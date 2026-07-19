# TODO

## Multi-project cli-router access

- [x] Accept multiple trusted Supabase clients through `ROUTER_TRUSTED_CLIENTS_JSON`.
- [x] Store per-client issuer, audience, public JWK, allowed origins/models, and launch policy.
- [x] Sign and verify `client_id`, `project_ref`, and protected `kid` claims.
- [x] Resolve `issuer + audience + kid` before signature and request-binding checks.
- [x] Intersect router availability, client model policy, and Supabase user ACL for `/models`.
- [x] Keep private signing keys project-local; the Router registry stores only public JWKs.
- [ ] Add a claim/callback/outbox runtime per client before enabling background jobs for a second project. Authentication and model discovery support multiple clients now, but background endpoints remain bound to the current `ROUTER_PROJECT_ID`.

## Provider quota health cache

- [x] Track provider quota/session-limit failures in the Node process.
- [x] Hide unavailable providers from `/models` until `disabledUntil` passes.
- [x] Parse relative, UTC clock, epoch, and dated reset messages.
- [x] Fall back to a bounded 15-minute cooldown.
- [x] Continue returning 429 for direct or background launches while unavailable.

## Production rollout gate

- [x] Deploy the migration and router-claim, router-callback, attachment-maintenance, gemini-api, and transaction functions.
- [x] Run the production E2E matrix for chat, reconnect, cancel, callback outage recovery, stale recovery, memory actions, private images, documents, and each feature action. The callback drill verified encrypted outbox persistence, automatic redelivery, idempotent settlement, and cleanup.
- [x] Emit structured alerts for outbox expiry/enqueue/flush failures and persist stale reconciliation events.
- [x] Calculate the 12-shichen rectification summary from the canonical owned chart in Edge.
- [x] Test authenticated stream-token refresh and action-specific callback persistence.
- [x] Verify the production Supabase-user `/models` path through Edge and the trusted-client Router registry. The warm request completed in 1.9 seconds.

## Attachment migration

- [x] Copy and checksum every referenced legacy image, rewrite its DB reference, and make `chat-images` private after the reference count reaches zero.
- [x] Run signed hourly cleanup for unreferenced private uploads older than 24 hours.
- [ ] Confirm scheduled retirement removes the now-private `chat-images` bucket after its 1,770 orphan objects reach the 24-hour threshold. No application references remain.
