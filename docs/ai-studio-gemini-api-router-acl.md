# AI Studio: Router Model ACL Changes For `gemini-api`

`cli-router` now exposes only live router models plus billing metadata through:

```text
GET https://sjpsrpohzcgxkruzrsex.functions.supabase.co/cli-router/v1beta/models
Authorization: Bearer <current user access token>
```

The response is already filtered by:

1. models currently enabled by `cli-router` (`ENABLE_CLAUDE`, `ENABLE_CODEX`, registry `enabled`)
2. the authenticated user's `profiles.allowed_router_models`

## DB Field

Use `profiles.allowed_router_models text[]`.

- `["gpt-5.4"]`: user can use only `gpt-5.4`
- `["gpt-5.4", "gpt-5.5"]`: user can use both Codex models
- `["*"]`: user can use all models currently enabled by `cli-router`

## Required `gemini-api` Enforcement

The UI model list is not a security boundary. `gemini-api` must also reject direct requests where `payload.model_name` is a router model the user is not allowed to use.

Add a helper near existing model routing helpers:

```ts
const getAllowedRouterModelsForUser = async (supabaseAdmin: any, userId: string) => {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("allowed_router_models")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("Router model ACL lookup failed", error);
    throw new Error("Router model ACL lookup failed");
  }

  const models = Array.isArray(data?.allowed_router_models)
    ? data.allowed_router_models.filter((model: unknown) => typeof model === "string" && model.trim())
    : [];

  return new Set(models);
};

const isRouterModelAllowed = (allowedModels: Set<string>, modelName: string) =>
  allowedModels.has("*") || allowedModels.has(modelName);
```

After `modelName`, `useRouter`, and `effectiveIsCustomKey` are calculated, add:

```ts
if (useRouter) {
  const allowedRouterModels = await getAllowedRouterModelsForUser(supabaseAdmin, user.id);
  if (!isRouterModelAllowed(allowedRouterModels, modelName)) {
    return new Response(JSON.stringify({ error: "Model not allowed" }), {
      status: 403,
      headers: { ...corsHeaders(req), "Content-Type": "application/json" },
    });
  }
}
```

Keep the existing behavior:

- `custom_api_key` is ignored for router models.
- Gemini models continue using the current Gemini/BYOK path.
- Router model availability still comes from `cli-router`; if a user has `claude-opus-latest` in DB but `ENABLE_CLAUDE=false`, it must not appear in `/cli-router/v1beta/models`, and direct generation will fail upstream.

## Frontend Model List

Replace hard-coded router model options and billing rules with the filtered `/cli-router/v1beta/models` response:

```ts
const { data } = await supabase.auth.getSession();
const token = data.session?.access_token;

const res = await fetch(
  "https://sjpsrpohzcgxkruzrsex.functions.supabase.co/cli-router/v1beta/models",
  { headers: { Authorization: `Bearer ${token}` } }
);

if (!res.ok) throw new Error("Failed to fetch router models");

const { models } = await res.json();
const routerModels = models.map((model: any) => ({
  id: model.name.replace(/^models\//, ""),
  label: model.displayName,
  provider: model.provider,
  supportsImages: !!model.supportsImages,
  billing: model.billing,
  estimatedUsage: !!model.billing?.estimatedUsage,
}));
```
