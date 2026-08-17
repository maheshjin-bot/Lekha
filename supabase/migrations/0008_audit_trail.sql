-- ============================================================================
-- 0008 — Audit trail
-- ============================================================================
-- Before/after snapshots of every change, written by a trigger rather than by
-- application code — because the client is not the only writer, and an audit
-- log that only records what the UI did is worse than none: it looks complete
-- while missing exactly the writes you most want to see.
--
-- Partitioned by month from the outset. Full JSONB snapshots of every voucher
-- line grow fast, and converting a large unpartitioned table later means a
-- rewrite under lock.
-- ============================================================================

create table public.audit_log (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  table_name text not null,
  record_id uuid,
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  before_data jsonb,
  after_data jsonb,
  -- Set when a change was made by a trigger rather than a person — the
  -- balance check writing back total_amount, for example. Those rows are shown
  -- (hiding rows from an audit log defeats the purpose) but labelled, so they
  -- do not read as somebody editing a voucher.
  derived_note text,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  -- A partitioned table's primary key must include its partition key.
  primary key (id, changed_at)
) partition by range (changed_at);

create index audit_log_company_time_idx on public.audit_log (company_id, changed_at desc);
create index audit_log_record_idx on public.audit_log (table_name, record_id, changed_at desc);

-- Catches anything outside an explicit monthly partition, so an insert can
-- never fail because nobody created next month's table in time. Rows landing
-- here are a signal that partition maintenance has fallen behind, not a fault.
create table public.audit_log_default partition of public.audit_log default;
-- Secured below, once secure_audit_partition() exists.

-- RLS on a partitioned parent does NOT cascade to its partitions, and
-- PostgREST exposes each partition as its own endpoint. Querying the parent
-- honours the policy; querying audit_log_2026_08 directly would not. Every
-- partition therefore needs RLS and the policy in its own right — including
-- ones created months from now, which is why this lives in the maintenance
-- function rather than being applied once by hand.
create or replace function app_private.secure_audit_partition(p_name text)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  execute format('alter table public.%I enable row level security', p_name);
  execute format('alter table public.%I force row level security', p_name);

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = p_name and policyname = 'audit_log_read'
  ) then
    execute format($f$
      create policy audit_log_read on public.%I
        for select to authenticated
        using ((select app_private.user_role_in_company(company_id)) in ('admin','auditor'))
    $f$, p_name);
  end if;
end;
$$;

create or replace function app_private.ensure_audit_partition(p_month date)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name text := 'audit_log_' || to_char(v_start, 'YYYY_MM');
begin
  if to_regclass('public.' || v_name) is null then
    execute format(
      'create table public.%I partition of public.audit_log for values from (%L) to (%L)',
      v_name, v_start, v_end
    );
  end if;
  -- Always, not only on creation: running it twice is harmless, and a
  -- partition that predates this function still needs securing.
  perform app_private.secure_audit_partition(v_name);
end;
$$;

comment on function app_private.ensure_audit_partition is
  'Creates one monthly partition if absent. Call ahead of time from a scheduled job; the DEFAULT partition is the safety net if it lapses.';


-- ----------------------------------------------------------------------------
-- The trigger
-- ----------------------------------------------------------------------------
create or replace function app_private.audit_change()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_before jsonb := case when TG_OP = 'INSERT' then null else to_jsonb(old) end;
  v_after  jsonb := case when TG_OP = 'DELETE' then null else to_jsonb(new) end;
  v_company uuid;
  v_record uuid;
  v_changed text[];
  v_note text;
begin
  -- companies is its own tenant; every other table carries company_id.
  if TG_TABLE_NAME = 'companies' then
    v_company := coalesce((v_after->>'id')::uuid, (v_before->>'id')::uuid);
  else
    v_company := coalesce((v_after->>'company_id')::uuid, (v_before->>'company_id')::uuid);
  end if;

  -- A row with no resolvable company cannot be shown to anyone under RLS, so
  -- recording it would be write-only noise.
  if v_company is null then
    return coalesce(new, old);
  end if;

  v_record := coalesce((v_after->>'id')::uuid, (v_before->>'id')::uuid);

  if TG_OP = 'UPDATE' then
    select array_agg(key) into v_changed
      from jsonb_each(v_after)
     where v_before -> key is distinct from v_after -> key
       and key <> 'updated_at';

    -- Nothing of substance changed — skip rather than log a no-op edit.
    if v_changed is null then
      return new;
    end if;

    -- check_voucher_balance() writes the derived total back after the lines
    -- are in. That is arithmetic, not a person amending a voucher.
    if v_changed = array['total_amount'] then
      v_note := 'Recalculated total';
    end if;
  end if;

  insert into public.audit_log (
    company_id, table_name, record_id, operation,
    before_data, after_data, derived_note, changed_by
  )
  values (
    v_company, TG_TABLE_NAME, v_record, TG_OP,
    v_before, v_after, v_note, auth.uid()
  );

  return coalesce(new, old);
end;
$$;

-- Applied to everything whose change history a reviewer would ask about.
-- Reference tables are excluded: they change by migration, and the migration
-- history is their audit trail.
create trigger audit after insert or update or delete on public.companies
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.company_members
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.company_invites
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.company_modules
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.gst_registrations
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.branches
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.member_branches
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.account_groups
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.ledgers
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.tax_ledger_map
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.vouchers
  for each row execute function app_private.audit_change();
create trigger audit after insert or update or delete on public.voucher_entries
  for each row execute function app_private.audit_change();


-- ----------------------------------------------------------------------------
-- Reading it
-- ----------------------------------------------------------------------------
create or replace function public.get_audit_trail(
  p_company_id uuid,
  p_from timestamptz default (now() - interval '30 days'),
  p_to timestamptz default now(),
  p_table_name text default null,
  p_limit integer default 200
) returns table (
  id uuid,
  table_name text,
  record_id uuid,
  operation text,
  changed_fields text[],
  derived_note text,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    a.id,
    a.table_name,
    a.record_id,
    a.operation,
    case when a.operation = 'UPDATE' then (
      select array_agg(key)
        from jsonb_each(a.after_data)
       where a.before_data -> key is distinct from a.after_data -> key
         and key <> 'updated_at'
    ) end,
    a.derived_note,
    a.changed_by,
    p.full_name,
    a.changed_at
  from public.audit_log a
  left join public.profiles p on p.id = a.changed_by
  where a.company_id = p_company_id
    and a.changed_at between p_from and p_to
    and (p_table_name is null or a.table_name = p_table_name)
  order by a.changed_at desc
  limit least(p_limit, 1000);
$$;


-- ----------------------------------------------------------------------------
-- Row level security
-- ----------------------------------------------------------------------------
alter table public.audit_log enable row level security;

-- Admins and auditors only. An accountant seeing the full change history of
-- their own edits is not a security problem, but the audit trail exists to be
-- read by someone reviewing them, and scoping it that way keeps the role
-- meaningful.
--
-- No insert, update or delete policy exists. The trigger writes as definer;
-- nothing else may write, and nobody at all may amend or remove a row. An
-- editable audit log is not an audit log.
create policy audit_log_read on public.audit_log
  for select to authenticated
  using (
    (select app_private.user_role_in_company(company_id)) in ('admin','auditor')
  );

-- Seed partitions around today and secure every one of them, DEFAULT included.
-- A scheduled job should call ensure_audit_partition() a month or two ahead.
select app_private.ensure_audit_partition((current_date - interval '1 month')::date);
select app_private.ensure_audit_partition(current_date);
select app_private.ensure_audit_partition((current_date + interval '1 month')::date);
select app_private.ensure_audit_partition((current_date + interval '2 months')::date);
select app_private.secure_audit_partition('audit_log_default');
