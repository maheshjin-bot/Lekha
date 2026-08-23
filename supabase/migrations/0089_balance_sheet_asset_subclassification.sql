-- ============================================================================
-- 0089 — Balance sheet: the asset side gets Schedule III's own sub-heads,
--        and the report gains a prior-year-end comparative column
-- ============================================================================
-- Two related gaps closed together because both live entirely in the
-- balance sheet report (audit item T2-23, scoped to the asset side only,
-- plus the balance-sheet half of T2-21 — the P&L half is a sibling agent's
-- file, profit-loss/page.tsx, untouched here).
--
-- GAP (a). account_groups.nature carries exactly TWO asset values,
-- current_asset and fixed_asset (account_groups_nature_check, unchanged
-- since 0033). schedule_iii mode has always rendered fixed_asset as one
-- undifferentiated "Non-current Assets" block — the report page's own
-- closing paragraph said so out loud. Schedule III Part I actually wants
-- four separate lines under Non-current Assets: (i) Property, Plant and
-- Equipment ["Tangible Assets" is the pre-2021 label still in wide use and
-- the one this app's own liabilities side uses for its plain-English
-- headings, e.g. "Long-term Borrowings" rather than a Schedule III form
-- number, so it is kept here for consistency), (ii) Intangible Assets,
-- (iii) Capital Work-in-Progress, (iv) Non-current Investments.
--
-- NOT a fifth nature value. 0037's own header already discovered the reason
-- a FINER split within one nature has to ride a different column: a child
-- group's nature is FORCED to match its parent's
-- (app_private.enforce_account_group_nature, confirmed live by that
-- migration) — but ledger_role is untouched by that trigger, and
-- account_groups already carries ledger_role as a second, finer dimension
-- get_cma_ratios (0056/0073) already rides to split stock/debtor/cash_bank
-- out of current_asset without touching nature at all. Reusing it here is
-- the same pattern, not a new one, and stays inside the "additive, small
-- blast radius" rule the nature column's own history (0033, 0037) argues
-- for: touching nature means touching every function that enumerates
-- natures (get_balance_sheet, get_cma_ratios' networth calc, the report
-- page's own LIABILITY_ORDER/ASSET_ORDER arrays); touching ledger_role
-- means touching the one function that groups by it, which after this
-- migration is exactly one: get_balance_sheet.
--
-- THE FOUR NEW VALUES, verified against live ledger_role usage before
-- picking names (account_groups_ledger_role_check, confirmed live):
--   ('cash_bank','debtor','creditor','income','expense','capital','loan',
--    'fixed_asset','duty_tax','stock','investment','provision','other')
-- 'investment' is ALREADY a valid value and, checked live, is held by
-- zero groups anywhere in the database today — reserved but never wired
-- up to anything. It is reused as-is for Non-current Investments rather
-- than inventing a new name for the same idea. The other three are new:
-- 'tangible_fixed_asset', 'intangible_fixed_asset',
-- 'capital_work_in_progress' — the two-word snake_case pattern the column
-- already uses (cash_bank, duty_tax). 'fixed_asset' itself is RETIRED from
-- the allowed set, not kept as a lingering synonym for tangible: the whole
-- point of this migration is that "fixed_asset" no longer names one bucket,
-- and leaving the old value legal would let a future insert land in limbo
-- (not one of the four sub-heads, silently falling to this report's
-- catch-all default) instead of failing loudly at the constraint.
--
-- BACKFILL, verified live across every company before writing it: every
-- fixed_asset-nature account_group in the database — 60 rows, 15 companies
-- x 4 groups each (the top-level "Fixed Assets" group plus its Plant &
-- Machinery / Office Equipment / Furniture children) — carries
-- ledger_role='fixed_asset' today, 1:1 with the fixed_asset-nature count,
-- and there exists not one single LEDGER (as opposed to group) posted
-- under any of them in any company yet (also confirmed live: zero rows
-- from `select * from ledgers l join account_groups g on g.id=l.group_id
-- where g.nature='fixed_asset'`) — matching 0077's own finding that no
-- company has actually capitalised an asset through a voucher. So this
-- backfill is exactly as unambiguous as 0081's was: every one of the 60
-- existing groups is genuinely the pre-2021-label "tangible" kind (Plant &
-- Machinery, Office Equipment, Furniture are textbook PP&E, and the
-- top-level "Fixed Assets" group is where 0077's post_depreciation puts
-- the Accumulated Depreciation contra) — 'tangible_fixed_asset' is not a
-- guess, it is what every one of these groups already, actually, is.
--
-- ACCUMULATED DEPRECIATION NETS UNDER TANGIBLE, AUTOMATICALLY, BY
-- CONSTRUCTION. 0077's app_private.ensure_depreciation_ledgers creates that
-- contra ledger inside the top-level "Fixed Assets" group itself — one of
-- the 60 rows this backfill retags 'tangible_fixed_asset' — so once the
-- report buckets by ledger_role instead of by nature, the contra falls
-- into the Tangible bucket with no special-casing required in the report
-- page. It would be wrong to net it against any of the other three heads;
-- Accumulated Depreciation is not accumulated amortisation, and mixing it
-- into Intangible/CWIP/Investments would misstate all four lines. No
-- ledger of that kind exists in the live data to re-verify this against
-- (see above — depreciation has never actually been posted anywhere yet),
-- so this is proven with a rolled-back transaction below rather than
-- against real postings; see this migration's own verification notes in
-- the session report for the exact query and result.
--
-- THREE NEW SUB-GROUPS SEEDED FOR EVERY COMPANY, existing and future — same
-- "unconditional, harmless if unused" reasoning 0033/0037 already used for
-- Non-current Liabilities and the Shareholders' Funds inner lines: a
-- proprietorship will simply never post to "Capital Work-in-Progress", the
-- same as it never posts to "Share Capital", and an unused group costs
-- nothing. Seeded as CHILDREN of the existing "Fixed Assets" top group
-- (nature is forced to 'fixed_asset' by the parent-nature trigger, which is
-- exactly what is wanted — these are still fixed_asset-nature groups, only
-- their ledger_role differs), not as new top-level siblings the way 0037's
-- Share Capital/Reserves and Surplus had to be — those needed a genuinely
-- new NATURE value and could not be children for that reason (0037's own
-- header). This migration invents no new nature, so there is no such
-- obstacle and the natural, lower-footprint move is a child group.
--
-- app_private.seed_chart_of_accounts is extended the same way 0037 already
-- extended 0006's version of it: every existing line unchanged, new lines
-- added, 'fixed_asset' role references updated to 'tangible_fixed_asset' to
-- match the retired value above.
--
-- get_balance_sheet gains ONE new output column, ledger_role — additive to
-- its existing (side, nature, group_name, ledger_name, amount) columns, so
-- every caller that reads named fields is unaffected. Checked live before
-- writing this: no SQL function anywhere calls get_balance_sheet (every
-- grep hit inside the migrations directory is a comment referencing it,
-- not a call), and of the two real callers
-- (app/(app)/[companyId]/reports/balance-sheet/page.tsx and
-- .../closing-stock/page.tsx) both read the result by named field, not
-- positionally, so a new column is safe for both. Postgres will not let
-- CREATE OR REPLACE change a RETURNS TABLE shape in place, so this is a
-- DROP then CREATE, which is why the grants are re-stated at the end.
--
-- GRANT FIX FOUND WHILE TOUCHING THIS FUNCTION, same class of bug the 21
-- Aug public-API session found systemically: get_balance_sheet held EXECUTE
-- for PUBLIC and anon (confirmed live via information_schema.routine_
-- privileges before this migration) even though it is a plain, unguarded
-- SELECT over tenant ledger data — RLS on ledgers/account_groups would still
-- gate what an anonymous caller actually sees, but there is no reason to
-- leave a company's balance sheet shape reachable by an unauthenticated
-- session in the first place, and this migration already has to drop and
-- recreate the function, so the standing convention (revoke from public and
-- anon both, grant only to authenticated) is applied here rather than left
-- for a separate pass.
--
-- GAP (b). Comparative column: "as at the end of the immediately preceding
-- financial year" — simpler and more determinate than the P&L's "same
-- length immediately preceding period" (a balance sheet has no length to
-- match, only a single instant), so this reuses
-- lib/utils/period.ts:financialYearStart directly rather than adding a
-- second FY-boundary helper next to lib/utils/period.ts:
-- previousFinancialYearEnd — that existing helper computes the year before
-- the one containing TODAY, but the comparative here has to be the year
-- before the one containing the report's chosen AS-AT date (which the user
-- can override via ?as_at=), so it is financialYearStart() called on the
-- as-at date, one day subtracted, entirely in the report page — no SQL
-- change needed for this half; get_profit_and_loss and get_balance_sheet
-- already take arbitrary p_from/p_to/p_as_at, proven correct for arbitrary
-- dates by 0073's own verification.
--
-- FIRST-YEAR EDGE CASE: every one of the 15 companies seeded in this
-- database has book_beginning_date = 2026-04-01, which is the FIRST day of
-- the financial year containing today (23 Aug 2026) — so for every one of
-- them the comparative date (31 Mar 2026) predates the books entirely.
-- Confirmed live (see verification notes): this is exactly the condition
-- the report page checks (comparativeAsAt < book_beginning_date) to show a
-- "first year, no comparative" placeholder instead of a real but
-- meaningless all-zero column, and every seeded company in this database
-- hits it today — the honest state for a set of companies whose books all
-- began this financial year.
--
-- OUT OF SCOPE, same as the task named: no intangible-amortisation
-- schedule, no CWIP-to-fixed-asset transfer workflow, no investment
-- fair-value or impairment tracking. This migration classifies and adds a
-- comparative column; it invents no new depreciation or amortisation logic.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- ledger_role: three new values, one retired. The constraint is dropped
-- here and re-added only AFTER the backfill and the new-group inserts below
-- — both write the new values (and the backfill briefly needs the OLD
-- constraint gone too, since it does not yet allow 'tangible_fixed_asset'
-- either), so adding the new constraint first would reject the very rows
-- this migration is about to write. Every row conforms by the time the
-- constraint comes back at the end of this file.
-- ----------------------------------------------------------------------------
alter table public.account_groups
  drop constraint account_groups_ledger_role_check;

comment on column public.account_groups.ledger_role is
  'Finer classification than nature, for filtering/grouping within one nature. Beyond the original set (0006): duty_tax, stock, investment, provision. As of 0089, the fixed_asset NATURE is itself split four ways by this column — tangible_fixed_asset, intangible_fixed_asset, capital_work_in_progress, investment — because a Schedule III sub-classification needs a finer cut than nature can give without inventing a nature value per sub-head (nature is forced to match a group''s parent, ledger_role is not). The bare value ''fixed_asset'' is retired, not reused as a synonym for tangible — see 0089.';

-- ----------------------------------------------------------------------------
-- Backfill every existing fixed_asset-nature group. Verified live before
-- writing this: all 60 such groups across all 15 companies carry
-- ledger_role='fixed_asset' today (1:1 with the fixed_asset-nature count),
-- and none has a single ledger posted under it yet — the backfill target is
-- unambiguous for the same reason 0081's was.
-- ----------------------------------------------------------------------------
update public.account_groups
   set ledger_role = 'tangible_fixed_asset'
 where nature = 'fixed_asset'
   and ledger_role = 'fixed_asset';

-- ----------------------------------------------------------------------------
-- Three new child sub-groups under each company's existing "Fixed Assets"
-- top group. Idempotent by NOT EXISTS on (company, parent, name) — safe to
-- re-run, and matches account_groups_child_name_idx's own uniqueness scope.
-- ----------------------------------------------------------------------------
insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
select g.company_id, g.id, 'Intangible Assets', 'fixed_asset', 'debit', 'intangible_fixed_asset', 4
  from public.account_groups g
 where g.parent_group_id is null and g.name = 'Fixed Assets' and g.nature = 'fixed_asset'
   and not exists (
     select 1 from public.account_groups c
      where c.company_id = g.company_id and c.parent_group_id = g.id and c.name = 'Intangible Assets'
   );

insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
select g.company_id, g.id, 'Capital Work-in-Progress', 'fixed_asset', 'debit', 'capital_work_in_progress', 5
  from public.account_groups g
 where g.parent_group_id is null and g.name = 'Fixed Assets' and g.nature = 'fixed_asset'
   and not exists (
     select 1 from public.account_groups c
      where c.company_id = g.company_id and c.parent_group_id = g.id and c.name = 'Capital Work-in-Progress'
   );

insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
select g.company_id, g.id, 'Non-current Investments', 'fixed_asset', 'debit', 'investment', 6
  from public.account_groups g
 where g.parent_group_id is null and g.name = 'Fixed Assets' and g.nature = 'fixed_asset'
   and not exists (
     select 1 from public.account_groups c
      where c.company_id = g.company_id and c.parent_group_id = g.id and c.name = 'Non-current Investments'
   );

-- ----------------------------------------------------------------------------
-- Now that every row conforms, the constraint comes back with the new value
-- set and 'fixed_asset' retired.
-- ----------------------------------------------------------------------------
alter table public.account_groups
  add constraint account_groups_ledger_role_check
  check (ledger_role in (
    'cash_bank','debtor','creditor','income','expense','capital','loan',
    'duty_tax','stock','investment','provision','other',
    'tangible_fixed_asset','intangible_fixed_asset','capital_work_in_progress'
  ));

-- ----------------------------------------------------------------------------
-- seed_chart_of_accounts (0006, extended 0033/0037): every existing line
-- unchanged except the three fixed-asset children and the top group itself,
-- whose role literal moves from the now-retired 'fixed_asset' to
-- 'tangible_fixed_asset'; three new child inserts added.
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
  values (p_company_id, 'Fixed Assets', 'fixed_asset', 'debit', 'tangible_fixed_asset', true, 4)
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
  -- Capital Account / Non-current Liabilities — see 0037's header for why a
  -- child group cannot carry its own nature in this schema.
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
    (p_company_id, v_fixed_assets,        'Plant & Machinery',       'fixed_asset', 'debit', 'tangible_fixed_asset',    1),
    (p_company_id, v_fixed_assets,        'Office Equipment',        'fixed_asset', 'debit', 'tangible_fixed_asset',    2),
    (p_company_id, v_fixed_assets,        'Furniture',               'fixed_asset', 'debit', 'tangible_fixed_asset',    3),
    (p_company_id, v_fixed_assets,        'Intangible Assets',       'fixed_asset', 'debit', 'intangible_fixed_asset', 4),
    (p_company_id, v_fixed_assets,        'Capital Work-in-Progress','fixed_asset', 'debit', 'capital_work_in_progress', 5),
    (p_company_id, v_fixed_assets,        'Non-current Investments', 'fixed_asset', 'debit', 'investment',             6);

  -- TDS Payable, same as Duties & Taxes above: unconditional and harmless
  -- for a company that never deducts TDS from anyone, seeded here so it is
  -- available the moment a TDS-deductee vendor first shows up, with no
  -- separate "configure TDS first" step.
  perform app_private.seed_tds_ledgers(p_company_id);
end;
$$;

comment on function app_private.seed_chart_of_accounts is
  'Fourteen system groups plus the conventional sub-groups. Schedule III''s inner Shareholders'' Funds and Non-current Liabilities line items (0037) are top-level system groups, not children (a child group''s nature is forced to match its parent''s). The Fixed Assets sub-groups (0089: Intangible Assets, Capital Work-in-Progress, Non-current Investments alongside the original Plant & Machinery/Office Equipment/Furniture, all ledger_role-classified) ARE children — no new nature was needed for that split, only a finer ledger_role. Also seeds the company-wide TDS Payable ledger (app_private.seed_tds_ledgers).';

-- ----------------------------------------------------------------------------
-- get_balance_sheet: adds ledger_role to its output. Dropped and recreated
-- because Postgres will not let CREATE OR REPLACE change a RETURNS TABLE
-- shape; grants re-stated below, tightened to match this codebase's
-- standing convention (see this migration's header for the PUBLIC/anon leak
-- found live while doing so).
-- ----------------------------------------------------------------------------
drop function public.get_balance_sheet(uuid, date, uuid);

create function public.get_balance_sheet(
  p_company_id uuid,
  p_as_at date,
  p_branch_id uuid default null
)
returns table (side text, nature text, group_name text, ledger_name text, ledger_role text, amount numeric)
language sql
stable
set search_path to ''
as $function$
  with bal as (
    select g.nature, g.name as group_name, l.name as ledger_name, g.ledger_role,
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
         nature, group_name, ledger_name, ledger_role,
         case when nature in ('current_asset','fixed_asset') then signed else -signed end
    from bal
   where signed <> 0
   order by 1, 2, 3, 4;
$function$;

revoke all on function public.get_balance_sheet(uuid, date, uuid) from public, anon;
grant execute on function public.get_balance_sheet(uuid, date, uuid) to authenticated;

comment on function public.get_balance_sheet(uuid, date, uuid) is
  'Balance sheet as at a date, one row per ledger with a non-zero balance. ledger_role (0089) lets a caller sub-classify the fixed_asset nature into Tangible/Intangible/CWIP/Investments (report page: balance-sheet, schedule_iii mode only) without a new nature value. Assets side signed debit-positive, liabilities side signed credit-positive; Accumulated Depreciation (0077, ledger_role tangible_fixed_asset) nets automatically into the Tangible figure since it is a normal row in this same output. See 0089.';
