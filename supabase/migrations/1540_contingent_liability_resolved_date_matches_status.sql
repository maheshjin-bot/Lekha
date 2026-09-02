-- ============================================================================
-- 1540 — a contingent liability's status and its resolved_date must agree
-- ============================================================================
-- get_contingent_liabilities_note (0105) decides whether a
-- contingent_liabilities row belongs in the Schedule III / AS 29 note purely
-- from resolved_date, never from status:
--     and (cl.resolved_date is null or cl.resolved_date > p_as_at)
-- That is deliberate and correct — the note is an AS AT statement, so a bank
-- guarantee released in July 2026 must still appear in the note as at 31 Mar
-- 2026 and must drop out of the note as at 31 Mar 2027. A status flag cannot
-- express that, which is exactly why it is not the filter.
--
-- The consequence, unguarded until now: a row saved as status='closed' with
-- resolved_date left null is disclosed as a contingent liability FOREVER — in
-- every note, at every as-at date — while every screen shows it as closed.
-- That is the same wrong-disclosure failure the frontend work shipped
-- alongside this migration fixes for notices.is_disclosed_as_contingent: a
-- signed financial statement carrying a liability the company no longer has.
-- Worse than an omission, because it reads as a considered disclosure.
--
-- The guard is a biconditional, not a one-way "closed needs a date". The
-- mirror state — resolved_date set while status='open' — is just as
-- contradictory: the item silently leaves the note while the screen still
-- calls it open, and a preparer reconciling the note against the register
-- would have nothing to go on. Both states are now unrepresentable.
--
-- The frontend built with this (components/contingent-liabilities/) sets both
-- columns together in one update for exactly this reason — resolving asks for
-- the date and refuses without it, reopening clears it. The constraint is the
-- backstop, not the user-facing check, same division of labour as RLS versus
-- the friendly permission errors in 1320.
--
-- NOT ENFORCED HERE, deliberately: nothing requires a resolution_note. A
-- guarantee that simply expired on its own terms has no story to tell, and
-- forcing prose would only produce a register full of the word "expired".
--
-- Live state before applying, checked not assumed: one single row exists in
-- contingent_liabilities company-wide (Sharma Textiles' HDFC bank guarantee,
-- inserted during 0105's own verification), status 'open' with a null
-- resolved_date. It satisfies the constraint — nothing to backfill, and no
-- existing disclosure is rewritten by this migration.
--
-- Folded back into 0105 as well, under the same constraint name, so a fresh
-- db:reset builds the table already carrying the guard; this migration drops
-- it if present before adding, so applying both in order stays idempotent.
-- ============================================================================

alter table public.contingent_liabilities
  drop constraint if exists contingent_liabilities_resolved_date_matches_status_check;

alter table public.contingent_liabilities
  add constraint contingent_liabilities_resolved_date_matches_status_check
  check ((status = 'closed') = (resolved_date is not null));

comment on constraint contingent_liabilities_resolved_date_matches_status_check
  on public.contingent_liabilities is
  'status and resolved_date must agree. get_contingent_liabilities_note filters on resolved_date alone (an as-at note cannot use a status flag), so status=''closed'' with a null resolved_date would keep the item in the note forever while the screen calls it closed; a resolved_date on an ''open'' row is the same contradiction the other way round. See 1540.';
