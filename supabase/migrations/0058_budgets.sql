-- ============================================================================
-- 0058 — Budgets and variance analysis
-- ============================================================================
-- A budget is a named, monthly figure per P&L ledger for a financial year;
-- variance analysis compares it against what was actually posted, over
-- whatever date range the reader asks for (a month, a quarter, the year to
-- date). Reuses the exact P&L-nature scoping and sign convention 0057 (cost
-- centres) already established, so a business can eventually cross-cut by
-- both — budget vs actual, per cost centre — without either feature having
-- guessed at the other's shape.
--
-- MONTHLY GRAIN, NOT ANNUAL. A single annual figure per ledger cannot answer
-- "are we on track in Q2" — only "did we, at the end, overspend for the
-- year", which is too late to be useful. budget_lines.period_month is the
-- first day of each calendar month; get_budget_variance sums whichever
-- months fall inside the caller's own [from, to], so one monthly grid serves
-- a single-month check, a quarter, or the year to date with no separate
-- rollup table to keep in step.
--
-- MULTIPLE BUDGETS PER COMPANY, ONE ACTIVE. A business commonly keeps an
-- original budget alongside a mid-year revision — both real, both worth
-- keeping for the record. is_active marks which one a report defaults to
-- without deleting the other; only one can be active at a time, enforced by
-- a partial unique index rather than application logic that could drift.
--
-- ONLY P&L LINES ARE BUDGETABLE, same reasoning as 0057's cost centres: a
-- budget answers "how much did we plan to earn or spend", which is a P&L
-- question. Budgeting capital expenditure or balance-sheet movements is real
-- and common practice but a genuinely different exercise (a capex plan tied
-- to specific assets, not a monthly ledger figure) — not attempted here,
-- documented rather than silently folded in.
--
-- AMOUNTS ARE MAGNITUDES, SIGNED BY NATURE AT COMPARISON TIME, not signed at
-- entry. A budget line for "Purchase Account" is entered as a plain positive
-- number — how much you expect to spend — and get_budget_variance applies
-- the same income-credit-positive / expense-debit-positive convention
-- get_cost_centre_pnl (0057) already uses when pulling the actual. Entering
-- signed figures would ask the budget-setter to think like a ledger, which
-- is exactly the friction a budget screen should not have.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- budgets
-- ----------------------------------------------------------------------------
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  fy_start date not null,
  fy_end date not null check (fy_end > fy_start),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);

-- At most one active budget per company — a report that defaults to "the"
-- active budget must never face two candidates.
create unique index budgets_one_active_per_company_idx
  on public.budgets(company_id) where is_active;

create index budgets_company_idx on public.budgets(company_id);

create trigger set_updated_at before update on public.budgets
  for each row execute function app_private.set_updated_at();

alter table public.budgets enable row level security;

create policy budgets_read on public.budgets
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy budgets_write on public.budgets
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.budgets is
  'A named annual budget. Monthly figures live in budget_lines. Only one budget per company may be is_active at a time (partial unique index) — that is the one variance reports default to.';


-- ----------------------------------------------------------------------------
-- budget_lines
-- ----------------------------------------------------------------------------
create table public.budget_lines (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references public.budgets(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  ledger_id uuid not null,
  -- Always the first of the month — a plain monthly bucket, not a date range.
  period_month date not null,
  amount numeric(18,2) not null default 0 check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (budget_id, ledger_id, period_month),
  foreign key (ledger_id, company_id) references public.ledgers (id, company_id)
);

create index budget_lines_budget_idx on public.budget_lines(budget_id);
create index budget_lines_company_period_idx on public.budget_lines(company_id, period_month);

create trigger set_updated_at before update on public.budget_lines
  for each row execute function app_private.set_updated_at();

alter table public.budget_lines enable row level security;

create policy budget_lines_read on public.budget_lines
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy budget_lines_write on public.budget_lines
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.budget_lines is
  'One monthly figure for one ledger under one budget. period_month is always the first of the month. Amount is a plain positive magnitude — see the migration header for why it is not pre-signed.';


-- ----------------------------------------------------------------------------
-- set_budget_lines(company, budget_id, lines jsonb)
-- ----------------------------------------------------------------------------
-- Bulk upsert so a spreadsheet-style ledger x month grid can be saved in one
-- call, the same shape as create_voucher taking a jsonb array of lines.
-- p_lines: [{"ledger_id": uuid, "period_month": "YYYY-MM-01", "amount": n}, ...]
create or replace function public.set_budget_lines(
  p_company_id uuid,
  p_budget_id uuid,
  p_lines jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line jsonb;
  v_count integer := 0;
  v_ledger_id uuid;
  v_month date;
  v_amount numeric;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'You do not have permission to change budgets for this company';
  end if;

  if not exists (
    select 1 from public.budgets where id = p_budget_id and company_id = p_company_id
  ) then
    raise exception 'That budget does not belong to this company';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_ledger_id := (v_line->>'ledger_id')::uuid;
    -- Truncate to the first of the month regardless of what date the caller
    -- sent — period_month is a bucket, not an arbitrary date, so this keeps
    -- a stray "2026-06-15" from silently creating a second June row.
    v_month := date_trunc('month', (v_line->>'period_month')::date)::date;
    v_amount := coalesce((v_line->>'amount')::numeric, 0);

    if not exists (
      select 1
        from public.ledgers l
        join public.account_groups g on g.id = l.group_id
       where l.id = v_ledger_id
         and l.company_id = p_company_id
         and g.nature in ('direct_income','indirect_income','direct_expense','indirect_expense')
    ) then
      raise exception 'Ledger % is not a profit-and-loss ledger of this company — only those can be budgeted', v_ledger_id;
    end if;

    insert into public.budget_lines (budget_id, company_id, ledger_id, period_month, amount)
    values (p_budget_id, p_company_id, v_ledger_id, v_month, v_amount)
    on conflict (budget_id, ledger_id, period_month)
      do update set amount = excluded.amount;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.set_budget_lines(uuid, uuid, jsonb) from anon;

comment on function public.set_budget_lines is
  'Bulk upsert of budget lines — the grid save behind the budget editor. Refuses any line whose ledger is not a P&L ledger of this company. period_month is truncated to the first of its month before matching, so it always lands in the right bucket regardless of what day-of-month the caller sent.';


-- ----------------------------------------------------------------------------
-- get_budget_variance(company, budget_id, from, to)
-- ----------------------------------------------------------------------------
-- Ledger-wise budgeted vs actual vs variance for the months of the budget
-- that fall inside [from, to]. Actual uses the SAME sign convention
-- get_cost_centre_pnl (0057) already applies: income credit-positive,
-- expense debit-positive — so a positive actual always means "more of the
-- activity happened", matching how the budget figure itself reads.
--
-- A ledger with budget but no actual, or actual but no budget, still appears
-- — full outer join, not an inner one. A silently dropped ledger in either
-- direction would misstate the total exactly the way a filtered cost-centre
-- report would (0057's own documented concern).
create or replace function public.get_budget_variance(
  p_company_id uuid,
  p_budget_id uuid,
  p_from date,
  p_to date
) returns table (
  ledger_id uuid,
  ledger_name text,
  nature text,
  budgeted numeric,
  actual numeric,
  variance numeric,
  variance_percent numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with bud as (
    select bl.ledger_id, sum(bl.amount) as budgeted
      from public.budget_lines bl
     where bl.budget_id = p_budget_id
       and bl.company_id = p_company_id
       and bl.period_month between date_trunc('month', p_from)::date and date_trunc('month', p_to)::date
     group by bl.ledger_id
  ),
  act as (
    select e.ledger_id,
           sum(case when g.nature in ('direct_income','indirect_income')
                    then e.credit_amount - e.debit_amount
                    else e.debit_amount - e.credit_amount end) as actual
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
      join public.ledgers l on l.id = e.ledger_id
      join public.account_groups g on g.id = l.group_id
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date between p_from and p_to
       and g.nature in ('direct_income','indirect_income','direct_expense','indirect_expense')
     group by e.ledger_id
  ),
  ids as (
    select ledger_id from bud
    union
    select ledger_id from act
  )
  select
    i.ledger_id,
    l.name,
    g.nature,
    coalesce(b.budgeted, 0),
    coalesce(a.actual, 0),
    coalesce(a.actual, 0) - coalesce(b.budgeted, 0),
    case when coalesce(b.budgeted, 0) <> 0
         then round((coalesce(a.actual, 0) - b.budgeted) / b.budgeted * 100, 1)
    end
    from ids i
    join public.ledgers l on l.id = i.ledger_id
    join public.account_groups g on g.id = l.group_id
    left join bud b on b.ledger_id = i.ledger_id
    left join act a on a.ledger_id = i.ledger_id
   order by g.nature, l.name;
$$;

comment on function public.get_budget_variance is
  'Budget vs actual per P&L ledger for a period, using budget_lines months that overlap [from, to]. Actual uses the same income-positive/expense-positive convention get_cost_centre_pnl (0057) uses. Ledgers with only a budget or only an actual still appear (full outer join) rather than being dropped from either side. variance_percent is null, not a divide-by-zero error or an infinite figure, when nothing was budgeted.';
