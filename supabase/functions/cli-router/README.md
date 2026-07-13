# cli-router Edge Function

This function is the only public entry point your frontend should call.

It expects Supabase's normal function JWT verification to validate the user session before this function runs. The function then signs a short-lived router-only JWT and forwards the Gemini-shaped request to `cli-router`.

## Required secrets

Already set by `scripts/supabase-setup.sh`:

- `ROUTER_JWT_PRIVATE_JWK`
- `ROUTER_JWT_ISSUER`
- `ROUTER_JWT_AUDIENCE`

You still need to set:

- `ROUTER_URL`: public HTTPS base URL for this Node router, for example `https://router.example.com`
- `ALLOWED_ORIGINS`: comma-separated frontend origins, for example `https://app.example.com`

The function also uses Supabase's built-in `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` secrets to read router model overrides from
`profiles`.

## Example frontend path

Call the Supabase Edge Function with the router path appended:

```text
POST https://<project-ref>.functions.supabase.co/cli-router/v1beta/models/claude-sonnet-latest:streamGenerateContent?alt=sse
```

The request body is the Gemini-shaped JSON body.

## Model Policy

`GET /v1beta/models` returns only models that are both enabled by the Node
router and visible to the authenticated user.

Visibility comes from `config/models.json`:

- `default`: visible to every authenticated user unless blocked for that user
- `restricted`: hidden unless explicitly listed in `profiles.allowed_router_models`
- `admin`: visible only when `profiles.allowed_router_models` contains `*`

The default visible models are currently `gpt-5.6-sol`, `gpt-5.6-terra`, and
`gpt-5.6-luna`.

`allowed_router_models` and `blocked_router_models` values are router model IDs
without the `models/` prefix. `["*"]` in `allowed_router_models` means all
currently enabled router models. The same policy is enforced before proxying
generation requests, so callers cannot bypass the UI by guessing a model ID.
