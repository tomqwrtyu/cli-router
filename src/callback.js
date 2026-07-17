import crypto from 'node:crypto';
import { HttpError, geminiError } from './errors.js';

const CALLBACK_ACTIONS = new Set(['condense_memory', 'increment_memory']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function callbackContextFromJwt(payload, callbackEnabled) {
  const values = [payload.request_id, payload.user_id, payload.action];
  const presentCount = values.filter((value) => value !== undefined).length;
  if (presentCount === 0) return null;
  if (presentCount !== values.length || values.some((value) => typeof value !== 'string' || !value)) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Incomplete callback claims', {
      reason: 'invalid_callback_claims'
    });
  }
  if (!CALLBACK_ACTIONS.has(payload.action)) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Unsupported callback action', {
      reason: 'invalid_callback_action'
    });
  }
  if (!UUID_PATTERN.test(payload.request_id) || !UUID_PATTERN.test(payload.user_id)) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Callback IDs must be UUIDs', {
      reason: 'invalid_callback_ids'
    });
  }
  if (!callbackEnabled) {
    throw new HttpError(503, 'UNAVAILABLE', 'Router callback is not configured', {
      reason: 'callback_not_configured'
    });
  }
  return {
    requestId: payload.request_id,
    userId: payload.user_id,
    action: payload.action
  };
}

function safeError(error) {
  const normalized = geminiError(error);
  return {
    code: normalized.statusCode,
    status: normalized.body.error.status,
    message: normalized.body.error.message,
    reason: error instanceof HttpError ? error.details?.reason || null : null
  };
}

export function buildCallbackEvent({ context, modelId, provider, usageMetadata = null, error = null }) {
  const failed = Boolean(error);
  return {
    version: 1,
    event: failed ? 'router.generation.failed' : 'router.generation.completed',
    requestId: context.requestId,
    userId: context.userId,
    action: context.action,
    model: modelId,
    provider,
    status: failed ? 'failed' : 'completed',
    usageMetadata: failed ? null : usageMetadata,
    error: failed ? safeError(error) : null,
    completedAt: new Date().toISOString()
  };
}

export function signCallbackBody(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('base64url');
}

export function createCallbackClient(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const wait = options.sleep || sleep;
  const enabled = Boolean(config.url && config.secret);

  async function deliver(event) {
    if (!enabled) return { delivered: false, disabled: true };
    const rawBody = JSON.stringify(event);
    let lastError;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      const timestamp = String(Math.floor(now() / 1000));
      const signature = signCallbackBody(config.secret, timestamp, rawBody);
      try {
        const response = await fetchImpl(config.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cli-router-event-id': event.requestId,
            'x-cli-router-timestamp': timestamp,
            'x-cli-router-signature': `v1=${signature}`
          },
          body: rawBody,
          signal: AbortSignal.timeout(config.timeoutMs)
        });
        if (response.ok) {
          await response.body?.cancel();
          return { delivered: true, attempt };
        }
        await response.body?.cancel();
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        lastError = new Error(`Callback returned HTTP ${response.status}`);
        if (!retryable) break;
      } catch (error) {
        lastError = error;
      }

      if (attempt < config.maxAttempts) {
        await wait(250 * (2 ** (attempt - 1)));
      }
    }

    throw lastError || new Error('Callback delivery failed');
  }

  return { enabled, deliver };
}
