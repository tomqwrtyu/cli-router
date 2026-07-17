import { HttpError } from './errors.js';

export async function readRequestBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, 'INVALID_ARGUMENT', 'Request body is too large', {
        reason: 'request_too_large',
        maxBytes
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res, statusCode, body, headers = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
    ...headers
  });
  res.end(raw);
}

export function sendSseHeaders(res, headers = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...headers
  });
}

export function writeSseData(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
