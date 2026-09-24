import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JobManager } from '../src/job-manager.js';
import { createEncryptedOutbox } from '../src/outbox.js';
import { RollingLaunchLimiter } from '../src/rate-limit.js';
import { createStreamTokenService } from '../src/stream-token.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const bodyJson = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
const payloadHash = 'a6f67704cb62ae84ad34a3c89f7963f86d5db271519398efc3a4f3014ee34cca';

test('rolling limiter permits six launches and rejects the seventh for one minute', () => {
  let current = 1_000_000;
  const limiter = new RollingLaunchLimiter({ limit: 6, now: () => current });
  for (let index = 0; index < 6; index += 1) limiter.consume(userId);
  assert.throws(
    () => limiter.consume(userId),
    (error) => error.statusCode === 429 && error.details.retryAfter === 60
  );
  current += 60_001;
  assert.doesNotThrow(() => limiter.consume(userId));
});

test('stream token is request, user, project, and scope bound', async () => {
  const service = createStreamTokenService({
    secret: 's'.repeat(32),
    issuer: 'router-test',
    audience: 'stream-test',
    ttlSeconds: 60
  });
  const token = await service.issue({ requestId, userId, projectId: 'project-one' });
  const payload = await service.verify(token, requestId, 'project-one');
  assert.equal(payload.scope, 'stream:read');
  assert.equal(payload.user_id, userId);
  await assert.rejects(
    () => service.verify(token, requestId, 'project-two'),
    (error) => error.statusCode === 403
  );
});

test('encrypted outbox stores no callback plaintext and removes delivered rows', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-outbox-'));
  const outbox = createEncryptedOutbox({
    rootDir,
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    retentionMs: 60_000
  }, 'project-one');
  try {
    const event = { requestId, output: 'PRIVATE_OUTPUT_MARKER' };
    assert.equal(outbox.enqueue(event), true);
    const databaseBytes = await readFile(path.join(rootDir, 'project-one', 'outbox.sqlite'));
    assert.equal(databaseBytes.includes(Buffer.from('PRIVATE_OUTPUT_MARKER')), false);
    const due = outbox.due();
    assert.equal(due.length, 1);
    assert.deepEqual(due[0].event, event);
    outbox.delivered(requestId);
    assert.equal(outbox.due().length, 0);
  } finally {
    outbox.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('outbox quarantines entries after the configured retry limit', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-outbox-limit-'));
  let current = 1_000_000;
  const outbox = createEncryptedOutbox({
    rootDir,
    encryptionKey: Buffer.alloc(32, 9).toString('base64'),
    retentionMs: 60_000,
    maxAttempts: 2,
    maxRetryDelayMs: 5_000
  }, 'project-one', { now: () => current });
  try {
    outbox.enqueue({ requestId, output: 'result' });
    let item = outbox.due()[0];
    const first = outbox.failed(item.id, item.attempts, new Error('temporary'));
    assert.equal(first.exhausted, false);
    current += 5_001;
    item = outbox.due()[0];
    const second = outbox.failed(item.id, item.attempts, new Error('persistent'));
    assert.equal(second.exhausted, true);
    assert.equal(outbox.due().length, 0);
  } finally {
    outbox.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('outbox flush is single-flight and performs one callback attempt', async () => {
  let releaseDelivery;
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  let deliveries = 0;
  let deliveryOptions;
  const item = { id: requestId, event: { requestId }, attempts: 0 };
  const manager = new JobManager({
    config: {
      backgroundJobs: {
        projectId: 'project-one',
        launchesPerMinute: 6,
        outbox: { retryIntervalMs: 60_000 }
      }
    },
    registry: {},
    claimClient: {},
    streamTokens: {},
    callbackClient: {
      deliver: async (_event, options) => {
        deliveries += 1;
        deliveryOptions = options;
        await deliveryGate;
      }
    },
    outbox: {
      quarantineExhausted: () => 0,
      purgeExpired: () => 0,
      due: () => [item],
      delivered: () => {},
      failed: () => assert.fail('delivery should succeed'),
      close: () => {}
    }
  });
  try {
    const first = manager.flushOutbox();
    const second = manager.flushOutbox();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deliveries, 1);
    releaseDelivery();
    await Promise.all([first, second]);
    assert.deepEqual(deliveryOptions, { maxAttempts: 1 });
  } finally {
    manager.close();
  }
});

test('job completes without a browser subscriber and callbacks the visible output', async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'cli-router-job-'));
  const fakeCodex = path.join(runRoot, 'fake-codex');
  await writeFile(fakeCodex, [
    '#!/bin/sh',
    'cat >/dev/null',
    `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"first "}}'`,
    `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}'`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'`
  ].join('\n'));
  await chmod(fakeCodex, 0o700);

  let terminalEvent;
  let resolveTerminal;
  const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
  const config = {
    providers: { codex: true, claude: false },
    providerBinaries: { codex: fakeCodex },
    codexLiveSearch: false,
    runTimeoutMs: 5_000,
    tmpDir: runRoot,
    usage: {
      imageFallbackTokens: 258,
      imageTileTokens: 258,
      imageSmallMaxPixels: 384,
      imageTileSize: 768,
      imageMaxTokens: 0
    },
    attachments: {
      allowedFileUriHosts: [],
      allowedImageMime: [],
      allowedDocMime: []
    },
    backgroundJobs: {
      projectId: 'project-one',
      maxActivePerUser: 1,
      launchesPerMinute: 6,
      cancelCooldownMs: 3_000,
      maxOutputTokens: 16_384,
      heartbeatMs: 60_000,
      terminalRetentionMs: 60_000,
      outbox: { retryIntervalMs: 60_000 }
    }
  };
  const registry = {
    'gpt-test': {
      provider: 'codex',
      cliModel: 'gpt-test',
      reasoningEffort: 'medium',
      contextWindow: 10_000,
      inputCharLimit: 8_000,
      inputTokenLimit: 8_000,
      outputTokenLimit: 2_000,
      autoCompactTokenLimit: 8_000,
      enabled: true
    }
  };
  const issuedStreamClaims = [];
  const manager = new JobManager({
    config,
    registry,
    streamTokens: {
      issue: async (claims) => {
        issuedStreamClaims.push(claims);
        return `stream-token-${issuedStreamClaims.length}`;
      },
      verify: async () => ({ jti: 'jti', user_id: userId })
    },
    claimClient: {
      claim: async () => ({
        requestId,
        userId,
        action: 'chat',
        model: 'gpt-test',
        bodyJson,
        webSearchEnabled: false
      })
    },
    callbackClient: {
      deliver: async (event) => {
        if (event.event === 'router.generation.terminal') {
          terminalEvent = event;
          resolveTerminal();
        }
        return { delivered: true };
      }
    },
    outbox: {
      enqueue: () => assert.fail('callback should not enter outbox'),
      purgeExpired: () => 0,
      due: () => [],
      close: () => {}
    }
  });

  try {
    const launch = await manager.launch({
      projectId: 'project-one',
      requestId,
      userId,
      action: 'chat',
      model: 'gpt-test',
      payloadHash
    }, {
      project_id: 'project-one',
      request_id: requestId,
      user_id: userId,
      action: 'chat',
      model: 'gpt-test',
      payload_hash: payloadHash
    });
    assert.equal(launch.streamToken, 'stream-token-1');
    const refreshed = await manager.issueStreamToken(requestId, {
      project_id: 'project-one',
      request_id: requestId,
      user_id: userId
    });
    assert.equal(refreshed, 'stream-token-2');
    assert.deepEqual(issuedStreamClaims[1], {
      requestId,
      userId,
      projectId: 'project-one'
    });
    const duplicate = await manager.launch({
      projectId: 'project-one',
      requestId,
      userId,
      action: 'chat',
      model: 'gpt-test',
      payloadHash
    }, {
      project_id: 'project-one',
      request_id: requestId,
      user_id: userId,
      action: 'chat',
      model: 'gpt-test',
      payload_hash: payloadHash
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.streamToken, 'stream-token-3');
    await assert.rejects(
      () => manager.issueStreamToken(requestId, {
        project_id: 'project-one',
        request_id: requestId,
        user_id: '33333333-3333-4333-8333-333333333333'
      }),
      (error) => error.statusCode === 403
    );
    await terminal;
    assert.equal(terminalEvent.status, 'completed');
    assert.equal(terminalEvent.output, 'first second');
    assert.equal(terminalEvent.usageMetadata.promptTokenCount, 10);
    assert.equal(terminalEvent.usageSource, 'provider');
  } finally {
    manager.close();
    await rm(runRoot, { recursive: true, force: true });
  }
});

test('cancelling a job emits a terminal callback and enforces the three-second launch cooldown', async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'cli-router-cancel-'));
  let current = 1_000_000;
  let releaseClaim;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  let resolveTerminal;
  const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
  const config = {
    providers: { codex: true, claude: false },
    providerBinaries: { codex: '/bin/false' },
    codexLiveSearch: false,
    runTimeoutMs: 5_000,
    tmpDir: runRoot,
    usage: {
      imageFallbackTokens: 258,
      imageTileTokens: 258,
      imageSmallMaxPixels: 384,
      imageTileSize: 768,
      imageMaxTokens: 0
    },
    attachments: {
      allowedFileUriHosts: [],
      allowedImageMime: [],
      allowedDocMime: []
    },
    backgroundJobs: {
      projectId: 'project-one',
      maxActivePerUser: 1,
      launchesPerMinute: 6,
      cancelCooldownMs: 3_000,
      maxOutputTokens: 16_384,
      heartbeatMs: 60_000,
      terminalRetentionMs: 60_000,
      outbox: { retryIntervalMs: 60_000 }
    }
  };
  const registry = {
    'gpt-test': {
      provider: 'codex',
      cliModel: 'gpt-test',
      reasoningEffort: 'medium',
      contextWindow: 10_000,
      inputCharLimit: 8_000,
      inputTokenLimit: 8_000,
      outputTokenLimit: 2_000,
      autoCompactTokenLimit: 8_000,
      enabled: true
    }
  };
  const manager = new JobManager({
    config,
    registry,
    now: () => current,
    streamTokens: {
      issue: async () => 'stream-token',
      verify: async () => ({ jti: 'jti', user_id: userId })
    },
    claimClient: {
      claim: async () => {
        await claimGate;
        return {
          requestId,
          userId,
          action: 'chat',
          model: 'gpt-test',
          bodyJson,
          webSearchEnabled: false
        };
      }
    },
    callbackClient: {
      deliver: async (event) => {
        if (event.event === 'router.generation.terminal') resolveTerminal(event);
        return { delivered: true };
      }
    },
    outbox: {
      enqueue: () => assert.fail('cancel callback should not enter outbox'),
      purgeExpired: () => 0,
      due: () => [],
      close: () => {}
    }
  });

  try {
    await manager.launch({
      projectId: 'project-one', requestId, userId, action: 'chat', model: 'gpt-test', payloadHash
    }, {
      project_id: 'project-one', request_id: requestId, user_id: userId,
      action: 'chat', model: 'gpt-test', payload_hash: payloadHash
    });
    const cancelled = manager.cancel(requestId, { request_id: requestId, user_id: userId });
    assert.equal(cancelled.requestId, requestId);
    assert.equal(cancelled.status, 'launching');
    releaseClaim();
    const terminalEvent = await terminal;
    assert.equal(terminalEvent.status, 'cancelled');
    assert.equal(terminalEvent.output, '');

    const secondRequestId = '44444444-4444-4444-8444-444444444444';
    await assert.rejects(
      () => manager.launch({
        projectId: 'project-one', requestId: secondRequestId, userId,
        action: 'chat', model: 'gpt-test', payloadHash
      }, {
        project_id: 'project-one', request_id: secondRequestId, user_id: userId,
        action: 'chat', model: 'gpt-test', payload_hash: payloadHash
      }),
      (error) => error.statusCode === 429 &&
        error.details.reason === 'cancel_cooldown' && error.details.retryAfter === 3
    );
    current += 3_001;
  } finally {
    manager.close();
    await rm(runRoot, { recursive: true, force: true });
  }
});

test('summary lane is explicitly authorized and does not consume the foreground slot', async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'cli-router-summary-lane-'));
  let releaseClaims;
  const claimGate = new Promise((resolve) => { releaseClaims = resolve; });
  let terminalCount = 0;
  let resolveTerminals;
  const terminals = new Promise((resolve) => { resolveTerminals = resolve; });
  const config = {
    providers: { codex: true, claude: false },
    providerBinaries: { codex: '/bin/false' },
    codexLiveSearch: false,
    runTimeoutMs: 5_000,
    tmpDir: runRoot,
    usage: { imageFallbackTokens: 258, imageTileTokens: 258, imageSmallMaxPixels: 384, imageTileSize: 768, imageMaxTokens: 0 },
    attachments: { allowedFileUriHosts: [], allowedImageMime: [], allowedDocMime: [] },
    backgroundJobs: {
      projectId: 'project-one', maxActivePerUser: 1, maxActiveJobs: 2,
      maxActiveSummaries: 1, autoSummaryEnabled: true, launchesPerMinute: 6,
      cancelCooldownMs: 3_000, maxOutputTokens: 16_384, heartbeatMs: 60_000,
      terminalRetentionMs: 60_000, outbox: { retryIntervalMs: 60_000 }
    }
  };
  const manager = new JobManager({
    config,
    registry: {
      'gpt-test': {
        provider: 'codex', cliModel: 'gpt-test', reasoningEffort: 'medium',
        contextWindow: 10_000, inputCharLimit: 8_000, inputTokenLimit: 8_000,
        outputTokenLimit: 2_000, autoCompactTokenLimit: 8_000, enabled: true
      }
    },
    streamTokens: { issue: async () => 'stream-token' },
    claimClient: {
      claim: async (identity) => {
        await claimGate;
        return { ...identity, bodyJson, webSearchEnabled: false };
      }
    },
    callbackClient: {
      deliver: async (event) => {
        if (event.event === 'router.generation.terminal' && ++terminalCount === 2) resolveTerminals();
        return { delivered: true };
      }
    },
    outbox: { enqueue: () => assert.fail('unexpected outbox write'), purgeExpired: () => 0, due: () => [], close: () => {} }
  });
  const summaryId = '33333333-3333-4333-8333-333333333333';
  const chatId = '44444444-4444-4444-8444-444444444444';
  const envelope = (id, action, user = userId) => ({
    projectId: 'project-one', requestId: id, userId: user, action,
    model: 'gpt-test', payloadHash
  });
  const claims = (id, action, allowAutoSummary = true, user = userId) => ({
    project_id: 'project-one', request_id: id, user_id: user, action,
    model: 'gpt-test', payload_hash: payloadHash,
    routerClient: { clientId: 'mirastral', allowAutoSummary, quota: { maxActivePerUser: 1 } }
  });
  try {
    await assert.rejects(
      () => manager.launch(envelope(summaryId, 'auto_summary'), claims(summaryId, 'auto_summary', false)),
      (error) => error.statusCode === 403 && error.details.reason === 'summary_lane_denied'
    );
    await manager.launch(envelope(summaryId, 'auto_summary'), claims(summaryId, 'auto_summary'));
    const anotherSummaryUser = '99999999-9999-4999-8999-999999999999';
    await assert.rejects(
      () => manager.launch(envelope('88888888-8888-4888-8888-888888888888', 'auto_summary', anotherSummaryUser),
        claims('88888888-8888-4888-8888-888888888888', 'auto_summary', true,
          anotherSummaryUser)),
      (error) => error.statusCode === 429 && error.details.reason === 'worker_capacity_exceeded'
    );
    manager.cancel(summaryId, claims(summaryId, 'auto_summary'));
    await manager.launch(envelope(chatId, 'chat'), claims(chatId, 'chat'));
    assert.equal(manager.activeJobs, 2);
    assert.equal(manager.activeSummaries, 1);
    assert.equal(manager.clientLaunchEvents.get('mirastral:' + userId)?.length, 2);
    await assert.rejects(
      () => manager.launch(envelope('55555555-5555-4555-8555-555555555555', 'auto_summary'),
        claims('55555555-5555-4555-8555-555555555555', 'auto_summary')),
      (error) => error.statusCode === 429 && error.details.reason === 'user_concurrency_exceeded'
    );
    const otherUser = '66666666-6666-4666-8666-666666666666';
    await assert.rejects(
      () => manager.launch(envelope('77777777-7777-4777-8777-777777777777', 'chat', otherUser),
        claims('77777777-7777-4777-8777-777777777777', 'chat', true, otherUser)),
      (error) => error.statusCode === 429 && error.details.reason === 'worker_capacity_exceeded'
    );
    manager.cancel(chatId, claims(chatId, 'chat'));
    releaseClaims();
    await terminals;
    assert.equal(manager.activeJobs, 0);
    assert.equal(manager.activeSummaries, 0);
  } finally {
    releaseClaims();
    manager.close();
    await rm(runRoot, { recursive: true, force: true });
  }
});
