-- ============================================================================
-- 0009 — Reporting functions
-- ============================================================================
-- Reconstructed from the live database, not written fresh. This file was
-- missing from disk entirely — migrations jumped from 0008 straight to 0010
-- — while all six functions below existed live, unchanged, the whole time.
-- Two things made that a real (not just cosmetic) defect rather than pure
-- documentation debt:
--
--   1. 0019_bank_reconciliation.sql calls app_private.ledger_opening_signed
--      at line 204. With this file absent, replaying 0001 through 0020 on an
--      empty database — `supabase db reset`, CI, a fresh clone — fails
--      outright at 0019 with an undefined-function error. This was a broken
--      build waiting to happen, not a documentation gap.
--   2. The five report screens (trial balance, ledger statement, daybook,
--      P&L, balance sheet) all call these RPCs; nothing about their
--      behaviour changes by writing this file, but nothing about the app
--      worked without them either.
--
-- Every definition below is byte-identical to pg_get_functiondef() against
-- the live database, re-verified independently (not copied from a prior
-- report) immediately before this file was written. Nothing here is
-- reconstructed from memory or approximation.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Shared helper
-- ----------------------------------------------------------------------------
-- The opening balance of a ledger, signed (positive = net debit, negative =
-- net credit), as at any date — the ledger's own opening_balance plus every
-- posted, non-deleted entry strictly before p_before. Three of the five
-- report functions below build on this rather than repeating the same
-- opening-balance arithmetic three times with three chances to disagree.
create or replace function app_private.ledger_opening_signed(
  p_company_id uuid,
  p_ledger_id uuid,
  p_before date,
  p_branch_id uuid
) returns numeric
language sql
stable
set search_path = ''
as $$
  select
    coalesce((select case when l.opening_balance_type = 'debit'
                         then l.opening_balance_amount else -l.opening_balance_amount end
                from public.ledgers l where l.id = p_ledger_id), 0)
    + coalesce((select sum(e.debit_amount - e.credit_amount)
                  from public.voucher_entries e
                  join public.vouchers v on v.id = e.voucher_id
                 where e.company_id = p_company_id
                   and e.ledger_id = p_ledger_id
                   and not v.is_deleted
                   and v.voucher_date < p_before
                   and (p_branch_id is null or e.branch_id = p_branch_id)), 0);
$$;


-- ----------------------------------------------------------------------------
-- Trial balance
-- ----------------------------------------------------------------------------
create or replace function public.get_trial_balance(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_branch_id uuid default null
) returns table (
  ledger_id uuid, ledger_name text, group_name text, nature text,
  opening_debit numeric, opening_credit numeric,
  period_debit numeric, period_credit numeric,
  closing_debit numeric, closing_credit numeric
)
language sql
stable
set search_path = ''
as $$
  with base as (
    select l.id, l.name, g.name as group_name, g.nature,
           app_private.ledger_opening_signed(p_company_id, l.id, p_from, p_branch_id) as opening,
           coalesce(sum(e.debit_amount) filter (where v.voucher_date between p_from and p_to), 0) as dr,
           coalesce(sum(e.credit_amount) filter (where v.voucher_date between p_from and p_to), 0) as cr
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
      left join public.voucher_entries e
        on e.ledger_id = l.id
       and (p_branch_id is null or e.branch_id = p_branch_id)
      left join public.vouchers v
        on v.id = e.voucher_id and not v.is_deleted
     where l.company_id = p_company_id
     group by l.id, l.name, g.name, g.nature
  )
  select id, name, group_name, nature,
         case when opening > 0 then opening else 0 end,
         case when opening < 0 then -opening else 0 end,
         dr, cr,
         case when (opening + dr - cr) > 0 then (opening + dr - cr) else 0 end,
         case when (opening + dr - cr) < 0 then -(opening + dr - cr) else 0 end
    from base
   where opening <> 0 or dr <> 0 or cr <> 0
   order by group_name, name;
$$;


-- ----------------------------------------------------------------------------
-- Ledger statement
-- ----------------------------------------------------------------------------
create or replace function public.get_ledger_statement(
  p_company_id uuid,
  p_ledger_id uuid,
  p_from date,
  p_to date,
  p_branch_id uuid default null
) returns table (
  voucher_id uuid, voucher_date date, voucher_number text, voucher_type text,
  narration text, contra_ledgers text,
  debit_amount numeric, credit_amount numeric, running_balance numeric
)
language sql
stable
set search_path = ''
as $$
  with opening as (
    select app_private.ledger_opening_signed(p_company_id, p_ledger_id, p_from, p_branch_id) as bal
  ),
  rows as (
    select v.id, v.voucher_date, v.voucher_number, v.voucher_type, coalesce(e.narration, v.narration) as narration,
           (select string_agg(distinct l2.name, ', ')
              from public.voucher_entries e2
              join public.ledgers l2 on l2.id = e2.ledger_id
             where e2.voucher_id = v.id and e2.ledger_id <> p_ledger_id) as contra,
           e.debit_amount, e.credit_amount,
           row_number() over (order by v.voucher_date, v.voucher_number, e.line_order) as rn
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
     where e.company_id = p_company_id
       and e.ledger_id = p_ledger_id
       and not v.is_deleted
       and v.voucher_date between p_from and p_to
       and (p_branch_id is null or e.branch_id = p_branch_id)
  )
  select r.id, r.voucher_date, r.voucher_number, r.voucher_type, r.narration, r.contra,
         r.debit_amount, r.credit_amount,
         (select bal from opening)
           + sum(r.debit_amount - r.credit_amount) over (order by r.rn rows between unbounded preceding and current row)
    from rows r
   order by r.rn;
$$;


-- ----------------------------------------------------------------------------
-- Daybook
-- ----------------------------------------------------------------------------
create or replace function public.get_daybook(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_branch_id uuid default null
) returns table (
  voucher_id uuid, voucher_date date, voucher_type text, voucher_number text,
  branch_code text, narration text, reference_number text, total_amount numeric,
  party_name text, line_count bigint
)
language sql
stable
set search_path = ''
as $$
  select v.id, v.voucher_date, v.voucher_type, v.voucher_number,
         b.code, v.narration, v.reference_number, v.total_amount,
         p.name, (select count(*) from public.voucher_entries e where e.voucher_id = v.id)
    from public.vouchers v
    join public.branches b on b.id = v.branch_id
    left join public.ledgers p on p.id = v.party_ledger_id
   where v.company_id = p_company_id
     and not v.is_deleted
     and v.voucher_date between p_from and p_to
     and (p_branch_id is null or v.branch_id = p_branch_id)
   order by v.voucher_date, v.voucher_number;
$$;


-- ----------------------------------------------------------------------------
-- Profit and loss
-- ----------------------------------------------------------------------------
-- section splits direct (trading account) from indirect (P&L proper) —
-- Schedule III and the simple statement format both need that split, just
-- rendered differently.
create or replace function public.get_profit_and_loss(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_branch_id uuid default null
) returns table (
  section text, nature text, group_name text, ledger_name text, amount numeric
)
language sql
stable
set search_path = ''
as $$
  select
    case when g.nature in ('direct_income','direct_expense') then 'trading' else 'profit_loss' end,
    g.nature, g.name, l.name,
    case when g.nature like '%income%'
         then coalesce(sum(e.credit_amount - e.debit_amount), 0)
         else coalesce(sum(e.debit_amount - e.credit_amount), 0) end
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    join public.voucher_entries e on e.ledger_id = l.id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where l.company_id = p_company_id
     and g.nature in ('direct_income','direct_expense','indirect_income','indirect_expense')
     and v.voucher_date between p_from and p_to
     and (p_branch_id is null or e.branch_id = p_branch_id)
   group by g.nature, g.name, l.name
  having coalesce(sum(e.debit_amount - e.credit_amount), 0) <> 0
   order by 1, 2, 3, 4;
$$;


-- ----------------------------------------------------------------------------
-- Balance sheet
-- ----------------------------------------------------------------------------
-- Reuses ledger_opening_signed at p_as_at + 1 as a cumulative-balance trick:
-- "opening balance as at the day after p_as_at" is exactly "closing balance
-- as at p_as_at", so the same helper serves both callers.
create or replace function public.get_balance_sheet(
  p_company_id uuid,
  p_as_at date,
  p_branch_id uuid default null
) returns table (
  side text, nature text, group_name text, ledger_name text, amount numeric
)
language sql
stable
set search_path = ''
as $$
  with bal as (
    select g.nature, g.name as group_name, l.name as ledger_name,
           app_private.ledger_opening_signed(p_company_id, l.id, p_as_at + 1, p_branch_id) as signed
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id
       and g.nature in ('capital','current_asset','current_liability','fixed_asset')
  )
  select case when nature in ('current_asset','fixed_asset') then 'assets' else 'liabilities' end,
         nature, group_name, ledger_name,
         case when nature in ('current_asset','fixed_asset') then signed else -signed end
    from bal
   where signed <> 0
   order by 1, 2, 3, 4;
$$;
