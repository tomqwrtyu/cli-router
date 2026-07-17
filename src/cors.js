import { HttpError } from './errors.js';

const ALLOWED_METHODS = new Set(['GET', 'POST']);
const ALLOWED_HEADERS = new Set(['authorization', 'content-type']);

function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid CORS origin: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.replace(/\/$/, '')) {
    throw new Error(`CORS origins must be exact HTTP(S) origins: ${value}`);
  }
  return url.origin;
}

export function createCorsPolicy(config) {
  const allowedOrigins = new Set(config.allowedOrigins.map(normalizeOrigin));

  function headersForRequest(req) {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (!allowedOrigins.has(origin)) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'Origin is not allowed', {
        reason: 'cors_origin_denied'
      });
    }
    return {
      'access-control-allow-origin': origin,
      'access-control-expose-headers': 'x-router-request-id',
      vary: 'Origin'
    };
  }

  function handlePreflight(req, res, responseHeaders) {
    if (req.method !== 'OPTIONS') return false;

    const requestedMethod = (req.headers['access-control-request-method'] || '').toUpperCase();
    if (!ALLOWED_METHODS.has(requestedMethod)) {
      throw new HttpError(405, 'INVALID_ARGUMENT', 'CORS method is not allowed', {
        reason: 'cors_method_denied'
      });
    }

    const requestedHeaders = String(req.headers['access-control-request-headers'] || '')
      .split(',')
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (requestedHeaders.some((header) => !ALLOWED_HEADERS.has(header))) {
      throw new HttpError(400, 'INVALID_ARGUMENT', 'CORS header is not allowed', {
        reason: 'cors_header_denied'
      });
    }

    res.writeHead(204, {
      ...responseHeaders,
      'access-control-allow-methods': [...ALLOWED_METHODS].join(', '),
      'access-control-allow-headers': [...ALLOWED_HEADERS].join(', '),
      'access-control-max-age': String(config.maxAgeSeconds)
    });
    res.end();
    return true;
  }

  return { headersForRequest, handlePreflight };
}
