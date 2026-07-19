# Background Generation and Direct Streaming Architecture

Status: Implemented locally; deployment and production E2E validation pending

Last updated: 2026-07-19

The implementation is intentionally disabled by ENABLE_BACKGROUND_JOBS=false
until the matching Supabase migration, Edge Functions, secrets, and Router service
have been deployed in order. Local unit/build checks pass. Production readiness
remains NEEDS WORK until the deployment gate in section 17 is completed.

## 1. Scope

This document defines the production contract for Mirastral model requests.

- Gemini and Gemini BYOK requests remain proxied through Supabase Edge Functions.
- Codex and Claude requests are launched by Supabase Edge Functions and executed by
  `cli-router`.
- Router output streams directly from `cli-router` to the browser, but the browser
  is never the owner of the generation lifecycle.
- A generation continues after the browser or app disconnects.
- The final response, billing settlement, and durable chat state are committed by a
  signed server-to-server callback.
- Proprietary system prompts, memories, canonical chat history, private attachment
  URLs, and provider credentials never pass through the browser.

This design does not route Gemini traffic through `cli-router` and does not provide
provider fallback.

## 2. Trust Boundaries

### Browser

The browser is untrusted. It may submit:

- action name
- `client_request_id`
- chart/session identifiers
- user-authored input
- attachment object identifiers
- requested model
- allowlisted UI options, language, and timezone

The browser may not supply authoritative prompts, memories, chat history, billing
values, usage values, model capabilities, callback URLs, provider CLI arguments, or
attachment download URLs.

### Supabase Edge and PostgreSQL

Supabase is the control plane and source of truth. It:

- verifies the Supabase user identity and resource ownership
- intersects Router model availability with per-user database permissions
- builds the canonical prompt from server-side data
- validates and reserves credits atomically
- creates normalized chat messages and request records
- stores the private launch payload
- launches Router jobs using project-specific server credentials
- accepts signed terminal callbacks and settles billing atomically
- owns cancellation authorization and stale-request reconciliation

### CLI Router

Router is the execution plane. It:

- accepts only signed project launch and claim requests
- claims each private payload once
- launches an allowlisted Codex or Claude command
- streams visible provider events to authorized viewers
- continues execution without a connected viewer
- enforces provider, context, output, runtime, and launch-rate limits
- sends terminal callbacks and persists failed callback deliveries in an encrypted,
  project-isolated outbox

## 3. Request Flow

1. The browser calls the Edge `prepare-and-launch` endpoint with a Supabase access
   token and a unique UUID `client_request_id`.
2. A PostgreSQL RPC atomically:
   - validates ownership, model permission, active-request policy, and credits
   - creates a credit hold
   - inserts the user message and assistant placeholder
   - inserts the generation request and private canonical payload
3. Edge signs a launch request and calls Router. Router returns `202 Accepted` after
   it has accepted responsibility for claiming the payload.
4. Router claims the private payload from Edge using a separate project-specific
   claim secret. The claim transition is atomic and one-use.
5. Supabase deletes the private payload immediately after successful claim.
6. Edge returns only the request ID and a short-lived, read-only stream token to the
   browser.
7. The browser connects directly to Router's stream endpoint. Disconnecting does not
   cancel the job.
8. Router executes the provider CLI, accumulates visible output in memory, and emits
   stream events to any connected viewer.
9. Router sends a signed terminal callback containing the final or partial visible
   output and authoritative execution metadata.
10. A PostgreSQL RPC atomically updates the exact assistant message, request state,
    memory metadata, suggestions, usage, credit hold, and ledger.

If launch returns a definite rejection, Edge releases the hold and marks the request
failed. If launch delivery is uncertain, Edge queries request status; it never starts
a duplicate model generation automatically.

## 4. Authentication and Capabilities

The following credentials are independent and project-specific:

- Supabase user JWT: browser to Edge only
- launch secret: Edge to Router launch endpoint
- claim secret: Router to Edge private-payload endpoint
- callback secret: Router to Edge terminal callback endpoint
- stream token signing key: Router-issued read-only viewer capability
- outbox encryption key: local, root-only systemd environment

Launch, claim, and callback requests use HMAC signatures over the HTTP method, path,
timestamp, request ID, and body digest. Timestamps have a short acceptance window and
identifiers are replay protected by durable request-state transitions.

The browser stream token:

- has only `stream:read` scope
- is bound to project, request, and user identifiers
- expires 60 seconds after issuance for the initial connection
- is held in memory only
- cannot claim, launch, cancel, or change a request
- is supplied in an authorization header, never a URL

Cancellation always travels browser to Edge with a Supabase JWT, then Edge to Router
with server credentials.

## 5. State Machine and Idempotency

Generation request states:

- `prepared`
- `launching`
- `running`
- `recovery_pending`
- `completed`
- `cancelled`
- `max_tokens`
- `provider_failed`
- `provider_timeout`
- `failed_partial`
- `launch_rejected`
- `expired`

Terminal states cannot be charged or refunded twice. Callback delivery is retryable,
but the callback RPC is idempotent by request ID and terminal transition.

`(user_id, client_request_id)` is unique. Repeating prepare with the same ID returns
the existing request and never creates another hold or CLI process. Manual retry uses
a new UUID.

There is no automatic model-generation retry. Callback delivery retries are allowed
because they do not invoke a provider.

## 6. Billing

Billing uses reserve, settle, and refund semantics.

- The input charge must be fully affordable before launch.
- A separate output reserve may make available credits negative, but not below
  `-1` credit.
- `profiles.credits` stores settled credit and `credit_holds` stores reservations.
- Available credit is settled credit minus active holds.
- A negative balance or insufficient available credit blocks all credit-spending app
  services until balance is restored.
- Reads, browsing existing data, backup download, and top-up remain available.
- Normal completion settles provider-reported usage when available.
- Missing provider usage with valid output uses a conservative server estimate and
  records `usage_source=estimated`.
- Explicit cancellation charges estimated input plus emitted visible output and saves
  the partial answer.
- Provider failure, timeout, Router crash, or stale-request recovery refunds the hold.
- A charge never exceeds its hold. An abnormal overage is audited and not debited.

Provider-reported hidden reasoning and cache usage are included when the CLI reports
them. Subscription CLI traffic receives no API cache discount.

## 7. Limits and Concurrency

- One active Router generation per user in version 1.
- Six provider CLI launches per user in a rolling one-minute window.
- There is no hourly or project-wide launch quota.
- A launch counts once the provider CLI process starts, including later cancellation,
  timeout, and provider failure.
- Requests rejected during authentication, prepare, permissions, balance, or capacity
  checks do not count.
- Rate-limit responses use HTTP 429 and include `retryAfter`.
- A three-second cooldown follows explicit cancellation.
- Router execution has a hard ten-minute limit.
- General chat has a hard maximum of 16,384 estimated output tokens. Memory actions
  may define smaller action-specific limits.
- The callback body has an approximately 1 MiB hard limit.
- Nginx/browser stream timeouts must exceed the Router execution limit, for example
  660 seconds.

Concurrency is stored as policy and resource-scoped locks so future releases can
allow independent app actions without redesigning the schema.

## 8. Streaming Semantics

Claude text deltas are emitted as they arrive.

Codex may emit multiple completed `agent_message` events around searches and tool
activity rather than token deltas. Every visible agent message is forwarded
immediately and accumulated in order. The persisted response exactly matches the
visible agent-message text. Search status, tool events, protocol frames, and
heartbeats are not persisted as answer text.

Stream events are typed. At minimum:

- `snapshot`
- `text_delta`
- `status`
- `heartbeat`
- `terminal`
- `error`

An interrupted stream can reconnect with a fresh short-lived capability obtained
through the authenticated Edge Function. The Router emits a complete `snapshot`
first, and the browser replaces its accumulated text before accepting later deltas.
Stream capabilities are one-use, request/user/project bound, and cannot be refreshed
directly by the browser. The current client attempts at most three reconnects; after
that it follows the Supabase request/message state and receives the final database
update. None of these viewer states affect background completion.

## 9. Cancellation, Failure, and Recovery

Closing the browser is not cancellation. Explicit cancellation terminates the entire
provider process group, saves visible partial output, settles estimated consumed
usage, and enters a terminal state.

For a caught provider failure, Router returns `failed_partial` when visible text
exists and stores that text with an incomplete marker. The user is fully refunded.
When a host or process crash loses in-memory text, the reconciler records failure and
refunds without inventing an answer.

Recovery rules:

- `prepared` requests unclaimed for two minutes expire and release their hold.
- Router reports a metadata-only heartbeat every 30 seconds while executing.
- A missing heartbeat first enters `recovery_pending`.
- A request without a terminal callback 12 minutes after launch becomes failed and is
  refunded.
- A later valid callback cannot charge again. A complete valid answer may still be
  saved for the user and is recorded in the audit trail.
- A systemd restart relies on Supabase reconciliation for lost active jobs and the
  local durable outbox for already completed callbacks.

## 10. Callback and Durable Outbox

The terminal callback contains only:

- project, request, user, chart/session, and message identifiers
- terminal status and timestamps
- final or partial visible output
- model and provider identifiers
- input, output, reasoning, and cache usage when reported
- usage source
- web-search-enabled flag
- bounded parsed memory and suggestions metadata

It never contains prompts, chat history, source memory, Supabase JWTs, BYOK keys,
attachment URLs, CLI arguments, or raw stderr.

Failed callback deliveries are encrypted with AES-256-GCM in a per-project SQLite
outbox under `/var/lib/cli-router/outbox/<internal-project-id>/`. Files and keys are
root-only. Entries are deleted after callback HTTP 2xx, retried for transient errors,
and retained for at most 24 hours before dead-letter alerting.

## 11. Chat and Memory Persistence

`chat_messages` is the permanent normalized source of truth. Each message records an
ID, session/chart/user, role, text, status, Router request ID, model, usage,
attachments, ordering value, and timestamps.

Prepare inserts the user message and assistant placeholder atomically. Callback
updates the exact assistant row. The browser does not write authoritative model
responses or metadata.

The model may return a strict metadata trailer containing bounded memory and up to
three bounded suggestions. The server parses and removes this trailer. Malformed
metadata is ignored while preserving visible answer text. Model output cannot set
identifiers, credits, actions, or arbitrary database fields.

Backup remains a single JSON file. Restore uses an atomic RPC that locks the session,
replaces normalized rows, and commits a new revision.

## 12. Attachments

All providers use a private `chat-attachments` bucket. Object paths are scoped by
user, chart, and a generated object ID. Images, PDF, TXT, and JSON are uploaded before
prepare; requests contain object identifiers rather than base64 payloads.

Edge verifies bucket, ownership, path, declared type, magic bytes, and size. Limits:

- images: 15 MiB
- PDF, TXT, and JSON: 10 MiB

For Router, Edge places short-lived signed URLs in the private claimed payload.
Router permits only the configured Supabase hostname, rejects redirects, streams with
hard size limits, and verifies content. Claude requests reject unsupported images at
prepare. Gemini and BYOK download the same private objects through Edge.

Referenced attachments remain until their message is deleted. Unreferenced uploads
are removed after 24 hours. Related attachments cannot be deleted while a generation
is active. Deleting a chat removes attachments after all related requests are
terminal.

Existing public attachments are copied, verified, and repointed before public copies
are removed and the public bucket is disabled.

## 13. Model Availability and Search

The exposed Router model set is the intersection of:

- models enabled by Router configuration and live `/models` health
- models allowed to the authenticated user by Supabase policy

Router availability fails closed. If Router cannot provide live availability, the UI
shows only Gemini models and Router prepare returns 503. There is no stale-model
launch and no implicit Gemini fallback.

Codex live web search is controlled by Router environment configuration. Mirastral
requests search by default, but Router remains authoritative. The signed private
request carries only an allowlisted boolean; it cannot inject CLI arguments. Claude
continues with tools disabled.

## 14. BYOK

Gemini BYOK keys exist only in browser memory for the current app session. They are
sent over TLS to Edge for the Google request and are not stored in localStorage,
sessionStorage, IndexedDB, PostgreSQL, logs, callbacks, or Router. Reload and logout
clear the key.

The product must state that Mirastral does not persist the key, not that the key never
leaves the device.

## 15. Logging and Browser Security

Production logs contain metadata only: identifiers, action, model, provider, status,
duration, token counts, byte counts, usage source, error classification, and callback
attempt count.

Logs must not contain prompt text, user input, chat, chart data, memory, model output,
attachment URLs or names, authentication tokens, BYOK keys, callback bodies, private
payloads, or raw stderr. Unknown provider errors are represented by a classification,
hash, and length. Logs are rotated and retained for a bounded period.

The frontend removes CDN import maps and inline-script CSP exceptions, uses an HTTP
CSP with exact origins, rejects unsafe Markdown link protocols, opens external links
with `noopener`, and never renders model output through `dangerouslySetInnerHTML`.
Production CORS uses exact configured origins only.

## 16. Migration and Rollout

The feature may be enabled for all current users after mandatory checks pass. A kill
switch must hide Router models and reject new Router requests while allowing active
requests to finish. Rollback never restores the old browser-visible system-prompt
flow.

Existing chat JSON is migrated idempotently to normalized rows. Message count,
ordering, and content hashes are validated before reads switch to normalized data.
The old JSON remains read-only for 30 days with no dual writes, then is removed.

Deployment order:

1. From the app repository, run `CONFIRM_BACKGROUND_DEPLOY=1 npm run deploy:background`.
   This runs frontend and Edge tests, pushes the migration, then deploys claim,
   callback, transaction, and Gemini control-plane functions in order.
2. From the Router repository, run
   `npm run configure:background -- <project-ref> <https-router-url>`, then
   `npm run sync:background-secrets -- <project-ref>`, and restart the systemd
   service while `ENABLE_BACKGROUND_JOBS=false`.
3. Run the production gate below with authenticated test users and verify balances,
   messages, holds, callbacks, outbox retries, and logs.
4. Set `ENABLE_BACKGROUND_JOBS=true`, restart `cli-router`, and verify `/health` and
   the authenticated model catalog before allowing Router launches in the app.

The deploy script intentionally cannot enable the Router kill switch.

## 17. Production Gate

Production remains `NEEDS WORK` until all implementation and tests pass. Required E2E
coverage includes:

- Codex, Claude, Gemini, and Gemini BYOK completion
- browser disconnect with background completion
- explicit cancellation, timeout, Router restart, and callback outage
- duplicate prepare and uncertain launch delivery
- negative credits, rate limits, model policy intersection, and kill switch
- cross-user and cross-project RLS/capability attacks
- image, PDF, TXT, and JSON validation and size enforcement
- long context, search, multiple Codex agent messages, and memory metadata
- XSS, malicious Markdown URLs, attachment redirects, and forged callbacks
- chat and public-attachment migration validation

Any billing, RLS, authentication, or proprietary-prompt exposure failure blocks
deployment. Non-security UI defects may be separately assessed and documented.
