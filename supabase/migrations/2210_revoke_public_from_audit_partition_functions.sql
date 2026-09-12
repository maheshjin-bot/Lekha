-- ============================================================================
-- 2210 — Revoke the PUBLIC EXECUTE grant from the two audit-partition helpers
-- ============================================================================
-- Found while sweeping app_private for the same PUBLIC-grant hole 2200 just
-- closed on nine ledger-writing helpers: app_private.ensure_audit_partition
-- (date) and app_private.secure_audit_partition(text) are a sharper case of
-- the same thing. Both are SECURITY DEFINER, both still carry the default
-- PUBLIC grant, and both run arbitrary dynamic DDL — `create table ...
-- partition of`, `alter table ... enable/force row level security`,
-- `create policy` — built with format(%I) from their own arguments (0008).
--
-- NOT EXPLOITABLE TODAY, same reason as 2200: anon has no USAGE on the
-- app_private schema, so nothing outside this database can even name these
-- functions, let alone call them.
--
-- Checked individually before revoking, not assumed: every real caller
-- reaches these two through a context that already runs as `postgres`
-- regardless of grants —
--   - the monthly pg_cron job (0021) that keeps future partitions ready runs
--     as the role that scheduled it (postgres, the migration-applying role);
--   - app_private.audit_change(), the trigger that calls
--     secure_audit_partition indirectly via ensure_audit_partition on first
--     write to a new month, is itself SECURITY DEFINER and owned by
--     postgres, so it runs as its owner regardless of which role performed
--     the triggering DML;
--   - both functions also already carry an explicit `authenticated` grant
--     alongside PUBLIC, so even a hypothetical SECURITY INVOKER caller
--     running as `authenticated` loses nothing.
-- No caller anywhere depends on the PUBLIC grant specifically.
-- ----------------------------------------------------------------------------

revoke all on function app_private.ensure_audit_partition(date) from public, anon;
grant execute on function app_private.ensure_audit_partition(date) to authenticated;

revoke all on function app_private.secure_audit_partition(text) from public, anon;
grant execute on function app_private.secure_audit_partition(text) to authenticated;
