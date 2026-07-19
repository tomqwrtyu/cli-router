import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCallbackEvent,
  callbackContextFromJwt,
  createCallbackClient,
  signCallbackBody
} from '../src/callback.js';
import { HttpError } from '../src/errors.js';

const context = {
  requestId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  action: 'condense_memory'
};

test('callback claims are optional for legacy router requests', () => {
  assert.equal(callbackContextFromJwt({}, true), null);
});

test('callback claims must be complete and valid', () => {
  assert.throws(
    () => callbackContextFromJwt({ request_id: context.requestId }, true),
    (error) => error.details?.reason === 'invalid_callback_claims'
  );
  assert.throws(
    () => callbackContextFromJwt({
      request_id: 'not-a-uuid',
      user_id: context.userId,
      action: context.action
    }, true),
    (error) => error.details?.reason === 'invalid_callback_ids'
  );
  assert.throws(
    () => callbackContextFromJwt({
      request_id: context.requestId,
      user_id: context.userId,
      action: 'chat'
    }, true),
    (error) => error.details?.reason === 'invalid_callback_action'
  );
});

test('callback claims fail closed when callback delivery is disabled', () => {
  assert.throws(
    () => callbackContextFromJwt({
      request_id: context.requestId,
      user_id: context.userId,
      action: context.action
    }, false),
    (error) => error.statusCode === 503 && error.details?.reason === 'callback_not_configured'
  );
});

test('callback body signature is stable HMAC-SHA256 base64url', () => {
  assert.equal(
    signCallbackBody('test-secret', '1710000000', '{"ok":true}'),
    '-NCa8BO2oBBVdAMrwFAKoP0dyUevNnjlkPjLn8aXuQs'
  );
});

test('callback client signs the raw body and retries transient responses', async () => {
  const requests = [];
  const waits = [];
  const responses = [
    { ok: false, status: 503 },
    { ok: true, status: 204 }
  ];
  const client = createCallbackClient({
    url: 'https://example.com/router-callback',
    secret: 's'.repeat(32),
    timeoutMs: 1_000,
    maxAttempts: 3
  }, {
    now: () => 1_710_000_000_000,
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    }
  });
  const event = buildCallbackEvent({
    context,
    modelId: 'gpt-test',
    provider: 'codex',
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
  });

  const delivery = await client.deliver(event);

  assert.deepEqual(delivery, { delivered: true, attempt: 2 });
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [250]);
  const rawBody = requests[0].init.body;
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.headers['x-cli-router-event-id'], context.requestId);
  assert.equal(
    requests[0].init.headers['x-cli-router-signature'],
    `v1=${signCallbackBody('s'.repeat(32), '1710000000', rawBody)}`
  );
});

test('callback client does not retry permanent 4xx responses', async () => {
  let attempts = 0;
  const client = createCallbackClient({
    url: 'https://example.com/router-callback',
    secret: 's'.repeat(32),
    timeoutMs: 1_000,
    maxAttempts: 3
  }, {
    sleep: async () => assert.fail('must not retry a permanent response'),
    fetchImpl: async () => {
      attempts += 1;
      return { ok: false, status: 401 };
    }
  });

  await assert.rejects(() => client.deliver({ requestId: context.requestId }), /HTTP 401/);
  assert.equal(attempts, 1);
});

test('failure callbacks omit provider stderr details', () => {
  const event = buildCallbackEvent({
    context,
    modelId: 'gpt-test',
    provider: 'codex',
    error: new HttpError(502, 'UNAVAILABLE', 'Provider CLI failed with exit code 1', {
      reason: 'provider_cli_failed',
      stderr: 'sensitive provider output'
    })
  });

  assert.equal(event.error.reason, 'provider_cli_failed');
  assert.equal(JSON.stringify(event).includes('sensitive provider output'), false);
});
