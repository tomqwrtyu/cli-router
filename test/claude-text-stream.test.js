import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaudeTextStream } from '../src/claude-text-stream.js';

const stream = (event, extra = {}) => ({ type: 'stream_event', event, ...extra });
const start = (index, type, extra = {}) => stream({ type: 'content_block_start', index,
  content_block: { type, ...extra } });
const delta = (index, type, value) => stream({ type: 'content_block_delta', index,
  delta: { type, ...(type === 'thinking_delta' ? { thinking: value } : { text: value }) } });

test('Claude emits only indexed text blocks, not thinking, signatures, snapshots or results', () => {
  const reader = createClaudeTextStream();
  const output = [
    stream({ type: 'message_start' }),
    start(0, 'thinking', { thinking: 'PRIVATE_THINKING_START' }),
    delta(0, 'thinking_delta', 'PRIVATE_THINKING_DELTA'),
    delta(0, 'text_delta', 'MISLABELED_THINKING'),
    delta(0, 'signature_delta', 'PRIVATE_SIGNATURE'),
    stream({ type: 'content_block_stop', index: 0 }),
    start(1, 'redacted_thinking', { data: 'PRIVATE_REDACTED' }),
    delta(1, 'text_delta', 'PRIVATE_REDACTED_DELTA'),
    start(2, 'text', { text: 'Public ' }),
    delta(2, 'text_delta', 'answer'),
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_SNAPSHOT' },
      { type: 'text', text: 'Public answer' }] } },
    stream({ type: 'content_block_stop', index: 2 }),
    stream({ type: 'message_stop' }),
    { type: 'result', is_error: false, result: 'Public answer' }
  ].map(event => reader.consume(event)).join('');
  assert.equal(output, 'Public answer');
  assert.deepEqual(reader.diagnostic(), {
    messages: 1,
    blocks: { text: 1, thinking: 1, redactedThinking: 1, other: 0 },
    textBytes: 13, thinkingDeltas: 1,
    suppressedTextBytes: Buffer.byteLength('MISLABELED_THINKINGPRIVATE_REDACTED_DELTA'),
    finalResultMatchesStream: true,
    stopReasons: {},
    result: { subtype: 'unknown', isError: false, errorCount: 0 }
  });
  assert.doesNotMatch(JSON.stringify(reader.diagnostic()), /PRIVATE|Public|answer/);
});

test('Claude failure diagnostics preserve only allowlisted protocol classifications', () => {
  const reader = createClaudeTextStream();
  reader.consume(stream({ type: 'message_delta', delta: { stop_reason: 'refusal' } }));
  reader.consume(stream({ type: 'message_delta', delta: { stop_reason: 'PRIVATE_REASON' } }));
  reader.consume({ type: 'result', subtype: 'error_max_turns', is_error: true,
    errors: ['PRIVATE_ERROR'], result: 'PRIVATE_RESULT' });
  assert.deepEqual(reader.diagnostic().stopReasons, { refusal: 1, unknown: 1 });
  assert.deepEqual(reader.diagnostic().result, { subtype: 'error_max_turns', isError: true, errorCount: 1 });
  reader.consume({ type: 'result', subtype: 'PRIVATE_SUBTYPE', is_error: true });
  assert.equal(reader.diagnostic().result.subtype, 'unknown');
  assert.doesNotMatch(JSON.stringify(reader.diagnostic()), /PRIVATE/);
});

test('Claude drops unknown, closed, reused and cross-message text block indices', () => {
  const reader = createClaudeTextStream();
  for (const index of [undefined, -1, 1.5, 1024, '0']) {
    assert.equal(reader.consume(start(index, 'text', { text: 'INVALID' })), '');
    assert.equal(reader.consume(delta(index, 'text_delta', 'INVALID')), '');
  }
  assert.equal(reader.consume(delta(4, 'text_delta', 'UNKNOWN')), '');
  assert.equal(reader.consume(start(0, 'text')), '');
  assert.equal(reader.consume(delta(0, 'text_delta', 'First')), 'First');
  reader.consume(stream({ type: 'content_block_stop', index: 0 }));
  assert.equal(reader.consume(delta(0, 'text_delta', 'CLOSED')), '');
  assert.equal(reader.consume(start(0, 'text', { text: 'REUSED' })), '');
  reader.consume(stream({ type: 'message_start' }));
  assert.equal(reader.consume(delta(0, 'text_delta', 'OLD_MESSAGE')), '');
  reader.consume(start(0, 'text'));
  assert.equal(reader.consume(delta(0, 'text_delta', 'Second')), 'Second');
  reader.consume(stream({ type: 'message_stop' }));
  assert.equal(reader.consume(delta(0, 'text_delta', 'STOPPED_MESSAGE')), '');
});

test('Claude ignores nested tool-session text and preserves legitimate English answers', () => {
  const reader = createClaudeTextStream();
  assert.equal(reader.consume({ ...start(0, 'text', { text: 'PRIVATE_SUBAGENT' }),
    parent_tool_use_id: 'tool-1' }), '');
  assert.equal(reader.consume(stream({ type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: 'PRIVATE_SUBAGENT' } }, { parent_tool_use_id: 'tool-1' })), '');
  reader.consume(start(0, 'text'));
  const answer = 'Plan: write an English outline. Metadata format at end.';
  assert.equal(reader.consume(delta(0, 'text_delta', answer)), answer);
  reader.consume({ type: 'result', result: 'Different final answer' });
  assert.equal(reader.diagnostic().finalResultMatchesStream, false);
});

test('Claude ignores invalid event values and reports a missing final result honestly', () => {
  const reader = createClaudeTextStream();
  for (const event of [null, undefined, [], 1, 'text', {}, stream(null)]) {
    assert.equal(reader.consume(event), '');
  }
  assert.equal(reader.diagnostic().finalResultMatchesStream, null);
});
