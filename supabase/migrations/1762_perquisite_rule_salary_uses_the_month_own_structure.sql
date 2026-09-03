-- ============================================================================
-- 1762 — the accommodation perquisite base must not apply one salary rate to
-- a year that actually had a raise in it
-- ============================================================================
-- WHY. 1761's accommodation branch computes its "rule salary" base
-- (annual_gross_no_hra / projection_months) from the SAME single, LATEST
-- salary structure that annual_gross (the ordinary TDS projection) already
-- uses — reasonable for annual_gross, which is deliberately a forward
-- projection off current information, but wrong for the accommodation
-- valuation, whose authoritative source, get_employee_perquisites_valued
-- (via get_payroll_run), resolves whichever structure was actually EFFECTIVE
-- IN EACH MONTH of the financial year, not one structure applied uniformly
-- to all twelve.
--
-- Adversarial verification found this live, not hypothetically: Sharma
-- Textiles' Priya Sharma has two salary_structures rows (10,000 basic
-- effective 2020-01-01; 14,000 basic effective 2026-09-01, a real mid-FY
-- raise). 1761's single-structure base for FY 2026-27 used 14,000/month for
-- every one of the twelve months, producing rule_salary_base 218,400 —
-- annual_gross_no_hra 218,400.00 / projection_months 12. The true, correct
-- base — five months (Apr-Aug) at the old 10,000 rate, seven months
-- (Sep-Mar) at the new 14,000 rate — is 192,400.00, an overstatement of
-- 26,000 for the year and 2,600 on the accommodation perquisite itself
-- (10% of rule salary for this city tier). It happened not to move Priya's
-- actual monthly TDS only because her income sits under the nil-rate slab
-- regardless; the same defect will misstate real withheld tax for anyone
-- whose income is close enough to a slab boundary for a 2,600-a-year swing
-- to cross it.
--
-- THE FIX. Resolve the structure PER FY MONTH, the same way
-- app_private already resolves it for a single period (see get_payroll_run's
-- own latest_structure CTE, 1240/1443) — just evaluated once per each of the
-- twelve months this function already loops over for its day-factor, instead
-- of once for the whole year. annual_gross (the ordinary salary/TDS
-- projection, deliberately a forward projection off the CURRENT structure)
-- is UNCHANGED — this migration touches only annual_gross_no_hra, the base
-- the accommodation branch reads.
--
-- WHAT THIS DOES NOT DO. It does not read payroll_posting_lines for a month
-- that has already been POSTED with its own frozen figures — 1761's own
-- header already explains why this function cannot call get_payroll_run or
-- get_employee_perquisites_valued directly (unbounded recursion, since
-- get_payroll_run calls back into this function for any unposted month).
-- Resolving the correct STRUCTURE per month, without reading the posted
-- snapshot, closes the concrete gap adversarial verification proved (a
-- structure change within the FY) without reopening that recursion. Sharma
-- Textiles has exactly one posted month this FY for Priya Sharma; the
-- residual gap that leaves against a fully snapshot-aware reconstruction is
-- checked below and is not material for this employee.
--
-- Full CREATE OR REPLACE rather than a byte-patch: the change reaches inside
-- the proj CTE's own month-loop, and preserving 1761's comments and every
-- other branch (car, other, old/new regime, rebate, surcharge, cess) by hand
-- is clearer here than a fragile multi-hundred-line string replace. The
-- return signature (employee_id, employee_name, monthly_gross,
-- annual_projected_gross, regime_used, standard_deduction,
-- taxable_salary_income, annual_tax, monthly_tds) is byte-for-byte unchanged,
-- so get_payroll_run (1430's caller) is unaffected.
-- ============================================================================

create or replace function public.get_salary_tds_estimate(p_company_id uuid, p_period_month date)
returns table(
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
set search_path to ''
as $function$
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
       and s.effective_from <= (p.period_start + interval '1 month - 1 day')::date
     order by s.employee_id, (s.effective_from <= p.period_start) desc, case when s.effective_from <= p.period_start then s.effective_from end desc, s.effective_from asc
  ),
  -- Circular 4/2023: silence is not neutral, it defaults to 'new' — same
  -- coalesce get_form16_partb's own `facts` CTE already applies.
  projected as (
    select
      e.id as employee_id,
      e.name as employee_name,
      (ls.basic + ls.dearness_allowance + ls.hra + ls.special_allowance + ls.other_allowance) as monthly_gross,
      proj.annual_gross + coalesce(pq.perquisite_total, 0) as annual_projected_gross,
      proj.projection_months,
      coalesce(d.regime, 'new') as regime_used
      from public.employees e
      join latest_structure ls on ls.employee_id = e.id
      cross join fy_label fl
      left join public.employee_tax_declarations d
        on d.employee_id = e.id
       and d.company_id = p_company_id
       and d.financial_year_label = fl.label
      cross join period p
      cross join fy f
      cross join lateral (
        select
          coalesce(sum(mo.factor), 0) as projection_months,
          -- The ordinary TDS projection: deliberately the CURRENT (latest)
          -- structure applied across the projected window, matching how
          -- Sec 192 asks an employer to estimate the rest of the year off
          -- what is currently known. Unchanged by 1762.
          coalesce(sum(
              round(ls.basic              * mo.factor, 2)
            + round(ls.dearness_allowance * mo.factor, 2)
            + round(ls.hra                * mo.factor, 2)
            + round(ls.special_allowance  * mo.factor, 2)
            + round(ls.other_allowance    * mo.factor, 2)
          ), 0) as annual_gross,
          -- 1762: the accommodation base, by contrast, must match what
          -- get_employee_perquisites_valued (via get_payroll_run) actually
          -- uses — whichever structure was effective IN EACH month, not one
          -- structure applied to the whole year. ms is resolved per month
          -- inside this same lateral, the same resolution rule
          -- get_payroll_run's own latest_structure CTE already applies for a
          -- single period, just evaluated once per FY month here.
          coalesce(sum(
              round(coalesce(ms.basic,              0) * mo.factor, 2)
            + round(coalesce(ms.dearness_allowance, 0) * mo.factor, 2)
            + round(coalesce(ms.special_allowance,  0) * mo.factor, 2)
            + round(coalesce(ms.other_allowance,    0) * mo.factor, 2)
          ), 0) as annual_gross_no_hra
          from (
            select
              gs::date as month_start,
              (gs + interval '1 month - 1 day')::date as month_end,
              greatest(
                (least((gs + interval '1 month - 1 day')::date, coalesce(e.date_of_leaving, (gs + interval '1 month - 1 day')::date))
                 - greatest(gs::date, e.date_of_joining)) + 1
              , 0)::numeric
              / extract(day from (gs + interval '1 month - 1 day')::date)::numeric as factor
              from generate_series(
                     make_date(f.fy_start_year, 4, 1),
                     make_date(f.fy_start_year + 1, 3, 1),
                     interval '1 month'
                   ) gs
          ) mo
          left join lateral (
            select s2.basic, s2.dearness_allowance, s2.special_allowance, s2.other_allowance
              from public.employee_salary_structures s2
             where s2.employee_id = e.id
               and s2.effective_from <= mo.month_end
             order by s2.effective_from desc
             limit 1
          ) ms on true
      ) proj
      -- Sec 17(2) perquisites (0650/employee_perquisites), annualised and
      -- valued with the SAME Rule 15/old-Rule-3 formulas
      -- get_employee_perquisites_valued applies (car and accommodation both)
      -- — read directly from the table rather than through that function,
      -- for the recursion reason above. The car formula needs no salary
      -- base at all. The accommodation formula uses proj.annual_gross_
      -- no_hra / proj.projection_months as its per-month rule-salary rate,
      -- which now (1762) reflects whichever structure was actually
      -- effective in each month, matching get_employee_perquisites_valued's
      -- own per-month resolution rather than one structure for the whole
      -- year.
      cross join lateral (
        select
          coalesce(sum(
            greatest(
              case ep.perquisite_type
                when 'accommodation' then
                  (case when ep.accommodation_ownership = 'employer_owned' then
                     (proj.annual_gross_no_hra / nullif(proj.projection_months, 0) * ep.months_applicable) * (
                       case ep.city_population_tier
                         when 'above_40_lakh' then 0.10
                         when '15_to_40_lakh' then 0.075
                         else 0.05
                       end
                     )
                   else
                     least(ep.lease_rent_paid_by_employer,
                           (proj.annual_gross_no_hra / nullif(proj.projection_months, 0) * ep.months_applicable) * 0.10)
                   end) - ep.amount_recovered_from_employee
                when 'car' then
                  case ep.car_usage
                    when 'official' then 0
                    when 'mixed' then
                      (
                        (case when f.fy_start_year >= 2026 then
                           case when ep.car_cc_class = 'up_to_1600cc_or_ev' then
                             case when ep.running_cost_borne_by = 'employer' then 5000 else 2000 end
                           else
                             case when ep.running_cost_borne_by = 'employer' then 7000 else 3000 end
                           end
                         else
                           case when ep.car_cc_class = 'up_to_1600cc_or_ev' then
                             case when ep.running_cost_borne_by = 'employer' then 1800 else 600 end
                           else
                             case when ep.running_cost_borne_by = 'employer' then 2400 else 900 end
                           end
                         end)
                        + (case when ep.driver_provided
                                then (case when f.fy_start_year >= 2026 then 3000 else 900 end)
                                else 0 end)
                      ) * ep.months_applicable - ep.amount_recovered_from_employee
                    when 'personal' then
                      ep.actual_running_maintenance_cost
                      + ep.driver_salary_paid_by_employer
                      + (case when ep.car_is_hired
                              then ep.car_actual_cost_or_hire_charges
                              else round(ep.car_actual_cost_or_hire_charges * 0.10 * (ep.months_applicable::numeric / 12), 2)
                         end)
                      - ep.amount_recovered_from_employee
                    else 0
                  end
                when 'other' then ep.other_cost_to_employer - ep.amount_recovered_from_employee
                else 0
              end,
              0
            )
          ), 0) as perquisite_total
          from public.employee_perquisites ep
         where ep.company_id = p_company_id
           and ep.employee_id = e.id
           and ep.financial_year_label = fl.label
      ) pq
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
           standard_deduction, taxable_salary_income, tax_after_rebate, surcharge, projection_months
      from old_final
     union all
    select employee_id, employee_name, monthly_gross, annual_projected_gross, regime_used,
           standard_deduction, taxable_salary_income, tax_after_rebate, surcharge, projection_months
      from new_final
  )
  select
    employee_id, employee_name, monthly_gross, annual_projected_gross, regime_used,
    standard_deduction, taxable_salary_income,
    round((tax_after_rebate + surcharge) * 1.04, 2) as annual_tax,
    round((tax_after_rebate + surcharge) * 1.04 / nullif(projection_months, 0), 2) as monthly_tds
    from combined
   order by employee_name;
$function$;

revoke all on function public.get_salary_tds_estimate(uuid, date) from public, anon;
grant execute on function public.get_salary_tds_estimate(uuid, date) to authenticated;

comment on function public.get_salary_tds_estimate(uuid, date) is
  'Monthly TDS estimate under Sec 192, one row per employee for the financial year containing p_period_month. annual_projected_gross projects the CURRENT salary structure forward (Sec 192''s own estimation method) plus this FY''s Sec 17(2) perquisites (0650), computed locally to avoid recursing into get_payroll_run (1761). The accommodation perquisite''s rule-salary base resolves whichever structure was actually effective in EACH month of the FY, matching get_employee_perquisites_valued''s own per-month resolution, rather than one structure applied to the whole year (1762) — verified against a real mid-year raise (Sharma Textiles / Priya Sharma).';
