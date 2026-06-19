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

## Example frontend path

Call the Supabase Edge Function with the router path appended:

```text
POST https://<project-ref>.functions.supabase.co/cli-router/v1beta/models/claude-sonnet:streamGenerateContent?alt=sse
```

The request body is the Gemini-shaped JSON body.
