-- ============================================================================
-- 2200 — Revoke the PUBLIC EXECUTE grant from nine app_private write helpers
-- ============================================================================
-- app_private.ensure_depreciation_ledgers(uuid) still carries Postgres'
-- default PUBLIC EXECUTE grant, which every real role — anon included —
-- inherits (revoking from anon alone is a no-op; this has recurred before,
-- see 0064 and 1844). It is SECURITY DEFINER and INSERTs real ledgers, so a
-- direct anon call would run as the function's owner regardless of RLS.
--
-- NOT EXPLOITABLE TODAY, verified live before writing this, not assumed:
-- anon holds no USAGE on the app_private schema at all
-- (has_schema_privilege('anon','app_private','USAGE') = false), and
-- PostgREST refuses to expose a schema it has no USAGE on, so there is no
-- route from the anon key to this function's name today. 1844 found the same
-- true of ~95 other app_private functions and, for most of them, deliberately
-- left the PUBLIC grant alone: revoking it would strip service_role's ONLY
-- path to functions that carry no explicit service_role grant, for zero
-- reduction in reachable surface.
--
-- This migration is narrower than that, and safe for a different reason than
-- "it's fine, don't touch it": each of the nine functions below actually
-- WRITES (an insert or update), and each was checked individually, not
-- assumed, to confirm revoking PUBLIC breaks nothing:
--
--   - ensure_deferred_tax_ledgers, seed_gst_ledgers, seed_payroll_ledgers,
--     seed_tcs_ledger, seed_tds_ledgers, check_voucher_balance: every real
--     caller reaches them from a SECURITY DEFINER wrapper owned by
--     `postgres` (post_depreciation's sibling posting functions, the
--     seed_chart_of_accounts family, trg_voucher_entries_balance). Postgres
--     switches the effective role to the DEFINER function's owner for the
--     duration of its body, and an object's owner always has implicit
--     EXECUTE on their own objects — so these nested calls never depended on
--     the PUBLIC grant at all.
--   - authenticate_api_key: both its callers (api_get_trial_balance,
--     api_get_dashboard_kpis, 0063) are themselves SECURITY DEFINER and
--     owned by postgres, same reasoning.
--   - opening_balance_equity_ledger: its one SECURITY INVOKER caller
--     (public.balance_opening_balances, 1350) runs as the calling role
--     itself, not postgres — but that role is `authenticated`, and this
--     function already carries an explicit `authenticated` grant alongside
--     PUBLIC, so removing PUBLIC changes nothing for it either.
--
-- app_private.ensure_stock_ledgers(uuid) — ensure_depreciation_ledgers' own
-- sibling from 0076/0077, and the "same pattern migration 1200 established"
-- this migration was asked to follow — already carries no PUBLIC grant live
-- (only authenticated and postgres). No migration in this repo revokes it
-- explicitly, so that fix was applied by hand directly against the shared
-- database at some point and never committed — the exact hazard this
-- project's own notes warn about. This migration brings its sibling and
-- these eight others to the same state, on the record, in git.
--
-- The remaining ~85 app_private functions that still carry PUBLIC are
-- deliberately NOT touched here: they are either trigger functions (which
-- Postgres refuses to invoke directly under any grant — "trigger functions
-- can only be called as triggers" is enforced by the server itself, not by
-- an EXECUTE check) or pure/validation helpers with no side effect worth
-- gating. 1844's decision to leave that broader set alone stands; this
-- migration does not reopen it.
-- ----------------------------------------------------------------------------

revoke all on function app_private.ensure_depreciation_ledgers(uuid) from public, anon;
grant execute on function app_private.ensure_depreciation_ledgers(uuid) to authenticated;

revoke all on function app_private.ensure_deferred_tax_ledgers(uuid) from public, anon;
grant execute on function app_private.ensure_deferred_tax_ledgers(uuid) to authenticated;

revoke all on function app_private.seed_gst_ledgers(uuid, uuid) from public, anon;
grant execute on function app_private.seed_gst_ledgers(uuid, uuid) to authenticated;

revoke all on function app_private.seed_payroll_ledgers(uuid) from public, anon;
grant execute on function app_private.seed_payroll_ledgers(uuid) to authenticated;

revoke all on function app_private.seed_tcs_ledger(uuid) from public, anon;
grant execute on function app_private.seed_tcs_ledger(uuid) to authenticated;

revoke all on function app_private.seed_tds_ledgers(uuid) from public, anon;
grant execute on function app_private.seed_tds_ledgers(uuid) to authenticated;

revoke all on function app_private.authenticate_api_key(text) from public, anon;
grant execute on function app_private.authenticate_api_key(text) to authenticated;

revoke all on function app_private.check_voucher_balance(uuid) from public, anon;
grant execute on function app_private.check_voucher_balance(uuid) to authenticated;

revoke all on function app_private.opening_balance_equity_ledger(uuid) from public, anon;
grant execute on function app_private.opening_balance_equity_ledger(uuid) to authenticated;
