import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelCatalog } from '../src/server.js';

const registry = {
  'gpt-test': {
    provider: 'codex',
    enabled: true,
    access: { visibility: 'default' },
    billing: { unit: 'credits_per_1m_tokens', input: 1, output: 6, costMultiplier: 2 }
  }
};

test('model catalog fails closed while background jobs are disabled', () => {
  const config = {
    providers: { codex: true },
    codexLiveSearch: true,
    backgroundJobs: { enabled: false }
  };
  assert.deepEqual(buildModelCatalog(config, registry), []);
  config.backgroundJobs.enabled = true;
  assert.equal(buildModelCatalog(config, registry)[0].name, 'models/gpt-test');
});

test('model catalog intersects enabled models with trusted-client policy', () => {
  const config = {
    providers: { codex: true },
    codexLiveSearch: true,
    backgroundJobs: { enabled: true }
  };
  const denied = buildModelCatalog(config, registry, null, {
    routerClient: { allowedModels: ['another-model'] }
  });
  assert.deepEqual(denied, []);
  const allowed = buildModelCatalog(config, registry, null, {
    routerClient: { allowedModels: ['gpt-test'] }
  });
  assert.equal(allowed.length, 1);
});
