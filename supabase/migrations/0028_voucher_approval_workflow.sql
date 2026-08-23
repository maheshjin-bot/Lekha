-- ============================================================================
-- 0028 — Voucher approval workflow: a non-gating maker-checker flag
-- ============================================================================
-- A review marker, nothing more. approval_status does not gate posting, does
-- not appear in any balance, trial balance, P&L or balance sheet computation,
-- and does not block any existing RPC — a voucher is fully live the moment
-- create_voucher/create_invoice commits, exactly as before this migration.
-- All this adds is a way for a second person to mark "I looked at this one".
--
-- MAKER-CHECKER. approve_voucher enforces the one rule that makes the flag
-- meaningful: the person who created a voucher cannot be the one who approves
-- it, even if they are a company admin. Only an admin can approve at all.
--
-- WHY THE COLUMN-LEVEL REVOKE. vouchers_write (0007) already lets any company
-- writer (admin or accountant) UPDATE a voucher row — that is what lets
-- update_voucher edit narration/date. Without locking approval_status,
-- approved_by and approved_at down at the column-privilege level, that same
-- broad UPDATE grant would let a non-admin (or the voucher's own creator)
-- self-approve by PATCHing the row directly through PostgREST, bypassing
-- approve_voucher and its checks entirely. Revoking UPDATE on just those
-- three columns from `authenticated` closes that path while leaving every
-- other column, and update_voucher itself, untouched.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Columns
-- ----------------------------------------------------------------------------
alter table public.vouchers
  add column approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved')),
  add column approved_by uuid references auth.users(id),
  add column approved_at timestamptz;

-- Backfill: history predates the concept of review and must not be
-- retroactively flagged pending. Everything that existed before this
-- migration lands is deemed approved; only vouchers created from here on
-- start life pending, via the column default above.
update public.vouchers set approval_status = 'approved' where approval_status = 'pending';

-- create_voucher, create_invoice and the CSV import path all list their
-- target columns explicitly rather than relying on column order, and none of
-- them mention approval_status — so every voucher they insert takes the
-- column default ('pending') with no change needed to those functions.

-- A column-level REVOKE alone is not enough here: `authenticated` also holds
-- a table-wide UPDATE grant (Supabase's default `grant all on all tables in
-- schema public to authenticated`), and Postgres checks table-level
-- privilege first — a table-wide grant permits updating any column
-- regardless of a column-level revoke sitting alongside it in the ACL. The
-- only way to actually lock these three columns down is to revoke the
-- table-wide UPDATE entirely and re-grant UPDATE on just the columns that
-- should stay editable through direct PostgREST writes.
revoke update on public.vouchers from authenticated;
grant update (
  id, company_id, branch_id, voucher_type, voucher_number, sequence_number,
  financial_year_label, voucher_date, narration, reference_number,
  reference_date, party_ledger_id, txn_currency, exchange_rate, rate_source,
  total_amount, is_deleted, created_by, updated_by, created_at, updated_at,
  place_of_supply, supply_type
) on public.vouchers to authenticated;

create index vouchers_company_pending_idx
  on public.vouchers(company_id)
  where approval_status = 'pending' and is_deleted = false;


-- ----------------------------------------------------------------------------
-- approve_voucher
-- ----------------------------------------------------------------------------
-- security definer: the column-level revoke above means `authenticated` has
-- no UPDATE privilege on these columns at all, so this must run as the
-- definer to make the change — invoker rights would simply fail. The checks
-- inside stand in for what RLS would otherwise enforce.
create or replace function public.approve_voucher(
  p_company_id uuid,
  p_voucher_id uuid
) returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_created_by uuid;
begin
  select company_id, created_by into v_company_id, v_created_by
    from public.vouchers where id = p_voucher_id;

  if v_company_id is null then
    raise exception 'Voucher not found';
  end if;

  if v_company_id <> p_company_id then
    raise exception 'Voucher does not belong to this company';
  end if;

  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can approve vouchers.';
  end if;

  if v_created_by = auth.uid() then
    raise exception 'You cannot approve a voucher you created yourself.';
  end if;

  -- Idempotent: approving an already-approved voucher is a harmless no-op,
  -- not an error — a second click should never fail.
  update public.vouchers
     set approval_status = 'approved',
         approved_by = auth.uid(),
         approved_at = now()
   where id = p_voucher_id
     and approval_status <> 'approved';
end;
$$;

revoke execute on function public.approve_voucher(uuid, uuid) from public, anon;
grant execute on function public.approve_voucher(uuid, uuid) to authenticated;

comment on function public.approve_voucher is
  'Maker-checker review marker only — approval_status never gates posting or feeds any balance/report. Admin-only, no self-approval, idempotent.';
