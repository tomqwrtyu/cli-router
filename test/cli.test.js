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
    imagePaths: [],
    runDir: os.tmpdir()
  };
  const config = {
    providerBinaries: { claude: 'claude' }
  };

  const command = providerCommand(normalized, claudeEntry, config);

  assert.equal(command.stdin, prompt);
  assert.equal(command.args.includes(prompt), false);
  assert.deepEqual(
    command.args.slice(command.args.indexOf('--system-prompt')),
    ['--system-prompt', normalized.systemInstruction]
  );
});

test('Claude runner can spawn with a 200 KiB prompt', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-test-'));
  const fakeClaude = path.join(runDir, 'fake-claude.mjs');
  const prompt = 'x'.repeat(200 * 1024);

  try {
    await writeFile(
      fakeClaude,
      '#!/bin/sh\nwc -c\n'
    );
    await chmod(fakeClaude, 0o700);

    const result = await runCliOnce(
      {
        prompt,
        systemInstruction: 'System instructions',
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
