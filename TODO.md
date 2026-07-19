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

## Production rollout gate

- Deploy the migration and router-claim, router-callback, gemini-api, and transaction functions before enabling Router background jobs.
- [x] Run the production E2E matrix for chat, reconnect, cancel, stale recovery, memory actions, private images, documents, and each feature action. Callback retry is covered by deterministic router integration tests and a clean production outbox; no production outage was injected.
- Alert on `outbox entries expired`, `outbox enqueue failed`, and stale-generation reconciliation events before enabling the kill switch.
- Move the 12-shichen rectification summary calculation into Edge. History and chart ownership are canonical now, but the calculated summary is still browser-derived data.
- Add automated tests for authenticated stream-token refresh and action-specific callback persistence.

## Attachment migration

- Copy existing `chat-images` objects to `chat-attachments`, verify object counts and references, then disable and remove the public bucket.
- Add a scheduled orphan cleanup for unreferenced private uploads older than 24 hours.
