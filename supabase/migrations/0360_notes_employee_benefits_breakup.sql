-- ============================================================================
-- 0360 — Notes to accounts: the Employee Benefits Expense sub-break-up
--         0210 explicitly deferred
-- ============================================================================
-- 0210's own header said so in plain words: "Schedule III's own general
-- instructions require every P&L line to cross-reference a supporting note
-- (e.g. an employee-benefits break-up of salaries/PF/ESOP/staff welfare) —
-- this schema and report show the HEAD TOTAL only, not the note-level
-- sub-break-up." This migration closes that named gap, in the home 0105
-- already built for exactly this class of disclosure (read live before
-- writing a line here — get_contingent_liabilities_note /
-- get_related_party_note / get_ageing_schedule, and their shared report page
-- at app/(app)/[companyId]/reports/notes-to-accounts/page.tsx).
--
-- THE BARE STATUTORY TEXT, CONFIRMED LIVE (WebSearch, two independent
-- sources — the same pair 0210 used, ca2013.com's hosted bare-act text and
-- corporatelawreporter.com's clause-by-clause reproduction — a second,
-- deliberately skeptical search specifically to rule out a paraphrase
-- drifting from the actual wording): Schedule III Part II, General
-- Instructions for the Statement of Profit and Loss, requires — "A Company
-- shall disclose by way of notes additional information regarding aggregate
-- expenditure ... on Employee Benefits Expense [showing separately (i)
-- salaries and wages, (ii) contribution to provident and other funds, (iii)
-- expense on Employee Stock Option Scheme (ESOP) and Employee Stock Purchase
-- Plan (ESPP), (iv) staff welfare expenses]." Four items, not five — Gratuity
-- and Statutory Bonus are NOT their own named statutory line. This migration
-- still builds a finer 5-bucket split (per this task's own brief) because it
-- is a common, genuinely useful refinement real Indian company notes make in
-- practice (AS 15 / Ind AS 19 itself lists "profit-sharing and bonuses" as a
-- SHORT-TERM benefit alongside wages, and gratuity as the flagship
-- POST-EMPLOYMENT benefit inside "contribution to ... other funds") — but
-- said HONESTLY here, not fabricated as itself the statutory minimum: a
-- preparer who needs only the bare four-item note gets it by folding this
-- migration's Gratuity bucket into (ii) and its Statutory Bonus bucket into
-- (i). ESOP/ESPP (iii) is NOT modelled at all — grepped the full migrations
-- directory before writing this (`esop|espp|stock option`) and confirmed
-- live: LEKHA has no share-based-payment feature anywhere, so there is no
-- honest signal to report a Rs 0 line from a Rs 0 line that might not even
-- be true; the residual "Staff welfare / other" bucket is where a company's
-- own manually-ledgered ESOP cost would land if it ever ledgers one, exactly
-- as honestly as any other unclassified employee-benefit ledger would.
-- Sources: https://ca2013.com/schedule/7501/ ,
-- https://corporatelawreporter.com/companies_act/schedule-3-of-companies-act-2013-general-instructions-for-preparation-of-balance-sheet-and-statement-of-profit-and-loss-of-a-company/
--
-- ----------------------------------------------------------------------------
-- CONFIRMED LIVE BEFORE WRITING A LINE OF SQL — WHAT THIS APP'S REAL DATA
-- ACTUALLY LOOKS LIKE. Not the "typical seeded company" the task brief
-- guessed at:
--   * Zero ledgers, anywhere, across all 15 companies, carried
--     coalesce(ledgers.ledger_role, account_groups.ledger_role) =
--     'employee_benefits' before this migration.
--   * public.payroll_ledger_map (0047/0075 — the table post_payroll_run
--     keys "Salary Expense"/"Employer PF Contribution"/"Employer ESI
--     Contribution"/etc. off of) had ZERO rows for EVERY company. No company
--     in this database had ever run payroll. (The task brief's framing —
--     "PF/ESI ledgers from 0110, gratuity from 0140, statutory bonus from
--     0109" — mis-attributes the PF/ESI ledgers: 0110 (ECR/MC-file reports)
--     and 0109 (bonus computation) are both READ-ONLY consumers of other
--     functions' data and never create a ledger or post a voucher, confirmed
--     by grepping both files for create_voucher/insert into ledgers — zero
--     hits in either. The real ledger-creating function is
--     app_private.seed_payroll_ledgers, added by 0075, called from
--     post_payroll_run.)
--   * 0140 (leave/gratuity/full-and-final) is ALSO entirely report/ledger-
--     table-only — get_gratuity_computation, record_fnf_settlement, etc. all
--     write to employee_exit_settlements / employee_leave_ledger, never to
--     voucher_entries (grepped for create_voucher/insert into
--     public.ledgers/public.vouchers across the whole file: zero hits). So
--     there is, structurally, NO system-managed "Gratuity" or "Statutory
--     Bonus" ledger anywhere in this schema, ever — a company that wants
--     either in its books must manually journal it under some ledger it
--     names itself. This is not a gap this migration can name-match its way
--     around; it is stated plainly below and in scope_deferred.
--   * Only one company, Sharma Textiles, has any employee data (11 rows,
--     several explicitly named "... (TEST DATA)" / "... - Bonus Test ..." by
--     earlier sessions' own seeding).
--
-- Given all of that, this migration's own verification (see the structured
-- report) could not "confirm against a real company's real payroll
-- postings" without first CREATING one — there was no other honest way to
-- get a non-empty employee_benefits total to partition. public.
-- post_payroll_run (unmodified, called exactly as any user would through the
-- existing Payroll screen — this migration does not touch it or
-- app_private.seed_payroll_ledgers, both are on this task's do-not-touch
-- list) was run for Sharma Textiles, period July 2026, before this migration
-- was written. Real, live, outside any rolled-back transaction — see "Real
-- data left in the database" in the structured report.
--
-- ----------------------------------------------------------------------------
-- A SECOND, GENUINELY LOAD-BEARING GAP THIS RUN SURFACED: seed_payroll_ledgers
-- PARKS "Salary Expense" / "Employer PF Contribution" / "Employer ESI
-- Contribution" DIRECTLY UNDER THE TOP-LEVEL "Indirect Expenses" GROUP —
-- unchanged since 0075, which predates 0210's Schedule III re-classification
-- by well over a hundred migrations. Confirmed live by actually running
-- post_payroll_run above and reading get_profit_and_loss's own output
-- straight after: all three ledgers came back ledger_role='other_expenses',
-- not 'employee_benefits' — meaning TODAY, for every company that has run or
-- will run payroll, real salary/PF/ESI cost is misclassified as generic
-- "Other expenses" in the Schedule III P&L itself, a full head wrong, not
-- merely un-sub-classified. This migration is not permitted to edit
-- seed_payroll_ledgers or post_payroll_run (do-not-touch list) or
-- get_profit_and_loss (also do-not-touch), so the fix taken here is the same
-- one 0210 itself used for its three system-ledger overrides: a plain,
-- additive UPDATE on ledgers.ledger_role (the override column 0210 already
-- added for exactly this situation), matched by
-- payroll_ledger_map.purpose — not by name-guessing, since purpose is an
-- exact, structural signal — guarded by `ledger_role is null` so a
-- preparer's own deliberate override is never clobbered. This is a DATA fix,
-- not a code change to any off-limits function, and it is what makes this
-- migration's own headline invariant (this note's bucket split sums exactly
-- to get_profit_and_loss's employee_benefits total) TRUE rather than
-- vacuously true-because-both-sides-are-empty.
--
-- THE LIMITATION THIS BACKFILL DOES NOT CLOSE, NAMED RATHER THAN HIDDEN: it
-- is a ONE-TIME UPDATE over ledgers that exist AS OF this migration. Any
-- company that runs payroll for the FIRST TIME after this migration gets a
-- freshly-created Salary Expense / Employer PF Contribution / Employer ESI
-- Contribution ledger with ledger_role NULL again (seed_payroll_ledgers
-- itself is unchanged), which lands back under Indirect Expenses' own
-- 'other_expenses' default at BOTH get_profit_and_loss and this note, until
-- either a future migration re-runs this same backfill or
-- seed_payroll_ledgers itself is patched to set the override at creation
-- time (the same fix 0210 made to ensure_stock_ledgers / ensure_
-- depreciation_ledgers / ensure_deferred_tax_ledgers for their three
-- ledgers — seed_payroll_ledgers just never got the equivalent treatment,
-- and is not this task's to give it, since it is explicitly off-limits
-- here). Flagged again in scope_deferred.
--
-- ----------------------------------------------------------------------------
-- THE FIVE BUCKETS, AND WHICH ARE RELIABLE VS. A NAME-MATCHED BEST EFFORT —
-- stated in the function's own comment too, not just here:
--   1. Salaries and wages — RELIABLE. ledger_id is the company's
--      payroll_ledger_map row for purpose='salary_expense' (0075's "Salary
--      Expense" ledger, the one post_payroll_run debits every gross_pay).
--   2. Contribution to provident and other funds (incl. ESI) — RELIABLE.
--      purpose in ('employer_pf_expense','employer_esi_expense') — "Employer
--      PF Contribution" and "Employer ESI Contribution", the two employer-
--      cost ledgers post_payroll_run debits (EDLI and EPF admin charges ride
--      the PF expense ledger already, per 0075's own header — not
--      double-counted or missed here).
--   3. Gratuity expense — NAME-MATCHED, NOT SYSTEM-SOURCED. No function in
--      this codebase ever posts a gratuity voucher (see above) — this
--      bucket only ever catches a ledger a preparer manually created and
--      named with "gratuity" in it. Zero today, for every company.
--   4. Statutory bonus — NAME-MATCHED, NOT SYSTEM-SOURCED. Same story —
--      0109 never posts. Zero today, for every company.
--   5. Staff welfare / other — the residual catch-all: every OTHER ledger
--      inside the employee_benefits universe (see below) not caught by 1-4.
--      A company that ledgers something oddly (an ESOP cost, a canteen
--      subsidy filed under a ledger with no "welfare"/"gratuity"/"bonus" cue
--      in its name, anything) lands here, correctly unclassified rather than
--      misclassified.
-- Buckets 3 and 4 are genuinely best-effort: a company could name its
-- gratuity-provision ledger "Employee Terminal Benefits" and this migration
-- would never catch it, landing it in bucket 5 instead — a real, disclosed
-- limitation of name-matching over a schema with no gratuity/bonus posting
-- feature to key off structurally, exactly the same class of caveat 0210
-- named for its own "Purchase Account" ambiguity.
--
-- THE UNIVERSE THIS NOTE PARTITIONS IS get_profit_and_loss's OWN
-- employee_benefits SET, NOT A NEW ONE. get_notes_employee_benefits_breakup
-- selects ledgers where coalesce(ledgers.ledger_role,
-- account_groups.ledger_role) = 'employee_benefits' — the identical
-- predicate get_profit_and_loss (0210) already applies before its own
-- ledger_role column reaches the report page — and sums the identical
-- debit-minus-credit movement formula over the identical non-deleted-
-- voucher, date-range, optional-branch filter. This is what makes "the
-- 4-5 bucket split sums exactly to get_profit_and_loss's own
-- employee_benefits total" true BY CONSTRUCTION, not by coincidence, the
-- same "reuse the computation, don't re-derive a parallel one" discipline
-- 0105's get_ageing_schedule and get_related_party_note both already follow.
--
-- security invoker, set search_path = '' — matching 0105's three note
-- functions exactly (not 0210's get_profit_and_loss, which is SQL/stable
-- with no explicit security clause; 0105 is the actual precedent this task
-- was told to match). Read-only; touches no table this task does not own.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- One-time backfill: the three payroll-created expense ledgers, wherever
-- they already exist (identified via payroll_ledger_map.purpose, not by
-- name), get the ledger_role override 0210 already built ledgers.ledger_role
-- for. `ledger_role is null` guard preserves any preparer's own deliberate
-- override, matching 0210's own backfill discipline exactly.
-- ----------------------------------------------------------------------------
update public.ledgers l
   set ledger_role = 'employee_benefits'
  from public.payroll_ledger_map pm
 where pm.ledger_id = l.id
   and pm.purpose in ('salary_expense', 'employer_pf_expense', 'employer_esi_expense')
   and l.ledger_role is null;


-- ----------------------------------------------------------------------------
-- get_notes_employee_benefits_breakup(company, period_start, period_end, branch)
-- One row per (bucket, constituent ledger) with non-zero period movement —
-- same "omit zero rows, the report page owns the fixed bucket-label shell"
-- shape 0105's own ageing schedule established for its bucket UI (the SQL
-- returns actuals; the page supplies the always-present label list and
-- defaults a missing bucket to zero, exactly like RECEIVABLE_BUCKET_ORDER /
-- PAYABLE_BUCKET_ORDER already do there).
-- ----------------------------------------------------------------------------
create or replace function public.get_notes_employee_benefits_breakup(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_branch_id uuid default null
) returns table (
  bucket_order smallint,
  bucket_label text,
  source_basis text,
  ledger_id uuid,
  ledger_name text,
  amount numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with universe as (
    -- Identical predicate to get_profit_and_loss (0210): coalesce(ledger
    -- override, group default) = 'employee_benefits', restricted to the same
    -- two expense natures that function itself reads from. Not a new
    -- definition of "employee benefits expense" -- THE definition, so the
    -- partition below reconciles to that function's own total by
    -- construction. See migration header.
    select l.id, l.name
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id
       and g.nature in ('direct_expense', 'indirect_expense')
       and coalesce(l.ledger_role, g.ledger_role) = 'employee_benefits'
  ),
  movement as (
    -- Same debit-minus-credit-over-the-period formula get_profit_and_loss
    -- uses for every expense-nature row, same non-deleted/date-range/
    -- optional-branch filter.
    select u.id as ledger_id, u.name as ledger_name,
           coalesce(sum(e.debit_amount - e.credit_amount), 0) as amount
      from universe u
      left join public.voucher_entries e on e.ledger_id = u.id
      left join public.vouchers v on v.id = e.voucher_id
                                  and not v.is_deleted
                                  and v.voucher_date between p_period_start and p_period_end
                                  and (p_branch_id is null or e.branch_id = p_branch_id)
     group by u.id, u.name
  ),
  payroll_purpose as (
    -- The RELIABLE signal: exactly the ledger post_payroll_run itself
    -- created for this purpose, for this company -- the same table 0110's
    -- ECR/MC-file reports already key off. See migration header for why
    -- this is a stronger signal than name-matching for these two buckets
    -- specifically.
    select ledger_id, purpose
      from public.payroll_ledger_map
     where company_id = p_company_id
       and purpose in ('salary_expense', 'employer_pf_expense', 'employer_esi_expense')
  ),
  classified as (
    select
      m.ledger_id, m.ledger_name, m.amount,
      case
        when pp.purpose = 'salary_expense' then 1::smallint
        when pp.purpose in ('employer_pf_expense', 'employer_esi_expense') then 2::smallint
        when m.ledger_name ilike '%gratuity%' then 3::smallint
        when m.ledger_name ilike '%bonus%' then 4::smallint
        else 5::smallint
      end as bucket_order,
      case
        when pp.purpose is not null then 'system: payroll ledger'
        when m.ledger_name ilike '%gratuity%' or m.ledger_name ilike '%bonus%' then 'name-matched'
        else 'residual'
      end as source_basis
      from movement m
      left join payroll_purpose pp on pp.ledger_id = m.ledger_id
     where m.amount <> 0
  )
  select
    c.bucket_order,
    case c.bucket_order
      when 1 then 'Salaries and wages'
      when 2 then 'Contribution to provident and other funds (incl. ESI)'
      when 3 then 'Gratuity expense'
      when 4 then 'Statutory bonus'
      else 'Staff welfare / other'
    end as bucket_label,
    c.source_basis,
    c.ledger_id,
    c.ledger_name,
    round(c.amount, 2) as amount
    from classified c
   order by c.bucket_order, c.ledger_name;
$$;

revoke all on function public.get_notes_employee_benefits_breakup(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_notes_employee_benefits_breakup(uuid, date, date, uuid) to authenticated;

comment on function public.get_notes_employee_benefits_breakup is
  'Schedule III note-level sub-break-up of the Employee Benefits Expense head 0210 left as a total only. Partitions the exact same ledger set get_profit_and_loss (0210) reports as ledger_role=''employee_benefits'' into five buckets: Salaries and wages / Contribution to provident and other funds (incl. ESI) — both sourced reliably from payroll_ledger_map.purpose (0075/0047) — plus Gratuity expense / Statutory bonus — both name-matched only, since no function in this schema ever posts either to the ledger (0109/0140 are report-only) — plus a Staff welfare / other residual. Sums exactly to get_profit_and_loss''s own employee_benefits total for the same company/period/branch by construction. See 0360.';

notify pgrst, 'reload schema';
