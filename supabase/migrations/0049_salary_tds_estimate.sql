-- ============================================================================
-- 0049 — Sec 192: TDS-on-salary estimate
-- ============================================================================
-- The last real Payroll gap flagged since 0043: net pay computed by
-- get_payroll_run and posted by post_payroll_run (0047) is gross minus
-- PF/ESI/PT only — no income tax withheld under Sec 192, even though every
-- employer is required to estimate and deduct it monthly.
--
-- ESTIMATE, NOT A DEDUCTION APPLIED ANYWHERE. get_salary_tds_estimate()
-- computes what Sec 192 requires the employer to estimate — annualised
-- salary income, less the standard deduction, taxed at slab rates, rebate
-- and surcharge applied, divided across the year — but does NOT touch
-- net_pay, does NOT get deducted anywhere, and does NOT create a TDS
-- Payable entry when payroll is posted (0047). This is deliberate: Sec 192
-- withholding depends on facts this schema has no way to know (whether the
-- employee has opted for the old regime under Sec 115BAC(1A), HRA
-- exemption computation against actual rent paid, Chapter VI-A
-- declarations — 80C/80D/80CCD, other income the employee has declared to
-- the employer under Sec 192(2B), tax already deducted by a previous
-- employer this year). Showing a number here that quietly excludes all of
-- that would be worse than showing nothing — an employer who wires this
-- estimate straight into payroll without adjusting for the employee's
-- actual declarations would over-withhold for nearly everyone with any
-- deduction at all. This is a starting estimate for a human to adjust, not
-- an authoritative Sec 192 computation, same "candidate, not final" framing
-- already used for Sec 40A(3)/40A(2)(b)/269SS/269T candidates.
--
-- NEW REGIME ONLY, same scope decision as 0026's own get_income_tax_
-- computation ("only regime modelled") — Sec 115BAC(1A) makes the new
-- regime the DEFAULT for salaried employees unless they specifically
-- declare the old regime to their employer, which this schema has no way
-- to record per employee. Reuses 0026's exact slab/rebate/surcharge/cess
-- formula (ref_income_tax_slabs, Sec 87A rebate up to Rs 60,000 for
-- taxable income up to Rs 12,00,000 with no marginal-relief taper modelled,
-- the same new-regime surcharge bands, 4% cess) against a SALARY-specific
-- taxable base rather than 0026's business-profit base — the two share the
-- same rate structure (both are ultimately Sec 115BAC individual slabs)
-- but a genuinely different starting number (annualised salary less
-- Rs 75,000 standard deduction, researched fresh — Budget 2024 raised it
-- from Rs 50,000, unchanged through AY 2026-27 and the following year),
-- not the PGBP bridge 0026 computes for a proprietor's business income.
--
-- ANNUALISATION IS A STEADY-STATE PROJECTION: this month's gross times 12,
-- the same "current structure, no proration" simplification
-- get_payroll_run itself already documents for mid-year joiners/leavers
-- and salary revisions — not a precise Sec 192(1) month-by-month
-- recompute against actual YTD income and tax already withheld.
-- ============================================================================

create or replace function public.get_salary_tds_estimate(
  p_company_id uuid,
  p_period_month date
) returns table (
  employee_id uuid,
  employee_name text,
  monthly_gross numeric,
  annual_projected_gross numeric,
  standard_deduction numeric,
  taxable_salary_income numeric,
  annual_tax numeric,
  monthly_tds numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with period as (
    select date_trunc('month', p_period_month)::date as period_start
  ),
  latest_structure as (
    select distinct on (s.employee_id)
      s.employee_id, s.basic, s.hra, s.special_allowance, s.other_allowance
      from public.employee_salary_structures s
      join public.employees e on e.id = s.employee_id
      cross join period p
     where e.company_id = p_company_id
       and s.effective_from <= p.period_start
     order by s.employee_id, s.effective_from desc
  ),
  projected as (
    select
      e.id as employee_id,
      e.name as employee_name,
      (ls.basic + ls.hra + ls.special_allowance + ls.other_allowance) as monthly_gross,
      (ls.basic + ls.hra + ls.special_allowance + ls.other_allowance) * 12 as annual_projected_gross
      from public.employees e
      join latest_structure ls on ls.employee_id = e.id
      cross join period p
     where e.company_id = p_company_id
       and e.date_of_joining <= (p.period_start + interval '1 month - 1 day')::date
       and (e.date_of_leaving is null or e.date_of_leaving >= p.period_start)
       and e.is_active
  ),
  taxed as (
    select
      employee_id, employee_name, monthly_gross, annual_projected_gross,
      75000::numeric as standard_deduction,
      greatest(annual_projected_gross - 75000, 0) as taxable_salary_income
      from projected
  ),
  slabbed as (
    select
      t.*,
      coalesce((
        select sum(greatest(least(t.taxable_salary_income, s.to_rupees) - s.from_rupees + 1, 0) * s.rate_percent / 100)
          from public.ref_income_tax_slabs s
         where s.from_rupees <= t.taxable_salary_income
      ), 0) as tax_before_rebate
      from taxed t
  ),
  rebated as (
    select
      s.*,
      case when s.taxable_salary_income <= 1200000 then least(s.tax_before_rebate, 60000) else 0 end as rebate_87a
      from slabbed s
  ),
  final as (
    select
      r.*,
      (r.tax_before_rebate - r.rebate_87a) as tax_after_rebate,
      (r.tax_before_rebate - r.rebate_87a) * (
        case
          when r.taxable_salary_income <= 5000000 then 0
          when r.taxable_salary_income <= 10000000 then 0.10
          when r.taxable_salary_income <= 20000000 then 0.15
          else 0.25
        end
      ) as surcharge
      from rebated r
  )
  select
    employee_id, employee_name, monthly_gross, annual_projected_gross,
    standard_deduction, taxable_salary_income,
    round((tax_after_rebate + surcharge) * 1.04, 2) as annual_tax,
    round((tax_after_rebate + surcharge) * 1.04 / 12, 2) as monthly_tds
    from final
   order by employee_name;
$$;

comment on function public.get_salary_tds_estimate is
  'Sec 192 TDS-on-salary ESTIMATE per employee, new regime only (Sec 115BAC is the default absent an employee declaration this schema cannot record): annualised gross (this month x 12, no proration) less the Rs 75,000 standard deduction, taxed at 0026''s own slab/rebate/surcharge/cess formula, divided by 12. Does not deduct from net pay, does not post anywhere, does not account for HRA exemption, Chapter VI-A declarations, other-employer TDS already withheld, or old-regime election — a starting number for a human to adjust, not an authoritative Sec 192 computation. See the migration header for the full scope.';
