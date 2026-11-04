# Claude Stream Diagnostics

Claude streaming forwards text only from an explicitly opened, indexed `text`
content block in the main session. Thinking, redacted thinking, signatures,
tool inputs, nested sessions, snapshots and terminal results are not appended to
the visible stream. Block state resets between messages and after message stop.

Both Claude instruction variants request a user-facing answer without planning
notes, preserving application-required output metadata. This is a best-effort
instruction, not a guarantee against the provider writing planning prose inside
an ordinary text block. Do not use language or keyword filters to delete such
prose: those would also damage legitimate replies.

Each finished streaming process writes one `Claude stream protocol` diagnostic
line to the service journal. Background jobs include their request UUID. The
line contains only block counts, byte counts, thinking-delta counts, suppressed
text bytes and whether the successful final result exactly matched the emitted
stream. It contains no prompt, response, thinking, search query or attachment.

`finalResultMatchesStream: false` is diagnostic, not automatic failure: a search
turn can emit progress text before a final answer. A missing terminal result is
reported as `null`. These metrics cannot reconstruct old raw events or prove
that a particular model sentence was hidden reasoning.

The 2026-11-04 reported response was confirmed in persisted Router output. Its
original raw events were not retained. A short, non-private probe on the installed
CLI did not reproduce it, so the historical cause remains unconfirmed. No user
chat or memory was modified during diagnosis. The mitigation does not disable
thinking, reduce agent turns or remove WebSearch.

Regression checks:

```sh
node --test test/claude-text-stream.test.js test/cli.test.js test/claude-search.test.js
npm run check
```
