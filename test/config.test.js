import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModelRegistry } from '../src/config.js';

test('model registry configures Luna with xhigh reasoning only', async () => {
  const registry = await loadModelRegistry({ modelRegistryPath: './config/models.json' });

  assert.equal(registry['gpt-5.6-luna'].reasoningEffort, 'xhigh');
  assert.equal(registry['gpt-5.6-sol'].reasoningEffort, 'medium');
  assert.equal(registry['gpt-5.6-terra'].reasoningEffort, 'medium');
});
