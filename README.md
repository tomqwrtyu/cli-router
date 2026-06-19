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
./scripts/supabase-setup.sh sjpsrpohzcgxkruzrsex
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
  "claude-sonnet": {
    "provider": "claude",
    "cliModel": "sonnet",
    "enabled": true,
    "supportsImages": false
  }
}
```

Provider-wide switches live in `.env`:

```env
ENABLE_CLAUDE=true
ENABLE_CODEX=true
```

## Attachments

`file_data.file_uri` is treated as a Supabase Storage signed URL. Configure allowed hosts with:

```env
ALLOWED_FILE_URI_HOSTS=.supabase.co
```

Default limits:

- Images: 15 MiB
- JSON/TXT/PDF: 10 MiB
- Injected document text: 50,000 chars

Codex supports images through `codex exec --image`. Claude image support is disabled in the default registry because the installed `claude -p` help does not expose a local image attachment flag.
