-- ============================================================================
-- 0045 — 0044's anon revoke didn't take effect
-- ============================================================================
-- This schema's default privileges grant EXECUTE on newly created functions
-- to `anon` directly (not via the PUBLIC pseudo-role), so 0044's
-- `revoke all ... from public` on set_company_password/verify_company_password
-- was a no-op for anon — verified live via information_schema.routine_privileges,
-- both still showed `anon` with EXECUTE after 0044. Every other RPC in this
-- schema (create_company, approve_voucher, ...) carries no anon grant, so
-- this brings the two new ones in line. Same shape of fix as 0028a.
-- ============================================================================

revoke execute on function public.set_company_password(uuid, text) from anon;
revoke execute on function public.verify_company_password(uuid, text) from anon;
