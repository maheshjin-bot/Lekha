-- ============================================================================
-- 0650 — Sec 17(2) perquisites (accommodation, company car, other): the gap
-- both 0093 and 0205 named and left open
-- ============================================================================
-- 0093's own header, on employee_tax_declarations: "Chapter VI-A categories
-- NOT captured ... and other-income heads ... are OUT OF SCOPE." 0205's own
-- header, on get_form16_partb, is more direct: "this schema has NO column,
-- anywhere, for accommodation, company car, ESOP, or any other perquisite
-- u/s 17(2) ... perquisites_value is returned as 0, which is honestly
-- correct for the overwhelming majority of salaried employees at this app's
-- target SME scale, but is NOT a confirmed 'this employee has no
-- perquisites.'" Both were right to flag it, not confirm it: an SME that
-- gives its GM a company flat or a company car is common, and until now
-- there was nowhere in this schema to record it. This migration is that
-- table, its Rule 3/Rule 15 valuation, and the one-field wire-in to
-- get_form16_partb the two migrations above already anticipated. It does
-- NOT touch 0430's regime/slab/surcharge chain (that migration, landed
-- concurrently in this same batch, owns it) and does NOT touch gross_salary,
-- old/new taxable income, or any tax computed on top of them — perquisites_
-- value remains a DISCLOSED line item on the certificate, not folded into
-- the tax base. See "WHY PERQUISITES VALUE DOES NOT FEED THE TAX BASE YET"
-- below for exactly why that is a real, stated limitation and not silently
-- swept under "future work."
--
-- ----------------------------------------------------------------------------
-- STATUTORY RESEARCH — Rule 3 (Income-tax Rules 1962) vs Rule 15 (Income-tax
-- Rules 2026), and why BOTH matter for a FY-labelled table
-- ----------------------------------------------------------------------------
-- FIRST PASS found what every recent explainer repeats: the Sep-2023 CBDT
-- amendment to (old) Rule 3(1) cut the rent-free-accommodation percentages
-- from 15/10/7.5% to 10/7.5/5%, retiering city population bands onto the
-- 2011 census (>40 lakh / 15-40 lakh / <15 lakh, replacing 2001 census'
-- >25 lakh / 10-25 lakh) — taxguru.in, PIB press release 1950509, BDO's and
-- KPMG's own client alerts, all agreeing. Motor car Rule 3(2) untouched by
-- that amendment: Rs 1,800/2,400 p.m. by cc class (mixed use, employer
-- bears running cost), Rs 900 p.m. more if a driver is provided; Rs 600/900
-- p.m. if the EMPLOYEE bears running cost instead (car still employer-
-- owned/hired) — taxguru.in's "Valuation of Motor Car" page, cross-checked
-- against the CAalley.com table below.
--
-- THE SKEPTICAL SECOND PASS is what actually mattered here, and it found a
-- genuinely new, dated, in-force change the first pass would have missed
-- entirely: the Income-tax Act 2025 (already this codebase's own 0205/0430
-- context) carries its OWN new subordinate rules — the Income-tax Rules,
-- 2026 — notified by CBDT vide Notification No. G.S.R. 198(E) dated 20 Mar
-- 2026, in force from 1 Apr 2026 (kpmg.com GMS Flash Alert 2026-081,
-- confirming the draft-to-notified transition; the 8 Feb 2026 draft and its
-- 15-day comment window are 2026-051, superseded by the notified text).
-- Perquisite valuation moves from old Rule 3 to NEW RULE 15. Two threads,
-- confirmed independently and cross-checked against EACH OTHER because they
-- pull in different directions:
--   * Residential accommodation (Rule 15(1)): the 10/7.5/5% tiers and the
--     >40-lakh/15-40-lakh/<15-lakh 2011-census bands are UNCHANGED — Rule 15
--     "codifies" the 2023 amendment rather than revising it again. Confirmed
--     by FOUR independent sources agreeing on the same three numbers and the
--     same two thresholds: a2ztaxcorp.net, taxcode.in's Rule-15 reproduction,
--     vialtopartners.com's employment-tax alert, and the original 2023
--     coverage (taxguru.in/BDO/KPMG/PIB) — a genuine cross-check catch:
--     patronaccounting.com's page (NOT relied on below) quoted a completely
--     different, stale 2001-census/15%-10%-5% table for the SAME "2026
--     Rules," internally contradicted by the other four sources and by its
--     own separately-fetched motor-car figures elsewhere on the same site
--     (which also didn't match its own car table) — exactly the kind of
--     casually-mis-cited figure this app's WebSearch discipline exists to
--     catch, caught here by requiring independent agreement before trusting
--     a number, not by picking whichever source looked more official.
--   * Motor car (Rule 15(3)): a REAL, large, dated increase, not a stale
--     figure — Rs 1,800/2,400 (mixed use, employer bears cost) becomes
--     Rs 5,000/7,000 p.m.; the Rs 900 driver addition becomes Rs 3,000 p.m.;
--     Rs 600/900 (employee bears running cost) becomes Rs 2,000/3,000 p.m.
--     Confirmed by FIVE independent sources landing on the identical numbers
--     — kpmg.com (flash-alert-2026-051), taxguru.in's "Decoding Draft
--     Income-tax Rules 2026," vialtopartners.com, a2ztaxcorp.net, and
--     caalley.com's full four-row table (the one source with every cell:
--     employer-bears-cost and employee-bears-cost, both cc classes, both
--     rule vintages side by side) — reused directly below because it is the
--     only source that actually gives the employee-bears-cost NEW-rule
--     figures with a citation trail rather than an extrapolated guess.
--     10% p.a. wear-and-tear for wholly-personal use is UNCHANGED (taxguru.
--     in's own Rule-15(3) quote: "10 per cent per annum of the actual cost
--     of the motor car").
--   * "cc <= 1.6 litre" now explicitly ALSO COVERS ELECTRIC VEHICLES under
--     Rule 15 wording (vialtopartners.com, taxcode.in both quote "cc of
--     engine does not exceed 1.6 litres OR the motor car is an electric
--     vehicle") — EVs have no cc rating at all, so Rule 15 states the
--     equivalence explicitly rather than leaving it to be inferred. Modelled
--     below as one enum value, up_to_1600cc_or_ev, for exactly that reason.
--   * "Salary" for Rule 15/Rule 3 valuation purposes (taxcode.in's
--     reproduction, cross-checked against the older Rule 3 Explanation via
--     taxguru.in/hostbooks.com): basic pay + DA (if it enters the
--     computation of retirement benefits) + bonus/commission + all other
--     TAXABLE monetary payments; EXCLUDES employer's PF contribution,
--     tax-exempt allowances, the value of perquisites themselves (avoiding
--     circularity), and lump-sum termination payments (gratuity, leave
--     encashment, VRS, pension commutation). See "THE SALARY BASE" below for
--     how this schema's fields map onto that definition, and the one
--     disclosed simplification (DA) it cannot resolve exactly.
--   * Effective-date boundary: Rule 15 governs FY 2026-27 onward (salary/
--     benefit PAID on or after 1 Apr 2026); FY 2025-26 and earlier stay on
--     old Rule 3. This is the SAME Apr-2026 boundary get_form16_partb (0205)
--     already draws for its own form_label — reused here, not re-derived,
--     via the identical fy_start_year >= 2026 test.
--   * The inflation-linked cap for accommodation CONTINUED beyond its first
--     year (value capped at first-year value x CII(this year)/CII(first
--     year), taxcode.in) is DELIBERATELY NOT MODELLED — see scope note.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION SCOPES IN, AND WHY EACH CUT IS A CUT, NOT A GUESS
-- ----------------------------------------------------------------------------
-- ACCOMMODATION: owned-by-employer (population-tiered %) and leased-by-
-- employer (lower of actual lease rent or 10% of salary) — the two Rule
-- 15(1) branches that cover the overwhelming majority of real cases. NOT
-- modelled: furniture (a SEPARATE Rule 3/15 addendum — 10% p.a. of
-- furniture cost or hire charges, on top of the accommodation value itself)
-- and hotel accommodation (a third, per-diem-based branch for short stays)
-- — both real Rule 15(1) sub-clauses this table has no fields for. Flagged
-- explicitly rather than silently valued at 0 alongside the accommodation
-- line, the same "0 is not a confirmed absence" distinction 0205 already
-- drew for the whole perquisites line.
--
-- COMPANY CAR: owned or hired BY THE EMPLOYER only — official / personal /
-- mixed use, cc class, who bears running cost, driver or not. This is
-- deliberately NOT the mirror-image Rule 15(3)(second table) case of a car
-- OWNED BY THE EMPLOYEE with the employer merely reimbursing running
-- expenses — a genuinely different sub-clause with its own (also revised)
-- figures. "Company car" in the task brief means the car is the company's
-- asset; an employee's own car with a reimbursed expense claim is closer to
-- a conveyance-allowance question than a "perquisite from an employer-
-- provided car," and is real, separate, un-researched scope, not built here.
--
-- OTHER: a residual bucket for any Sec 17(2)(viii) benefit not covered by
-- the two specific rules above (club membership, gym, gadgets, etc.),
-- valued the same way every unlisted perquisite has always been valued —
-- cost to the employer, less any amount recovered from the employee. No
-- further Rule reference needed; this is the residual valuation principle
-- itself, not a specific sub-rule.
--
-- WHY PERQUISITES VALUE DOES NOT FEED THE TAX BASE YET. Rule 15/Rule 3 value
-- a perquisite; Sec 17(1)(iv) then folds that value into "salary" for the
-- purpose of computing tax on it, exactly like any other salary component.
-- get_form16_partb's gross_salary, old_income_chargeable_salary, old_gross_
-- total_income, old_taxable_income and every new_* equivalent are ALL
-- computed upstream of the one line this migration is authorised to touch
-- (see the task's own explicit boundary, and 0430 landing in this same
-- batch on that exact chain). Folding perquisites into the actual tax base
-- would mean editing every one of those five-plus CTEs — precisely the
-- "regime, slab, or surcharge logic" this migration was told not to touch,
-- and a genuine collision risk against 0430's own concurrent edit to the
-- same function. So perquisites_value is wired in as an accurate, DISCLOSED
-- salary-annexure line (matching how Form 16 Part B / Form 130 Part C
-- itself presents it — a labelled line item the employer states, which then
-- separately feeds "income chargeable under the head Salaries" one row
-- down) rather than silently mixed into totals a sibling migration also
-- edits this run. The report page below states this explicitly rather than
-- implying the net-tax figure already reflects it.
--
-- THE SALARY BASE ("Rule 15/Rule 3 salary") THIS FUNCTION USES FOR
-- ACCOMMODATION. get_payroll_run (0075) exposes basic, dearness_allowance,
-- hra, special_allowance, other_allowance. This function sums basic +
-- dearness_allowance + special_allowance + other_allowance and EXCLUDES hra
-- — HRA is separately exempt/taxable under Sec 10(13A) and an employee
-- actually GIVEN employer accommodation essentially never also draws HRA in
-- practice (the two are mutually exclusive on any real payslip), so
-- excluding it avoids inventing a double-counted base for a combination
-- that shouldn't occur. DEARNESS ALLOWANCE IS A DISCLOSED SIMPLIFICATION:
-- the statutory base includes DA only "if it enters into the computation of
-- superannuation/retirement benefits," a fact employee_salary_structures
-- (0075) has no column for. Rather than silently drop DA (which would
-- UNDERSTATE the base for the — likely more common at SME scale — case
-- where it does apply) or silently include it always (which would OVERSTATE
-- it otherwise), this function includes it and states the imprecision here
-- and in the report UI, the identical "apply what the data can support,
-- disclose what it can't" choice 0093 and 0205 already made for their own
-- unresolvable facts (80D's age band, HRA's rent/city computation).
--
-- MONTHS_APPLICABLE AND PRORATION. Rule 15/Rule 3 value accommodation as a
-- % of salary EARNED DURING THE PERIOD the accommodation was actually
-- occupied, not full-year salary regardless of when it started. This table
-- has no per-voucher date range (matching the coarse, SME-appropriate grain
-- employee_tax_declarations already set at "one fact per employee per FY,"
-- not per pay period) — instead months_applicable (1-12) records how many
-- months of the FY the perquisite actually applied, and the salary base is
-- the employee's ACTUAL cumulative get_payroll_run salary for the FY,
-- scaled by months_applicable / months_actually_on_payroll_this_fy. For an
-- employee on payroll the whole FY with accommodation the whole FY, that
-- ratio is 12/12 = the full annual base, exactly right. For a mid-year
-- joiner given accommodation from day one, months_with_data and months_
-- applicable are both e.g. 6, ratio 1.0, applying their real 6-month
-- cumulative pay — also exactly right. Where the ratio is a genuine
-- approximation is a mid-year joiner whose accommodation started PARTWAY
-- INTO their (already partial) employment — a linear share of cumulative
-- pay stands in for "pay earned during that sub-window" without knowing
-- exactly which months. Disclosed, not hidden, in the report UI.
--
-- GRANTS. Two new functions (get_employee_perquisites_valued, get_employee_
-- perquisites_total) get the mandatory revoke-from-public/anon, grant-to-
-- authenticated pair below — the gap that has bitten this project four
-- times already. get_form16_partb is MODIFIED, not newly created, so its
-- existing grants (reasserted by 0205, unaffected by CREATE OR REPLACE with
-- an unchanged signature) are verified live after this migration rather
-- than reissued blind.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- employee_perquisites — one row per perquisite grant, per employee, per
-- financial year. A company car AND a company flat in the same FY are two
-- rows, not two columns on one row — matching employee_tax_declarations'
-- (0093) own "one fact, one row" grain rather than a wide table of optional
-- columns for every possible benefit.
-- ----------------------------------------------------------------------------
create table public.employee_perquisites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  financial_year_label text not null
    check (financial_year_label ~ '^\d{4}-\d{2}$'),
  perquisite_type text not null check (perquisite_type in ('accommodation', 'car', 'other')),

  -- How many months of the FY this perquisite actually applied. Governs
  -- both the salary-base proration (accommodation) and the flat-rate
  -- multiplication (car, mixed/personal use). See migration header.
  months_applicable smallint not null default 12
    check (months_applicable between 1 and 12),

  -- Universal netting: any amount the EMPLOYEE paid back to the employer
  -- for this benefit, applicable regardless of type (Rule 15(1)'s "reduced
  -- by rent recovered," Rule 15(3)'s "reduced by amount charged from the
  -- employee," and the residual "cost to employer less amount recovered"
  -- principle for 'other' are the same netting idea under three names).
  amount_recovered_from_employee numeric not null default 0
    check (amount_recovered_from_employee >= 0),

  -- ACCOMMODATION (Rule 15(1) / old Rule 3(1)) — meaningful only when
  -- perquisite_type = 'accommodation'.
  accommodation_ownership text
    check (accommodation_ownership in ('employer_owned', 'employer_leased')),
  city_population_tier text
    check (city_population_tier in ('above_40_lakh', '15_to_40_lakh', 'below_15_lakh')),
  -- Annual lease rent the EMPLOYER pays the landlord. Meaningful only for
  -- accommodation_ownership = 'employer_leased'; the value is the LOWER of
  -- this figure and 10% of the prorated salary base.
  lease_rent_paid_by_employer numeric not null default 0
    check (lease_rent_paid_by_employer >= 0),

  -- COMPANY CAR (Rule 15(3) / old Rule 3(2)) — meaningful only when
  -- perquisite_type = 'car'. Employer-owned/hired car only; see header for
  -- why the employee-owned-car-reimbursed variant is out of scope.
  car_cc_class text
    check (car_cc_class in ('up_to_1600cc_or_ev', 'above_1600cc')),
  car_usage text
    check (car_usage in ('official', 'personal', 'mixed')),
  -- Meaningful for car_usage = 'mixed' only (Rule 15(3)'s flat-rate table
  -- has a different figure depending who bears running/maintenance cost;
  -- 'personal' use is instead valued from actual cost, below, and
  -- 'official' use is nil either way).
  running_cost_borne_by text
    check (running_cost_borne_by in ('employer', 'employee')),
  driver_provided boolean not null default false,
  -- The following three are meaningful ONLY for car_usage = 'personal'
  -- (wholly-personal use), which Rule 15(3)(b)/old Rule 3(2)(b) values from
  -- ACTUAL cost, not the flat monthly table 'mixed' use uses.
  car_is_hired boolean not null default false,
  -- If car_is_hired: the actual ANNUAL hire charges paid. If not hired
  -- (employer-owned): the car's actual COST, on which 10% p.a. wear-and-tear
  -- is computed, prorated by months_applicable.
  car_actual_cost_or_hire_charges numeric not null default 0
    check (car_actual_cost_or_hire_charges >= 0),
  actual_running_maintenance_cost numeric not null default 0
    check (actual_running_maintenance_cost >= 0),
  driver_salary_paid_by_employer numeric not null default 0
    check (driver_salary_paid_by_employer >= 0),

  -- OTHER (residual Sec 17(2)(viii)) — meaningful only when
  -- perquisite_type = 'other'.
  other_perquisite_description text,
  other_cost_to_employer numeric not null default 0
    check (other_cost_to_employer >= 0),

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,

  foreign key (employee_id, company_id)
    references public.employees (id, company_id) on delete cascade,

  -- Type-gated field groups — matching employee_tax_declarations' (0093)
  -- own "a row of the wrong type cannot silently carry the other type's
  -- figures" discipline, so a CHECK catches a data-entry mistake instead of
  -- a stray field quietly being ignored (or, worse, quietly double-valued
  -- by a future reader who doesn't know to gate on perquisite_type first).
  constraint employee_perquisites_accommodation_required check (
    perquisite_type <> 'accommodation'
    or (accommodation_ownership is not null and city_population_tier is not null)
  ),
  constraint employee_perquisites_accommodation_only check (
    perquisite_type = 'accommodation'
    or (accommodation_ownership is null and city_population_tier is null
        and lease_rent_paid_by_employer = 0)
  ),
  constraint employee_perquisites_car_required check (
    perquisite_type <> 'car'
    or (car_cc_class is not null and car_usage is not null)
  ),
  constraint employee_perquisites_car_mixed_needs_cost_bearer check (
    perquisite_type <> 'car' or car_usage <> 'mixed' or running_cost_borne_by is not null
  ),
  constraint employee_perquisites_car_only check (
    perquisite_type = 'car'
    or (car_cc_class is null and car_usage is null and running_cost_borne_by is null
        and driver_provided = false and car_is_hired = false
        and car_actual_cost_or_hire_charges = 0 and actual_running_maintenance_cost = 0
        and driver_salary_paid_by_employer = 0)
  ),
  constraint employee_perquisites_other_required check (
    perquisite_type <> 'other' or other_perquisite_description is not null
  ),
  constraint employee_perquisites_other_only check (
    perquisite_type = 'other'
    or (other_perquisite_description is null and other_cost_to_employer = 0)
  )
);

create index employee_perquisites_lookup_idx
  on public.employee_perquisites (employee_id, financial_year_label);

create index employee_perquisites_company_idx
  on public.employee_perquisites (company_id);

create trigger set_updated_at before update on public.employee_perquisites
  for each row execute function app_private.set_updated_at();

comment on table public.employee_perquisites is
  'One row per Sec 17(2) perquisite grant (accommodation, company car, or a residual "other" benefit) per employee per financial year. Valued by get_employee_perquisites_valued() per Rule 15 (Income-tax Rules 2026, FY 2026-27 onward) or old Rule 3 (Income-tax Rules 1962, up to FY 2025-26) depending on the row''s financial_year_label. See 0500 for the full statutory citation trail, the DA/HRA salary-base simplification, and everything deliberately out of scope (furniture, hotel accommodation, employee-owned-car reimbursement, the CII inflation-linked accommodation cap).';

comment on column public.employee_perquisites.months_applicable is
  'How many months of the FY this perquisite actually applied (1-12). Prorates the accommodation salary base and multiplies the car flat-rate table. See 0500 header for the proration formula and its one disclosed approximation (a mid-year start partway into an already-partial employment).';

comment on column public.employee_perquisites.city_population_tier is
  'Rule 15(1)/old Rule 3(1) 2011-census population band the employee must classify the city into themselves — this app has no city/population reference table. above_40_lakh = 10% of salary, 15_to_40_lakh = 7.5%, below_15_lakh = 5%.';

comment on column public.employee_perquisites.car_cc_class is
  'up_to_1600cc_or_ev covers BOTH engines <=1.6 litre AND electric vehicles — Rule 15(3) states the EV equivalence explicitly (an EV has no cc rating), so this app mirrors it as one value rather than leaving EV unclassifiable.';

alter table public.employee_perquisites enable row level security;

-- Same bar as employee_tax_declarations (0093): compensation/benefit detail,
-- so write is admin-only, read is any company member.
create policy employee_perquisites_read on public.employee_perquisites
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy employee_perquisites_write on public.employee_perquisites
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));


-- ----------------------------------------------------------------------------
-- get_employee_perquisites_valued — every employee_perquisites row for one
-- employee/FY, with its Rule 15/Rule 3 taxable value computed. See the
-- migration header for the full rate tables and every source.
-- ----------------------------------------------------------------------------
create function public.get_employee_perquisites_valued(
  p_company_id uuid,
  p_employee_id uuid,
  p_financial_year_label text
)
returns table (
  perquisite_id uuid,
  perquisite_type text,
  months_applicable smallint,
  accommodation_ownership text,
  city_population_tier text,
  car_cc_class text,
  car_usage text,
  running_cost_borne_by text,
  driver_provided boolean,
  other_perquisite_description text,
  amount_recovered_from_employee numeric,
  rule_salary_base numeric,
  taxable_value numeric,
  computation_note text
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
  -- "Salary" for Rule 15(1)/old Rule 3(1) accommodation valuation: basic +
  -- DA + special + other allowance, excluding HRA. See migration header for
  -- why (mutual exclusivity in practice with company accommodation) and the
  -- disclosed DA simplification.
  salary_agg as (
    select
      count(*)::int as months_with_data,
      coalesce(sum(basic + dearness_allowance + special_allowance + other_allowance), 0) as annual_rule_salary
      from payroll
  ),
  rows as (
    select ep.*, p.fy_start_year, (p.fy_start_year >= 2026) as new_rule_applies
      from public.employee_perquisites ep
      cross join params p
     where ep.company_id = p_company_id
       and ep.employee_id = p_employee_id
       and ep.financial_year_label = p_financial_year_label
  ),
  based as (
    select
      r.*,
      round(sa.annual_rule_salary * (r.months_applicable::numeric / greatest(sa.months_with_data, 1)), 2)
        as prorated_salary_base
      from rows r
      cross join salary_agg sa
  )
  select
    b.id,
    b.perquisite_type,
    b.months_applicable,
    b.accommodation_ownership,
    b.city_population_tier,
    b.car_cc_class,
    b.car_usage,
    b.running_cost_borne_by,
    b.driver_provided,
    b.other_perquisite_description,
    b.amount_recovered_from_employee,
    case when b.perquisite_type = 'accommodation' then b.prorated_salary_base else 0 end as rule_salary_base,
    greatest(
      case b.perquisite_type
        when 'accommodation' then
          (case when b.accommodation_ownership = 'employer_owned' then
             b.prorated_salary_base * (
               case b.city_population_tier
                 when 'above_40_lakh' then 0.10
                 when '15_to_40_lakh' then 0.075
                 else 0.05
               end
             )
           else
             least(b.lease_rent_paid_by_employer, b.prorated_salary_base * 0.10)
           end) - b.amount_recovered_from_employee
        when 'car' then
          case b.car_usage
            when 'official' then 0
            when 'mixed' then
              (
                (case when b.new_rule_applies then
                   case when b.car_cc_class = 'up_to_1600cc_or_ev' then
                     case when b.running_cost_borne_by = 'employer' then 5000 else 2000 end
                   else
                     case when b.running_cost_borne_by = 'employer' then 7000 else 3000 end
                   end
                 else
                   case when b.car_cc_class = 'up_to_1600cc_or_ev' then
                     case when b.running_cost_borne_by = 'employer' then 1800 else 600 end
                   else
                     case when b.running_cost_borne_by = 'employer' then 2400 else 900 end
                   end
                 end)
                + (case when b.driver_provided
                        then (case when b.new_rule_applies then 3000 else 900 end)
                        else 0 end)
              ) * b.months_applicable - b.amount_recovered_from_employee
            when 'personal' then
              b.actual_running_maintenance_cost
              + b.driver_salary_paid_by_employer
              + (case when b.car_is_hired
                      then b.car_actual_cost_or_hire_charges
                      else round(b.car_actual_cost_or_hire_charges * 0.10 * (b.months_applicable::numeric / 12), 2)
                 end)
              - b.amount_recovered_from_employee
            else 0
          end
        when 'other' then b.other_cost_to_employer - b.amount_recovered_from_employee
        else 0
      end,
      0
    ) as taxable_value,
    case b.perquisite_type
      when 'accommodation' then
        (case when b.accommodation_ownership = 'employer_owned'
              then (case b.city_population_tier
                      when 'above_40_lakh' then '10% '
                      when '15_to_40_lakh' then '7.5% '
                      else '5% '
                    end) || 'of prorated salary (Rule 15(1)/old Rule 3(1), employer-owned, 2011-census population tier)'
              else 'lower of actual lease rent paid or 10% of prorated salary (Rule 15(1)/old Rule 3(1), employer-leased)'
         end)
      when 'car' then
        case b.car_usage
          when 'official' then 'Wholly official use — nil (assumes required journey-log documentation is kept outside this app; Rule 15(3)/old Rule 3(2)).'
          when 'mixed' then
            (case when b.new_rule_applies
                  then 'Rule 15(3), Income-tax Rules 2026 (FY 2026-27 onward)'
                  else 'Old Rule 3(2), Income-tax Rules 1962 (up to FY 2025-26)'
             end) || ' flat monthly rate x months applicable, minus amount recovered from employee.'
          when 'personal' then 'Wholly personal use — actual running/maintenance cost + driver salary + 10% p.a. wear-and-tear (or hire charges), Rule 15(3)(b)/old Rule 3(2)(b), minus amount recovered.'
          else null
        end
      when 'other' then 'Residual Sec 17(2)(viii) valuation — cost to employer minus amount recovered from employee.'
      else null
    end as computation_note
    from based b;
$fn$;

revoke all on function public.get_employee_perquisites_valued(uuid, uuid, text) from public, anon;
grant execute on function public.get_employee_perquisites_valued(uuid, uuid, text) to authenticated;

comment on function public.get_employee_perquisites_valued(uuid, uuid, text) is
  'Every employee_perquisites row for one employee/FY with its Rule 15 (FY 2026-27 onward) or old Rule 3 (up to FY 2025-26) taxable value computed. See 0500 for the full rate tables, salary-base definition and every source.';


-- ----------------------------------------------------------------------------
-- get_employee_perquisites_total — the scalar sum get_form16_partb wires
-- into its perquisites_value line.
-- ----------------------------------------------------------------------------
create function public.get_employee_perquisites_total(
  p_company_id uuid,
  p_employee_id uuid,
  p_financial_year_label text
)
returns numeric
language sql
stable
set search_path = ''
as $fn$
  select coalesce(sum(v.taxable_value), 0)
    from public.get_employee_perquisites_valued(p_company_id, p_employee_id, p_financial_year_label) v
$fn$;

revoke all on function public.get_employee_perquisites_total(uuid, uuid, text) from public, anon;
grant execute on function public.get_employee_perquisites_total(uuid, uuid, text) to authenticated;

comment on function public.get_employee_perquisites_total(uuid, uuid, text) is
  'Sum of get_employee_perquisites_valued() for one employee/FY — the figure get_form16_partb (0205) wires into its perquisites_value output column as of 0500. Does NOT feed gross_salary or any tax-base computation in get_form16_partb; see 0500 header for why that boundary is deliberate.';


-- ----------------------------------------------------------------------------
-- get_form16_partb — CREATE OR REPLACE, changing exactly one output
-- expression (perquisites_value: 0::numeric -> the real total above).
-- Every other line is byte-for-byte the live definition as of immediately
-- before this migration (captured via pg_get_functiondef, NOT re-typed from
-- 0205's or 0430's migration file text, to avoid drifting from whatever
-- 0430 actually landed) — regime/slab/surcharge logic, gross_salary, and
-- every old_*/new_* CTE are untouched. See migration header for why
-- perquisites_value does not additionally feed those CTEs.
-- ----------------------------------------------------------------------------
create or replace function public.get_form16_partb(p_company_id uuid, p_employee_id uuid, p_financial_year_label text)
 returns table(employee_id uuid, employee_name text, pan text, financial_year_label text, period_from date, period_to date, is_fy_complete boolean, form_label text, months_with_payroll_data integer, basic_total numeric, dearness_allowance_total numeric, hra_total numeric, special_allowance_total numeric, other_allowance_total numeric, gross_salary numeric, perquisites_value numeric, professional_tax_total numeric, declaration_exists boolean, declared_regime text, regime_used text, declaration_date date, hra_exemption_claimed numeric, deduction_80c_claimed numeric, deduction_80c_allowed numeric, deduction_80d_claimed numeric, deduction_80d_allowed numeric, home_loan_interest_24b_claimed numeric, home_loan_interest_24b_allowed numeric, previous_employer_income numeric, previous_employer_tds_deducted numeric, old_income_chargeable_salary numeric, old_gross_total_income numeric, old_chapter_via_deductions numeric, old_taxable_income numeric, old_tax_before_rebate numeric, old_rebate_87a numeric, old_surcharge numeric, old_cess numeric, old_net_tax_payable numeric, new_income_chargeable_salary numeric, new_taxable_income numeric, new_tax_before_rebate numeric, new_rebate_87a numeric, new_surcharge numeric, new_cess numeric, new_net_tax_payable numeric, net_tax_payable numeric, tds_deposited_per_payroll_projection numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
  -- New regime: Sec 87A marginal relief added by 0430 (Finance Act 2023
  -- proviso). Below Rs 12,00,000 the full-rebate branch is unchanged; above
  -- it, tax is capped at the excess of income over Rs 12,00,000 rather than
  -- dropping the rebate to zero outright.
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
    -- 0500: was 0::numeric ("not tracked, not a confirmed absence").
    -- get_employee_perquisites_total sums every employee_perquisites row
    -- (accommodation/car/other) for this employee/FY, valued per Rule 15
    -- (FY 2026-27 onward) or old Rule 3 (earlier). Deliberately NOT folded
    -- into gross_salary or any downstream tax-base CTE above — see 0500
    -- header, "WHY PERQUISITES VALUE DOES NOT FEED THE TAX BASE YET."
    (select public.get_employee_perquisites_total(p_company_id, p_employee_id, p_financial_year_label))
      as perquisites_value,
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
$function$;

comment on function public.get_form16_partb(uuid, uuid, text) is
  'Form 16 Part B (Form 130 Part C from FY 2026-27 — see 0205 header) for one employee/FY: annual salary summed from get_payroll_run (0075) across the FY''s 12 months, the employee''s Sec 115BAC(1A) declaration (employee_tax_declarations, 0093, "not declared" defaults to new regime per Circular 4/2023), a full BOTH-REGIMES tax computation with Sec 87A marginal relief on the new-regime side (0430), and perquisites_value from get_employee_perquisites_total (0500, Rule 15/old Rule 3) — disclosed as a salary-annexure line, not folded into gross_salary or the tax base (see 0500 header for why). Statutory bonus and exit gratuity/leave encashment are not included in gross_salary. See 0205/0430/0500 for the full statutory citation trail and every caveat.';
