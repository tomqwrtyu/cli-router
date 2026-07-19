import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderHealthCache, parseQuotaResetAt, quotaErrorDetails } from '../src/provider-health.js';
import { buildModelCatalog } from '../src/server.js';

test('quota reset parser understands relative and UTC clock reset messages', () => {
  const now = Date.UTC(2026, 6, 19, 14, 0);
  assert.equal(
    parseQuotaResetAt('Usage limit reached; try again in 2 hours 15 minutes', { nowMs: now }),
    now + (2 * 60 + 15) * 60_000
  );
  assert.equal(
    parseQuotaResetAt('Session limit reached; resets 4:20pm (UTC)', { nowMs: now }),
    Date.UTC(2026, 6, 19, 16, 20)
  );
  assert.equal(
    parseQuotaResetAt('Session limit reached; resets 1:00pm (UTC)', { nowMs: now }),
    Date.UTC(2026, 6, 20, 13, 0)
  );
});

test('quota reset parser falls back and caps untrusted reset timestamps', () => {
  const now = 1_000_000;
  assert.equal(parseQuotaResetAt('quota exceeded', { nowMs: now, fallbackMs: 30_000 }), now + 30_000);
  assert.equal(
    parseQuotaResetAt('reset_at: 9999999999999', { nowMs: now, maxCooldownMs: 60_000 }),
    now + 60_000
  );
});

test('provider health hides models until cooldown expiry and direct calls remain 429', () => {
  let now = Date.UTC(2026, 6, 19, 14, 0);
  const health = new ProviderHealthCache({ fallbackCooldownMs: 60_000, maxCooldownMs: 300_000 }, {
    now: () => now
  });
  const details = quotaErrorDetails('codex', 'quota exceeded', {
    fallbackCooldownMs: 60_000,
    maxCooldownMs: 300_000
  }, now);
  assert.equal(health.markQuotaError('codex', { details }), true);

  const config = { providers: { codex: true }, backgroundJobs: { enabled: true }, codexLiveSearch: true };
  const registry = {
    model: { provider: 'codex', enabled: true, access: { visibility: 'default' } }
  };
  assert.deepEqual(buildModelCatalog(config, registry, health), []);
  assert.throws(
    () => health.assertAvailable('codex'),
    (error) => error.statusCode === 429 && error.details.retryAfter === 60
  );

  now += 60_001;
  assert.equal(buildModelCatalog(config, registry, health).length, 1);
  assert.doesNotThrow(() => health.assertAvailable('codex'));
});
