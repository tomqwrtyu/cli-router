import crypto from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
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
  const trustedClients = config.trustedClients || [];
  if (trustedClients.length === 0 && !config.jwt.publicJwk) {
    throw new Error('ROUTER_JWT_PUBLIC_JWK is required when ROUTER_AUTH_MODE=jwt');
  }
  if (trustedClients.length === 0 && !config.jwt.issuer) {
    throw new Error('ROUTER_JWT_ISSUER is required when ROUTER_AUTH_MODE=jwt');
  }

  const legacyKey = trustedClients.length === 0
    ? await importJWK(config.jwt.publicJwk, config.jwt.alg)
    : null;
  const clientKeys = new Map();
  for (const client of trustedClients) {
    const identity = `${client.issuer}\n${client.audience}\n${client.publicJwk.kid}`;
    clientKeys.set(identity, {
      client,
      key: await importJWK(client.publicJwk, client.alg)
    });
  }

  return async function verifyRouterJwt(req, url, rawBody) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
    }

    let payload;
    let routerClient = null;
    try {
      if (trustedClients.length > 0) {
        const protectedHeader = decodeProtectedHeader(match[1]);
        const unverified = decodeJwt(match[1]);
        const audiences = Array.isArray(unverified.aud) ? unverified.aud : [unverified.aud];
        const matches = audiences
          .filter((audience) => typeof audience === 'string')
          .map((audience) => clientKeys.get(`${unverified.iss}\n${audience}\n${protectedHeader.kid}`))
          .filter(Boolean);
        if (matches.length !== 1) throw new Error('Unknown trusted client identity');
        const selected = matches[0];
        const verified = await jwtVerify(match[1], selected.key, {
          algorithms: [selected.client.alg],
          issuer: selected.client.issuer,
          audience: selected.client.audience,
          clockTolerance: config.jwt.clockToleranceSeconds
        });
        payload = verified.payload;
        routerClient = selected.client;
        if (
          payload.client_id !== routerClient.clientId ||
          payload.project_ref !== routerClient.projectRef
        ) {
          throw new Error('Trusted client claims do not match registry');
        }
      } else {
        const verified = await jwtVerify(match[1], legacyKey, {
          algorithms: [config.jwt.alg],
          issuer: config.jwt.issuer,
          audience: config.jwt.audience,
          clockTolerance: config.jwt.clockToleranceSeconds
        });
        payload = verified.payload;
      }
    } catch {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid router JWT');
    }

    const origin = req.headers.origin;
    if (routerClient && origin && !routerClient.allowedOrigins.includes(origin)) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'Origin is not allowed for this client', {
        reason: 'client_origin_denied'
      });
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
    const replayKey = `${routerClient?.clientId || 'legacy'}:${payload.jti}`;
    if (replayCache.has(replayKey)) {
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

    replayCache.set(replayKey, payload.exp + config.jwt.clockToleranceSeconds);
    if (routerClient) payload.routerClient = routerClient;
    return payload;
  };
}

export function clientAllowsModel(claims, modelId) {
  const allowedModels = claims?.routerClient?.allowedModels;
  if (!allowedModels) return true;
  return allowedModels.includes('*') || allowedModels.includes(modelId);
}
