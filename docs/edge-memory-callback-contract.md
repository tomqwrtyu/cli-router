# Edge Memory Callback Contract

This contract applies only to memory actions sent through the router. Ordinary chat and model-list requests remain unchanged.

## Request Flow

1. The authenticated Edge Function validates the Supabase user and model policy.
2. For `condense_memory` or `increment_memory`, it creates a UUID `request_id` and records a pending operation in the database.
3. It signs the normal short-lived ES256 router JWT, adding all three callback claims:

```json
{
  "request_id": "11111111-1111-4111-8111-111111111111",
  "user_id": "22222222-2222-4222-8222-222222222222",
  "action": "condense_memory"
}
```

`request_id` and `user_id` must be UUIDs. `action` must be `condense_memory` or `increment_memory`. Supplying only part of this claim set is rejected. Requests with no callback claims continue to work as normal chat requests.

The existing JWT requirements still apply: ES256 signature, issuer, audience, 60-second maximum lifetime, unique `jti`, exact HTTP method and path, and SHA-256 binding to the exact request bytes.

The Edge Function must pass the same serialized bytes to both `body_sha256` and the upstream request body. Do not parse and reserialize the body after signing.

## Router Response

For callback-enabled requests, the router adds:

```text
X-Router-Request-Id: <request_id>
```

Successful Gemini-shaped responses also include `usageMetadata.routerRequestId`. For SSE, this field is on the final usage chunk. An empty provider result is a `502 UNAVAILABLE` with reason `provider_empty_output`; it is not a successful memory.

## Callback Endpoint

Deploy a dedicated Supabase Edge Function such as:

```text
POST https://<project-host>/functions/v1/router-callback
```

Deploy this callback function with gateway JWT verification disabled. It does not accept a user JWT; its authentication is the HMAC signature below. Keep it separate from the public Gemini proxy route.

Configure the same random secret, at least 32 bytes, in:

- router `.env`: `ROUTER_CALLBACK_SECRET`
- callback Edge Function secret: `ROUTER_CALLBACK_SECRET`

Configure the router destination as `ROUTER_CALLBACK_URL`. Production callback URLs must use HTTPS.

## Callback Authentication

The router sends:

```text
Content-Type: application/json
X-Cli-Router-Event-Id: <request_id>
X-Cli-Router-Timestamp: <Unix seconds>
X-Cli-Router-Signature: v1=<base64url HMAC-SHA256>
```

The signed bytes are exactly:

```text
<timestamp>.<raw HTTP request body>
```

The callback function must:

1. Read the request once with `await req.text()` and preserve those exact bytes for verification.
2. Reject timestamps more than 300 seconds from the current time.
3. Compute HMAC-SHA256 with `ROUTER_CALLBACK_SECRET` and compare it to the `v1` signature in constant time.
4. Parse JSON only after the signature succeeds.
5. Require `X-Cli-Router-Event-Id === body.requestId`.
6. Match both `requestId` and `userId` to the pending database operation.
7. Apply completion or failure idempotently. A repeated event for the same request must return success without applying credits or memory twice.

Do not authorize the callback from CORS, source IP, the event ID, or an unverified request body.

## Callback Body

Success:

```json
{
  "version": 1,
  "event": "router.generation.completed",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "userId": "22222222-2222-4222-8222-222222222222",
  "action": "condense_memory",
  "model": "gpt-5.6-sol",
  "provider": "codex",
  "status": "completed",
  "usageMetadata": {
    "promptTokenCount": 100,
    "candidatesTokenCount": 20,
    "totalTokenCount": 120,
    "routerRequestId": "11111111-1111-4111-8111-111111111111"
  },
  "error": null,
  "completedAt": "2026-01-01T00:00:00.000Z"
}
```

Failure uses `event: router.generation.failed`, `status: failed`, null usage metadata, and a sanitized error:

```json
{
  "error": {
    "code": 502,
    "status": "UNAVAILABLE",
    "message": "Provider returned an empty response",
    "reason": "provider_empty_output"
  }
}
```

The callback never contains the prompt, generated memory, attachments, user JWT, router JWT, or provider stderr.

`provider` can be null when the request fails before a registry model/provider can be resolved.

## Delivery Semantics

The router retries network errors, HTTP 408, HTTP 429, and HTTP 5xx responses with short exponential backoff. Other HTTP 4xx responses stop retries. Callback delivery is at-least-once within this retry window, so the receiver must be idempotent.

Callback failure never replaces or corrupts an already-sent model response. Because the router does not yet persist a durable callback outbox, the Edge Function must keep timed-out pending operations reconcilable instead of treating missing callback delivery as success.

## CORS Contract

The router accepts browser origins only when they exactly match `CORS_ALLOWED_ORIGINS`. The allowed browser request headers are `Authorization` and `Content-Type`; the allowed methods are `GET` and `POST`. The browser may read `X-Router-Request-Id`.

Requests from Supabase Edge Functions normally have no `Origin` header and remain unaffected. CORS is browser policy, not authentication; every non-health router route still requires the signed router JWT.
