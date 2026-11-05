import crypto from 'node:crypto';

// Keep protocol diagnostics, never the prompt, thinking text, or response body.
export function createClaudeTextStream() {
  const blocks = new Map();
  const textHash = crypto.createHash('sha256');
  const counts = { text: 0, thinking: 0, redactedThinking: 0, other: 0 };
  let messages = 0;
  let textBytes = 0;
  let suppressedTextBytes = 0;
  let thinkingDeltas = 0;
  let resultHash = null;
  const stopReasons = {};
  let result = null;
  const knownStops = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded']);
  const knownResults = new Set(['success', 'error_max_turns', 'error_during_execution', 'error_max_budget_usd', 'error_max_structured_output_retries']);
  const emit = (text) => {
    if (typeof text !== 'string') return '';
    textBytes += Buffer.byteLength(text);
    textHash.update(text);
    return text;
  };

  return {
    consume(event) {
      if (!event || typeof event !== 'object' || Array.isArray(event) || event.parent_tool_use_id) return '';
      if (event.type === 'result') {
        result = {
          subtype: knownResults.has(event.subtype) ? event.subtype : 'unknown',
          isError: event.is_error === true,
          errorCount: Array.isArray(event.errors) ? event.errors.length : 0
        };
      }
      if (event.type === 'result' && !event.is_error && typeof event.result === 'string') {
        resultHash = crypto.createHash('sha256').update(event.result).digest('hex');
      }
      if (event.type !== 'stream_event') return '';
      const inner = event.event;
      if (inner?.type === 'message_delta' && typeof inner.delta?.stop_reason === 'string') {
        const reason = knownStops.has(inner.delta.stop_reason) ? inner.delta.stop_reason : 'unknown';
        stopReasons[reason] = (stopReasons[reason] || 0) + 1;
      }
      if (inner?.type === 'message_start') {
        blocks.clear();
        messages++;
        return '';
      }
      if (inner?.type === 'message_stop') {
        blocks.clear();
        return '';
      }
      const index = inner?.index;
      const validIndex = Number.isInteger(index) && index >= 0 && index < 1024;
      if (inner?.type === 'content_block_start') {
        if (!validIndex) return '';
        const type = inner.content_block?.type;
        const key = type === 'text' ? 'text' : type === 'thinking' ? 'thinking'
          : type === 'redacted_thinking' ? 'redactedThinking' : 'other';
        counts[key]++;
        // A duplicate block start is not a new opportunity to forward its text.
        if (blocks.has(index)) {
          blocks.set(index, null);
          return '';
        }
        blocks.set(index, type === 'text' ? 'text' : null);
        return type === 'text' ? emit(inner.content_block.text) : '';
      }
      if (inner?.type === 'content_block_stop') {
        // Retain the index as closed until the next message, preventing reuse.
        if (validIndex) blocks.set(index, null);
        return '';
      }
      if (inner?.type !== 'content_block_delta') return '';
      if (inner.delta?.type === 'thinking_delta') thinkingDeltas++;
      if (inner.delta?.type !== 'text_delta' || typeof inner.delta.text !== 'string') return '';
      if (!validIndex || blocks.get(index) !== 'text') {
        suppressedTextBytes += Buffer.byteLength(inner.delta.text);
        return '';
      }
      return emit(inner.delta.text);
    },
    diagnostic() {
      return {
        messages,
        blocks: { ...counts },
        textBytes,
        thinkingDeltas,
        suppressedTextBytes,
        finalResultMatchesStream: resultHash === null ? null
          : resultHash === textHash.copy().digest('hex'),
        stopReasons: { ...stopReasons },
        result
      };
    }
  };
}
