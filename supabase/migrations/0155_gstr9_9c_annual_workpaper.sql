-- ============================================================================
-- 0155 — GSTR-9 / GSTR-9C annual-return workpaper
-- ============================================================================
-- GSTR-9 is the annual return under Sec 44 CGST Act that reconciles a whole
-- financial year's outward/inward supplies, ITC and tax paid against what
-- was actually declared across that year's monthly/quarterly GSTR-1s and
-- GSTR-3Bs. GSTR-9C is the separate reconciliation STATEMENT under Sec 44(2)
-- read with Rule 80(3) that ties GSTR-9's own figures back to the taxpayer's
-- AUDITED financial statements. Both are genuinely large, multi-part returns
-- (19 tables across 6 parts for GSTR-9; 5 parts for GSTR-9C) — this migration
-- deliberately assembles only the parts this schema can support with real
-- confidence, and says so plainly, in the SQL comments below and in the
-- report page's own copy, for every part it cannot.
--
-- APPLICABILITY THRESHOLDS — CONFIRMED LIVE, BOTH A FIRST PASS AND A SECOND,
-- SKEPTICAL PASS SPECIFICALLY ON WHETHER THE OLD "recurring annual
-- notification" PATTERN STILL APPLIES (it has been burned before: a
-- threshold or an exemption that turns out to have been re-issued, not
-- permanent). Current position as of this task (Aug 2026), for FY 2024-25
-- onward:
--   * GSTR-9 (Sec 44(1) first proviso): mandatory above ₹2 crore aggregate
--     turnover for the FY; a registered person at or below ₹2 crore is
--     EXEMPT. Through FY 2023-24 this exemption was re-issued year by year
--     by a fresh notification each time (most recently Notification
--     14/2024-Central Tax, 10 Jul 2024, for FY 2023-24). From FY 2024-25 it
--     was made a STANDING exemption under Notification 15/2025-Central Tax
--     (17 Sep 2025) rather than a one-off — a real change in HOW the
--     exemption is granted, not merely a renewal, and worth stating
--     explicitly since a stale mental model of "check this year's
--     notification" no longer applies.
--   * GSTR-9C (Sec 44(2)/Rule 80(3)): mandatory above ₹5 crore aggregate
--     turnover for the FY — a separate, HIGHER threshold than GSTR-9's own,
--     not a form that everyone who files GSTR-9 must also file. Below ₹5
--     crore, GSTR-9C is not required (self-certified, no CA/CMA
--     certification needed either, since Rule 80(3)'s CA/CMA certification
--     requirement itself was removed w.e.f. FY 2020-21 by the Finance Act
--     2021 — GSTR-9C has been purely self-certified for several years now).
--   * "Aggregate turnover" for both thresholds is the Sec 2(6) PAN-wide
--     figure (every GSTIN under the same PAN, added together) — NOT a
--     single registration's own turnover. This workpaper cannot compute
--     that: it has no cross-company/cross-PAN aggregation, and (per 0104's
--     own already-documented finding) no company in this database currently
--     holds more than one GST registration to even test the gap against.
--     The report page shows a single-registration turnover figure purely as
--     an informational data point, explicitly labelled as NOT the Sec 2(6)
--     figure the threshold actually tests.
-- Sources: cleartax.in/s/gstr-9-annual-return, taxguru.in "GSTR-9/9C FY
-- 2024-25: Mandatory Changes and Reconciliations", taxtmi.com's own writeup
-- of Notification 15/2025-CT, batchwise.ai's "GSTR-9 and 9C — ₹2cr permanent
-- exemption (N/N 15/2025-CT)", cashfree.com's and cleartax.in's GSTR-9C
-- applicability guides — all read today, all independently agreeing on both
-- the ₹2cr/₹5cr split and the FY 2024-25 permanence change.
--
-- THE FINANCIAL YEAR THIS WORKPAPER USES IS ALWAYS 1 APRIL – 31 MARCH,
-- REGARDLESS OF THIS COMPANY'S OWN CONFIGURED financial_year_start_month.
-- Neither the CGST Act nor the IGST Act separately defines "financial
-- year" — GST borrows the General Clauses Act, 1897 definition (year
-- commencing 1 April), the same position ICAI's own "Note on Financial Year
-- in GSTR-9 and GSTR-9C" takes, and the same convention this codebase's own
-- get_income_tax_computation / get_tax_depreciation_blocks / income-tax
-- report page already established (see reports/income-tax/page.tsx's own
-- taxYearBounds, "deliberately ignores the company's own
-- financial_year_start_month"). This migration's functions all take
-- explicit p_fy_start/p_fy_end date parameters rather than resolving them
-- internally, so a caller who gets this wrong will see it in the dates
-- passed, not have it silently overridden — but the report page always
-- calls them with 1 Apr–31 Mar bounds, never the company's book year.
--
-- REUSE, NOT REBUILD — every rupee in this workpaper is read from a function
-- this app already ships and already hand-verified on its own:
--   get_gst_output_register / get_gst_input_register      (0035)
--   get_gstr1_table6a / 6b / 6c   (exports / SEZ / deemed exports)  (0134)
--   get_gstr1_table8              (nil-rated / exempt / non-GST)    (0081)
--   get_gstr1_table9b              (CDNR — registered-party credit notes) (0094)
--   get_gstr1_hsn_summary          (HSN, real per-rate rows)         (0098)
--   get_gstr3b_table4              (ITC availed/reversed, 3B's own A-D shape) (0129)
--   get_gstr3b_table6_1            (net tax payable, cash vs ITC)    (0129)
--   match_gstr2b_purchase_register (2B vs register, 3-bucket)        (0120)
--   get_profit_and_loss            (books revenue, for 9C Table 5)   (0009)
-- Three new functions below do nothing but re-bucket and sum what those
-- already say, into GSTR-9/9C's own table numbering — no tax is recomputed
-- from rates anywhere in this migration, only re-aggregated from postings
-- already read back by the functions above.
--
-- WHAT THIS WORKPAPER DELIBERATELY DOES NOT ATTEMPT, STATED HERE RATHER THAN
-- DISCOVERED BY READING TO THE END OF THE REPORT PAGE:
--   * GSTR-9 Table 4F (advances on which tax was paid, invoice not yet
--     issued) — LEKHA has no advance-receipt voucher type that tracks tax
--     paid ahead of an invoice.
--   * GSTR-9 Table 4J (debit notes raising output tax on a B2B/SEZ/deemed-
--     export supply) — this app's debit_note voucher type is structurally a
--     PURCHASE-side document (input tax reduction, see 0094's own comment
--     on get_gstr1_table9b), never an output-side price-increase note.
--   * GSTR-9 Tables 10-14 (prior-FY transactions declared in the CURRENT
--     FY's returns, up to the following 30 November) — this needs a "which
--     RETURN PERIOD this voucher was actually reported in" fact LEKHA does
--     not persist (every report in this app derives a period from
--     voucher_date alone; there is no separate "filed in" period). The
--     report page instead surfaces filing_register (0095) rows for GSTR-1/
--     GSTR-3B covering Apr-Nov of the year following the FY, as a manual
--     cross-reference list — not computed table data.
--   * GSTR-9 Table 6's Input/Input Service/Capital Goods split, and Rule 43
--     (capital goods, Table 7D) — items has no capital-goods flag distinct
--     from an ordinary input, and 0104's own header already cut Rule 43 as
--     unverified; both inherited here, not re-attempted.
--   * GSTR-9 Table 6C/6D (ITC on RCM inward, registered/unregistered split)
--     — always 0, not a gap in THIS migration: 0102's own design never
--     posts an ITC leg for RCM at all (Sec 49(4) bars using ITC to pay RCM,
--     and LEKHA has no "this RCM liability was actually remitted in cash"
--     event that would make it eligible credit under Rule 36(1)(b)). What
--     IS shown is the accrued RCM LIABILITY itself (get_gstr3b_table4's
--     a3_rcm_memo_liability_accrued), under Table 4G, clearly marked as
--     liability, not credit.
--   * GSTR-9 Tables 15 (demands/refunds), 16 (composition/approval/deemed
--     supply), 18 (HSN of INWARD supplies), 19 (late fee for GSTR-9 itself)
--     — no function in this app tracks an actual filed refund application
--     or its sanction (get_gst_refund_rule89_4/5, 0123, compute ELIGIBILITY
--     under the Rule 89(4)/(5) formula, not a record of what was actually
--     claimed/received), no demand-order tracking exists distinct from the
--     general notices module, and Table 19 only has a figure once GSTR-9
--     itself has been filed late — not something to compute ahead of
--     filing. All left out rather than guessed.
--   * GSTR-9C Part V (additional liability on account of non-reconciliation)
--     — flows only from Part II/IV figures a human preparer has reviewed
--     and adjusted; nothing here should auto-generate a liability figure
--     unreviewed.
--
-- THE MOST IMPORTANT HONESTY POINT IN THIS MIGRATION — GSTR-9C's OWN
-- REASON FOR EXISTING IS STRUCTURALLY UNAVAILABLE FROM THIS SCHEMA ALONE.
-- GSTR-9C Table 5 compares "turnover per the AUDITED financial statements"
-- against "turnover per GSTR-9" — a comparison that is only meaningful when
-- the two numbers come from genuinely INDEPENDENT sources (the audited
-- books on one side, the as-filed GST return on the other), so a real
-- difference exposes something GST missed (unbilled revenue, a deemed
-- supply, goods sent on approval never invoiced, a discount never
-- reflected in the tax invoice) or something the return over/understated.
-- In LEKHA, BOTH sides are computed from the SAME voucher ledger — there is
-- no separately-maintained "audited P&L" distinct from get_profit_and_loss,
-- and no record of what was actually typed into the GST portal at filing
-- time if it ever diverged from what this app computed. get_gstr9c_
-- turnover_reconciliation below (and the report page's Table 9/12 copy)
-- therefore produces a SAME-SOURCE comparison that will tie out by
-- construction whenever no schema-specific quirk applies — useful as an
-- internal review aid (it still catches a real GST-side classification
-- issue, like Table 8's own non-netting of exempt-supply credit notes,
-- flagged below), but not a substitute for an actual books-vs-return
-- reconciliation, which needs a genuinely independent "books" figure this
-- schema does not keep. Said plainly in every returned row's own note
-- column and in the report page, not left for a preparer to discover only
-- when the numbers suspiciously always match.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_gstr9_table4_5 — outward supplies liable to tax (Table 4) and outward
-- supplies on which tax is not payable (Table 5), one row per sub-table
-- letter this schema can populate. taxable_value/cgst/sgst/igst/cess/
-- tax_total are null (not zero) on a row this schema genuinely cannot
-- compute, so a report page can tell "confirmed zero" from "not attempted"
-- at a glance — the same null-vs-zero discipline 0129's own Table 4 uses for
-- 6C/6D/6H/D1/D2.
-- ----------------------------------------------------------------------------
create or replace function public.get_gstr9_table4_5(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  table_ref text,
  row_code text,
  description text,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric,
  tax_total numeric,
  note text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with sales as (
    select * from public.get_gst_output_register(p_company_id, p_fy_start, p_fy_end, p_gst_registration_id)
     where voucher_type = 'sales'
  ),
  t6a as (select * from public.get_gstr1_table6a(p_company_id, p_fy_start, p_fy_end, p_gst_registration_id)),
  t6b as (select * from public.get_gstr1_table6b(p_company_id, p_fy_start, p_fy_end, p_gst_registration_id)),
  t6c as (select * from public.get_gstr1_table6c(p_company_id, p_fy_start, p_fy_end, p_gst_registration_id)),
  t8  as (select * from public.get_gstr1_table8(p_company_id, p_fy_start, p_fy_end)),
  t9b as (select * from public.get_gstr1_table9b(p_company_id, p_fy_start, p_fy_end, p_gst_registration_id)),
  rcm as (select * from public.get_gstr3b_table4(p_company_id, p_gst_registration_id, p_fy_start, p_fy_end)),
  b2c as (
    select coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst), 0) c, coalesce(sum(sgst), 0) s,
           coalesce(sum(igst), 0) i, coalesce(sum(cess), 0) ce
      from sales where party_gstin is null and supply_type in ('intra', 'inter')
  ),
  b2b as (
    select coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst), 0) c, coalesce(sum(sgst), 0) s,
           coalesce(sum(igst), 0) i, coalesce(sum(cess), 0) ce
      from sales where party_gstin is not null and supply_type in ('intra', 'inter')
  ),
  exp_wpay as (
    select coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst), 0) c, coalesce(sum(sgst), 0) s,
           coalesce(sum(igst), 0) i, coalesce(sum(cess), 0) ce
      from t6a where tax_payment = 'WPAY'
  ),
  exp_wopay as (
    select coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst), 0) c, coalesce(sum(sgst), 0) s,
           coalesce(sum(igst), 0) i, coalesce(sum(cess), 0) ce
      from t6a where tax_payment = 'WOPAY'
  ),
  sez_wpay as (
    select coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst), 0) c, coalesce(sum(sgst), 0) s,
           coalesce(sum(igst), 0) i, coalesce(sum(cess), 0) ce
      from t6b where tax_payment = 'WPAY'
  ),
  sez_wopay as (
    select coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst), 0) c, coalesce(sum(sgst), 0) s,
           coalesce(sum(igst), 0) i, coalesce(sum(cess), 0) ce
      from t6b where tax_payment = 'WOPAY'
  ),
  deemed as (
    select coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst), 0) c, coalesce(sum(sgst), 0) s,
           coalesce(sum(igst), 0) i, coalesce(sum(cess), 0) ce
      from t6c
  ),
  cn as (
    select coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst), 0) c, coalesce(sum(sgst), 0) s,
           coalesce(sum(igst), 0) i, coalesce(sum(cess), 0) ce
      from t9b
  ),
  exempt_totals as (
    select coalesce(sum(nil_rated), 0) nr, coalesce(sum(exempted), 0) ex, coalesce(sum(non_gst), 0) ng
      from t8
  )
  select '4', '4A', 'Supplies made to unregistered persons (B2C)',
         b2c.tv, b2c.c, b2c.s, b2c.i, b2c.ce, b2c.c + b2c.s + b2c.i + b2c.ce, null::text
    from b2c
  union all
  select '4', '4B', 'Supplies made to registered persons (B2B)',
         b2b.tv, b2b.c, b2b.s, b2b.i, b2b.ce, b2b.c + b2b.s + b2b.i + b2b.ce, null
    from b2b
  union all
  select '4', '4C', 'Zero rated supply (Export) on payment of tax',
         exp_wpay.tv, exp_wpay.c, exp_wpay.s, exp_wpay.i, exp_wpay.ce,
         exp_wpay.c + exp_wpay.s + exp_wpay.i + exp_wpay.ce,
         'Excludes SEZ, which has its own row (4D) — see get_gstr1_table6a (0134).'
    from exp_wpay
  union all
  select '4', '4D', 'Supply to SEZ on payment of tax',
         sez_wpay.tv, sez_wpay.c, sez_wpay.s, sez_wpay.i, sez_wpay.ce,
         sez_wpay.c + sez_wpay.s + sez_wpay.i + sez_wpay.ce,
         'With-payment/without-payment split is INFERRED from IGST actually posted (igst > 0 = with payment), not a stored flag — vouchers.supply_type has one ''sez'' value for both routes. See get_gstr1_table6b (0134)''s own header for the one theoretical edge case this misclassifies (a 0%-rated item sold to an SEZ under the with-payment route).'
    from sez_wpay
  union all
  select '4', '4E', 'Deemed Exports',
         deemed.tv, deemed.c, deemed.s, deemed.i, deemed.ce,
         deemed.c + deemed.s + deemed.i + deemed.ce, null
    from deemed
  union all
  select '4', '4F', 'Advances on which tax has been paid but invoice has not been issued',
         null, null, null, null, null, null,
         'Not representable: LEKHA has no advance-receipt voucher type that tracks tax paid ahead of an invoice being raised.'
  union all
  select '4', '4G', 'Inward supplies liable to reverse charge',
         null, null, null, null, null, rcm.a3_rcm_memo_liability_accrued,
         'This is the RCM LIABILITY accrued for the FY (get_gstr3b_table4''s a3_rcm_memo_liability_accrued), not a taxable-value/head split — 0102''s own design never posts an ITC leg for RCM, so LEKHA has no per-head figure to show here, only the total self-assessed liability.'
    from rcm
  union all
  select '4', '4I', 'Credit Notes issued in respect of supplies in 4B to 4E (-)',
         -cn.tv, -cn.c, -cn.s, -cn.i, -cn.ce, -(cn.c + cn.s + cn.i + cn.ce),
         'Registered-recipient (CDNR) credit notes only, from get_gstr1_table9b (0094) — a credit note to an UNregistered customer is already netted straight into 4A via get_gst_output_register''s own sign convention, so it is not double-subtracted here.'
    from cn
  union all
  select '4', '4J', 'Debit Notes issued in respect of supplies in 4B to 4E (+)',
         null, null, null, null, null, null,
         'Not representable: this app''s debit_note voucher type is structurally a PURCHASE-side document (input-tax reduction on a purchase return), never an output-side price-increase note — see get_gstr1_table9b''s own comment.'
  union all
  select '5', '5A', 'Zero rated supply (Export) without payment of tax',
         exp_wopay.tv, exp_wopay.c, exp_wopay.s, exp_wopay.i, exp_wopay.ce,
         exp_wopay.c + exp_wopay.s + exp_wopay.i + exp_wopay.ce, null
    from exp_wopay
  union all
  select '5', '5B', 'Supply to SEZ without payment of tax',
         sez_wopay.tv, sez_wopay.c, sez_wopay.s, sez_wopay.i, sez_wopay.ce,
         sez_wopay.c + sez_wopay.s + sez_wopay.i + sez_wopay.ce,
         'Same WPAY/WOPAY inference caveat as 4D.'
    from sez_wopay
  union all
  select '5', '5C', 'Deemed Exports (without payment of tax)',
         0, 0, 0, 0, 0, 0,
         'Always zero by law, not a gap: Rule 89(1)''s 3rd proviso forbids a deemed export under LUT/bond — full GST is always charged at the time of supply and only the tax itself is refunded afterwards (see migration 0087''s own header). Every deemed export therefore lands in 4E, never here.'
  union all
  select '5', '5D', 'Exempted',
         exempt_totals.ex, 0, 0, 0, 0, 0,
         'From get_gstr1_table8 (0081) — company-wide, NOT scoped to p_gst_registration_id (that function takes no registration filter); immaterial while this company holds a single GST registration, a real gap for a multi-registration one. That function also sums sales and credit-note item lines WITHOUT sign inversion for a credit note (its own documented behaviour) — a credit note against an exempt/nil-rated/non-GST item INCREASES this figure rather than reducing it.'
    from exempt_totals
  union all
  select '5', '5E', 'Nil Rated',
         exempt_totals.nr, 0, 0, 0, 0, 0,
         'Same source and same two caveats as 5D.'
    from exempt_totals
  union all
  select '5', '5F', 'Non-GST supply',
         exempt_totals.ng, 0, 0, 0, 0, 0,
         'Same source and same two caveats as 5D.'
    from exempt_totals;
$$;

revoke all on function public.get_gstr9_table4_5(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gstr9_table4_5(uuid, uuid, date, date) to authenticated;

comment on function public.get_gstr9_table4_5 is
  'GSTR-9 Table 4 (outward supplies liable to tax) and Table 5 (outward supplies on which tax is not payable), one row per sub-table letter, for the financial year [p_fy_start, p_fy_end] (always call with 1 Apr-31 Mar bounds — GST''s own financial year, not this company''s book year). Assembled entirely from existing GSTR-1/register functions, no tax recomputed. A null taxable_value/cgst/sgst/igst/cess/tax_total means this schema genuinely cannot populate that row (see the note column and migration 0155''s header) — distinct from a confirmed zero. See 0155.';


-- ----------------------------------------------------------------------------
-- get_gstr9_table8 — ITC as per GSTR-2B vs ITC availed per books, for the
-- financial year. match_gstr2b_purchase_register (0120) only ever compares
-- ONE calendar-month return_period at a time; this function calls it once
-- per month of the FY via LATERAL and sums the three buckets it already
-- computes, rather than re-deriving the match key (supplier GSTIN + supplier
-- invoice number) itself. p_gst_registration_id is NOT optional here — a
-- GSTR-2B upload (0120) is always per-registration, so there is no
-- meaningful company-wide 8A without picking one.
-- ----------------------------------------------------------------------------
create or replace function public.get_gstr9_table8(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  row_code text,
  description text,
  document_count integer,
  taxable_value numeric,
  tax_total numeric,
  note text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with months as (
    select to_char(generate_series(p_fy_start, p_fy_end, interval '1 month')::date, 'YYYY-MM') as ym
  ),
  matches as (
    select m.*
      from months mo,
           lateral public.match_gstr2b_purchase_register(p_company_id, mo.ym, p_gst_registration_id, 2) m
  ),
  avail_2b as (
    select count(*)::int n, coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst + sgst + igst + cess), 0) tax
      from public.gstr2b_lines
     where company_id = p_company_id
       and gst_registration_id = p_gst_registration_id
       and return_period between to_char(p_fy_start, 'YYYY-MM') and to_char(p_fy_end, 'YYYY-MM')
       and itc_availability = 'available'
  ),
  not_avail_2b as (
    select count(*)::int n, coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst + sgst + igst + cess), 0) tax
      from public.gstr2b_lines
     where company_id = p_company_id
       and gst_registration_id = p_gst_registration_id
       and return_period between to_char(p_fy_start, 'YYYY-MM') and to_char(p_fy_end, 'YYYY-MM')
       and itc_availability <> 'available'
  ),
  register_total as (
    select count(*)::int n, coalesce(sum(taxable_value), 0) tv, coalesce(sum(cgst + sgst + igst + cess), 0) tax
      from public.get_gst_input_register(p_company_id, p_fy_start, p_fy_end, p_gst_registration_id)
  ),
  matched_agg as (
    select count(*)::int n, coalesce(sum(taxable_value_register), 0) tv, coalesce(sum(tax_register), 0) tax
      from matches where bucket = 'matched'
  ),
  missing_register_agg as (
    select count(*)::int n, coalesce(sum(taxable_value_2b), 0) tv, coalesce(sum(tax_2b), 0) tax
      from matches where bucket = 'missing_from_register'
  ),
  missing_2b_agg as (
    select count(*)::int n, coalesce(sum(taxable_value_register), 0) tv, coalesce(sum(tax_register), 0) tax
      from matches where bucket = 'missing_from_2b'
  )
  select '8A', 'ITC as per GSTR-2B (available), FY total', avail_2b.n, avail_2b.tv, avail_2b.tax,
         'Sum of every uploaded GSTR-2B line for this registration (B2B+CDNR only, itc_availability = available) across the FY''s 12 return periods — only what was actually imported via /import > GSTR-2B, never fetched live from GSTN.'
    from avail_2b
  union all
  select '8A_excluded', 'ITC as per GSTR-2B, not available / reversal / rejected, FY total',
         not_avail_2b.n, not_avail_2b.tv, not_avail_2b.tax,
         'Informational only — excluded from 8A and from every other ITC figure in this workpaper, per GSTR-2B''s own Summary-tab categories (0120''s header).'
    from not_avail_2b
  union all
  select '8B', 'ITC availed per books (purchase + debit-note register), FY total',
         register_total.n, register_total.tv, register_total.tax,
         'get_gst_input_register''s own FY total — the closest analogue this schema has to Table 6(B)+6(H); it cannot separate ordinary purchases from RCM/import/ISD credit (which the real 6B-6H split apart), so compare this to Table 6''s own get_gstr3b_table4-sourced figures for that split instead.'
    from register_total
  union all
  select '8D', 'Difference: 8A minus 8B', null, null, avail_2b.tax - register_total.tax,
         'Positive = more sits in GSTR-2B as available than this app''s register claims (worth checking for unclaimed ITC, i.e. the missing_from_register row below); negative = the register claims more than GSTR-2B currently shows as available — a Sec 16(2)(aa) risk, see missing_from_2b below and the invoice-level /reports/gstr2b-match report.'
    from avail_2b, register_total
  union all
  select 'matched', 'Matched: found in both GSTR-2B and the register', matched_agg.n, matched_agg.tv, matched_agg.tax, null
    from matched_agg
  union all
  select 'missing_from_register', 'In GSTR-2B, not yet booked in the purchase register',
         missing_register_agg.n, missing_register_agg.tv, missing_register_agg.tax,
         'Eligible ITC sitting in GSTR-2B with no matching purchase voucher entered yet.'
    from missing_register_agg
  union all
  select 'missing_from_2b', 'Booked in the register, not found in GSTR-2B',
         missing_2b_agg.n, missing_2b_agg.tv, missing_2b_agg.tax,
         'Sec 16(2)(aa) ITC at risk. See /reports/gstr2b-match for the invoice-level, month-by-month detail.'
    from missing_2b_agg;
$$;

revoke all on function public.get_gstr9_table8(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gstr9_table8(uuid, uuid, date, date) to authenticated;

comment on function public.get_gstr9_table8 is
  'GSTR-9 Table 8 (ITC as per GSTR-2B vs availed vs difference) for one GST registration''s financial year. Loops match_gstr2b_purchase_register (0120) once per calendar month of the FY via LATERAL and sums its own matched/missing_from_register/missing_from_2b buckets — the matching key itself is never re-derived here. 8A reads gstr2b_lines directly (uploaded 2B only); 8B reads get_gst_input_register. p_gst_registration_id is required (not nullable) since a 2B upload is always per-registration. See 0155.';


-- ----------------------------------------------------------------------------
-- get_gstr9c_turnover_reconciliation — GSTR-9C Table 5 workpaper. See this
-- migration's header for why this is a SAME-SOURCE comparison, not a real
-- audited-books-vs-return reconciliation, and why that is stated in the
-- note column of every row it returns rather than left implicit.
-- ----------------------------------------------------------------------------
create or replace function public.get_gstr9c_turnover_reconciliation(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  books_revenue_from_operations numeric,
  books_other_income numeric,
  gst_workpaper_turnover numeric,
  difference numeric,
  note text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with books as (
    select
      coalesce(sum(amount) filter (where nature = 'direct_income'), 0) as rev_ops,
      coalesce(sum(amount) filter (where nature = 'indirect_income'), 0) as other_inc
      from public.get_profit_and_loss(p_company_id, p_fy_start, p_fy_end)
  ),
  gst_total as (
    select coalesce(sum(taxable_value), 0) as tv
      from public.get_gstr9_table4_5(p_company_id, p_gst_registration_id, p_fy_start, p_fy_end)
     where taxable_value is not null
  )
  select
    round(books.rev_ops, 2),
    round(books.other_inc, 2),
    round(gst_total.tv, 2),
    round(books.rev_ops - gst_total.tv, 2),
    'A SAME-SOURCE comparison, not an independent audit reconciliation — see migration 0155''s header for why. books_revenue_from_operations sums every ledger under this company''s direct_income account-group nature for the FY (get_profit_and_loss), tax-exclusive by construction since GST posts to separate tax ledgers, never to a trading/sales ledger — the closest schema-native proxy for "Revenue from Operations" on an audited P&L. books_other_income (indirect_income) is shown separately, not included, because whether it belongs in a Table 5 reconciliation is a preparer judgement call this function does not make for you. gst_workpaper_turnover sums every non-null taxable_value this workpaper''s own Table 4/5 (get_gstr9_table4_5) computed for the same FY, from the SAME underlying vouchers as books_revenue_from_operations — so the two tie out by construction whenever no schema-specific quirk applies (a non-zero difference here reflects a classification quirk already inside this workpaper, e.g. Table 8''s own non-netting of exempt-supply credit notes noted on 5D/5E/5F, not an independent finding the way the real GSTR-9C Table 5 is meant to surface). A genuine reconciliation still needs the actual audited financial statements and the actual as-filed GSTR-9, both external to this schema.'
    from books, gst_total;
$$;

revoke all on function public.get_gstr9c_turnover_reconciliation(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gstr9c_turnover_reconciliation(uuid, uuid, date, date) to authenticated;

comment on function public.get_gstr9c_turnover_reconciliation is
  'GSTR-9C Table 5 turnover-reconciliation workpaper: books revenue (get_profit_and_loss direct_income for the FY) vs this app''s own GSTR-9 Table 4/5 taxable-value total, for one GST registration''s financial year. A same-source comparison, not a real audited-books-vs-portal-filing reconciliation — every returned row says so in its own note column. See 0155.';

notify pgrst, 'reload schema';
