-- ============================================================================
-- 0043 — Payroll (P12) core: employee master, salary structure, payroll run
-- ============================================================================
-- First slice of Payroll, gated by the existing `payroll` (optional tier)
-- and `payroll_statutory` (conditional, PF/ESI/PT — 0004) modules, both
-- already seeded but unbuilt until now.
--
-- SCOPE, DELIBERATELY NARROW — mirrors the fixed-assets precedent (0025):
-- book depreciation is REPORTED, not journal-posted, until a later phase.
-- Payroll here is the same shape: get_payroll_run() COMPUTES a month's
-- payroll from employee master + salary structure data; it does not create
-- a voucher, does not persist a "payroll run" as its own row, and does not
-- touch ledgers or account_groups at all. Posting to the books (Salary
-- Expense Dr, PF/ESI/PT Payable Cr, Net Pay Payable Cr) is real, future
-- work, not attempted here — running the same computation twice for the
-- same month must currently give the same answer both times, which is
-- easiest to guarantee by not persisting run state yet.
--
-- ALSO NOT IN THIS SLICE, each because it needs data or logic well beyond
-- a first cut:
--   * TDS on salary (Sec 192) — needs an annual income projection per
--     employee (regime election, HRA exemption computation, Chapter VI-A
--     declarations) closely related to but genuinely separate from
--     get_income_tax_computation's own slab logic. Net pay here is gross
--     minus PF/ESI/PT only; salary TDS is a real future addition.
--   * PF ECR / ESI return FILE FORMATS — government-specific file layouts,
--     the same shape as GSTR/TRACES e-filing being blocked on API access
--     elsewhere in this app. The EPS-vs-EPF internal split (relevant only
--     to the ECR file, not to what a company owes in total) is not broken
--     out here either — pf_employer is one number, the total employer
--     contribution.
--   * Mid-month proration for a joiner/leaver — a full month's salary
--     structure amount is used regardless of actual days worked in a
--     partial month; day-based proration is not computed.
--   * Salary revisions mid-flow: a later effective_from row on the same
--     employee correctly supersedes an earlier one for periods on/after
--     it (see get_payroll_run below), but there is no UI yet to browse an
--     employee's salary HISTORY, only to add a new current one.
--
-- STATUTORY FIGURES, researched fresh, not carried from memory:
--   EPF: 12% of PF wage from BOTH employee and employer (employer's 12%
--   internally splits into EPS 8.33%/EPF 3.67%, capped by the same PF
--   wage ceiling — not broken out here, see above). PF wage is basic pay,
--   capped at Rs 15,000/month unless the employer has elected to
--   contribute on the full (uncapped) basic — modelled as a per-employee
--   pf_wage_ceiling_applies flag, defaulting to the capped (standard)
--   case.
--   ESI: 0.75% employee / 3.25% employer of GROSS wages (not just basic),
--   only when gross wages are at or under the Rs 21,000/month ceiling —
--   frozen at this rate and threshold since July 2019 (rate) and January
--   2017 (ceiling) respectively, unchanged for FY 2025-26/2026-27. The
--   higher Rs 25,000 ceiling for persons with disabilities is not
--   modelled — a single ceiling is applied to every employee.
--   Professional Tax: NOT computed from a rate table — PT is levied by
--   roughly 20 of India's 28 states plus some UTs, each with its own slab
--   structure (several states levy none at all), revised independently of
--   any central schedule, capped only by the Constitution's own Rs 2,500/
--   year ceiling (Article 276). Hardcoding every state's current slab
--   table risked being wrong somewhere and silently staying wrong — the
--   user enters the monthly PT figure per employee directly, the same
--   resolution already used throughout this session for facts LEKHA
--   cannot safely derive on its own (msme_category, is_related_party,
--   sec43b_category, and more).
-- ============================================================================

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  pan text check (app_private.is_valid_pan(pan)),
  uan text,
  esi_number text,
  date_of_joining date not null,
  date_of_leaving date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  check (date_of_leaving is null or date_of_leaving >= date_of_joining)
);

create index employees_company_idx on public.employees(company_id, is_active);

create trigger set_updated_at before update on public.employees
  for each row execute function app_private.set_updated_at();

comment on table public.employees is
  'Payroll employee master. UAN (PF) and ESI number are free-text, not format-validated — unlike PAN, neither has a single fixed checksum-able pattern LEKHA can verify.';

create table public.employee_salary_structures (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null,
  company_id uuid not null,
  effective_from date not null,
  basic numeric not null check (basic >= 0),
  hra numeric not null default 0 check (hra >= 0),
  special_allowance numeric not null default 0 check (special_allowance >= 0),
  other_allowance numeric not null default 0 check (other_allowance >= 0),
  pf_applicable boolean not null default true,
  pf_wage_ceiling_applies boolean not null default true,
  esi_applicable boolean not null default true,
  professional_tax_monthly numeric not null default 0 check (professional_tax_monthly >= 0),
  created_at timestamptz not null default now(),
  foreign key (employee_id, company_id) references public.employees (id, company_id) on delete cascade,
  unique (employee_id, effective_from)
);

create index employee_salary_structures_lookup_idx
  on public.employee_salary_structures(employee_id, effective_from desc);

comment on table public.employee_salary_structures is
  'Effective-dated CTC breakup per employee — a new row with a later effective_from supersedes the prior one for any payroll period on or after it, the prior row stays for periods before. pf_wage_ceiling_applies=true caps PF wage at the statutory Rs 15,000 basic; false uses the employee''s actual (uncapped) basic, for employers who have elected to contribute PF on full pay.';

-- ----------------------------------------------------------------------------
-- Row level security — employee data carries PAN and (indirectly) salary,
-- so write access is admin-only, same bar as godowns; read is any member.
-- ----------------------------------------------------------------------------
alter table public.employees enable row level security;
alter table public.employee_salary_structures enable row level security;

create policy employees_read on public.employees
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy employees_write on public.employees
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

create policy employee_salary_structures_read on public.employee_salary_structures
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy employee_salary_structures_write on public.employee_salary_structures
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

-- ----------------------------------------------------------------------------
-- get_payroll_run(company, period_month)
-- One row per employee eligible for the month (joined on/before the period
-- end, not yet left before the period start, currently active), using each
-- employee's latest salary structure effective on or before the period.
-- ----------------------------------------------------------------------------
create or replace function public.get_payroll_run(
  p_company_id uuid,
  p_period_month date
) returns table (
  employee_id uuid,
  employee_name text,
  basic numeric,
  hra numeric,
  special_allowance numeric,
  other_allowance numeric,
  gross_pay numeric,
  pf_wage numeric,
  pf_employee numeric,
  pf_employer numeric,
  esi_applicable boolean,
  esi_employee numeric,
  esi_employer numeric,
  professional_tax numeric,
  net_pay numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with period as (
    select date_trunc('month', p_period_month)::date as period_start,
           (date_trunc('month', p_period_month) + interval '1 month - 1 day')::date as period_end
  ),
  latest_structure as (
    select distinct on (s.employee_id)
      s.employee_id, s.basic, s.hra, s.special_allowance, s.other_allowance,
      s.pf_applicable, s.pf_wage_ceiling_applies, s.esi_applicable, s.professional_tax_monthly
      from public.employee_salary_structures s
      join public.employees e on e.id = s.employee_id
      cross join period p
     where e.company_id = p_company_id
       and s.effective_from <= p.period_start
     order by s.employee_id, s.effective_from desc
  ),
  computed as (
    select
      e.id as employee_id,
      e.name as employee_name,
      ls.basic, ls.hra, ls.special_allowance, ls.other_allowance,
      (ls.basic + ls.hra + ls.special_allowance + ls.other_allowance) as gross_pay,
      case when ls.pf_applicable
        then (case when ls.pf_wage_ceiling_applies then least(ls.basic, 15000) else ls.basic end)
        else 0
      end as pf_wage,
      (ls.esi_applicable and (ls.basic + ls.hra + ls.special_allowance + ls.other_allowance) <= 21000) as esi_applies,
      ls.professional_tax_monthly
      from public.employees e
      join latest_structure ls on ls.employee_id = e.id
      cross join period p
     where e.company_id = p_company_id
       and e.date_of_joining <= p.period_end
       and (e.date_of_leaving is null or e.date_of_leaving >= p.period_start)
       and e.is_active
  )
  select
    employee_id,
    employee_name,
    basic, hra, special_allowance, other_allowance,
    gross_pay,
    pf_wage,
    round(pf_wage * 0.12, 2) as pf_employee,
    round(pf_wage * 0.12, 2) as pf_employer,
    esi_applies as esi_applicable,
    case when esi_applies then round(gross_pay * 0.0075, 2) else 0 end as esi_employee,
    case when esi_applies then round(gross_pay * 0.0325, 2) else 0 end as esi_employer,
    professional_tax_monthly as professional_tax,
    round(
      gross_pay
      - round(pf_wage * 0.12, 2)
      - (case when esi_applies then round(gross_pay * 0.0075, 2) else 0 end)
      - professional_tax_monthly
    , 2) as net_pay
    from computed
   order by employee_name;
$$;

comment on function public.get_payroll_run is
  'One month''s payroll computation: gross pay, PF (12%/12%, PF wage capped at Rs 15,000 unless pf_wage_ceiling_applies=false), ESI (0.75%/3.25% of gross, only when gross <= Rs 21,000), professional tax (as entered on the salary structure, not computed from a state slab table), and net pay. Report-only — does not post a voucher or persist run state; TDS on salary (Sec 192) is not deducted from net pay here. See the migration header for the full scope.';

-- ----------------------------------------------------------------------------
-- delete_company: cascade the two new tables too (belt-and-braces — the FKs
-- above already cascade on their own, matching the existing pattern of
-- listing every tenant table explicitly rather than relying on cascade alone).
-- ----------------------------------------------------------------------------
create or replace function public.delete_company(p_company_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can delete a company';
  end if;

  delete from public.employee_salary_structures where company_id = p_company_id;
  delete from public.employees            where company_id = p_company_id;
  delete from public.vouchers            where company_id = p_company_id;
  delete from public.tax_ledger_map      where company_id = p_company_id;
  delete from public.bank_statement_lines where company_id = p_company_id;
  delete from public.items               where company_id = p_company_id;
  delete from public.godowns             where company_id = p_company_id;
  delete from public.ledgers             where company_id = p_company_id;
  delete from public.companies           where id = p_company_id;
  delete from public.audit_log           where company_id = p_company_id;
end;
$$;
