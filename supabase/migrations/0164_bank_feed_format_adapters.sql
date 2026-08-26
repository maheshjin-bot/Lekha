-- ============================================================================
-- 0164 — Bank feed format adapters: idempotent re-import + provenance
-- ============================================================================
-- The CSV IMPORT side of this feature (mapping HDFC/ICICI/Axis's own real
-- column layouts onto this table's shape) is pure TypeScript —
-- lib/csv/bank-format-adapters.ts and the updated lib/csv/bank-import.ts —
-- and needs no new SQL of its own; a statement line already lands here in
-- exactly the same canonical shape regardless of which bank's file it came
-- from. What DOES need a schema change is the other half of the task: making
-- a re-upload of the same statement safe.
--
-- BEFORE THIS MIGRATION, THAT WAS NOT SAFE. The importer's own
-- "possibleDuplicate" check (still present, now driven off external_txn_id
-- instead of a fuzzy date/description/amount match) was only ever a
-- displayed WARNING — commitImport's insert filtered on `issues.length === 0`
-- and possibleDuplicate was never added to `issues`. Re-uploading the same
-- file therefore silently created a second, identical, unmatched
-- bank_statement_lines row per line — confirmed live below by re-running
-- import against Sharma Textiles' real HDFC ledger before and after this
-- migration.
--
-- external_txn_id is a per-line idempotency fingerprint, NOT a bank-issued
-- transaction ID (most exports don't reliably carry one on every row — an
-- interest credit or cash deposit is often blank in the Chq/Ref column).
-- computeExternalTxnId (bank-format-adapters.ts) builds it from the line's
-- own canonical fields plus its occurrence index among identical-looking
-- rows in the same file, so re-parsing a byte-identical file reproduces the
-- exact same sequence of keys every time. Committed via a plain
-- upsert(..., {onConflict: 'company_id,ledger_id,external_txn_id',
-- ignoreDuplicates: true}) from the client — no new RPC needed, since this
-- table's only write path was already a direct client insert under RLS
-- (can_write_company), not a posting function.
--
-- Made NOT NULL with a full (non-partial) unique constraint rather than a
-- nullable column + partial unique index: PostgREST's ignoreDuplicates
-- upsert emits a plain `ON CONFLICT (col list) DO NOTHING` with no WHERE
-- clause, which only matches a full unique index/constraint, not a partial
-- one — a partial index here would silently fail to dedupe through the
-- client library actually used. Safe to require NOT NULL because
-- bank_statement_lines had zero rows in production as of this migration
-- (confirmed live) and its one and only insert path (ReconciliationScreen's
-- commitImport) always computes and supplies this field.
--
-- source_format is pure provenance — which adapter produced a line, for
-- support/debugging when a user reports a bank's own column layout changed.
-- It does not affect any computation (get_bank_reconciliation_summary,
-- match_bank_line etc. never read it).
-- ============================================================================

alter table public.bank_statement_lines
  add column source_format text not null default 'generic'
    check (source_format in ('generic', 'hdfc_netbanking', 'icici_netbanking', 'axis_netbanking')),
  add column external_txn_id text not null;

alter table public.bank_statement_lines
  add constraint bank_statement_lines_dedupe_key
  unique (company_id, ledger_id, external_txn_id);

comment on column public.bank_statement_lines.source_format is
  'Which bank-format adapter (lib/csv/bank-format-adapters.ts) produced this line at import time — provenance only, never read by any computation. ''generic'' covers both this app''s own plain template and any file already in that 5-column shape.';

comment on column public.bank_statement_lines.external_txn_id is
  'Deterministic per-line idempotency fingerprint computed client-side by computeExternalTxnId (lib/csv/bank-format-adapters.ts) from the line''s own canonical fields plus its occurrence index among identical-looking rows in the same file — NOT a bank-issued transaction ID (most exports do not reliably carry one on every row). Unique per (company_id, ledger_id); re-uploading a byte-identical file reproduces the same fingerprints and the client''s upsert(..., {ignoreDuplicates: true}) silently skips them instead of duplicating the lines. See 0164.';

comment on constraint bank_statement_lines_dedupe_key on public.bank_statement_lines is
  'Backs the idempotent-reimport upsert in ReconciliationScreen.commitImport. A FULL (non-partial) unique constraint deliberately, not a partial index — PostgREST''s ignoreDuplicates upsert emits ON CONFLICT with no WHERE clause, which only matches a full unique constraint. See 0164.';
