-- ============================================================================
-- 0142 — Fixes a real bug in 0140's accrue_leave_for_month, caught live
-- ============================================================================
-- Confirmed live, as the real authenticated admin user (not the sbq
-- superuser connection, which would not have hit this): calling
-- accrue_leave_for_month raised
--   42702: column reference "employee_id" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
-- RETURNS TABLE (employee_id uuid, days_accrued numeric) makes
-- `employee_id` an OUT-parameter name in scope for the whole function
-- body. The INSERT's `on conflict (employee_id, period_month)` target list
-- takes bare column names only (it cannot be table-qualified), and
-- PL/pgSQL's variable-shadowing rules make that bare reference ambiguous
-- against its own OUT parameter — even though the SELECT list and the
-- RETURNING clause were already correctly table-qualified. Not caught by
-- npm run check:sql (a parse-only check, not an execution check) or by the
-- earlier sbq-superuser dry runs of this same statement shape, which
-- exercise the same SQL text but not through a role where the ON CONFLICT
-- path's identifier resolution actually got exercised against a live
-- PL/pgSQL variable scope in the way a real call does.
--
-- Following 0112's own precedent for this exact situation (a bug found in
-- an already-applied same-session migration): fix forward with a new
-- migration rather than editing 0140 after the fact. CREATE OR REPLACE
-- FUNCTION is idempotent, so a from-scratch migration replay picks up
-- 0140's version and then this one harmlessly re-applies the same
-- definition.
--
-- THE FIX: rename the OUT parameters to accrual_employee_id/
-- accrual_days_accrued, names that do not collide with any column in
-- employees or employee_leave_ledger, so the ON CONFLICT target list's
-- bare `employee_id` can only mean the table column. No other logic
-- changes.
-- ============================================================================

drop function if exists public.accrue_leave_for_month(uuid, date);

create function public.accrue_leave_for_month(
  p_company_id uuid,
  p_period_month date
) returns table (
  accrual_employee_id uuid,
  accrual_days_accrued numeric
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
  returning employee_leave_ledger.employee_id, employee_leave_ledger.days;
end;
$fn$;

revoke all on function public.accrue_leave_for_month(uuid, date) from public, anon;
grant execute on function public.accrue_leave_for_month(uuid, date) to authenticated;

comment on function public.accrue_leave_for_month is
  'Credits one accrual row per eligible active employee for a calendar month, prorated by days-in-employment. Idempotent per (employee, month) via a partial unique index — re-running is safe, already-accrued pairs are silently skipped, not double-credited. Admin-only, same bar as post_payroll_run. Output columns are accrual_employee_id/accrual_days_accrued, not employee_id/days_accrued, to avoid a PL/pgSQL OUT-parameter/column-name collision in the ON CONFLICT clause — see 0142. See 0130/0140 for the feature.';
