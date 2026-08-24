-- ============================================================================
-- 0141 — Closes the same column-grant gap 0112 already fixed once
-- ============================================================================
-- 0044 locked public.companies down to an explicit per-column SELECT/UPDATE
-- allowlist for `authenticated` (so password_hash can never be read or
-- overwritten via a plain .from("companies") call) — every migration that
-- adds a new company-level column since then has had to extend that
-- allowlist itself. 0085 forgot to for four columns; 0112 fixed it and
-- named the pattern explicitly. 0140 (this session, same day) repeated the
-- exact same omission for leave_accrual_days_per_month and
-- leave_carry_forward_cap_days — caught here by testing the RPC that reads
-- them (accrue_leave_for_month) as the real authenticated admin user in a
-- transaction, NOT via the sbq superuser connection, which bypasses column
-- grants entirely and would never have surfaced this (0112's own header
-- says exactly the same thing). Strictly additive: two GRANT statements,
-- no privilege beyond what every other non-sensitive company column
-- already has.
-- ============================================================================

grant select (leave_accrual_days_per_month, leave_carry_forward_cap_days)
  on public.companies to authenticated;

grant update (leave_accrual_days_per_month, leave_carry_forward_cap_days)
  on public.companies to authenticated;
