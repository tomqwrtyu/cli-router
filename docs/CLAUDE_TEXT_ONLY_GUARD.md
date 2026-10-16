# Claude text-only output guard

The Router defaults to Claude without tools (`--tools ""`), with customizations
disabled by safe mode and with non-interactive permissions. Operators may enable
the bounded WebSearch-only mode described below. Tool-like text emitted by a
model is never dispatched as a shell command by the Router.

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
- Actual tool-use events outside the selected allowlist fail closed with
  `provider_unexpected_tool_use`.
- Eight matching invocation headers plus parameter markers within a bounded
  8,192-character prose window stop the process with `provider_tool_call_loop`.
  Standard fenced code blocks and inline examples are excluded. This is a narrow
  repetition heuristic, not a general-purpose detector for all malformed output.
- The offending delta is not forwarded; earlier already-streamed text cannot be
  recalled. The request fails rather than being persisted as a completed answer.
- Streaming, plain non-streaming and image/JSON calls share the guard. Image
  calls request partial events even when the API caller requested a final answer,
  allowing early termination without changing the API response format.
- No shell/file/MCP permissions are enabled, no tool results are fabricated, and
  no automatic paid retry or provider fallback is added. Codex behavior is unchanged.

## Optional WebSearch

Set `ENABLE_CLAUDE_LIVE_SEARCH=true` in the Router `.env` and restart the service
to enable Claude's native `WebSearch`. The default when unset is false. The live
model catalog reports this setting as `capabilities.liveWebSearch`.

- Both global enablement and the request policy must allow search. An explicit
  `routerConfig.webSearchEnabled: false` disables it. Local API requests still
  default to no search; the background summary lane always disables search.
- Search-enabled calls use `--tools WebSearch --allowedTools WebSearch`, keep
  `--permission-mode dontAsk` and safe mode, and explicitly deny `mcp__*`.
  WebFetch remains absent from the allowlist and is disabled in the child env.
  Bash, filesystem tools and agents are not made available. These are CLI-level
  restrictions, not a new operating-system network sandbox.
- `--max-turns 4` allows search/result/answer continuations. The native search
  session cap is set to 3, with a separate event guard stopping after 3 unique
  search tool IDs (`provider_search_limit`). Partial and aggregate events sharing
  an ID count once. A WebSearch call can perform multiple backend searches, so
  this is not a claim of only 3 outbound HTTP requests. The overall timeout stays
  unchanged, and the repetition guard remains active.
- Native `WebSearch` and server `web_search` events are recognized only in their
  corresponding tool event types. Unknown tools fail closed. Permission/tool
  allowlisting is the execution boundary; inspecting stdout is defense in depth,
  not authorization before execution.
- Search-enabled non-streaming calls also request JSON events internally, so the
  same inspection applies. Raw tool inputs/results are not forwarded as answer
  text; final answers retain normal streaming and provider aggregate token usage.
- Mirastral enables Claude search for chat only when the live catalog advertises
  the capability. Its other Claude actions retain their previous no-search policy.
  There are no database migrations or changes to stored memories.

Queries are sent to Anthropic's search service. The capability instruction asks
for generic public terms, excludes private conversation/memory/birth/address data
from queries, and treats results as untrusted data. This prompt is a mitigation,
not a deterministic guarantee against disclosure through a model-generated query.
Leave the feature disabled for workflows requiring strict non-disclosure.
WebSearch returns search results; it does not enable arbitrary page retrieval.

Verification uses mock CLIs (including search-result continuations and denied
tool events), not a paid live Claude search. Provider availability/account policy
still needs confirmation during actual use.

Tests use only local fake CLIs and synthetic output. They cover split deltas,
duplicate assistant snapshots, code examples, actual tool events, process
termination, privacy of error responses and preservation of large-prompt stdin.
A successful live Opus reproduction has not been performed as part of this fix;
the instruction reduces the risk but cannot guarantee the model never emits bad
text. The guard is the deterministic failure bound for the tested pattern.

References:
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/tools-reference#websearch-tool-behavior
