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

## Endpoints

```text
GET  /health
GET  /v1beta/models
POST /v1beta/models/:model:generateContent
POST /v1beta/models/:model:streamGenerateContent?alt=sse
```

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

The default visible models are currently `gpt-5.4` and `gpt-5.5`.

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
set blocked_router_models = array['gpt-5.5']::text[]
where id = '<user-id>';
```

The Supabase Edge Function also checks the policy before proxying
`generateContent` or `streamGenerateContent`, so hiding a model from the UI is
not the security boundary.

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

- Claude uses `--safe-mode`, `--no-session-persistence`, disabled slash commands, no tools, and the request `systemInstruction` as `--system-prompt`. `--safe-mode` disables CLAUDE.md, hooks, skills, plugins, MCP, custom commands, agents, output styles, workflows, and other local customizations while preserving normal Claude Code auth.
- Codex runs with `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--sandbox read-only`, and a temporary `--cd` directory. Prompts are passed through stdin, and images are passed with `--image`.

This keeps global/project coding instructions such as `CLAUDE.md` and `AGENTS.md` from shaping chat responses.
