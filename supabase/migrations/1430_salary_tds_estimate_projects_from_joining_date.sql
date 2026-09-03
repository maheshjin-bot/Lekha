-- ============================================================================
-- 1430 — Sec 192 / Sec 392 salary TDS: project the year the employee will
--        actually be paid, not twelve months of it
-- ============================================================================
-- WHAT WAS OBSERVED, live, in the pilot company (TEST Rangoli Spice Works
-- Pvt Ltd, 8e161d8e-cd2e-4c60-96a4-bad69c42b573). TEST Vikram Rao joined on
-- 1 Aug 2026 on Rs 1,25,000 a month. Two payroll runs have been computed,
-- posted and remitted:
--
--   get_salary_tds_estimate('...','2026-08-01')   BEFORE this migration
--     monthly_gross                1,25,000
--     annual_projected_gross      15,00,000     <-- 1,25,000 x 12
--     taxable_salary_income       14,25,000     <-- less Rs 75,000 std ded
--     slab tax                        93,750
--     Sec 87A rebate                     nil    <-- pushed over Rs 12,00,000
--     annual_tax (incl. 4% cess)      97,500
--     monthly_tds                      8,125.00
--
--   posted, twice, to TDS Payable (Salary): 8,125.00 on 2026-08-31 and
--   8,125.00 on 2026-09-30.
--
-- The app's own year-end certificate, for the same employee and the same
-- year, disagrees with all of it:
--
--   get_form16_partb('...','62b05470-...','2026-27')
--     months_with_payroll_data             8
--     gross_salary                10,00,000
--     new_taxable_income           9,25,000
--     new_tax_before_rebate           32,500
--     new_rebate_87a                  32,500     <-- fully rebated
--     net_tax_payable                      0.00
--     tds_deposited_per_payroll_projection 65,000.00
--
-- So the app withholds and remits Rs 65,000 of income tax over the year from
-- an employee whose liability, on its own computation, is nil. That is not a
-- presentation defect: the money leaves the employee's net pay, is credited
-- to TDS Payable (Salary) and is paid to the government. The employee gets it
-- back only by filing a return and waiting for a refund.
--
-- THE CAUSE. get_salary_tds_estimate annualised as `monthly_gross * 12`,
-- unconditionally, with no reference to date_of_joining — the simplification
-- 0049's own header called a "steady-state projection" and 1240's header
-- explicitly left open ("projecting annual pay as monthly x 12 regardless of
-- joining date; that is a different bug and is not touched here"). For anyone
-- employed the whole year it is right. For a mid-year joiner it inflates the
-- estimated income by the months before they were hired, and because Sec 87A
-- is a threshold test on that same inflated figure, the error does not merely
-- scale the tax — it can turn a nil liability into a real deduction, which is
-- exactly what happened here.
--
-- THE RULE RELIED ON. For FY 2026-27 the governing provision is section 392
-- of the Income-tax Act, 2025, which replaced sections 192 and 192A of the
-- 1961 Act with effect from 1 April 2026 (this codebase already recognises
-- the changeover — get_form16_partb switches its own form_label to "Form 130
-- Part C" for fy_start_year >= 2026). Section 392(1) carries forward the
-- 1961 Act's section 192(1) unchanged in substance: tax is to be deducted
-- "at the average rate of income-tax computed on the basis of the rates in
-- force for the tax year ... on the estimated income of the assessee". Two
-- consequences, and this migration implements both:
--
--   (a) the base is the ESTIMATED INCOME of the assessee for the year — what
--       this employer will actually pay this employee between joining and
--       31 March — not a notional twelve months of the current structure;
--   (b) the rate is an AVERAGE RATE — net tax divided by that estimated
--       income — so applying it month by month spreads the whole year's
--       liability over the months actually paid. Dividing by a fixed 12 when
--       only 8 months remain would collect two-thirds of the tax and leave a
--       shortfall; dividing by the projected months is the average-rate
--       method restated, and for a full-year employee it IS twelve, so the
--       existing number for such an employee does not move by a paisa.
--
-- HOW THE PROJECTION IS BUILT, and why it agrees with Form 16 by
-- construction. get_form16_partb gets the right annual figure by summing
-- get_payroll_run over the twelve months of the year; get_salary_tds_estimate
-- cannot do the same, because get_payroll_run calls get_salary_tds_estimate
-- (that would recurse). So it reproduces get_payroll_run's own day factor
-- instead, month by month over the financial year:
--
--     days_paid  = clamp(joining .. leaving) within the month, inclusive
--     factor     = days_paid / days_in_month
--     month gross= sum of each component rounded at factor, exactly as
--                  get_payroll_run's `prorated` CTE rounds them
--
-- Summing the factors gives `projection_months` (12.00 for a whole-year
-- employee, 8.00 for a 1 August joiner, 10.548387 for a 15 May joiner) and
-- summing the month grosses gives annual_projected_gross. Where the salary
-- structure runs from the start of the joining month this reproduces
-- get_form16_partb's gross_salary to the paisa, which is the point — the
-- monthly estimate and the year-end certificate should not be able to
-- disagree. Verified live for 5 of the pilot's 6 employees; the sixth is the
-- known get_payroll_run gap described below.
--
-- MID-MONTH JOINERS are handled by the same factor rather than as a special
-- case: TEST Priya Nair joined 15 May 2026, so May contributes 17/31 of a
-- month, not a whole one and not none.
--
-- ONE PLACE THIS DELIBERATELY DOES NOT AGREE WITH get_form16_partb, and why.
-- get_payroll_run picks the salary structure with `effective_from <=
-- period_start`, so an employee whose FIRST structure begins mid-month has no
-- structure at all in their joining month and drops out of that month's
-- payroll entirely. TEST Priya Nair joined 15 May 2026 with a structure
-- effective 15 May 2026 and is absent from May's run: she is paid nothing for
-- 17 days she worked, and get_form16_partb consequently reports 2,90,000
-- against this function's 3,05,903.23. That is a defect in get_payroll_run's
-- structure window, not here, and get_payroll_run is outside this migration's
-- scope. This function projects what the employee is actually entitled to
-- between joining and 31 March, which is what section 392(1) asks for;
-- mirroring the other function's window would hard-code its bug into the tax
-- base and would silently go wrong the day that bug is fixed. The residual
-- over-projection is bounded by one part-month of salary and, because 0430
-- added Sec 87A marginal relief, cannot reproduce anything like the cliff
-- this migration removes.
--
-- MID-YEAR LEAVERS get the mirror-image treatment (the projection stops at
-- date_of_leaving). Today this is defensive rather than active:
-- record_fnf_settlement is the only writer of employees.is_active and always
-- sets date_of_leaving in the same statement (1240 verified this), and this
-- function still filters on is_active, so a row with a leaving date does not
-- reach here at all. If that ever changes, the arithmetic is already right.
--
-- WHAT IS DELIBERATELY *NOT* CHANGED — PREVIOUS-EMPLOYER INCOME. A mid-year
-- joiner usually has salary from a previous employer, and section 192(2) of
-- the 1961 Act (Form 12B) / its section 392 successor requires the present
-- employer to take it into account — but only where the employee actually
-- furnishes it; absent that, the employer deducts on its own salary alone.
-- employee_tax_declarations already stores previous_employer_income and
-- previous_employer_tds_deducted, and get_form16_partb already reads and
-- REPORTS both — but does not fold either into any of its tax-base CTEs
-- (old_computed starts from gross_salary; new_computed starts from
-- gross_salary). Folding it into the monthly estimate alone would recreate
-- precisely the defect this migration exists to remove: an estimate that
-- disagrees with the certificate. The two have to move together, and
-- get_form16_partb is out of this migration's scope. Flagged, not done.
--
-- METHOD. Read the live definition, apply targeted replacements, assert each
-- one matched the expected number of times, then execute — the pattern 1200,
-- 1230 and 1240 already use. Nothing else in the function is retyped, so the
-- regime split, the slab tables, the Sec 87A marginal relief and the
-- surcharge bands added by 0430 are carried across untouched.
-- ============================================================================

do $mig$
declare
  v_def text;
  v_new text;
  v_hits int;

  -- 1. The annualisation itself.
  c_t1 constant text := $t1$      (ls.basic + ls.dearness_allowance + ls.hra + ls.special_allowance + ls.other_allowance) * 12 as annual_projected_gross,
      coalesce(d.regime, 'new') as regime_used$t1$;
  c_r1 constant text := $r1$      proj.annual_gross as annual_projected_gross,
      proj.projection_months,
      coalesce(d.regime, 'new') as regime_used$r1$;

  -- 2. Where that projection comes from: get_payroll_run's own day factor,
  --    walked across the twelve months of the financial year.
  c_t2 constant text := $t2$      cross join period p
     where e.company_id = p_company_id
       and e.date_of_joining <= (p.period_start + interval '1 month - 1 day')::date$t2$;
  c_r2 constant text := $r2$      cross join period p
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
       and e.date_of_joining <= (p.period_start + interval '1 month - 1 day')::date$r2$;

  -- 3. Carry it through the union (both arms list their columns explicitly).
  c_t3 constant text := $t3$standard_deduction, taxable_salary_income, tax_after_rebate, surcharge$t3$;
  c_r3 constant text := $r3$standard_deduction, taxable_salary_income, tax_after_rebate, surcharge, projection_months$r3$;

  -- 4. The average rate: spread over the months actually paid, not a flat 12.
  c_t4 constant text := $t4$round((tax_after_rebate + surcharge) * 1.04 / 12, 2) as monthly_tds$t4$;
  c_r4 constant text := $r4$round((tax_after_rebate + surcharge) * 1.04 / nullif(projection_months, 0), 2) as monthly_tds$r4$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_salary_tds_estimate'
     and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1430: public.get_salary_tds_estimate is missing.';
  end if;

  -- The two things the rest of this migration assumes are still true of the
  -- body: 0430's regime split is present, and the function has not already
  -- been made joining-date aware by somebody else.
  if v_def !~ 'ref_income_tax_slabs_old_regime' then
    raise exception
      '1430: get_salary_tds_estimate no longer carries 0430''s old-regime arm; its body has moved. Fix by hand.';
  end if;
  if position('projection_months' in v_def) > 0 then
    raise exception
      '1430: get_salary_tds_estimate already projects from the joining date. Nothing to do; review before re-running.';
  end if;

  v_new := v_def;

  v_hits := (length(v_new) - length(replace(v_new, c_t1, ''))) / length(c_t1);
  if v_hits <> 1 then
    raise exception '1430: expected exactly 1 "x 12" annualisation, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_t1, c_r1);

  v_hits := (length(v_new) - length(replace(v_new, c_t2, ''))) / length(c_t2);
  if v_hits <> 1 then
    raise exception '1430: expected exactly 1 projected-CTE from-clause, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_t2, c_r2);

  v_hits := (length(v_new) - length(replace(v_new, c_t3, ''))) / length(c_t3);
  if v_hits <> 2 then
    raise exception '1430: expected exactly 2 union column lists, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_t3, c_r3);

  v_hits := (length(v_new) - length(replace(v_new, c_t4, ''))) / length(c_t4);
  if v_hits <> 1 then
    raise exception '1430: expected exactly 1 "/ 12" monthly divisor, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_t4, c_r4);

  -- Belt and braces: the divisor must be gone and the new column present in
  -- all four places (projected, both union arms, final select).
  if position('* 1.04 / 12,' in v_new) > 0 then
    raise exception '1430: a flat /12 divisor survived the rewrite. Fix by hand.';
  end if;
  v_hits := (length(v_new) - length(replace(v_new, 'projection_months', ''))) / length('projection_months');
  if v_hits <> 5 then
    raise exception '1430: expected projection_months in 5 places, found %. Fix by hand.', v_hits;
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
  'Sec 192 / Sec 392 TDS-on-salary ESTIMATE per employee, on the employee''s own declared regime (0430): the salary this employer will actually pay between date_of_joining and 31 March at the current structure — pro-rated by get_payroll_run''s own day factor, so a mid-month joiner contributes a part month (1430) — less the regime''s standard deduction, taxed at that regime''s slabs/Sec 87A rebate/surcharge/cess, then divided by the months projected rather than a flat 12, which is Sec 392(1)''s average rate restated and is exactly 12 for a whole-year employee. Reproduces get_form16_partb''s gross_salary to the paisa where the structure is unchanged across the year. Still does NOT account for HRA exemption, Chapter VI-A declarations, or previous-employer salary/TDS (Sec 192(2)/Form 12B — stored and reported by get_form16_partb but folded into neither function''s tax base; see the 1430 header). A starting number for a human to adjust, not an authoritative computation.';
