-- ============================================================================
-- 1300 — F&F leave encashment silently dropped the exit month's own earned
-- leave for any mid-month leaver
-- ============================================================================
-- accrue_leave_for_month has always prorated a leaver's exit-month accrual
-- AMOUNT correctly — least(v_period_end, coalesce(e.date_of_leaving,
-- v_period_end)) already caps the days-in-employment window at the actual
-- last working day. But the row's own transaction_date was always written
-- as v_period_end (the calendar last day of the month) regardless, even
-- when that date is after the employee actually left.
--
-- get_leave_balance/get_leave_balances (both from 0140) filter
-- transaction_date <= p_as_of. fnf-settlement calls get_leave_balance at
-- exit_date. A real exit date is almost never the literal last day of a
-- month, so the exit month's own (correctly prorated) accrual was ALWAYS
-- dated after exit_date and therefore ALWAYS excluded from every full-and-
-- final settlement — a systematic underpayment of a statutory "all wages"
-- component (Code on Wages Sec 17(2)) on essentially every real resignation
-- or termination.
--
-- Found live (wave 7, 1 Sep 2026): Sharma Textiles' Vikram Nair, exited
-- 2026-08-20, true August entitlement 0.81 days (20/31 x 1.25) visible on
-- the Balances table, but his finalized settlement showed leave
-- encashment = 0.00 — because his August accrual was dated 2026-08-31,
-- nine days after his own exit date.
--
-- This function has since been touched twice more (0142: OUT parameters
-- renamed accrual_employee_id/accrual_days_accrued to resolve a PL/pgSQL
-- column-ambiguity; 1240: the eligibility filter widened from e.is_active
-- alone to (e.is_active or e.date_of_leaving is not null), so a just-
-- exited employee whose is_active has already flipped false still gets
-- their final month's accrual). Reproduced here as a straight CREATE OR
-- REPLACE against the function's own real, current live shape — read via
-- pg_get_functiondef immediately before writing this file, not copied from
-- 0140's now-stale on-disk copy — with only the one line this migration
-- actually changes touched.
--
-- Fix: date the row to the same boundary the amount is already prorated
-- against — the employee's actual last day within the period, when that is
-- earlier than the calendar month-end. A still-active employee's accrual
-- (date_of_leaving null or after period end) is completely unaffected: the
-- least(...) collapses to v_period_end exactly as before. period_month
-- (the idempotency key) is untouched either way.
-- ============================================================================

create or replace function public.accrue_leave_for_month(
  p_company_id uuid,
  p_period_month date
) returns table (
  accrual_employee_id uuid,
  accrual_days_accrued numeric
)
language plpgsql
set search_path to ''
as $function$
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
    -- The same boundary the amount below is already prorated against — an
    -- employee who left mid-month accrues (and is now dated) only up to
    -- their real last day, not the calendar month-end they never worked to.
    -- This is the ONE line 1300 changes; everything else here is 0140/0142/
    -- 1240 unchanged.
    least(v_period_end, coalesce(e.date_of_leaving, v_period_end)),
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
     and (e.is_active or e.date_of_leaving is not null)
     and e.date_of_joining <= v_period_end
     and (e.date_of_leaving is null or e.date_of_leaving >= v_period_start)
     and (least(v_period_end, coalesce(e.date_of_leaving, v_period_end))
          - greatest(v_period_start, e.date_of_joining) + 1) > 0
  on conflict (employee_id, period_month) where entry_type = 'accrual' do nothing
  returning employee_leave_ledger.employee_id, employee_leave_ledger.days;
end;
$function$;

revoke all on function public.accrue_leave_for_month(uuid, date) from public, anon;
grant execute on function public.accrue_leave_for_month(uuid, date) to authenticated;

comment on function public.accrue_leave_for_month is
  'Monthly earned-leave accrual, one row per eligible employee, prorated by days-in-employment the same way get_payroll_run (0075) prorates pay. Idempotent via the partial unique index on (employee_id, period_month) — re-running for an already-accrued month/employee inserts nothing more, no exception raised. Eligibility considers a just-exited employee even after is_active flips false (1240). transaction_date (1300) is the employee''s actual last day within the period when they left mid-period, not always the calendar month-end — otherwise a leaver''s own exit-month accrual is dated after their exit_date and every get_leave_balance(..., p_as_of := exit_date) call (including fnf-settlement) silently excludes it. See 0140 for get_leave_balance/get_leave_balances, this migration''s header for the live bug this closes.';

-- ----------------------------------------------------------------------------
-- Backfill: rows already written by the old, unconditional-month-end version
-- of this function, for an employee who has since left, carry a date proven
-- wrong by the employee's OWN date_of_leaving already on file — not a
-- judgment call about what a number should be (the kind of historical
-- correction this codebase deliberately leaves to a human), just a
-- mechanical fix to a date the code itself got wrong. Scoped tightly: only
-- an accrual row whose own period_month covers the employee's real exit
-- date, and whose stored date sits strictly after it.
-- ----------------------------------------------------------------------------
update public.employee_leave_ledger l
   set transaction_date = e.date_of_leaving
  from public.employees e
 where l.employee_id = e.id
   and l.entry_type = 'accrual'
   and e.date_of_leaving is not null
   and l.transaction_date > e.date_of_leaving
   and e.date_of_leaving >= l.period_month
   and e.date_of_leaving <= (date_trunc('month', l.period_month) + interval '1 month - 1 day')::date;

