-- ============================================================================
-- 1380 — set_employee_leaving_date: an exit no longer requires a full
--        settlement before payroll/leave/PT will stop accruing
-- ============================================================================
-- Narrower than the migration this reconciles with git history was
-- originally written. The original also carried record_salary_revision
-- (a salary-revision RPC) and a joining-month fix to four payroll functions.
-- Both are out of scope here:
--
--   * record_salary_revision duplicates a DIFFERENT, later, already-committed
--     salary-revision mechanism: components/employees/EmployeeManager.tsx's
--     own revision UI (onSubmitRevision, an effective-dated insert/update
--     against employee_salary_structures), guarded by the live, committed
--     trigger in 1471_salary_revision_cannot_rewrite_posted_payroll.sql
--     (app_private.guard_posted_payroll_structure). That work shipped
--     independently (commit b02ff82, "No state on a party... no way to
--     revise a salary") before this reconciliation. record_salary_revision
--     itself is left exactly as it already is live — an orphaned, unused
--     function nothing calls — rather than either re-wiring the frontend to
--     a second, competing mechanism or dropping a function this task was not
--     asked to remove.
--
--   * The joining-month structure-selection fix to get_payroll_run,
--     get_pf_ecr_data, get_salary_tds_estimate and get_pt_liability_by_state
--     is a separate, independent defect, not part of employee-identity or
--     exit editing. It is left for whichever task is actually scoped to it.
--
-- WHAT REMAINS: exactly what record_fnf_settlement never covered. Before
-- this, date_of_leaving/is_active had exactly one writer in the whole app —
-- record_fnf_settlement (0140) — which computes and snapshots gratuity,
-- leave encashment and net dues in the same call. An employee who resigned
-- with the F&F still under negotiation had no way to say "this person left"
-- short of finalizing a settlement, so payroll, leave accrual and PT kept
-- running for them indefinitely.
--
-- This function is deliberately the opposite of record_fnf_settlement: it
-- records THAT and WHEN someone left, and computes nothing. A full-and-final
-- settlement, once finalized, keeps sole ownership of the exit date — see
-- the exception below — so a genuine settlement correction still happens on
-- the Full & Final screen, not here.
--
-- CONFIRMED LIVE, unchanged, before writing this file (not re-applied blind):
-- pg_get_functiondef(public.set_employee_leaving_date) matches this body
-- byte-for-byte, and its EXECUTE grant is authenticated-only (no anon, no
-- PUBLIC) — exactly the shape below. This migration exists to stop git and
-- the live database disagreeing about what schema exists (the shared-
-- worktree drift pattern), not to change anything already running.
--
-- is_active moves with date_of_leaving in the same statement, never
-- separately — get_salary_tds_estimate and get_gratuity_estimates still
-- read is_active as "employed now", and 1240 depends on the two fields
-- never disagreeing. A future leaving date is refused for the same reason:
-- marking someone as leaving before their last working day would zero their
-- TDS estimate for a notice period they are still being paid for.
-- ============================================================================

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
