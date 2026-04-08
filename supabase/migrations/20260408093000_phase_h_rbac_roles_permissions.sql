begin;

-- -------------------------------------------------------------------
-- RBAC core tables
-- -------------------------------------------------------------------
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  name text not null,
  description text,
  is_system boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists roles_key_unique_idx
  on public.roles (key);

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'roles_set_updated_at'
  ) then
    create trigger roles_set_updated_at
    before update on public.roles
    for each row execute function public.set_updated_at();
  end if;
end
$$;

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  description text,
  created_at timestamptz not null default now()
);

create unique index if not exists permissions_key_unique_idx
  on public.permissions (key);

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create index if not exists role_permissions_role_permission_idx
  on public.role_permissions (role_id, permission_id);

-- -------------------------------------------------------------------
-- Seed default v1 roles and permissions
-- -------------------------------------------------------------------
insert into public.roles (key, name, description, is_system)
values
  ('admin', 'Admin', 'Can manage tenant members, invites, and settings', true),
  ('member', 'Member', 'Can access tenant worlds and participate in realtime interactions', true)
on conflict (key) do update
set
  name = excluded.name,
  description = excluded.description,
  is_system = excluded.is_system;

insert into public.permissions (key, description)
values
  ('tenant.invite.create', 'Create tenant invites'),
  ('tenant.members.manage', 'Manage tenant members and role assignments'),
  ('tenant.settings.manage', 'Manage tenant settings')
on conflict (key) do update
set description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in ('tenant.invite.create', 'tenant.members.manage', 'tenant.settings.manage')
where r.key = 'admin'
on conflict (role_id, permission_id) do nothing;

-- -------------------------------------------------------------------
-- Extend tenant_memberships with role_id
-- -------------------------------------------------------------------
alter table public.tenant_memberships
  add column if not exists role_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenant_memberships_role_id_fkey'
  ) then
    alter table public.tenant_memberships
      add constraint tenant_memberships_role_id_fkey
      foreign key (role_id) references public.roles(id) on delete restrict;
  end if;
end
$$;

update public.tenant_memberships tm
set role_id = r.id
from public.roles r
where tm.role_id is null
  and tm.role = r.key;

alter table public.tenant_memberships
  alter column role_id set not null;

drop index if exists tenant_memberships_tenant_role_status_idx;
create index if not exists tenant_memberships_tenant_role_id_status_idx
  on public.tenant_memberships (tenant_id, role_id, status);

-- -------------------------------------------------------------------
-- Extend tenant_invites with invited_role_id
-- -------------------------------------------------------------------
alter table public.tenant_invites
  add column if not exists invited_role_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenant_invites_invited_role_id_fkey'
  ) then
    alter table public.tenant_invites
      add constraint tenant_invites_invited_role_id_fkey
      foreign key (invited_role_id) references public.roles(id) on delete restrict;
  end if;
end
$$;

update public.tenant_invites ti
set invited_role_id = r.id
from public.roles r
where ti.invited_role_id is null
  and ti.role = r.key;

alter table public.tenant_invites
  alter column invited_role_id set not null;

-- -------------------------------------------------------------------
-- RLS defaults for RBAC tables
-- -------------------------------------------------------------------
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'roles'
      and policyname = 'roles_select_authenticated'
  ) then
    create policy roles_select_authenticated
    on public.roles
    for select
    to authenticated
    using (true);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'permissions'
      and policyname = 'permissions_select_authenticated'
  ) then
    create policy permissions_select_authenticated
    on public.permissions
    for select
    to authenticated
    using (true);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'role_permissions'
      and policyname = 'role_permissions_select_authenticated'
  ) then
    create policy role_permissions_select_authenticated
    on public.role_permissions
    for select
    to authenticated
    using (true);
  end if;
end
$$;

commit;
