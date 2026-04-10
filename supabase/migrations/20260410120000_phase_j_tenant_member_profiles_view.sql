begin;

-- -------------------------------------------------------------------
-- tenant_member_profiles
-- A public-schema view joining tenant_memberships → auth.users → roles
-- so PostgREST can return member profile data in a single query.
--
-- LEFT JOINs are intentional:
--   - auth.users: a deleted user must not silently drop the membership
--     row from admin visibility. Admins need to see orphaned memberships
--     so they can remediate them.
--   - roles: a misconfigured role_id must not hide the membership row.
--
-- Security: queried exclusively by the server via the service-role key
-- (bypasses RLS). All non-service roles are explicitly denied access.
-- -------------------------------------------------------------------
create or replace view public.tenant_member_profiles
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

-- Deny all non-service access. `public` covers any role not listed
-- explicitly; anon/authenticated are belt-and-suspenders.
revoke all on public.tenant_member_profiles from public, anon, authenticated;

commit;
