-- The chart of accounts becomes extensible — safely.
--
-- WHY. A pilot opened a brand-new company, traded it for a month with four
-- preparers, and could not add a single account group. There is no screen
-- anywhere in the app that creates one: `seed_chart_of_accounts` lays down the
-- eight primary groups and about twenty-five sub-groups when the company is
-- created, and that is the chart, permanently. Every expense a spice trader
-- actually incurs — freight outward, godown rent, packing material — has to be
-- squeezed into "Indirect Expenses" as a bare ledger, and the Schedule III
-- statement of profit and loss then has one line called "Indirect Expenses"
-- with everything in it. Verified live before writing this: thirty-five
-- distinct group names exist across all sixteen companies, and thirty-three of
-- them are names seed_chart_of_accounts or a later migration backfill writes.
-- The two that are not — "Export Debtors" and "Export Debtors - USA", at two
-- companies, created within the same second by an August session — were
-- written by SQL, because there has never been a screen that could write them.
--
-- WHY A SCREEN ALONE IS NOT THE FIX. account_groups carries three columns that
-- decide where money appears in the financial statements:
--
--   nature          which statement and which side (get_balance_sheet and
--                   get_profit_and_loss both filter on it, and ONLY on it)
--   normal_balance  the Dr/Cr the group is presented under
--   ledger_role     the Schedule III sub-head, and — since 1200 — the binding
--                   key the close postings use to FIND a ledger
--
-- A group created with the wrong nature does not produce an error. It produces
-- a balance sheet that still balances, and a profit figure that is wrong. That
-- is the same failure mode 1200 documented at length: every safety net in this
-- system is a self-consistency check, and misclassification is exactly the
-- class of error self-consistency preserves. So the constraint belongs in the
-- database, not only in a dropdown.
--
-- WHAT WAS ALREADY SAFE, checked rather than assumed:
--
--   * `nature` is already forced. app_private.enforce_account_group_nature
--     (0006) overwrites new.nature with the PARENT's nature on every insert
--     and on every re-parent. A child cannot be classified differently from
--     its parent, whatever the caller sends.
--   * `statement` cannot be set at all — it is GENERATED ALWAYS AS a CASE over
--     nature (confirmed live in information_schema, is_generated = ALWAYS).
--   * `is_system` rows are already protected from reclassification and
--     deletion by app_private.protect_system_group (0006).
--
-- WHAT WAS NOT SAFE, and is what this migration closes:
--
--   1. normal_balance is a free column. Nothing tied it to nature. A group
--      with nature 'indirect_expense' and normal_balance 'credit' was, and
--      until now would remain, insertable.
--   2. ledger_role is checked against a 22-value vocabulary but not against
--      the nature it sits under. 'debtor' on an expense group was insertable.
--
-- THE MAP IS THE LIVE DATA, NOT AN OPINION. Every (nature, normal_balance)
-- pair below was read out of the live table before being written here:
--
--   select nature, normal_balance, count(*) from account_groups group by 1,2
--
-- returned exactly fourteen rows — one per nature, one normal_balance each,
-- across all sixteen companies and 602 group rows. normal_balance is already a
-- function of nature in practice; this makes it one in fact. Because the map
-- agrees with every existing row, the assignment below is a no-op on all
-- current data and cannot rewrite anything.
--
-- ROLE COMPATIBILITY is likewise taken from what is actually seeded, so
-- re-seeding a new company keeps working unchanged (that was checked too: the
-- distinct (nature, ledger_role) pairs live are all admitted below). The guard
-- is deliberately BROAD — it rejects nonsense like a receivable role on an
-- expense group, not tasteful choices. The narrower list a person is offered
-- lives in the new Chart of accounts screen, which additionally withholds the
-- four SINGLETON roles:
--
--   stock, changes_in_inventories, depreciation_amortisation,
--   accumulated_depreciation
--
-- app_private.ledger_for_role (1200, message improved in 1220) RAISES when a
-- company has more than one ledger carrying one of these, because post_closing_
-- stock and post_depreciation must bind to exactly one. Handing a preparer a
-- dropdown that lets them create a second Stock-in-Hand group is handing them
-- a year-end close that refuses to run. Those roles stay reachable through the
-- seed and through a ledger-level override; they are not offered as a choice.
--
-- DELIBERATELY NOT DONE HERE. No new RPC: account_groups already carries
-- table-level INSERT for `authenticated` behind an RLS policy that requires
-- app_private.can_write_company, and a trigger guards every path into the
-- table rather than only the one a new function would own. No rename or delete
-- of existing groups either — get_sec269ss_loan_receipts,
-- get_sec269t_loan_repayments and get_sec40a3_cash_payments all still match
-- the seeded group by the literal string 'Cash-in-Hand' (verified live), so
-- renaming a seeded group is a live hazard of exactly 1200's kind. That is
-- reported, not fixed here.

-- ---------------------------------------------------------------------------
-- 1. Nature -> normal_balance, and nature -> the roles that make sense under it
-- ---------------------------------------------------------------------------

create or replace function app_private.account_group_normal_balance(p_nature text)
returns text
language sql
immutable
set search_path to ''
as $fn$
  select case p_nature
    when 'capital'               then 'credit'
    when 'share_capital'         then 'credit'
    when 'reserves_surplus'      then 'credit'
    when 'current_liability'     then 'credit'
    when 'non_current_liability' then 'credit'
    when 'long_term_borrowing'   then 'credit'
    when 'long_term_provision'   then 'credit'
    when 'deferred_tax'          then 'credit'
    when 'direct_income'         then 'credit'
    when 'indirect_income'       then 'credit'
    when 'current_asset'         then 'debit'
    when 'fixed_asset'           then 'debit'
    when 'direct_expense'        then 'debit'
    when 'indirect_expense'      then 'debit'
  end;
$fn$;

revoke all on function app_private.account_group_normal_balance(text) from public, anon;
grant execute on function app_private.account_group_normal_balance(text) to authenticated;

comment on function app_private.account_group_normal_balance(text) is
  'The Dr/Cr side an account group of this nature is presented under. Derived from the live table, where normal_balance was already a strict function of nature. Enforced by enforce_account_group_presentation (1470).';

create or replace function app_private.account_group_roles_for_nature(p_nature text)
returns text[]
language sql
immutable
set search_path to ''
as $fn$
  select case p_nature
    -- Owners' funds. 'capital' is the only role the seed uses for all three.
    when 'capital'               then array['capital','other']
    when 'share_capital'         then array['capital','other']
    when 'reserves_surplus'      then array['capital','other']
    -- Current assets. 'stock' is admitted here because Stock-in-Hand is
    -- seeded with it; the screen still does not offer it (see header).
    when 'current_asset'         then array['other','cash_bank','debtor','loan','investment','stock']
    when 'current_liability'     then array['other','creditor','duty_tax','provision','loan']
    when 'non_current_liability' then array['other','loan','provision','creditor']
    when 'long_term_borrowing'   then array['other','loan']
    when 'long_term_provision'   then array['other','provision']
    when 'deferred_tax'          then array['other']
    when 'fixed_asset'           then array['tangible_fixed_asset','intangible_fixed_asset',
                                            'capital_work_in_progress','investment','other']
    -- Schedule III's expense heads, split direct/indirect the way the seed
    -- splits them. tax_expense is admitted because ensure_deferred_tax_ledgers
    -- uses it, but only on the indirect side where the seed puts it.
    when 'direct_expense'        then array['cost_of_materials','purchases_stock_in_trade',
                                            'changes_in_inventories','other_expenses','other']
    when 'indirect_expense'      then array['other_expenses','employee_benefits','finance_costs',
                                            'depreciation_amortisation','tax_expense','other']
    when 'direct_income'         then array['income','other']
    when 'indirect_income'       then array['income','other']
    else array[]::text[]
  end;
$fn$;

revoke all on function app_private.account_group_roles_for_nature(text) from public, anon;
grant execute on function app_private.account_group_roles_for_nature(text) to authenticated;

comment on function app_private.account_group_roles_for_nature(text) is
  'The ledger_role values that are meaningful under an account group of this nature — a compatibility guard, not a style guide. Superset of what the Chart of accounts screen offers; the screen additionally withholds the singleton roles that app_private.ledger_for_role requires to be unique. See 1470.';

-- ---------------------------------------------------------------------------
-- 2. The guard
-- ---------------------------------------------------------------------------
-- Named so it sorts AFTER enforce_account_group_nature: Postgres fires
-- per-row triggers in name order, and this one reads the nature that trigger
-- has already forced from the parent. 'n' < 'p', so the order holds.

create or replace function app_private.enforce_account_group_presentation()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_expected text;
  v_allowed text[];
begin
  v_expected := app_private.account_group_normal_balance(new.nature);

  if v_expected is null then
    raise exception
      'Account group nature % is not one this build knows how to present. Add it to app_private.account_group_normal_balance before using it.',
      new.nature;
  end if;

  -- ASSIGNED, not rejected. Every row in the database already satisfies this,
  -- so nothing existing changes; a caller that sends the wrong side is
  -- corrected rather than made to guess, exactly as 0006 corrects nature.
  new.normal_balance := v_expected;

  v_allowed := app_private.account_group_roles_for_nature(new.nature);

  if not (new.ledger_role = any (v_allowed)) then
    raise exception
      'The role "%" does not belong on a group of nature "%". Choose one of: %.',
      replace(new.ledger_role, '_', ' '),
      replace(new.nature, '_', ' '),
      array_to_string(v_allowed, ', ')
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_account_group_presentation on public.account_groups;

create trigger enforce_account_group_presentation
  before insert or update on public.account_groups
  for each row execute function app_private.enforce_account_group_presentation();

-- Trigger functions inherit PUBLIC's default EXECUTE grant like any other, and
-- this one is SECURITY DEFINER, so it is taken away rather than left. Safe:
-- neither anon nor service_role holds USAGE on app_private (checked), and every
-- table in this database already carries an app_private trigger that service_role
-- fires without it — a trigger's privilege check happens at CREATE TRIGGER, not
-- when it fires. The existing app_private trigger functions (0006's
-- enforce_account_group_nature and protect_system_group among them) still carry
-- the default grant; tightening those is not this migration's business.
revoke all on function app_private.enforce_account_group_presentation() from public, anon;
grant execute on function app_private.enforce_account_group_presentation() to authenticated;

comment on function app_private.enforce_account_group_presentation() is
  'Ties an account group''s normal_balance and ledger_role to its nature, so a user-created group cannot misclassify money in the balance sheet or the statement of profit and loss. See 1470.';

-- ---------------------------------------------------------------------------
-- 3. Prove the map fits the data it claims to describe
-- ---------------------------------------------------------------------------
-- If any existing row disagrees with the map, the assumption behind section 1
-- is wrong and this migration must not be trusted. Checked here rather than
-- taken on faith, because every row would otherwise be silently rewritten the
-- next time anything updated it.

do $mig$
declare
  v_bad int;
  v_detail text;
begin
  select count(*), string_agg(distinct nature || '/' || normal_balance || '/' || ledger_role, ', ')
    into v_bad, v_detail
    from public.account_groups
   where normal_balance is distinct from app_private.account_group_normal_balance(nature)
      or not (ledger_role = any (app_private.account_group_roles_for_nature(nature)));

  if v_bad > 0 then
    raise exception '1470: % existing account group rows disagree with the map (%). Widen the map before enforcing it.',
      v_bad, v_detail;
  end if;

  raise notice '1470: every existing account group row already satisfies the map.';
end $mig$;
