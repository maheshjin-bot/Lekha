-- ============================================================================
-- 1270 — Ledger Statement: show the real balance even when the selected
-- period has no transactions in it
-- ============================================================================
-- get_ledger_statement (0009) computes its running balance as
-- `(select bal from opening) + sum(...)` per row of its own `rows` CTE — but
-- that CTE only contains rows for vouchers dated inside [p_from, p_to]. When
-- a ledger has real prior activity (its own opening_balance_amount, plus any
-- posted vouchers dated before p_from) but genuinely zero vouchers *inside*
-- the selected period, `rows` is empty, so the RPC returns zero rows too —
-- there is no row left to carry the opening balance out to the caller at all.
--
-- app/(app)/[companyId]/reports/ledger-statement/page.tsx then falls back to
-- `closing = lines.length ? ... : 0`, so the page's own status badge either
-- shows a wrong "Closing 0.00" or, when there are literally zero lines,
-- shows no badge at all — both silently implying the ledger has nothing
-- outstanding when it may well not. Found live: a ledger with a genuine
-- ₹5,00,000 Cr opening balance plus a real, balanced ₹1,00,000 Cr voucher
-- dated before the selected financial year showed "No entries for this
-- ledger in the period" with no indication its true carried-forward balance
-- was ₹6,00,000 Cr — exactly matching Trial Balance's own Closing figure for
-- the same ledger, so the two reports were never actually in conflict, the
-- Ledger Statement screen was just failing to say so.
--
-- Fix: a public wrapper around the existing app_private.ledger_opening_signed
-- helper (already used internally by get_ledger_statement itself, along with
-- get_trial_balance/get_daybook — this is not new arithmetic, just exposing
-- what already exists), so the page can compute the true closing balance
-- itself regardless of whether any rows come back.
-- ============================================================================

create or replace function public.get_ledger_opening_balance(
  p_company_id uuid,
  p_ledger_id uuid,
  p_before date,
  p_branch_id uuid default null
) returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select app_private.ledger_opening_signed(p_company_id, p_ledger_id, p_before, p_branch_id)
   where exists (
     select 1 from public.ledgers l
      where l.id = p_ledger_id and l.company_id = p_company_id
   );
$$;

revoke all on function public.get_ledger_opening_balance(uuid, uuid, date, uuid) from public, anon;
grant execute on function public.get_ledger_opening_balance(uuid, uuid, date, uuid) to authenticated;

comment on function public.get_ledger_opening_balance(uuid, uuid, date, uuid) is
  'Signed opening balance of a ledger as at p_before (positive = net debit, negative = net credit) — a thin public wrapper around app_private.ledger_opening_signed, the same helper get_ledger_statement/get_trial_balance/get_daybook already use internally. Exists so the Ledger Statement screen can show the true carried-forward balance even when the selected period has zero transactions in it, since get_ledger_statement itself returns no rows at all in that case (RLS-checks the ledger belongs to p_company_id by returning no row otherwise, same convention as other narrow public.get_* wrappers).';
