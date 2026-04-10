begin;

alter table public.tenant_access_configs
  add column if not exists invite_allowlist_domains text[] not null default '{}'::text[],
  add column if not exists invite_allowlist_emails text[] not null default '{}'::text[],
  add column if not exists invite_require_password_for_unlisted boolean not null default false,
  add column if not exists invite_password_hash text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenant_access_configs_invite_password_required_check'
  ) then
    alter table public.tenant_access_configs
      add constraint tenant_access_configs_invite_password_required_check
      check (
        not invite_require_password_for_unlisted
        or invite_password_hash is not null
      );
  end if;
end $$;

commit;
