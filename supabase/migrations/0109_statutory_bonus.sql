-- ============================================================================
-- 0109 — Statutory bonus: minimum bonus is owed, the surplus ceiling is not
-- ============================================================================
-- WHICH LAW GOVERNS THIS, RE-CHECKED BEFORE CODING A SINGLE SECTION NUMBER.
-- The task brief for this migration cites "the Payment of Bonus Act, 1965,
-- as amended" — and that framing is now WRONG for this app's own "today". A
-- live search confirms the four Labour Codes (Code on Wages 2019 among them)
-- came into force 21 November 2025, repealing the Payment of Bonus Act 1965
-- along with three other wage-related Acts; the Code on Wages (Central)
-- Rules, 2026 — which operationalise Chapter IV's bonus machinery, including
-- the wage-ceiling notification Sec 26(1)/32 delegate to the Central
-- Government — were themselves notified 8 May 2026, well before this
-- session's "today" of 23 Aug 2026. So the operative citations below are the
-- CODE ON WAGES 2019's own section numbers (Chapter IV, Sec 26-36), not the
-- 1965 Act's — the same "which Act governs THIS today" discipline 0026
-- already established for income tax (1961 Act vs 2025 Act) is applied here
-- for labour law. Every secondary source still calls this area "the Bonus
-- Act" out of habit and the substantive content carried forward almost
-- unchanged (confirmed section-by-section below), so this header still says
-- "Bonus Act" in prose for readability, but every SECTION NUMBER cited in
-- code comments is the Code on Wages one.
--
-- FIGURES CONFIRMED LIVE (WebSearch, Aug 2026), WITH ONE GENUINE CORRECTION
-- caught by the mandatory second, skeptical pass — the "obvious" answer
-- carried over from the old Act was WRONG:
--
--   Applicability (Sec 1(3) old Act; the Code's establishment-coverage
--     provision is worded the same way in every summary found): every
--     factory, and every OTHER establishment employing 20 or more persons
--     on any day during the accounting year — "once covered, always
--     covered" even if headcount later falls. A State notification CAN
--     lower this to as low as 10 for a specified class of establishment;
--     not modelled, same reason 0043/0085 refuse to hardcode a Professional
--     Tax slab table — it is State-specific and this schema has no per-
--     State override table for it.
--   Eligibility wage ceiling: Rs 21,000 per month (basic + DA only — see
--     "WHAT COUNTS AS WAGE" below). Employee must also have worked at
--     least 30 days in the accounting year (Sec 27/28) — LEKHA has no
--     attendance ledger, so "worked" is approximated as "employed" from
--     date_of_joining/date_of_leaving, the same substitution 0075 already
--     makes for payroll proration.
--   Calculation wage ceiling: Rs 7,000 per month (or the notified minimum
--     wage for the scheduled employment, whichever is higher — LEKHA does
--     not hold a State minimum-wage table, same gap as Professional Tax;
--     using the flat Rs 7,000 UNDERSTATES the calculation wage, and hence
--     the bonus, wherever the real minimum wage exceeds it). Genuinely
--     different from the eligibility ceiling and easy to conflate with it —
--     the task brief's own warning, borne out by how many summaries quote
--     only one of the two numbers.
--   Minimum bonus: 8.33% of the (capped) wage earned during the accounting
--     year, or Rs 100, whichever is higher — owed "whether or not the
--     employer has any allocable surplus", which is exactly why this app's
--     existing ledgers.sec43b_category already carries a 'bonus_commission'
--     value (0042): it is a Sec 43B(c)-style accrual, deductible only on
--     actual payment, owed regardless of profit or loss.
--   THE CORRECTION: proration of that Rs 100 floor. An employee who has
--     NOT worked every working day of the accounting year does not get the
--     flat Rs 100 — if 8.33% of their actual (partial-year) wage is LESS
--     than Rs 100, they get only that smaller percentage figure, not the
--     floor. This is not a simplification LEKHA is choosing; it is what
--     the statute itself says. (8.33% of the days-worked wage still wins
--     over the flat figure whenever it happens to exceed Rs 100 — the
--     comparison always keeps the higher of the two candidates.) Applied
--     below via full_year_employment: the floor only ever wins for someone
--     employed the entire FY, never for a mid-year joiner/leaver.
--   Maximum bonus: 20% of the same capped wage — an absolute statutory
--     ceiling, separate from and always at least as strict as whatever the
--     allocable surplus can actually fund.
--   WHAT COUNTS AS WAGE: basic + dearness allowance ONLY. HRA, other
--     allowances, overtime, employer PF, gratuity and commission are all
--     explicitly excluded. This maps directly onto
--     employee_salary_structures.basic + .dearness_allowance and nothing
--     else — a clean fit this app happens to already have from 0075's DA
--     fix, not a new column.
--
-- ALLOCABLE SURPLUS PERCENTAGE — THE SECOND, LARGER CORRECTION. The old
-- 1965 Act's Sec 2(4) split was 67% for a company that had NOT made a
-- specific dividend-arrangement filing, 60% for "any other case" (which
-- swept in every non-company employer — proprietorship, partnership, LLP —
-- by default). Multiple independent live sources for the CODE ON WAGES'
-- own Sec 31 give a DIFFERENT split: 60% for a banking company, 67% for
-- "any other establishment" — meaning every non-banking employer, company
-- or not, now gets 67%. This app's ref_entity_types has no "banking
-- company" code at all (LEKHA is not aimed at banks), so 67% is applied
-- UNIFORMLY below to every entity type the surplus estimate computes for —
-- correct under current law, and a genuine change from what carrying the
-- old Act's company/non-company split forward unexamined would have
-- produced for every proprietorship and partnership in this database.
--
-- TWO FUNCTIONS, DELIBERATELY SEPARATE, MATCHING THE TASK'S OWN FRAMING.
--
--   get_statutory_bonus_computation(company, fy_end) — per EMPLOYEE. The
--   minimum bonus (Sec 26/27) is computed with full confidence: it depends
--   only on this app's own employee/salary-structure data, nothing
--   external. Every employee employed at any point in the FY appears, even
--   an ineligible one, with a stated reason — never silently dropped.
--
--   get_statutory_bonus_surplus_estimate(company, fy_end) — one row,
--   company-wide. This is the honest partial computation the task brief
--   asked for. What it CAN reuse from this app's existing machinery:
--   get_income_tax_computation's own book_profit, book_depreciation_
--   addback and tax_depreciation_deduction (0026), and its total_tax
--   (an approximation of Sec 35's own "direct tax payable" sub-formula,
--   which has narrower carve-outs than a full return computation — a named
--   gap, not a silent one). What it CANNOT compute, and says so in its own
--   `note` column rather than fabricating a figure:
--     * Every Schedule-II-turned-Sec-34 item unrelated to depreciation/tax
--       — bonus paid in a PRIOR year added back, gratuity provision in
--       excess of the approved-fund contribution added back, donations in
--       excess of the Income-tax-admissible amount added back, capital
--       receipts/profits excluded, foreign-branch income excluded, subsidy
--       receipts excluded. None of these are identifiable from a general-
--       purpose ledger the way "which ledger is a Sec 43B category" already
--       is not (0042's own framing) — this app has no per-ledger tag for
--       "this expense is a donation in excess of the 80G-admissible
--       amount", and inventing one is a separate feature, not this one.
--     * Sec 36's multi-year set-on/set-off carry-forward (up to the fourth
--       following accounting year) — the Fourth-Schedule mechanic the task
--       brief specifically flagged as likely out of reach. It needs each
--       PRIOR year's own computed allocable surplus and actual bonus
--       declared, persisted year over year. This migration adds no such
--       history table — building one is real, valuable, separate future
--       work (a natural companion to the retained-earnings carry-forward
--       0073 already built the same way, one year at a time), not
--       something this pass can retrofit from ledger balances alone. Every
--       company in this database that has employee data at all (Sharma
--       Textiles, added for this verification) has no such history yet
--       regardless — there being nothing to carry forward is the honest
--       state of the data, not just the honest state of the code.
--     * Sec 26(6)-(9)'s first-five/sixth/seventh-accounting-year relief for
--       a NEW establishment. Needs the accounting year in which the
--       employer first sold goods/rendered services from the
--       establishment — companies.incorporation_date is null for every
--       seeded company (the same gap 0092 already documented), so this is
--       silently inapplicable for this data, not evaluated as false.
--     * Sec 29 disqualification (dismissal for fraud, violence, theft,
--       sabotage, a sexual-harassment conviction). employees has
--       is_active/date_of_leaving but no termination-REASON code, so this
--       cannot be tested; every employee who clears the wage/day tests is
--       treated as not disqualified.
--   Given all of that, `available_surplus_approx` /
--   `allocable_surplus_approx` are exactly that — approximate, current-
--   year-only, and clearly labelled so in both the column names and the
--   `note` text the report page surfaces verbatim. They are a useful
--   directional signal (is there obviously enough profit to fund more than
--   the minimum), not a Form-A-ready figure.
--
-- REPORT-ONLY, LIKE EVERY BONUS-ADJACENT COMPUTATION IN THIS APP SO FAR.
-- Nothing here posts a voucher or writes a liability. If a user wants the
-- minimum bonus accrued in the books before actual payment (the whole
-- point of Sec 43B(c) and this app's existing bonus_commission category),
-- they journal it themselves and flag that ledger's sec43b_category —
-- machinery that already exists and needed no change here.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_statutory_bonus_computation(company, fy_end)
-- One row per employee employed at any point in [fy_start, fy_end]. fy_end
-- must be 31 March — same guard 0091's get_deferred_tax_reconciliation uses,
-- for the same reason: this function derives fy_start as the preceding
-- 1 April rather than reading companies.financial_year_start_month, because
-- it calls get_income_tax_computation and get_tax_depreciation_blocks
-- (via the surplus-estimate function below) which themselves always run
-- the calendar April-March year — deriving a different year here than what
-- those functions use would silently mismatch the two.
-- ----------------------------------------------------------------------------
create or replace function public.get_statutory_bonus_computation(
  p_company_id uuid,
  p_fy_end date
) returns table (
  employee_id uuid,
  employee_name text,
  date_of_joining date,
  date_of_leaving date,
  days_employed_in_fy integer,
  full_year_employment boolean,
  monthly_wage_rate numeric,
  eligible boolean,
  ineligibility_reason text,
  annual_salary_wage_earned numeric,
  annual_calculation_wage numeric,
  minimum_bonus numeric,
  minimum_bonus_floor_applied boolean,
  maximum_bonus_at_20pct numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_fy_start date;
  v_fy_total_days integer;
  v_eligibility_ceiling constant numeric := 21000;
  v_calc_ceiling constant numeric := 7000;
  v_min_rate constant numeric := 0.0833;
  v_max_rate constant numeric := 0.20;
  v_min_floor constant numeric := 100;
  v_min_days constant integer := 30;
begin
  if extract(month from p_fy_end) <> 3 or extract(day from p_fy_end) <> 31 then
    raise exception
      'Statutory bonus is computed only as at a financial year end (31 March) — % is not one.',
      p_fy_end;
  end if;
  v_fy_start := make_date(extract(year from p_fy_end)::int - 1, 4, 1);
  v_fy_total_days := (p_fy_end - v_fy_start) + 1;

  return query
  with months as (
    select generate_series(v_fy_start, p_fy_end, interval '1 month')::date as month_start
  ),
  emp as (
    select e.id, e.name, e.date_of_joining, e.date_of_leaving
      from public.employees e
     where e.company_id = p_company_id
       and e.date_of_joining <= p_fy_end
       and (e.date_of_leaving is null or e.date_of_leaving >= v_fy_start)
  ),
  -- Per-employee day count actually employed within the FY — a single
  -- closed-form range, not a sum of the monthly pieces below (the months
  -- are contiguous and non-overlapping so the two would agree anyway; the
  -- closed form is simpler and avoids re-deriving it 12 times).
  emp_days as (
    select
      emp.id,
      (least(p_fy_end, coalesce(emp.date_of_leaving, p_fy_end))
       - greatest(v_fy_start, emp.date_of_joining) + 1)::integer as days_employed
      from emp
  ),
  -- The wage RATE tested against the eligibility ceiling — the latest
  -- structure in force at the employee's last day of FY employment (or at
  -- fy_end if still employed), never the prorated earned amount. Same
  -- "rate test vs earned-amount computation" split get_payroll_run already
  -- draws for ESI eligibility (0075).
  elig as (
    select
      emp.id as employee_id,
      ls.basic, ls.dearness_allowance,
      (ls.basic + ls.dearness_allowance) as wage_rate
      from emp
      left join lateral (
        select s.basic, s.dearness_allowance
          from public.employee_salary_structures s
         where s.employee_id = emp.id
           and s.effective_from <= least(p_fy_end, coalesce(emp.date_of_leaving, p_fy_end))
         order by s.effective_from desc
         limit 1
      ) ls on true
  ),
  -- Month-by-month earned wage, day-prorated within each calendar month —
  -- the same day-count arithmetic 0075's get_payroll_run uses for a single
  -- month, applied here across all 12 months of the FY so a salary
  -- revision mid-year is picked up segment by segment. The Rs 7,000 cap is
  -- applied to the MONTHLY RATE first, then prorated — mathematically
  -- identical to LEAST(prorated_actual, 7000 * days_paid/days_in_month),
  -- the exact pattern get_payroll_run already uses for the PF wage
  -- ceiling, so this is not a new technique, just the same one reused.
  monthly as (
    select
      emp.id as employee_id,
      m.month_start,
      extract(day from (m.month_start + interval '1 month - 1 day'))::int as days_in_month,
      greatest(
        (least((m.month_start + interval '1 month - 1 day')::date,
               coalesce(emp.date_of_leaving, (m.month_start + interval '1 month - 1 day')::date))
         - greatest(m.month_start, emp.date_of_joining)) + 1
      , 0)::int as days_paid,
      coalesce(ls.basic, 0) + coalesce(ls.dearness_allowance, 0) as month_rate
      from emp
      cross join months m
      -- effective_from <= MONTH END, not month start. A joiner's very first
      -- salary structure is conventionally dated to their date_of_joining —
      -- if that lands mid-month (the common case), a month-START cutoff
      -- would find no structure at all for that partial month and silently
      -- price it at zero, understating a real entitlement. Caught live by
      -- this migration's own verification run, not by re-reading the code:
      -- a mid-month joiner otherwise eligible on every other test came back
      -- with annual_calculation_wage = 0. The trade-off this accepts: a
      -- salary REVISION effective mid-month is treated as governing the
      -- whole month it starts in rather than being split day-by-day from
      -- the exact date — a much smaller, and disclosed, simplification.
      left join lateral (
        select s.basic, s.dearness_allowance
          from public.employee_salary_structures s
         where s.employee_id = emp.id
           and s.effective_from <= (m.month_start + interval '1 month - 1 day')::date
         order by s.effective_from desc
         limit 1
      ) ls on true
     where emp.date_of_joining <= (m.month_start + interval '1 month - 1 day')::date
       and (emp.date_of_leaving is null or emp.date_of_leaving >= m.month_start)
  ),
  -- Bare "employee_id" is genuinely ambiguous below — it is also this
  -- function's own OUT/RETURNS TABLE column name, so plpgsql treats it as a
  -- variable in scope too. Every reference here is qualified with its
  -- source CTE's alias; the exact same gotcha 0092's get_agm_status hit
  -- and documented (financial_year_start_year vs its own RETURNS TABLE
  -- column), confirmed live by this migration's own first apply attempt.
  monthly_amounts as (
    select
      monthly.employee_id,
      round(monthly.month_rate * monthly.days_paid::numeric / nullif(monthly.days_in_month, 0), 2) as earned_amount,
      round(least(monthly.month_rate, v_calc_ceiling) * monthly.days_paid::numeric / nullif(monthly.days_in_month, 0), 2) as calc_amount
      from monthly
  ),
  earned as (
    select
      monthly_amounts.employee_id,
      coalesce(sum(monthly_amounts.earned_amount), 0) as annual_salary_wage_earned,
      coalesce(sum(monthly_amounts.calc_amount), 0) as annual_calculation_wage
      from monthly_amounts
     group by monthly_amounts.employee_id
  )
  select
    emp.id,
    emp.name,
    emp.date_of_joining,
    emp.date_of_leaving,
    ed.days_employed,
    (ed.days_employed >= v_fy_total_days) as full_year,
    el.wage_rate,
    case
      when el.wage_rate is null then false
      when el.wage_rate > v_eligibility_ceiling then false
      when ed.days_employed < v_min_days then false
      else true
    end as eligible,
    case
      when el.wage_rate is null then 'No salary structure on file for this employee — eligibility cannot be determined.'
      when el.wage_rate > v_eligibility_ceiling then
        'Monthly basic + DA of ' || to_char(el.wage_rate, 'FM99,99,999') ||
        ' exceeds the Rs 21,000 eligibility ceiling (Code on Wages 2019, Sec 26(1)).'
      when ed.days_employed < v_min_days then
        'Employed ' || ed.days_employed || ' day(s) in this accounting year — below the 30-day minimum ' ||
        '(Sec 27/28). LEKHA approximates "worked" as "employed" (no attendance/leave-without-pay ' ||
        'tracking), so this is an upper bound on days actually worked.'
      else null
    end as ineligibility_reason,
    round(coalesce(ea.annual_salary_wage_earned, 0), 2),
    round(coalesce(ea.annual_calculation_wage, 0), 2),
    case
      when el.wage_rate is null or el.wage_rate > v_eligibility_ceiling or ed.days_employed < v_min_days
        then null
      -- Sec 27: the flat Rs 100 floor only ever wins for an employee who
      -- worked (here: was employed) every day of the accounting year. A
      -- mid-year joiner/leaver gets the straight percentage even when that
      -- is below Rs 100 — see the migration header, this is not a LEKHA
      -- simplification, it is what the statute itself requires.
      when ed.days_employed >= v_fy_total_days
        then greatest(round(coalesce(ea.annual_calculation_wage, 0) * v_min_rate, 2), v_min_floor)
      else round(coalesce(ea.annual_calculation_wage, 0) * v_min_rate, 2)
    end as minimum_bonus,
    case
      when el.wage_rate is null or el.wage_rate > v_eligibility_ceiling or ed.days_employed < v_min_days
        then false
      when ed.days_employed >= v_fy_total_days
        then v_min_floor > round(coalesce(ea.annual_calculation_wage, 0) * v_min_rate, 2)
      else false
    end as minimum_bonus_floor_applied,
    case
      when el.wage_rate is null or el.wage_rate > v_eligibility_ceiling or ed.days_employed < v_min_days
        then null
      else round(coalesce(ea.annual_calculation_wage, 0) * v_max_rate, 2)
    end as maximum_bonus_at_20pct
    from emp
    join emp_days ed on ed.id = emp.id
    join elig el on el.employee_id = emp.id
    left join earned ea on ea.employee_id = emp.id
   order by emp.name;
end;
$fn$;

comment on function public.get_statutory_bonus_computation(uuid, date) is
  'Per-employee statutory bonus under the Code on Wages 2019, Chapter IV (successor to the repealed Payment of Bonus Act 1965 — see the migration header). Eligibility tests the actual monthly basic+DA rate against the Rs 21,000 ceiling and 30 days employed in the FY (a proxy for "worked", no attendance data exists); the minimum bonus is 8.33% of the Rs 7,000-capped wage or Rs 100 whichever is higher, with the Rs 100 floor withheld for anyone not employed the full FY per Sec 27''s proportionate-reduction rule. maximum_bonus_at_20pct is the absolute statutory ceiling only — see get_statutory_bonus_surplus_estimate for whether the allocable surplus can actually fund anything above the minimum.';

revoke all on function public.get_statutory_bonus_computation(uuid, date) from public, anon;
grant execute on function public.get_statutory_bonus_computation(uuid, date) to authenticated;


-- ----------------------------------------------------------------------------
-- get_statutory_bonus_surplus_estimate(company, fy_end)
-- One row, company-wide. See the migration header for exactly what this
-- does and does not compute — it is a directional estimate, not a Form A.
-- ----------------------------------------------------------------------------
create or replace function public.get_statutory_bonus_surplus_estimate(
  p_company_id uuid,
  p_fy_end date
) returns table (
  fy_start date,
  fy_end date,
  entity_type text,
  headcount_this_fy integer,
  act_applicable_by_headcount boolean,
  eligible_employee_count integer,
  total_annual_calculation_wage numeric,
  total_minimum_bonus numeric,
  total_maximum_bonus_at_20pct numeric,
  surplus_computable boolean,
  book_profit numeric,
  book_depreciation_addback numeric,
  tax_depreciation_deduction numeric,
  estimated_direct_tax numeric,
  available_surplus_approx numeric,
  allocable_surplus_percent numeric,
  allocable_surplus_approx numeric,
  surplus_covers_minimum_bonus boolean,
  affordable_bonus_percent_approx numeric,
  note text
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_fy_start date;
  v_entity_type text;
  v_headcount int;
  v_eligible_count int;
  v_total_calc_wage numeric;
  v_total_min numeric;
  v_total_max20 numeric;
  v_itc_applicable boolean;
  v_book_profit numeric;
  v_book_dep numeric;
  v_tax_dep numeric;
  v_total_tax numeric;
  v_available numeric;
  v_pct numeric := 67; -- Sec 31: 60% banking company / 67% any other. No
                       -- banking-company entity type exists in this schema
                       -- — see migration header — so 67% applies uniformly.
  v_allocable numeric;
  v_note text;
begin
  if extract(month from p_fy_end) <> 3 or extract(day from p_fy_end) <> 31 then
    raise exception
      'Statutory bonus is computed only as at a financial year end (31 March) — % is not one.',
      p_fy_end;
  end if;
  v_fy_start := make_date(extract(year from p_fy_end)::int - 1, 4, 1);

  select c.entity_type into v_entity_type from public.companies c where c.id = p_company_id;

  -- Headcount: distinct employees whose employment overlapped the FY at
  -- all. This approximates Sec 1(3)/the Code's "20 or more persons employed
  -- on any day during the accounting year" — it is an UPPER bound on the
  -- true "maximum on any single day" test whenever there is turnover (five
  -- people who each worked a different two months could show headcount 5
  -- with a same-day maximum of 1), and matches it exactly when there is
  -- none. LEKHA has no daily headcount snapshot to compute the stricter
  -- test.
  select count(*) into v_headcount
    from public.employees e
   where e.company_id = p_company_id
     and e.date_of_joining <= p_fy_end
     and (e.date_of_leaving is null or e.date_of_leaving >= v_fy_start);

  select
      count(*) filter (where b.eligible),
      coalesce(sum(b.annual_calculation_wage) filter (where b.eligible), 0),
      coalesce(sum(b.minimum_bonus) filter (where b.eligible), 0),
      coalesce(sum(b.maximum_bonus_at_20pct) filter (where b.eligible), 0)
    into v_eligible_count, v_total_calc_wage, v_total_min, v_total_max20
    from public.get_statutory_bonus_computation(p_company_id, p_fy_end) b;

  select t.applicable, t.book_profit, t.book_depreciation_addback,
         t.tax_depreciation_deduction, t.total_tax
    into v_itc_applicable, v_book_profit, v_book_dep, v_tax_dep, v_total_tax
    from public.get_income_tax_computation(p_company_id, v_fy_start, p_fy_end) t;

  fy_start := v_fy_start;
  fy_end := p_fy_end;
  entity_type := v_entity_type;
  headcount_this_fy := v_headcount;
  act_applicable_by_headcount := v_headcount >= 20;
  eligible_employee_count := v_eligible_count;
  total_annual_calculation_wage := round(v_total_calc_wage, 2);
  total_minimum_bonus := round(v_total_min, 2);
  total_maximum_bonus_at_20pct := round(v_total_max20, 2);

  if not coalesce(v_itc_applicable, false) then
    surplus_computable := false;
    book_profit := null; book_depreciation_addback := null; tax_depreciation_deduction := null;
    estimated_direct_tax := null; available_surplus_approx := null;
    allocable_surplus_percent := null; allocable_surplus_approx := null;
    surplus_covers_minimum_bonus := null; affordable_bonus_percent_approx := null;
    note := 'Allocable surplus not estimated — get_income_tax_computation does not derive a tax figure for this entity type (AOP/BOI, trust or society; see 0026), and this estimate needs that figure for the Sec 34/35 direct-tax deduction. The minimum bonus above is unaffected — it is owed regardless of surplus.';
    return next;
    return;
  end if;

  -- Available surplus (approx): book profit + book depreciation added back
  -- (Sec 34 item 2's own add-back) minus tax depreciation (Sec 34(a)) minus
  -- estimated direct tax (Sec 34(c)/35). Every OTHER Sec 34 item — bonus/
  -- gratuity/donation adjustments, capital items, foreign income, subsidies
  -- — is NOT modelled; see the migration header for why. This is a genuine
  -- approximation of "gross profit as computed by Schedule II of the old
  -- Act / Sec 32 read with the Rules", not that figure itself.
  v_available := coalesce(v_book_profit, 0) + coalesce(v_book_dep, 0)
                 - coalesce(v_tax_dep, 0) - coalesce(v_total_tax, 0);
  v_allocable := round(v_available * v_pct / 100.0, 2);

  surplus_computable := true;
  book_profit := round(v_book_profit, 2);
  book_depreciation_addback := round(v_book_dep, 2);
  tax_depreciation_deduction := round(v_tax_dep, 2);
  estimated_direct_tax := round(v_total_tax, 2);
  available_surplus_approx := round(v_available, 2);
  allocable_surplus_percent := v_pct;
  allocable_surplus_approx := v_allocable;
  surplus_covers_minimum_bonus := v_allocable >= v_total_min;
  affordable_bonus_percent_approx :=
    case when v_total_calc_wage > 0
      then greatest(8.33, least(20, round(v_allocable / v_total_calc_wage * 100, 2)))
      else null
    end;

  v_note := 'Approximate, current-year-only allocable surplus (Code on Wages 2019, Sec 31-35). '
    || 'Excludes every Sec 34 adjustment unrelated to depreciation/direct tax (prior-year bonus '
    || 'add-back, gratuity/donation excess add-back, capital and foreign-income exclusions — none '
    || 'identifiable from a general-purpose ledger), and excludes Sec 36''s multi-year set-on/'
    || 'set-off carry-forward entirely — that needs each prior year''s own computed surplus and '
    || 'declared bonus, persisted year over year, which this app does not yet do for any company. '
    || 'Treat available_surplus_approx/allocable_surplus_approx as a directional signal, not a '
    || 'Form A figure. total_minimum_bonus above is exact and owed regardless of this estimate.';
  note := v_note;
  return next;
end;
$fn$;

comment on function public.get_statutory_bonus_surplus_estimate(uuid, date) is
  'Company-wide statutory bonus surplus estimate: exact minimum-bonus totals (from get_statutory_bonus_computation) alongside an APPROXIMATE current-year allocable surplus reused from get_income_tax_computation''s book profit/depreciation/tax figures. Does not compute the Sec 36 multi-year set-on/set-off carry-forward (no persisted history exists) or several Sec 34 gross-profit adjustments this schema cannot identify. See the migration header and the note column.';

revoke all on function public.get_statutory_bonus_surplus_estimate(uuid, date) from public, anon;
grant execute on function public.get_statutory_bonus_surplus_estimate(uuid, date) to authenticated;
