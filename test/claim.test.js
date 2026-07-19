import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaimClient } from '../src/claim.js';

test('claim client classifies launch rate limits without retrying', async () => {
  let attempts = 0;
  const client = createClaimClient({
    url: 'https://example.com/router-claim',
    secret: 's'.repeat(32),
    timeoutMs: 1_000,
    maxAttempts: 3,
    maxResponseBytes: 1024
  }, {
    sleep: async () => assert.fail('rate limit must not be retried immediately'),
    fetchImpl: async () => {
      attempts += 1;
      return new Response('{"error":"Launch rate exceeded"}', {
        status: 429,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await assert.rejects(
    () => client.claim({ requestId: '11111111-1111-4111-8111-111111111111' }),
    (error) => error.statusCode === 429 && error.details?.reason === 'launch_rate_exceeded'
  );
  assert.equal(attempts, 1);
});
