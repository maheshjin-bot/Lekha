-- ============================================================================
-- 0037 — Schedule III inner structure: Share Capital, Reserves & Surplus,
--         and the Non-current Liabilities sub-heads
-- ============================================================================
-- The prior migration gave Schedule III its outer structure (Shareholders'
-- Funds / Non-current Liabilities / Current Liabilities, Non-current /
-- Current Assets) but left each liability heading as one flat bucket — its
-- own footer said so explicitly. This is the inner split the roadmap named:
--
--   Shareholders' Funds       -> Share Capital, Reserves and Surplus
--   Non-current Liabilities   -> Long-term Borrowings, Deferred Tax
--                                 Liabilities (Net), Other Long-term
--                                 Liabilities, Long-term Provisions
--
-- FIVE new nature values, following the exact pattern 0033 itself
-- established for non_current_liability: additive, not a rename of
-- anything existing. 'capital' and 'non_current_liability' both keep their
-- current meaning and stay valid. What changes: 'non_current_liability' is
-- now ALSO exactly Schedule III's own "Other Long-term Liabilities" line,
-- relabelled for schedule_iii display rather than needing a sixth new
-- nature to duplicate what it already means.
--
-- TOP-LEVEL SYSTEM GROUPS, NOT SUB-GROUPS OF Capital Account / Non-current
-- Liabilities — a real constraint discovered while building this, not a
-- style choice. app_private.enforce_account_group_nature() (0006) does
-- `new.nature := v_parent_nature` unconditionally for any child group
-- (parent_group_id is not null) — a child's nature is FORCED to match its
-- parent's on every insert and update, full stop. Confirmed live: the
-- first version of this migration tried to seed "Share Capital" as a child
-- of "Capital Account" with nature='share_capital', and the trigger
-- silently rewrote it back to 'capital' every time, including through an
-- explicit `ON CONFLICT ... DO UPDATE SET nature = excluded.nature` that
-- LOOKED like it succeeded (no error) but the returned row still showed
-- the old nature. So these five are new SIBLINGS of Capital Account and
-- Non-current Liabilities — top-level, is_system=true, sort_order 10-14 —
-- not children of them. Schedule III's "Shareholders' Funds" / "Non-current
-- Liabilities" super-headings are therefore display-only groupings by
-- nature-family in the report page, same as they already were for 'capital'
-- and 'non_current_liability' themselves before this migration.
--
-- SEEDED UNCONDITIONALLY for every entity type, same reasoning 0033 already
-- gave for Non-current Liabilities itself: a simple-format company is free
-- to never post to "Share Capital" (that concept does not exist for a
-- proprietorship or partnership in the first place) — an unused group is
-- harmless, same as Duties & Taxes being seeded for a company that never
-- turns GST on.
--
-- get_balance_sheet's nature IN-list gets all five new values — the exact
-- failure 0033's own header warned about (a ledger under an unlisted nature
-- is silently dropped from the RPC's output entirely, not merely
-- mis-grouped) applies identically here if skipped.
--
-- BACKFILL: as top-level groups, these seed into the SAME namespace as
-- Capital Account / Non-current Liabilities themselves (account_groups_
-- root_name_idx: (company_id, name) WHERE parent_group_id IS NULL) — no
-- collision with a pre-existing CHILD group of the same name (confirmed
-- live: several companies already had their own hand-created "Share
-- Capital" / "Reserves and Surplus" sub-groups under Capital Account, under
-- the old catch-all nature — those are untouched, left exactly as they
-- were, not merged or renamed into the new top-level ones).
--
-- ALSO FIXED, found while touching this exact code: LIABILITY_ORDER.simple
-- in the report page never included 'non_current_liability' at all, even
-- after 0033 added the nature to the RPC's own output — a simple-format
-- company with a genuine long-term loan ledger would have had it computed
-- correctly by get_balance_sheet but then silently excluded by the report
-- page's own display-order array, which the RPC fix did not touch. In
-- scope here since this migration is already restructuring that exact
-- array; not a new investigation, a one-line inclusion. Assets are
-- untouched — the inner asset split (Tangible/Intangible/CWIP/Investments)
-- stays out of scope, same as the outer-structure migration's own footer
-- already said.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- The five new natures
-- ----------------------------------------------------------------------------
alter table public.account_groups
  drop constraint account_groups_nature_check;

alter table public.account_groups
  add constraint account_groups_nature_check
  check (nature in (
    'capital','share_capital','reserves_surplus',
    'current_asset','current_liability','non_current_liability',
    'long_term_borrowing','deferred_tax','long_term_provision',
    'fixed_asset',
    'direct_expense','direct_income','indirect_expense','indirect_income'
  ));


-- ----------------------------------------------------------------------------
-- seed_chart_of_accounts, extended with five new top-level system groups
-- (sort_order 10-14). Every existing line is unchanged.
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

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Non-current Liabilities', 'non_current_liability', 'credit', 'other', true, 9);

  -- Schedule III's inner line items (0037). Top-level, not children of
  -- Capital Account / Non-current Liabilities — see the migration header
  -- for why a child group cannot carry its own nature in this schema.
  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values
    (p_company_id, 'Share Capital',                  'share_capital',        'credit', 'capital', true, 10),
    (p_company_id, 'Reserves and Surplus',            'reserves_surplus',     'credit', 'capital', true, 11),
    (p_company_id, 'Long-term Borrowings',            'long_term_borrowing',  'credit', 'other',   true, 12),
    (p_company_id, 'Deferred Tax Liabilities (Net)',  'deferred_tax',         'credit', 'other',   true, 13),
    (p_company_id, 'Long-term Provisions',            'long_term_provision',  'credit', 'other',   true, 14);

  -- Conventional sub-groups. Deletable and renameable, unlike the fourteen above.
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
  'Fourteen system groups plus the conventional sub-groups. Schedule III''s inner Shareholders'' Funds and Non-current Liabilities line items (0037: Share Capital, Reserves and Surplus, Long-term Borrowings, Deferred Tax Liabilities, Long-term Provisions) are top-level system groups, not children of Capital Account / Non-current Liabilities — a child group''s nature is forced to match its parent''s (app_private.enforce_account_group_nature), so a finer nature needs a sibling, not a child. The fourth Non-current Liabilities line, Other Long-term Liabilities, is the Non-current Liabilities group itself. Duties & Taxes and Stock-in-Hand are seeded here because GST and inventory both need somewhere to post before their modules are configured. Also seeds the company-wide TDS Payable ledger (app_private.seed_tds_ledgers).';


-- ----------------------------------------------------------------------------
-- Backfill: every company created before this migration is missing the five
-- new top-level groups. Idempotent (WHERE NOT EXISTS by nature) — safe to
-- re-run. No naming collision risk with a pre-existing CHILD group of the
-- same name, since top-level and child groups occupy separate uniqueness
-- namespaces (account_groups_root_name_idx vs account_groups_child_name_idx)
-- — see the migration header for the company that already had its own
-- hand-created "Share Capital" child group under Capital Account.
-- ----------------------------------------------------------------------------
insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
select c.id, 'Share Capital', 'share_capital', 'credit', 'capital', true, 10
  from public.companies c
 where not exists (select 1 from public.account_groups g where g.company_id = c.id and g.nature = 'share_capital');

insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
select c.id, 'Reserves and Surplus', 'reserves_surplus', 'credit', 'capital', true, 11
  from public.companies c
 where not exists (select 1 from public.account_groups g where g.company_id = c.id and g.nature = 'reserves_surplus');

insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
select c.id, 'Long-term Borrowings', 'long_term_borrowing', 'credit', 'other', true, 12
  from public.companies c
 where not exists (select 1 from public.account_groups g where g.company_id = c.id and g.nature = 'long_term_borrowing');

insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
select c.id, 'Deferred Tax Liabilities (Net)', 'deferred_tax', 'credit', 'other', true, 13
  from public.companies c
 where not exists (select 1 from public.account_groups g where g.company_id = c.id and g.nature = 'deferred_tax');

insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
select c.id, 'Long-term Provisions', 'long_term_provision', 'credit', 'other', true, 14
  from public.companies c
 where not exists (select 1 from public.account_groups g where g.company_id = c.id and g.nature = 'long_term_provision');


-- ----------------------------------------------------------------------------
-- get_balance_sheet (0009, extended 0033): nature filter widened to include
-- the five new natures, all liabilities-side (none of Share Capital,
-- Reserves and Surplus, Long-term Borrowings, Deferred Tax, or Long-term
-- Provisions is ever an asset). The side-assignment CASE needs no change —
-- anything not asset-nature already falls to 'liabilities' by its ELSE
-- branch, correct for every new nature too, same as 0033's own note about
-- non_current_liability.
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
       and g.nature in (
         'capital','share_capital','reserves_surplus',
         'current_asset','current_liability','non_current_liability',
         'long_term_borrowing','deferred_tax','long_term_provision',
         'fixed_asset'
       )
  )
  select case when nature in ('current_asset','fixed_asset') then 'assets' else 'liabilities' end,
         nature, group_name, ledger_name,
         case when nature in ('current_asset','fixed_asset') then signed else -signed end
    from bal
   where signed <> 0
   order by 1, 2, 3, 4;
$$;
