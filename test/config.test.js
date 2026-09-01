import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLocalApiConfig, loadModelRegistry } from '../src/config.js';

test('model registry configures per-model reasoning effort', async () => {
  const registry = await loadModelRegistry({ modelRegistryPath: './config/models.json' });

  assert.equal(registry['gpt-5.6-luna'].reasoningEffort, 'max');
  assert.equal(registry['gpt-5.6-sol'].reasoningEffort, 'medium');
  assert.equal(registry['gpt-5.6-terra'].reasoningEffort, 'high');
});

test('model registry rejects unknown local allowlist entries', async () => {
  await assert.rejects(
    () => loadModelRegistry({
      modelRegistryPath: './config/models.json',
      localApi: { enabled: true, allowedModels: ['not-a-model'] }
    }),
    /contains unknown model ID/
  );
});

test('local API config is disabled by default and fails closed when enabled', () => {
  assert.equal(loadLocalApiConfig({}).enabled, false);
  assert.throws(
    () => loadLocalApiConfig({
      ROUTER_LOCAL_API_ENABLED: 'true',
      ROUTER_LOCAL_API_HOST: '0.0.0.0',
      ROUTER_LOCAL_API_TOKEN: 'a'.repeat(32),
      ROUTER_LOCAL_ALLOWED_MODELS: 'gpt-5.6-luna'
    }),
    /must be 127\.0\.0\.1 or ::1/
  );
  assert.throws(
    () => loadLocalApiConfig({
      ROUTER_LOCAL_API_ENABLED: 'true',
      ROUTER_LOCAL_API_TOKEN: 'short',
      ROUTER_LOCAL_ALLOWED_MODELS: 'gpt-5.6-luna'
    }),
    /at least 32 bytes/
  );
  assert.throws(
    () => loadLocalApiConfig({
      ROUTER_LOCAL_API_ENABLED: 'true',
      ROUTER_LOCAL_API_TOKEN: 'a'.repeat(32)
    }),
    /at least one model ID/
  );
});

test('local API config parses an explicit model allowlist', () => {
  const config = loadLocalApiConfig({
    ROUTER_LOCAL_API_ENABLED: 'true',
    ROUTER_LOCAL_API_TOKEN: 'a'.repeat(32),
    ROUTER_LOCAL_ALLOWED_MODELS: 'gpt-5.6-sol, gpt-5.6-luna'
  });
  assert.deepEqual(config.allowedModels, ['gpt-5.6-sol', 'gpt-5.6-luna']);
});
