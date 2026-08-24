-- ============================================================================
-- 0130 — Payroll cluster: earned leave, gratuity, and full-and-final exit
-- ============================================================================
-- ONE COHERENT BUILD, not four unrelated features. Leave and gratuity share
-- an exit-date and a wage-base calculation; the F&F screen is an aggregator
-- with nothing of its own to compute once those two exist; the muster
-- roll/wage register (0131 territory, see the report file) fall out of
-- get_payroll_run (0075) almost for free. AS 15/Ind AS 19 actuarial gratuity
-- PROVISIONING is explicitly NOT built here — that is a certified actuary's
-- job, an ongoing balance-sheet estimate over ALL employed staff. What this
-- migration computes is the different thing: the determinate, arithmetic,
-- payable-ON-EXIT statutory gratuity amount for one employee who has
-- actually left or is about to — a plain 15/26 formula, no actuarial
-- judgement involved at all.
--
-- WHICH LAW GOVERNS THIS, TODAY — re-checked live, not carried over from
-- training data, and it is genuinely NOT what the task brief's own framing
-- ("Payment of Gratuity Act 1972... Factories Act / Shops & Establishments
-- Act") assumed. 0109 (statutory bonus, 23 Aug 2026) already hit this same
-- wall for the Bonus Act and left the same discipline behind: confirm
-- "which Act governs THIS today" before citing a section number. A live
-- search (Aug 2026) confirms the four Labour Codes — Code on Wages 2019,
-- Code on Social Security 2020, the OSH Code 2020, and the Industrial
-- Relations Code 2020 — were brought into force by central notification
-- S.O. 5319(E) dated 21 November 2025, repealing the Payment of Gratuity
-- Act 1972, the Payment of Bonus Act 1965, the Factories Act 1948's leave
-- chapter and the state Shops & Establishments Acts' leave provisions
-- (subsumed, not merely amended) among others. The CODES THEMSELVES are
-- central law and apply everywhere in India from that date — no state can
-- opt out of the substantive entitlement. What genuinely IS still patchy as
-- of this session's "today" (24 Aug 2026) is PROCEDURAL: each state must
-- separately notify its own rules (register formats, inspector process),
-- and as of August 2026 only a small minority of states/UTs had finalised
-- rules under all four codes. That patchiness affects paperwork mechanics,
-- not the substantive formula below — Sec 53 (gratuity), Sec 32 (OSH Code,
-- leave) and Sec 17(2) (Code on Wages, settlement timeline) are themselves
-- central-Act text, not something a state rule can alter. Every section
-- number cited in this migration's code comments is the CODE's own, not
-- the repealed Act's — matching 0109's own discipline, even though this
-- header still says "Gratuity Act" / "gratuity" in prose for readability.
--
-- GRATUITY — CODE ON SOCIAL SECURITY 2020, SECTION 53 (replaces the 1972
-- Act's Sec 4 almost verbatim in substance; confirmed via the Code's own
-- bare-act text, not a summary):
--   Eligibility: continuous service of not less than FIVE YEARS on
--     termination by superannuation, retirement, resignation, or
--     termination — WAIVED entirely on death or disablement (Sec 53(1)
--     proviso), whatever the actual tenure. Modelled below as an exact
--     calendar test — exit_date >= date_of_joining + 5 years — not the
--     "4 years + 240 days is a deemed 5th year" doctrine some High Courts
--     (Madras HC among them) have applied to the OLD Act: that doctrine is
--     genuinely contested across jurisdictions, not settled national law,
--     and this app does not encode disputed case law any more than it
--     encodes a disputed valuation method elsewhere. A genuinely NEW carve-
--     out the Code adds: Sec 53(6) reduces the threshold to ONE YEAR,
--     pro-rata, for FIXED-TERM employees specifically. NOT modelled —
--     employees (0043) has no employment_type/fixed-term column at all, so
--     this app cannot currently tell a fixed-term hire from a permanent
--     one. Stated as a scope gap below and in the report UI, not silently
--     dropped.
--   Formula (Sec 53(2)): 15 days' wages, at the rate of wages last drawn,
--     for every completed year of service "or part thereof in excess of
--     six months" — i.e. a part-year rounds UP to a full year only if the
--     leftover EXCEEDS six months (6 months and 0 days exactly does NOT
--     round up; 6 months and 1 day does). Implemented via age()'s own
--     normalised year/month/day parts, not a /365.25 approximation, which
--     is exactly the kind of boundary this app's own PT/TDS day-counting
--     precedent (0075's proration) treats as worth getting exactly right.
--     "Wages last drawn" is 15/26 of a MONTH — the 26 is calendar days in a
--     month less four Sundays, the same constant the 1972 Act always used
--     and the Code carries forward unchanged.
--   Ceiling: Rs 20,00,000 (raised from Rs 10,00,000 by a 29 Mar 2018
--     notification under the old Act; re-confirmed live for Aug 2026 — no
--     further revision found, and the Code's own Sec 53(2) proviso
--     preserves a Central-Government-notified ceiling in the same place
--     the old Act's Sec 4(3) did).
--   Payment timeline: Sec 53(7)/(8) — within 30 days of it becoming
--     payable, with mandatory simple interest on a delay not attributable
--     to the employee. This is DELIBERATELY DIFFERENT from the wage
--     settlement timeline below — gratuity is not "wages" and keeps its
--     own 30-day clock, not the 2-working-day one.
--
-- THE WAGE BASE ITSELF CHANGED, AND THIS IS THE GENUINE CORRECTION THIS
-- MIGRATION MAKES THAT A "PORT THE OLD ACT FORWARD UNEXAMINED" PASS WOULD
-- HAVE MISSED. The 1972 Act's Sec 2(s) "wages" was effectively basic + DA.
-- The Code on Social Security 2020's OWN "wages" definition (Sec 2(88)) is
-- the same harmonised definition Sec 2(y) of the Code on Wages 2019 uses
-- everywhere else in this app's payroll (0075's PF-wage reasoning already
-- rests on it): basic + DA (+ retaining allowance, which this schema does
-- not carry as a separate component and treats as zero) — SUBJECT TO A
-- FLOOR. The first proviso to Sec 2(88)/2(y): if the excluded components
-- (HRA, conveyance, special allowance, etc.) exceed 50% of total
-- remuneration, the EXCESS over that 50% is added back into "wages". Worked
-- through algebraically (excluded = total − basic/DA, excess-over-half =
-- excluded − 0.5×total), the add-back collapses to one clean rule:
--     statutory wage = GREATEST(basic + DA, 0.5 × total remuneration)
-- — i.e. wages can never be structured below half of what an employee is
-- actually paid, for gratuity OR for leave encashment (same harmonised
-- definition, same 26-day-month rate, used for both below). This is a
-- LIVE, material change from the pre-Nov-2025 position multiple sources
-- flagged the same way 0109 flagged the 60%/67% bonus-surplus split — many
-- employers had historically structured a low basic specifically to keep
-- PF/gratuity liability down, and that structuring no longer works: this
-- app's own get_payroll_run (0075) does NOT yet apply this floor to the PF
-- wage base it computes monthly (it still uses basic+DA alone), which is a
-- real, separate gap this migration does not fix — flagged in
-- caveats_for_integration, out of scope for THIS task (payroll posting
-- correctness, not the leave/gratuity/F&F cluster this migration builds).
--
-- LEAVE — OCCUPATIONAL SAFETY, HEALTH AND WORKING CONDITIONS CODE 2020,
-- SECTION 32 (replaces the Factories Act 1948 Sec 79 / the state Shops &
-- Establishments Acts' leave chapters, in force nationally since the same
-- 21 Nov 2025 notification):
--   Eligibility: 180 days worked in a calendar year (DOWN from the
--     Factories Act's 240 — a genuine reduction, not a typo; re-verified
--     live because it read like the "obvious" unchanged figure).
--   Accrual: one day of leave for every 20 days worked (unchanged from the
--     old Sec 79 rate for adult workers).
--   Carry-forward: capped at 30 days; any balance ABOVE 30 at a calendar
--     year's end must be ENCASHED, not merely capped — a mandatory
--     employer obligation, not a discretionary policy.
--   Applies broadly ("all establishments", appropriate Government may
--     extend further) — genuinely MORE uniform across India post-Nov-2025
--     than the old patchwork of state Shops Act leave rules this app's own
--     Professional Tax precedent (0043/0085/0108) still correctly refuses
--     to hardcode. That patchwork precedent is why the numbers below are
--     STILL made configurable per company rather than hardcoded, even
--     though they are now central-Code figures — an establishment that is
--     itself under a more generous CONTRACTUAL leave policy, or one whose
--     State has not yet finished notifying its own procedural rules, needs
--     the override same as the PT and bonus-applicability precedents this
--     app already set. The task's own instruction was explicit on this
--     point: a configurable per-company setting with a sensible documented
--     default, not a second hardcoded universal table.
--   NOT MODELLED, stated plainly rather than faked: the 180-day annual
--     ELIGIBILITY test and the calendar-year-end lapse/mandatory-encashment
--     trigger. Both need a "days actually WORKED" capture this app does not
--     have — 0075's own header already draws this exact line for payroll
--     proration ("attendance, loss-of-pay days, leave balances... need a
--     capture table that does not exist"). What IS built below is the
--     simplification the task brief itself asked for instead: leave
--     accrues by a configurable MONTHLY rate from date of joining (default
--     1.25 days/month, which is exactly 15 days/year — the commonly-quoted
--     private-sector EL entitlement, and algebraically what Sec 32's own
--     20:1 rate implies for a ~300-working-day year: 300/20 = 15 ÷ 12
--     months ≈ 1.25), prorated for a joining/leaving month by days-in-
--     employment the same way get_payroll_run already prorates pay. The
--     30-day cap is SURFACED (excess_over_cap on the balances report/RPC)
--     rather than auto-encashed — auto-generating a money-moving ledger
--     entry with no human review, on a date this app cannot verify is
--     really the company's calendar year-end trigger point, would be worse
--     than the honest gap; a manual "record encashment" action reads the
--     surfaced excess and lets a person confirm it.
--
-- FULL & FINAL SETTLEMENT TIMELINE — CODE ON WAGES 2019, SECTION 17(2),
-- also in force since 21 Nov 2025: ALL WAGES payable to an employee whose
-- employment is terminated — by the employer, by resignation, or by
-- retrenchment/closure — must be paid within TWO WORKING DAYS. This is a
-- genuine unification: pre-Code, the "2 days" figure existed only for
-- employer-initiated termination/retrenchment/layoff in most States' model
-- standing orders, while a resignation typically only had to be settled by
-- the next normal wage cycle. Sec 17(2) now applies the 2-working-day clock
-- uniformly regardless of exit reason. GRATUITY IS NOT "WAGES" under this
-- test and keeps its own separate 30-day Sec 53(7) clock (above) — the two
-- timelines are shown separately in the F&F screen, not conflated into one
-- "days remaining" figure.
--
-- SCOPE OF public.employee_exit_settlements: a SNAPSHOT taken when a
-- settlement is finalised, not a live-recomputing view — the gratuity
-- formula depends on "wages last drawn" and the leave balance at the exit
-- date, both of which must be frozen at settlement time rather than
-- drifting if a salary structure or leave ledger is edited afterward. One
-- row per employee (an employee record does not get re-hired in this
-- schema — a genuine re-hire needs a new employee row, same limitation
-- documents/notices-style single-entity tables already carry elsewhere in
-- this app). Finalising SETS employees.date_of_leaving/is_active — the
-- same pair 0043 already carries — rather than inventing a parallel status
-- flag, and records a real 'encashed' leave-ledger transaction for the
-- full balance so a later balances report reads zero, not stale.
--
-- NO LEDGER POSTING in this migration, for gratuity OR for F&F — the task
-- brief itself treats a report as "the safe minimum deliverable" for
-- gratuity and does not ask for F&F posting at all. Payment of an actual
-- settlement remains an ordinary voucher a bookkeeper enters by hand
-- (or, TDS on gratuity in excess of the Sec 10(10) exemption, salary TDS
-- for the exit-month part-pay, and Sec 192(2) previous-employer figures
-- all interact with income tax machinery this migration does not attempt
-- to re-derive here) — flagged in scope_deferred, not silently assumed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Company-level leave settings — same flat-column-on-companies convention
-- as stock_margin_percent/debtor_margin_percent/debtor_eligibility_days,
-- not a new settings sub-table, for consistency with how every other
-- per-company numeric knob in this app already lives.
-- ----------------------------------------------------------------------------
alter table public.companies
  add column if not exists leave_accrual_days_per_month numeric not null default 1.25
    check (leave_accrual_days_per_month >= 0),
  add column if not exists leave_carry_forward_cap_days numeric not null default 30
    check (leave_carry_forward_cap_days >= 0);

comment on column public.companies.leave_accrual_days_per_month is
  'Earned leave accrued per month employed, prorated by days-in-employment for a joining/leaving month. Default 1.25 (= 15 days/year) approximates OSH Code 2020 Sec 32''s 1-day-per-20-worked-days rate for a ~300 working-day year — this app has no attendance/days-worked capture (see 0075), so a monthly rate is the documented simplification the feature was scoped to. Configurable per company because an establishment''s own policy, or its State''s not-yet-notified procedural rules, may differ — same reasoning this app already applies to Professional Tax and bonus applicability rather than hardcoding one national number.';

comment on column public.companies.leave_carry_forward_cap_days is
  'Leave balance above this is flagged as due for mandatory encashment (OSH Code 2020 Sec 32(6), default 30 days — a national figure, not State-varying, but still configurable for a more generous contractual policy). Not auto-encashed: excess is surfaced on the balances report/RPC for a human to action.';

-- ----------------------------------------------------------------------------
-- app_private.get_employee_statutory_wage — the harmonised Sec 2(88)/Sec
-- 2(y) "wages" figure (basic + DA, floored at 50% of total remuneration),
-- shared by gratuity and leave encashment below. Internal helper, not a
-- public RPC — same app_private convention as seed_one_payroll_ledger
-- (0047), no grant boilerplate needed since PostgREST never sees this
-- schema.
-- ----------------------------------------------------------------------------
create or replace function app_private.get_employee_statutory_wage(
  p_company_id uuid,
  p_employee_id uuid,
  p_as_of date
) returns numeric
language sql
stable
set search_path to ''
as $$
  select greatest(
           s.basic + s.dearness_allowance,
           round(0.5 * (s.basic + s.dearness_allowance + s.hra + s.special_allowance + s.other_allowance), 2)
         )
    from public.employee_salary_structures s
   where s.employee_id = p_employee_id
     and s.company_id = p_company_id
     and s.effective_from <= p_as_of
   order by s.effective_from desc
   limit 1
$$;

comment on function app_private.get_employee_statutory_wage is
  'The Sec 2(88) (Code on Social Security)/Sec 2(y) (Code on Wages) harmonised "wages" figure as of a date: basic + DA, floored at 50% of total remuneration (basic+DA+HRA+special+other) per the first proviso''s add-back mechanic, algebraically simplified to GREATEST(basic+DA, 0.5*total) — see 0130. Returns null if the employee has no salary structure effective by that date.';

-- ----------------------------------------------------------------------------
-- Earned-leave ledger. One row per accrual/availed/encashed/adjustment
-- transaction — a running ledger, same "sum the rows for a balance" shape
-- as every financial ledger in this app, not a single mutable balance
-- column, so history stays auditable. Scoped to EARNED LEAVE only: casual
-- and sick leave carry no statutory encashment right and are pure company
-- policy with no formula to hand-verify against, so this migration does
-- not model them — a real, stated scope line, not an oversight.
-- ----------------------------------------------------------------------------
create table public.employee_leave_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  entry_type text not null check (entry_type in ('accrual', 'availed', 'encashed', 'adjustment')),
  transaction_date date not null,
  -- Set only for entry_type='accrual': the first-of-month this accrual
  -- covers. Drives the one-accrual-per-employee-per-month uniqueness below;
  -- null for every other entry_type.
  period_month date,
  -- Signed: positive credits the balance (accrual, or a correcting
  -- adjustment), negative debits it (availed, encashed, or a correcting
  -- adjustment the other way). Enforced by entry_type below rather than
  -- left to convention.
  days numeric not null check (days <> 0),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),

  foreign key (employee_id, company_id)
    references public.employees (id, company_id) on delete cascade,

  check (
    (entry_type = 'accrual' and days > 0 and period_month is not null)
    or (entry_type = 'availed' and days < 0)
    or (entry_type = 'encashed' and days < 0)
    or (entry_type = 'adjustment')
  )
);

-- One accrual per employee per month — mirrors payroll_postings' own
-- one-post-per-month discipline (0047), enforced the same way: a partial
-- unique index accrue_leave_for_month relies on for ON CONFLICT DO NOTHING
-- rather than silently double-crediting a re-run.
create unique index employee_leave_ledger_one_accrual_per_month
  on public.employee_leave_ledger (employee_id, period_month)
  where entry_type = 'accrual';

create index employee_leave_ledger_lookup_idx
  on public.employee_leave_ledger (company_id, employee_id, transaction_date);

comment on table public.employee_leave_ledger is
  'Earned-leave transactions: accrual (monthly, from accrue_leave_for_month only), availed, encashed, adjustment. Sum of days as of a date is the balance — see get_leave_balance. Scoped to earned/annual leave (OSH Code 2020 Sec 32) only, not casual/sick leave, which carry no statutory encashment right. See 0130.';

alter table public.employee_leave_ledger enable row level security;

create policy employee_leave_ledger_read on public.employee_leave_ledger
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy employee_leave_ledger_write on public.employee_leave_ledger
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

-- ----------------------------------------------------------------------------
-- Full-and-final settlement snapshots. See the migration header for why
-- this is a frozen snapshot, not a live view, and why it is one row per
-- employee.
-- ----------------------------------------------------------------------------
create table public.employee_exit_settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  exit_date date not null,
  exit_reason text not null check (exit_reason in (
    'resignation', 'retirement', 'termination', 'death', 'disablement', 'contract_expiry'
  )),

  unpaid_salary_amount numeric not null default 0 check (unpaid_salary_amount >= 0),

  leave_encashment_days numeric not null default 0 check (leave_encashment_days >= 0),
  leave_encashment_amount numeric not null default 0 check (leave_encashment_amount >= 0),

  gratuity_eligible boolean not null,
  gratuity_ineligibility_reason text,
  gratuity_completed_years numeric,
  gratuity_last_drawn_wage numeric,
  gratuity_amount numeric not null default 0 check (gratuity_amount >= 0),

  bonus_amount numeric not null default 0 check (bonus_amount >= 0),
  recoveries_amount numeric not null default 0 check (recoveries_amount >= 0),

  net_payable numeric not null,

  notes text,
  finalized_by uuid references auth.users(id),
  finalized_at timestamptz not null default now(),

  foreign key (employee_id, company_id)
    references public.employees (id, company_id) on delete cascade,

  -- One settlement per employee — a genuine re-hire needs a new employee
  -- row in this schema, same limitation this app's other single-entity
  -- tables already carry. Re-finalizing overwrites via record_fnf_settlement's
  -- own upsert, not a second row.
  unique (employee_id)
);

comment on table public.employee_exit_settlements is
  'One frozen snapshot per employee, written by record_fnf_settlement: unpaid salary (user-entered — see 0130 header for why this is not auto-derived), leave encashment and gratuity (both server-computed from get_leave_balance/get_gratuity_computation at exit_date), bonus and recoveries (user-entered), net_payable = sum of credits less recoveries. Does not post to the ledger — see 0130.';

alter table public.employee_exit_settlements enable row level security;

create policy employee_exit_settlements_read on public.employee_exit_settlements
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy employee_exit_settlements_write on public.employee_exit_settlements
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

-- ----------------------------------------------------------------------------
-- get_leave_balance — sum of the ledger as of a date. The single source of
-- truth every other leave function below reads from.
-- ----------------------------------------------------------------------------
create or replace function public.get_leave_balance(
  p_company_id uuid,
  p_employee_id uuid,
  p_as_of date default current_date
) returns numeric
language sql
stable
set search_path to ''
as $$
  select coalesce(sum(days), 0)
    from public.employee_leave_ledger
   where company_id = p_company_id
     and employee_id = p_employee_id
     and transaction_date <= p_as_of
$$;

revoke all on function public.get_leave_balance(uuid, uuid, date) from public, anon;
grant execute on function public.get_leave_balance(uuid, uuid, date) to authenticated;

-- ----------------------------------------------------------------------------
-- get_leave_balances — every employee, one row each, with the accrual cap
-- excess surfaced for the report page and the "encash the excess" nudge.
-- ----------------------------------------------------------------------------
create or replace function public.get_leave_balances(
  p_company_id uuid,
  p_as_of date default current_date
) returns table (
  employee_id uuid,
  employee_name text,
  date_of_joining date,
  accrued numeric,
  availed numeric,
  encashed numeric,
  adjusted numeric,
  balance numeric,
  carry_forward_cap numeric,
  excess_over_cap numeric
)
language sql
stable
set search_path to ''
as $$
  select
    e.id,
    e.name,
    e.date_of_joining,
    coalesce(sum(l.days) filter (where l.entry_type = 'accrual'), 0),
    coalesce(-sum(l.days) filter (where l.entry_type = 'availed'), 0),
    coalesce(-sum(l.days) filter (where l.entry_type = 'encashed'), 0),
    coalesce(sum(l.days) filter (where l.entry_type = 'adjustment'), 0),
    coalesce(sum(l.days), 0) as balance,
    c.leave_carry_forward_cap_days,
    greatest(coalesce(sum(l.days), 0) - c.leave_carry_forward_cap_days, 0)
    from public.employees e
    join public.companies c on c.id = e.company_id
    left join public.employee_leave_ledger l
      on l.employee_id = e.id and l.company_id = e.company_id and l.transaction_date <= p_as_of
   where e.company_id = p_company_id
   group by e.id, e.name, e.date_of_joining, c.leave_carry_forward_cap_days
   order by e.name
$$;

revoke all on function public.get_leave_balances(uuid, date) from public, anon;
grant execute on function public.get_leave_balances(uuid, date) to authenticated;

-- ----------------------------------------------------------------------------
-- accrue_leave_for_month — the monthly run, one row per eligible employee,
-- prorated by days-in-employment the same way get_payroll_run (0075)
-- prorates pay. Idempotent via the partial unique index: re-running for an
-- already-accrued month/employee inserts nothing more for that pair, no
-- exception raised (a mixed month — some employees newly eligible, others
-- already accrued from an earlier run — should not fail wholesale).
-- ----------------------------------------------------------------------------
create or replace function public.accrue_leave_for_month(
  p_company_id uuid,
  p_period_month date
) returns table (
  employee_id uuid,
  days_accrued numeric
)
language plpgsql
set search_path to ''
as $fn$
declare
  v_period_start date := date_trunc('month', p_period_month)::date;
  v_period_end date := (date_trunc('month', p_period_month) + interval '1 month - 1 day')::date;
  v_rate numeric;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can run leave accrual';
  end if;

  select leave_accrual_days_per_month into v_rate
    from public.companies where id = p_company_id;

  if v_rate is null then
    raise exception 'Company not found';
  end if;

  return query
  insert into public.employee_leave_ledger (
    company_id, employee_id, entry_type, transaction_date, period_month, days, notes, created_by
  )
  select
    p_company_id,
    e.id,
    'accrual',
    v_period_end,
    v_period_start,
    round(
      v_rate * (
        (least(v_period_end, coalesce(e.date_of_leaving, v_period_end))
         - greatest(v_period_start, e.date_of_joining) + 1)::numeric
        / extract(day from v_period_end)::numeric
      ), 2
    ),
    'Monthly accrual for ' || to_char(v_period_start, 'Mon YYYY'),
    auth.uid()
    from public.employees e
   where e.company_id = p_company_id
     and e.is_active
     and e.date_of_joining <= v_period_end
     and (e.date_of_leaving is null or e.date_of_leaving >= v_period_start)
     and (least(v_period_end, coalesce(e.date_of_leaving, v_period_end))
          - greatest(v_period_start, e.date_of_joining) + 1) > 0
  on conflict (employee_id, period_month) where entry_type = 'accrual' do nothing
  returning employee_leave_ledger.employee_id, employee_leave_ledger.days as days_accrued;
end;
$fn$;

revoke all on function public.accrue_leave_for_month(uuid, date) from public, anon;
grant execute on function public.accrue_leave_for_month(uuid, date) to authenticated;

comment on function public.accrue_leave_for_month is
  'Credits one accrual row per eligible active employee for a calendar month, prorated by days-in-employment. Idempotent per (employee, month) via a partial unique index — re-running is safe, already-accrued pairs are silently skipped, not double-credited. Admin-only, same bar as post_payroll_run. See 0130.';

-- ----------------------------------------------------------------------------
-- record_leave_transaction — availed/encashed/adjustment only; accrual is
-- accrue_leave_for_month's job alone. Caller passes a positive magnitude
-- for availed/encashed (the sign is applied here, not asked of the UI);
-- adjustment passes its own signed value through, for a correcting entry
-- either direction.
-- ----------------------------------------------------------------------------
create or replace function public.record_leave_transaction(
  p_company_id uuid,
  p_employee_id uuid,
  p_entry_type text,
  p_days numeric,
  p_transaction_date date,
  p_notes text default null
) returns uuid
language plpgsql
set search_path to ''
as $fn$
declare
  v_id uuid;
  v_signed_days numeric;
  v_balance numeric;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can record a leave transaction';
  end if;

  if p_entry_type = 'accrual' then
    raise exception 'Accrual entries are created only by accrue_leave_for_month, not recorded directly';
  end if;

  if p_entry_type not in ('availed', 'encashed', 'adjustment') then
    raise exception 'Unrecognised leave entry type: %', p_entry_type;
  end if;

  if p_days = 0 then
    raise exception 'Days must be non-zero';
  end if;

  v_signed_days := case
    when p_entry_type in ('availed', 'encashed') then -abs(p_days)
    else p_days
  end;

  if p_entry_type in ('availed', 'encashed') then
    v_balance := coalesce(public.get_leave_balance(p_company_id, p_employee_id, p_transaction_date), 0);
    if v_balance + v_signed_days < -0.01 then
      raise exception 'Insufficient leave balance: % day(s) available as of %, % requested',
        v_balance, p_transaction_date, abs(p_days);
    end if;
  end if;

  insert into public.employee_leave_ledger (
    company_id, employee_id, entry_type, transaction_date, days, notes, created_by
  ) values (
    p_company_id, p_employee_id, p_entry_type, p_transaction_date, v_signed_days, p_notes, auth.uid()
  ) returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.record_leave_transaction(uuid, uuid, text, numeric, date, text) from public, anon;
grant execute on function public.record_leave_transaction(uuid, uuid, text, numeric, date, text) to authenticated;

-- ----------------------------------------------------------------------------
-- get_gratuity_computation — one employee, one hypothetical or real exit.
-- Pure arithmetic per Sec 53 (see header); no actuarial input anywhere.
-- exit_reason is accepted as free text here (not constrained to the
-- settlements table's CHECK list) so the gratuity report can probe
-- "what if" reasons — only 'death'/'disablement' change the eligibility
-- test, so an unrecognised string is harmless and just gets the standard
-- 5-year test.
-- ----------------------------------------------------------------------------
create or replace function public.get_gratuity_computation(
  p_company_id uuid,
  p_employee_id uuid,
  p_exit_date date,
  p_exit_reason text
) returns table (
  employee_id uuid,
  employee_name text,
  date_of_joining date,
  exit_date date,
  exit_reason text,
  tenure_years int,
  tenure_months int,
  tenure_days int,
  eligible boolean,
  ineligibility_reason text,
  completed_years_for_formula numeric,
  statutory_monthly_wage numeric,
  gratuity_uncapped numeric,
  gratuity_ceiling numeric,
  ceiling_applied boolean,
  gratuity_payable numeric
)
language sql
stable
set search_path to ''
as $$
  with emp as (
    select e.id, e.name, e.date_of_joining
      from public.employees e
     where e.id = p_employee_id and e.company_id = p_company_id
  ),
  tenure as (
    select
      emp.*,
      age(p_exit_date, emp.date_of_joining) as tenure_iv,
      (p_exit_date >= (emp.date_of_joining + interval '5 years')::date) as meets_5yr_tenure
      from emp
  ),
  parts as (
    select
      tenure.*,
      extract(year from tenure_iv)::int as ty,
      extract(month from tenure_iv)::int as tm,
      extract(day from tenure_iv)::int as td
      from tenure
  ),
  rounded as (
    select
      parts.*,
      -- "completed year or part thereof IN EXCESS OF six months" — exactly
      -- 6 months does not round up, 6 months 1 day does.
      case when tm > 6 or (tm = 6 and td > 0) then ty + 1 else ty end as completed_years,
      case
        when lower(coalesce(p_exit_reason, '')) in ('death', 'disablement') then true
        else meets_5yr_tenure
      end as eligible
      from parts
  ),
  wage as (
    select coalesce(app_private.get_employee_statutory_wage(p_company_id, p_employee_id, p_exit_date), 0) as monthly_wage
  )
  select
    r.id,
    r.name,
    r.date_of_joining,
    p_exit_date,
    p_exit_reason,
    r.ty,
    r.tm,
    r.td,
    r.eligible,
    case when r.eligible then null else
      format(
        'Less than 5 years of continuous service (%s to %s = %s years %s months %s days). Not payable except on death or disablement.',
        r.date_of_joining, p_exit_date, r.ty, r.tm, r.td
      )
    end,
    r.completed_years::numeric,
    w.monthly_wage,
    round(w.monthly_wage / 26 * 15 * r.completed_years, 2),
    2000000::numeric,
    (r.eligible and round(w.monthly_wage / 26 * 15 * r.completed_years, 2) > 2000000),
    case when r.eligible
         then least(round(w.monthly_wage / 26 * 15 * r.completed_years, 2), 2000000)
         else 0
    end
    from rounded r, wage w
$$;

revoke all on function public.get_gratuity_computation(uuid, uuid, date, text) from public, anon;
grant execute on function public.get_gratuity_computation(uuid, uuid, date, text) to authenticated;

comment on function public.get_gratuity_computation is
  'Sec 53 (Code on Social Security 2020) gratuity for one employee as of one exit date/reason: 5-year continuous-service test (waived for death/disablement), 15/26 x statutory wage x completed years (6-months-exceeded rounding), Rs 20L ceiling. Storage/computation only — does not post to the ledger. See 0130 for the fixed-term 1-year carve-out and 4y+240d case-law doctrine this deliberately does not model.';

-- ----------------------------------------------------------------------------
-- get_gratuity_estimates — every active employee, "if they exited today by
-- resignation". An estimate report, not a prediction of anyone's actual
-- exit — last-drawn wage will change before any real exit happens.
-- ----------------------------------------------------------------------------
create or replace function public.get_gratuity_estimates(
  p_company_id uuid,
  p_as_of date default current_date
) returns table (
  employee_id uuid,
  employee_name text,
  date_of_joining date,
  tenure_years int,
  tenure_months int,
  tenure_days int,
  eligible boolean,
  ineligibility_reason text,
  completed_years_for_formula numeric,
  statutory_monthly_wage numeric,
  gratuity_uncapped numeric,
  ceiling_applied boolean,
  gratuity_payable numeric
)
language sql
stable
set search_path to ''
as $$
  select
    g.employee_id, g.employee_name, g.date_of_joining,
    g.tenure_years, g.tenure_months, g.tenure_days,
    g.eligible, g.ineligibility_reason,
    g.completed_years_for_formula, g.statutory_monthly_wage,
    g.gratuity_uncapped, g.ceiling_applied, g.gratuity_payable
    from public.employees e
    cross join lateral public.get_gratuity_computation(p_company_id, e.id, p_as_of, 'resignation') g
   where e.company_id = p_company_id and e.is_active
   order by e.name
$$;

revoke all on function public.get_gratuity_estimates(uuid, date) from public, anon;
grant execute on function public.get_gratuity_estimates(uuid, date) to authenticated;

-- ----------------------------------------------------------------------------
-- get_fnf_preview — the aggregator's read side. Combines leave encashment
-- (real ledger balance x statutory daily wage) and gratuity (above) for one
-- employee/exit; unpaid salary is deliberately NOT computed here — see the
-- migration header for why get_payroll_run's own proration cannot safely be
-- re-derived against a hypothetical p_exit_date that has not actually been
-- written to employees.date_of_leaving yet. exit_month_already_posted is
-- the honesty check the F&F screen shows instead: if that month's payroll
-- is already posted, unpaid salary is very likely zero, not the full-month
-- estimate shown alongside for reference only.
-- ----------------------------------------------------------------------------
create or replace function public.get_fnf_preview(
  p_company_id uuid,
  p_employee_id uuid,
  p_exit_date date,
  p_exit_reason text
) returns table (
  employee_id uuid,
  employee_name text,
  date_of_joining date,
  leave_balance_days numeric,
  leave_daily_wage numeric,
  leave_encashment_amount numeric,
  gratuity_eligible boolean,
  gratuity_ineligibility_reason text,
  gratuity_completed_years numeric,
  gratuity_amount numeric,
  statutory_monthly_wage numeric,
  exit_month_reference_gross numeric,
  exit_month_already_posted boolean
)
language sql
stable
set search_path to ''
as $$
  with g as (
    select * from public.get_gratuity_computation(p_company_id, p_employee_id, p_exit_date, p_exit_reason)
  ),
  bal as (
    select coalesce(public.get_leave_balance(p_company_id, p_employee_id, p_exit_date), 0) as balance
  ),
  wage as (
    select round(coalesce(app_private.get_employee_statutory_wage(p_company_id, p_employee_id, p_exit_date), 0) / 26, 2) as daily_wage
  ),
  structure_hint as (
    select (s.basic + s.dearness_allowance + s.hra + s.special_allowance + s.other_allowance) as gross
      from public.employee_salary_structures s
     where s.employee_id = p_employee_id and s.company_id = p_company_id and s.effective_from <= p_exit_date
     order by s.effective_from desc
     limit 1
  ),
  posted as (
    select exists(
      select 1 from public.payroll_postings pp
       where pp.company_id = p_company_id and pp.period_month = date_trunc('month', p_exit_date)::date
    ) as already_posted
  )
  select
    g.employee_id, g.employee_name, g.date_of_joining,
    bal.balance,
    wage.daily_wage,
    round(greatest(bal.balance, 0) * wage.daily_wage, 2),
    g.eligible, g.ineligibility_reason,
    g.completed_years_for_formula, g.gratuity_payable,
    g.statutory_monthly_wage,
    coalesce(sh.gross, 0),
    posted.already_posted
    from g
    cross join bal
    cross join wage
    cross join posted
    left join structure_hint sh on true
$$;

revoke all on function public.get_fnf_preview(uuid, uuid, date, text) from public, anon;
grant execute on function public.get_fnf_preview(uuid, uuid, date, text) to authenticated;

-- ----------------------------------------------------------------------------
-- record_fnf_settlement — the aggregator's write side. Computes leave
-- encashment and gratuity server-side (never trusts client-supplied
-- figures for the two statutory components); takes unpaid salary, bonus
-- and recoveries as explicit admin-entered amounts. Side effects: records
-- a real 'encashed' ledger row for the full leave balance (so future
-- balance reads are correct), and sets employees.date_of_leaving/is_active.
-- Upserts on (employee_id) — re-finalizing a correction replaces the prior
-- snapshot and re-does the leave encashment rather than double-encashing.
-- ----------------------------------------------------------------------------
create or replace function public.record_fnf_settlement(
  p_company_id uuid,
  p_employee_id uuid,
  p_exit_date date,
  p_exit_reason text,
  p_unpaid_salary_amount numeric default 0,
  p_bonus_amount numeric default 0,
  p_recoveries_amount numeric default 0,
  p_notes text default null
) returns uuid
language plpgsql
set search_path to ''
as $fn$
declare
  v_id uuid;
  v_leave_balance numeric;
  v_daily_wage numeric;
  v_leave_amount numeric;
  v_gratuity record;
  v_net numeric;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can finalize a full-and-final settlement';
  end if;

  if p_exit_reason not in ('resignation', 'retirement', 'termination', 'death', 'disablement', 'contract_expiry') then
    raise exception 'Unrecognised exit reason: %', p_exit_reason;
  end if;

  select * into v_gratuity
    from public.get_gratuity_computation(p_company_id, p_employee_id, p_exit_date, p_exit_reason);

  if v_gratuity.employee_id is null then
    raise exception 'Employee not found for this company';
  end if;

  v_leave_balance := greatest(coalesce(public.get_leave_balance(p_company_id, p_employee_id, p_exit_date), 0), 0);
  v_daily_wage := round(coalesce(app_private.get_employee_statutory_wage(p_company_id, p_employee_id, p_exit_date), 0) / 26, 2);
  v_leave_amount := round(v_leave_balance * v_daily_wage, 2);

  v_net := coalesce(p_unpaid_salary_amount, 0) + v_leave_amount + v_gratuity.gratuity_payable
           + coalesce(p_bonus_amount, 0) - coalesce(p_recoveries_amount, 0);

  insert into public.employee_exit_settlements (
    company_id, employee_id, exit_date, exit_reason,
    unpaid_salary_amount, leave_encashment_days, leave_encashment_amount,
    gratuity_eligible, gratuity_ineligibility_reason, gratuity_completed_years,
    gratuity_last_drawn_wage, gratuity_amount,
    bonus_amount, recoveries_amount, net_payable, notes, finalized_by
  ) values (
    p_company_id, p_employee_id, p_exit_date, p_exit_reason,
    coalesce(p_unpaid_salary_amount, 0), v_leave_balance, v_leave_amount,
    v_gratuity.eligible, v_gratuity.ineligibility_reason, v_gratuity.completed_years_for_formula,
    v_gratuity.statutory_monthly_wage, v_gratuity.gratuity_payable,
    coalesce(p_bonus_amount, 0), coalesce(p_recoveries_amount, 0), v_net, p_notes, auth.uid()
  )
  on conflict (employee_id) do update set
    company_id = excluded.company_id,
    exit_date = excluded.exit_date,
    exit_reason = excluded.exit_reason,
    unpaid_salary_amount = excluded.unpaid_salary_amount,
    leave_encashment_days = excluded.leave_encashment_days,
    leave_encashment_amount = excluded.leave_encashment_amount,
    gratuity_eligible = excluded.gratuity_eligible,
    gratuity_ineligibility_reason = excluded.gratuity_ineligibility_reason,
    gratuity_completed_years = excluded.gratuity_completed_years,
    gratuity_last_drawn_wage = excluded.gratuity_last_drawn_wage,
    gratuity_amount = excluded.gratuity_amount,
    bonus_amount = excluded.bonus_amount,
    recoveries_amount = excluded.recoveries_amount,
    net_payable = excluded.net_payable,
    notes = excluded.notes,
    finalized_by = excluded.finalized_by,
    finalized_at = now()
  returning id into v_id;

  -- Remove any prior auto-recorded F&F encashment for this employee/date
  -- before re-inserting, so re-finalizing a correction does not double-
  -- encash the same days.
  delete from public.employee_leave_ledger
   where company_id = p_company_id and employee_id = p_employee_id
     and entry_type = 'encashed' and transaction_date = p_exit_date
     and notes = 'Full-and-final settlement encashment';

  if v_leave_balance > 0 then
    insert into public.employee_leave_ledger (
      company_id, employee_id, entry_type, transaction_date, days, notes, created_by
    ) values (
      p_company_id, p_employee_id, 'encashed', p_exit_date, -v_leave_balance,
      'Full-and-final settlement encashment', auth.uid()
    );
  end if;

  update public.employees
     set date_of_leaving = p_exit_date, is_active = false
   where id = p_employee_id and company_id = p_company_id;

  return v_id;
end;
$fn$;

revoke all on function public.record_fnf_settlement(uuid, uuid, date, text, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.record_fnf_settlement(uuid, uuid, date, text, numeric, numeric, numeric, text) to authenticated;

comment on function public.record_fnf_settlement is
  'Finalizes an employee exit: server-computes leave encashment and gratuity, takes unpaid salary/bonus/recoveries as admin-entered figures, snapshots the whole into employee_exit_settlements (upsert on employee_id), records a real leave-ledger encashment for the full balance, sets employees.date_of_leaving/is_active. Does not post to the general ledger — see 0130.';
