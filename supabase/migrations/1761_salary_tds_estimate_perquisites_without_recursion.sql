-- ============================================================================
-- 1761 — 1760's fix for perquisites recursed through get_payroll_run;
--        rebuilt to compute the same figure without calling it
-- ============================================================================
-- WHAT WAS WRONG WITH 1760. It folded the perquisite total in by calling
-- public.get_employee_perquisites_total, which calls
-- public.get_employee_perquisites_valued, whose own `payroll` CTE calls
-- public.get_payroll_run once per month of the financial year (to build the
-- accommodation rule-salary base) — and get_payroll_run ALREADY calls
-- get_salary_tds_estimate for any FY month with no posted payroll_posting_
-- lines yet (its `tds_estimate` CTE; 1430's own header names this exact
-- coupling as the reason get_salary_tds_estimate cannot itself call
-- get_payroll_run). 1760 closed that loop from the other side: calling
-- get_salary_tds_estimate now walked into get_employee_perquisites_valued,
-- which walked into get_payroll_run, which called get_salary_tds_estimate
-- again — for every future FY month, for every employee with a perquisite
-- row, at every recursion depth. Verified live: after 1760 was applied,
--   select * from get_salary_tds_estimate('9e4071b8-...', '2026-09-01');
-- did not return in over two minutes and was killed. That is 1760's own
-- defect, caught in this same task before being reported as done, not a
-- pre-existing bug — this migration corrects it before 1760 is signed off.
--
-- THE FIX. Compute the perquisite figure without calling either
-- get_employee_perquisites_valued or get_employee_perquisites_total —
-- reading public.employee_perquisites directly instead, which is a plain
-- table and cannot recurse. get_salary_tds_estimate already walks the
-- financial year month-by-month with a day factor (1430) to annualise the
-- salary structure into proj.annual_gross; this migration asks that SAME
-- lateral for one more aggregate, annual_gross_no_hra (basic + DA + special
-- + other, excluding HRA — the exact base Rule 15(1)/old Rule 3(1) uses,
-- per get_employee_perquisites_valued's own salary_agg comment, 0650), and
-- adds a second lateral, joined straight to employee_perquisites for the
-- employee/financial-year, applying the IDENTICAL Rule 15/old-Rule-3 rate
-- tables and CASE logic get_employee_perquisites_valued uses for both the
-- car and the accommodation branch (0650) — car needs no salary base at
-- all; accommodation divides annual_gross_no_hra by projection_months to
-- get a per-month rule-salary rate and multiplies by the perquisite row's
-- own months_applicable, which equals get_employee_perquisites_valued's own
-- annual_rule_salary / months_with_data for the case this reproduces (a
-- stable structure held the whole projected window — true for every
-- employee in the pilot company today).
--
-- REPRODUCTION, live, unchanged from 1760's header (re-verified below after
-- this fix, both for the correct number AND for actually returning): TEST
-- Vantage Ananya Rao, company 9e4071b8-dfec-4d4c-86f6-bb9fab84e600, Rule
-- 15(3) company-car perquisite (mixed use, above-1600cc, employer-borne
-- running cost, no driver, 12 months applicable, FY 2026-27) valued by the
-- app's own get_employee_perquisites_valued at 84,000.00.
--   BEFORE any perquisites fix:  annual_projected_gross 18,00,000.00,
--     taxable_salary_income 17,25,000.00, annual_tax 1,50,800.00,
--     monthly_tds 12,566.67
--   AFTER this migration:        annual_projected_gross 18,84,000.00,
--     taxable_salary_income 18,09,000.00, annual_tax 1,68,272.00,
--     monthly_tds 14,022.67
--   Delta: the whole 84,000 lands inside the 16,00,001-20,00,000 (20%) new-
--   regime slab, so tax_before_rebate rises by 84,000 x 20% = 16,800; no
--   Sec 87A relief reaches this income level; +4% cess brings the annual
--   delta to 16,800 x 1.04 = 17,472.00, i.e. Rs 1,456.00/month, exactly the
--   under-withholding named in the task.
--
-- CONTROL CASE. An employee with no employee_perquisites row for the FY:
-- the new lateral's coalesce(sum(...), 0) returns 0, so annual_projected_
-- gross, taxable_salary_income, annual_tax and monthly_tds are all
-- unchanged to the paisa. Verified live for TEST Vantage Divya Iyer and
-- TEST Vantage Rohan Deshmukh in the task report.
--
-- METHOD. Read the live definition, apply one targeted whole-CTE
-- replacement (the `projected` CTE, in full — smaller fragment-by-fragment
-- replacements were rejected here because the new lateral needs two new
-- aggregates threaded through in specific places, and a partial match would
-- assert-fail loudly rather than silently drift, which a single whole-block
-- replace makes easiest to review), assert it matched exactly once, then
-- execute. Nothing else in the function is retyped, so the regime split,
-- slabs, Sec 87A marginal relief, surcharge and the projection_months
-- divisor (0430/1430) are carried across untouched.
-- ============================================================================

do $mig$
declare
  v_def text;
  v_new text;
  v_hits int;

  c_old constant text := $oldblk$  projected as (
    select
      e.id as employee_id,
      e.name as employee_name,
      (ls.basic + ls.dearness_allowance + ls.hra + ls.special_allowance + ls.other_allowance) as monthly_gross,
      proj.annual_gross + coalesce(public.get_employee_perquisites_total(p_company_id, e.id, fl.label), 0) as annual_projected_gross,
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
          coalesce(sum(
              round(ls.basic              * mo.factor, 2)
            + round(ls.dearness_allowance * mo.factor, 2)
            + round(ls.hra                * mo.factor, 2)
            + round(ls.special_allowance  * mo.factor, 2)
            + round(ls.other_allowance    * mo.factor, 2)
          ), 0) as annual_gross
          from (
            select
              greatest(
                (least(mm.month_end, coalesce(e.date_of_leaving, mm.month_end))
                 - greatest(mm.month_start, e.date_of_joining)) + 1
              , 0)::numeric
              / extract(day from mm.month_end)::numeric as factor
              from (
                select gs::date as month_start,
                       (gs + interval '1 month - 1 day')::date as month_end
                  from generate_series(
                         make_date(f.fy_start_year, 4, 1),
                         make_date(f.fy_start_year + 1, 3, 1),
                         interval '1 month'
                       ) gs
              ) mm
          ) mo
      ) proj
     where e.company_id = p_company_id
       and e.date_of_joining <= (p.period_start + interval '1 month - 1 day')::date
       and (e.date_of_leaving is null or e.date_of_leaving >= p.period_start)
       and e.is_active
  ),
$oldblk$;

  c_new constant text := $newblk$  projected as (
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
          coalesce(sum(
              round(ls.basic              * mo.factor, 2)
            + round(ls.dearness_allowance * mo.factor, 2)
            + round(ls.hra                * mo.factor, 2)
            + round(ls.special_allowance  * mo.factor, 2)
            + round(ls.other_allowance    * mo.factor, 2)
          ), 0) as annual_gross,
          -- Same day-factor annualisation, excluding HRA: the "rule salary"
          -- base Rule 15(1)/old Rule 3(1) uses for accommodation valuation
          -- (see get_employee_perquisites_valued's own salary_agg comment,
          -- 0650). Computed locally, from the SAME structure/day-factor this
          -- function already walks, rather than by calling that function:
          -- get_employee_perquisites_valued reads get_payroll_run, and
          -- get_payroll_run calls get_salary_tds_estimate for any FY month
          -- with no posted payroll yet (1430's own header names this) — so
          -- calling it from here recurses without bound. See 1761.
          coalesce(sum(
              round(ls.basic              * mo.factor, 2)
            + round(ls.dearness_allowance * mo.factor, 2)
            + round(ls.special_allowance  * mo.factor, 2)
            + round(ls.other_allowance    * mo.factor, 2)
          ), 0) as annual_gross_no_hra
          from (
            select
              greatest(
                (least(mm.month_end, coalesce(e.date_of_leaving, mm.month_end))
                 - greatest(mm.month_start, e.date_of_joining)) + 1
              , 0)::numeric
              / extract(day from mm.month_end)::numeric as factor
              from (
                select gs::date as month_start,
                       (gs + interval '1 month - 1 day')::date as month_end
                  from generate_series(
                         make_date(f.fy_start_year, 4, 1),
                         make_date(f.fy_start_year + 1, 3, 1),
                         interval '1 month'
                       ) gs
              ) mm
          ) mo
      ) proj
      -- Sec 17(2) perquisites (0650/employee_perquisites), annualised and
      -- valued with the SAME Rule 15/old-Rule-3 formulas
      -- get_employee_perquisites_valued applies (car and accommodation both)
      -- — read directly from the table rather than through that function,
      -- for the recursion reason above. The car formula needs no salary
      -- base at all. The accommodation formula uses proj.annual_gross_
      -- no_hra / proj.projection_months as its per-month rule-salary rate,
      -- which equals get_employee_perquisites_valued's own annual_rule_
      -- salary / months_with_data for the case this reproduces: a stable
      -- structure held the whole projected window.
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
$newblk$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_salary_tds_estimate'
     and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1761: public.get_salary_tds_estimate is missing.';
  end if;

  if position('get_employee_perquisites_total' in v_def) = 0 then
    raise exception
      '1761: get_salary_tds_estimate does not carry 1760''s recursive perquisites call. Nothing to fix here; review before re-running.';
  end if;

  v_new := v_def;

  v_hits := (length(v_new) - length(replace(v_new, c_old, ''))) / length(c_old);
  if v_hits <> 1 then
    raise exception '1761: expected exactly 1 match of 1760''s `projected` CTE, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_old, c_new);

  -- Belt and braces: the recursive call must be gone and the new
  -- self-contained lookup present.
  if position('get_employee_perquisites_total' in v_new) > 0 then
    raise exception '1761: the recursive perquisites call survived the rewrite. Fix by hand.';
  end if;
  if position('employee_perquisites ep' in v_new) = 0 then
    raise exception '1761: the direct employee_perquisites lookup did not land. Fix by hand.';
  end if;

  execute v_new;
end;
$mig$;

-- Grants restated rather than assumed. CREATE OR REPLACE preserves the ACL,
-- but revoking from anon alone is a no-op (anon inherits PUBLIC's default
-- EXECUTE), which has shipped as a real hole here before — so the revoke
-- names both.
revoke all on function public.get_salary_tds_estimate(uuid, date) from public, anon;
grant execute on function public.get_salary_tds_estimate(uuid, date) to authenticated;
grant execute on function public.get_salary_tds_estimate(uuid, date) to service_role;

comment on function public.get_salary_tds_estimate is
  'Sec 192(1) / Sec 392(1) TDS-on-salary ESTIMATE per employee, on the employee''s own declared regime (0430): the salary this employer will actually pay between date_of_joining and 31 March at the current structure — pro-rated by get_payroll_run''s own day factor, so a mid-month joiner contributes a part month (1430) — PLUS the annualised Sec 17(2) perquisite value for the same employee/FY, valued with the same Rule 15/old-Rule-3 formulas as get_employee_perquisites_valued (accommodation and car both covered), read directly from employee_perquisites rather than through that function because that function''s own salary base reads get_payroll_run, which calls THIS function for unposted FY months — calling it from here would recurse (1760/1761) — less the regime''s standard deduction, taxed at that regime''s slabs/Sec 87A rebate/surcharge/cess, then divided by the months projected rather than a flat 12, which is Sec 392(1)''s average rate restated and is exactly 12 for a whole-year employee. monthly_gross is the cash salary-structure figure only and does NOT include perquisites (a non-cash valuation); only annual_projected_gross (and everything derived from it) does. Reproduces get_form16_partb''s gross_salary to the paisa where the structure is unchanged across the year, though NOT its perquisites_value line, which 0650 deliberately leaves undisclosed-only there. Still does NOT account for HRA exemption, Chapter VI-A declarations, or previous-employer salary/TDS (Sec 192(2)/Form 12B — stored and reported by get_form16_partb but folded into neither function''s tax base; see the 1430 header). A starting number for a human to adjust, not an authoritative computation.';
