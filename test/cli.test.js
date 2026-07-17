import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { providerCommand, runCliOnce } from '../src/cli.js';

const claudeEntry = {
  provider: 'claude',
  cliModel: 'opus'
};

test('Claude sends large prompts through stdin instead of argv', async () => {
  const prompt = 'x'.repeat(200 * 1024);
  const normalized = {
    prompt,
    systemInstruction: 'System instructions',
    systemInstructionPath: '/tmp/system-prompt.txt',
    imagePaths: [],
    runDir: os.tmpdir()
  };
  const config = {
    providerBinaries: { claude: 'claude' }
  };

  const command = providerCommand(normalized, claudeEntry, config);

  assert.equal(command.stdin, prompt);
  assert.equal(command.args.includes(prompt), false);
  assert.equal(command.args.includes(normalized.systemInstruction), false);
  assert.deepEqual(
    command.args.slice(command.args.indexOf('--system-prompt-file')),
    ['--system-prompt-file', normalized.systemInstructionPath]
  );
});

test('Claude runner can spawn with a 200 KiB prompt', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-test-'));
  const fakeClaude = path.join(runDir, 'fake-claude.mjs');
  const systemInstructionPath = path.join(runDir, 'system-prompt.txt');
  const prompt = 'x'.repeat(200 * 1024);

  try {
    await writeFile(
      fakeClaude,
      '#!/bin/sh\nwc -c\n'
    );
    await chmod(fakeClaude, 0o700);
    await writeFile(systemInstructionPath, 'System instructions');

    const result = await runCliOnce(
      {
        prompt,
        systemInstruction: 'System instructions',
        systemInstructionPath,
        imagePaths: [],
        runDir
      },
      claudeEntry,
      {
        providerBinaries: { claude: fakeClaude },
        runTimeoutMs: 5_000
      }
    );

    assert.equal(result, String(Buffer.byteLength(prompt)));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('Claude keeps a 200 KiB system instruction out of argv', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-test-'));
  const fakeClaude = path.join(runDir, 'fake-claude');
  const systemInstructionPath = path.join(runDir, 'system-prompt.txt');
  const systemInstruction = 's'.repeat(200 * 1024);

  try {
    await writeFile(fakeClaude, '#!/bin/sh\nwc -c\n');
    await chmod(fakeClaude, 0o700);
    await writeFile(systemInstructionPath, systemInstruction);

    const result = await runCliOnce(
      {
        prompt: 'small prompt',
        systemInstruction,
        systemInstructionPath,
        imagePaths: [],
        runDir
      },
      claudeEntry,
      {
        providerBinaries: { claude: fakeClaude },
        runTimeoutMs: 5_000
      }
    );

    assert.equal(result, String(Buffer.byteLength('small prompt')));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('Codex sends a 200 KiB system instruction through stdin', async () => {
  const systemInstruction = 's'.repeat(200 * 1024);
  const normalized = {
    prompt: 'small prompt',
    systemInstruction,
    imagePaths: [],
    runDir: os.tmpdir()
  };
  const command = providerCommand(normalized, {
    provider: 'codex',
    cliModel: 'gpt-test',
    reasoningEffort: 'medium'
  }, {
    providerBinaries: { codex: 'codex' }
  });

  assert.equal(command.args.includes(systemInstruction), false);
  assert.equal(command.stdin.includes(systemInstruction), true);
  assert.equal(command.stdin.includes(normalized.prompt), true);
});
