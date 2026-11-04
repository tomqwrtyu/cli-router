# Manual Memory Output Integrity

Manual increment/condensation have a separate Router estimate budget:
`ROUTER_MAX_MEMORY_OUTPUT_TOKENS=131072` (default). This is eight times the old
16,384 estimate cap, approximately 256 KiB of UTF-8 output with the current
`ceil(bytes / 2)` estimator. It is not a promise of 131,072 actual model tokens.
General chat and independent automatic summaries retain their existing limits.

Mirastral requests the lesser of this 131,072 ceiling and an advertised model
output limit. Native Gemini manual-memory generation uses a 65,536-token output
request. Larger budgets do not guarantee completion: provider limits, safety
stops, transport failures and runtime timeouts still apply.

Publication requires all of:

- A `completed` settled operation, not `max_tokens`, `cancelled`, or partial failure.
- A nonempty memory body and a valid complete six-question metadata trailer.
- For native Gemini, a `STOP` finish reason and an explicit completion receipt
  after persistence and settlement. An interrupted transport without that receipt
  cannot authorize a frontend overwrite.

The callback validates before persisting. Failed/incomplete operations preserve
the old core and source fragments. Database settlement additionally maps manual
memory `max_tokens`/`cancelled` to a failed result, protecting old clients. Output
truncation refunds its hold; deliberate cancellation retains existing usage-based
billing. Retries do not refill failed output or charge again. Result metadata is
stored on the same request in the settlement transaction. Ordinary chat's
partial-output behavior is unchanged.

Migration `20261104000400_memory_operation_integrity.sql` is mirrored as data-plane
`sql/054_memory_operation_integrity.sql`. Apply to the authoritative local plane
and hosted control plane; one successful migration does not prove both planes.
The migration preserves the installed authorization, write gate, concurrency,
cache billing and revision logic. Repeated application is tested.

Memory prose is practitioner working notes, not an external audit of the
assistant/user exchange. Facts, interpretations and unconfirmed information remain
distinct. Silence is not confirmation and length pressure does not invalidate
facts. These are prompt requirements, not proof that a generated merge preserved
every fact.

Do not restore old memory or deleted fragments automatically. Recovery requires
a targeted, separately approved plan after the write-safety fixes are deployed.
This change does not claim to resolve the separate Claude rejected-draft stream
concatenation investigation.

Verification: Router subprocess budget tests; mocked frontend Router/BYOK memory
workflows; Edge finish/completeness tests; rollback-only SQL integrity/refund tests
on an empty schema clone and each deployed data plane. No real-user memory write
or paid provider call is required for these tests.
