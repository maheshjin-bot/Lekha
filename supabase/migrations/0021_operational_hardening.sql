-- ============================================================================
-- 0021 — Operational hardening: voucher-numbering grants, audit partitions
-- ============================================================================
-- Two low-severity findings from the 17 Aug 2026 audit (see
-- [[lekha-audit-findings-2026-08]]): neither is a live security hole, but
-- both are worth closing outright rather than leaving as documented risk.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- F5 — voucher_number_sequences: redundant client grants
-- ----------------------------------------------------------------------------
-- Numbering is machinery, not data (see the comment at
-- 0007_voucher_engine.sql:503) — the table is RLS-enabled with zero policies,
-- so anon/authenticated can already read or write NOTHING in it regardless of
-- table-level grants. This is NOT a live hole: RLS alone already denies all
-- access. It IS defense-in-depth worth having anyway — Supabase's default
-- privileges hand every public-schema table full anon/authenticated grants
-- on creation, and that grant sitting there unused is a second thing that
-- would need to go wrong (an accidental future policy) before the first
-- (RLS being disabled) could actually leak anything. Revoking it removes the
-- redundant surface entirely.
revoke all privileges on table public.voucher_number_sequences from anon, authenticated;


-- ----------------------------------------------------------------------------
-- F6 — audit_log partitions: automate what was previously seeded by hand
-- ----------------------------------------------------------------------------
-- app_private.ensure_audit_partition() has existed since 0008 but nothing
-- ever called it on a schedule — partitions only existed as far out as
-- whoever last ran the seeding statement remembered to reach. Two parts:
--
--   1. Immediate stopgap: extend coverage a year ahead right now, so there is
--      real buffer regardless of when the cron job below first fires.
--   2. pg_cron, monthly, keeping that same buffer topped up forever.
--
-- ensure_audit_partition() is idempotent (checks to_regclass() before
-- creating), so calling it for a month that already has a partition is a
-- harmless no-op — safe to run for a whole year of months unconditionally,
-- and safe for the monthly job to re-request the same future month it asked
-- for last time.
do $$
declare
  v_month date;
begin
  for v_month in
    select date_trunc('month', current_date + (n || ' months')::interval)::date
      from generate_series(0, 11) as n
  loop
    perform app_private.ensure_audit_partition(v_month);
  end loop;
end;
$$;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- Runs at 00:00 UTC on the 1st of every month, always ensuring the partition
-- two months out exists — a two-month buffer rather than one, so a single
-- missed or delayed run still leaves next month covered.
select cron.schedule(
  'ensure-audit-partition',
  '0 0 1 * *',
  $$ select app_private.ensure_audit_partition((date_trunc('month', current_date) + interval '2 months')::date) $$
);
