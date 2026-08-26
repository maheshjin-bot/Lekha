-- ============================================================================
-- 0231 — Revoke anon EXECUTE from session-authenticated internal RPCs
-- ============================================================================
-- information_schema.routine_privileges showed 36 public/app_private
-- functions granting EXECUTE to anon. Six are deliberate:
--   api_get_dashboard_kpis, api_get_trial_balance   — 0063 public-API-key-gated
--   get_signature_request_by_token,
--   record_signed_document_by_token                 — 0575 token-gated external-signer RPCs
--   signature_request_source_doc_visible,
--   signature_request_signer_upload_allowed          — 0660 storage-policy helpers anon
--                                                       genuinely needs to invoke
-- The other 30 are internal RPCs meant only for a logged-in `authenticated`
-- session (voucher deletion, dashboard/report reads, ledger statements, ...)
-- with no reason for anon to ever call them.
--
-- Confirmed live before writing this (begin; set local role anon; call with
-- real args; rollback — same pattern 0064 used) that anon is already fully
-- blocked, and by more than one mechanism, so no application behavior
-- depends on this access:
--   delete_voucher          -> RLS empties the SELECT, function raises
--                              "Voucher not found"; no row touched
--   get_dashboard_kpis,
--   get_trial_balance       -> "permission denied for schema app_private"
--                              (anon lacks USAGE on app_private)
--   get_notices             -> RLS policies are authenticated-only, anon
--                              gets zero rows back
-- All 30 are also SECURITY INVOKER (prosecdef = false), confirmed via
-- pg_proc, so this is defense in depth closing an unnecessary invocation
-- surface, not a disclosed data exposure — the same conclusion 0064 reached
-- for that batch of write RPCs.
--
-- Like 0064: revoking only from anon is not enough. All 30 also carry a
-- PUBLIC grant (Postgres's default at CREATE FUNCTION time), and anon is
-- implicitly a member of PUBLIC, so EXECUTE via that inherited grant would
-- survive an anon-only revoke. Revoking `from public, anon` closes both.
-- authenticated keeps its own separate explicit grant, untouched.
-- ============================================================================

revoke execute on function public.delete_voucher(uuid, uuid) from public, anon;
revoke execute on function public.find_duplicate_bills(uuid, uuid, text, uuid) from public, anon;
revoke execute on function public.get_allocatable_entries(uuid, date, date, boolean) from public, anon;
revoke execute on function public.get_audit_trail(uuid, timestamptz, timestamptz, text, integer) from public, anon;
revoke execute on function public.get_bank_reconciliation_summary(uuid, uuid, date) from public, anon;
revoke execute on function public.get_budget_variance(uuid, uuid, date, date) from public, anon;
revoke execute on function public.get_cost_centre_pnl(uuid, date, date) from public, anon;
revoke execute on function public.get_dashboard_kpis(uuid, date) from public, anon;
revoke execute on function public.get_daybook(uuid, date, date, uuid) from public, anon;
revoke execute on function public.get_drawing_power(uuid, date, uuid) from public, anon;
revoke execute on function public.get_fixed_asset_register(uuid, date) from public, anon;
revoke execute on function public.get_form_3cd_particulars(uuid, date, date) from public, anon;
revoke execute on function public.get_general_sec43b_dues(uuid, date, date) from public, anon;
revoke execute on function public.get_gst_input_register(uuid, date, date, uuid) from public, anon;
revoke execute on function public.get_gst_output_register(uuid, date, date, uuid) from public, anon;
revoke execute on function public.get_isd_distribution(uuid, uuid, date, date) from public, anon;
revoke execute on function public.get_ledger_statement(uuid, uuid, date, date, uuid) from public, anon;
revoke execute on function public.get_needs_attention(uuid) from public, anon;
revoke execute on function public.get_notices(uuid, text) from public, anon;
revoke execute on function public.get_orders(uuid, text, text) from public, anon;
revoke execute on function public.get_overdue_receivables(uuid, date) from public, anon;
revoke execute on function public.get_party_outstanding(uuid, date, text) from public, anon;
revoke execute on function public.get_related_party_payments(uuid, date, date) from public, anon;
revoke execute on function public.get_sec269ss_loan_receipts(uuid, date, date) from public, anon;
revoke execute on function public.get_sec269t_loan_repayments(uuid, date, date) from public, anon;
revoke execute on function public.get_sec40a3_cash_payments(uuid, date, date) from public, anon;
revoke execute on function public.get_tax_audit_applicability(uuid, date, date) from public, anon;
revoke execute on function public.get_tax_depreciation_blocks(uuid, date, date) from public, anon;
revoke execute on function public.get_tds_deductee_summary(uuid, date, date) from public, anon;
revoke execute on function public.get_trial_balance(uuid, date, date, uuid) from public, anon;
