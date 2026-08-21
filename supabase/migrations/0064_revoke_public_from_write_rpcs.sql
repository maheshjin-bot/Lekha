-- ============================================================================
-- 0064 — Revoke PUBLIC too, not just anon, from today's write RPCs
-- ============================================================================
-- Found by a permanent invariant catching itself: 0063's own test suite
-- asserted create_api_key/revoke_api_key were NOT executable by anon, ran
-- it, and it failed — both were. Postgres GRANTs EXECUTE on every new
-- function to the PUBLIC pseudo-role by default at creation time, and every
-- real role (anon included) is implicitly a member of PUBLIC. `revoke
-- execute ... from anon` on its own does not remove that broader grant —
-- only revoking from PUBLIC itself does. delete_company (0010) already gets
-- this right: `revoke execute on function public.delete_company(uuid) from
-- public, anon;`. Every write-capable function this session added today
-- (0057, 0058, 0061, 0063) copied only the second half of that pattern.
--
-- NOT AN EXPLOITABLE VULNERABILITY, verified directly before writing this
-- fix, not assumed: a real anon call to create_order (0061) was attempted
-- against a live company and refused with "new row violates row-level
-- security policy for table orders" — every one of these functions is
-- SECURITY INVOKER, so it runs with the CALLING role's own RLS, and every
-- underlying table's own can_write_company-gated policy blocks the write
-- regardless of whether the function itself could be invoked. This is
-- defense in depth closing an unnecessary invocation surface, not a
-- disclosed data exposure — worth fixing precisely because the SECOND
-- layer (RLS) held today; a future change to RLS or to can_write_company
-- should not be the only thing standing between anon and a write.
--
-- SCOPE: exactly the seven write-capable functions from today's session
-- that already showed a `revoke ... from anon` (clear intent to lock them
-- down, just incomplete) — not every read-only get_* RPC also added today,
-- which are already fully protected by their own tables' SELECT policies
-- regardless of anon-callability, the same reasoning the exploit attempt
-- above demonstrates for writes.
-- ============================================================================

revoke execute on function public.set_entry_cost_centre(uuid, uuid[], uuid) from public, anon;
revoke execute on function public.set_budget_lines(uuid, uuid, jsonb) from public, anon;
revoke execute on function public.create_order(uuid, uuid, text, uuid, date, date, text, text, jsonb) from public, anon;
revoke execute on function public.advance_order_status(uuid, uuid, text, text) from public, anon;
revoke execute on function public.mark_order_converted(uuid, uuid, uuid) from public, anon;
revoke execute on function public.create_api_key(uuid, text) from public, anon;
revoke execute on function public.revoke_api_key(uuid, uuid) from public, anon;
