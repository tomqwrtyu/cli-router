alter table if exists public.profiles
alter column allowed_router_models set default array[]::text[];

alter table if exists public.profiles
add column if not exists blocked_router_models text[] not null default array[]::text[];

do $$
begin
  if to_regclass('public.profiles') is not null then
    update public.profiles
    set allowed_router_models = array[]::text[]
    where allowed_router_models <@ array['gpt-5.4', 'gpt-5.5']::text[];
  end if;
end $$;

comment on column public.profiles.allowed_router_models is
  'Extra cli-router model IDs allowed for this user beyond default-visible models. Use ["*"] for admin access to all currently enabled models.';

comment on column public.profiles.blocked_router_models is
  'Default-visible or explicitly allowed cli-router model IDs blocked for this user. Ignored when allowed_router_models contains "*".';
