-- ============================================================================
-- 0205 — Form 16 Part B (Form 130 Part C from FY 2026-27): the employer-
-- prepared salary/tax annexure
-- ============================================================================
-- SCOPE, STATED UP FRONT. Form 16 has two halves and this migration builds
-- exactly one of them. Part A (deductor/deductee summary + challan detail)
-- and Form 16A/27D are TRACES-generated documents carrying TRACES' own
-- digital signature — a software lookalike would not be a valid TDS
-- certificate, only a look-alike of one, so LEKHA does not attempt them, the
-- same "we do not forge a government-signed document" line 0119 already drew
-- around eBRC and every TRACES-gated report before it. Part B is different:
-- it is the EMPLOYER's own computation — gross salary, exemptions, Chapter
-- VI-A deductions, tax thereon — fully derivable from data this app already
-- owns (payroll postings, the employee's own Sec 115BAC(1A) declaration).
-- That is the one this migration builds.
--
-- THE NAME CHANGES MID-STREAM, AND THIS IS THE GENUINE, RESEARCHED REASON
-- get_form16_partb's own UI does not just say "Form 16" unconditionally.
-- Fresh WebSearch today (26 Aug 2026), not carried over from training data:
--   * TDS on salary itself moves from Sec 192 (Income-tax Act 1961) to
--     Sec 392 of the Income-tax Act 2025, in force 1 Apr 2026 — confirmed
--     independently by ClearTax's, TaxHeal's and eztax's own "Section 392"
--     explainers, all read today, all agreeing (cleartax.in/s/section-392-
--     income-tax-act-2025, taxheal.com). Salary PAID before 1 Apr 2026
--     stays under the old Act's Sec 192; the boundary is the PAYMENT date,
--     i.e. which financial year the salary belongs to, exactly the axis
--     get_form16_partb's own p_financial_year_label already carries.
--   * Form 16 ITSELF is renamed and restructured, not just recodified.
--     Under the Income-tax Act 2025 (Sec 395(4)(a)), the salary TDS
--     certificate becomes FORM NO. 130 — confirmed via TaxGuru's, ClearTax's
--     and the Income Tax Department's own Form-130-FAQ page
--     (incometaxindia.gov.in/documents/d/guest/form-130-faqs), all read
--     today. Crucially the INTERNAL SHAPE changes too: Form 130 has three
--     parts, not two — Part A (deductor/deductee identity), Part B (a
--     HIGH-LEVEL summary: total income credited, total tax deducted — a
--     one-line figure, not a computation), and PART C (the detailed
--     salary/exemption/deduction/tax annexure — what the OLD Form 16 called
--     "Part B"). The content this migration builds — the full computation
--     — therefore maps to Form 130's PART C, not its Part B, for any FY
--     from 2026-27 onward. get_form16_partb keeps its name (matching the
--     task's own naming, and because "Form 16" is still what every
--     employer, employee and search query calls this document colloquially,
--     Form 130 being five weeks old at the time of writing) but its
--     form_label output column says the right thing for the FY asked about
--     — "Form 16 Part B" for FY 2025-26 and earlier (still governed by the
--     1961 Act — salary paid entirely before 1 Apr 2026), "Form 130 Part C"
--     for FY 2026-27 onward. Getting this wrong in either direction would
--     be exactly the kind of "obvious answer, revised without most sources
--     catching up yet" mistake 0119's FEMA timeline and the 24Q page's own
--     24Q->138 renumbering already had to work through.
--
-- THE OLD-REGIME TAX ENGINE THIS MIGRATION ADDS — AND WHY THE 24Q PAGE
-- DELIBERATELY DID NOT BUILD THIS ITSELF. /reports/tds-return-24q's own
-- Annexure II (read in full before writing this migration, per the task
-- brief) shows an old-regime employee's declaration facts next to a big
-- warning that the annual gross/TDS columns are STILL get_salary_tds_
-- estimate's new-regime-only projection, because — its own words — "LEKHA
-- has no old-regime slab/deduction computation engine at all." That gap is
-- exactly what get_form16_partb below closes, for exactly the reason 0093
-- itself anticipated it would eventually need to: "the future computation
-- engine would need those [...] facts added" (0093, on HRA) and "the future
-- computation... is the right place to enforce them, with the facts... in
-- hand that a CHECK constraint never will be" (0093, on 24(b) and 80D).
-- Form 16 Part B is that future computation. It does NOT touch 24Q's own
-- page or get_salary_tds_estimate/get_payroll_run — those keep computing
-- exactly what they already compute (a new-regime Sec 192 withholding
-- ESTIMATE for the monthly deduction itself); this migration is a
-- DIFFERENT, ANNUAL, REGIME-AWARE computation that reads the same
-- get_payroll_run facts but taxes them correctly under whichever regime the
-- employee actually declared.
--
-- WHERE THE ANNUAL SALARY NUMBERS COME FROM, AND WHY NOT get_salary_tds_
-- estimate's OWN PROJECTION. get_salary_tds_estimate annualises ONE month's
-- structure x 12 — a fine approximation for a monthly withholding estimate,
-- a bad one for an annual certificate covering an employee who joined,
-- left, or had a salary revision mid-year. get_form16_partb instead calls
-- get_payroll_run (0075) once per calendar month of the financial year and
-- sums the ACTUAL prorated figures it already computes correctly (days-paid
-- proration, mid-year revisions via each month's own latest_structure
-- lookup) — the same pattern /reports/tds-return-24q's own Annexure II
-- already established for exactly this reason, reused here rather than
-- reinvented.
--
-- INHERITED LIMITATION, NOT A NEW ONE: get_payroll_run's own WHERE clause
-- requires e.is_active = true for ANY month's row to appear at all — an
-- employee who has since left AND been deactivated shows ZERO months of
-- salary here, even for months they were genuinely employed and paid. This
-- is get_payroll_run's own long-standing behaviour (unchanged by this
-- migration, and already inherited silently by 24Q's Annexure II before
-- it) — flagged here explicitly because Form 16 Part B is disproportionately
-- likely to be requested for an employee who has since exited.
--
-- THE OLD-REGIME COMPUTATION ITSELF — every rate/cap re-confirmed by live
-- WebSearch today for FY 2026-27 (AY 2027-28), Budget 2026 (1 Feb 2026)
-- changed none of it (multiple sources agree: bankbazaar.com, axismaxlife.
-- com, indiapost.org "income tax slab" pages, all read today):
--   Slabs (general/non-senior only — see the age caveat below): 0-2,50,000
--     nil, 2,50,001-5,00,000 5%, 5,00,001-10,00,000 20%, above 10,00,000
--     30%. Seeded into ref_income_tax_slabs_old_regime below, mirroring
--     ref_income_tax_slabs' own (new-regime) table shape from 0026, rather
--     than a magic CASE buried in this one function — a future consumer
--     (a standalone individual ITR-old-regime computation, say) can reuse
--     it the same way ref_income_tax_slabs already gets reused three times.
--   Standard deduction: Rs 50,000 (old regime), unchanged since FY 2019-20,
--     re-confirmed live, distinct from the Rs 75,000 new-regime figure
--     0049 already encodes and this migration does not touch.
--   Sec 16(iii) professional tax: deductible from salary income ONLY under
--     the old regime (confirmed live — new regime "strips out... HRA, LTA,
--     80C, 80D and Professional Tax", multiple 115BAC explainers agreeing).
--     PT actually paid this FY (from get_payroll_run's own professional_tax
--     column, correctly zeroed for a no-pay month per 0075) is deducted
--     here for the old-regime column only.
--   Sec 10(13A) HRA exemption: the employee's own CLAIMED figure
--     (employee_tax_declarations.hra_exemption_claimed, 0093) used
--     directly, exactly as 0093's own comment already stated this table
--     would be consumed — "the amount the employee is CLAIMING," not
--     independently recomputed from rent/city/HRA-drawn facts this schema
--     was never asked to capture. Old regime only; new-regime rows are
--     already constrained to 0 here by 0093's own CHECK.
--   Sec 24(b) home loan interest + Sec 71(3A) set-off cap: 0093 explicitly
--     declined to CHECK-constrain deduction_home_loan_interest_24b at the
--     data layer because "a CHECK cannot tell a self-occupied home loan
--     from a let-out one... enforcing the self-occupied [Rs 2,00,000]
--     number as a blanket ceiling would silently reject a legitimate
--     let-out claim." This computation does not repeat that mistake by
--     capping the deduction itself at Rs 2,00,000. Instead it applies the
--     cap that genuinely IS universal regardless of self-occupied/let-out
--     status: Sec 71(3A) (Finance Act 2017) caps how much of a HOUSE
--     PROPERTY LOSS can be SET OFF AGAINST OTHER HEADS (salary, here) in
--     the same year at Rs 2,00,000, for every property type alike — the
--     excess is carried forward against future house-property income only,
--     confirmed independently by livelaw.in's Delhi HC ruling coverage,
--     taxbuddy.com and patronaccounting.com, all read today, all agreeing
--     on both the amount and the "regardless of property type" scope. This
--     app does not track house-property income directly (only the interest
--     claim), so the full claimed interest is treated as the house-property
--     LOSS, and Rs 2,00,000 of it is what Sec 71(3A) allows to reduce
--     salary income THIS YEAR — carry-forward of any excess into a future
--     year is explicitly NOT modelled (this app has no multi-year loss
--     ledger for individuals, the same honest gap 0078's own income-tax-
--     loss carry-forward work drew for business income, not personal).
--   Sec 80C: capped at Rs 1,50,000, unchanged, re-confirmed live (now
--     Sec 123 read with Schedule XV of the Income-tax Act 2025, effective
--     1 Apr 2026 — cited for completeness, this computation still cites the
--     well-known old-Act number in its own column names since that is what
--     both employer and employee say and search for).
--   Sec 80D: THE ONE CAP THIS MIGRATION DELIBERATELY DOES NOT GET EXACT,
--     STATED PLAINLY RATHER THAN GUESSED. The real cap is age-dependent —
--     Rs 25,000 (self/family, non-senior) or Rs 50,000 (self/family,
--     senior, 60+) PLUS Rs 25,000/Rs 50,000 for parents on the same test —
--     confirmed live, multiple sources agreeing the combined maximum
--     across every age combination is Rs 1,00,000/year. employees (0043)
--     has no date-of-birth column at all, so this schema cannot tell a
--     30-year-old from a 65-year-old. Rather than silently apply the
--     lowest (non-senior) cap — which would UNDER-compute a legitimate
--     senior citizen's real deduction and overstate their tax — this
--     computation applies the outer statutory bound (Rs 1,00,000) and
--     states the imprecision here and in the report UI: a claim between
--     the age-correct cap and Rs 1,00,000 is not independently verified as
--     valid by this app. The same "apply what the data can support,
--     disclose what it can't" choice 0093 itself made for the identical
--     reason on this identical field.
--   Sec 87A rebate: taxable income <= Rs 5,00,000 -> full rebate up to
--     Rs 12,500 (old regime) — re-confirmed live, unchanged. New regime
--     keeps 0049's own Rs 60,000-up-to-Rs-12,00,000 figure, unmodified
--     here. No marginal-relief taper is modelled for either regime's
--     rebate cliff — 0049's OWN documented simplification for the new
--     regime, extended here to the old regime for the same reason (a
--     genuinely separate, larger piece of work), not a new gap this
--     migration introduces.
--   Surcharge: OLD regime keeps the full band structure INCLUDING THE 37%
--     TOP SLAB (>Rs 5 crore) that the NEW regime does not have — Budget
--     2023 capped new-regime surcharge at 25% even above Rs 5 crore, but
--     that cap is new-regime-only; old regime's 37% slab survives,
--     re-confirmed live today (canarahsbclife.com, cleartax.in's own
--     marginal-relief page, both read today, both agreeing). Reusing
--     0049/0075's own new-regime surcharge CASE for the old-regime column
--     would have been a real, live-money error at the very top bracket —
--     exactly the kind of "looks like the same thing, isn't" mistake this
--     codebase's WebSearch discipline exists to catch.
--   Cess: 4% Health & Education cess on tax + surcharge, both regimes,
--     unchanged — matches 0049/0075's own new-regime figure exactly.
--
-- WHAT THE COMPARISON TABLE IS FOR. get_form16_partb computes BOTH regimes'
-- full outcomes side by side for every call, regardless of which one the
-- employee actually declared — common practice this task brief asked to
-- confirm, and genuinely useful for an employer deciding what to withhold
-- next year, not just this year's certificate. regime_used (the employee's
-- declaration, or 'new' by default absent one, per Circular 4/2023 exactly
-- as 0093 and the 24Q page already established) selects which column is the
-- REAL Sec 392/Sec 192 liability this certificate reports; the other column
-- is a what-if, not a second valid answer.
--
-- PERQUISITES: this schema has NO column, anywhere, for accommodation,
-- company car, ESOP, or any other perquisite u/s 17(2) — employee_salary_
-- structures carries only basic/DA/HRA/special/other cash components.
-- perquisites_value is returned as 0, which is honestly correct for the
-- overwhelming majority of salaried employees at this app's target SME
-- scale, but is NOT a confirmed "this employee has no perquisites" — an
-- employer who has actually extended one must add its value by hand before
-- relying on this certificate. Stated in the report UI, not silently
-- implied by the 0.
--
-- STATUTORY BONUS (0109) AND GRATUITY/LEAVE ENCASHMENT ON EXIT (0140) ARE
-- NOT INCLUDED in gross_salary here. Neither posts through get_payroll_run
-- — bonus is a separate voucher, gratuity/leave encashment flow through
-- employee_exit_settlements — so summing get_payroll_run alone, as this
-- migration does, will UNDERSTATE the true annual salary for an employee
-- who received either during the FY. Folding both in correctly (bonus is
-- fully taxable; gratuity is exempt u/s 10(10) up to Rs 20,00,000 for a
-- covered employee; leave encashment is exempt u/s 10(10AA) with its own,
-- different formula/cap) is real, separate scope this task does not cover
-- — flagged here rather than silently producing an understated certificate
-- for exactly the population (recent exits) most likely to have both.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- ref_income_tax_slabs_old_regime — mirrors ref_income_tax_slabs' (0026)
-- own shape for the individual/HUF OLD regime, general (non-senior) rates
-- only — see the header's Sec 80D-style caveat: employees (0043) has no
-- date-of-birth column, so a senior/super-senior citizen's higher basic
-- exemption (Rs 3,00,000 / Rs 5,00,000) cannot be applied. Every employee
-- is taxed on the general slab here; stated in the report UI, not silently
-- assumed to be correct for a taxpayer this app cannot identify as senior.
-- ----------------------------------------------------------------------------
create table public.ref_income_tax_slabs_old_regime (
  from_rupees numeric(18,2) not null,
  to_rupees numeric(18,2) not null,
  rate_percent numeric(5,2) not null check (rate_percent >= 0 and rate_percent <= 100),
  sort_order smallint not null,
  constraint ref_income_tax_slabs_old_regime_range_valid check (to_rupees >= from_rupees)
);

comment on table public.ref_income_tax_slabs_old_regime is
  'Sec 115BAC(1A) OLD-regime slabs for individuals/HUF, general (non-senior) rates, FY 2026-27 (AY 2027-28) — re-confirmed by live WebSearch, unchanged by Budget 2026. Senior (60-79, Rs 3,00,000 exemption) and super-senior (80+, Rs 5,00,000) bands are NOT seeded: employees (0043) has no date-of-birth column, so this app cannot tell which slab applies. See 0205 for the full citation trail.';

insert into public.ref_income_tax_slabs_old_regime (from_rupees, to_rupees, rate_percent, sort_order) values
  (0,       250000,        0,  10),
  (250001,  500000,        5,  20),
  (500001,  1000000,      20,  30),
  (1000001, 999999999999, 30,  40)
;

alter table public.ref_income_tax_slabs_old_regime enable row level security;
create policy ref_income_tax_slabs_old_regime_read on public.ref_income_tax_slabs_old_regime
  for select to authenticated using (true);


-- ----------------------------------------------------------------------------
-- get_form16_partb — see the migration header in full for the statutory
-- research behind every figure below.
-- ----------------------------------------------------------------------------
create or replace function public.get_form16_partb(
  p_company_id uuid,
  p_employee_id uuid,
  p_financial_year_label text
)
returns table (
  employee_id uuid,
  employee_name text,
  pan text,
  financial_year_label text,
  period_from date,
  period_to date,
  is_fy_complete boolean,
  form_label text,
  months_with_payroll_data integer,
  basic_total numeric,
  dearness_allowance_total numeric,
  hra_total numeric,
  special_allowance_total numeric,
  other_allowance_total numeric,
  gross_salary numeric,
  perquisites_value numeric,
  professional_tax_total numeric,
  declaration_exists boolean,
  declared_regime text,
  regime_used text,
  declaration_date date,
  hra_exemption_claimed numeric,
  deduction_80c_claimed numeric,
  deduction_80c_allowed numeric,
  deduction_80d_claimed numeric,
  deduction_80d_allowed numeric,
  home_loan_interest_24b_claimed numeric,
  home_loan_interest_24b_allowed numeric,
  previous_employer_income numeric,
  previous_employer_tds_deducted numeric,
  old_income_chargeable_salary numeric,
  old_gross_total_income numeric,
  old_chapter_via_deductions numeric,
  old_taxable_income numeric,
  old_tax_before_rebate numeric,
  old_rebate_87a numeric,
  old_surcharge numeric,
  old_cess numeric,
  old_net_tax_payable numeric,
  new_income_chargeable_salary numeric,
  new_taxable_income numeric,
  new_tax_before_rebate numeric,
  new_rebate_87a numeric,
  new_surcharge numeric,
  new_cess numeric,
  new_net_tax_payable numeric,
  net_tax_payable numeric,
  tds_deposited_per_payroll_projection numeric
)
language sql
stable
set search_path = ''
as $fn$
  with params as (
    select
      make_date(split_part(p_financial_year_label, '-', 1)::int, 4, 1) as period_start,
      (make_date(split_part(p_financial_year_label, '-', 1)::int + 1, 4, 1) - interval '1 day')::date as period_end,
      split_part(p_financial_year_label, '-', 1)::int as fy_start_year
    where p_financial_year_label ~ '^\d{4}-\d{2}$'
  ),
  months as (
    select generate_series(p.period_start, p.period_end, interval '1 month')::date as m
      from params p
  ),
  payroll as (
    select pr.*
      from months
      cross join lateral public.get_payroll_run(p_company_id, months.m) pr
     where pr.employee_id = p_employee_id
  ),
  agg as (
    select
      count(*)::int as months_with_data,
      coalesce(sum(basic), 0) as basic_total,
      coalesce(sum(dearness_allowance), 0) as da_total,
      coalesce(sum(hra), 0) as hra_total,
      coalesce(sum(special_allowance), 0) as special_total,
      coalesce(sum(other_allowance), 0) as other_total,
      coalesce(sum(gross_pay), 0) as gross_salary,
      coalesce(sum(professional_tax), 0) as pt_total,
      coalesce(sum(tds), 0) as tds_projection
      from payroll
  ),
  emp as (
    select id, name, pan
      from public.employees
     where id = p_employee_id and company_id = p_company_id
  ),
  decl as (
    select regime, declaration_date, deduction_80c, deduction_80d,
           hra_exemption_claimed, home_loan_interest_24b,
           previous_employer_income, previous_employer_tds_deducted
      from public.employee_tax_declarations
     where employee_id = p_employee_id
       and company_id = p_company_id
       and financial_year_label = p_financial_year_label
  ),
  facts as (
    select
      e.id as employee_id, e.name as employee_name, e.pan,
      p.period_start, p.period_end, p.fy_start_year,
      (p.period_end < current_date) as is_fy_complete,
      a.months_with_data, a.basic_total, a.da_total, a.hra_total, a.special_total, a.other_total,
      a.gross_salary, a.pt_total, a.tds_projection,
      (d.regime is not null) as declaration_exists,
      d.regime as declared_regime,
      coalesce(d.regime, 'new') as regime_used,
      d.declaration_date,
      coalesce(d.hra_exemption_claimed, 0) as hra_exemption_claimed,
      coalesce(d.deduction_80c, 0) as ded_80c_claimed,
      coalesce(d.deduction_80d, 0) as ded_80d_claimed,
      coalesce(d.home_loan_interest_24b, 0) as ded_24b_claimed,
      coalesce(d.previous_employer_income, 0) as prev_income,
      coalesce(d.previous_employer_tds_deducted, 0) as prev_tds
      from emp e
      cross join params p
      cross join agg a
      left join decl d on true
  ),
  capped as (
    select
      f.*,
      least(f.ded_80c_claimed, 150000) as ded_80c_allowed,
      least(f.ded_80d_claimed, 100000) as ded_80d_allowed,
      least(f.ded_24b_claimed, 200000) as ded_24b_allowed
      from facts f
  ),
  old_computed as (
    select
      c.*,
      greatest(c.gross_salary - c.hra_exemption_claimed - 50000 - c.pt_total, 0)
        as old_income_chargeable_salary,
      greatest(
        greatest(c.gross_salary - c.hra_exemption_claimed - 50000 - c.pt_total, 0) - c.ded_24b_allowed,
        0
      ) as old_gross_total_income,
      (c.ded_80c_allowed + c.ded_80d_allowed) as old_chapter_via_deductions
      from capped c
  ),
  old_taxable as (
    select
      o.*,
      greatest(o.old_gross_total_income - o.old_chapter_via_deductions, 0) as old_taxable_income
      from old_computed o
  ),
  old_taxed as (
    select
      ot.*,
      coalesce((
        select sum(greatest(least(ot.old_taxable_income, s.to_rupees) - s.from_rupees + 1, 0) * s.rate_percent / 100)
          from public.ref_income_tax_slabs_old_regime s
         where s.from_rupees <= ot.old_taxable_income
      ), 0) as old_tax_before_rebate
      from old_taxable ot
  ),
  old_rebated as (
    select
      ot2.*,
      case when ot2.old_taxable_income <= 500000
           then least(ot2.old_tax_before_rebate, 12500)
           else 0 end as old_rebate_87a
      from old_taxed ot2
  ),
  old_final as (
    select
      orb.*,
      (orb.old_tax_before_rebate - orb.old_rebate_87a) as old_tax_after_rebate,
      round(
        (orb.old_tax_before_rebate - orb.old_rebate_87a) * (
          case
            when orb.old_taxable_income <= 5000000 then 0
            when orb.old_taxable_income <= 10000000 then 0.10
            when orb.old_taxable_income <= 20000000 then 0.15
            when orb.old_taxable_income <= 50000000 then 0.25
            else 0.37
          end
        ), 2
      ) as old_surcharge
      from old_rebated orb
  ),
  old_done as (
    select
      of2.*,
      round((of2.old_tax_after_rebate + of2.old_surcharge) * 0.04, 2) as old_cess,
      round((of2.old_tax_after_rebate + of2.old_surcharge) * 1.04, 2) as old_net_tax_payable
      from old_final of2
  ),
  new_computed as (
    select
      od.*,
      greatest(od.gross_salary - 75000, 0) as new_income_chargeable_salary
      from old_done od
  ),
  new_taxed as (
    select
      nc.*,
      nc.new_income_chargeable_salary as new_taxable_income,
      coalesce((
        select sum(greatest(least(nc.new_income_chargeable_salary, s.to_rupees) - s.from_rupees + 1, 0) * s.rate_percent / 100)
          from public.ref_income_tax_slabs s
         where s.from_rupees <= nc.new_income_chargeable_salary
      ), 0) as new_tax_before_rebate
      from new_computed nc
  ),
  new_rebated as (
    select
      nt.*,
      case when nt.new_taxable_income <= 1200000
           then least(nt.new_tax_before_rebate, 60000)
           else 0 end as new_rebate_87a
      from new_taxed nt
  ),
  new_final as (
    select
      nr.*,
      (nr.new_tax_before_rebate - nr.new_rebate_87a) as new_tax_after_rebate,
      round(
        (nr.new_tax_before_rebate - nr.new_rebate_87a) * (
          case
            when nr.new_taxable_income <= 5000000 then 0
            when nr.new_taxable_income <= 10000000 then 0.10
            when nr.new_taxable_income <= 20000000 then 0.15
            else 0.25
          end
        ), 2
      ) as new_surcharge
      from new_rebated nr
  ),
  new_done as (
    select
      nf.*,
      round((nf.new_tax_after_rebate + nf.new_surcharge) * 0.04, 2) as new_cess,
      round((nf.new_tax_after_rebate + nf.new_surcharge) * 1.04, 2) as new_net_tax_payable
      from new_final nf
  )
  select
    nd.employee_id, nd.employee_name, nd.pan,
    p_financial_year_label,
    nd.period_start, nd.period_end, nd.is_fy_complete,
    case when nd.fy_start_year >= 2026
         then 'Form 130 Part C (salary annexure — the detailed computation the repealed 1961 Act called Form 16 Part B)'
         else 'Form 16 Part B' end as form_label,
    nd.months_with_data,
    nd.basic_total, nd.da_total, nd.hra_total, nd.special_total, nd.other_total,
    nd.gross_salary,
    0::numeric as perquisites_value,
    nd.pt_total,
    nd.declaration_exists, nd.declared_regime, nd.regime_used, nd.declaration_date,
    nd.hra_exemption_claimed,
    nd.ded_80c_claimed, nd.ded_80c_allowed,
    nd.ded_80d_claimed, nd.ded_80d_allowed,
    nd.ded_24b_claimed, nd.ded_24b_allowed,
    nd.prev_income, nd.prev_tds,
    nd.old_income_chargeable_salary, nd.old_gross_total_income, nd.old_chapter_via_deductions,
    nd.old_taxable_income, nd.old_tax_before_rebate, nd.old_rebate_87a, nd.old_surcharge, nd.old_cess,
    nd.old_net_tax_payable,
    nd.new_income_chargeable_salary, nd.new_taxable_income, nd.new_tax_before_rebate, nd.new_rebate_87a,
    nd.new_surcharge, nd.new_cess, nd.new_net_tax_payable,
    case when nd.regime_used = 'old' then nd.old_net_tax_payable else nd.new_net_tax_payable end as net_tax_payable,
    nd.tds_projection
    from new_done nd;
$fn$;

revoke all on function public.get_form16_partb(uuid, uuid, text) from public, anon;
grant execute on function public.get_form16_partb(uuid, uuid, text) to authenticated;

comment on function public.get_form16_partb(uuid, uuid, text) is
  'Form 16 Part B (Form 130 Part C from FY 2026-27 — see 0205 header) for one employee/FY: annual salary summed from get_payroll_run (0075) across the FY''s 12 months, the employee''s Sec 115BAC(1A) declaration (employee_tax_declarations, 0093, "not declared" defaults to new regime per Circular 4/2023), and a full BOTH-REGIMES tax computation (old regime: HRA exemption + Sec 71(3A)-capped 24(b) house-property set-off + Chapter VI-A 80C/80D, ref_income_tax_slabs_old_regime; new regime: standard deduction only, ref_income_tax_slabs). net_tax_payable selects whichever regime the employee actually declared. Perquisites always 0 (not captured by this schema — not a confirmed absence); statutory bonus and exit gratuity/leave encashment are not included in gross_salary. See 0205 for the full statutory citation trail and every caveat.';
