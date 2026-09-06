# Authenticated Black-box Remediation Plan

Date: 2026-09-06

## Scope

This plan addresses the findings from the deployed unauthenticated and
authenticated black-box reviews of Mirastral. It spans:

- `cli-router`: response hardening and the checked-in Supabase `cli-router`
  Edge Function.
- `Zwei-AI`: model catalog behavior, chat controls, rectification controls,
  memory state, model labels, and frontend caching.
- Deployment configuration: the Supabase Edge Function origin allowlist and
  the HTTPS reverse proxy in front of `router.mirastral.uk`.

A schema migration is required only for the fixed-price router rectification
transaction described below. Because it changes credit reservation and
settlement behavior, that migration is approval-gated and must not be deployed
with the UI-only fixes by accident.

## Implementation status

- Implemented: exact-origin CORS response hardening, preflight caching, router
  JSON/SSE security headers, catalog fail-closed behavior, stop/send guard,
  rectification model inheritance, auxiliary control hitboxes, exact model
  attribution, optimistic memory visibility/rollback, and immutable asset
  caching.
- Automated verification completed. Pending deployment: production origin
  secret synchronization, Edge Function deployment, router service restart,
  and frontend deployment.
- Approval-gated: fixed-price router rectification reservation and settlement
  RPC migration.

## Priority 0

### Dynamic router catalog

1. Configure the Edge Function `ALLOWED_ORIGINS` secret with both production
   origins: `https://mirastral.uk` and `https://www.mirastral.uk`.
2. Keep exact-origin matching. Do not introduce wildcard origins.
3. Make Zwei-AI fail closed when the authenticated router catalog cannot be
   fetched: retain native Gemini models, remove all router models, and surface
   router availability as unavailable instead of returning stale base config.
4. Preserve the successful-path intersection between the router catalog and
   the per-user model policy enforced by the Edge Function.

Acceptance criteria:

- Allowed-origin `OPTIONS` returns 204 with the exact origin, allowed methods,
  allowed headers, `Vary: Origin`, and a preflight cache lifetime.
- Authenticated `GET /v1beta/models` works from both production origins.
- An unlisted origin receives no usable CORS permission.
- If catalog loading fails, no `gpt-*` or `claude-*` model is selectable.

### Stop/send race

1. Give Stop and Send different React identities.
2. Handle pointer-based Stop on `pointerdown` so completion cannot overtake the
   user's stop intent while waiting for `click`.
3. Keep keyboard activation through `click`.
4. Add a short post-generation send guard. A pointer sequence that started on
   Stop must never submit the draft after the response reaches a terminal state.
5. Keep the composer editable during generation so the next draft can still be
   prepared.

Acceptance criteria:

- Completing a generation between stop pointer-down and pointer-up does not
  call `onSendMessage`.
- The draft remains in the composer.
- Deliberate Send works after the short guard expires.
- Keyboard users can stop generation.

## Priority 1

### Rectification model selection and billing

1. Select models in this order: persisted rectification session model, current
   chart chat model, dynamic default model.
2. If the preferred model is no longer available, require a visible valid
   selection rather than silently changing provider.
3. Persist the selected model in the rectification session before generation.
4. Verify fixed-cost charging against the transaction ledger. Starting a new
   paid session must deduct exactly the advertised fixed cost; resuming the same
   session must not charge again. Restarts require a new idempotent transaction.
5. Render charged amount and resulting balance from the server response, not a
   client-side estimate.

Implementation constraint: the existing router transaction RPCs reserve and
settle from token estimates. Supporting the advertised fixed initial cost must
be implemented in `prepare_router_generation` and
`settle_router_generation`, limited to `action = 'rectification'` with
`action_context.isInitialTurn = true`. Follow-up turns remain token-priced, and
failed/partial initial responses must not settle the fixed charge.

### Rectification auxiliary controls

1. Replace the animated `max-height` auxiliary region with a layout whose
   visual and pointer boxes remain aligned, such as an animating grid row.
2. Give the auxiliary region explicit stacking ownership above the composer.
3. Avoid running smooth auto-scroll while the auxiliary region is opening.

Acceptance criteria:

- A real pointer click opens palm assistance after scrolling and after
  reopening a persisted rectification session.
- Keyboard activation continues to work.

### Model attribution

1. Remove the binary `flash ? Flash : Pro` label heuristic.
2. Resolve the completed immutable model ID through the dynamic catalog.
3. Fall back to the raw model ID when catalog metadata is unavailable.

### Memory completion state

1. Apply a memory summary optimistically to both `charts` and `activeChart`
   before persisting it.
2. Keep the related-operation lock until persistence completes.
3. Roll back the optimistic state and present an error if persistence fails.

Acceptance criteria:

- Opening memory management immediately after completion shows the new item
  without a reload.
- A failed write does not leave a local-only memory item.

## Priority 2

### HTTP and deployment hardening

1. Add `X-Content-Type-Options: nosniff` to all router responses, including
   JSON errors and SSE handshakes.
2. Add HSTS at the public HTTPS reverse proxy after confirming the router host
   is HTTPS-only. Start with `max-age=31536000` and do not enable preload or
   `includeSubDomains` as part of this change.
3. Cache fingerprinted `/assets/*` resources for one year with `immutable`;
   keep the HTML entry point revalidatable.
4. Remove unnecessary repository, commit, and deployment-provider metadata
   from public frontend output. Retain only an opaque release identifier if
   support diagnostics require one.

## Verification and release

1. Run `npm run check` in `cli-router`.
2. Run `npm test`, `npm run lint`, and `npm run build` in `Zwei-AI`.
3. Deploy the Edge Function and frontend.
4. Verify CORS from both production origins and one denied origin.
5. Run focused browser checks for catalog failure, the stop/send race,
   rectification model inheritance, palm-assist pointer behavior, immediate
   memory visibility, model attribution, and mobile layout.
6. Do not invoke paid models for browser verification unless explicitly needed;
   use mocked terminal events for the stop/send race.

## Rollback

- Edge Function: redeploy the previous known-good commit and restore the prior
  exact origin secret only if the new configuration prevents production access.
- Frontend: redeploy the previous Vercel release. The changes require no data
  rollback.
- Router headers: remove only the newly added response headers if an upstream
  proxy incompatibility is observed. Do not weaken authentication or origin
  checks during rollback.
