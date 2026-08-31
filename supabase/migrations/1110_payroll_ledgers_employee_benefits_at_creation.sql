-- ============================================================================
-- 1110 — Payroll ledgers get their Schedule III head AT CREATION, not by a
--        one-time backfill that the next new company walks straight past
-- ============================================================================
-- THE WRONG NUMBER, MEASURED LIVE BEFORE A LINE OF THIS FILE WAS WRITTEN.
-- Bharat Industries Limited (a6fc600a-1a82-4ef9-baaa-63c03753eb6c),
-- get_profit_and_loss for FY 2026-27, run exactly as the Schedule III P&L
-- report page runs it:
--     other_expenses  Employer PF Contribution     2,375.00
--     other_expenses  Professional Fees           50,000.00
--     other_expenses  Salary Expense              40,000.00
--   -> "Other expenses" head total                92,375.00
--   -> "Employee benefits expense" head           ABSENT ENTIRELY
-- Of that 92,375.00, only Professional Fees' 50,000.00 genuinely belongs to
-- Schedule III's "Other expenses". The other 42,375.00 is salary and employer
-- PF -- "Employee benefits expense", head (d), a named line of its own in the
-- Statement of Profit and Loss. Two statutory lines wrong in opposite
-- directions on a financial statement, today, for a real company.
--
-- WHY IT IS WRONG, AND WHY THIS IS THE SECOND TIME. 0210 gave public.ledgers
-- a nullable ledger_role that OVERRIDES its group's role, because three
-- system ledgers (Depreciation, Deferred Tax Expense, Changes in Inventories)
-- must stay physically parked under the flat "Indirect Expenses" group while
-- belonging to a different Schedule III head than their siblings there. 0210
-- set that override in the INSERT inside each of the three creating functions
-- (ensure_stock_ledgers/0076, ensure_depreciation_ledgers/0077,
-- ensure_deferred_tax_ledgers/0091), so a company that has never run
-- depreciation still gets a correctly classified ledger the first time it
-- does. 0360 later found the payroll ledgers had the identical problem and
-- fixed it with a one-time UPDATE -- and said so in its own header, in plain
-- words, that this was only half a fix: "it is a ONE-TIME UPDATE over ledgers
-- that exist AS OF this migration. Any company that runs payroll for the
-- FIRST TIME after this migration gets a freshly-created Salary Expense /
-- Employer PF Contribution / Employer ESI Contribution ledger with
-- ledger_role NULL again (seed_payroll_ledgers itself is unchanged)."
-- Bharat Industries Limited is that company. It ran payroll on 2026-08-31,
-- after 0360's backfill, and landed exactly where 0360 predicted it would.
-- The backfill fixed history; nothing fixed the source. This fixes the source.
--
-- ----------------------------------------------------------------------------
-- NOT ALL EIGHT PAYROLL LEDGERS ARE EMPLOYEE BENEFITS -- ONLY THREE ARE.
-- seed_payroll_ledgers creates eight ledgers across three groups, confirmed
-- live (payroll_ledger_map joined to ledgers and account_groups, all
-- companies) rather than assumed:
--   EXPENSE SIDE -- group "Indirect Expenses", nature indirect_expense, group
--   ledger_role 'other_expenses'. These three, and only these three, get the
--   'employee_benefits' override:
--     salary_expense        -> Salary Expense
--     employer_pf_expense   -> Employer PF Contribution
--     employer_esi_expense  -> Employer ESI Contribution
--   LIABILITY SIDE -- five ledgers that are not expenses at all and MUST NOT
--   be given an expense role. Their groups already classify them correctly
--   and their overrides stay NULL:
--     pf_payable, esi_payable, professional_tax_payable, tds_payable
--       -> group "Duties & Taxes", nature current_liability, role 'duty_tax'
--     net_pay_payable  (Salaries Payable)
--       -> group "Outstanding Expenses", nature current_liability, role 'other'
-- Giving any of those five an 'employee_benefits' role would not merely be
-- meaningless -- ledgers.ledger_role carries no nature check, so the value
-- would stick, and any future report reading ledger_role without also
-- filtering on nature would sweep a balance-sheet liability into a P&L
-- expense head. The five nulls below are deliberate and are written out
-- explicitly at each call site, not left to a default, for exactly that
-- reason (see the required-parameter note below).
--
-- ----------------------------------------------------------------------------
-- WHY THE OVERRIDE AND NOT A REPARENT. Every company in this database already
-- has an "Employee Benefits Expense" child group under Indirect Expenses,
-- seeded by 0210 with ledger_role='employee_benefits' (confirmed live: 15 of
-- 15 companies). Pointing seed_payroll_ledgers at that group instead of at
-- Indirect Expenses is a real alternative, and 0210's own stated reason for
-- not reparenting -- that the creating function hardcodes a group_id + name
-- lookup and would duplicate-insert -- does NOT apply here:
-- seed_one_payroll_ledger's reuse lookup is lower(name) across the whole
-- company with no group predicate, so a reparented ledger would still be
-- found. The reason for not reparenting is a different one, and it is about
-- the data rather than the code: Sharma Textiles and Bharat Industries
-- Limited have real, posted payroll vouchers against ledgers that sit under
-- Indirect Expenses today. Reparenting only for new companies would leave two
-- permanently different chart-of-accounts shapes depending on the month a
-- company signed up, and get_profit_and_loss returns group_name in its own
-- output, so the same report would read differently for the same transaction
-- at two companies. Reparenting retroactively would move real ledgers with
-- real postings under a user's feet, changing the trial balance's grouping
-- and every group-keyed report for data already filed. The override column
-- exists precisely so classification can be corrected without moving
-- anything, which is the whole point 0210 made when it added it. One
-- consistent shape plus an override beats two shapes.
--
-- ----------------------------------------------------------------------------
-- THE STRUCTURAL GUARD, AND WHY IT IS A TRIGGER RATHER THAN A REPORT.
-- The brief for this change asked whether something should make this class of
-- bug loud rather than silent, so it cannot recur a third time. The obvious
-- shape -- a report listing "expense ledgers with no ledger_role" -- does not
-- work here, and it is worth writing down why: get_profit_and_loss reads
-- coalesce(ledger.ledger_role, group.ledger_role), so a NULL override is
-- never observable downstream. It silently becomes the group's catch-all,
-- 'other_expenses'. There is no missing value to notice. That is exactly what
-- made both 0210's and 0360's discoveries accidental.
--
-- A trigger on public.ledgers cannot work either: that table has no is_system
-- column (checked live), so at insert time there is nothing to distinguish a
-- system-managed ledger that MUST carry a head from a user's own "Office
-- Rent" that correctly should not. Confirmed by scanning every company: of
-- the eight distinct ledger names currently resolving to 'other_expenses'
-- under an expense-nature group, five (Professional Fees, Office Rent, Common
-- Area Electricity Charges, Common Area Housekeeping Expense, Relief to Poor
-- - Programme Expenses) are genuine other-expenses ledgers that a null-role
-- alarm would flag as false positives forever, and exactly three -- Bharat's
-- payroll trio -- are real defects. A guard with a 5:3 false-positive rate
-- gets ignored, which is the same silence by another route.
--
-- So the guard is placed where the system signal actually lives:
-- payroll_ledger_map.purpose. A row in that table is a machine-readable
-- assertion that "this specific ledger IS this company's salary expense
-- ledger" -- which is precisely the fact that implies the Schedule III head.
-- app_private.stamp_payroll_expense_ledger_role(), fired AFTER INSERT OR
-- UPDATE OF ledger_id on payroll_ledger_map, stamps 'employee_benefits' on
-- the mapped ledger whenever the purpose is one of the three expense
-- purposes. The knowledge moves out of a function body, where it was a
-- convention that two migrations in a row forgot, and next to the data that
-- encodes the purpose, where forgetting it is not possible. Any future code
-- path that maps a salary expense ledger -- one nobody has written yet, one
-- that does not go through seed_payroll_ledgers at all -- gets the correct
-- classification as a consequence of mapping it. That is what makes a third
-- recurrence structurally unavailable rather than merely unlikely.
-- The trigger is guarded three ways so it can never do harm:
--   * l.ledger_role is null -- a preparer's own deliberate override is never
--     clobbered, the same discipline 0210's and 0360's backfills both used.
--   * the ledger's group nature must be direct_expense/indirect_expense -- if
--     someone has mapped salary_expense at an asset or liability ledger, that
--     is a broken setup to fix by hand, not one to paper over by stamping an
--     expense head onto a balance-sheet account.
--   * the UPDATE joins on company_id as well as id. Redundant today, since
--     payroll_ledger_map_ledger_id_company_id_fkey is a composite FK against
--     ledgers(id, company_id) and already makes a cross-company mapping
--     impossible -- but the trigger function is SECURITY DEFINER and
--     therefore bypasses RLS, so it does not lean on another constraint to
--     stay inside one tenant.
-- SECURITY DEFINER is deliberate: the trigger must behave identically whether
-- it fires inside seed_payroll_ledgers (already definer-owned) or from a
-- company admin's own direct write to payroll_ledger_map through PostgREST,
-- rather than depending on that admin's UPDATE privilege on public.ledgers.
--
-- ----------------------------------------------------------------------------
-- THE NEW PARAMETER IS REQUIRED, NOT DEFAULTED. seed_one_payroll_ledger gains
-- a sixth argument, p_ledger_role, with NO default. A default of NULL would
-- have been the smaller diff and would have kept the old signature callable --
-- and would also have let the next person who adds a ninth payroll ledger
-- omit it and silently reintroduce this exact bug for the third time. Making
-- it required forces every call site to state its answer out loud, which is
-- why the five liability lines below read null explicitly. The old 5-arg
-- signature is DROPped rather than left beside the new one, because CREATE OR
-- REPLACE with an added defaulted parameter creates an overload rather than a
-- replacement, leaving a dead 5-arg function that still compiles and still
-- has the bug. Confirmed live first that this is safe: pg_proc.prosrc across
-- both schemas shows exactly one caller of seed_one_payroll_ledger
-- (seed_payroll_ledgers, replaced in the same transaction below) and exactly
-- one caller of seed_payroll_ledgers (public.post_payroll_run, whose call is
-- unaffected -- that signature is unchanged and post_payroll_run is not
-- touched by this migration). Recreating also resets the function's ACL, so
-- the strict convention is applied on the way back in: revoked from PUBLIC
-- and anon, granted to authenticated. That is tighter than what it carried
-- before (it held the default PUBLIC EXECUTE grant), and harmless -- anon has
-- no USAGE on app_private at all, and the only caller reaches it from inside
-- a postgres-owned SECURITY DEFINER context.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT SOLVE.
--   * The reuse path stamps, but only within the expense natures. If a
--     company already has a ledger named "Salary Expense" that payroll adopts
--     rather than creates, it gets classified -- but if that ledger sits
--     under a non-expense group, it is left exactly as found. That is a
--     genuinely wrong chart of accounts and this migration will not disguise
--     it as a right one.
--   * Nothing here touches gratuity or statutory bonus. 0360 established, and
--     it is still true, that no function in this schema ever posts either to
--     the ledger, so there is no system-managed ledger for this migration to
--     classify. A company that journals gratuity by hand under a name of its
--     own choosing still lands in whatever head its group says, and
--     get_notes_employee_benefits_breakup still name-matches it. Unchanged.
--   * get_profit_and_loss, post_payroll_run and create_voucher are not
--     modified. This migration changes which head three ledgers report under;
--     it changes no amount, no voucher, and no posting rule. The nature-level
--     totals are identical before and after -- the same partition-sums-to-the-
--     whole property 0210 used.
--   * The equivalent question for the OTHER system ledger maps (tax_ledger_map
--     and friends) is not examined here. The live scan above found no
--     misclassified system expense ledger outside the payroll trio, so there
--     is nothing to fix today; whether those maps deserve the same trigger if
--     they ever grow an expense-side purpose is left open rather than
--     pre-emptively answered.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. seed_one_payroll_ledger — the Schedule III head is now an argument, set
--    in the INSERT, exactly the way 0210 set it in ensure_depreciation_ledgers
--    and its two siblings. Dropped and recreated rather than replaced, so no
--    5-arg overload survives to be called by accident. See header.
-- ----------------------------------------------------------------------------
drop function if exists app_private.seed_one_payroll_ledger(uuid, uuid, text, text, text);

create function app_private.seed_one_payroll_ledger(
  p_company_id uuid,
  p_group_id uuid,
  p_name text,
  p_purpose text,
  p_opening_type text,
  p_ledger_role text          -- no default, deliberately. See header.
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ledger uuid;
begin
  if exists (
    select 1 from public.payroll_ledger_map
     where company_id = p_company_id and purpose = p_purpose
  ) then
    return;
  end if;

  select id into v_ledger
    from public.ledgers
   where company_id = p_company_id and lower(name) = lower(p_name)
   limit 1;

  if v_ledger is null then
    -- Creation path. The head is set here, at creation, which is the whole
    -- point of this migration: a company running payroll for the first time
    -- never needs a backfill to be classified correctly.
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, ledger_role)
    values (p_company_id, p_group_id, p_name, p_opening_type, p_ledger_role)
    returning id into v_ledger;
  elsif p_ledger_role is not null then
    -- Adoption path. The company already had a same-named ledger and payroll
    -- is taking it over as its own. It is now, structurally, the salary /
    -- employer PF / employer ESI expense ledger, so it earns the same head --
    -- but only as a null-to-correct transition (never clobbering a preparer's
    -- own override) and only if it actually sits on the expense side.
    update public.ledgers l
       set ledger_role = p_ledger_role
      from public.account_groups g
     where l.id = v_ledger
       and g.id = l.group_id
       and g.nature in ('direct_expense', 'indirect_expense')
       and l.ledger_role is null;
  end if;

  insert into public.payroll_ledger_map (company_id, purpose, ledger_id)
  values (p_company_id, p_purpose, v_ledger)
  on conflict (company_id, purpose) do nothing;
end;
$fn$;

revoke all on function app_private.seed_one_payroll_ledger(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function app_private.seed_one_payroll_ledger(uuid, uuid, text, text, text, text) to authenticated;

comment on function app_private.seed_one_payroll_ledger is
  'Get-or-create one ledger for one payroll_ledger_map purpose, and set its Schedule III expense head at the same time. Reuses an existing same-named ledger if the company already has one, same discipline as seed_tds_ledgers (0030). p_ledger_role is REQUIRED and has no default: pass ''employee_benefits'' for the three expense purposes and NULL for the five liability purposes, which are not expenses and must not carry an expense head. On the reuse path the role is only applied when the existing ledger has no override of its own and sits under an expense-nature group. Idempotent via the payroll_ledger_map existence check. See 0075 for the original, and 1110 for why the role moved into the insert.';


-- ----------------------------------------------------------------------------
-- 2. seed_payroll_ledgers — same signature, same eight ledgers, same groups,
--    same order. The only change is the sixth argument on each line, which
--    now says out loud which three of the eight are Schedule III employee
--    benefits and which five are liabilities that must stay unclassified.
-- ----------------------------------------------------------------------------
create or replace function app_private.seed_payroll_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_indirect_expense uuid;
  v_duty_tax uuid;
  v_outstanding uuid;
begin
  select id into v_indirect_expense from public.account_groups
   where company_id = p_company_id and parent_group_id is null and name = 'Indirect Expenses';
  select id into v_duty_tax from public.account_groups
   where company_id = p_company_id and name = 'Duties & Taxes';
  select id into v_outstanding from public.account_groups
   where company_id = p_company_id and name = 'Outstanding Expenses';

  if v_indirect_expense is null or v_duty_tax is null or v_outstanding is null then
    raise exception 'Chart of accounts is missing a standard group; seed it first';
  end if;

  -- The three EXPENSE ledgers. Indirect Expenses' own group role is
  -- 'other_expenses' (Schedule III's catch-all), which is wrong for all
  -- three -- salary and both employer contributions are head (d), Employee
  -- benefits expense. The per-ledger override (0210) corrects it at creation.
  perform app_private.seed_one_payroll_ledger(p_company_id, v_indirect_expense, 'Salary Expense', 'salary_expense', 'debit', 'employee_benefits');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_indirect_expense, 'Employer PF Contribution', 'employer_pf_expense', 'debit', 'employee_benefits');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_indirect_expense, 'Employer ESI Contribution', 'employer_esi_expense', 'debit', 'employee_benefits');

  -- The five LIABILITY ledgers. Not expenses at all -- these are the amounts
  -- withheld or accrued and still owed to EPFO / ESIC / the state PT
  -- authority / the department / the employee. They belong on the balance
  -- sheet, their groups already classify them ('duty_tax' and 'other'), and
  -- an expense head here would be a category error. NULL is written out on
  -- each line rather than defaulted, so the answer is visible.
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'PF Payable', 'pf_payable', 'credit', null);
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'ESI Payable', 'esi_payable', 'credit', null);
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'Professional Tax Payable', 'professional_tax_payable', 'credit', null);
  -- Distinct from the general "TDS Payable" every company already carries for
  -- vendor TDS: different section code, different return, different challan.
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'TDS Payable (Salary)', 'tds_payable', 'credit', null);
  perform app_private.seed_one_payroll_ledger(p_company_id, v_outstanding, 'Salaries Payable', 'net_pay_payable', 'credit', null);
end;
$fn$;

comment on function app_private.seed_payroll_ledgers is
  'Provisions the eight payroll ledgers for a company, lazily, on the first post_payroll_run. Three are expenses under Indirect Expenses and are created with ledger_role=''employee_benefits'' so the Schedule III P&L reports them under Employee benefits expense rather than Other expenses; the five payables under Duties & Taxes / Outstanding Expenses are liabilities and are created with no expense role at all. Groups are resolved by exact seeded name rather than by ledger_role, since ledger_role is not unique across Direct and Indirect Expenses. See 0047 and 0075 for the original, and 1110 for the classification.';


-- ----------------------------------------------------------------------------
-- 3. The structural guard. A row in payroll_ledger_map naming a ledger as a
--    company's salary / employer PF / employer ESI expense ledger IS the fact
--    that determines the Schedule III head, so the head is derived from that
--    row rather than remembered by whoever wrote the creating function. See
--    the header for why this grain, and not a null-role alarm on ledgers.
-- ----------------------------------------------------------------------------
create or replace function app_private.stamp_payroll_expense_ledger_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.purpose in ('salary_expense', 'employer_pf_expense', 'employer_esi_expense') then
    update public.ledgers l
       set ledger_role = 'employee_benefits'
      from public.account_groups g
     where l.id = new.ledger_id
       and l.company_id = new.company_id     -- never reach outside the tenant
       and g.id = l.group_id
       and g.nature in ('direct_expense', 'indirect_expense')
       and l.ledger_role is null;            -- never clobber a real override
  end if;
  return null;
end;
$fn$;

revoke all on function app_private.stamp_payroll_expense_ledger_role() from public, anon;
grant execute on function app_private.stamp_payroll_expense_ledger_role() to authenticated;

comment on function app_private.stamp_payroll_expense_ledger_role is
  'Trigger guard: whenever a ledger is mapped to one of payroll''s three EXPENSE purposes, give it Schedule III''s Employee benefits expense head if it has no override of its own and sits under an expense-nature group. Exists because this classification was missed twice -- 0210 set it for its own three system ledgers but not payroll''s, and 0360 backfilled the existing rows while explicitly noting that seed_payroll_ledgers itself was left unfixed, so the next company to run payroll regressed. Deriving the head from payroll_ledger_map.purpose, rather than remembering to set it in whichever function creates the ledger, makes a third recurrence structurally unavailable. Never touches the five liability purposes. See 1110.';

drop trigger if exists trg_stamp_payroll_expense_ledger_role on public.payroll_ledger_map;

create trigger trg_stamp_payroll_expense_ledger_role
after insert or update of ledger_id on public.payroll_ledger_map
for each row execute function app_private.stamp_payroll_expense_ledger_role();


-- ----------------------------------------------------------------------------
-- 4. Backfill for every ledger created since 0360's one-time pass -- Bharat
--    Industries Limited's three today. Same shape as 0360's own UPDATE, plus
--    the expense-nature guard the trigger uses, so the two agree exactly.
--    Idempotent: re-running it after this migration matches zero rows.
-- ----------------------------------------------------------------------------
update public.ledgers l
   set ledger_role = 'employee_benefits'
  from public.payroll_ledger_map pm,
       public.account_groups g
 where pm.ledger_id = l.id
   and pm.company_id = l.company_id
   and g.id = l.group_id
   and g.nature in ('direct_expense', 'indirect_expense')
   and pm.purpose in ('salary_expense', 'employer_pf_expense', 'employer_esi_expense')
   and l.ledger_role is null;

notify pgrst, 'reload schema';
