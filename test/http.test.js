import assert from 'node:assert/strict';
import test from 'node:test';
import { sendJson, sendSseHeaders } from '../src/http.js';

function fakeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
      this.ended = true;
    }
  };
}

function assertSecurityHeaders(headers) {
  assert.equal(headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(headers['x-content-type-options'], 'nosniff');
}

test('JSON responses include security headers', () => {
  const res = fakeResponse();
  sendJson(res, 200, { ok: true });

  assertSecurityHeaders(res.headers);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.body, '{"ok":true}');
});

test('SSE handshakes include security headers', () => {
  const res = fakeResponse();
  sendSseHeaders(res);

  assertSecurityHeaders(res.headers);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['x-accel-buffering'], 'no');
});
