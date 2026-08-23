-- ============================================================================
-- 0028a — 0028's column-level revoke didn't take effect
-- ============================================================================
-- `authenticated` also holds a table-wide UPDATE grant on public.vouchers
-- (Supabase's default `grant all on all tables in schema public to
-- authenticated`), and Postgres checks table-level privilege first — a
-- table-wide grant permits updating any column regardless of a column-level
-- revoke sitting alongside it in the ACL. Verified live: after 0028's
-- `revoke update (approval_status, approved_by, approved_at) ... from
-- authenticated`, information_schema.column_privileges still showed
-- authenticated with UPDATE on all three. The fix folded back into 0028
-- itself for a fresh db:reset; this applies the same fix to the
-- already-migrated live database.
-- ============================================================================

revoke update on public.vouchers from authenticated;
grant update (
  id, company_id, branch_id, voucher_type, voucher_number, sequence_number,
  financial_year_label, voucher_date, narration, reference_number,
  reference_date, party_ledger_id, txn_currency, exchange_rate, rate_source,
  total_amount, is_deleted, created_by, updated_by, created_at, updated_at,
  place_of_supply, supply_type
) on public.vouchers to authenticated;
