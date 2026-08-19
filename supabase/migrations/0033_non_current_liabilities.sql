-- ============================================================================
-- 0033 — Non-current Liabilities: the one heading Schedule III needs that the
--        chart of accounts had nowhere to put
-- ============================================================================
-- Schedule III (Division II, Companies Act 2013, non-Ind AS) presentation for
-- the Balance Sheet is genuinely just a re-grouping of what 0006 already
-- modelled — Shareholders' Funds is the capital nature, Non-current Assets is
-- fixed_asset, Current Assets is current_asset, Current Liabilities is
-- current_liability — with one real gap: Schedule III requires a distinct
-- "Non-current Liabilities" heading (long-term borrowings, deferred tax
-- liabilities, long-term provisions) ahead of Current Liabilities, and no
-- nature value existed for a ledger to sit there. This migration adds it.
--
-- SCOPE CUT, same voice as 0025's tax-depreciation and 0026's income-tax
-- headers: no sub-division. Non-current Liabilities is one flat bucket, not
-- separately Long-term Borrowings / Deferred Tax Liabilities / Long-term
-- Provisions. Shareholders' Funds stays one bucket too, not Share Capital vs
-- Reserves and Surplus. That finer break is a real gap of its own, left for
-- whoever picks up the rest of Schedule III's inner structure (and the P&L
-- side, explicitly out of scope here).
--
-- enforce_account_group_nature() (0006) does NOT map nature -> a required
-- normal_balance — it only inherits a child's nature from its parent and
-- guards against a re-parenting cycle. There is no trigger anywhere that
-- enforces nature <-> normal_balance; every existing group's normal_balance
-- is just a value the seed function is careful to set consistently, with
-- nothing stopping a hand-created group from disagreeing. Confirmed by
-- reading the live function body, not assumed. So there is nothing to change
-- there beyond the CHECK constraint below; Non-current Liabilities gets
-- normal_balance='credit' at the one place (seed_chart_of_accounts) that
-- creates it, same as Current Liabilities.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- The nature itself
-- ----------------------------------------------------------------------------
alter table public.account_groups
  drop constraint account_groups_nature_check;

alter table public.account_groups
  add constraint account_groups_nature_check
  check (nature in (
    'capital','current_asset','current_liability','non_current_liability','fixed_asset',
    'direct_expense','direct_income','indirect_expense','indirect_income'
  ));


-- ----------------------------------------------------------------------------
-- seed_chart_of_accounts, extended with the ninth system group. Every
-- existing line is unchanged; the new insert and its comment are the only
-- addition. Sort order 9 — the next free number after the existing eight,
-- which run 1-8 contiguously — not spliced in next to Current Liabilities,
-- so the eight existing groups' sort_order values stay untouched.
-- ----------------------------------------------------------------------------
create or replace function app_private.seed_chart_of_accounts(p_company_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_capital uuid;
  v_current_assets uuid;
  v_current_liabilities uuid;
  v_fixed_assets uuid;
begin
  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Capital Account', 'capital', 'credit', 'capital', true, 1)
  returning id into v_capital;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Current Assets', 'current_asset', 'debit', 'other', true, 2)
  returning id into v_current_assets;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Current Liabilities', 'current_liability', 'credit', 'other', true, 3)
  returning id into v_current_liabilities;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Fixed Assets', 'fixed_asset', 'debit', 'fixed_asset', true, 4)
  returning id into v_fixed_assets;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values
    (p_company_id, 'Direct Expenses',   'direct_expense',   'debit',  'expense', true, 5),
    (p_company_id, 'Direct Incomes',    'direct_income',    'credit', 'income',  true, 6),
    (p_company_id, 'Indirect Expenses', 'indirect_expense', 'debit',  'expense', true, 7),
    (p_company_id, 'Indirect Incomes',  'indirect_income',  'credit', 'income',  true, 8);

  -- Ninth system group (0033): a home for a long-term borrowing, a deferred
  -- tax liability, or a long-term provision — none of which belong under
  -- Current Liabilities. Every entity type whose statement_format is
  -- 'simple' is free to never post here; an unused group is harmless, same
  -- as the unused sub-groups already seeded below for every company
  -- regardless of which modules it turns on.
  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Non-current Liabilities', 'non_current_liability', 'credit', 'other', true, 9);

  -- Conventional sub-groups. Deletable and renameable, unlike the nine above.
  insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
  values
    (p_company_id, v_current_assets,      'Bank Accounts',        'current_asset',     'debit',  'cash_bank',  1),
    (p_company_id, v_current_assets,      'Cash-in-Hand',         'current_asset',     'debit',  'cash_bank',  2),
    (p_company_id, v_current_assets,      'Sundry Debtors',       'current_asset',     'debit',  'debtor',     3),
    (p_company_id, v_current_assets,      'Loans & Advances',     'current_asset',     'debit',  'loan',       4),
    (p_company_id, v_current_assets,      'Stock-in-Hand',        'current_asset',     'debit',  'stock',      5),
    (p_company_id, v_current_liabilities, 'Sundry Creditors',     'current_liability', 'credit', 'creditor',   1),
    (p_company_id, v_current_liabilities, 'Duties & Taxes',       'current_liability', 'credit', 'duty_tax',   2),
    (p_company_id, v_current_liabilities, 'Provisions',           'current_liability', 'credit', 'provision',  3),
    (p_company_id, v_current_liabilities, 'Outstanding Expenses', 'current_liability', 'credit', 'other',      4),
    (p_company_id, v_fixed_assets,        'Plant & Machinery',    'fixed_asset',       'debit',  'fixed_asset', 1),
    (p_company_id, v_fixed_assets,        'Office Equipment',     'fixed_asset',       'debit',  'fixed_asset', 2),
    (p_company_id, v_fixed_assets,        'Furniture',            'fixed_asset',       'debit',  'fixed_asset', 3);

  -- TDS Payable, same as Duties & Taxes above: unconditional and harmless
  -- for a company that never deducts TDS from anyone, seeded here so it is
  -- available the moment a TDS-deductee vendor first shows up, with no
  -- separate "configure TDS first" step.
  perform app_private.seed_tds_ledgers(p_company_id);
end;
$$;

comment on function app_private.seed_chart_of_accounts is
  'Nine system groups plus the conventional sub-groups. Duties & Taxes and Stock-in-Hand are seeded here because GST and inventory both need somewhere to post before their modules are configured. Non-current Liabilities (0033) gives Schedule III entity types (opc/pvt_ltd/ltd) a home for long-term borrowings/deferred tax/long-term provisions; every other entity type simply never posts to it. Also seeds the company-wide TDS Payable ledger (app_private.seed_tds_ledgers).';


-- ----------------------------------------------------------------------------
-- Backfill: every company created before this migration is missing the
-- group. Idempotent (WHERE NOT EXISTS) — safe to re-run, same idiom as
-- 0014's default-godown backfill and 0030's TDS-ledger backfill.
-- ----------------------------------------------------------------------------
insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
select c.id, 'Non-current Liabilities', 'non_current_liability', 'credit', 'other', true, 9
  from public.companies c
 where not exists (
   select 1 from public.account_groups g
    where g.company_id = c.id and g.nature = 'non_current_liability'
 );


-- ----------------------------------------------------------------------------
-- get_balance_sheet (0009): the nature filter was a hardcoded four-value IN
-- list, not generic over account_groups.nature — a non_current_liability
-- ledger balance would have been silently excluded from the RPC's output
-- entirely, not merely mis-grouped. The side-assignment CASE needs no change:
-- anything not asset-nature already falls to 'liabilities' by its ELSE
-- branch, which is correct for the new nature too.
-- ----------------------------------------------------------------------------
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
       and g.nature in ('capital','current_asset','current_liability','non_current_liability','fixed_asset')
  )
  select case when nature in ('current_asset','fixed_asset') then 'assets' else 'liabilities' end,
         nature, group_name, ledger_name,
         case when nature in ('current_asset','fixed_asset') then signed else -signed end
    from bal
   where signed <> 0
   order by 1, 2, 3, 4;
$$;
