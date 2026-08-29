-- ============================================================================
-- 0430 — get_salary_tds_estimate becomes regime-aware; Sec 87A marginal
-- relief added to it and to get_form16_partb
-- ============================================================================
-- THE BUG, CONFIRMED LIVE BEFORE WRITING A LINE HERE. pg_get_functiondef on
-- public.get_salary_tds_estimate (today, before this migration) showed
-- exactly what 0093's own header already flagged as a known-open gap: every
-- employee, regardless of what employee_tax_declarations (0093) says, is
-- taxed on new-regime slabs, a flat Rs 75,000 standard deduction, the
-- Rs 60,000/Rs 12,00,000 new-regime Sec 87A rebate, and the new-regime
-- (25%-capped) surcharge bands — unconditionally. get_form16_partb (0205)
-- already reads employee_tax_declarations correctly and taxes an old-regime
-- employee on the RIGHT basis, but only at year-end, when the certificate is
-- generated. In between, every one of that employee's 11 (or 12) monthly Sec
-- 192 estimates — the number get_payroll_run (0075) actually deducts from
-- net pay and posts to TDS Payable when payroll runs — is computed on the
-- wrong regime's slabs. For an old-regime employee with real HRA/80C/80D/
-- 24(b) claims this typically over-withholds all year (old-regime standard
-- deduction is Rs 50,000 vs new-regime's Rs 75,000, and the old-regime
-- 30% slab starts at Rs 10,00,000 vs new-regime's Rs 24,00,000 — the SLAB
-- STRUCTURE ALONE, before even touching HRA/Chapter VI-A, already produces a
-- different monthly number for most incomes), corrected only in a lump at
-- Form 16 time. This migration makes get_salary_tds_estimate read the same
-- declaration get_form16_partb already reads and tax each employee on their
-- own declared regime's slabs/standard-deduction/rebate/surcharge — the same
-- four things 0205's own header already researched and hand-verified
-- (including the old-regime 37%-above-Rs-5-crore surcharge trap 0205's
-- header calls out by name). It does NOT extend get_salary_tds_estimate to
-- HRA exemption, Chapter VI-A (80C/80D/24(b)) or Sec 192(2) previous-
-- employer facts — see SCOPE below, that boundary is deliberate, not an
-- oversight.
--
-- WHERE THE FIX GETS ITS REGIME/SLAB/SURCHARGE LOGIC FROM: get_form16_partb
-- (0205) itself, read fresh via pg_get_functiondef immediately before writing
-- this migration, not re-derived from memory or from 0026. Its old_taxed ->
-- old_slabbed(old_taxed) -> old_rebated -> old_final chain (Rs 50,000
-- standard deduction, ref_income_tax_slabs_old_regime, Rs 12,500/Rs 5,00,000
-- Sec 87A rebate, surcharge INCLUDING the 37% top slab above Rs 5 crore) and
-- its new_taxed -> new_slabbed -> new_rebated -> new_final chain (Rs 75,000
-- standard deduction, ref_income_tax_slabs, Rs 60,000/Rs 12,00,000 rebate,
-- surcharge capped at 25%) are copied into get_salary_tds_estimate verbatim,
-- as two parallel CTE arms (one per regime) that are UNION ALL'd back
-- together at the end — not a single merged CASE expression, so each arm
-- stays a direct, checkable copy of 0205's own already-verified formula
-- rather than a fresh, error-prone merge of the two.
--
-- WHICH REGIME APPLIES, AND FOR WHICH FINANCIAL YEAR. get_salary_tds_estimate
-- takes p_period_month, not a financial-year label, so this migration derives
-- the Apr-Mar FY label from p_period_month the same way get_form16_partb's
-- own page (app/(app)/[companyId]/reports/form16-partb/page.tsx,
-- currentFinancialYearLabel()) and employee_tax_declarations' own CHECK
-- ('^\d{4}-\d{2}$') already assume — a FIXED April boundary, not the
-- company's own configurable book financial_year_start_month
-- (companies.financial_year_start_month, read by app_private.fy_label/
-- fy_start_date elsewhere in this codebase for GST/book-period purposes).
-- That is deliberate, not an oversight: Sec 192 withholding and the Circular
-- 4/2023 regime declaration are both governed by the STATUTORY income-tax
-- year, which is April-March regardless of what FY a company keeps its own
-- books on — get_form16_partb already made exactly this choice by hardcoding
-- April 1 rather than reading the company row, and this migration matches it
-- rather than introducing a second, inconsistent convention. Absent a
-- declaration for that FY, 'new' is the default — Circular 4/2023, exactly
-- as 0093 and get_form16_partb both already state: silence is not neutral,
-- it is itself the fact that sets the default.
--
-- ============================================================================
-- SEC 87A MARGINAL RELIEF — RESEARCHED FRESH FOR THIS MIGRATION, NOT CARRIED
-- OVER FROM 0049/0205'S OWN "NOT MODELLED" NOTE
-- ============================================================================
-- Both 0049 and 0205 say, in almost identical words, that marginal relief is
-- "not modelled" for either regime's rebate cliff. Live WebSearch today (26
-- Aug 2026), cross-checked across taxguru.in, cleartax.in, tax2win.in,
-- axismaxlife.com and a caclubindia FY 2026-27 worked-example piece, all
-- agreeing independently:
--
--   NEW REGIME (Sec 115BAC(1A)) — marginal relief EXISTS, and is REAL money.
--   A proviso inserted into Sec 87A by the Finance Act 2023 (effective FY
--   2023-24 onward, unchanged through the Rs 12,00,000/Rs 60,000 rebate
--   Budget 2025 introduced and Budget 2026 left alone) caps the tax payable,
--   for a taxpayer whose new-regime taxable income exceeds Rs 12,00,000, at
--   the amount by which income exceeds Rs 12,00,000 — so a taxpayer who
--   crosses the threshold by a small amount pays tax on only that small
--   excess, not the full slab-computed tax on their whole income. Formula
--   (agreeing across every source read, and matching this session's own
--   hand-worked check at Rs 12,10,000 income: slab tax Rs 61,500, excess
--   over threshold Rs 10,000, so relief = Rs 51,500 and tax payable
--   (pre-cess) = Rs 10,000 — exactly what taxguru.in's and cleartax.in's own
--   worked examples give):
--     rebate_87a = case
--       when taxable_income <= 12,00,000       -> least(tax_before_rebate, 60000)   [existing, unchanged]
--       when tax_before_rebate > (taxable_income - 12,00,000)
--                                               -> tax_before_rebate - (taxable_income - 12,00,000)
--       else                                    -> 0   [income far enough above 12L that slab tax alone
--                                                        is already below the excess — no relief needed]
--     end
--   Cess (4%) is applied AFTER marginal relief, on the relieved tax figure,
--   exactly as it already is on every other tax figure in both functions —
--   the marginal-relief comparison itself (tax_before_rebate vs the rupee
--   excess over Rs 12,00,000) is a pre-cess comparison, confirmed by every
--   worked example read (Rs 12,10,000 income -> Rs 10,000 tax -> Rs 10,400
--   with cess, not Rs 10,000 flat).
--
--   OLD REGIME — NO MARGINAL RELIEF. NOT AN OVERSIGHT, A GENUINE FEATURE OF
--   THE LAW. The Finance Act 2023 proviso above is written against Sec
--   115BAC(1A) specifically — the NEW regime. The ORIGINAL Sec 87A rebate
--   (Rs 12,500 up to Rs 5,00,000 total income, in force since FY 2019-20 for
--   whichever taxpayer is on the old regime) carries no such proviso and
--   never has. Multiple sources confirm this explicitly and in the same
--   words ("no graduated marginal relief," "a cliff structure," "cross
--   Rs 5,00,000 by even one rupee and the entire rebate disappears in one
--   go") — this is the well-known, often-criticised old-regime cliff, not a
--   gap this codebase introduced. Both get_salary_tds_estimate's old-regime
--   arm and get_form16_partb's own old_rebated CTE already compute exactly
--   this hard cliff (case when old_taxable_income <= 500000 then
--   least(old_tax_before_rebate, 12500) else 0 end) — that formula is LEFT
--   UNCHANGED by this migration; only its comment/documentation now says so
--   explicitly rather than leaving it looking like an unfinished "not
--   modelled yet" gap.
--
--   OUT OF SCOPE, STATED EXPLICITLY: SURCHARGE marginal relief (the
--   completely separate Finance-Act provision smoothing the surcharge
--   bands themselves — e.g. at Rs 50 lakh/Rs 1 crore/Rs 2 crore/Rs 5 crore
--   income crossing a surcharge slab) is a DIFFERENT provision from Sec 87A
--   rebate marginal relief and is NOT touched here — this task's brief named
--   Sec 87A marginal relief specifically, and both functions' surcharge
--   bands were already hand-verified (0205) as flat CASE steps with no
--   smoothing, a pre-existing and separate simplification this migration
--   does not extend or fix. The Sec 87A rebate itself also does not apply to
--   income taxed at special rates under Sec 111A/112/112A (capital gains) —
--   irrelevant here since neither function models any income head besides
--   salary, which is always taxed at slab rates, so this carve-out has no
--   effect on either function and is not implemented.
--
-- SCOPE OF THE get_salary_tds_estimate FIX, STATED EXPLICITLY: this
-- migration brings get_salary_tds_estimate's SLAB STRUCTURE, STANDARD
-- DEDUCTION, SEC 87A REBATE (with marginal relief) AND SURCHARGE to the
-- employee's own declared regime. It does NOT add HRA exemption, Chapter
-- VI-A deductions (80C/80D/24(b)) or Sec 192(2) previous-employer netting to
-- the MONTHLY estimate — those stay get_form16_partb's job, exactly as
-- 0093's own header already drew this line ("the future computation engine
-- would need those facts added" — meaning a full annual computation like
-- Form 16 Part B, not the monthly running estimate). Modelling those in the
-- monthly estimate too is real, separate, deliberately deferred work — see
-- the migration's own scope_deferred note in the accompanying report, not
-- silently done here under a name that only promised regime-correct
-- slabs/deduction/rebate/surcharge.
--
-- WHY get_salary_tds_estimate IS DROPPED AND RECREATED RATHER THAN CREATE OR
-- REPLACE'D IN PLACE. This migration adds one new output column
-- (regime_used text) so the payroll register and any future consumer can
-- show which regime actually drove the number shown — genuinely useful
-- given the whole point of this fix is that the regime now varies per
-- employee. PostgreSQL's CREATE OR REPLACE FUNCTION only allows adding new
-- OUT parameters at the end for functions declared with OUT parameters
-- directly; the safe, unambiguous way to add a column to a RETURNS TABLE
-- function is DROP FUNCTION then CREATE FUNCTION, so that is what this
-- migration does — followed immediately by the mandatory revoke/grant pair,
-- since a DROP resets grants and this project has been bitten by a missing
-- post-DROP grant before. get_form16_partb's own signature is unchanged (the
-- marginal-relief fix is purely an internal CTE change), so it is a plain
-- CREATE OR REPLACE.
--
-- CALLERS CHECKED BEFORE THIS CHANGE, LIVE, NOT FROM MEMORY: get_payroll_run
-- (0075) calls get_salary_tds_estimate and selects only t.employee_id,
-- t.monthly_tds by name — unaffected by the new trailing column or by the
-- corrected number itself flowing through (that IS the fix taking effect,
-- not a side effect to guard against). /reports/payroll-register and
-- /reports/tds-return-24q both read get_salary_tds_estimate/get_payroll_run
-- output by column name only — no positional access anywhere in either page.
-- payroll-register's own explainer text is updated by this same change
-- (see caveats_for_integration) since it previously stated, correctly at the
-- time, that the estimate was new-regime-only; tds-return-24q's Annexure
-- I/II copy makes the same now-stale claim but is NOT edited here — it is
-- outside this task's named ownership (get_salary_tds_estimate/
-- get_form16_partb and THEIR OWN report pages only) and touching it risked a
-- collision with whichever concurrent task in this batch owns TDS-return
-- prep. Flagged instead in the integration report.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- get_salary_tds_estimate — regime-aware Sec 192 monthly TDS estimate.
-- ----------------------------------------------------------------------------
drop function if exists public.get_salary_tds_estimate(uuid, date);

create function public.get_salary_tds_estimate(
  p_company_id uuid,
  p_period_month date
) returns table (
  employee_id uuid,
  employee_name text,
  monthly_gross numeric,
  annual_projected_gross numeric,
  regime_used text,
  standard_deduction numeric,
  taxable_salary_income numeric,
  annual_tax numeric,
  monthly_tds numeric
)
language sql
stable
set search_path = ''
as $$
  with period as (
    select date_trunc('month', p_period_month)::date as period_start
  ),
  fy as (
    select
      (case when extract(month from p.period_start)::int >= 4
            then extract(year from p.period_start)::int
            else extract(year from p.period_start)::int - 1
       end) as fy_start_year
      from period p
  ),
  fy_label as (
    select fy_start_year::text || '-' || lpad(((fy_start_year + 1) % 100)::text, 2, '0') as label
      from fy
  ),
  latest_structure as (
    select distinct on (s.employee_id)
      s.employee_id, s.basic, s.dearness_allowance, s.hra, s.special_allowance, s.other_allowance
      from public.employee_salary_structures s
      join public.employees e on e.id = s.employee_id
      cross join period p
     where e.company_id = p_company_id
       and s.effective_from <= p.period_start
     order by s.employee_id, s.effective_from desc
  ),
  -- Circular 4/2023: silence is not neutral, it defaults to 'new' — same
  -- coalesce get_form16_partb's own `facts` CTE already applies.
  projected as (
    select
      e.id as employee_id,
      e.name as employee_name,
      (ls.basic + ls.dearness_allowance + ls.hra + ls.special_allowance + ls.other_allowance) as monthly_gross,
      (ls.basic + ls.dearness_allowance + ls.hra + ls.special_allowance + ls.other_allowance) * 12 as annual_projected_gross,
      coalesce(d.regime, 'new') as regime_used
      from public.employees e
      join latest_structure ls on ls.employee_id = e.id
      cross join fy_label fl
      left join public.employee_tax_declarations d
        on d.employee_id = e.id
       and d.company_id = p_company_id
       and d.financial_year_label = fl.label
      cross join period p
     where e.company_id = p_company_id
       and e.date_of_joining <= (p.period_start + interval '1 month - 1 day')::date
       and (e.date_of_leaving is null or e.date_of_leaving >= p.period_start)
       and e.is_active
  ),

  -- OLD REGIME ARM — Rs 50,000 standard deduction, ref_income_tax_slabs_old_
  -- regime, Sec 87A rebate up to Rs 12,500 for taxable income <= Rs 5,00,000
  -- with NO marginal relief (a genuine hard cliff in the law — see header),
  -- surcharge including the 37%-above-Rs-5-crore top slab. Every expression
  -- below is copied from get_form16_partb's own old_taxed/old_slabbed(as
  -- old_taxed)/old_rebated/old_final chain (0205), not re-derived.
  old_taxed as (
    select
      p.*,
      50000::numeric as standard_deduction,
      greatest(p.annual_projected_gross - 50000, 0) as taxable_salary_income
      from projected p
     where p.regime_used = 'old'
  ),
  old_slabbed as (
    select
      t.*,
      coalesce((
        select sum(greatest(least(t.taxable_salary_income, s.to_rupees) - s.from_rupees + 1, 0) * s.rate_percent / 100)
          from public.ref_income_tax_slabs_old_regime s
         where s.from_rupees <= t.taxable_salary_income
      ), 0) as tax_before_rebate
      from old_taxed t
  ),
  old_rebated as (
    select
      s.*,
      case when s.taxable_salary_income <= 500000
           then least(s.tax_before_rebate, 12500)
           else 0 end as rebate_87a
      from old_slabbed s
  ),
  old_final as (
    select
      r.*,
      (r.tax_before_rebate - r.rebate_87a) as tax_after_rebate,
      round(
        (r.tax_before_rebate - r.rebate_87a) * (
          case
            when r.taxable_salary_income <= 5000000 then 0
            when r.taxable_salary_income <= 10000000 then 0.10
            when r.taxable_salary_income <= 20000000 then 0.15
            when r.taxable_salary_income <= 50000000 then 0.25
            else 0.37
          end
        ), 2
      ) as surcharge
      from old_rebated r
  ),

  -- NEW REGIME ARM — Rs 75,000 standard deduction, ref_income_tax_slabs, Sec
  -- 87A rebate up to Rs 60,000 for taxable income <= Rs 12,00,000 WITH
  -- marginal relief above that threshold (Finance Act 2023 proviso to Sec
  -- 87A — see header), surcharge capped at 25% (no 37% slab above Rs 5
  -- crore under the new regime, Budget 2023). Slab/surcharge expressions
  -- copied from get_form16_partb's own new_taxed/new_slabbed(as new_taxed)/
  -- new_final chain (0205); the rebate CASE is the one expression genuinely
  -- new here (and mirrored into get_form16_partb's own new_rebated below).
  new_taxed as (
    select
      p.*,
      75000::numeric as standard_deduction,
      greatest(p.annual_projected_gross - 75000, 0) as taxable_salary_income
      from projected p
     where p.regime_used = 'new'
  ),
  new_slabbed as (
    select
      t.*,
      coalesce((
        select sum(greatest(least(t.taxable_salary_income, s.to_rupees) - s.from_rupees + 1, 0) * s.rate_percent / 100)
          from public.ref_income_tax_slabs s
         where s.from_rupees <= t.taxable_salary_income
      ), 0) as tax_before_rebate
      from new_taxed t
  ),
  new_rebated as (
    select
      s.*,
      case
        when s.taxable_salary_income <= 1200000
          then least(s.tax_before_rebate, 60000)
        when s.tax_before_rebate > (s.taxable_salary_income - 1200000)
          then s.tax_before_rebate - (s.taxable_salary_income - 1200000)
        else 0
      end as rebate_87a
      from new_slabbed s
  ),
  new_final as (
    select
      r.*,
      (r.tax_before_rebate - r.rebate_87a) as tax_after_rebate,
      round(
        (r.tax_before_rebate - r.rebate_87a) * (
          case
            when r.taxable_salary_income <= 5000000 then 0
            when r.taxable_salary_income <= 10000000 then 0.10
            when r.taxable_salary_income <= 20000000 then 0.15
            else 0.25
          end
        ), 2
      ) as surcharge
      from new_rebated r
  ),

  combined as (
    select employee_id, employee_name, monthly_gross, annual_projected_gross, regime_used,
           standard_deduction, taxable_salary_income, tax_after_rebate, surcharge
      from old_final
     union all
    select employee_id, employee_name, monthly_gross, annual_projected_gross, regime_used,
           standard_deduction, taxable_salary_income, tax_after_rebate, surcharge
      from new_final
  )
  select
    employee_id, employee_name, monthly_gross, annual_projected_gross, regime_used,
    standard_deduction, taxable_salary_income,
    round((tax_after_rebate + surcharge) * 1.04, 2) as annual_tax,
    round((tax_after_rebate + surcharge) * 1.04 / 12, 2) as monthly_tds
    from combined
   order by employee_name;
$$;

revoke all on function public.get_salary_tds_estimate(uuid, date) from public, anon;
grant execute on function public.get_salary_tds_estimate(uuid, date) to authenticated;

comment on function public.get_salary_tds_estimate is
  'Sec 192 TDS-on-salary ESTIMATE per employee, REGIME-AWARE as of this migration: reads employee_tax_declarations (0093) for the Apr-Mar financial year containing p_period_month and taxes each employee on their OWN declared regime''s slabs (ref_income_tax_slabs / ref_income_tax_slabs_old_regime), standard deduction (Rs 75,000 new / Rs 50,000 old), Sec 87A rebate WITH marginal relief (new regime only — Finance Act 2023 proviso; old regime is a genuine hard cliff at Rs 5,00,000, no relief in the law) and surcharge (old regime keeps the 37%-above-Rs-5-crore top slab the new regime does not have). Absent a declaration, defaults to new regime per Circular 4/2023. Still does NOT model HRA exemption, Chapter VI-A deductions (80C/80D/24(b)) or Sec 192(2) previous-employer netting — that remains get_form16_partb''s (0205) job; this is a starting estimate for a human to adjust, not an authoritative Sec 192 computation. Does not deduct from net pay itself or post anywhere on its own — get_payroll_run (0075) and post_payroll_run consume its monthly_tds. See this migration''s header for the full research trail.';


-- ----------------------------------------------------------------------------
-- get_form16_partb — add Sec 87A marginal relief to the NEW-regime rebate.
-- The old-regime rebate (old_rebated) is UNCHANGED: a hard cliff at
-- Rs 5,00,000 is the correct law, not a gap (see this migration's header).
-- Every other CTE, column, and the surrounding side-by-side both-regimes
-- structure is untouched.
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
  -- Old regime: no marginal relief — a genuine hard cliff, unchanged by this
  -- migration. See the migration header for the researched reason.
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
  -- New regime: Sec 87A marginal relief added by this migration (Finance
  -- Act 2023 proviso — see header). Below Rs 12,00,000 the full-rebate
  -- branch is unchanged; above it, tax is capped at the excess of income
  -- over Rs 12,00,000 rather than dropping the rebate to zero outright.
  new_rebated as (
    select
      nt.*,
      case
        when nt.new_taxable_income <= 1200000
          then least(nt.new_tax_before_rebate, 60000)
        when nt.new_tax_before_rebate > (nt.new_taxable_income - 1200000)
          then nt.new_tax_before_rebate - (nt.new_taxable_income - 1200000)
        else 0
      end as new_rebate_87a
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
  'Form 16 Part B (Form 130 Part C from FY 2026-27 — see 0205 header) for one employee/FY: annual salary summed from get_payroll_run (0075) across the FY''s 12 months, the employee''s Sec 115BAC(1A) declaration (employee_tax_declarations, 0093, "not declared" defaults to new regime per Circular 4/2023), and a full BOTH-REGIMES tax computation (old regime: HRA exemption + Sec 71(3A)-capped 24(b) house-property set-off + Chapter VI-A 80C/80D, ref_income_tax_slabs_old_regime, Sec 87A rebate as a hard cliff at Rs 5,00,000 — no marginal relief exists in the law for the old regime; new regime: standard deduction only, ref_income_tax_slabs, Sec 87A rebate WITH marginal relief above Rs 12,00,000 per the Finance Act 2023 proviso, added by this migration). net_tax_payable selects whichever regime the employee actually declared. Perquisites always 0 (not captured by this schema — not a confirmed absence); statutory bonus and exit gratuity/leave encashment are not included in gross_salary. See 0205 for the full statutory citation trail and this migration for the marginal-relief research.';
