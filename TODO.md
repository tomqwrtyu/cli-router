# TODO

## Multi-project cli-router access

- Support multiple trusted Supabase Edge Function clients instead of a single `ROUTER_JWT_PUBLIC_JWK`.
- Store per-client issuer, audience, public JWK, allowed origins, allowed models, and quota/rate-limit policy.
- Include `client_id` and `project_ref` claims in router JWTs signed by each project.
- Verify `issuer + audience + kid` against a trusted-client registry before checking `method`, `path`, `body_sha256`, `jti`, and `exp`.
- Return `/v1beta/models` as the intersection of router-enabled models, client-level policy, and user-level ACL.
- Keep one private signing key per Supabase project so one project can be revoked without rotating every client.

## Provider quota health cache

- Track provider quota/session-limit failures in the Node router when a CLI exits with `provider_quota_exceeded`.
- Temporarily hide models for an unavailable provider from `/v1beta/models` until a `disabledUntil` timestamp passes.
- Parse reset times from provider messages when available, for example Claude's `resets 4:20pm (UTC)` session-limit text.
- Fall back to a conservative fixed cooldown when no reset time can be parsed.
- Keep this as an availability optimization only; direct generation must still return 429 when the provider is quota-limited.

## Direct router-backed chat streaming

- Move router-backed chat off the long-lived Supabase Edge proxy path; Free-plan Edge workers have a 150-second wall-clock limit.
- Reuse the memory flow: authenticate and prepare through Edge, mint a short-lived route-bound JWT, then stream browser-to-router directly.
- Extend callback settlement to chat so billing remains server-authoritative even though the browser owns the streaming connection.
- Finalize chat persistence idempotently only after the signed callback marks the router request completed.
