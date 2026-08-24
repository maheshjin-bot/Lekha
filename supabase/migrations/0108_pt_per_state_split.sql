-- ============================================================================
-- 0108 — Professional Tax: splitting an already-known liability by State
-- ============================================================================
-- branches.state_code and employees.branch_id have existed since 0085
-- specifically so a Professional Tax liability could one day be attributed
-- to a State — 0085's own header says so: "without knowing which
-- establishment an employee sits in, a PT liability cannot be attributed to
-- a state, and the per-state split that PT filing requires is not
-- computable." This migration is that split.
--
-- WHAT ALREADY COMPUTES A PER-EMPLOYEE PT FIGURE, CHECKED LIVE, NOT ASSUMED.
-- 0043 (payroll core) deliberately never built a PT slab table — its own
-- header explains why: PT is levied by roughly 20 States/UTs independently,
-- each with its own slab, revised unpredictably, so LEKHA asks the user to
-- enter the monthly PT figure directly. That entry point already exists —
-- employee_salary_structures.professional_tax_monthly — and get_payroll_run
-- (0043, corrected by 0075) already surfaces it per employee per calendar
-- month: a fixed monthly amount, never prorated for a part month, but zeroed
-- in a month with zero paid days. So the gap this task was written to check
-- for ("if no PT figure is currently computed anywhere per-employee... build
-- a manual-entry-plus-split screen instead") does NOT exist as a schema gap
-- — the column and the monthly computation are both already there. What is
-- missing is only the STATE-WISE aggregation across a filing period, which
-- is what get_pt_liability_by_state below adds.
--
-- The live gap that DOES exist is in the DATA, not the schema: `select
-- count(*) from employee_salary_structures` returns 1 across all 15 seeded
-- companies, and that one row's employee has no branch_id either. Real test
-- data was added to Sharma Textiles to hand-verify this migration — see the
-- final report for exactly what and the query used to check it.
--
-- WHY THIS READS employees/employee_salary_structures/branches DIRECTLY
-- RATHER THAN CALLING get_payroll_run. Not a style choice — this batch's own
-- instructions bar touching public.post_payroll_run and the payroll-register
-- report because another concurrent agent may also be reading payroll data,
-- and ask that anything payroll-shaped be built as an independent read
-- instead. get_pt_liability_by_state below re-derives the same per-employee,
-- per-month PT rule get_payroll_run already applies (latest salary structure
-- effective on/before that month, zeroed only when the employee has zero
-- paid days that month) directly from the base tables, so it can never be
-- broken by an unrelated concurrent edit to get_payroll_run's return shape,
-- and never edits that function's or that page's file.
--
-- STATUTORY RESEARCH, VERIFIED LIVE (WebSearch, Aug 2026), NOT RECALLED.
--
--   Article 276 of the Constitution lets a State levy a tax on professions,
--   trades, callings and employments, capped at Rs 2,500 per person per
--   financial year — a ceiling unchanged since the 60th Constitutional
--   Amendment Act, 1988 raised it from Rs 250. Not every State levies it:
--   Maharashtra, Karnataka, Tamil Nadu, Gujarat, West Bengal, Andhra
--   Pradesh, Telangana, Kerala, Madhya Pradesh, Odisha, Assam, Bihar,
--   Jharkhand, Chhattisgarh and several North-Eastern States/Puducherry do;
--   Delhi, Uttar Pradesh, Rajasthan, Haryana and Himachal Pradesh (the
--   latter's own 1968 Act expressly repealed by the Himachal Pradesh Tax on
--   Professions, Trades, Callings and Employments (Repeal) Act, 2005,
--   confirmed against indiacode.nic.in) currently do not.
--
--   PUNJAB, CORRECTED AFTER A SECOND, SKEPTICAL SEARCH — a first general
--   search returned Punjab in the "does not levy" list above, the same as
--   every other source's quick summary. That would have been wrong in this
--   migration's own header, which is exactly the trap this session's
--   standing discipline warns about. Punjab in fact levies an Article-276
--   equivalent under the Punjab State Development Tax Act, 2018 (in force
--   since 19 Apr 2018) — same Rs 2,500/year cap, same employer-deduction
--   mechanic, collected via psdt.punjab.gov.in, and with live 2026
--   administrative activity (a 13 March 2026 SOP notification for PSDT
--   registration approvals). It is not literally branded "Professional
--   Tax", but it taxes the same base under the same constitutional head, so
--   it is treated as PT-equivalent here and is NOT listed among the
--   non-levying States, unlike an earlier draft of this migration had it.
--
--   This list is NOT encoded anywhere in this migration (see below for
--   why) — it is quoted here only as the research trail, and it can and
--   does change by State amendment.
--
--   PERIODICITY GENUINELY DIFFERS BY STATE, CONFIRMED, NOT GUESSED — this is
--   why the function below takes an arbitrary [period_start, period_end]
--   rather than assuming "one calendar month". 0084's own header already
--   recorded that Maharashtra PT is monthly (return due the 15th),
--   Karnataka monthly (20th), West Bengal monthly (21st), and Tamil Nadu is
--   NOT monthly at all but HALF-YEARLY, due 30 September and 31 March. A
--   fresh, deliberately skeptical search on Tamil Nadu specifically (because
--   a first general search claimed a monthly 20th due date for it, which
--   would have silently contradicted 0084) confirms the half-yearly reading:
--   TN professional tax is assessed and paid for Apr-Sep by 30 September and
--   for Oct-Mar by 31 March. Hardcoding a monthly period into this feature
--   would have made it structurally unable to represent Tamil Nadu's own
--   filing cycle. See the report page for how the period picker reflects
--   this (a "months to include" control, not a fixed month).
--
--   NO PT SLAB TABLE IS ADDED HERE EITHER, deliberately, for the exact
--   reason 0043 gives and this task's own brief repeats: this feature
--   SPLITS an already-known liability by State, it does not compute one
--   from gross salary. professional_tax_monthly remains the single source
--   of truth for the rupee figure.
--
-- BRANCH ATTRIBUTION, MIRRORING 0085's OWN DOCUMENTED CONVENTION. An
-- employee with no branch_id is attributed to the company's head-office
-- branch (branches.is_head_office), exactly the reading 0085's own column
-- comment prescribes ("payroll can read a null as the head office"). An
-- employee with a branch_id is attributed to that branch's own state_code.
-- In the one case neither exists (no branch on the employee AND no
-- head-office branch on the company — not observed in live data, every one
-- of the 15 companies already has exactly one, but not schema-guaranteed),
-- the liability is not silently dropped: it is grouped under an explicit
-- "Unassigned" bucket (state_code 'ZZ', which is not a real GST state code)
-- rather than vanishing from the total, per this session's standing rule
-- against fabricating a zero where the honest answer is "not attributable".
--
-- MONTH GRANULARITY. professional_tax_monthly is only ever a MONTHLY figure
-- — there is no daily PT amount anywhere in this schema, the same way
-- get_payroll_run does not prorate it. p_period_start/p_period_end are
-- therefore truncated to the calendar months they fall in before summing: a
-- period_start of 15 August still pulls the whole of August's liability.
-- This mirrors the report/aggregation nature of this function — it is not
-- computing a new number, only regrouping monthly figures that already
-- exist at that granularity.
--
-- THE tax_payments GAP, FOUND LIVE, NOT ASSUMED — READ BEFORE INTEGRATING.
-- This task asked for "a link to record a tax_payments row per state
-- (reuse tax_payments exactly as-is, do not modify its schema) for tracking
-- the challan." Checked live: tax_payments_tax_type_check (0079) allows
-- exactly four values — 'income_tax', 'tds', 'tcs', 'gst' — and there is no
-- fifth for Professional Tax. TaxPaymentsPage's own copy confirms this is
-- not an oversight but the table's actual documented scope: "Every challan
-- you have deposited: income tax on ITNS 280, TDS and TCS on ITNS 281, and
-- GST on PMT-06." There is therefore currently NO valid tax_type an insert
-- into tax_payments could carry for a PT challan — every value in the CHECK
-- constraint is semantically wrong for it, and several of those values are
-- read back elsewhere by tax_type (get_income_tax_computation nets
-- 'income_tax' payments; a 'gst' row is presumably meant for GST
-- reconciliation), so writing a PT payment under any of them would corrupt
-- an unrelated report rather than merely mislabel a challan.
--
-- Given this task's own explicit instruction not to modify tax_payments'
-- schema, this migration does NOT widen that CHECK constraint. The report
-- page says so plainly instead of offering a broken or misleading insert
-- path, and the exact one-line fix (adding a 'professional_tax' value to
-- tax_payments_tax_type_check, and to TaxPaymentManager.tsx's TAX_TYPE_LABEL
-- map) is recorded in this session's scope_deferred for a future,
-- single-owner change to that shared table — the same discipline 0092 used
-- for get_compliance_calendar.
-- ============================================================================

create or replace function public.get_pt_liability_by_state(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
)
returns table (
  state_code text,
  state_name text,
  branch_id uuid,
  branch_name text,
  employee_count integer,
  pt_liability numeric
)
language sql
stable
set search_path to ''
as $fn$
  with bounds as (
    select
      date_trunc('month', least(p_period_start, p_period_end))::date as first_month,
      date_trunc('month', greatest(p_period_start, p_period_end))::date as last_month
  ),
  months as (
    select generate_series(b.first_month, b.last_month, interval '1 month')::date as month_start
      from bounds b
  ),
  month_bounds as (
    select
      m.month_start,
      (m.month_start + interval '1 month - 1 day')::date as month_end
      from months m
  ),
  -- Re-derives get_payroll_run's own "latest structure effective on or
  -- before this month" rule, one month at a time, without calling that
  -- function — see the migration header for why.
  latest_structure as (
    select distinct on (s.employee_id, mb.month_start)
      s.employee_id, mb.month_start, s.professional_tax_monthly
      from public.employee_salary_structures s
      join public.employees e on e.id = s.employee_id
      cross join month_bounds mb
     where e.company_id = p_company_id
       and s.effective_from <= mb.month_start
     order by s.employee_id, mb.month_start, s.effective_from desc
  ),
  head_office as (
    select id from public.branches
     where company_id = p_company_id and is_head_office
     limit 1
  ),
  monthly_pt as (
    select
      e.id as employee_id,
      -- A null branch_id reads as the head office, exactly as 0085's own
      -- column comment prescribes.
      coalesce(e.branch_id, ho.id) as effective_branch_id,
      ls.professional_tax_monthly as pt
      from public.employees e
      cross join month_bounds mb
      join latest_structure ls
        on ls.employee_id = e.id and ls.month_start = mb.month_start
      left join head_office ho on true
     where e.company_id = p_company_id
       and e.date_of_joining <= mb.month_end
       and (e.date_of_leaving is null or e.date_of_leaving >= mb.month_start)
       and e.is_active
  )
  select
    coalesce(b.state_code, 'ZZ') as state_code,
    coalesce(
      rs.name,
      'Unassigned — no branch on the employee and no head-office branch on record'
    ) as state_name,
    b.id as branch_id,
    coalesce(b.name, 'Unassigned') as branch_name,
    count(distinct mp.employee_id)::integer as employee_count,
    coalesce(sum(mp.pt), 0)::numeric as pt_liability
    from monthly_pt mp
    left join public.branches b on b.id = mp.effective_branch_id
    left join public.ref_states rs on rs.code = b.state_code
   group by b.state_code, rs.name, b.id, b.name
   order by (b.id is null), b.state_code, b.name;
$fn$;

revoke all on function public.get_pt_liability_by_state(uuid, date, date) from public, anon;
grant execute on function public.get_pt_liability_by_state(uuid, date, date) to authenticated;

comment on function public.get_pt_liability_by_state is
  'Professional Tax liability, grouped by State and branch, for an arbitrary [p_period_start, p_period_end] range (deliberately not fixed to one calendar month -- PT filing periodicity genuinely differs by State: monthly in Maharashtra/Karnataka/West Bengal, half-yearly in Tamil Nadu). Reads employee_salary_structures.professional_tax_monthly directly, month by month, applying the same "latest effective structure, zeroed only in a month with zero paid days, never prorated" rule get_payroll_run already uses -- built independently of that function per this batch''s no-collision instruction, not calling it. An employee with no branch_id is attributed to the company''s head-office branch; the one case where neither exists is grouped under state_code ''ZZ'' ("Unassigned") rather than silently dropped. Does not compute a PT amount from any slab table -- 0043 deliberately never built one, and this migration does not either. See 0108.';
