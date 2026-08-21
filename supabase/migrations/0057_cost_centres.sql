-- ============================================================================
-- 0057 — Cost centres and projects: filling in the dimension hook 0007 left
-- ============================================================================
-- voucher_entries.dimensions (0007) has existed since the voucher engine was
-- written, with a GIN index on it and create_voucher already accepting and
-- storing a per-line `dimensions` object — its own comment calls it "a generic
-- analytical-dimension bag (cost centre/project/salesperson)". Nothing has
-- ever written to it. This migration gives that hook its first real consumer
-- rather than adding a parallel column beside it.
--
-- KEY USED IS 'cost_centre'. One key, named in one place, read in one place.
-- The bag stays open for a second dimension later (salesperson, campaign)
-- without a schema change, which is exactly why 0007 made it jsonb.
--
-- ALLOCATION IS BULK AND AFTER THE FACT, NOT AT VOUCHER ENTRY. That is a
-- deliberate design choice, not a shortcut: cost-centre allocation is how
-- accountants actually work — periodically, over a list, often by someone
-- other than whoever keyed the voucher, and frequently revisited when the
-- allocation basis changes. A required dropdown on every voucher line would
-- also make every single entry slower for the majority of businesses that
-- never use cost centres at all. set_entry_cost_centre() takes an ARRAY of
-- entry ids for exactly this reason.
--
-- ONLY PROFIT-AND-LOSS LINES ARE ALLOCATABLE. A cost centre answers "what did
-- this activity earn or cost", which is a P&L question; tagging a bank balance
-- or a creditor with a cost centre produces a figure that cannot be summed
-- into anything meaningful. Enforced in set_entry_cost_centre, not merely
-- discouraged in the UI.
--
-- PERIOD LOCK IS DELIBERATELY NOT ENFORCED HERE. Every other write path in
-- this app refuses to touch a closed period, and correctly so — those change
-- debits and credits. This one cannot: it writes an analytical label and
-- touches no amount, no ledger and no date, so the trial balance, P&L and
-- balance sheet for a closed period are byte-for-byte identical before and
-- after. Blocking it would make it impossible to allocate a prior year's costs
-- once the books are closed, which is a real and ordinary need. The change is
-- still traceable through the existing audit trail (0008).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- cost_centres
-- ----------------------------------------------------------------------------
create table public.cost_centres (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  name text not null check (length(trim(name)) > 0),
  -- Same table, because they behave identically in every report; the
  -- distinction is what the user calls it. A project tends to be finite and a
  -- cost centre ongoing, but nothing in the arithmetic cares.
  kind text not null default 'cost_centre' check (kind in ('cost_centre','project')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code),
  unique (id, company_id)
);

create index cost_centres_company_idx on public.cost_centres(company_id, is_active);

create trigger set_updated_at before update on public.cost_centres
  for each row execute function app_private.set_updated_at();

alter table public.cost_centres enable row level security;

create policy cost_centres_read on public.cost_centres
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy cost_centres_write on public.cost_centres
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.cost_centres is
  'Cost centres and projects. Allocation lives in voucher_entries.dimensions->>''cost_centre'' (the jsonb hook 0007 created), not in a join table — so an entry carries at most one cost centre and reporting needs no extra join.';


-- ----------------------------------------------------------------------------
-- set_entry_cost_centre(company, entry_ids[], cost_centre_id)
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER because voucher_entries carries no UPDATE policy for
-- clients — every write to it goes through a vetted function, the same shape
-- as create_voucher. Permission is checked explicitly against
-- can_write_company before anything is written.
--
-- Passing NULL as the cost centre CLEARS the allocation, which is why the
-- parameter is nullable and there is no separate unset function.
create or replace function public.set_entry_cost_centre(
  p_company_id uuid,
  p_entry_ids uuid[],
  -- Defaulted to null so the CLEAR case is expressible: passing no cost centre
  -- unsets the allocation. Also makes the argument optional in the generated
  -- client types, so the UI can omit it rather than fake a value.
  p_cost_centre_id uuid default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'You do not have permission to change allocations for this company';
  end if;

  if p_cost_centre_id is not null and not exists (
    select 1 from public.cost_centres
     where id = p_cost_centre_id and company_id = p_company_id
  ) then
    raise exception 'That cost centre does not belong to this company';
  end if;

  -- P&L lines only — see the migration header. Silently skipping a
  -- balance-sheet line would leave the caller thinking it had been allocated,
  -- so the whole call is refused instead.
  if exists (
    select 1
      from public.voucher_entries e
      join public.ledgers l on l.id = e.ledger_id
      join public.account_groups g on g.id = l.group_id
     where e.id = any(p_entry_ids)
       and e.company_id = p_company_id
       and g.nature not in ('direct_income','indirect_income','direct_expense','indirect_expense')
  ) then
    raise exception 'Only profit-and-loss lines can carry a cost centre — one of the selected lines is a balance-sheet account';
  end if;

  update public.voucher_entries e
     set dimensions = case
           when p_cost_centre_id is null then e.dimensions - 'cost_centre'
           else jsonb_set(e.dimensions, '{cost_centre}', to_jsonb(p_cost_centre_id::text), true)
         end
   where e.id = any(p_entry_ids)
     and e.company_id = p_company_id;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke execute on function public.set_entry_cost_centre(uuid, uuid[], uuid) from anon;

comment on function public.set_entry_cost_centre is
  'Bulk-assign (or clear, by passing null) a cost centre across voucher_entries. Refuses the whole call if any line is a balance-sheet account. Does NOT enforce the period lock — it writes an analytical label and changes no amount, so a closed period''s statements are unchanged; see the migration header.';


-- ----------------------------------------------------------------------------
-- get_cost_centre_pnl(company, from, to)
-- ----------------------------------------------------------------------------
-- Income positive, expense positive, net = income - expense. Unallocated lines
-- come back as a real row with a null id rather than being dropped — a cost
-- centre report that silently omits what it could not classify invites the
-- reader to believe the parts sum to the whole when they do not.
create or replace function public.get_cost_centre_pnl(
  p_company_id uuid,
  p_from date,
  p_to date
) returns table (
  cost_centre_id uuid,
  code text,
  name text,
  kind text,
  income numeric,
  expense numeric,
  net numeric,
  entry_count integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with lines as (
    select
      nullif(e.dimensions->>'cost_centre','')::uuid as cc_id,
      g.nature,
      e.debit_amount,
      e.credit_amount
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
      join public.ledgers l on l.id = e.ledger_id
      join public.account_groups g on g.id = l.group_id
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date between p_from and p_to
       and g.nature in ('direct_income','indirect_income','direct_expense','indirect_expense')
  ),
  agg as (
    select
      cc_id,
      sum(case when nature in ('direct_income','indirect_income')
               then credit_amount - debit_amount else 0 end) as income,
      sum(case when nature in ('direct_expense','indirect_expense')
               then debit_amount - credit_amount else 0 end) as expense,
      count(*)::integer as entry_count
      from lines
     group by cc_id
  )
  select
    a.cc_id,
    c.code,
    coalesce(c.name, '(unallocated)') as name,
    c.kind,
    a.income,
    a.expense,
    a.income - a.expense as net,
    a.entry_count
    from agg a
    left join public.cost_centres c on c.id = a.cc_id and c.company_id = p_company_id
   order by (a.cc_id is null), c.kind nulls last, c.code nulls last;
$$;

comment on function public.get_cost_centre_pnl is
  'Profit and loss sliced by cost centre for a period. Unallocated P&L lines are returned as a row with a null cost_centre_id and the label "(unallocated)" rather than being dropped, so the rows always sum to the company P&L. Balance-sheet lines are excluded entirely — a cost centre is a P&L concept.';


-- ----------------------------------------------------------------------------
-- get_allocatable_entries(company, from, to, unallocated_only)
-- ----------------------------------------------------------------------------
-- The working list the allocation screen drives. Returns the P&L lines in the
-- period with whatever cost centre they currently carry, so the same screen
-- serves first-time allocation and later re-allocation.
create or replace function public.get_allocatable_entries(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_unallocated_only boolean default true
) returns table (
  entry_id uuid,
  voucher_id uuid,
  voucher_date date,
  voucher_number text,
  voucher_type text,
  ledger_name text,
  nature text,
  narration text,
  amount numeric,
  is_expense boolean,
  cost_centre_id uuid,
  cost_centre_name text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    e.id,
    v.id,
    v.voucher_date,
    v.voucher_number,
    v.voucher_type,
    l.name,
    g.nature,
    coalesce(e.narration, v.narration),
    case when g.nature in ('direct_expense','indirect_expense')
         then e.debit_amount - e.credit_amount
         else e.credit_amount - e.debit_amount end,
    g.nature in ('direct_expense','indirect_expense'),
    c.id,
    c.name
    from public.voucher_entries e
    join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
    join public.ledgers l on l.id = e.ledger_id
    join public.account_groups g on g.id = l.group_id
    left join public.cost_centres c
      on c.id = nullif(e.dimensions->>'cost_centre','')::uuid
     and c.company_id = p_company_id
   where e.company_id = p_company_id
     and not v.is_deleted
     and v.voucher_date between p_from and p_to
     and g.nature in ('direct_income','indirect_income','direct_expense','indirect_expense')
     and (not p_unallocated_only or e.dimensions->>'cost_centre' is null)
   order by v.voucher_date, v.voucher_number, e.line_order;
$$;

comment on function public.get_allocatable_entries is
  'P&L voucher lines in a period, with the cost centre each currently carries. p_unallocated_only defaults true (the first-pass allocation list); pass false to see and re-allocate everything.';
