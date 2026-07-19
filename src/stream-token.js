import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { HttpError } from './errors.js';

const encoder = new TextEncoder();

export function createStreamTokenService(config, options = {}) {
  const key = encoder.encode(config.secret);
  const now = options.now || (() => Math.floor(Date.now() / 1000));

  async function issue({ requestId, userId, projectId }) {
    const issuedAt = now();
    return new SignJWT({
      scope: 'stream:read',
      request_id: requestId,
      user_id: userId,
      project_id: projectId
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + config.ttlSeconds)
      .setJti(crypto.randomUUID())
      .sign(key);
  }

  async function verify(token, requestId, projectId) {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        issuer: config.issuer,
        audience: config.audience
      }));
    } catch {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired stream token', {
        reason: 'invalid_stream_token'
      });
    }
    if (
      payload.scope !== 'stream:read' ||
      payload.request_id !== requestId ||
      payload.project_id !== projectId ||
      typeof payload.user_id !== 'string' ||
      typeof payload.jti !== 'string'
    ) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'Stream token scope does not match request', {
        reason: 'stream_token_scope_mismatch'
      });
    }
    return payload;
  }

  return { issue, verify };
}
