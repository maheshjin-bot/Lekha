-- ============================================================================
-- 1900 — update_ledger, recovered: live in the shared database, never
-- committed to git
-- ============================================================================
-- /ledgers has always been a static table plus a "New ledger" creation
-- form — no click-to-edit, no [ledgerId] route, no update_ledger RPC
-- anywhere in this repo's git history. That gap was closed once already
-- (1 Sep 2026, per this project's memory: migration 1330 + a same-day
-- follow-up 1332 hard-locking 8 system-managed ledger names against a
-- balance-splitting rename), built and hand-verified live in a worktree
-- that was never committed — the exact "live but lost" pattern this
-- project's memory documents happening to delete_company, the payment-
-- webhook migrations, and (briefly) this project's own Branches screen.
--
-- update_ledger itself IS live right now, confirmed via pg_get_functiondef
-- against the real shared database, with the full 1330+1332 shape already
-- in place (the 8-name lock, party_type/credit_days). This migration
-- registers that existing, already-verified function in git, reproduced
-- byte-for-byte from its live definition — not rewritten from memory —
-- so this file's apply is an idempotent no-op against the current
-- database and only exists to stop it being lost a second time. The
-- frontend (the actual missing piece) is added separately in this same
-- commit: app/(app)/[companyId]/ledgers/[ledgerId]/edit/page.tsx +
-- components/ledgers/LedgerEditForm.tsx.
--
-- Design decisions preserved exactly as previously verified (see this
-- project's memory for the full reasoning, re-derived from the function
-- body below rather than trusted blind):
--   * SECURITY INVOKER, not DEFINER — a plain full-replace UPDATE on
--     public.ledgers, so RLS (ledgers_write) and every pre-existing
--     trigger/CHECK constraint that already governs INSERT
--     (protect_ledger_financial_fields, enforce_opening_balance_equity
--     from 0755, enforce_ledger_gst_identity, every ledgers_* CHECK) fire
--     on it unmodified.
--   * Opening balance/type: NOT locked. 0755's Opening Balance Equity
--     mechanism exists specifically to make this safe to edit at any
--     time, including after real postings — a stronger lock here would
--     fight that mechanism, not support it.
--   * Group: hard-locked once the ledger has >=1 real (non-deleted)
--     voucher_entries row, regardless of admin status — a group change
--     can alter the ledger's effective ledger_role (1200's
--     coalesce(ledgers.ledger_role, account_groups.ledger_role)), the
--     binding key every role-bound close posting and depreciation
--     computation resolves against.
--   * Name: hard-locked, exact-string match, for the 8 ledgers other
--     features find by name on every call rather than by id — renaming
--     one doesn't error, it silently creates a second ledger by the old
--     name the next time that feature posts, splitting the balance with
--     nothing on screen to explain it: Opening Balance Equity (0755),
--     Exchange Gain/Loss (0068), Job Work Movement (0069), Manufacturing
--     Clearing (0070), Delivery Challan Movement (0113), Stock
--     Verification Adjustment (0165), and the two Deferred Tax ledgers
--     (0091, seeds both). "Cash Sales" is deliberately NOT in this list —
--     ensure_cash_sales_ledger (0066) matches by GROUP, never by name, so
--     renaming it is inert; including it would have been over-broad.
--   * ledgers.ledger_role itself (system-only), ldc_* (owned by
--     LowerDeductionManager.tsx at /lower-deduction), and credit_limit
--     (zero readers anywhere) are deliberately NOT settable here.
--     party_type and credit_days ARE settable (job_worker was already a
--     valid constraint value with no writer; credit_days has exactly two
--     real readers, get_overdue_receivables_by_invoice and the ageing
--     report, both coalesce(l.credit_days, 30)).
-- ============================================================================

create or replace function public.update_ledger(
  p_ledger_id uuid,
  p_name text,
  p_group_id uuid,
  p_opening_balance_amount numeric,
  p_opening_balance_type text,
  p_is_active boolean,
  p_pan text,
  p_tan text,
  p_state_code character,
  p_gst_registration_type text,
  p_gstin character,
  p_contact_person text,
  p_phone text,
  p_email text,
  p_address text,
  p_city text,
  p_pincode text,
  p_notes text,
  p_udyam_number text,
  p_msme_category text,
  p_msme_payment_days smallint,
  p_bank_name text,
  p_bank_account_number text,
  p_bank_ifsc text,
  p_is_tds_deductee boolean,
  p_default_tds_section text,
  p_is_partner_remuneration boolean,
  p_is_related_party boolean,
  p_relationship_type text,
  p_is_loan_or_deposit boolean,
  p_sec43b_category text,
  p_party_type text default null,
  p_credit_days smallint default null
) returns uuid
language plpgsql
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_old_group_id uuid;
  v_old_name text;
  v_posting_count int;
begin
  select company_id, group_id, name into v_company_id, v_old_group_id, v_old_name
    from public.ledgers where id = p_ledger_id;

  if v_company_id is null then
    raise exception 'Ledger not found';
  end if;

  if not app_private.can_write_company(v_company_id) then
    raise exception 'You do not have permission to edit ledgers in this company';
  end if;

  -- The group-lock guard from 1330, unchanged.
  if p_group_id is distinct from v_old_group_id then
    select count(*) into v_posting_count
      from public.voucher_entries ve
      join public.vouchers v on v.id = ve.voucher_id and not v.is_deleted
     where ve.ledger_id = p_ledger_id;

    if v_posting_count > 0 then
      raise exception
        'This ledger has % posted transaction(s) — its account group can no longer be changed here, since moving it would retroactively reclassify every one of them across every statement. Create a new ledger under the correct group instead.',
        v_posting_count;
    end if;
  end if;

  -- The new guard. Exact-string, not lower(): a case-only change would still
  -- break the six case-sensitive by-name lookups this list protects against.
  if p_name is distinct from v_old_name
     and v_old_name = any (array[
       'Opening Balance Equity',
       'Exchange Gain/Loss',
       'Job Work Movement',
       'Manufacturing Clearing',
       'Delivery Challan Movement',
       'Stock Verification Adjustment',
       'Deferred Tax Expense',
       'Deferred Tax Liabilities (Net)'
     ])
  then
    raise exception
      '"%" is a system-managed ledger that other features find by this exact name every time they post to it — renaming it here would not fail, it would silently create a second ledger by the old name the next time that feature runs, splitting the balance across both with nothing on screen to explain why. Leave the name as it is.',
      v_old_name;
  end if;

  update public.ledgers set
    name = p_name,
    group_id = p_group_id,
    opening_balance_amount = p_opening_balance_amount,
    opening_balance_type = p_opening_balance_type,
    is_active = p_is_active,
    pan = p_pan,
    tan = p_tan,
    state_code = p_state_code,
    gst_registration_type = p_gst_registration_type,
    gstin = p_gstin,
    contact_person = p_contact_person,
    phone = p_phone,
    email = p_email,
    address = p_address,
    city = p_city,
    pincode = p_pincode,
    notes = p_notes,
    udyam_number = p_udyam_number,
    msme_category = p_msme_category,
    msme_payment_days = p_msme_payment_days,
    bank_name = p_bank_name,
    bank_account_number = p_bank_account_number,
    bank_ifsc = p_bank_ifsc,
    is_tds_deductee = p_is_tds_deductee,
    default_tds_section = p_default_tds_section,
    is_partner_remuneration = p_is_partner_remuneration,
    is_related_party = p_is_related_party,
    relationship_type = p_relationship_type,
    is_loan_or_deposit = p_is_loan_or_deposit,
    sec43b_category = p_sec43b_category,
    party_type = p_party_type,
    credit_days = p_credit_days
  where id = p_ledger_id;

  return p_ledger_id;
end;
$function$;

revoke all on function public.update_ledger(
  uuid, text, uuid, numeric, text, boolean, text, text, character, text, character,
  text, text, text, text, text, text, text, text, text, smallint, text, text, text,
  boolean, text, boolean, boolean, text, boolean, text, text, smallint
) from public, anon;
grant execute on function public.update_ledger(
  uuid, text, uuid, numeric, text, boolean, text, text, character, text, character,
  text, text, text, text, text, text, text, text, text, smallint, text, text, text,
  boolean, text, boolean, boolean, text, boolean, text, text, smallint
) to authenticated;

comment on function public.update_ledger is
  'Full-replace edit of an existing ledger, SECURITY INVOKER so every pre-existing INSERT-time trigger and CHECK constraint on public.ledgers governs this too. Group is hard-locked once >=1 real posting exists (would silently reclassify every one across every statement/role-bound computation). Name is hard-locked, exact-string, for 8 ledgers other features find by name every time they post (renaming would not error, it would split the balance across a silently-recreated second ledger) — see this function''s own migration (1900, recovered from a lost worktree; originally 1330+1332) for the full list and reasoning. Opening balance/type deliberately NOT locked — 0755''s Opening Balance Equity mechanism exists to make that safe at any time.';
