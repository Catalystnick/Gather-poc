begin;

alter table public.tenant_invites
  add column if not exists invite_type text not null default 'shared'
  check (invite_type in ('shared', 'personalized'));

update public.tenant_invites
set invite_type = case
  when email_optional is not null and btrim(email_optional) <> '' then 'personalized'
  else 'shared'
end
where invite_type is distinct from case
  when email_optional is not null and btrim(email_optional) <> '' then 'personalized'
  else 'shared'
end;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenant_invites_personalized_requires_email'
  ) then
    alter table public.tenant_invites
      add constraint tenant_invites_personalized_requires_email
      check (
        invite_type = 'shared'
        or (email_optional is not null and btrim(email_optional) <> '')
      );
  end if;
end $$;

create index if not exists tenant_invites_tenant_type_status_expires_idx
  on public.tenant_invites (tenant_id, invite_type, status, expires_at);

commit;
