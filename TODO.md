# TODO

## Multi-project cli-router access

- Support multiple trusted Supabase Edge Function clients instead of a single `ROUTER_JWT_PUBLIC_JWK`.
- Store per-client issuer, audience, public JWK, allowed origins, allowed models, and quota/rate-limit policy.
- Include `client_id` and `project_ref` claims in router JWTs signed by each project.
- Verify `issuer + audience + kid` against a trusted-client registry before checking `method`, `path`, `body_sha256`, `jti`, and `exp`.
- Return `/v1beta/models` as the intersection of router-enabled models, client-level policy, and user-level ACL.
- Keep one private signing key per Supabase project so one project can be revoked without rotating every client.
