begin;

-- -------------------------------------------------------------------
-- tenant_access_configs
-- -------------------------------------------------------------------
create table if not exists public.tenant_access_configs (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  guest_zone_enforced boolean not null default false,
  guest_can_chat boolean not null default true,
  guest_can_tag boolean not null default true,
  guest_can_teleport boolean not null default false,
  member_can_tag boolean not null default true,
  member_can_teleport boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'tenant_access_configs_set_updated_at'
  ) then
    create trigger tenant_access_configs_set_updated_at
    before update on public.tenant_access_configs
    for each row execute function public.set_updated_at();
  end if;
end
$$;

-- Backfill one config row per existing tenant.
insert into public.tenant_access_configs (
  tenant_id,
  guest_zone_enforced,
  guest_can_chat,
  guest_can_tag,
  guest_can_teleport,
  member_can_tag,
  member_can_teleport
)
select
  t.id,
  false,
  true,
  true,
  false,
  true,
  true
from public.tenants t
left join public.tenant_access_configs tac
  on tac.tenant_id = t.id
where tac.tenant_id is null;

-- -------------------------------------------------------------------
-- RLS
-- -------------------------------------------------------------------
alter table public.tenant_access_configs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_access_configs'
      and policyname = 'tenant_access_configs_select_member'
  ) then
    create policy tenant_access_configs_select_member
    on public.tenant_access_configs
    for select
    to authenticated
    using (
      exists (
        select 1
        from public.tenant_memberships tm
        where tm.tenant_id = tenant_access_configs.tenant_id
          and tm.user_id = auth.uid()
          and tm.status = 'active'
      )
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tenant_access_configs'
      and policyname = 'tenant_access_configs_update_admin'
  ) then
    create policy tenant_access_configs_update_admin
    on public.tenant_access_configs
    for update
    to authenticated
    using (
      exists (
        select 1
        from public.tenant_memberships tm
        join public.roles r on r.id = tm.role_id
        where tm.tenant_id = tenant_access_configs.tenant_id
          and tm.user_id = auth.uid()
          and tm.status = 'active'
          and r.key = 'admin'
      )
    )
    with check (
      exists (
        select 1
        from public.tenant_memberships tm
        join public.roles r on r.id = tm.role_id
        where tm.tenant_id = tenant_access_configs.tenant_id
          and tm.user_id = auth.uid()
          and tm.status = 'active'
          and r.key = 'admin'
      )
    );
  end if;
end
$$;

commit;
