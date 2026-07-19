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
