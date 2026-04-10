begin;

-- Add owner role with full authority.
insert into public.roles (key, name, description, is_system)
values (
  'owner',
  'Owner',
  'Full control over tenant settings, invite access passwords, invites, and members',
  true
)
on conflict (key) do update
set
  name = excluded.name,
  description = excluded.description,
  is_system = excluded.is_system;

-- Add invite access/password permissions used for granular settings authorization.
insert into public.permissions (key, description)
values
  ('tenant.invite.access.manage', 'Manage invite allowlists and invite access policy'),
  ('tenant.invite.password.manage', 'Manage invite access password')
on conflict (key) do update
set description = excluded.description;

-- Owners get all current tenant-management permissions.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in (
  'tenant.invite.create',
  'tenant.members.manage',
  'tenant.settings.manage',
  'tenant.invite.access.manage',
  'tenant.invite.password.manage'
)
where r.key = 'owner'
on conflict (role_id, permission_id) do nothing;

-- Admins can manage users, invites, and allowlists; they cannot change invite passwords or full tenant settings.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in (
  'tenant.invite.create',
  'tenant.members.manage',
  'tenant.invite.access.manage'
)
where r.key = 'admin'
on conflict (role_id, permission_id) do nothing;

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.key = 'admin'
  and p.key in ('tenant.settings.manage', 'tenant.invite.password.manage');

-- tenant_memberships.role is still populated for compatibility with views/legacy paths.
do $$
declare
  role_check record;
begin
  for role_check in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.tenant_memberships'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%role%'
  loop
    execute format(
      'alter table public.tenant_memberships drop constraint %I',
      role_check.conname
    );
  end loop;
end
$$;

alter table public.tenant_memberships
  add constraint tenant_memberships_role_check
  check (role in ('owner', 'admin', 'member'));

-- Backfill creator memberships to owner for active memberships.
update public.tenant_memberships tm
set
  role = 'owner',
  role_id = owner_role.id,
  updated_at = now()
from public.tenants t
join public.roles owner_role on owner_role.key = 'owner'
where tm.tenant_id = t.id
  and tm.user_id = t.created_by
  and tm.status = 'active'
  and (tm.role <> 'owner' or tm.role_id <> owner_role.id);

commit;
