-- ============================================================================
-- 1380 — Employees were create-only, and every one of them was permanently
--        stuck on their joining-date salary
-- ============================================================================
-- THREE DEFECTS, one root cause: nothing in the app has ever written to an
-- employee row after the insert that created it.
--
-- 1. IDENTITY IS UNCORRECTABLE. EmployeeManager.tsx holds exactly one write
--    against public.employees — the insert. No update_employee RPC exists in
--    any of the 197 migrations before this one, and the only SQL anywhere that
--    updates an employee is record_fnf_settlement (0140), which sets
--    date_of_leaving/is_active and nothing else. So a mistyped PAN, UAN or ESI
--    number can never be fixed. reports/pf-ecr and reports/esi-mc both tell the
--    user 'add it under Employees before uploading' for a missing UAN or IP
--    number — a screen that, for an employee who already exists, could not do
--    it. A missing UAN makes EPFO's ECR reject the row outright; a wrong PAN
--    breaks Form 24Q and Form 16.
--
-- 2. SALARY IS FROZEN AT HIRE. public.employee_salary_structures is
--    effective-dated and carries unique (employee_id, effective_from) —
--    a shape that exists for exactly one reason, revisions — but the create
--    form hardcodes effective_from := date_of_joining and nothing ever inserts
--    a second row. Consequence, after any employee's first increment: 24Q,
--    Form 16, PF ECR, ESI, gratuity, statutory bonus and the payroll register
--    all compute on stale pay. These are filed numbers.
--
-- 3. AN EXIT REQUIRES A FULL SETTLEMENT. record_fnf_settlement is the only
--    writer of date_of_leaving, and it computes and snapshots gratuity, leave
--    encashment and net dues in the same call. Until that is finalized there
--    is no way to say "this person left" — so an ordinary resignation with the
--    F&F still in negotiation keeps accruing payroll, leave and PT for ever,
--    while the Employees list renders a Left/Active column off two fields the
--    UI cannot write.
--
-- ----------------------------------------------------------------------------
-- 4. AND THE ONE THIS FOUND ON THE WAY: a mid-month joiner is silently missing
--    from their own joining month, in every period-scoped payroll report.
-- ----------------------------------------------------------------------------
-- get_payroll_run and its three siblings pick a structure with
--
--     where s.effective_from <= <period start>
--     order by s.employee_id, s.effective_from desc     (distinct on)
--
-- and the create form dates the first structure to date_of_joining. For anyone
-- who joined on the 1st those two facts never collide. For anyone who did not,
-- the joining month has NO structure at or before its first day, the inner
-- join to latest_structure drops the employee, and the month they were actually
-- employed and paid for reports nothing at all.
--
-- Confirmed live before writing this, not inferred: TEST Rangoli Spice Works'
-- TEST Priya Nair (joined 2026-05-15, structure effective 2026-05-15) is absent
-- from get_payroll_run for May 2026 entirely and first appears in June. Swept
-- across every company, employee and month on the project, the old and new
-- rules disagree on exactly five (employee, month) pairs — every one of them a
-- mid-month joiner's own joining month, every one of them currently returning
-- NOTHING, and none of them a month with posted payroll. So this widens five
-- silently-empty rows into correct ones and changes no existing figure.
--
-- get_statutory_bonus_computation (0136) hit this exact bug in its own corner
-- and fixed it there, with a comment that says a month-START cutoff "would find
-- no structure at all for that partial month and silently price it at zero,
-- understating a real entitlement... Caught live by this migration's own
-- verification run". That call is already settled; this applies it to the four
-- functions it was never carried across to.
--
-- The fix is NOT simply month-end everywhere, which is what the bonus function
-- could safely do because it had no revisions to worry about. A plain month-end
-- cutoff would let a revision dated mid-month re-rate the half of the month
-- already worked at the old salary. The rule here is a preference, not a wider
-- window: take the structure in force on the first of the month; only if there
-- is none, take the earliest structure that begins inside the month. A revision
-- therefore still takes effect from the month its effective_from starts (see
-- below — this function forces that to be a month start anyway), and a joining
-- structure is used for the joining month, day-prorated by days_paid exactly as
-- it already is for every other month.
--
-- METHOD. Same as 1240 and 1300: these four function bodies are read from
-- pg_get_functiondef at apply time and the two target clauses replaced, with a
-- hit count asserted first. Their on-disk copies in 0075/0080/0085/0125 are
-- several migrations stale (0142, 1240 and others have replaced them since);
-- reproducing a body from those files would ship a fix against a function that
-- no longer exists. For the same reason this is a standalone corrective
-- migration and is deliberately NOT folded back into those files.
--
-- ----------------------------------------------------------------------------
-- WHAT IS AN RPC HERE, AND WHAT IS NOT
-- ----------------------------------------------------------------------------
-- employees_write and employee_salary_structures_write (0043) already restrict
-- ALL writes to app_private.is_company_admin, and authenticated already holds
-- column-level INSERT/UPDATE on both tables. Correcting name/PAN/UAN/ESI
-- number/establishment is therefore a plain PostgREST .update() from the client
-- — RLS is the gate, employees_pan_check and the (branch_id, company_id)
-- composite FK are the validation, set_updated_at and the audit trigger both
-- already fire, and an admin who could call an RPC could make the same write
-- directly anyway, so wrapping it would add ceremony and no protection. The
-- raw Postgres text is mapped to plain English client-side, the same way
-- lib/ledgers/friendlyError.ts already does for the ledger forms.
--
-- The two functions below exist because each enforces a rule the TABLE cannot:
-- both read public.payroll_postings, a different table, to refuse a write that
-- would rewrite a month already posted, paid and remitted. That is precisely
-- the harm 1240 was written about, and a client-side check of it is a
-- suggestion, not a rule. Both are SECURITY INVOKER with an explicit
-- is_company_admin test for a friendly error and RLS as the real backstop —
-- same shape as update_branch (1320) and delete_company (0010).
--
-- ----------------------------------------------------------------------------
-- DELIBERATELY NOT EDITABLE, and why
-- ----------------------------------------------------------------------------
--   id, company_id            identity; moving an employee between companies
--                             would orphan their structures, leave ledger,
--                             tax declarations and settlement.
--   date_of_joining           re-dates every past payroll month at once
--                             (days_paid is computed from it), and drives
--                             gratuity tenure and bonus eligibility. A wrong
--                             joining date is a re-create, not an edit.
--   is_active                 never written on its own. record_fnf_settlement
--                             is today the only writer and always sets
--                             date_of_leaving in the same statement; 1240
--                             verified that and its fallback condition
--                             (e.is_active or e.date_of_leaving is not null)
--                             depends on it. set_employee_leaving_date below
--                             keeps the pairing exactly.
--   the money on an existing
--   salary structure row      a revision is a NEW row, not an edit of the old
--                             one — that is what makes last year's 24Q still
--                             compute on last year's salary.
--
-- ----------------------------------------------------------------------------
-- WHY A LEAVING DATE IN THE FUTURE IS REFUSED
-- ----------------------------------------------------------------------------
-- Tempting, since a notice period's last working day is usually known weeks
-- ahead. But is_active has to move with date_of_leaving to keep 1240's
-- guarantee, and two functions still read the flag as "employed now":
-- get_salary_tds_estimate, whose result get_payroll_run left-joins for the
-- month's TDS, and get_gratuity_estimates, which has no date filter at all and
-- relies on the flag alone. Marking someone as leaving on the 30th while they
-- are still working the month would take their TDS to zero for the notice
-- period they are still being paid for — a live under-withholding created by
-- using this feature. Recording the exit on or after the last working day
-- costs the preparer a diary note and costs the return nothing.
--
-- (record_fnf_settlement accepts a future exit date today and has the same
-- exposure. That is pre-existing, it is not reached by anything this migration
-- adds, and it is left alone rather than widened.)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- record_salary_revision — the second, third, nth structure row an employee
-- should always have been able to have.
-- ----------------------------------------------------------------------------
create or replace function public.record_salary_revision(
  p_employee_id uuid,
  p_effective_from date,
  p_basic numeric,
  p_dearness_allowance numeric default 0,
  p_hra numeric default 0,
  p_special_allowance numeric default 0,
  p_other_allowance numeric default 0,
  p_pf_applicable boolean default true,
  p_pf_wage_ceiling_applies boolean default true,
  p_esi_applicable boolean default true,
  p_professional_tax_monthly numeric default 0
) returns uuid
language plpgsql
security invoker   -- RLS decides; only an admin may write a salary structure
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_date_of_joining date;
  v_date_of_leaving date;
  v_posted_month date;
  v_id uuid;
begin
  select company_id, date_of_joining, date_of_leaving
    into v_company_id, v_date_of_joining, v_date_of_leaving
    from public.employees
   where id = p_employee_id;

  if v_company_id is null then
    raise exception 'Employee not found';
  end if;

  if not app_private.is_company_admin(v_company_id) then
    raise exception 'Only a company admin can revise an employee''s salary';
  end if;

  if p_effective_from is null then
    raise exception 'A salary revision needs a month to take effect from';
  end if;

  -- One rate per month is what the payroll engine can represent: every
  -- period-scoped function picks ONE structure for a whole month. Accepting
  -- 15 Aug would quietly mean 'from 1 September' and underpay the second half
  -- of August, so it is refused with both real choices spelled out. The single
  -- exception is the very first structure, which is conventionally dated to
  -- date_of_joining and legitimately starts mid-month — there is no earlier
  -- rate for it to be blended with, and re-running this function on that date
  -- is how a typo in the amounts entered at hire gets corrected.
  if p_effective_from <> date_trunc('month', p_effective_from)::date
     and p_effective_from <> v_date_of_joining then
    raise exception
      'Payroll pays one salary rate for a whole month, so a revision has to start on the first of one. Use % to pay the new rate for the whole of that month, or % to start from the month after.',
      to_char(date_trunc('month', p_effective_from), 'DD Mon YYYY'),
      to_char(date_trunc('month', p_effective_from) + interval '1 month', 'DD Mon YYYY');
  end if;

  if p_effective_from < v_date_of_joining then
    raise exception
      'A salary cannot take effect before the employee joined on %',
      to_char(v_date_of_joining, 'DD Mon YYYY');
  end if;

  if v_date_of_leaving is not null and p_effective_from > v_date_of_leaving then
    raise exception
      'This employee left on % — a salary effective % would never be paid',
      to_char(v_date_of_leaving, 'DD Mon YYYY'),
      to_char(p_effective_from, 'DD Mon YYYY');
  end if;

  if p_basic is null or p_basic < 0
     or coalesce(p_dearness_allowance, 0) < 0
     or coalesce(p_hra, 0) < 0
     or coalesce(p_special_allowance, 0) < 0
     or coalesce(p_other_allowance, 0) < 0
     or coalesce(p_professional_tax_monthly, 0) < 0 then
    raise exception 'Salary amounts cannot be negative';
  end if;

  -- A posted month has been paid, its PF/ESI/PT challans remitted and its 24Q
  -- filed. Re-rating it from here would leave every one of those disagreeing
  -- with a ledger this function does not touch — the exact failure 1240
  -- documents. Backdated pay for a closed month is a separate arrears payment,
  -- not a rewrite of history.
  --
  -- Compared against the MONTH p_effective_from falls in, not the date itself.
  -- For an ordinary revision those are the same day. For the date_of_joining
  -- exception above they are not, and a plain date comparison would happily let
  -- a correction dated the 15th re-rate a 1st-of-the-month posting.
  select max(period_month) into v_posted_month
    from public.payroll_postings
   where company_id = v_company_id
     and period_month >= date_trunc('month', p_effective_from)::date;

  if v_posted_month is not null then
    raise exception
      'Payroll for % is already posted. A revision effective % would change a month that has been paid and remitted — pay the difference as arrears instead, or date the revision from %.',
      to_char(v_posted_month, 'Mon YYYY'),
      to_char(p_effective_from, 'Mon YYYY'),
      to_char(date_trunc('month', v_posted_month) + interval '1 month', 'Mon YYYY');
  end if;

  if not app_private.is_period_open(v_company_id, date_trunc('month', p_effective_from)::date) then
    raise exception
      'The books are locked on or before this date, so a revision effective % would change a closed period',
      to_char(p_effective_from, 'DD Mon YYYY');
  end if;

  -- unique (employee_id, effective_from) is the natural key: revising the same
  -- month twice corrects that month rather than failing, the same way the
  -- Sec 115BAC declaration form upserts on (employee, financial year).
  insert into public.employee_salary_structures (
    employee_id, company_id, effective_from,
    basic, dearness_allowance, hra, special_allowance, other_allowance,
    pf_applicable, pf_wage_ceiling_applies, esi_applicable, professional_tax_monthly
  ) values (
    p_employee_id, v_company_id, p_effective_from,
    p_basic,
    coalesce(p_dearness_allowance, 0),
    coalesce(p_hra, 0),
    coalesce(p_special_allowance, 0),
    coalesce(p_other_allowance, 0),
    coalesce(p_pf_applicable, true),
    coalesce(p_pf_wage_ceiling_applies, true),
    coalesce(p_esi_applicable, true),
    coalesce(p_professional_tax_monthly, 0)
  )
  on conflict (employee_id, effective_from) do update set
    basic                    = excluded.basic,
    dearness_allowance       = excluded.dearness_allowance,
    hra                      = excluded.hra,
    special_allowance        = excluded.special_allowance,
    other_allowance          = excluded.other_allowance,
    pf_applicable            = excluded.pf_applicable,
    pf_wage_ceiling_applies  = excluded.pf_wage_ceiling_applies,
    esi_applicable           = excluded.esi_applicable,
    professional_tax_monthly = excluded.professional_tax_monthly
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_salary_revision(
  uuid, date, numeric, numeric, numeric, numeric, numeric,
  boolean, boolean, boolean, numeric
) from public, anon;
grant execute on function public.record_salary_revision(
  uuid, date, numeric, numeric, numeric, numeric, numeric,
  boolean, boolean, boolean, numeric
) to authenticated;

comment on function public.record_salary_revision(
  uuid, date, numeric, numeric, numeric, numeric, numeric,
  boolean, boolean, boolean, numeric
) is
  'Records an increment as a NEW effective-dated employee_salary_structures row, never by mutating the existing one, so every past month keeps computing on the salary that was actually in force then. effective_from must be the first of a month (payroll pays one rate per whole month) or exactly the employee''s date_of_joining, which is how the structure entered at hire gets corrected. Upserts on the unique (employee_id, effective_from), so revising the same month twice corrects it. Refuses a month at or before any already-posted payroll month, and any date inside locked books. Admin-gated to match employee_salary_structures_write RLS (0043).';


-- ----------------------------------------------------------------------------
-- set_employee_leaving_date — records THAT someone left, and when. Not what
-- they are owed for it: that is still record_fnf_settlement's job, and this
-- function deliberately computes and settles nothing.
-- ----------------------------------------------------------------------------
create or replace function public.set_employee_leaving_date(
  p_employee_id uuid,
  p_date_of_leaving date
) returns void
language plpgsql
security invoker   -- RLS decides; only an admin may write an employee
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_date_of_joining date;
  v_existing date;
  v_fnf_exit_date date;
  v_from_month date;
  v_posted_month date;
begin
  select company_id, date_of_joining, date_of_leaving
    into v_company_id, v_date_of_joining, v_existing
    from public.employees
   where id = p_employee_id;

  if v_company_id is null then
    raise exception 'Employee not found';
  end if;

  if not app_private.is_company_admin(v_company_id) then
    raise exception 'Only a company admin can record an employee''s leaving date';
  end if;

  if p_date_of_leaving is null and v_existing is null then
    return;   -- nothing to change
  end if;

  -- A finalized settlement computed gratuity, leave encashment and net dues AT
  -- a specific exit date and snapshotted all of it. Moving the date behind its
  -- back would leave those figures silently wrong, so the settlement keeps
  -- ownership of the date once it exists — and record_fnf_settlement upserts
  -- on employee_id, so re-finalizing there is a real, working correction path.
  select exit_date into v_fnf_exit_date
    from public.employee_exit_settlements
   where employee_id = p_employee_id and company_id = v_company_id;

  if v_fnf_exit_date is not null then
    raise exception
      'A full-and-final settlement is already finalized for this employee at %, and its gratuity and leave encashment were computed on that date. Change it by re-finalizing on the Full & Final screen, not here.',
      to_char(v_fnf_exit_date, 'DD Mon YYYY');
  end if;

  if p_date_of_leaving is not null then
    if p_date_of_leaving < v_date_of_joining then
      raise exception
        'The leaving date cannot be before the joining date (%)',
        to_char(v_date_of_joining, 'DD Mon YYYY');
    end if;

    -- See the migration header: is_active moves with this date, and two
    -- functions still read that flag as 'employed now'.
    if p_date_of_leaving > current_date then
      raise exception
        'A leaving date in the future cannot be recorded yet — record it on or after the last working day. Until then payroll must keep running at full pay, and the TDS estimate for those months depends on this employee still counting as employed.';
    end if;
  end if;

  -- Both directions rewrite history from the earlier of the two dates onward:
  -- setting a date prorates that month and removes every later one, clearing it
  -- puts the employee back into all of them.
  v_from_month := date_trunc('month',
    least(coalesce(v_existing, p_date_of_leaving), coalesce(p_date_of_leaving, v_existing))
  )::date;

  select max(period_month) into v_posted_month
    from public.payroll_postings
   where company_id = v_company_id
     and period_month >= v_from_month;

  if v_posted_month is not null then
    raise exception
      'Payroll for % is already posted. Changing this employee''s leaving date would rewrite a month that has been paid and remitted — its PF, ESI, PT and 24Q figures would no longer match the challans filed. Correct it with a journal entry instead.',
      to_char(v_posted_month, 'Mon YYYY');
  end if;

  if not app_private.is_period_open(v_company_id, v_from_month) then
    raise exception
      'The books are locked on or before this date, so changing the leaving date would rewrite the closed period containing %',
      to_char(v_from_month, 'Mon YYYY');
  end if;

  -- The pairing 1240 verified and depends on: is_active is never written
  -- without date_of_leaving in the same statement, and never disagrees with it.
  update public.employees
     set date_of_leaving = p_date_of_leaving,
         is_active = (p_date_of_leaving is null)
   where id = p_employee_id;
end;
$$;

revoke all on function public.set_employee_leaving_date(uuid, date) from public, anon;
grant execute on function public.set_employee_leaving_date(uuid, date) to authenticated;

comment on function public.set_employee_leaving_date(uuid, date) is
  'Records that an employee has left, and when, so payroll/leave/PT stop accruing — without running a full-and-final settlement, which stays the only thing that computes gratuity, leave encashment and net dues. Sets is_active in the same statement, never separately (1240 depends on that). Pass null to clear a leaving date recorded in error. Refuses when a finalized settlement already owns the date (re-finalize on the F&F screen), when the date is in the future, and when any payroll month from the affected month onward is already posted or inside locked books. Admin-gated to match employees_write RLS (0043).';


-- ----------------------------------------------------------------------------
-- The joining-month drop: prefer the structure in force on the first of the
-- month, and fall back to the earliest one that begins inside it.
--
-- Read from pg_get_functiondef at apply time and rewritten, 1240-style, rather
-- than reproduced from the stale on-disk copies in 0075/0080/0085/0125. Each
-- target clause must appear exactly once or this raises and applies nothing.
--
-- get_payroll_run's period CTE already exposes period_end; get_pf_ecr_data's
-- and get_salary_tds_estimate's expose only period_start, so the month end is
-- derived inline rather than by also rewriting their period CTEs.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_fn text;
  v_def text;
  v_where_target text;
  v_where_new text;
  v_order_target text;
  v_order_new text;
  v_start text;
  v_end text;
  v_hits int;
begin
  foreach v_fn in array array[
    'get_payroll_run',
    'get_pf_ecr_data',
    'get_salary_tds_estimate',
    'get_pt_liability_by_state'
  ] loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn and p.prokind = 'f'
     limit 1;

    if v_def is null then
      raise exception '1380: % is missing.', v_fn;
    end if;

    if v_fn = 'get_pt_liability_by_state' then
      v_start := 'mb.month_start';
      v_end   := 'mb.month_end';
      v_where_target := 'and s.effective_from <= mb.month_start';
      v_order_target := 'order by s.employee_id, mb.month_start, s.effective_from desc';
      v_order_new    := 'order by s.employee_id, mb.month_start,';
    else
      v_start := 'p.period_start';
      v_where_target := 'and s.effective_from <= p.period_start';
      v_order_target := 'order by s.employee_id, s.effective_from desc';
      v_order_new    := 'order by s.employee_id,';
      if v_fn = 'get_payroll_run' then
        v_end := 'p.period_end';
      else
        v_end := '(p.period_start + interval ''1 month - 1 day'')::date';
      end if;
    end if;

    v_where_new := 'and s.effective_from <= ' || v_end;

    -- Already carrying the new form: nothing to do. 1240 and 1300 are one-shot
    -- in this position, which is fine on a replay from an empty database but
    -- means a re-run against a database that already has the fix aborts the
    -- whole file. This costs three lines and makes the migration re-runnable
    -- without loosening either assertion below.
    if position(v_where_new in v_def) > 0 then
      continue;
    end if;

    -- Preference, not a wider window: rows in force on the first of the month
    -- sort ahead of rows that merely begin inside it. Among the first group the
    -- LATEST wins (an ordinary revision); the second group is only ever reached
    -- when the first is empty, and there the EARLIEST wins (the structure dated
    -- to a mid-month date_of_joining).
    v_order_new := v_order_new
      || ' (s.effective_from <= ' || v_start || ') desc,'
      || ' case when s.effective_from <= ' || v_start || ' then s.effective_from end desc,'
      || ' s.effective_from asc';

    v_hits := (length(v_def) - length(replace(v_def, v_where_target, '')))
              / length(v_where_target);
    if v_hits <> 1 then
      raise exception
        '1380: expected exactly one structure cutoff in %, found %. Its body has moved; fix by hand.',
        v_fn, v_hits;
    end if;

    v_hits := (length(v_def) - length(replace(v_def, v_order_target, '')))
              / length(v_order_target);
    if v_hits <> 1 then
      raise exception
        '1380: expected exactly one structure ordering in %, found %. Its body has moved; fix by hand.',
        v_fn, v_hits;
    end if;

    -- The fallback arm is only safe because employment is still decided by
    -- date somewhere downstream: an employee picked up for their joining month
    -- must be paid for the days they actually worked, not the whole month.
    -- Three of these carry that test themselves. get_pf_ecr_data does not and
    -- must not — its structure lookup only answers "was PF applicable", and
    -- every row it emits comes from an inner join to get_payroll_run, which
    -- does the dating and the proration. (Asserted, not assumed: the first run
    -- of this migration failed here, on a precondition written before that
    -- distinction was checked.)
    if v_fn = 'get_pf_ecr_data' then
      if v_def !~ 'public\.get_payroll_run\(' then
        raise exception
          '1380: get_pf_ecr_data no longer derives its rows from get_payroll_run, so it no longer inherits the employment dating. Fix by hand.';
      end if;
    elsif v_def !~ 'date_of_leaving is null or e\.date_of_leaving >=' then
      raise exception
        '1380: % has lost its period-aware employment test; including a joining month here would be wrong. Fix by hand.',
        v_fn;
    end if;

    v_def := replace(v_def, v_where_target, v_where_new);
    v_def := replace(v_def, v_order_target, v_order_new);
    execute v_def;
  end loop;
end;
$mig$;

comment on function public.get_payroll_run(uuid, date) is
  'One month of payroll for every employee employed during THAT month — judged on date_of_joining and date_of_leaving, never on the current is_active flag, so recording a resignation cannot rewrite a month already posted, paid and filed (1240). The salary structure is the one in force on the first of the month, falling back to the earliest structure that begins inside the month, so a mid-month joiner is paid (day-prorated) for their joining month instead of vanishing from it (1380).';
