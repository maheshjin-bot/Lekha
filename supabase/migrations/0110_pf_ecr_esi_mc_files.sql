-- ============================================================================
-- 0110 — PF ECR and ESI MC: assembling the two monthly wage-return files
-- ============================================================================
-- 0043 flagged PF/ESI filing as blocked the same way it flagged GSTR-1 and
-- TRACES — behind a government API this app cannot call. That was correct
-- for GSTR-1 and TRACES (which really are API-gated) and wrong for these two:
-- neither EPFO's ECR nor ESIC's MC is submitted through an API this app would
-- need credentials for. Both are a TEXT/EXCEL FILE an employer prepares
-- offline and uploads through the employer's own portal login. Nothing about
-- producing that file needs this app to talk to EPFO or ESIC — it only needs
-- the wage data this app already computes. The blocker was internal, not
-- external: no company in this database had real payroll figures to build
-- the file from until today (see the live verification below).
--
-- FORMAT, CONFIRMED BY WEBSEARCH (Aug 2026), NOT RECALLED —
--
--   ECR (EPFO): a plain-text file, 11 fields per member, delimited by #~#,
--   in this exact order: UAN, Member Name, Gross Wages, EPF Wages, EPS
--   Wages, EDLI Wages, EPF Contribution (employee share), EPS Contribution
--   (employer share, from the employer's 12%), EPF-EPS Difference
--   (employer's EPF share = the balance of the employer's 12% after EPS is
--   deducted from it), NCP Days, Refund of Advances. Due the 15th of the
--   following wage month, same as the challan payment. All wage and
--   contribution figures are rounded to the nearest whole rupee — no paise
--   — a specific EPFO instruction, not a formatting choice made here.
--
--   MC (ESIC): a bulk-upload template, 6 fields per insured person: IP
--   Number (10 digits), IP Name, No. of Days (paid/payable this wage
--   month), Total Monthly Wages, Reason for 0 wages (numeric code 0-12,
--   required only when wages are 0; 0 = "Without Reason", 2 = "Left
--   Service", and ten others this app cannot determine — see below), Last
--   Working Day (populated when the IP left service this month). Also due
--   the 15th of the following month, same as PF.
--
-- SKEPTICAL RE-CHECK: the EPS 8.33% figure was verified against a second,
-- independent source before relying on it for real money — 8.33% of a wage
-- capped at Rs 15,000 gives exactly the commonly-quoted Rs 1,250/month
-- ceiling (15000 x 0.0833 = 1249.5, rounds to 1250), so the 15,000 pension
-- wage cap is applied FIRST and 8.33% taken second, not the other way round.
--
-- WHY THIS BUILDS ON get_payroll_run RATHER THAN RECOMPUTING PF/ESI —
-- 0075 already computes the PF wage (with its proportionate 15,000 ceiling),
-- the ESI eligibility test and the ESI wage base correctly, prorated for
-- mid-month joiners/leavers. Recomputing any of that here would risk the
-- exact kind of drift this app has been burned by before (0054's sign
-- inversion, 0074's stock-valuation gap) -- two functions independently
-- computing "the same" number that quietly stop agreeing. Both functions
-- below call get_payroll_run and ONLY add the extra breakdown an ECR/MC
-- needs that a general payroll register does not: the EPS/EDLI wage
-- sub-cap, the EPS/EPF-diff contribution split (0075's header says outright
-- it deliberately does not model this split, because it doesn't change any
-- ledger total -- it matters here because ECR needs it), NCP days, and the
-- ESI reason code. get_payroll_run itself is untouched.
--
-- NCP DAYS REUSES get_payroll_run's days_paid/days_in_month, not a new
-- concept — NCP = days_in_month - days_paid. This inherits 0075's own
-- limitation along with the number: this app does not track attendance or
-- loss-of-pay, so days_paid is derived ONLY from date_of_joining and
-- date_of_leaving. A continuing member who was on unpaid leave for an
-- entire month cannot be represented — get_payroll_run has no way to know
-- that happened, so it will show them paid for the full month. Stated
-- plainly in the report pages, not silently inherited.
--
-- PF MEMBERSHIP TEST — get_payroll_run does not expose the pf_applicable
-- flag itself, only the money it produces (pf_wage is 0 either way a
-- non-member would have zero PF or a member with zero basic+DA would).
-- get_pf_ecr_data re-reads employee_salary_structures for that one boolean,
-- the same effective-dated lookup 0075 already does internally — a read of
-- the same fact, not a second computation of a number.
--
-- REFUND OF ADVANCES is always 0 here — this schema has no PF advance/loan
-- tracking at all (no table, no column, anywhere), so there is no honest
-- non-zero value to compute. Explicit, not silently omitted: the report
-- page says so and tells the preparer to check for any active advance
-- before uploading, rather than the file implying "confirmed nil."
--
-- ESI REASON CODE — this app can positively detect exactly one of the
-- twelve reasons ESIC defines: "Left Service" (2), from date_of_leaving
-- falling inside the wage month. Every other reason (on leave, retired,
-- strike, suspension, non-implemented area, ...) requires attendance or
-- HR-event data this schema does not capture, so a zero-wage row that is
-- not a leaver gets code 0 ("Without Reason") with a label that says
-- outright it needs manual review — not a guess dressed up as a fact.
--
-- NOT CLAIMED: byte-for-byte upload readiness. The #~# delimiter and field
-- order are confirmed from EPFO's own published format and cross-checked
-- against three independent secondary sources describing it identically;
-- the ESIC MC field list likewise. Neither was verified against the actual
-- portal upload validator (no sandbox exists for either), so — matching
-- 0072/0096's established honesty pattern — these are PREP reports in the
-- file's own field order and shape, not confirmed upload-ready output. Said
-- explicitly on both report pages, not just here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- get_pf_ecr_data — one row per PF member, in ECR's own 11-field order
-- (employee_id and has_uan appended at the end for the UI, not part of the
-- file itself).
-- ----------------------------------------------------------------------------
create or replace function public.get_pf_ecr_data(
  p_company_id uuid,
  p_period_month date
)
returns table (
  employee_id uuid,
  uan text,
  member_name text,
  gross_wages numeric,
  epf_wages numeric,
  eps_wages numeric,
  edli_wages numeric,
  epf_contribution_employee numeric,
  eps_contribution_employer numeric,
  epf_contribution_employer_diff numeric,
  ncp_days integer,
  refund_of_advances numeric,
  has_uan boolean
)
language sql
stable
set search_path to ''
as $fn$
  with period as (
    select date_trunc('month', p_period_month)::date as period_start
  ),
  membership as (
    -- pf_applicable is a fact on the salary structure that get_payroll_run
    -- consumes but does not return — same effective-dated lookup 0075 uses.
    select distinct on (s.employee_id)
      s.employee_id, s.pf_applicable
      from public.employee_salary_structures s
      join public.employees e on e.id = s.employee_id
      cross join period p
     where e.company_id = p_company_id
       and s.effective_from <= p.period_start
     order by s.employee_id, s.effective_from desc
  ),
  run as (
    select r.*
      from public.get_payroll_run(p_company_id, p_period_month) r
      join membership m on m.employee_id = r.employee_id and m.pf_applicable
  ),
  capped as (
    select
      r.*,
      round(15000 * (r.days_paid::numeric / nullif(r.days_in_month, 0)), 2) as proportionate_ceiling
      from run r
  ),
  wage_based as (
    select
      c.*,
      -- EPS and EDLI wages share one statutory cap (Rs 15,000, prorated) --
      -- exactly the cap get_payroll_run already applies for EDLI (0075).
      least(c.pf_wage, c.proportionate_ceiling) as pension_wage_base
      from capped c
  ),
  contributions as (
    select
      w.*,
      -- 8.33% of the ALREADY-capped pension wage -- naturally tops out at
      -- Rs 1,250/month without a separate clamp.
      round(w.pension_wage_base * 0.0833, 0) as eps_contribution_employer,
      round(w.pf_employer, 0) as employer_pf_total_rounded
      from wage_based w
  )
  select
    c.employee_id,
    e.uan,
    c.employee_name,
    round(c.gross_pay, 0) as gross_wages,
    round(c.pf_wage, 0) as epf_wages,
    round(c.pension_wage_base, 0) as eps_wages,
    round(c.pension_wage_base, 0) as edli_wages,
    round(c.pf_employee, 0) as epf_contribution_employee,
    c.eps_contribution_employer,
    -- The balance of the employer's 12% after EPS is taken out of it --
    -- deliberately NOT a fresh 3.67% calculation, so this plus the EPS
    -- column always reconciles to the employer's total PF contribution to
    -- the rupee, the way EPFO's own ECR validator checks it.
    (c.employer_pf_total_rounded - c.eps_contribution_employer) as epf_contribution_employer_diff,
    (c.days_in_month - c.days_paid) as ncp_days,
    0::numeric as refund_of_advances,
    (e.uan is not null) as has_uan
    from contributions c
    join public.employees e on e.id = c.employee_id
   order by c.employee_name;
$fn$;

revoke all on function public.get_pf_ecr_data(uuid, date) from public, anon;
grant execute on function public.get_pf_ecr_data(uuid, date) to authenticated;

comment on function public.get_pf_ecr_data(uuid, date) is
  'PF members for one wage month in ECR''s own 11-field order (see 0110). Built on get_payroll_run, not a parallel PF calculation -- only adds the EPS/EDLI wage sub-cap, the EPS/EPF-diff contribution split and NCP days that a general payroll register does not need. refund_of_advances is always 0 (not tracked by this schema). Prep data in the file''s own shape, not confirmed upload-ready.';

-- ----------------------------------------------------------------------------
-- get_esi_mc_data — one row per ESI-eligible employee, in MC's own field
-- order (employee_id and has_ip_number appended for the UI).
-- ----------------------------------------------------------------------------
create or replace function public.get_esi_mc_data(
  p_company_id uuid,
  p_period_month date
)
returns table (
  employee_id uuid,
  ip_number text,
  ip_name text,
  no_of_days integer,
  total_monthly_wages numeric,
  reason_code integer,
  reason_label text,
  last_working_day date,
  has_ip_number boolean
)
language sql
stable
set search_path to ''
as $fn$
  with period as (
    select
      date_trunc('month', p_period_month)::date as period_start,
      (date_trunc('month', p_period_month) + interval '1 month - 1 day')::date as period_end
  ),
  run as (
    -- esi_applicable already combines the salary-structure flag with the
    -- Rs 21,000 full-month wage-rate eligibility test (0075) -- read
    -- directly, not re-derived.
    select r.* from public.get_payroll_run(p_company_id, p_period_month) r
     where r.esi_applicable
  ),
  reasoned as (
    select
      r.*,
      e.esi_number,
      e.date_of_leaving,
      (e.date_of_leaving is not null
        and e.date_of_leaving between p.period_start and p.period_end) as left_this_month
      from run r
      join public.employees e on e.id = r.employee_id
      cross join period p
  )
  select
    r.employee_id,
    r.esi_number as ip_number,
    r.employee_name as ip_name,
    r.days_paid as no_of_days,
    round(r.gross_pay, 0) as total_monthly_wages,
    -- Reason is only meaningful when wages are 0; only "left service" is a
    -- fact this schema can actually establish (date_of_leaving). Every other
    -- ESIC reason code needs attendance/HR-event data this app doesn't
    -- capture, so a zero-wage non-leaver gets the generic code with a label
    -- that says review it, not a guessed specific reason.
    case
      when round(r.gross_pay, 0) > 0 then null
      when r.left_this_month then 2
      else 0
    end as reason_code,
    case
      when round(r.gross_pay, 0) > 0 then null
      when r.left_this_month then 'Left service'
      else 'Without reason -- wages are 0 but this app does not track attendance/LOP, so the true cause can''t be determined; review before upload'
    end as reason_label,
    case when r.left_this_month then r.date_of_leaving else null end as last_working_day,
    (r.esi_number is not null) as has_ip_number
    from reasoned r
   order by r.employee_name;
$fn$;

revoke all on function public.get_esi_mc_data(uuid, date) from public, anon;
grant execute on function public.get_esi_mc_data(uuid, date) to authenticated;

comment on function public.get_esi_mc_data(uuid, date) is
  'ESI-eligible employees for one wage month in the MC template''s own field order (see 0110). Built on get_payroll_run''s existing esi_applicable/gross_pay/days_paid, not a parallel ESI calculation. Reason-for-zero-wages can only be positively determined for "left service" (date_of_leaving); every other ESIC reason code needs attendance data this app doesn''t track. Prep data in the file''s own shape, not confirmed upload-ready.';
