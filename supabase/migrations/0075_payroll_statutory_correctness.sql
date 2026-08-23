-- ============================================================================
-- 0075 — Payroll: four defects that each produce a wrong number every month
-- ============================================================================
-- All four live in get_payroll_run / post_payroll_run, so they are fixed
-- together rather than as four migrations each rewriting the same function.
--
-- (1) SALARY TDS WAS COMPUTED AND THEN NOT DEDUCTED.
--
-- get_salary_tds_estimate (0049) already returns a per-employee monthly_tds.
-- Nothing consumed it. get_payroll_run's net_pay was
--     gross - pf_employee - esi_employee - professional_tax
-- with no TDS term, and payroll_ledger_map's CHECK had seven purposes, none of
-- them TDS, so post_payroll_run could not have posted the liability even if it
-- had wanted to. The app therefore computed the correct withholding and then
-- paid it to the employee anyway -- a Sec 201(1) default plus 201(1A)
-- interest, self-inflicted, every month. Worse than not knowing.
--
-- Honest limit, stated rather than buried: the estimate takes NO employee
-- declarations -- no 80C, no HRA exemption, no previous-employer income, no
-- regime election (employees has 11 columns and none of them is any of
-- those). It is a pure new-regime projection of 12 x current gross. That is
-- defensible as the DEFAULT position, because 115BAC(1A) is the default
-- regime and an employee must opt out of it, so deducting on that basis is
-- what Sec 192 requires absent a declaration. It is still an estimate, and
-- the declarations feature stays open.
--
-- Slab data re-verified before wiring it to real money rather than trusted
-- from the 0049 era: Budget 2026 (1 Feb 2026) changed neither regime's slabs,
-- so the seeded 0/5/10/15/20/25/30 bands, the 75,000 standard deduction and
-- the 60,000 87A rebate up to 12,00,000 taxable all remain correct for
-- FY 2026-27. Note ref_income_tax_slabs has NO effective-date column at all,
-- which is worth fixing separately -- the dossier calls for version-dated
-- rule sets and this table is a flat snapshot.
--
-- Salary TDS gets its OWN ledger rather than reusing the general "TDS Payable"
-- every company already carries for vendor TDS. Sec 192 salary TDS and Sec
-- 194x vendor TDS are deposited under different section codes and reconciled
-- against different returns; mixing them would corrupt the balance
-- get_tds_deductee_summary reports against.
--
-- (2) THE PF WAGE BASE OMITTED DEARNESS ALLOWANCE.
--
-- pf_wage was `least(basic, 15000)` -- basic alone. The statutory PF wage is
-- basic + DA (+ retaining allowance); EPFO's own admin-charge formula is
-- literally "(Basic Wages + DA + Retaining Allowance) x rate". There was no DA
-- column on employee_salary_structures at all, so every employer paying DA had
-- PF understated on BOTH sides. DA is added as a real salary component: it
-- flows into gross pay, the PF wage base, the ESI wage base and the TDS
-- projection, because it is wages for all four.
--
-- (3) EDLI AND EPF ADMIN CHARGES WERE MISSING ENTIRELY.
--
-- Employer PF cost was a flat 12%. The real employer outgo also carries:
--   * A/c 21 EDLI          0.50% of PF wages, ceiling 15,000, so at most 75
--                          per member per month. Genuinely per-employee.
--   * A/c 2  admin charges 0.50% of total EPF wages, MINIMUM 500 per month
--                          PER ESTABLISHMENT (75 for a non-functional
--                          establishment with no contributory member).
--                          Establishment-level, NOT per employee -- which is
--                          why it is computed once in post_payroll_run and
--                          never appears as a per-employee column. A
--                          per-employee admin charge would be a fiction, and
--                          the minimum makes it one that cannot even be
--                          allocated proportionately without lying.
--   * A/c 22 EDLI admin    NIL since 1 April 2017. Deliberately not
--                          implemented; noted so nobody re-adds it.
-- Rates confirmed against current sources before coding, not recalled.
--
-- Both ride the existing employer_pf_expense / pf_payable pair rather than
-- getting their own ledgers: they are employer costs remitted on the same PF
-- challan, so separate ledgers would fragment a balance that has to be
-- reassembled to pay it.
--
-- The EPS 8.33 / EPF 3.67 split of the employer's own 12% is deliberately NOT
-- modelled. That split matters for filling the challan, but both halves are
-- already inside the 12% -- it is presentational, not a money error, and
-- conflating it with these two genuine omissions would be a mistake.
--
-- (4) A MID-MONTH JOINER OR LEAVER WAS PAID FOR THE WHOLE MONTH.
--
-- The only date logic was `date_of_joining <= period_end` and
-- `date_of_leaving >= period_start` -- a pass/fail filter, not a calculation.
-- Someone joining on the 28th was paid a full month's salary, and
-- post_payroll_run then booked the overpayment as fact. This is the only one
-- of the four that produces a wrong PAYMENT rather than a wrong accrual.
--
-- Now prorated by days actually in employment within the month. Three
-- deliberate refinements:
--   * ESI ELIGIBILITY is tested against the FULL monthly gross, because it is
--     a wage-RATE test -- a high earner joining on the 28th must not become
--     ESI-eligible just because their part-month pay is small. The ESI
--     CONTRIBUTION is then computed on wages actually paid.
--   * The PF wage ceiling is applied PROPORTIONATELY (15,000 x the day
--     factor), so a half-month employee on a high salary does not attract the
--     same PF as a full-month one.
--   * Professional tax is NOT prorated -- it is a fixed monthly slab amount,
--     not a rate on wages -- but it is dropped entirely when no days are paid.
--
-- EXPLICITLY OUT OF SCOPE: attendance, loss-of-pay days, leave balances. Those
-- need a capture table that does not exist, and guessing at them would be
-- worse than the honest gap. This fixes only what the joining and leaving
-- dates already tell us for certain. TDS is NOT prorated either --
-- get_salary_tds_estimate projects 12 x current gross regardless of a mid-year
-- join, which over-projects for a joiner. A guard below caps the deduction at
-- what is actually available so net pay can never go negative (which would
-- also break create_voucher's own balance check); the projection itself is
-- left for the declarations work.
-- ============================================================================

alter table public.employee_salary_structures
  add column if not exists dearness_allowance numeric not null default 0;

comment on column public.employee_salary_structures.dearness_allowance is
  'Dearness allowance. Part of the statutory PF wage base (basic + DA), the ESI wage base and taxable salary -- not a cosmetic component. See 0075.';

alter table public.payroll_ledger_map
  drop constraint payroll_ledger_map_purpose_check;

alter table public.payroll_ledger_map
  add constraint payroll_ledger_map_purpose_check
  check (purpose = any (array[
    'salary_expense', 'employer_pf_expense', 'employer_esi_expense',
    'pf_payable', 'esi_payable', 'professional_tax_payable',
    'net_pay_payable', 'tds_payable'
  ]));

-- ----------------------------------------------------------------------------
-- Ledger seeding: one new ledger for salary TDS
-- ----------------------------------------------------------------------------
create or replace function app_private.seed_payroll_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_indirect_expense uuid;
  v_duty_tax uuid;
  v_outstanding uuid;
begin
  select id into v_indirect_expense from public.account_groups
   where company_id = p_company_id and parent_group_id is null and name = 'Indirect Expenses';
  select id into v_duty_tax from public.account_groups
   where company_id = p_company_id and name = 'Duties & Taxes';
  select id into v_outstanding from public.account_groups
   where company_id = p_company_id and name = 'Outstanding Expenses';

  if v_indirect_expense is null or v_duty_tax is null or v_outstanding is null then
    raise exception 'Chart of accounts is missing a standard group; seed it first';
  end if;

  perform app_private.seed_one_payroll_ledger(p_company_id, v_indirect_expense, 'Salary Expense', 'salary_expense', 'debit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_indirect_expense, 'Employer PF Contribution', 'employer_pf_expense', 'debit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_indirect_expense, 'Employer ESI Contribution', 'employer_esi_expense', 'debit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'PF Payable', 'pf_payable', 'credit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'ESI Payable', 'esi_payable', 'credit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'Professional Tax Payable', 'professional_tax_payable', 'credit');
  -- Distinct from the general "TDS Payable" every company already carries for
  -- vendor TDS: different section code, different return, different challan.
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'TDS Payable (Salary)', 'tds_payable', 'credit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_outstanding, 'Salaries Payable', 'net_pay_payable', 'credit');
end;
$fn$;

-- ----------------------------------------------------------------------------
-- TDS estimate: DA is taxable salary too
-- ----------------------------------------------------------------------------
create or replace function public.get_salary_tds_estimate(
  p_company_id uuid,
  p_period_month date
)
returns table (
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
set search_path to ''
as $fn$
  with period as (
    select date_trunc('month', p_period_month)::date as period_start
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
  projected as (
    select
      e.id as employee_id,
      e.name as employee_name,
      (ls.basic + ls.dearness_allowance + ls.hra + ls.special_allowance + ls.other_allowance) as monthly_gross,
      (ls.basic + ls.dearness_allowance + ls.hra + ls.special_allowance + ls.other_allowance) * 12 as annual_projected_gross
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
$fn$;

revoke all on function public.get_salary_tds_estimate(uuid, date) from public, anon;
grant execute on function public.get_salary_tds_estimate(uuid, date) to authenticated;

-- ----------------------------------------------------------------------------
-- The run itself. DROP first: the return type gains columns.
-- ----------------------------------------------------------------------------
drop function if exists public.get_payroll_run(uuid, date);

create function public.get_payroll_run(
  p_company_id uuid,
  p_period_month date
)
returns table (
  employee_id uuid,
  employee_name text,
  days_in_month integer,
  days_paid integer,
  basic numeric,
  dearness_allowance numeric,
  hra numeric,
  special_allowance numeric,
  other_allowance numeric,
  gross_pay numeric,
  pf_wage numeric,
  pf_employee numeric,
  pf_employer numeric,
  edli_employer numeric,
  esi_applicable boolean,
  esi_employee numeric,
  esi_employer numeric,
  professional_tax numeric,
  tds numeric,
  net_pay numeric
)
language sql
stable
set search_path to ''
as $fn$
  with period as (
    select date_trunc('month', p_period_month)::date as period_start,
           (date_trunc('month', p_period_month) + interval '1 month - 1 day')::date as period_end
  ),
  latest_structure as (
    select distinct on (s.employee_id)
      s.employee_id, s.basic, s.dearness_allowance, s.hra, s.special_allowance, s.other_allowance,
      s.pf_applicable, s.pf_wage_ceiling_applies, s.esi_applicable, s.professional_tax_monthly
      from public.employee_salary_structures s
      join public.employees e on e.id = s.employee_id
      cross join period p
     where e.company_id = p_company_id
       and s.effective_from <= p.period_start
     order by s.employee_id, s.effective_from desc
  ),
  tds_estimate as (
    select t.employee_id, t.monthly_tds
      from public.get_salary_tds_estimate(p_company_id, p_period_month) t
  ),
  dated as (
    select
      e.id as employee_id,
      e.name as employee_name,
      ls.basic, ls.dearness_allowance, ls.hra, ls.special_allowance, ls.other_allowance,
      ls.pf_applicable, ls.pf_wage_ceiling_applies, ls.esi_applicable,
      ls.professional_tax_monthly,
      coalesce(te.monthly_tds, 0) as monthly_tds,
      extract(day from p.period_end)::int as days_in_month,
      greatest(
        (least(p.period_end, coalesce(e.date_of_leaving, p.period_end))
         - greatest(p.period_start, e.date_of_joining)) + 1
      , 0)::int as days_paid
      from public.employees e
      join latest_structure ls on ls.employee_id = e.id
      left join tds_estimate te on te.employee_id = e.id
      cross join period p
     where e.company_id = p_company_id
       and e.date_of_joining <= p.period_end
       and (e.date_of_leaving is null or e.date_of_leaving >= p.period_start)
       and e.is_active
  ),
  factored as (
    select
      d.*,
      -- The day factor. Everything that is a rate on wages scales by it;
      -- eligibility TESTS deliberately do not (see the header).
      (d.days_paid::numeric / nullif(d.days_in_month, 0)) as factor,
      (d.basic + d.dearness_allowance + d.hra + d.special_allowance + d.other_allowance)
        as full_month_gross
      from dated d
  ),
  prorated as (
    select
      f.*,
      round(f.basic * f.factor, 2)              as paid_basic,
      round(f.dearness_allowance * f.factor, 2) as paid_da,
      round(f.hra * f.factor, 2)                as paid_hra,
      round(f.special_allowance * f.factor, 2)  as paid_special,
      round(f.other_allowance * f.factor, 2)    as paid_other,
      round(15000 * f.factor, 2)                as proportionate_pf_ceiling
      from factored f
  ),
  computed as (
    select
      p.*,
      (p.paid_basic + p.paid_da + p.paid_hra + p.paid_special + p.paid_other) as paid_gross,
      case when p.pf_applicable then
        case when p.pf_wage_ceiling_applies
             then least(p.paid_basic + p.paid_da, p.proportionate_pf_ceiling)
             else p.paid_basic + p.paid_da end
      else 0 end as computed_pf_wage,
      -- ESI eligibility is a wage-RATE test, so it reads the full month.
      (p.esi_applicable and p.full_month_gross <= 21000) as esi_applies
      from prorated p
  ),
  amounts as (
    select
      c.*,
      round(c.computed_pf_wage * 0.12, 2) as pf_each_side,
      -- EDLI: 0.50% of PF wages, always capped at the 15,000 ceiling (applied
      -- proportionately here) even when the member's own PF ceiling is waived.
      case when c.pf_applicable
           then round(least(c.computed_pf_wage, c.proportionate_pf_ceiling) * 0.005, 2)
           else 0 end as edli,
      case when c.esi_applies then round(c.paid_gross * 0.0075, 2) else 0 end as esi_ee,
      case when c.esi_applies then round(c.paid_gross * 0.0325, 2) else 0 end as esi_er,
      -- A fixed monthly slab amount, not a rate on wages: not prorated, but
      -- not charged at all in a month with no paid days.
      case when c.days_paid > 0 then c.professional_tax_monthly else 0 end as pt
      from computed c
  )
  select
    a.employee_id,
    a.employee_name,
    a.days_in_month,
    a.days_paid,
    a.paid_basic, a.paid_da, a.paid_hra, a.paid_special, a.paid_other,
    a.paid_gross,
    a.computed_pf_wage,
    a.pf_each_side as pf_employee,
    a.pf_each_side as pf_employer,
    a.edli as edli_employer,
    a.esi_applies as esi_applicable,
    a.esi_ee as esi_employee,
    a.esi_er as esi_employer,
    a.pt as professional_tax,
    -- Never deduct more TDS than the month can actually bear. The estimate
    -- projects 12 x full-month gross, so for a mid-month joiner it can exceed
    -- the whole part-month pay; a negative net pay would also be rejected by
    -- create_voucher's own balance check.
    least(
      greatest(a.monthly_tds, 0),
      greatest(a.paid_gross - a.pf_each_side - a.esi_ee - a.pt, 0)
    ) as tds,
    round(
      a.paid_gross - a.pf_each_side - a.esi_ee - a.pt
      - least(
          greatest(a.monthly_tds, 0),
          greatest(a.paid_gross - a.pf_each_side - a.esi_ee - a.pt, 0)
        )
    , 2) as net_pay
    from amounts a
   order by a.employee_name;
$fn$;

revoke all on function public.get_payroll_run(uuid, date) from public, anon;
grant execute on function public.get_payroll_run(uuid, date) to authenticated;

comment on function public.get_payroll_run(uuid, date) is
  'Monthly payroll, prorated by days in employment. PF wage is basic + DA (proportionate 15,000 ceiling); employer cost includes EDLI (A/c 21). EPF admin charges (A/c 2) are establishment-level and appear only in post_payroll_run. Salary TDS is deducted per get_salary_tds_estimate, capped at what the month can bear. See 0075.';

-- ----------------------------------------------------------------------------
-- Posting: EDLI, establishment-level admin charges, and the TDS liability
-- ----------------------------------------------------------------------------
create or replace function public.post_payroll_run(
  p_company_id uuid,
  p_branch_id uuid,
  p_period_month date
)
returns uuid
language plpgsql
set search_path to ''
as $fn$
declare
  v_period_start date := date_trunc('month', p_period_month)::date;
  v_period_end date := (date_trunc('month', p_period_month) + interval '1 month - 1 day')::date;
  v_voucher_id uuid;
  v_gross numeric; v_pf_employee numeric; v_pf_employer numeric;
  v_edli numeric; v_pf_wage_total numeric; v_admin numeric;
  v_esi_employee numeric; v_esi_employer numeric; v_pt numeric;
  v_tds numeric; v_net_pay numeric;
  v_salary_exp uuid; v_pf_exp uuid; v_esi_exp uuid;
  v_pf_pay uuid; v_esi_pay uuid; v_pt_pay uuid; v_tds_pay uuid; v_net_pay_ledger uuid;
  v_lines jsonb := '[]'::jsonb;
begin
  if exists (
    select 1 from public.payroll_postings
     where company_id = p_company_id and period_month = v_period_start
  ) then
    raise exception 'Payroll for % has already been posted', to_char(v_period_start, 'Mon YYYY');
  end if;

  select
      coalesce(sum(gross_pay), 0), coalesce(sum(pf_employee), 0), coalesce(sum(pf_employer), 0),
      coalesce(sum(edli_employer), 0), coalesce(sum(pf_wage), 0),
      coalesce(sum(esi_employee), 0), coalesce(sum(esi_employer), 0),
      coalesce(sum(professional_tax), 0), coalesce(sum(tds), 0), coalesce(sum(net_pay), 0)
    into v_gross, v_pf_employee, v_pf_employer, v_edli, v_pf_wage_total,
         v_esi_employee, v_esi_employer, v_pt, v_tds, v_net_pay
    from public.get_payroll_run(p_company_id, v_period_start);

  if v_gross = 0 then
    raise exception 'No employee has an active salary structure for %', to_char(v_period_start, 'Mon YYYY');
  end if;

  -- EPF administrative charges (A/c 2): 0.50% of total EPF wages, minimum 500
  -- per month for the ESTABLISHMENT. Per-establishment is why this is computed
  -- here on the total rather than per employee in get_payroll_run -- the
  -- minimum cannot be allocated across members without inventing a number.
  -- Charged only when there is at least one contributory member this month;
  -- the 75 non-functional-establishment minimum is a different case (no
  -- contributory members at all) and is not modelled, since a payroll run with
  -- no PF wages posts no PF at all.
  v_admin := case when v_pf_wage_total > 0
                  then greatest(round(v_pf_wage_total * 0.005, 2), 500)
                  else 0 end;

  perform app_private.seed_payroll_ledgers(p_company_id);

  select ledger_id into v_salary_exp from public.payroll_ledger_map where company_id = p_company_id and purpose = 'salary_expense';
  select ledger_id into v_pf_exp from public.payroll_ledger_map where company_id = p_company_id and purpose = 'employer_pf_expense';
  select ledger_id into v_esi_exp from public.payroll_ledger_map where company_id = p_company_id and purpose = 'employer_esi_expense';
  select ledger_id into v_pf_pay from public.payroll_ledger_map where company_id = p_company_id and purpose = 'pf_payable';
  select ledger_id into v_esi_pay from public.payroll_ledger_map where company_id = p_company_id and purpose = 'esi_payable';
  select ledger_id into v_pt_pay from public.payroll_ledger_map where company_id = p_company_id and purpose = 'professional_tax_payable';
  select ledger_id into v_tds_pay from public.payroll_ledger_map where company_id = p_company_id and purpose = 'tds_payable';
  select ledger_id into v_net_pay_ledger from public.payroll_ledger_map where company_id = p_company_id and purpose = 'net_pay_payable';

  -- Omit zero-amount lines: voucher_entries' own check constraint requires
  -- exactly one of debit_amount/credit_amount to be strictly positive, so a
  -- zero/zero line (e.g. no employee had ESI applicable this month) would
  -- be rejected, not just redundant.
  if v_gross > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_salary_exp, 'debit_amount', v_gross));
  end if;
  -- EDLI and admin charges are employer PF cost, remitted on the same challan.
  if (v_pf_employer + v_edli + v_admin) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_pf_exp, 'debit_amount', v_pf_employer + v_edli + v_admin));
  end if;
  if v_esi_employer > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_esi_exp, 'debit_amount', v_esi_employer));
  end if;
  if (v_pf_employee + v_pf_employer + v_edli + v_admin) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_pf_pay, 'credit_amount', v_pf_employee + v_pf_employer + v_edli + v_admin));
  end if;
  if (v_esi_employee + v_esi_employer) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_esi_pay, 'credit_amount', v_esi_employee + v_esi_employer));
  end if;
  if v_pt > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_pt_pay, 'credit_amount', v_pt));
  end if;
  if v_tds > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_tds_pay, 'credit_amount', v_tds));
  end if;
  if v_net_pay > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_net_pay_ledger, 'credit_amount', v_net_pay));
  end if;

  v_voucher_id := public.create_voucher(
    p_company_id := p_company_id,
    p_branch_id := p_branch_id,
    p_voucher_type := 'journal',
    p_voucher_date := v_period_end,
    p_lines := v_lines,
    p_narration := 'Payroll for ' || to_char(v_period_start, 'Mon YYYY')
  );

  insert into public.payroll_postings (company_id, period_month, voucher_id, posted_by)
  values (p_company_id, v_period_start, v_voucher_id, auth.uid());

  return v_voucher_id;
end;
$fn$;

revoke all on function public.post_payroll_run(uuid, uuid, date) from public, anon;
grant execute on function public.post_payroll_run(uuid, uuid, date) to authenticated;

comment on function public.post_payroll_run(uuid, uuid, date) is
  'Posts a month''s payroll as one journal. Employer PF expense carries the 12% employer share plus EDLI (A/c 21) plus establishment-level EPF admin charges (A/c 2, 0.50% of total EPF wages, minimum 500/month). Salary TDS is credited to its own TDS Payable (Salary) ledger, separate from vendor TDS. See 0075.';
