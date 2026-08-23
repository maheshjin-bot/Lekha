-- ============================================================================
-- 0086 — A lower-deduction certificate with no validity window is inert
-- ============================================================================
-- ledgers already carried ldc_number, ldc_rate, ldc_valid_from, ldc_valid_to
-- and ldc_amount_cap, with three constraints keeping them sane: number and
-- rate are set together, valid_to is not before valid_from, and the rate is a
-- percentage. What none of them says is that the DATES ARE REQUIRED.
--
-- That matters because of how the certificate is actually consumed.
-- VoucherForm applies it only when both dates are present:
--
--     if (ledger.ldc_rate != null && ledger.ldc_valid_from && ledger.ldc_valid_to)
--
-- So a ledger carrying a certificate number and a rate but no dates would show
-- a certificate on file and still have TDS deducted at the full section rate,
-- silently, with nothing anywhere reporting the discrepancy. A Sec 197
-- certificate is issued FOR a period — one without dates is not a partially
-- filled record, it is a record that cannot be acted on.
--
-- Safe to add: there are ten TDS-deductee ledgers and not one carries a
-- certificate yet, so nothing has to be migrated.
--
-- NOT ENFORCED HERE, deliberately: that the certificate rate is at or below
-- the section's normal rate. A CHECK cannot reach ref_tds_sections, and a
-- trigger for it would be heavier than the problem — a certificate that raises
-- the rate is a data-entry mistake rather than a corruption, and the screen
-- warns about it where the section rate is actually in hand. Note a NIL
-- certificate at 0% is perfectly ordinary and must stay valid.
-- ============================================================================

alter table public.ledgers
  drop constraint if exists ledgers_ldc_needs_validity;

alter table public.ledgers
  add constraint ledgers_ldc_needs_validity
  check (
    ldc_rate is null
    or (ldc_valid_from is not null and ldc_valid_to is not null)
  );

comment on column public.ledgers.ldc_rate is
  'Sec 197 lower/nil deduction rate for this deductee. Requires a validity window — VoucherForm only applies the certificate inside ldc_valid_from..ldc_valid_to, so a rate without dates would be silently inert. See 0086.';

comment on column public.ledgers.ldc_amount_cap is
  'Optional ceiling on the certificate. VoucherForm applies the lower rate only while the line amount is at or under it, and falls back to the full section rate above — it does not split one amount across two rates.';
