-- Phase A schema (Supabase/Postgres)
-- Assumes auth.users exists (Supabase Auth)
begin;

create extension if not exists pgcrypto;

-- -------------------------------------------------------------------
-- Common updated_at trigger
-- -------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -------------------------------------------------------------------
-- tenants
-- -------------------------------------------------------------------
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null,
  access_policy text not null default 'public'
    check (access_policy in ('public', 'private')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tenants_slug_unique_idx
  on public.tenants (lower(slug));

create trigger tenants_set_updated_at
before update on public.tenants
for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------
-- tenant_memberships
-- -------------------------------------------------------------------
create table if not exists public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  status text not null default 'active'
    check (status in ('active', 'invited', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tenant_memberships_tenant_user_unique_idx
  on public.tenant_memberships (tenant_id, user_id);

-- one active home tenant per user (v1 rule)
create unique index if not exists tenant_memberships_one_active_per_user_idx
  on public.tenant_memberships (user_id)
  where status = 'active';

create index if not exists tenant_memberships_user_status_idx
  on public.tenant_memberships (user_id, status);

create index if not exists tenant_memberships_tenant_role_status_idx
  on public.tenant_memberships (tenant_id, role, status);

create trigger tenant_memberships_set_updated_at
before update on public.tenant_memberships
for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------
-- worlds
-- -------------------------------------------------------------------
create table if not exists public.worlds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  world_type text not null
    check (world_type in ('main_plaza', 'tenant_interior')),
  key text not null,
  display_name text not null,
  map_key text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (world_type = 'main_plaza' and tenant_id is null) or
    (world_type = 'tenant_interior' and tenant_id is not null)
  )
);

create unique index if not exists worlds_key_unique_idx
  on public.worlds (key);

-- exactly one main plaza row
create unique index if not exists worlds_single_main_plaza_idx
  on public.worlds ((world_type))
  where world_type = 'main_plaza';

-- one interior world per tenant (v1)
create unique index if not exists worlds_one_interior_per_tenant_idx
  on public.worlds (tenant_id)
  where world_type = 'tenant_interior';

create index if not exists worlds_world_type_tenant_idx
  on public.worlds (world_type, tenant_id);

create trigger worlds_set_updated_at
before update on public.worlds
for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------
-- tenant_invites
-- -------------------------------------------------------------------
create table if not exists public.tenant_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  token_hash text not null,
  role text not null check (role in ('admin', 'member')),
  email_optional text,
  expires_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'redeemed', 'expired', 'revoked')),
  invited_by uuid not null references auth.users(id) on delete restrict,
  redeemed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz
);

create unique index if not exists tenant_invites_token_hash_unique_idx
  on public.tenant_invites (token_hash);

create index if not exists tenant_invites_tenant_status_expires_idx
  on public.tenant_invites (tenant_id, status, expires_at);

-- -------------------------------------------------------------------
-- Seed required main plaza world row
-- -------------------------------------------------------------------
insert into public.worlds (tenant_id, world_type, key, display_name, map_key, is_active)
values (null, 'main_plaza', 'main_plaza', 'Main Plaza', 'main_plaza', true)
on conflict (key) do nothing;

-- -------------------------------------------------------------------
-- RLS (baseline)
-- -------------------------------------------------------------------
alter table public.tenants enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.worlds enable row level security;
alter table public.tenant_invites enable row level security;

-- users can read their own membership rows
create policy tenant_memberships_select_own
on public.tenant_memberships
for select
to authenticated
using (user_id = auth.uid());

-- users can read tenants where they are active members
create policy tenants_select_member
on public.tenants
for select
to authenticated
using (
  exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = tenants.id
      and tm.user_id = auth.uid()
      and tm.status = 'active'
  )
);

-- users can read main plaza + worlds they are active members of
create policy worlds_select_member_or_main_plaza
on public.worlds
for select
to authenticated
using (
  world_type = 'main_plaza'
  or exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = worlds.tenant_id
      and tm.user_id = auth.uid()
      and tm.status = 'active'
  )
);

-- tenant_invites intentionally has no authenticated policy:
-- admin operations should go through backend service role APIs.

commit;
