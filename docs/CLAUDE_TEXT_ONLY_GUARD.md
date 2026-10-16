# Claude text-only output guard

The Router runs Claude without tools (`--tools ""`), with customizations disabled
by safe mode and with non-interactive permissions. Tool-like text emitted by a
model is not dispatched as a shell command by the Router.

A reported tarot request produced repeated legacy tool-call markup in the text
channel. Metadata-only diagnosis of the cancelled reply counted 108 invocation
starts and 87 mentions of the reported `echo ok` pattern. No private conversation
text or command bodies were retrieved. This establishes repetitive output, not
the upstream model's internal cause or evidence that any command executed.

## Protection

- Claude receives a short text-only capability instruction and `--max-turns 1`.
  An application system prompt remains in its temporary file, with the capability
  instruction appended. Without an application prompt, the text-only instruction
  replaces Claude Code's default coding persona.
- Actual tool-use events fail closed with `provider_unexpected_tool_use`.
- Eight matching invocation headers plus parameter markers within a bounded
  8,192-character prose window stop the process with `provider_tool_call_loop`.
  Standard fenced code blocks and inline examples are excluded. This is a narrow
  repetition heuristic, not a general-purpose detector for all malformed output.
- The offending delta is not forwarded; earlier already-streamed text cannot be
  recalled. The request fails rather than being persisted as a completed answer.
- Streaming, plain non-streaming and image/JSON calls share the guard. Image
  calls request partial events even when the API caller requested a final answer,
  allowing early termination without changing the API response format.
- No tool permissions are enabled, no tool results are fabricated, and no automatic
  paid retry or provider fallback is added. Codex behavior is unchanged.

Tests use only local fake CLIs and synthetic output. They cover split deltas,
duplicate assistant snapshots, code examples, actual tool events, process
termination, privacy of error responses and preservation of large-prompt stdin.
A successful live Opus reproduction has not been performed as part of this fix;
the instruction reduces the risk but cannot guarantee the model never emits bad
text. The guard is the deterministic failure bound for the tested pattern.

References: https://code.claude.com/docs/en/cli-reference
