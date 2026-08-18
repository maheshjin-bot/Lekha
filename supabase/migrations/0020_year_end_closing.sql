-- ============================================================================
-- 0020 — Year-end closing: actually setting the lock date
-- ============================================================================
-- Year-end closing is declared a CORE (always-on) module in 0004 ("Books must
-- roll over"), and the enforcement half of it has existed since 0007:
-- companies.lock_date, app_private.is_period_open, and a trigger
-- (enforce_period_open) that rejects any insert/update/delete on vouchers
-- dated on or before it. That part is correct and was never the gap.
--
-- The gap: nothing can ever WRITE lock_date. There is no RLS write policy on
-- public.companies at all (by design — 0004's set_module comment makes the
-- same call for company_modules: mutation belongs behind a checked RPC, not a
-- bare table grant), so admin or not, no client can close a period through
-- the app. tests/db/invariants.test.ts even has the empty stub
-- `it("enforce_period_open rejects a voucher dated on or before lock_date")`
-- waiting on exactly this.
--
-- This migration adds the two RPCs that were missing and nothing else —
-- no new tables, no "closing entries": the reports already compute the P&L
-- and balance sheet from a from/to range (see lib/utils/period.ts), so a
-- financial year's numbers are already correct without a year-end journal.
-- Closing has one job here: freeze the past so it cannot silently change.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Close: move the lock date forward
-- ----------------------------------------------------------------------------
-- Deliberately admin-only and forward-only. A period is closed once its
-- figures have been relied on — a bank reconciliation signed off, a return
-- filed, a lender statement sent — and reopening that has to be a distinct,
-- visible act (reopen_period below), not a side effect of closing again with
-- an earlier date by mistake.
create or replace function public.close_period(
  p_company_id uuid,
  p_lock_date date
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_lock date;
  v_book_beginning date;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can close a period';
  end if;

  select lock_date, book_beginning_date into v_current_lock, v_book_beginning
    from public.companies where id = p_company_id;

  if v_book_beginning is null then
    raise exception 'Company not found';
  end if;

  -- A period that has not finished cannot be closed — that would lock out
  -- today's and tomorrow's entries too, not just the past.
  if p_lock_date >= current_date then
    raise exception
      'Cannot close through % — that is today or in the future. Close only a period that has fully passed.',
      p_lock_date;
  end if;

  if p_lock_date < v_book_beginning then
    raise exception
      'Cannot close through % — the books begin on %.', p_lock_date, v_book_beginning;
  end if;

  if v_current_lock is not null and p_lock_date <= v_current_lock then
    raise exception
      'The books are already closed through %. Closing only moves the lock date forward — use Reopen to move it back.',
      v_current_lock;
  end if;

  update public.companies set lock_date = p_lock_date where id = p_company_id;
  -- Captured automatically: 0008's audit trigger on public.companies logs
  -- this update, so "who closed what, when" is get_audit_trail(company_id,
  -- p_table_name => 'companies') with no extra bookkeeping here.
end;
$$;

comment on function public.close_period is
  'Locks every voucher dated on or before p_lock_date against insert/update/delete (app_private.enforce_period_open, since 0007). Admin only; only moves the lock date forward. See reopen_period to move it back.';

revoke execute on function public.close_period(uuid, date) from public, anon;


-- ----------------------------------------------------------------------------
-- Reopen: move the lock date back, or clear it
-- ----------------------------------------------------------------------------
create or replace function public.reopen_period(
  p_company_id uuid,
  p_new_lock_date date default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_lock date;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can reopen a period';
  end if;

  select lock_date into v_current_lock from public.companies where id = p_company_id;

  if v_current_lock is null then
    raise exception 'The books are not locked; there is nothing to reopen';
  end if;

  if p_new_lock_date is not null and p_new_lock_date >= v_current_lock then
    raise exception
      'Reopening must move the lock date back from % (or clear it entirely) — % does not.',
      v_current_lock, p_new_lock_date;
  end if;

  update public.companies set lock_date = p_new_lock_date where id = p_company_id;
end;
$$;

comment on function public.reopen_period is
  'Moves the lock date back, or clears it (p_new_lock_date default null), reopening previously-closed periods for editing. Admin only. Every use is captured in the audit trail on companies.';

revoke execute on function public.reopen_period(uuid, date) from public, anon;
