import crypto from 'node:crypto';
import { HttpError } from './errors.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function signServerBody(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('base64url');
}

export function createClaimClient(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const wait = options.sleep || sleep;

  async function claim(envelope) {
    const rawBody = JSON.stringify(envelope);
    let lastError;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      const timestamp = String(Math.floor(now() / 1000));
      const signature = signServerBody(config.secret, timestamp, rawBody);
      try {
        const response = await fetchImpl(config.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cli-router-request-id': envelope.requestId,
            'x-cli-router-timestamp': timestamp,
            'x-cli-router-signature': `v1=${signature}`
          },
          body: rawBody,
          signal: AbortSignal.timeout(config.timeoutMs),
          redirect: 'error'
        });
        const declaredLength = Number(response.headers.get('content-length') || '0');
        if (declaredLength > config.maxResponseBytes) {
          await response.body?.cancel();
          throw new HttpError(502, 'UNAVAILABLE', 'Claim payload is too large', {
            reason: 'claim_payload_too_large'
          });
        }
        const raw = Buffer.from(await response.arrayBuffer());
        if (raw.length > config.maxResponseBytes) {
          throw new HttpError(502, 'UNAVAILABLE', 'Claim payload is too large', {
            reason: 'claim_payload_too_large'
          });
        }
        if (!response.ok) {
          if (response.status === 429) {
            lastError = new HttpError(429, 'RESOURCE_EXHAUSTED', 'Router launch rate exceeded', {
              reason: 'launch_rate_exceeded',
              retryAfter: 60
            });
            break;
          }
          const retryable = response.status === 408 || response.status >= 500;
          lastError = new HttpError(retryable ? 503 : 409, 'UNAVAILABLE', `Claim returned HTTP ${response.status}`, {
            reason: retryable ? 'claim_temporarily_unavailable' : 'claim_rejected'
          });
          if (!retryable) break;
        } else {
          let payload;
          try {
            payload = JSON.parse(raw.toString('utf8'));
          } catch {
            throw new HttpError(502, 'UNAVAILABLE', 'Claim response is not valid JSON', {
              reason: 'invalid_claim_response'
            });
          }
          return payload;
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt < config.maxAttempts) await wait(250 * (2 ** (attempt - 1)));
    }
    throw lastError || new HttpError(503, 'UNAVAILABLE', 'Claim failed', { reason: 'claim_failed' });
  }

  return { claim };
}
