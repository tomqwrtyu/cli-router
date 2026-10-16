import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { providerCommand, runCliOnce, streamCli } from '../src/cli.js';

const model = { provider: 'claude', cliModel: 'opus' };

test('Claude search requires global enablement and respects per-request opt-out', () => {
  for (const [global, requested, enabled] of [
    [undefined, true, false], [false, true, false], [true, false, false],
    [true, true, true], [true, undefined, true]
  ]) {
    const command = providerCommand({ prompt: 'Question', webSearchEnabled: requested }, model, {
      providerBinaries: { claude: 'claude' }, claudeLiveSearch: global
    });
    assert.equal(command.claudeWebSearchEnabled, enabled);
    assert.equal(command.args[command.args.indexOf('--tools') + 1], enabled ? 'WebSearch' : '');
    assert.equal(command.args[command.args.indexOf('--max-turns') + 1], enabled ? '4' : '1');
    assert.equal(command.args.includes('--allowedTools'), enabled);
    assert.equal(command.args[command.args.indexOf('--disallowedTools') + 1], 'mcp__*');
    assert.equal(command.envOverrides.CLAUDE_CODE_DISABLE_WEB_FETCH, '1');
    assert.equal(command.envOverrides.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION, '3');
    if (enabled) {
      assert.equal(command.claudeJsonOutput, true);
      assert.match(command.args[command.args.indexOf('--system-prompt') + 1], /only available tool is WebSearch/);
    }
  }
});

for (const mode of ['stream', 'nonstream', 'image-nonstream']) {
  test(`Claude search continues through tool results to the answer: ${mode}`, async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-search-'));
    const fakeClaude = path.join(runDir, 'fake-claude.mjs');
    const answer = 'Public answer https://example.com/source';
    const events = [
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: {
        type: 'tool_use', name: 'WebSearch', id: 'search-1', input: {}
      } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: {
        type: 'input_json_delta', partial_json: '{"query":"synthetic search"}'
      } } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', id: 'search-1' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search-1', content: 'Do not expose raw results' }] } },
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
      { type: 'result', result: answer, is_error: false, usage: {
        input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 200
      } }
    ];
    try {
      await writeFile(fakeClaude, [
        '#!/usr/bin/env node',
        'import assert from "node:assert/strict";',
        'const args = process.argv.slice(2);',
        'assert.equal(args[args.indexOf("--tools")+1], "WebSearch");',
        'assert.equal(args[args.indexOf("--allowedTools")+1], "WebSearch");',
        'assert.equal(process.env.CLAUDE_CODE_DISABLE_WEB_FETCH, "1");',
        'assert.equal(process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION, "3");',
        'process.stdin.resume();',
        `process.stdin.on('end', () => process.stdout.write(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\n') + '\n')}));`
      ].join('\n'));
      await chmod(fakeClaude, 0o700);
      const normalized = { prompt: 'Synthetic question', runDir, images: mode === 'image-nonstream'
        ? [{ mimeType: 'image/png', base64Data: 'aW1hZ2U=' }] : [] };
      const config = { providerBinaries: { claude: fakeClaude }, claudeLiveSearch: true, runTimeoutMs: 5_000 };
      if (mode === 'stream') {
        const chunks = [];
        const result = await streamCli(normalized, model, config, text => chunks.push(text));
        assert.equal(chunks.join(''), answer);
        assert.equal(result.usageMetadata.promptTokenCount, 300);
        assert.equal(result.usageMetadata.cacheReadTokenCount, 200);
        assert.equal(result.usageMetadata.candidatesTokenCount, 30);
      } else {
        assert.equal(await runCliOnce(normalized, model, config), answer);
      }
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
}

test('enabling search does not permit Bash or expose its payload', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-search-deny-'));
  const fakeClaude = path.join(runDir, 'fake-claude.mjs');
  try {
    const events = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'bad', input: { command: 'private-input' } }] } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'not forwarded' } } }
    ];
    await writeFile(fakeClaude, [
      '#!/usr/bin/env node', 'process.stdin.resume();',
      `process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\n') + '\n')}); setInterval(() => {}, 1000); });`
    ].join('\n'));
    await chmod(fakeClaude, 0o700);
    const config = { providerBinaries: { claude: fakeClaude }, claudeLiveSearch: true, runTimeoutMs: 5_000 };
    for (const mode of ['stream', 'nonstream']) {
      const chunks = [];
      const normalized = { prompt: 'Question', runDir };
      await assert.rejects(() => mode === 'stream'
        ? streamCli(normalized, model, config, text => chunks.push(text))
        : runCliOnce(normalized, model, config), error =>
        error.details.reason === 'provider_unexpected_tool_use' && !JSON.stringify(error).includes('private-input'));
      assert.deepEqual(chunks, []);
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
