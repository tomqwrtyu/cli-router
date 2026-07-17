import assert from 'node:assert/strict';
import test from 'node:test';
import { createCorsPolicy } from '../src/cors.js';

function fakeResponse() {
  return {
    statusCode: null,
    headers: null,
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end() {
      this.ended = true;
    }
  };
}

const policy = createCorsPolicy({
  allowedOrigins: ['https://www.example.com', 'https://example.com'],
  maxAgeSeconds: 600
});

test('CORS allows exact configured origins', () => {
  const headers = policy.headersForRequest({ headers: { origin: 'https://www.example.com' } });
  assert.equal(headers['access-control-allow-origin'], 'https://www.example.com');
  assert.equal(headers.vary, 'Origin');
});

test('CORS leaves server-to-server requests without Origin unchanged', () => {
  assert.deepEqual(policy.headersForRequest({ headers: {} }), {});
});

test('CORS rejects unconfigured origins', () => {
  assert.throws(
    () => policy.headersForRequest({ headers: { origin: 'https://attacker.example' } }),
    (error) => error.statusCode === 403 && error.details?.reason === 'cors_origin_denied'
  );
});

test('CORS handles an allowed JSON authorization preflight', () => {
  const req = {
    method: 'OPTIONS',
    headers: {
      origin: 'https://www.example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type'
    }
  };
  const res = fakeResponse();
  const headers = policy.headersForRequest(req);

  assert.equal(policy.handlePreflight(req, res, headers), true);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], 'https://www.example.com');
  assert.equal(res.headers['access-control-allow-methods'], 'GET, POST');
  assert.equal(res.headers['access-control-allow-headers'], 'authorization, content-type');
  assert.equal(res.ended, true);
});

test('CORS rejects unconfigured preflight headers', () => {
  const req = {
    method: 'OPTIONS',
    headers: {
      origin: 'https://www.example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'x-untrusted-header'
    }
  };

  assert.throws(
    () => policy.handlePreflight(req, fakeResponse(), policy.headersForRequest(req)),
    (error) => error.statusCode === 400 && error.details?.reason === 'cors_header_denied'
  );
});
