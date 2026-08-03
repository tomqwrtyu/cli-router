import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAdmissionOpen } from '../src/maintenance.js';

test('allows launches while maintenance is open', async () => {
  await assertAdmissionOpen(async () => ({ maintenance: false, phase: 'open' }));
});

test('rejects new launches while preserving retry metadata', async () => {
  await assert.rejects(
    () => assertAdmissionOpen(async () => ({ maintenance: true, phase: 'draining' })),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.status, 'UNAVAILABLE');
      assert.equal(error.details.reason, 'app_maintenance');
      assert.equal(error.details.retryAfter, 15);
      return true;
    }
  );
});
