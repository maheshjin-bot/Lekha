-- ============================================================================
-- 1030 — Solo-admin companies could never clear the approval queue
-- ============================================================================
-- CONFIRMED LIVE, independently in 2 companies, before writing a line of fix:
--
-- 0028's maker-checker forbids self-approval by design — approve_voucher
-- raises 'You cannot approve a voucher you created yourself.' whenever
-- v_created_by = auth.uid(), unconditionally. That is a real control when a
-- second admin exists to be the checker. But company_members (0003) has no
-- floor above one: a company can run, indefinitely, with exactly one active
-- admin — a solo bookkeeper is a completely ordinary real-world shape, not an
-- edge case. For that company, EVERY voucher its one admin creates is
-- permanently unapprovable: there is no second admin who could ever approve
-- it, and none can exist without an explicit invite (0003/0107). The
-- /approvals queue only grows, forever, with no in-app explanation of why or
-- what to do about it. Confirmed non-blocking per 0028's own design (Trial
-- Balance/P&L/Balance Sheet already reflect an unapproved voucher correctly
-- — approval_status has never gated posting) — this is a stuck-workflow UX
-- bug, not a financial-correctness one.
--
-- THE FIX. Allow self-approval, but ONLY while the company genuinely lacks
-- the people to satisfy the two-person rule — fewer than 2 active admins.
-- Recomputed FRESH on every approve_voucher call from company_members,
-- never cached on the voucher or the session: if a second admin is invited
-- and accepts, the very next self-approval attempt on a still-pending
-- voucher is correctly refused again, exactly like a normal 2-admin company
-- (older vouchers already self-approved under the 1-admin state are not,
-- and should not be, retroactively unwound — that already happened and
-- approval_status is not a gate on anything to unwind).
--
-- This mirrors 0092's OPC precedent (Sec 96(1) proviso: an OPC has no AGM to
-- hold at all, because the statute itself recognises the rule cannot bind a
-- company that structurally cannot satisfy it) rather than the alternative
-- of quietly disabling the whole approval queue for such a company — the
-- rule bends exactly as far as the missing headcount requires and no
-- further: a 1-admin company's OWN vouchers become self-approvable, nothing
-- else changes, and the moment a 2nd admin exists the exception evaporates.
--
-- VISIBILITY, so this never quietly weakens the control for a company that
-- actually has a second admin. A self-approval taken under this exception
-- must not be indistinguishable from an ordinary two-person approval:
--   * vouchers.self_approved (new column) records it directly on the row,
--     next to approved_by/approved_at, so a report or a future auditor can
--     find every solo self-approval with a plain WHERE clause.
--   * 0008's generic audit trigger already fires on every UPDATE to
--     vouchers and jsonb-diffs the whole row — self_approved flipping
--     false -> true lands in audit_log's after_data automatically, with no
--     bespoke logging needed here.
--   * The UI (approvals list + voucher detail, this migration's companion
--     frontend changes) shows the exception up front as "you're the only
--     admin" rather than a dead "must be a different admin" tooltip with no
--     way forward, and marks a self-approved voucher as such once it lands.
--
-- NOT the same shape as declaring a boolean "this company is solo, exempt
-- it": the check is a live count against company_members, not a flag set
-- once at signup, precisely because a company's headcount changes over its
-- life and the rule must track that, not the moment it was created.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Column: mark a self-approval so it is never mistaken for a two-person one
-- ----------------------------------------------------------------------------
alter table public.vouchers
  add column self_approved boolean not null default false;

comment on column public.vouchers.self_approved is
  'True only when approve_voucher (1030) let the voucher''s own creator approve it, because the company had fewer than 2 active admins at approval time. False for every ordinary two-person approval. Never set directly — authenticated has no UPDATE grant on this column (see 0028''s column-privilege revoke, which this migration does not touch: self_approved is written only by approve_voucher, running as the security-definer owner).';

-- Deliberately NOT added to the authenticated column-UPDATE grant list
-- (0028/0028a) — same reasoning as approval_status/approved_by/approved_at:
-- a broad table-wide UPDATE grant would let anyone PATCH this flag directly
-- through PostgREST, bypassing approve_voucher's checks entirely. It is
-- written only inside the security-definer function below.


-- ----------------------------------------------------------------------------
-- approve_voucher — dynamic, per-call admin-headcount exception
-- ----------------------------------------------------------------------------
create or replace function public.approve_voucher(
  p_company_id uuid,
  p_voucher_id uuid
) returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_created_by uuid;
  v_active_admins integer;
  v_self_approved boolean := false;
begin
  select company_id, created_by into v_company_id, v_created_by
    from public.vouchers where id = p_voucher_id;

  if v_company_id is null then
    raise exception 'Voucher not found';
  end if;

  if v_company_id <> p_company_id then
    raise exception 'Voucher does not belong to this company';
  end if;

  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can approve vouchers.';
  end if;

  if v_created_by = auth.uid() then
    -- Recomputed fresh on every call, never cached: guard_last_admin (0003)
    -- guarantees this is never 0 for a company that still exists, so "fewer
    -- than 2" here means exactly 1 — the caller themself, the company's only
    -- admin. Two or more active admins means a genuine second checker could
    -- exist, so the original rule stands unchanged.
    select count(*) into v_active_admins
      from public.company_members
      where company_id = p_company_id and role = 'admin' and status = 'active';

    if v_active_admins >= 2 then
      raise exception 'You cannot approve a voucher you created yourself.';
    end if;

    v_self_approved := true;
  end if;

  -- Idempotent: approving an already-approved voucher is a harmless no-op,
  -- not an error — a second click should never fail.
  update public.vouchers
     set approval_status = 'approved',
         approved_by = auth.uid(),
         approved_at = now(),
         self_approved = v_self_approved
   where id = p_voucher_id
     and approval_status <> 'approved';
end;
$$;

comment on function public.approve_voucher is
  'Maker-checker review marker only — approval_status never gates posting or feeds any balance/report. Admin-only. Self-approval is forbidden UNLESS the company currently has fewer than 2 active admins (a solo admin has no possible second checker) — recomputed from company_members on every call, so the exception evaporates the moment a 2nd admin is active, even for a voucher still pending from before. Self-approvals taken under the exception are flagged via self_approved (1030). Idempotent.';
