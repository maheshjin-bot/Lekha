-- ============================================================================
-- 1661 — delete_company is broken for every signed-in user since 1660
-- ============================================================================
-- ADDENDUM, added when this file was recovered into main on 6 Sep 2026 — see
-- 1660's own addendum for the full context (same abandoned worktree, same
-- recovery). Confirmed live before recovering: `authenticated` already holds
-- DELETE on both public.payment_webhook_events and
-- public.payment_gateway_configs, and policy payment_webhook_events_delete
-- already exists on payment_webhook_events — i.e. this file's grants/policy
-- were already applied live on 2 Sep, just never recorded in git or in
-- supabase_migrations.schema_migrations. Not re-run against the live
-- database (the `create policy` below has no IF NOT EXISTS and would fail
-- with "policy already exists"); version '1661' is recorded directly in
-- schema_migrations instead, the same way as 1660. File content otherwise
-- unchanged — safe to replay as-is on a fresh install, where it still runs
-- immediately after 1660 as originally intended.
-- ============================================================================
-- FOUND BY A PEER SESSION (quizzical-chebyshev-b81f6b), hit live while trying
-- to remove a throwaway test company. Verified independently before acting:
-- confirmed live that `authenticated` holds only SELECT on
-- public.payment_webhook_events, and delete_company is SECURITY INVOKER —
-- so its own `delete from public.payment_webhook_events where company_id =
-- p_company_id` fails 42501 (permission denied) for literally every caller,
-- admin included, the moment a company is deleted. No admin, no accountant,
-- nobody could delete ANY company from the instant 1660 was applied.
--
-- NOT A CARELESS OVERSIGHT IN 1660 — the opposite. 1660 deliberately did
-- `revoke insert, update, delete on payment_webhook_events from authenticated`
-- and `revoke select, insert, update, delete on payment_gateway_configs from
-- authenticated` (re-granting back only a scoped column-level select/update),
-- precisely to keep webhook_secret and the webhook audit trail unreachable by
-- ordinary table access — every real write already goes through SECURITY
-- DEFINER RPCs (create_payment_gateway_config, rotate_payment_gateway_
-- webhook_secret, receive_payment_webhook_event, sync_payment_webhook_event_
-- status — confirmed live, all four prosecdef = true) that bypass table
-- grants entirely. That lockdown was correct and stays exactly as tight.
-- The one hole it didn't anticipate: delete_company itself is SECURITY
-- INVOKER (matching every other line in that function, which relies on the
-- calling admin's own table grants on ledgers/vouchers/etc.), and it had
-- already checked app_private.is_company_admin(p_company_id) before ever
-- reaching these two DELETEs — so the fix is not "loosen the lockdown", it's
-- "give the admin delete_company already vetted the one privilege its own
-- body needs, nothing more".
--
-- SCOPE, DELIBERATELY NARROW: DELETE only, on both tables, to `authenticated`
-- — no INSERT/UPDATE/SELECT restored on payment_webhook_events (still
-- correctly reachable only via the definer RPCs and its own read policy),
-- and payment_gateway_configs' existing column-scoped select/update stay
-- exactly as they were. payment_gateway_configs already carries an `ALL`
-- RLS policy (payment_gateway_configs_write, is_company_admin-scoped, from
-- 1660) that already covers DELETE — it only needed the table-level grant to
-- actually reach it. payment_webhook_events had no delete-shaped RLS policy
-- at all (only payment_webhook_events_read, SELECT-only) — added one below,
-- scoped to is_company_admin to match payment_gateway_configs_write exactly
-- (and because delete_company's own top-level check already guarantees the
-- caller clears that bar by the time either DELETE runs).
--
-- Sibling tables in delete_company's own body (ledgers, voucher_entries,
-- bank_statement_lines — checked live) grant authenticated full DELETE with
-- an ALL/can_write_company-scoped policy; this is intentionally narrower
-- (admin-only, delete-only) because this pair of tables is deliberately
-- locked down in every other direction, unlike those.
-- ============================================================================

grant delete on public.payment_webhook_events to authenticated;
grant delete on public.payment_gateway_configs to authenticated;

create policy payment_webhook_events_delete on public.payment_webhook_events
  for delete to authenticated
  using ((select app_private.is_company_admin(company_id)));

comment on policy payment_webhook_events_delete on public.payment_webhook_events is
  'Admin-only, company-scoped — exists so delete_company (security invoker) can remove a company''s webhook history as part of teardown. No corresponding insert/update policy: every real write to this table goes through receive_payment_webhook_event/sync_payment_webhook_event_status (both security definer), never direct table access. See 1661.';
