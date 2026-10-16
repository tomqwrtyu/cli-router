import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaudeOutputInspector } from '../src/claude-output.js';

const invoke = '<invoke name="Bash"><parameter name="command">echo ok</parameter></invoke>';
const delta = (text) => ({ type: 'stream_event', event: {
  type: 'content_block_delta', delta: { type: 'text_delta', text }
} });

test('Claude inspector stops repetitive tool markup across arbitrary text chunks', () => {
  for (const separator of ['', '\n']) {
    const inspector = createClaudeOutputInspector();
    const text = (invoke + separator).repeat(108);
    let consumed = 0;
    let reason;
    for (const piece of text.match(/.{1,5}|\n/g)) {
      consumed += piece.length;
      reason = inspector.inspectEvent(delta(piece));
      if (reason) break;
    }
    assert.equal(reason, 'provider_tool_call_loop');
    assert.ok(consumed < text.length / 2);
  }
});

test('Claude inspector preserves fenced and inline examples, including long fences', () => {
  for (const marker of ['```', '~~~~']) {
    const inspector = createClaudeOutputInspector();
    const example = `${marker}xml\n${invoke.repeat(200)}\n${marker}\n`;
    for (const character of example.match(/.{1,37}|\n/g)) {
      assert.equal(inspector.inspectText(character), null);
    }
    assert.equal(inspector.inspectText(`An example: \`${invoke}\`\n`.repeat(20)), null);
    assert.equal(inspector.inspectText('The card is The Star, upright.'), null);
  }
});

test('Claude inspector does not count assistant snapshots twice after partial deltas', () => {
  const inspector = createClaudeOutputInspector();
  assert.equal(inspector.inspectEvent(delta(invoke.repeat(4))), null);
  assert.equal(inspector.inspectEvent({ type: 'assistant', message: {
    content: [{ type: 'text', text: invoke.repeat(4) }]
  } }), null);
  assert.equal(inspector.inspectEvent({ type: 'result', result: invoke.repeat(4) }), null);
});

test('Claude inspector fails closed on actual tool events but not quoted JSON', () => {
  for (const event of [
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } },
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'server_tool_use' } } },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }
  ]) {
    assert.equal(createClaudeOutputInspector().inspectEvent(event), 'provider_unexpected_tool_use');
  }
  assert.equal(createClaudeOutputInspector().inspectEvent(delta('Example: {"type":"tool_use"}')), null);
});

test('Claude inspector checks non-partial assistant and result-only output', () => {
  assert.equal(createClaudeOutputInspector().inspectEvent({ type: 'assistant', message: {
    content: [{ type: 'text', text: invoke.repeat(8) }]
  } }), 'provider_tool_call_loop');
  assert.equal(createClaudeOutputInspector().inspectEvent({ type: 'result', result: invoke.repeat(8) }),
    'provider_tool_call_loop');
});

test('Claude inspector ignores non-event JSON values', () => {
  for (const value of [null, undefined, 1, 'text', []]) {
    assert.equal(createClaudeOutputInspector().inspectEvent(value), null);
  }
});
