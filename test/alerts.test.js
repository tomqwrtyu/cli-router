import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlertSink } from '../src/alerts.js';

test('alert webhook sends only scalar operational metadata and deduplicates', async () => {
  const requests = [];
  let current = 1_000;
  const alerts = createAlertSink({
    webhookUrl: 'https://alerts.example.test/router',
    webhookSecret: 'secret',
    timeoutMs: 1_000,
    minIntervalMs: 60_000
  }, {
    now: () => current,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 204 };
    }
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    await alerts.emit('callback_outbox_entries_expired', {
      projectId: 'project-a',
      count: 2,
      unsafe: { payload: 'must-not-leak' }
    });
    await alerts.emit('callback_outbox_entries_expired', {
      projectId: 'project-a',
      count: 3
    });
    current += 60_001;
    await alerts.emit('callback_outbox_entries_expired', {
      projectId: 'project-a',
      count: 4
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.authorization, 'Bearer secret');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.event, 'callback_outbox_entries_expired');
  assert.equal(body.count, 2);
  assert.equal('unsafe' in body, false);
});
