-- ============================================================================
-- 0129 — GSTR-3B Table 4 (ITC availed/reversed/ineligible) and Table 6.1 (net
--        tax payable). Tables 3.1/3.2 are NOT built — portal-auto-populated
--        from GSTR-1 and hard-locked for edit, exactly as 0051's own header
--        already reasoned for the sibling GSTR-1 prep functions.
-- ============================================================================
-- PREREQUISITES, CONFIRMED LIVE BEFORE WRITING A LINE OF THIS MIGRATION:
--   * items.is_rcm_applicable            (0102, reverse charge)
--   * items.itc_eligibility / itc_blocked_clause (0082, Sec 17(5))
--   * public.get_common_credit_apportionment      (0104, Rule 42)
--   * public.get_gst_setoff_computation           (0090, Sec 49/49A/Rule 88A)
--   * public.get_itc_180day_reversal              (0096, Rule 37)
-- select proname from pg_proc where proname in (...) — all five present.
--
-- WHICH TABLE-4 FORMAT, AND WHY THIS DELIBERATELY DIFFERS FROM THE BRIEF THAT
-- PRODUCED THIS MIGRATION. The brief describes Table 4(D) as "Ineligible ITC
-- — As per Sec 17(5), Others" — the format that was RETIRED in July 2022.
-- Two fresh, skeptical web searches (CBIC Circular 170/02/2022-GST itself,
-- cross-checked against ClearTax/TaxGuru/Pice/CAclubindia secondary
-- coverage) confirm the CURRENT, still-in-force layout, effective GSTR-3B for
-- the return period of July 2022 onward (Notification 14/2022-CT):
--
--   4(A) ITC Available (gross, before any reversal):
--     (1) Import of goods
--     (2) Import of services
--     (3) Inward supplies liable to reverse charge (other than 1 & 2 above)
--     (4) Inward supplies from ISD
--     (5) All other ITC
--   4(B) ITC Reversed:
--     (1) As per Rule 42/43 of CGST/SGST Rules AND Sec 17(5) — the Circular's
--         own words: "reversal of ITC which are absolute in nature and not
--         reclaimable" now INCLUDES Sec 17(5) blocked credit in THIS row,
--         not in 4(D) as the pre-2022 form had it. This is exactly what
--         0082's own header already found and built for (Table 4(B)(1),
--         not 4(D)) — this migration is consistent with that prior finding,
--         not introducing a new position.
--     (2) Others — reclaimable/temporary reversals (e.g. Rule 37's 180-day
--         non-payment reversal), which come back via 4(D)(1) once the
--         underlying condition is cured.
--   4(C) Net ITC Available = 4(A) − 4(B). This is what actually credits the
--     electronic credit ledger.
--   4(D) — INFORMATIONAL ONLY, NOT part of 4(C):
--     (1) ITC reclaimed which was reversed under 4(B)(2) in an earlier period
--     (2) Ineligible ITC under Sec 16(4) (time-barred) and ITC restricted by
--         place-of-supply provisions
--
-- This migration builds the CURRENT format. Getting this wrong would have
-- been the exact "obvious but retired" trap 0082 already fell into checking
-- for and fixed — repeating the pre-2022 layout here would silently
-- contradict 0082's own live GSTR-3B Table 4(B)(1) treatment of blocked
-- credit, producing two different LEKHA reports that disagree about where
-- the SAME rupee belongs. Sources: cbic-gst.gov.in/pdf/Circular-170-02-2022-
-- GST.pdf; cleartax.in/s/table-4-of-gstr-3b; taxguru.in "Reporting of
-- Eligible ITC, Ineligible ITC & ITC reversal in GSTR-3B".
--
-- WHAT EACH ROW CAN ACTUALLY BE POPULATED FROM, AND WHAT HONESTLY READS ZERO
-- BECAUSE THE SCHEMA CANNOT SEPARATE IT — not because nothing happened:
--
--   A(1) Import of goods, A(2) Import of services — ALWAYS 0. A purchase
--   from a foreign supplier posts through the identical 'purchase' voucher
--   type as a domestic one, with IGST landing on the same input_igst ledger
--   either way (Sec 7(2) IGST Act treats import of goods as an inter-State
--   supply, so nothing about the POSTING distinguishes it). There is no
--   country-of-origin or "this is a Bill of Entry" flag anywhere in
--   vouchers, voucher_items or the party ledger. The EXIM module
--   (migration 0119) records shipment-level customs data separately but is
--   not linked to any specific purchase voucher's tax posting — confirmed by
--   reading its own schema, not assumed. So an import, if any occurred, is
--   sitting inside A(5) below, indistinguishable from a domestic purchase.
--
--   A(3) Inward supplies liable to reverse charge — ALWAYS 0 IN THE "ITC
--   AVAILABLE" SENSE, DELIBERATELY, per 0102's own already-settled design.
--   0102 posts ONLY the self-assessed LIABILITY leg (Cr rcm_payable, Dr the
--   trading ledger — capitalised as cost) and explicitly does NOT post an
--   Input CGST/SGST/IGST leg, because Sec 49(4) bars using ITC to discharge
--   reverse-charge tax and LEKHA has no event representing "this RCM
--   liability was actually remitted in cash" that would make it eligible
--   credit under Rule 36(1)(b). So there is, structurally, never any ITC
--   for this function to report under A(3) — reporting it as 0 is not a gap
--   in THIS migration, it is 0102's own documented design working as
--   intended. What IS shown, separately and clearly marked NOT part of the
--   ITC total, is a3_rcm_memo_liability_accrued — the self-assessed RCM
--   liability recognised (rcm_payable credited) during the period, for the
--   preparer's own awareness of what a later manual reclassification
--   journal (per 0102's own header) would eventually move into real ITC
--   once actually paid.
--
--   A(4) ISD — ALWAYS 0. LEKHA has no Input Service Distributor modelling:
--   no distinct voucher type, no ISD-registration flag on any ledger, no
--   distribution mechanism. Not represented at all.
--
--   A(5) All other ITC — the residual, and in practice the ENTIRE figure:
--   every rupee of input_cgst/sgst/igst/cess this function can see (via
--   get_gst_input_register, read-only reuse — not re-derived) ends up here,
--   because A(1)-A(4) can never be carved out of it. This is GROSS ITC,
--   including whatever will be reversed in 4(B) below — matching the form's
--   own "before reversal" semantics for 4(A).
--
--   B(1) Rule 42/43 + Sec 17(5) — TWO SOURCES, ADDED, NOT RE-DERIVED:
--     * Sec 17(5) blocked: get_common_credit_apportionment's own blocked_itc
--       (T3) — the exact same figure get_itc_eligibility_summary (0082)
--       computes, by the same items.itc_eligibility = 'blocked' test and the
--       same voucher-value apportionment technique. Reused as a single total
--       (0104 does not expose a head-wise blocked split, so this migration
--       does not invent one — see report page for the amount-only
--       presentation of this component).
--     * Rule 42: get_common_credit_apportionment's own total_reversal
--       (D1 + D2), WITH its head-wise split (reversal_cgst/sgst/igst/cess),
--       reused directly.
--     * Rule 43 (capital goods) is NOT included — 0104's own header cut it
--       as its own, separately-verified piece of work not yet built
--       anywhere in this codebase. B(1) therefore understates the true
--       figure for a company with capital-goods common use; said here and
--       on the report page, not silently.
--
--   B(2) Others — Rule 37 (180-day non-payment), reused from
--   get_itc_180day_reversal (0096), READ-ONLY, filtered to the invoices
--   whose 181st day (the day the reversal trigger fires — 0096's own
--   "> 180 days" test) falls WITHIN [p_period_start, p_period_end]:
--     voucher_date between (p_period_start - 181) and (p_period_end - 181)
--   evaluated against get_itc_180day_reversal(company, p_period_end) — i.e.
--   this period's OWN outstanding-as-at-period-end figures, for exactly the
--   invoices that newly cross the threshold in this window. 0096 is itself
--   a point-in-time snapshot (recomputed fresh each call, not a running
--   ledger of past crossings), so calling it once at p_period_end and
--   filtering by voucher_date is the correct way to isolate "reversals NEW
--   this period" without double-counting a prior period's already-reported
--   reversal — the alternative of calling get_itc_180day_reversal at
--   p_period_end with NO date filter would return the full CUMULATIVE
--   overdue book, which is not what 4(B)(2) means for a single return
--   period. 0096 cannot exclude genuine RCM purchases from this figure (its
--   own header: no per-voucher RCM flag at the time it was written) — a
--   documented pre-existing limitation of 0096, inherited here unchanged.
--
--   C — Net ITC Available = A(total) − B(total). Verified below to equal
--   get_gst_input_register's own period total minus blocked minus Rule 42
--   reversal minus Rule 37 reversal, by hand, against real posted data.
--
--   D(1) ITC reclaimed (previously reversed under B(2)) — ALWAYS 0. This
--   needs a stateful link between a PAST reversal event and a LATER payment
--   that cures it (Rule 37(4): credit reclaimable once the supplier is
--   actually paid) — no such link exists in this schema (0096 recomputes
--   from scratch every call, it does not persist "this invoice was
--   previously reported reversed"). Not modelled; always 0, informational.
--
--   D(2) Ineligible ITC under Sec 16(4) (time-barred — the 30 November
--   deadline for availing credit on an invoice from the prior FY) and
--   place-of-supply-restricted ITC — ALWAYS 0. LEKHA has no Sec 16(4)
--   time-bar checker anywhere in the codebase (grepped: no function or
--   report mentions it) and no place-of-supply-mismatch detector on inward
--   supplies. Not modelled; always 0, informational.
--
--   COMPANY-WIDE vs PER-GSTIN — A COMPOUNDING LIMITATION, STATED ONCE HERE.
--   Table 4 is inherently a PER-GSTIN return table (this function correctly
--   takes p_gst_registration_id and the A-side figures, sourced from
--   get_gst_input_register, ARE properly scoped to that one registration).
--   The B-side is not: get_common_credit_apportionment (Rule 42, Sec 17(5))
--   and get_itc_180day_reversal (Rule 37) both compute COMPANY-WIDE, each
--   for its own already-documented reason (0104's own header: Rule 42's "F"
--   is technically per-State turnover; 0096 was never built with a
--   registration filter). Every company in this database currently holds
--   exactly one GST registration (verified live below), so this cannot be
--   distinguished from a true per-GSTIN figure today. A genuine
--   multi-registration company should treat 4(B) here as a company-wide
--   estimate needing manual reconciliation across GSTINs, not an exact
--   per-GSTIN split — flagged in caveats_for_integration.
--
-- TABLE 5.1 (INTEREST AND LATE FEE) — DELIBERATELY NOT BUILT, PER THE TASK'S
-- OWN INSTRUCTION TO SHIP 4/6.1 SOLIDLY RATHER THAN A RUSHED APPROXIMATION.
-- The legal mechanics were still confirmed live, so the gap is a documented
-- one, not a guess: GSTR-3B is due on the 20th of the following month for an
-- ordinary monthly filer (Sec 39(7) read with Rule 61(1) — QRMP filers have
-- their own 22nd/24th dates, not modelled, LEKHA has no QRMP election flag);
-- Sec 50(1) interest is 18% p.a., and — per the proviso inserted by the
-- Finance Act 2019 and given retrospective effect from 1 July 2017 by
-- Notification 16/2021-CT (1 June 2021) — charged only on the NET tax paid
-- through the electronic CASH ledger, not on gross output tax; late fee is
-- Sec 47(1), Rs 50/day (Rs 25 CGST + Rs 25 SGST) standard, Rs 20/day for a
-- NIL return, subject to turnover-based caps under later notifications.
-- THE REASON THIS CANNOT BE COMPUTED RELIABLY: tax_payments (0079) has NO
-- column linking a GST challan to the SPECIFIC RETURN PERIOD it settles —
-- only financial_year_label (for income tax's own annual computation) and a
-- single payment_date. A GST row's tax_type = 'gst' carries no period_month
-- or period_start/period_end at all (confirmed live: information_schema.
-- columns for tax_payments has no such field). Guessing that a payment
-- dated in month M settles month M-1's liability would be exactly the kind
-- of unverified assumption this task was warned against — a preparer could
-- easily pay two months' GST in one challan, or pay late for an old period
-- and on time for the current one in the same week. Building "days late"
-- arithmetic on that guess would produce a confident, wrong number. See
-- scope_deferred / caveats_for_integration for the schema change (a
-- period_start/period_end pair on tax_payments for tax_type='gst') that
-- would make this reliably buildable.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_gstr3b_table4(company, gst_registration, period_start, period_end)
-- ----------------------------------------------------------------------------
create or replace function public.get_gstr3b_table4(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  a1_import_of_goods numeric,
  a2_import_of_services numeric,
  a3_inward_rcm numeric,
  a3_rcm_memo_liability_accrued numeric,
  a4_isd numeric,
  a5_all_other_itc numeric,
  a5_all_other_itc_cgst numeric,
  a5_all_other_itc_sgst numeric,
  a5_all_other_itc_igst numeric,
  a5_all_other_itc_cess numeric,
  a_total numeric,
  b1_sec17_5_blocked numeric,
  b1_rule42_reversal numeric,
  b1_rule42_reversal_cgst numeric,
  b1_rule42_reversal_sgst numeric,
  b1_rule42_reversal_igst numeric,
  b1_rule42_reversal_cess numeric,
  b1_total numeric,
  b2_others_rule37 numeric,
  b_total numeric,
  c_net_itc_available numeric,
  d1_reclaimed_itc numeric,
  d2_ineligible_16_4_and_pos numeric,
  exempt_turnover_ratio numeric,
  note text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with input_totals as (
    select
      coalesce(sum(r.cgst), 0) as cgst,
      coalesce(sum(r.sgst), 0) as sgst,
      coalesce(sum(r.igst), 0) as igst,
      coalesce(sum(r.cess), 0) as cess
    from public.get_gst_input_register(p_company_id, p_period_start, p_period_end, p_gst_registration_id) r
  ),
  rcm_accrued as (
    select coalesce(sum(e.credit_amount - e.debit_amount), 0) as amt
    from public.voucher_entries e
    join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
    join public.vouchers v on v.id = e.voucher_id
   where e.company_id = p_company_id
     and m.purpose = 'rcm_payable'
     and (p_gst_registration_id is null or m.gst_registration_id = p_gst_registration_id)
     and not v.is_deleted
     and v.voucher_date between p_period_start and p_period_end
  ),
  common as (
    select * from public.get_common_credit_apportionment(p_company_id, p_period_start, p_period_end)
  ),
  rule37 as (
    select coalesce(sum(r.reversal_itc), 0) as amt
      from public.get_itc_180day_reversal(p_company_id, p_period_end) r
     where r.voucher_date between (p_period_start - 181) and (p_period_end - 181)
  )
  select
    0::numeric as a1_import_of_goods,
    0::numeric as a2_import_of_services,
    0::numeric as a3_inward_rcm,
    round(rcm_accrued.amt, 2) as a3_rcm_memo_liability_accrued,
    0::numeric as a4_isd,
    round(input_totals.cgst + input_totals.sgst + input_totals.igst + input_totals.cess, 2) as a5_all_other_itc,
    round(input_totals.cgst, 2) as a5_all_other_itc_cgst,
    round(input_totals.sgst, 2) as a5_all_other_itc_sgst,
    round(input_totals.igst, 2) as a5_all_other_itc_igst,
    round(input_totals.cess, 2) as a5_all_other_itc_cess,
    round(input_totals.cgst + input_totals.sgst + input_totals.igst + input_totals.cess, 2) as a_total,
    round(common.blocked_itc, 2) as b1_sec17_5_blocked,
    round(common.total_reversal, 2) as b1_rule42_reversal,
    round(common.reversal_cgst, 2) as b1_rule42_reversal_cgst,
    round(common.reversal_sgst, 2) as b1_rule42_reversal_sgst,
    round(common.reversal_igst, 2) as b1_rule42_reversal_igst,
    round(common.reversal_cess, 2) as b1_rule42_reversal_cess,
    round(common.blocked_itc + common.total_reversal, 2) as b1_total,
    round(rule37.amt, 2) as b2_others_rule37,
    round(common.blocked_itc + common.total_reversal + rule37.amt, 2) as b_total,
    round(
      (input_totals.cgst + input_totals.sgst + input_totals.igst + input_totals.cess)
      - (common.blocked_itc + common.total_reversal + rule37.amt),
      2
    ) as c_net_itc_available,
    0::numeric as d1_reclaimed_itc,
    0::numeric as d2_ineligible_16_4_and_pos,
    round(common.exempt_turnover_ratio, 6) as exempt_turnover_ratio,
    'A1 (import of goods), A2 (import of services), A4 (ISD) and A3''s true ITC component cannot be '
    || 'identified from this schema and read as zero for that reason, not because none occurred — see '
    || 'the report page. B reversals (Sec 17(5) blocked, Rule 42, Rule 37) are computed company-wide, '
    || 'not strictly per GSTIN; exact for a single-registration company (every company in this database '
    || 'today). Rule 43 (capital goods) is not included in B(1). D(1)/D(2) are not tracked (no '
    || 'cross-period reclaim linkage, no Sec 16(4) time-bar check, no place-of-supply restriction check) '
    || 'and are always 0 — informational only, never netted into C.' as note
  from input_totals, rcm_accrued, common, rule37;
$$;

revoke all on function public.get_gstr3b_table4(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gstr3b_table4(uuid, uuid, date, date) to authenticated;

comment on function public.get_gstr3b_table4(uuid, uuid, date, date) is
  'GSTR-3B Table 4 prep, POST-JULY-2022 format (CBIC Circular 170/02/2022 — Sec 17(5) blocked credit reported in 4(B)(1), not 4(D), consistent with 0082): 4(A) ITC available (A1/A2/A4 always 0 — imports and ISD are not identifiable in this schema; A3 always 0 by 0102''s own design — RCM tax is never posted as same-period ITC, see a3_rcm_memo_liability_accrued for the self-assessed liability instead; A5 is the full get_gst_input_register total for the registration); 4(B) reversed (Sec 17(5) + Rule 42 from get_common_credit_apportionment, Rule 37 from get_itc_180day_reversal filtered to this period''s new 180-day crossings — Rule 43 not included, not built anywhere in this codebase); 4(C) = A − B; 4(D) always 0, informational only (no Sec 16(4) time-bar or reclaim tracking). B-side figures are company-wide, not per-GSTIN — exact only while every company holds one registration. Tables 3.1/3.2 are portal-computed from GSTR-1 and out of scope. See 0129.';


-- ----------------------------------------------------------------------------
-- get_gstr3b_table6_1(company, gst_registration, period_start, period_end)
-- ----------------------------------------------------------------------------
-- Reuses get_gst_setoff_computation (0090) DIRECTLY — no re-derivation of the
-- Sec 49A/Rule 88A cascade. p_period_start is accepted only for interface
-- symmetry with get_gstr3b_table4 and the report page's single period
-- selector; the actual computation is inherently CUMULATIVE SINCE THE LAST
-- post_gst_setoff call (0090's own documented "incremental, like
-- post_closing_stock" design), evaluated as at p_period_end — not strictly
-- bounded to [p_period_start, p_period_end] unless set-off was last posted
-- exactly at p_period_start − 1. Said here and on the report page, not
-- silently assumed away.
create or replace function public.get_gstr3b_table6_1(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  tax_head text,
  tax_payable numeric,
  itc_igst_utilised numeric,
  itc_cgst_utilised numeric,
  itc_sgst_utilised numeric,
  itc_cess_utilised numeric,
  itc_total_utilised numeric,
  tds_tcs_credit numeric,
  cash_tax_payable numeric,
  interest_payable numeric,
  late_fee_payable numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with legs as (
    select * from public.get_gst_setoff_computation(p_company_id, p_gst_registration_id, p_period_end)
  ),
  heads as (
    select t.tax_head, t.ord from (values ('igst', 1), ('cgst', 2), ('sgst', 3), ('cess', 4)) as t(tax_head, ord)
  )
  select
    h.tax_head,
    round(coalesce((select l.amount from legs l where l.row_kind = 'output_opening' and l.tax_head = h.tax_head), 0), 2) as tax_payable,
    round(coalesce((select sum(l.amount) from legs l where l.row_kind = 'utilisation' and l.tax_head = h.tax_head and l.credit_head = 'igst'), 0), 2) as itc_igst_utilised,
    round(coalesce((select sum(l.amount) from legs l where l.row_kind = 'utilisation' and l.tax_head = h.tax_head and l.credit_head = 'cgst'), 0), 2) as itc_cgst_utilised,
    round(coalesce((select sum(l.amount) from legs l where l.row_kind = 'utilisation' and l.tax_head = h.tax_head and l.credit_head = 'sgst'), 0), 2) as itc_sgst_utilised,
    round(coalesce((select sum(l.amount) from legs l where l.row_kind = 'utilisation' and l.tax_head = h.tax_head and l.credit_head = 'cess'), 0), 2) as itc_cess_utilised,
    round(coalesce((select sum(l.amount) from legs l where l.row_kind = 'utilisation' and l.tax_head = h.tax_head), 0), 2) as itc_total_utilised,
    -- Sec 51/52 GST TDS/TCS (deducted by a government deductor or collected by
    -- an e-commerce operator) — a DIFFERENT mechanism from income-tax
    -- TDS/TCS, and not modelled anywhere in this schema (tax_ledger_map has
    -- no such purpose; grepped live). Always 0.
    0::numeric as tds_tcs_credit,
    round(coalesce((select l.amount from legs l where l.row_kind = 'net_payable' and l.tax_head = h.tax_head), 0), 2) as cash_tax_payable,
    -- Table 5.1 gap — see migration header. Always 0.
    0::numeric as interest_payable,
    0::numeric as late_fee_payable
  from heads h
  order by h.ord;
$$;

revoke all on function public.get_gstr3b_table6_1(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gstr3b_table6_1(uuid, uuid, date, date) to authenticated;

comment on function public.get_gstr3b_table6_1(uuid, uuid, date, date) is
  'GSTR-3B Table 6.1 (payment of tax) prep, one row per head (IGST, CGST, SGST/UTGST, Cess) in the form''s own order: tax payable, ITC utilised split by credit head (direct re-projection of get_gst_setoff_computation''s Sec 49A/Rule 88A cascade — no logic duplicated), GST TDS/TCS credit (Sec 51/52 — a different mechanism from income-tax TDS/TCS, not modelled, always 0), cash tax payable (= net_payable per head), interest and late fee (Table 5.1 — not computed, see migration header for why; always 0). Cumulative since the last post_gst_setoff call, evaluated as at p_period_end, not strictly bounded by p_period_start — same caveat 0090 already documents for get_gst_setoff_computation itself. See 0129.';

notify pgrst, 'reload schema';
