begin;

-- Redefine tenant_member_profiles with correct column aliases.
-- DROP + CREATE required because Postgres forbids renaming columns via
-- CREATE OR REPLACE VIEW when the existing column names differ.
drop view if exists public.tenant_member_profiles;

create view public.tenant_member_profiles
with (security_invoker = false)
as
select
  m.id,
  m.tenant_id,
  m.user_id,
  m.status,
  m.created_at,
  m.updated_at,
  m.role                                        as role_key,
  r.name                                        as role_name,
  u.email,
  coalesce(
    u.raw_user_meta_data->>'full_name',
    u.raw_user_meta_data->>'name'
  )                                             as display_name
from public.tenant_memberships m
left join auth.users u  on u.id  = m.user_id
left join public.roles r on r.id = m.role_id;

revoke all on public.tenant_member_profiles from public, anon, authenticated;

commit;
