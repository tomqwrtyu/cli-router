import crypto from 'node:crypto';
import { importJWK, jwtVerify } from 'jose';
import { HttpError } from './errors.js';

const replayCache = new Map();

function cleanupReplayCache(nowSeconds) {
  for (const [jti, expiresAt] of replayCache.entries()) {
    if (expiresAt <= nowSeconds) replayCache.delete(jti);
  }
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function createJwtVerifier(config) {
  if (config.authMode === 'disabled') {
    if (config.env === 'production') {
      throw new Error('ROUTER_AUTH_MODE=disabled is not allowed in production');
    }
    return async () => ({ authDisabled: true });
  }

  if (config.authMode !== 'jwt') {
    throw new Error(`Unsupported ROUTER_AUTH_MODE: ${config.authMode}`);
  }
  if (!config.jwt.publicJwk) {
    throw new Error('ROUTER_JWT_PUBLIC_JWK is required when ROUTER_AUTH_MODE=jwt');
  }
  if (!config.jwt.issuer) {
    throw new Error('ROUTER_JWT_ISSUER is required when ROUTER_AUTH_MODE=jwt');
  }

  const key = await importJWK(config.jwt.publicJwk, config.jwt.alg);

  return async function verifyRouterJwt(req, url, rawBody) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
    }

    let payload;
    try {
      const verified = await jwtVerify(match[1], key, {
        algorithms: [config.jwt.alg],
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
        clockTolerance: config.jwt.clockToleranceSeconds
      });
      payload = verified.payload;
    } catch {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid router JWT');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    cleanupReplayCache(nowSeconds);

    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
      throw new HttpError(401, 'UNAUTHENTICATED', 'JWT must include numeric iat and exp');
    }
    if (payload.exp - payload.iat > config.jwt.maxAgeSeconds) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'JWT lifetime is too long');
    }
    if (!payload.jti || typeof payload.jti !== 'string') {
      throw new HttpError(401, 'UNAUTHENTICATED', 'JWT must include jti');
    }
    if (replayCache.has(payload.jti)) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'JWT jti was already used');
    }

    const expectedBodyHash = sha256Hex(rawBody);
    if (payload.body_sha256 !== expectedBodyHash) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'JWT body hash does not match');
    }
    if (payload.method !== req.method) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'JWT method does not match');
    }
    if (payload.path !== url.pathname) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'JWT path does not match');
    }

    replayCache.set(payload.jti, payload.exp + config.jwt.clockToleranceSeconds);
    return payload;
  };
}
