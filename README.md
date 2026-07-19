# cli-router

Gemini-shaped API facade for local `claude` and `codex` CLI calls. This project does not call Gemini. It accepts a small Gemini-compatible request shape, verifies a router-only JWT from your Supabase Edge Function, then runs an allowlisted CLI provider.

## Security Boundary

The intended flow is:

```text
Frontend
  -> Supabase Edge Function
     validates Supabase user JWT, app quota, and permissions
     signs a short-lived router JWT
       -> cli-router
          validates router JWT only
          runs claude/codex
```

Do not forward the user's Supabase session token to this router. The router JWT is a separate service-to-service token with a 60 second lifetime, `jti` replay protection, and a `body_sha256` claim bound to the exact request body.

The accepted background generation, billing, private-payload, streaming, and recovery contract is defined in [docs/background-generation-architecture.md](docs/background-generation-architecture.md).

## Setup

```bash
npm install
cp .env.example .env
npm run start
```

Generate an ES256 key with Supabase CLI:

```bash
npx supabase gen signing-key --algorithm ES256
```

Use the generated private JWK in the Supabase Edge Function secret:

```text
ROUTER_JWT_PRIVATE_JWK={... includes "d" ...}
```

Use the public JWK in `cli-router` `.env`:

```bash
ROUTER_JWT_PRIVATE_JWK='{...}' npm run print-public-jwk
```

Set that output as `ROUTER_JWT_PUBLIC_JWK`.

For multiple Supabase projects, set `ROUTER_TRUSTED_CLIENTS_JSON` to an array
of client records containing `clientId`, `projectRef`, `issuer`, `audience`, an
ES256 public JWK with `kid`, exact browser origins, allowed model IDs, and the
client launch policy. Router JWTs must then include matching `client_id` and
`project_ref` claims. Private JWKs remain in each project's Edge secrets and
must never be added to the Router registry.

Convert the current single-project `.env` without exposing its private key:

```bash
npm run configure:trusted-client -- <supabase-project-ref>
```

## Deployment

Link Supabase and set router JWT secrets:

```bash
./scripts/supabase-setup.sh <supabase-project-ref>
```

Deploy only the Edge Function:

```bash
npm run deploy:edge -- https://your-router.example.com
```

Install or restart the Node API as a systemd service:

```bash
npm run service:install
```

Run both:

```bash
npm run deploy -- https://your-router.example.com
```

`ROUTER_URL` must be a public HTTPS URL reachable from Supabase Edge Functions. If this Node process listens on `127.0.0.1`, put it behind a reverse proxy such as Caddy, Nginx, or a tunnel before setting `ROUTER_URL`.

Configure exact browser origins and the optional callback destination in `.env`:

```env
CORS_ALLOWED_ORIGINS=https://www.example.com,https://example.com
ROUTER_CALLBACK_URL=https://your-project.supabase.co/functions/v1/router-callback
ROUTER_CALLBACK_SECRET=replace-with-at-least-32-random-bytes
ENABLE_BACKGROUND_JOBS=true
ROUTER_PROJECT_ID=your-project-ref
ROUTER_CLAIM_URL=https://your-project.supabase.co/functions/v1/router-claim
ROUTER_CLAIM_SECRET=replace-with-at-least-32-random-bytes
ROUTER_STREAM_TOKEN_SECRET=replace-with-at-least-32-random-bytes
ROUTER_OUTBOX_ENCRYPTION_KEY=replace-with-32-byte-base64-or-hex
```

Generate the local background-job secrets and matching project endpoints, then sync
only the required server secrets to Supabase:

```bash
npm run configure:background -- your-project-ref https://your-router.example.com
npm run sync:background-secrets -- your-project-ref
```

Keep `ENABLE_BACKGROUND_JOBS=false` until the database migration and the matching
Edge Functions have been deployed and the production E2E gate has passed. While it
is false, `/v1/jobs` rejects launches and `/v1beta/models` returns no Router models,
so the Supabase user-policy intersection fails closed.

Requests from Edge Functions without an `Origin` header are unaffected by the browser CORS allowlist. The callback URL and secret must either both be configured or both be empty.

## Endpoints

```text
GET  /health
GET  /v1beta/models
POST /v1beta/models/:model:generateContent
POST /v1beta/models/:model:streamGenerateContent?alt=sse
POST /v1/jobs
GET  /v1/jobs/:requestId/stream
POST /v1/jobs/:requestId/stream-token
GET  /v1/jobs/:requestId
POST /v1/jobs/:requestId/cancel
```

Launch, status, cancellation, and stream-token refresh requests require a signed
Edge-to-Router JWT. The browser receives only a short-lived, one-use `stream:read`
token; it cannot launch, cancel, or inspect another user's job. Reconnecting clients
request a fresh stream token through the authenticated Edge Function and replace
their local output with the Router's `snapshot` event before accepting new deltas.

## Calling From Existing Supabase Edge Functions

Existing Edge Functions in the same Supabase project can read the project-wide
secrets that were set by `scripts/supabase-setup.sh`:

- `ROUTER_URL`
- `ROUTER_JWT_PRIVATE_JWK`
- `ROUTER_JWT_ISSUER`
- `ROUTER_JWT_AUDIENCE`

Copy [examples/supabase-router-client.ts](examples/supabase-router-client.ts)
into an existing function, then call:

```ts
const upstream = await callCliRouter(
  '/v1beta/models/claude-sonnet-latest:streamGenerateContent?alt=sse',
  geminiShapedBody,
  { headers: { accept: 'text/event-stream' } }
)

return new Response(upstream.body, {
  status: upstream.status,
  headers: upstream.headers
})
```

Do not forward a user's Supabase session JWT to `cli-router`. The Edge Function
validates the user session, then signs a separate 60-second router JWT.

Supported request subset:

- `contents[].parts[].text`
- `contents[].parts[].inline_data` / `inlineData`
- `contents[].parts[].file_data` / `fileData`
- `systemInstruction.parts[].text`
- `generationConfig` is accepted but only partially used by providers today

Unsupported in v1:

- `tools`
- `toolConfig`
- `cachedContent`
- audio/video
- native PDF understanding

PDF files are converted to extracted text before being included in the prompt. Scanned PDFs without text will not work unless OCR is added later.

## Model Registry

Models are public IDs in `config/models.json`. The router never passes arbitrary model strings to CLIs.

```json
{
  "claude-sonnet-latest": {
    "provider": "claude",
    "cliModel": "sonnet",
    "enabled": true,
    "supportsImages": false,
    "access": {
      "visibility": "restricted"
    },
    "billing": {
      "unit": "credits_per_1m_tokens",
      "input": 2.0,
      "output": 12.0,
      "costMultiplier": 2.0,
      "estimatedUsage": true
    }
  }
}
```

Model entries publish context metadata for clients and server-side preflight.
All exposed Claude and Codex models share a 524,288-character hard input limit
and a 786,432-token estimated input limit. `GET /v1beta/models` exposes these
values as `contextWindow`, `inputCharLimit`, `inputTokenLimit`, and (when known)
`outputTokenLimit`. GPT-5.6 CLI runs explicitly opt into the 1,050,000-token
model context instead of relying on the smaller Codex catalog default.

Provider-wide switches live in `.env`:

```env
ENABLE_CLAUDE=true
ENABLE_CODEX=true
```

## Model Access

The public Supabase `cli-router` Edge Function filters `GET /v1beta/models`
with three layers:

- live router availability from the Node router registry and provider `.env`
- global model visibility from `config/models.json`
- user-level overrides from `profiles.allowed_router_models` and `profiles.blocked_router_models`

The result is an intersection. For example, a user may have admin access with
`allowed_router_models = ['*']`, but Claude models still will not appear if
`ENABLE_CLAUDE=false` on the Node router.

`access.visibility` values:

- `default`: visible to every authenticated user unless blocked for that user
- `restricted`: hidden unless explicitly listed in `allowed_router_models`
- `admin`: visible only when `allowed_router_models` contains `*`

The default visible models are currently `gpt-5.6-sol`, `gpt-5.6-terra`, and
`gpt-5.6-luna`. Codex calls pin `model_reasoning_effort` to `medium` per registry
entry, independent of the host user's global Codex configuration.

`profiles.allowed_router_models` is now an override list, not the full model
list for normal users. It accepts router model IDs without the `models/` prefix:

```sql
update public.profiles
set allowed_router_models = array['claude-sonnet-latest']::text[]
where id = '<user-id>';
```

Use `array['*']::text[]` only for admin users who may access every currently
enabled router model:

```sql
update public.profiles
set allowed_router_models = array['*']::text[]
where id = '<admin-user-id>';
```

Block a default-visible model for one user with:

```sql
update public.profiles
set blocked_router_models = array['gpt-5.6-sol']::text[]
where id = '<user-id>';
```

The public Supabase `cli-router` function is a read-only model catalog. It does
not proxy generation calls. Generation must pass through the authenticated,
metered prepare-and-launch flow in `gemini-api`.

## Attachments

`file_data.file_uri` is treated as a Supabase Storage signed URL. Configure allowed hosts with:

```env
ALLOWED_FILE_URI_HOSTS=.supabase.co
```

Default limits:

- Images: 15 MiB
- JSON/TXT/PDF: 10 MiB
- Injected document text: 50,000 chars
- Estimated image prompt cost: Gemini-style tile estimate. Images where both dimensions are <=384px count as 258 tokens. Larger images use 768x768 tiles at 258 tokens per tile. `IMAGE_PROMPT_MAX_TOKENS=0` means no cap.

Codex supports images through `codex exec --image`. Claude image support is disabled in the default registry because the installed `claude -p` help does not expose a local image attachment flag.

Router `usageMetadata` is estimated from the materialized prompt, not the raw
request JSON. Inline image base64 is not counted as text; images are estimated
from PNG/JPEG/WebP dimensions when available, with `IMAGE_PROMPT_TOKEN_ESTIMATE`
as a fallback when dimensions cannot be parsed. Clients should prefer router
`usageMetadata` over estimating from `JSON.stringify(contents)`.

## Provider Isolation

Provider CLIs are run as one-shot chat backends, not coding agents:

- Claude uses `--safe-mode`, `--no-session-persistence`, disabled slash commands, no tools, and a temporary `--system-prompt-file`. The conversation is passed through stdin. `--safe-mode` disables CLAUDE.md, hooks, skills, plugins, MCP, custom commands, agents, output styles, workflows, and other local customizations while preserving normal Claude Code auth.
- Codex runs with `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--sandbox read-only`, and a temporary `--cd` directory. Application instructions and conversation text are passed through stdin, and images are passed with `--image`.

This keeps request-sized text out of process arguments and prevents global/project coding instructions such as `CLAUDE.md` and `AGENTS.md` from shaping chat responses.
