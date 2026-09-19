-- ============================================================================
-- 2201 — close a public/anon grant gap on the two new deferred-tax rate helpers
-- ============================================================================
-- Migration 2000 added app_private.company_regime_base_rate and
-- app_private.company_regime_surcharge_rate but never explicitly revoked the
-- default PUBLIC-EXECUTE grant Postgres attaches to a new function — every
-- other function this session has shipped does `revoke all ... from public,
-- anon` and this pair was the one place that line got dropped. Adversarial
-- verification caught it directly against pg_proc.proacl, and correctly
-- noted the practical risk is low (anon/PUBLIC hold no USAGE on schema
-- app_private at all, which already blocks any real call regardless, and
-- every other pre-existing app_private helper sampled carries the identical
-- unrevoked pattern) -- but this codebase has spent many migrations making
-- "revoke all ... from public, anon" on every new function a hard rule
-- specifically because relying on schema USAGE alone has been wrong before.
-- Fixed for consistency with that rule, not because a live hole was found.
-- ============================================================================

revoke all on function app_private.company_regime_base_rate(text, text) from public, anon;
grant execute on function app_private.company_regime_base_rate(text, text) to authenticated;

revoke all on function app_private.company_regime_surcharge_rate(text, text, numeric) from public, anon;
grant execute on function app_private.company_regime_surcharge_rate(text, text, numeric) to authenticated;
