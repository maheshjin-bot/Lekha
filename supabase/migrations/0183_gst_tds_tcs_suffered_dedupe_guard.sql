-- ============================================================================
-- 0183 — gst_tds_tcs_suffered: guard against re-entering the same statement
-- line twice
-- ============================================================================
-- Nothing in 0180 stopped a preparer from recording the same deductor/
-- operator + period twice by accident (e.g. re-clicking Save, or genuinely
-- forgetting an entry was already logged for that month) — each portal "TDS
-- and TCS Credit Received" statement line is naturally 1:1 with one
-- (registration, source, deductor/operator GSTIN, period), so a second row
-- for the same four is a data-entry duplicate, not a second real credit. A
-- deductor/operator DOES occasionally issue a correction in a later period
-- (see 0180 header's "rejected records" note) — that lands as a NEW
-- period_label, which this constraint does not block.
-- ============================================================================

alter table public.gst_tds_tcs_suffered
  add constraint gst_tds_tcs_suffered_dedupe
  unique (gst_registration_id, source_type, deductor_or_operator_gstin, period_label);
