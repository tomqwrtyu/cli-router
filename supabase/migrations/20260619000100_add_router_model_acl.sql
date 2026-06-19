alter table if exists public.profiles
add column if not exists allowed_router_models text[] not null default array['gpt-5.4']::text[];

comment on column public.profiles.allowed_router_models is
  'Allowlisted cli-router model IDs for this user. Use ["*"] to allow all models currently enabled by cli-router.';
