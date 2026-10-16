const WINDOW_CHARS = 8_192;
const REPEATED_INVOCATIONS = 8;

export const CLAUDE_TEXT_ONLY_INSTRUCTION = [
  'You are responding through a text-only API, not an interactive coding session.',
  'Follow the application instructions and requested output format.',
  'No tools, shell, Python execution, or tool-result channel are available.',
  'Never attempt tool calls or wait for tool results. Do not simulate tool execution.',
  'Answer from the supplied conversation and attachments. For a simulated draw or arbitrary choice, choose directly in your reply without claiming an external random generator.',
  'If an unavailable capability is essential, state the limitation rather than repeatedly invoking it.'
].join(' ');

function createToolMarkupGuard() {
  let tail = '';
  let pendingLine = '';
  let fence = null;
  const fenceAt = (line) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const repeated = (text) => {
    const counts = new Map();
    // Examples in inline code are not attempted tool invocations.
    const prose = text.replace(/`[^`]*(?:`|$)/g, '');
    if ((prose.match(/<parameter\b/gi) || []).length < REPEATED_INVOCATIONS) return false;
    for (const [header] of prose.matchAll(/<invoke\s+name\s*=\s*["'][^"'<>]+["'][^>]*>/gi)) {
      const key = header.replace(/\s+/g, ' ').toLowerCase();
      const count = (counts.get(key) || 0) + 1;
      if (count >= REPEATED_INVOCATIONS) return true;
      counts.set(key, count);
    }
    return false;
  };
  const completeLine = (line) => {
    const marker = fenceAt(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character &&
        marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return false;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      tail = '';
      return false;
    }
    tail = (tail + line + '\n').slice(-WINDOW_CHARS);
    return repeated(tail);
  };
  return (text) => {
    const lines = (pendingLine + text).split('\n');
    pendingLine = lines.pop() || '';
    for (const line of lines) if (completeLine(line)) return true;
    // Retain the start-of-line fence marker without retaining an unbounded line.
    if (pendingLine.length > WINDOW_CHARS + 128) {
      pendingLine = pendingLine.slice(0, 128) + pendingLine.slice(-WINDOW_CHARS);
    }
    return !fence && !fenceAt(pendingLine) && repeated((tail + pendingLine).slice(-WINDOW_CHARS));
  };
}

export function createClaudeOutputInspector() {
  const repeatedMarkup = createToolMarkupGuard();
  let sawPartialText = false;
  let sawText = false;
  const inspectText = (text) => {
    if (typeof text !== 'string' || !text) return null;
    sawText = true;
    return repeatedMarkup(text) ? 'provider_tool_call_loop' : null;
  };
  return {
    inspectText,
    inspectEvent(event) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
      const inner = event.type === 'stream_event' ? event.event : null;
      if (inner?.type === 'message_start') sawPartialText = false;
      const content = event.type === 'assistant' ? event.message?.content : null;
      if ((inner?.type === 'content_block_start' &&
        ['tool_use', 'server_tool_use'].includes(inner.content_block?.type)) ||
        (inner?.type === 'message_delta' && inner.delta?.stop_reason === 'tool_use') ||
        (Array.isArray(content) && content.some((part) => ['tool_use', 'server_tool_use'].includes(part?.type)))) {
        return 'provider_unexpected_tool_use';
      }
      if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        sawPartialText = true;
        return inspectText(inner.delta.text);
      }
      if (Array.isArray(content) && !sawPartialText) {
        for (const part of content) {
          if (part?.type === 'text') {
            const reason = inspectText(part.text);
            if (reason) return reason;
          }
        }
      }
      if (event.type === 'result' && !event.is_error && !sawText) return inspectText(event.result);
      return null;
    }
  };
}
