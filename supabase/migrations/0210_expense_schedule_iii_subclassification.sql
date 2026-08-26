-- ============================================================================
-- 0210 — Statement of Profit and Loss: expenses get Schedule III's own
--        seven heads, the same way 0089 split the asset side
-- ============================================================================
-- CONFIRMED LIVE, NOT ASSUMED, THAT THIS WAS STILL A GAP before writing a
-- line of this file. account_groups_ledger_role_check (information_schema,
-- live) had no expense-head value at all — every direct_expense/
-- indirect_expense group in the database (30 rows, 15 companies x 2) still
-- carried the placeholder ledger_role='expense' from 0006/0033, untouched by
-- 0089 (which was explicitly scoped to the asset side only — see its own
-- header). get_profit_and_loss's live definition (pg_get_functiondef,
-- checked before writing this) returns (section, nature, group_name,
-- ledger_name, amount) — no ledger_role column at all. And the report page
-- itself, app/(app)/[companyId]/reports/profit-loss/page.tsx, says so in so
-- many words in its own schedule_iii closing paragraph: "Expenses are not
-- sub-classified into Cost of materials consumed, Purchases of stock-in-
-- trade, Changes in inventories, Employee benefits expense, Finance costs,
-- Depreciation and amortisation expense, or Other expenses — this schema
-- only classifies Direct vs Indirect." Genuinely open, not duplicated work.
--
-- THE SEVEN HEADS, confirmed by live WebSearch against Schedule III's own
-- Division I text (ca2013.com's hosted bare-act PDF, cross-checked against
-- corporatelawreporter.com's clause-by-clause reproduction) and a second,
-- deliberately skeptical search for Division II (Ind AS) specifically to
-- catch any wording drift: both Divisions carry the SAME seven-line
-- "Expenses" break-up, in the SAME order —
--   (a) Cost of materials consumed
--   (b) Purchases of Stock-in-Trade
--   (c) Changes in inventories of finished goods, work-in-progress and
--       stock-in-trade
--   (d) Employee benefits expense
--   (e) Finance costs
--   (f) Depreciation and amortisation expense (Division II's Guidance Note
--       widens this to "…and impairment expense" for Ind AS filers — a
--       wording variant, not a different bucket; this schema does not
--       distinguish Division I from II today, so one column serves both)
--   (g) Other expenses
-- The pre-GST eighth line, "Excise duty on sale of goods," was removed by
-- the MCA's own Schedule III amendment years before this session and does
-- not need modelling.
-- Sources: https://ca2013.com/wp-content/uploads/2015/07/Schedule3.pdf ,
-- https://corporatelawreporter.com/companies_act/schedule-3-of-companies-act-2013-general-instructions-for-preparation-of-balance-sheet-and-statement-of-profit-and-loss-of-a-company/
--
-- THE GENUINE STRUCTURAL DIFFERENCE FROM 0089, FOUND LIVE, NOT GUESSED.
-- 0089's asset-side backfill was clean because every fixed_asset ledger sat
-- under a group that was ALREADY, unambiguously, one Schedule III sub-head
-- (Plant & Machinery is tangible, full stop). The expense side is not that
-- tidy: querying live before writing this migration, exactly two top-level
-- groups exist system-wide today — "Direct Expenses" and "Indirect
-- Expenses" (0006/0033) — with ZERO child groups under either, anywhere,
-- across all 15 companies. But the LEDGERS already parked directly under
-- "Indirect Expenses" span three genuinely different Schedule III
-- categories in the SAME group: "Professional Fees" (Other expenses),
-- "Depreciation" (Depreciation and amortisation — real postings: Sharma
-- Textiles carries 60,442.27, Verma & Associates 36,442.27, both confirmed
-- live), and "Deferred Tax Expense" (not one of the seven heads at all —
-- Schedule III shows tax as its own section, "Tax expense: Current tax /
-- Deferred tax," below Profit before tax, not inside Total Expenses; real
-- postings here too, -820.51 at both companies, confirmed live). A single
-- ledger_role value on the "Indirect Expenses" GROUP cannot correctly carry
-- all three at once — group-level classification alone, applied blindly,
-- would misstate real, already-posted figures at two live companies.
--
-- THE ROUTE TAKEN: keep 0089's group-level default (every account_group
-- still gets exactly one ledger_role, "no group left unclassified" holds
-- exactly as before), and add ONE narrow, additive escape hatch — a
-- nullable ledger_role column on public.ledgers itself, which OVERRIDES its
-- group's role only when set. It is used for exactly three ledgers, and
-- named BY EXACT NAME rather than moved to a new group, because their names
-- are not incidental — three separate already-shipped functions
-- (app_private.ensure_stock_ledgers/0076, ensure_depreciation_ledgers/0077,
-- ensure_deferred_tax_ledgers/0091) hardcode "select … where group_id =
-- (Indirect/Direct Expenses) and name = '<exact name>'" to find-or-create
-- these ledgers. Moving any of the three into a new child group would make
-- that lookup miss on its next run and silently INSERT A DUPLICATE ledger
-- (a second "Depreciation", a second "Deferred Tax Expense") the next time
-- post_depreciation/post_deferred_tax/post_closing_stock runs — a real,
-- live-data-corrupting regression, not a hypothetical one. So the ledger
-- stays exactly where those functions expect it; only a same-migration
-- ledger_role value is added, read by coalesce(ledger, group) in the report
-- below. The three creation functions are also updated (CREATE OR REPLACE,
-- identical signatures and behaviour, one new column value per relevant
-- insert) so any COMPANY THAT HAS NOT YET RUN post_closing_stock/
-- post_depreciation/post_deferred_tax gets the override the moment that
-- ledger is first created, with no second backfill ever required.
--
-- 'tax_expense' IS AN EIGHTH ledger_role VALUE, DELIBERATELY NOT ONE OF THE
-- SEVEN. It exists so "Deferred Tax Expense" is never silently folded into
-- "Other expenses" (which would misstate that line at Sharma Textiles and
-- Verma & Associates today) while still being honest that it is not itself
-- a Schedule III "Expenses" head — the report below surfaces it as its own,
-- separately captioned line, not inside the seven-head total's own running
-- narrative. NOTE FOR ANY FUTURE READER: this schema still nets Deferred
-- Tax Expense into the indirect_expense NATURE (a pre-existing decision
-- from 0091, out of this migration's scope to change — re-naturing it would
-- ripple into get_balance_sheet's networth calc and the cash-flow
-- statement, the same "touching nature is the expensive move" reasoning
-- 0089's own header already laid out for the asset side), so Schedule III
-- purists will note Total Expenses here still includes tax in the arithmetic
-- even though the LABEL correctly separates it out — a real, named,
-- documented limitation, not a silent one.
--
-- WHY "Direct Expenses" DEFAULTS TO cost_of_materials, NOT
-- purchases_stock_in_trade. Genuinely ambiguous on the merits — "Purchase
-- Account", the one real ledger sitting there for every company, is
-- literally consistent with EITHER head depending on whether the company
-- manufactures (raw material consumed) or trades (goods resold as bought).
-- No per-company signal exists in this schema to decide automatically (item
-- master does not distinguish raw material from trading goods at the
-- account_groups grain this migration operates at). cost_of_materials is
-- picked as the default because most of this session's live companies with
-- real Purchase Account postings are manufacturers (Sharma Textiles —
-- textiles, Bharat Industries Limited), and because a dedicated "Purchases
-- of Stock-in-Trade" CHILD group is seeded below (same "unconditional,
-- harmless if unused" reasoning 0089 used for Non-current Investments) so a
-- genuinely trading company can move its purchase ledgers there — this
-- migration does not move any existing ledger itself (see above; the
-- top-level groups' own contents are left exactly where the hardcoded
-- lookups expect them). Symmetrically, "Indirect Expenses" defaults to
-- other_expenses, Schedule III's own catch-all, for the same reason 0089's
-- "Fixed Assets" kept tangible_fixed_asset as its own default while new
-- children absorbed the other sub-heads — no group needed for
-- other_expenses beyond the parent itself, since that is what "generic,
-- unclassified indirect expense" already means.
--
-- FOUR NEW CHILD GROUPS SEEDED, existing companies and
-- app_private.seed_chart_of_accounts alike — only for heads NOT already
-- served by a parent's own default: "Purchases of Stock-in-Trade" (under
-- Direct Expenses), "Employee Benefits Expense", "Finance Costs",
-- "Depreciation and Amortisation Expense" (all three under Indirect
-- Expenses). No new "Cost of Materials Consumed" or "Other Expenses" child
-- — the parent groups already, functionally, are those two heads, the same
-- asymmetry 0089 used (Fixed Assets itself stayed tangible; only the OTHER
-- three sub-heads got new children). No group for changes_in_inventories or
-- tax_expense either — both are single, specific, already-named system
-- ledgers (see above), not general-purpose buckets a user would want to
-- create more ledgers under.
--
-- get_profit_and_loss gains ONE new output column, ledger_role — additive,
-- same DROP/CREATE-then-regrant mechanics 0089 used for get_balance_sheet
-- (Postgres will not let CREATE OR REPLACE change a RETURNS TABLE shape).
-- Checked live before writing this: the only real callers are
-- app/(app)/[companyId]/reports/profit-loss/page.tsx and .../balance-
-- sheet/page.tsx, both reading the result by named field (r.amount,
-- r.nature — grepped, not assumed), so a new column is safe for both.
--
-- GRANT FIX FOUND WHILE TOUCHING THIS FUNCTION, same class 0089 found on
-- get_balance_sheet: get_profit_and_loss held EXECUTE for PUBLIC and anon
-- (information_schema.routine_privileges, confirmed live) despite being a
-- plain SELECT over tenant P&L data. Tightened here to the standing
-- convention (authenticated only) since this migration already has to drop
-- and recreate the function.
--
-- OUT OF SCOPE, same discipline 0089 named explicitly: no re-naturing of
-- Deferred Tax Expense out of indirect_expense; no UI to reassign an
-- existing ledger's group or ledger_role override (none exists for the
-- asset-side ledger_role either — this is not a regression, just not yet
-- built for either side); no attempt to auto-detect trading vs
-- manufacturing to pick a smarter default for "Purchase Account". Schedule
-- III's own general instructions require every P&L line to cross-reference
-- a supporting note (e.g. an employee-benefits break-up of salaries/PF/
-- ESOP/staff welfare) — this schema and report show the HEAD TOTAL only,
-- not the note-level sub-break-up; said so in the report copy below rather
-- than fabricated.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- account_groups.ledger_role: eight new expense-head values added, the
-- placeholder 'expense' retired (same "drop the constraint before the
-- backfill needs the new values, re-add once every row conforms" sequencing
-- 0089 used — and the same finding: every row that carries 'expense' today,
-- confirmed live via `select nature, ledger_role, count(*) from
-- account_groups group by 1,2`, is about to be rewritten by the backfill
-- below, so 'expense' becomes truly orphaned and is safe to retire rather
-- than leave as a lingering synonym nothing points to any more).
-- ----------------------------------------------------------------------------
alter table public.account_groups
  drop constraint account_groups_ledger_role_check;

comment on column public.account_groups.ledger_role is
  'Finer classification than nature, for filtering/grouping within one nature. Beyond the original set (0006) and 0089''s four fixed_asset sub-heads: as of 0210, the direct_expense/indirect_expense natures are further split into Schedule III''s seven Statement of P&L expense heads — cost_of_materials, purchases_stock_in_trade, changes_in_inventories, employee_benefits, finance_costs, depreciation_amortisation, other_expenses — plus tax_expense, which is NOT one of the seven (Schedule III shows tax as its own section below Profit before tax) but needs a value here so Deferred Tax Expense is never silently folded into other_expenses. The placeholder ''expense'' is retired, not kept as a synonym — see 0210. A ledger can override its group''s ledger_role via ledgers.ledger_role (also added in 0210); get_profit_and_loss reports coalesce(ledger, group).';

update public.account_groups
   set ledger_role = 'cost_of_materials'
 where nature = 'direct_expense' and ledger_role = 'expense';

update public.account_groups
   set ledger_role = 'other_expenses'
 where nature = 'indirect_expense' and ledger_role = 'expense';

alter table public.account_groups
  add constraint account_groups_ledger_role_check
  check (ledger_role in (
    'cash_bank','debtor','creditor','income','capital','loan',
    'duty_tax','stock','investment','provision','other',
    'tangible_fixed_asset','intangible_fixed_asset','capital_work_in_progress',
    'cost_of_materials','purchases_stock_in_trade','changes_in_inventories',
    'employee_benefits','finance_costs','depreciation_amortisation',
    'other_expenses','tax_expense'
  ));

-- ----------------------------------------------------------------------------
-- Four new child sub-groups, existing companies. Idempotent by NOT EXISTS on
-- (company, parent, name), matching 0089's own pattern and
-- account_groups_child_name_idx's uniqueness scope.
-- ----------------------------------------------------------------------------
insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
select g.company_id, g.id, 'Purchases of Stock-in-Trade', 'direct_expense', 'debit', 'purchases_stock_in_trade', 1
  from public.account_groups g
 where g.parent_group_id is null and g.name = 'Direct Expenses' and g.nature = 'direct_expense'
   and not exists (
     select 1 from public.account_groups c
      where c.company_id = g.company_id and c.parent_group_id = g.id and c.name = 'Purchases of Stock-in-Trade'
   );

insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
select g.company_id, g.id, 'Employee Benefits Expense', 'indirect_expense', 'debit', 'employee_benefits', 1
  from public.account_groups g
 where g.parent_group_id is null and g.name = 'Indirect Expenses' and g.nature = 'indirect_expense'
   and not exists (
     select 1 from public.account_groups c
      where c.company_id = g.company_id and c.parent_group_id = g.id and c.name = 'Employee Benefits Expense'
   );

insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
select g.company_id, g.id, 'Finance Costs', 'indirect_expense', 'debit', 'finance_costs', 2
  from public.account_groups g
 where g.parent_group_id is null and g.name = 'Indirect Expenses' and g.nature = 'indirect_expense'
   and not exists (
     select 1 from public.account_groups c
      where c.company_id = g.company_id and c.parent_group_id = g.id and c.name = 'Finance Costs'
   );

insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
select g.company_id, g.id, 'Depreciation and Amortisation Expense', 'indirect_expense', 'debit', 'depreciation_amortisation', 3
  from public.account_groups g
 where g.parent_group_id is null and g.name = 'Indirect Expenses' and g.nature = 'indirect_expense'
   and not exists (
     select 1 from public.account_groups c
      where c.company_id = g.company_id and c.parent_group_id = g.id and c.name = 'Depreciation and Amortisation Expense'
   );

-- ----------------------------------------------------------------------------
-- ledgers.ledger_role: nullable per-ledger override of its group's role.
-- NULL (the default, and every pre-existing row) means "inherit the group's
-- ledger_role" — get_profit_and_loss reads coalesce(ledger, group). Same
-- allowed-value domain as account_groups.ledger_role for consistency, though
-- only the expense-head values are actually used by this migration.
-- ----------------------------------------------------------------------------
alter table public.ledgers add column ledger_role text;

alter table public.ledgers
  add constraint ledgers_ledger_role_check
  check (ledger_role is null or ledger_role in (
    'cash_bank','debtor','creditor','income','capital','loan',
    'duty_tax','stock','investment','provision','other',
    'tangible_fixed_asset','intangible_fixed_asset','capital_work_in_progress',
    'cost_of_materials','purchases_stock_in_trade','changes_in_inventories',
    'employee_benefits','finance_costs','depreciation_amortisation',
    'other_expenses','tax_expense'
  ));

comment on column public.ledgers.ledger_role is
  'Overrides this ledger''s group''s ledger_role when set (NULL = inherit the group). Added 0210 for exactly three system-managed, name-stable ledgers (Depreciation, Deferred Tax Expense, Changes in Inventories) which must stay physically parked under the flat Direct/Indirect Expenses group their creating function (0076/0077/0091) hardcodes a name lookup against, but which individually belong to a different Schedule III expense head than their sibling ledgers in that same group — see 0210''s header for why moving them to a dedicated group instead would duplicate-insert on the next post_closing_stock/post_depreciation/post_deferred_tax run.';

-- No new grant statements needed: public.ledgers already carries whole-table
-- (not per-column) SELECT/INSERT/UPDATE grants for authenticated (confirmed
-- live via information_schema.column_privileges before writing this — 41/41
-- existing columns, not an allowlist like public.companies), so ALTER TABLE
-- ADD COLUMN extends automatically. This is the companies-specific bug class
-- named in this task's brief; ledgers does not use that grant pattern.

-- ----------------------------------------------------------------------------
-- Backfill the three known system ledgers by exact name, wherever they
-- already exist. changes_in_inventories affects zero rows today (confirmed
-- live: no company has ever run post_closing_stock, so "Changes in
-- Inventories" does not exist anywhere yet) — harmless, and the function
-- patch below means it is set at creation time for every future company
-- regardless.
-- ----------------------------------------------------------------------------
update public.ledgers l
   set ledger_role = 'depreciation_amortisation'
  from public.account_groups g
 where g.id = l.group_id
   and g.nature = 'indirect_expense'
   and l.name = 'Depreciation'
   and l.ledger_role is null;

update public.ledgers l
   set ledger_role = 'tax_expense'
  from public.account_groups g
 where g.id = l.group_id
   and g.nature = 'indirect_expense'
   and l.name = 'Deferred Tax Expense'
   and l.ledger_role is null;

update public.ledgers l
   set ledger_role = 'changes_in_inventories'
  from public.account_groups g
 where g.id = l.group_id
   and g.nature = 'direct_expense'
   and l.name = 'Changes in Inventories'
   and l.ledger_role is null;

-- ----------------------------------------------------------------------------
-- The three ledger-creation functions: identical bodies, one new column +
-- value on the expense-side insert only. Everything else — the
-- asset-side/liability-side inserts, the exception messages, the
-- find-or-create guards — is byte-for-byte the live definition (fetched via
-- pg_get_functiondef before writing this file) so no other behaviour moves.
-- ----------------------------------------------------------------------------
create or replace function app_private.ensure_stock_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_stock_group uuid;
  v_expense_group uuid;
begin
  select id into v_stock_group
    from public.account_groups
   where company_id = p_company_id and name = 'Stock-in-Hand'
   limit 1;

  select id into v_expense_group
    from public.account_groups
   where company_id = p_company_id and name = 'Direct Expenses'
   limit 1;

  if v_stock_group is null or v_expense_group is null then
    raise exception 'Chart of accounts is missing the Stock-in-Hand or Direct Expenses group; seed it first';
  end if;

  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_stock_group and name = 'Stock-in-Hand'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_stock_group, 'Stock-in-Hand', 'debit', 0);
  end if;

  -- Schedule III's own name for this line. Lives under Direct Expenses and
  -- normally carries a CREDIT balance -- see 0076's header for why it is not
  -- a direct_income ledger. ledger_role='changes_in_inventories' (0210)
  -- overrides Direct Expenses' own group default (cost_of_materials) since
  -- this one specific ledger is not a materials-purchase ledger at all.
  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_expense_group and name = 'Changes in Inventories'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount, ledger_role)
    values (p_company_id, v_expense_group, 'Changes in Inventories', 'debit', 0, 'changes_in_inventories');
  end if;
end;
$fn$;

create or replace function app_private.ensure_depreciation_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_expense_group uuid;
  v_asset_group uuid;
begin
  select id into v_expense_group
    from public.account_groups
   where company_id = p_company_id and parent_group_id is null and name = 'Indirect Expenses'
   limit 1;

  select id into v_asset_group
    from public.account_groups
   where company_id = p_company_id and name = 'Fixed Assets'
   limit 1;

  if v_expense_group is null or v_asset_group is null then
    raise exception 'Chart of accounts is missing the Indirect Expenses or Fixed Assets group; seed it first';
  end if;

  -- ledger_role='depreciation_amortisation' (0210) overrides Indirect
  -- Expenses' own group default (other_expenses) -- Depreciation is a named
  -- Schedule III head in its own right, not a generic other expense.
  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_expense_group and name = 'Depreciation'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount, ledger_role)
    values (p_company_id, v_expense_group, 'Depreciation', 'debit', 0, 'depreciation_amortisation');
  end if;

  -- A contra-asset: lives with the assets it reduces and carries a credit.
  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_asset_group and name = 'Accumulated Depreciation'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_asset_group, 'Accumulated Depreciation', 'credit', 0);
  end if;
end;
$fn$;

create or replace function app_private.ensure_deferred_tax_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_expense_group uuid;
  v_dtl_group uuid;
begin
  select id into v_expense_group
    from public.account_groups
   where company_id = p_company_id and parent_group_id is null and name = 'Indirect Expenses'
   limit 1;

  -- By NATURE, never by name — see 0091's header for the duplicate
  -- same-named group this dodges.
  select id into v_dtl_group
    from public.account_groups
   where company_id = p_company_id and nature = 'deferred_tax'
   limit 1;

  if v_expense_group is null or v_dtl_group is null then
    raise exception 'Chart of accounts is missing the Indirect Expenses or Deferred Tax Liabilities (Net) group; seed it first';
  end if;

  -- ledger_role='tax_expense' (0210) overrides Indirect Expenses' own group
  -- default (other_expenses). Deliberately NOT one of the seven Schedule III
  -- expense heads -- Schedule III shows tax expense as its own section below
  -- Profit before tax -- but still needs a distinct value so it is never
  -- silently folded into other_expenses. See 0210's header.
  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_expense_group and name = 'Deferred Tax Expense'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount, ledger_role)
    values (p_company_id, v_expense_group, 'Deferred Tax Expense', 'debit', 0, 'tax_expense');
  end if;

  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_dtl_group and name = 'Deferred Tax Liabilities (Net)'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_dtl_group, 'Deferred Tax Liabilities (Net)', 'credit', 0);
  end if;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- app_private.seed_chart_of_accounts: every existing line unchanged except
-- Direct Expenses/Indirect Expenses' own ledger_role literals (now their
-- Schedule III defaults instead of the retired 'expense') and their ids now
-- captured for the four new child inserts appended to the existing
-- "Conventional sub-groups" block.
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
  v_direct_expenses uuid;
  v_indirect_expenses uuid;
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
  values (p_company_id, 'Direct Expenses', 'direct_expense', 'debit', 'cost_of_materials', true, 5)
  returning id into v_direct_expenses;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Direct Incomes', 'direct_income', 'credit', 'income', true, 6);

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Indirect Expenses', 'indirect_expense', 'debit', 'other_expenses', true, 7)
  returning id into v_indirect_expenses;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Indirect Incomes', 'indirect_income', 'credit', 'income', true, 8);

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

  -- Conventional sub-groups. Deletable and renameable, unlike the fourteen
  -- above. The four Schedule III expense-head children (0210) go here
  -- alongside the pre-existing asset-side ones (0089).
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
    (p_company_id, v_fixed_assets,        'Non-current Investments', 'fixed_asset', 'debit', 'investment',             6),
    (p_company_id, v_direct_expenses,     'Purchases of Stock-in-Trade',           'direct_expense',   'debit', 'purchases_stock_in_trade', 1),
    (p_company_id, v_indirect_expenses,   'Employee Benefits Expense',             'indirect_expense', 'debit', 'employee_benefits',        1),
    (p_company_id, v_indirect_expenses,   'Finance Costs',                         'indirect_expense', 'debit', 'finance_costs',            2),
    (p_company_id, v_indirect_expenses,   'Depreciation and Amortisation Expense', 'indirect_expense', 'debit', 'depreciation_amortisation',3);

  -- TDS Payable, same as Duties & Taxes above: unconditional and harmless
  -- for a company that never deducts TDS from anyone, seeded here so it is
  -- available the moment a TDS-deductee vendor first shows up, with no
  -- separate "configure TDS first" step.
  perform app_private.seed_tds_ledgers(p_company_id);
end;
$$;

comment on function app_private.seed_chart_of_accounts is
  'Fourteen system groups plus the conventional sub-groups. Schedule III''s inner Shareholders'' Funds and Non-current Liabilities line items (0037) are top-level system groups, not children. The Fixed Assets sub-groups (0089: Intangible Assets, Capital Work-in-Progress, Non-current Investments) and the Direct/Indirect Expenses sub-groups (0210: Purchases of Stock-in-Trade, Employee Benefits Expense, Finance Costs, Depreciation and Amortisation Expense) ARE children, all ledger_role-classified — no new nature was needed for either split, only a finer ledger_role. Also seeds the company-wide TDS Payable ledger (app_private.seed_tds_ledgers).';

-- ----------------------------------------------------------------------------
-- get_profit_and_loss: adds ledger_role to its output, read as
-- coalesce(ledger.ledger_role, group.ledger_role) so the three per-ledger
-- overrides above win over their group's own default. Dropped and recreated
-- because Postgres will not let CREATE OR REPLACE change a RETURNS TABLE
-- shape; grants re-stated below, tightened to this codebase's standing
-- convention (see this migration's header for the PUBLIC/anon leak found
-- live while doing so — the same class 0089 found on get_balance_sheet).
-- ----------------------------------------------------------------------------
drop function public.get_profit_and_loss(uuid, date, date, uuid);

create function public.get_profit_and_loss(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_branch_id uuid default null
)
returns table (section text, nature text, group_name text, ledger_name text, ledger_role text, amount numeric)
language sql
stable
set search_path to ''
as $function$
  select
    case when g.nature in ('direct_income','direct_expense') then 'trading' else 'profit_loss' end,
    g.nature, g.name, l.name,
    coalesce(l.ledger_role, g.ledger_role),
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
   group by g.nature, g.name, l.name, coalesce(l.ledger_role, g.ledger_role)
  having coalesce(sum(e.debit_amount - e.credit_amount), 0) <> 0
   order by 1, 2, 3, 4;
$function$;

revoke all on function public.get_profit_and_loss(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_profit_and_loss(uuid, date, date, uuid) to authenticated;

comment on function public.get_profit_and_loss(uuid, date, date, uuid) is
  'Profit & loss for a date range, one row per ledger with a non-zero net movement. ledger_role (0210) is coalesce(ledger override, group default) and, for expense-nature rows, is one of Schedule III''s seven Statement of P&L expense heads (cost_of_materials, purchases_stock_in_trade, changes_in_inventories, employee_benefits, finance_costs, depreciation_amortisation, other_expenses) or tax_expense (not one of the seven — see 0210). Income-nature rows carry ledger_role=''income'' unchanged, not sub-classified by this migration. section is ''trading'' for direct_income/direct_expense, ''profit_loss'' otherwise, matching this function''s pre-0210 shape. See 0210.';
