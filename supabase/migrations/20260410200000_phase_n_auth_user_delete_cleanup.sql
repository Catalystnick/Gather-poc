begin;

-- Allow removing auth users without leaving restrictive FK blockers.
-- Keep tenant/org rows intact by nulling attribution columns instead of cascading org deletion.

-- -------------------------------------------------------------------
-- tenants.created_by -> nullable + ON DELETE SET NULL
-- -------------------------------------------------------------------
alter table public.tenants
  alter column created_by drop not null;

do $$
declare
  fk record;
begin
  for fk in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where c.contype = 'f'
      and n.nspname = 'public'
      and t.relname = 'tenants'
      and a.attname = 'created_by'
  loop
    execute format('alter table public.tenants drop constraint %I', fk.conname);
  end loop;
end
$$;

alter table public.tenants
  add constraint tenants_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

-- -------------------------------------------------------------------
-- tenant_invites.invited_by -> nullable + ON DELETE SET NULL
-- -------------------------------------------------------------------
alter table public.tenant_invites
  alter column invited_by drop not null;

do $$
declare
  fk record;
begin
  for fk in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where c.contype = 'f'
      and n.nspname = 'public'
      and t.relname = 'tenant_invites'
      and a.attname = 'invited_by'
  loop
    execute format('alter table public.tenant_invites drop constraint %I', fk.conname);
  end loop;
end
$$;

alter table public.tenant_invites
  add constraint tenant_invites_invited_by_fkey
  foreign key (invited_by) references auth.users(id) on delete set null;

-- -------------------------------------------------------------------
-- tenant_invites.redeemed_by -> enforce ON DELETE SET NULL explicitly
-- -------------------------------------------------------------------
do $$
declare
  fk record;
begin
  for fk in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where c.contype = 'f'
      and n.nspname = 'public'
      and t.relname = 'tenant_invites'
      and a.attname = 'redeemed_by'
  loop
    execute format('alter table public.tenant_invites drop constraint %I', fk.conname);
  end loop;
end
$$;

alter table public.tenant_invites
  add constraint tenant_invites_redeemed_by_fkey
  foreign key (redeemed_by) references auth.users(id) on delete set null;

commit;
