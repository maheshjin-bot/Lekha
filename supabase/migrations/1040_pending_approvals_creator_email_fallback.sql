-- ============================================================================
-- 1040 — Approvals list: "Created by" is blank for every voucher
-- ============================================================================
-- Confirmed live: the Approvals page's "Created by" column reads "—" for
-- every pending voucher, even though the SAME page's Approve button already
-- disables correctly with "You created this voucher — a different admin must
-- approve it." for the signed-in user's own vouchers. That message is driven
-- by approve_voucher (0028) comparing vouchers.created_by to auth.uid()
-- directly — so created_by itself is captured correctly on every voucher, in
-- exactly the same way 0760 already proved changed_by is captured correctly
-- on every audit_log row. The display side is where this breaks, not the
-- capture side.
--
-- ROOT CAUSE — TRACED, NOT ASSUMED, AND NOT QUITE THE SHAPE THE BUG REPORT
-- DESCRIBED. There is no RPC backing this column at all.
-- app/(app)/[companyId]/approvals/page.tsx does two direct PostgREST reads:
--   1. `select id, ..., created_by from vouchers where ...` (RLS: vouchers_read,
--      0007 — is_company_member + can_access_branch)
--   2. `select id, full_name from profiles where id in (...)` (RLS:
--      profiles_read, 0003)
-- and then renders `profiles.full_name || "—"` per row (line 61, before this
-- migration). Both queries succeed and RLS lets them through — there is no
-- error to see, which is exactly why this shipped unnoticed. The bug is the
-- same one 0760 and 0107 already found twice: public.profiles.full_name is
-- populated only from raw_user_meta_data ->> 'full_name' at signup
-- (app_private.handle_new_user, 0003), this app's sign-up form never sends
-- that metadata (components/auth/LoginForm.tsx: `supabase.auth.signUp({
-- email, password })`, two arguments), and there is still no screen anywhere
-- that sets full_name after the fact. So profiles.full_name is null for every
-- account this app has ever created, and `p.full_name || "—"` collapses every
-- correctly-captured creator into the same blank dash.
--
-- Because no RPC exists here today, "redefine the function" isn't literally
-- available the way it was for get_audit_trail — there is nothing to
-- `create or replace`. The equivalent fix is the one 0107 already used to
-- solve this exact class of problem for the team roster: a new, narrow
-- SECURITY DEFINER RPC that can join auth.users for an email fallback (RLS
-- never grants authenticated a direct read on auth.users), returning the
-- resolved name alongside the row instead of leaving the client to stitch
-- profiles in separately and silently lose the fallback.
--
-- get_pending_approvals(company_id) replaces both direct reads above with one
-- call. Because SECURITY DEFINER runs as the function owner rather than the
-- calling user, Postgres does not re-apply vouchers_read for this query (the
-- same fact 0760's header spells out for get_audit_trail vs audit_log_read) —
-- so this function restates vouchers_read's own predicate,
-- is_company_member(company_id) and can_access_branch(branch_id), verbatim,
-- rather than relying on RLS it is not actually subject to. Gated on
-- is_company_member (not admin-only): a branch-restricted non-admin member
-- can already see these same rows and this same creator's name via the two
-- queries being replaced, so this keeps the access bar identical rather than
-- narrowing or widening it.
--
-- WHAT THIS DOES NOT TOUCH: approve_voucher itself (0028) — the authorisation
-- check was never the bug, and is untouched here. profiles or its RLS —
-- unchanged; other pages reading profiles.full_name directly (TeamManager
-- already has its own auth.users fallback via get_company_team, 0107) are out
-- of scope for this fix.
-- ============================================================================

create or replace function public.get_pending_approvals(
  p_company_id uuid
) returns table (
  id uuid,
  voucher_number text,
  voucher_type text,
  voucher_date date,
  total_amount numeric,
  created_by uuid,
  creator_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    v.id,
    v.voucher_number,
    v.voucher_type,
    v.voucher_date,
    v.total_amount,
    v.created_by,
    -- profiles.full_name is null for every account this app has ever created
    -- (see header, and 0107/0760's identical finding) — email is the only
    -- identifying fact guaranteed to exist for a real user. A voucher whose
    -- created_by is null (or whose creator's auth.users row is gone) keeps
    -- reading null here, same as before; the page's own "—" fallback still
    -- applies to that genuinely-unknown case.
    coalesce(p.full_name, u.email::text) as creator_name
  from public.vouchers v
  left join public.profiles p on p.id = v.created_by
  left join auth.users u on u.id = v.created_by
  where v.company_id = p_company_id
    and v.is_deleted = false
    and v.approval_status = 'pending'
    -- Re-stating vouchers_read's (0007) own predicate explicitly: this
    -- function is SECURITY DEFINER, so RLS on vouchers is not re-applied for
    -- it, and the access bar must be kept identical here in the body instead
    -- of assumed from the table's policy.
    and (select app_private.is_company_member(v.company_id))
    and (select app_private.can_access_branch(v.branch_id))
  order by v.voucher_date desc;
$$;

revoke all on function public.get_pending_approvals(uuid) from public, anon;
grant execute on function public.get_pending_approvals(uuid) to authenticated;

comment on function public.get_pending_approvals is
  'Pending (approval_status = ''pending'', not deleted) vouchers for one company, company-member/branch-gated exactly as vouchers_read (0007) is — re-checked explicitly in the body because this function is SECURITY DEFINER. creator_name resolves to profiles.full_name if a company ever collects one, falling back to auth.users.email otherwise, which is every account today (see 0107, 0760, and this migration''s own header). Replaces the Approvals page''s prior direct vouchers+profiles reads, which had no such fallback and always showed a blank "Created by". See 1040.';
