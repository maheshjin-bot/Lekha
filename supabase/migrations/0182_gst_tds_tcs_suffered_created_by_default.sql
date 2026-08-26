-- ============================================================================
-- 0182 — gst_tds_tcs_suffered.created_by: default auth.uid(), same as 0095/
-- 0117's created_by columns
-- ============================================================================
-- Caught live browser-verifying 0180: GstTdsTcsSufferedManager's client-side
-- insert (mirroring NoticeManager's own direct-insert convention) never sets
-- created_by, so every UI-recorded row landed with created_by null — no
-- error (the column is nullable), just silently missing audit attribution.
-- default auth.uid() closes it the same way 0095/0117 already do for their
-- own created_by columns, without requiring every call site to remember to
-- pass it. Existing rows (this migration's own direct-SQL test data from
-- 0180's hand-verification, inserted with an explicit created_by) are
-- untouched — only the column default changes.
-- ============================================================================

alter table public.gst_tds_tcs_suffered
  alter column created_by set default auth.uid();
