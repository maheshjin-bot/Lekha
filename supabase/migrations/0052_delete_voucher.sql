-- ============================================================================
-- 0052 — delete_voucher: a soft-delete RPC for the correction/void case
-- ============================================================================
-- Every balance-computing function already treats vouchers.is_deleted = true
-- as "doesn't exist financially" (0009's app_private.ledger_opening_signed and
-- every report built on it filter `not v.is_deleted`), so flipping that flag
-- is the entire operation — no separate cleanup of voucher_entries or
-- voucher_items rows is needed or wanted; they stay in place as history under
-- an is_deleted header, exactly like every reporting function already expects.
--
-- SECURITY INVOKER, deliberately, matching create_voucher/update_voucher
-- (0007): this is a correction action available to whoever can already edit
-- a voucher — RLS's vouchers_write policy (can_write_company +
-- can_access_branch) gates it exactly as it already gates UPDATE, not a
-- stronger, admin-only tier the way approve_voucher (0028) is.
--
-- THE BANK-RECONCILIATION GUARD. 0019's bank_statement_lines.matched_entry_id
-- points at a voucher_entries row with ON DELETE SET NULL, but this is a soft
-- delete — the entry row itself is never removed, so that FK action never
-- fires and would silently let a "matched" statement line keep pointing at an
-- entry that belongs to a now-vanished voucher. Refusing outright is safer
-- than half-reconciling: the user is told to unmatch first, in Reconciliation,
-- where they can see and re-decide the match.
--
-- THE PERIOD LOCK. No new logic needed: enforce_period_open (0007) already
-- fires `before insert or update or delete on public.vouchers` for every row,
-- so the plain `update ... set is_deleted = true` below already goes through
-- it and is already correctly blocked when voucher_date falls on or before
-- the company's lock_date. Verified below, not assumed.
--
-- IDEMPOTENT. Calling this twice on the same voucher must not error — a
-- second click (or a retried request) should be a harmless no-op, same
-- posture as approve_voucher (0028).
-- ============================================================================

create or replace function public.delete_voucher(
  p_company_id uuid,
  p_voucher_id uuid
) returns void
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_company_id uuid;
  v_is_deleted boolean;
begin
  select company_id, is_deleted
    into v_company_id, v_is_deleted
    from public.vouchers
   where id = p_voucher_id;

  if v_company_id is null or v_company_id <> p_company_id then
    raise exception 'Voucher not found';
  end if;

  -- Idempotent: already deleted is a harmless no-op, not an error.
  if v_is_deleted then
    return;
  end if;

  if exists (
    select 1
      from public.voucher_entries e
      join public.bank_statement_lines l on l.matched_entry_id = e.id
     where e.voucher_id = p_voucher_id
  ) then
    raise exception 'This voucher has a bank-reconciled entry — unmatch it in Reconciliation before deleting.';
  end if;

  update public.vouchers
     set is_deleted = true,
         updated_by = auth.uid()
   where id = p_voucher_id;
end;
$$;

grant execute on function public.delete_voucher(uuid, uuid) to authenticated;

comment on function public.delete_voucher is
  'Soft delete: flips vouchers.is_deleted, which every report/balance function already excludes. Same write permission as update_voucher (RLS-gated, not admin-only), idempotent, blocked by the same period-lock trigger as any other voucher UPDATE, and refuses if any entry is matched to a bank statement line.';
