import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { providerCommand, runCliOnce, streamCli } from '../src/cli.js';

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

test('Claude streaming uses stream-json and forwards only text deltas', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-test-'));
  const fakeClaude = path.join(runDir, 'fake-claude');

  try {
    await writeFile(
      fakeClaude,
      [
        '#!/bin/sh',
        'cat >/dev/null',
        `printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"first "}}}'`,
        `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"duplicate"}]}}'`,
        `printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"second"}}}'`,
        `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"duplicate"}'`
      ].join('\n')
    );
    await chmod(fakeClaude, 0o700);
    const chunks = [];

    await streamCli(
      {
        prompt: 'prompt',
        systemInstruction: '',
        systemInstructionPath: null,
        imagePaths: [],
        runDir
      },
      claudeEntry,
      {
        providerBinaries: { claude: fakeClaude },
        runTimeoutMs: 5_000
      },
      (text) => chunks.push(text)
    );

    assert.equal(chunks.join(''), 'first second');
    const command = providerCommand({ prompt: '', runDir }, claudeEntry, {
      providerBinaries: { claude: 'claude' }
    }, { stream: true });
    assert.equal(command.args.includes('stream-json'), true);
    assert.equal(command.args.includes('--include-partial-messages'), true);
    assert.equal(command.args.includes('--verbose'), true);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
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

test('runner converts a provider context error on stderr into a structured 413', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-test-'));
  const fakeClaude = path.join(runDir, 'fake-claude');

  try {
    await writeFile(fakeClaude, '#!/bin/sh\necho "Input exceeds the maximum length" >&2\n');
    await chmod(fakeClaude, 0o700);

    await assert.rejects(
      () => runCliOnce(
        {
          prompt: 'large prompt',
          systemInstruction: '',
          systemInstructionPath: null,
          imagePaths: [],
          runDir
        },
        claudeEntry,
        {
          providerBinaries: { claude: fakeClaude },
          runTimeoutMs: 5_000
        }
      ),
      (error) => error.statusCode === 413 && error.details.reason === 'context_length_exceeded'
    );
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
    reasoningEffort: 'medium',
    contextWindow: 1_050_000,
    autoCompactTokenLimit: 800_000
  }, {
    providerBinaries: { codex: 'codex' }
  });

  assert.equal(command.args.includes(systemInstruction), false);
  assert.equal(command.stdin.includes(systemInstruction), true);
  assert.equal(command.stdin.includes(normalized.prompt), true);
  assert.equal(command.args.includes('model_context_window=1050000'), true);
  assert.equal(command.args.includes('model_auto_compact_token_limit=800000'), true);
});
