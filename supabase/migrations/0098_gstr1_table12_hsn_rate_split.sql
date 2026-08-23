-- ============================================================================
-- 0098 — GSTR-1 Table 12: real per-(HSN, rate) rows, and the mandatory
--         B2B/B2C split (Phase-3 HSN reporting)
-- ============================================================================
-- get_gstr1_hsn_summary (0051) grouped only by (hsn_sac, uom) and printed an
-- "effective_rate_percent" DERIVED as round((cgst+sgst+igst)/taxable_value*100,
-- 2) — an average over everything sharing that HSN in the period. If the same
-- HSN was billed at two genuinely different GST rates (a mid-period rate
-- change, or two items sharing an HSN at different rates), that produced one
-- blended row with a rate that was never actually charged on anything. 0051's
-- own header already flagged this as a known cut, not an oversight.
--
-- THIS IS NO LONGER COSMETIC — GSTN NOW REJECTS IT. Verified live via
-- WebSearch during this task, not recalled from training data (two searches:
-- "GSTR-1 Table 12 HSN summary B2B B2C split mandatory 2025 phase 3 fields",
-- and a second, skeptical one specifically on the same-HSN-different-rate
-- behaviour, since this codebase has been burned before by trusting the
-- "obvious" answer). GSTN's Phase-3 HSN validation:
--   * introduced rate-wise variance checks on Table 12 — a mismatch beyond a
--     small tolerance blocks the GSTR-1 submission until corrected, so a
--     preparer working from LEKHA's export needs the rates already split,
--     not blended, before the mismatch is even visible;
--   * split Table 12 itself into two SEPARATE TABS — "B2B Supplies" and
--     "B2C Supplies" — reported independently, no longer one combined table.
-- The advisory (23 Jan 2025) originally named the Feb 2025 return period;
-- multiple sources agree the dropdown-only HSN selection and description
-- auto-populate landed with that timeline, but the mandatory B2B/B2C SPLIT
-- of Table 12 itself was subsequently deferred and actually took effect
-- from the May 2025 return period (the May'25 GSTR-1, filed June'25, was
-- the first return that had to carry it). Both dates are stated here rather
-- than picking one, since sources genuinely disagree on which phase-3
-- sub-change landed when — what matters for this migration is that the
-- split is unambiguously mandatory NOW, in Aug 2026, regardless of which of
-- the two 2025 dates it started on.
-- Sources: tallysolutions.com/gst/b2b-and-b2c-breakup-for-hsn-summary...,
-- irisgst.com/hsn-reporting-changes-in-gstr-1-and-gstr-1a...,
-- taxguru.in/.../gstn-implements-phase-iii-table-12-gstr-1-1a-april-2025,
-- and the rate-wise-variance/blocking behaviour cross-checked separately.
--
-- FIELD SET, confirmed live rather than assumed: HSN code, description (per
-- GSTN's own HSN master, auto-populated when the code is picked from its
-- mandatory dropdown), UQC, total quantity, total value, taxable value,
-- integrated tax, central tax, state/UT tax, cess — now reported once per
-- (HSN, rate) combination, in each of the B2B and B2C tabs separately.
--
-- THE GROUPING KEY, per the task that produced this migration: (hsn_sac,
-- gst_rate_percent, uom), with gst_rate_percent READ from items per
-- voucher_item (join on item_id) rather than derived from an averaged
-- cgst+sgst+igst/taxable_value formula. b2b_or_b2c is a new dimension:
-- 'b2b' when the party ledger's gst_registration_type sits in India's
-- GSTIN-bearing categories (regular, composition, sez, sez_developer,
-- deemed_export, uin — every one of these carries a real registration
-- number a return can cite), 'b2c' otherwise (unregistered, overseas — a
-- foreign recipient ordinarily has no Indian GSTIN — or no registration
-- type recorded at all). A defensive fallback treats a non-null gstin as
-- b2b even if gst_registration_type is somehow still null; in practice this
-- cannot happen through the app (enforce_ledger_gst_identity, 0006, sets
-- gst_registration_type to 'regular' the moment a gstin is attached if it
-- was previously null) but a bulk-loaded row could in principle disagree,
-- and the honest signal — an actual GSTIN — should win over a stale or
-- absent classification. uin holders are technically GSTR-1's Table 4C
-- (supplies to UIN holders), a different sub-table from 4A's ordinary
-- registered taxpayers — but Table 12 itself asks only for a binary B2B/B2C
-- split, and a UIN is a real registration number, so it sits under B2B here.
--
-- WHY THIS IS A REAL ARITHMETIC FIX, NOT JUST A NEW GROUP BY COLUMN. 0051
-- allocated a voucher's ACTUAL posted tax to each item line by that line's
-- plain VALUE SHARE of the voucher's taxable total (share = line amount /
-- voucher taxable total). That is only correct when every line on the
-- voucher shares the same rate — which was invisible before because every
-- line sharing an HSN was summed into one blended row regardless. The
-- moment rows are split by rate, a plain value-share allocation becomes
-- visibly wrong: a line taxed at 18% and a line taxed at 12% on the SAME
-- invoice do not owe tax in proportion to their rupee value, they owe it in
-- proportion to (value × their own rate). This migration allocates each
-- line's share of the voucher's real posted tax by that line's own IMPLIED
-- tax (taxable value × the item's own current gst_rate_percent, and
-- separately taxable value × cess_rate_percent for cess) rather than by
-- taxable value alone — so a voucher's real cgst/sgst/igst/cess still lands
-- exactly on the lines that actually generated it, and the per-voucher
-- total is unchanged (weights still sum to 1, so the whole-database
-- invariant that this function's total tax equals get_gst_output_register's
-- — enforced by tests/db/invariants.test.ts, not touched by this migration
-- — continues to hold). Falls back to a plain value share only when nothing
-- on the voucher carries a rate at all (all lines nil-rated/exempt/non-GST):
-- output tax is 0 regardless in that case, so the weight only needs to be
-- defined, not exact.
--
-- STILL READS gst_rate_percent FROM TODAY'S ITEM MASTER, same caveat 0051
-- already carried for hsn_sac: voucher_items denormalises hsn_sac at entry
-- time but never carried a rate column, and this migration does not add
-- one (a real, separate piece of schema work, out of scope here — see
-- caveats_for_integration). If an item's GST rate was changed on the master
-- AFTER a historical invoice was raised, this function's rate-grouping and
-- rate-weighting will reflect TODAY's rate for that historical line, not
-- the rate actually charged at invoice time — the dollar totals still
-- reconcile to real ledger postings (the tax figures are never fabricated
-- from the rate, only the ALLOCATION WEIGHT and the DISPLAYED rate column
-- are), but a rate-changed item's history could show under today's rate
-- bucket rather than the one that applied when it was actually sold. This
-- is the same class of gap 0051 already accepted for hsn_sac, now extended
-- once more to gst_rate_percent, for the same reason: the schema has
-- nowhere else to read a rate from.
--
-- DESCRIPTION IS NOT GSTN'S OWN HSN-MASTER TEXT. LEKHA holds no HSN-code
-- master (the portal's own dropdown supplies that at filing time). The
-- description column here is a locally-sourced label — the distinct name(s)
-- of the item(s) actually billed under that (HSN, rate) pair in the period —
-- so a preparer can tell rows apart before filing, not a substitute for
-- what GSTN will show on the portal itself.
--
-- SCOPE UNCHANGED FROM 0051 otherwise: sales and credit notes only (GSTR-1
-- Table 12 is outward supplies); a voucher with zero taxable total still
-- gets zero allocated tax rather than raising; not a filing-ready JSON for
-- GSTN's offline utility.
--
-- VERIFIED LIVE against a real mixed-rate invoice, not just eyeballed as
-- "some rows came back" — see live_verification in this session's report.
-- Sharma Textiles (a real company with existing history) got one new test
-- item (an 8471 item at 12%, alongside its existing 8471 item at 18%) and
-- two new sales vouchers: one B2B invoice carrying BOTH rates under the
-- SAME HSN on one invoice, and one B2C invoice at the pre-existing 18% rate
-- under the same HSN — disclosed plainly, not silently left as test junk.
-- ============================================================================

drop function if exists public.get_gstr1_hsn_summary(uuid, date, date, uuid);

create function public.get_gstr1_hsn_summary(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
) returns table (
  hsn_sac text,
  description text,
  gst_rate_percent numeric,
  uom text,
  b2b_or_b2c text,
  total_quantity numeric,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric,
  total_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with eligible_vouchers as (
    select v.id, v.voucher_type, v.party_ledger_id
      from public.vouchers v
     where v.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_type in ('sales', 'credit_note')
       and v.voucher_date between p_period_start and p_period_end
       and (p_gst_registration_id is null
            or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
  ),
  voucher_tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'output_cgst' then e.credit_amount - e.debit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'output_sgst' then e.credit_amount - e.debit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'output_igst' then e.credit_amount - e.debit_amount else 0 end) as igst,
           sum(case when m.purpose = 'output_cess' then e.credit_amount - e.debit_amount else 0 end) as cess
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
      join eligible_vouchers ev on ev.id = e.voucher_id
     where e.company_id = p_company_id
       and m.purpose in ('output_cgst', 'output_sgst', 'output_igst', 'output_cess')
     group by e.voucher_id
  ),
  -- Registered/unregistered per GSTN's own signal for this bifurcation: a
  -- gst_registration_type that actually carries a real registration number.
  -- See migration header for the exact category list and the gstin fallback.
  party as (
    select
      ev.id as voucher_id,
      case
        when l.gst_registration_type in
             ('regular', 'composition', 'sez', 'sez_developer', 'deemed_export', 'uin')
          then 'b2b'
        when l.gst_registration_type is null and l.gstin is not null and l.gstin <> ''
          then 'b2b'
        else 'b2c'
      end as b2b_or_b2c
      from eligible_vouchers ev
      left join public.ledgers l on l.id = ev.party_ledger_id and l.company_id = p_company_id
  ),
  -- One row per item line, carrying its OWN rate (read from items, not
  -- derived) and its OWN implied tax — the basis for the weighted
  -- allocation below. hsn_sac denormalised on voucher_items (entry-time, per
  -- 0051); gst_rate_percent is not, so it is read fresh from the item
  -- master via item_id — see header for what that does and does not mean.
  lines as (
    select
      vi.voucher_id,
      ev.voucher_type,
      coalesce(vi.hsn_sac, '(no HSN/SAC)') as hsn_sac,
      vi.uom,
      coalesce(i.gst_rate_percent, 0) as gst_rate_percent,
      i.name as item_name,
      vi.quantity,
      vi.amount,
      vi.amount * coalesce(i.gst_rate_percent, 0) / 100 as implied_gst,
      vi.amount * coalesce(i.cess_rate_percent, 0) / 100 as implied_cess
      from public.voucher_items vi
      join eligible_vouchers ev on ev.id = vi.voucher_id
      join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
     where vi.company_id = p_company_id
  ),
  voucher_weights as (
    select voucher_id,
           sum(implied_gst) as total_implied_gst,
           sum(implied_cess) as total_implied_cess,
           sum(amount) as total_amount
      from lines
     group by voucher_id
  ),
  -- Each line's share of its voucher's real posted tax, weighted by the
  -- line's OWN implied tax rather than by taxable value alone — see header
  -- ("WHY THIS IS A REAL ARITHMETIC FIX") for why the old plain-value-share
  -- method misallocates the moment one voucher mixes rates. Weights for
  -- every line on a voucher sum to 1 whenever the voucher has any implied
  -- tax at all, so the voucher's real cgst/sgst/igst/cess is always fully
  -- and exactly redistributed, never inflated or dropped.
  allocated as (
    select
      l.hsn_sac,
      l.gst_rate_percent,
      l.uom,
      l.item_name,
      p.b2b_or_b2c,
      l.voucher_type,
      l.quantity,
      l.amount,
      case when coalesce(vw.total_implied_gst, 0) = 0
             then case when coalesce(vw.total_amount, 0) = 0 then 0 else l.amount / vw.total_amount end
           else l.implied_gst / vw.total_implied_gst
      end as weight_gst,
      case when coalesce(vw.total_implied_cess, 0) = 0
             then case when coalesce(vw.total_amount, 0) = 0 then 0 else l.amount / vw.total_amount end
           else l.implied_cess / vw.total_implied_cess
      end as weight_cess,
      tx.cgst, tx.sgst, tx.igst, tx.cess
      from lines l
      join voucher_weights vw on vw.voucher_id = l.voucher_id
      join party p on p.voucher_id = l.voucher_id
      left join voucher_tax tx on tx.voucher_id = l.voucher_id
  ),
  grouped as (
    select
      a.hsn_sac,
      a.gst_rate_percent,
      a.uom,
      a.b2b_or_b2c,
      string_agg(distinct a.item_name, ', ' order by a.item_name) as description,
      sum(case when a.voucher_type = 'credit_note' then -a.quantity else a.quantity end) as total_quantity,
      sum(case when a.voucher_type = 'credit_note' then -a.amount else a.amount end) as taxable_value,
      sum(a.weight_gst * coalesce(a.cgst, 0)) as cgst,
      sum(a.weight_gst * coalesce(a.sgst, 0)) as sgst,
      sum(a.weight_gst * coalesce(a.igst, 0)) as igst,
      sum(a.weight_cess * coalesce(a.cess, 0)) as cess
      from allocated a
     group by a.hsn_sac, a.gst_rate_percent, a.uom, a.b2b_or_b2c
  ),
  -- Rounded once at this final boundary, not inside the CTEs — same reason
  -- as 0051: the allocation divisions are repeating decimals in general, so
  -- rounding only after summing keeps the allocation itself exact while
  -- making the displayed figures behave like money.
  rounded as (
    select
      g.hsn_sac, g.description, g.gst_rate_percent, g.uom, g.b2b_or_b2c,
      g.total_quantity, g.taxable_value,
      round(g.cgst, 2) as cgst,
      round(g.sgst, 2) as sgst,
      round(g.igst, 2) as igst,
      round(g.cess, 2) as cess
      from grouped g
  )
  select
    r.hsn_sac, r.description, r.gst_rate_percent, r.uom, r.b2b_or_b2c,
    r.total_quantity, r.taxable_value,
    r.cgst, r.sgst, r.igst, r.cess,
    r.taxable_value + r.cgst + r.sgst + r.igst + r.cess as total_value
    from rounded r
   order by r.b2b_or_b2c, r.hsn_sac, r.gst_rate_percent, r.uom;
$$;

revoke all on function public.get_gstr1_hsn_summary(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_gstr1_hsn_summary(uuid, date, date, uuid) to authenticated;

comment on function public.get_gstr1_hsn_summary is
  'GSTR-1 Table 12 source data, Phase-3 shape: sales and credit notes in the period grouped by (hsn_sac, gst_rate_percent, uom), split into b2b_or_b2c per GSTN''s mandatory two-tab Table 12 (registered vs unregistered party, by gst_registration_type). gst_rate_percent is read from items per voucher_item (join on item_id), not derived from a blended cgst+sgst+igst/taxable_value average — a single HSN billed at two genuinely different rates now produces two separate rows, which GSTN''s own Phase-3 validation requires. Tax is allocated from each voucher''s ACTUAL posted cgst/sgst/igst/cess, weighted by each line''s OWN implied tax (taxable value x its own rate) rather than by taxable value alone, so a voucher mixing rates still attributes real tax correctly to each rate bucket while the voucher total is unchanged. See 0098.';

notify pgrst, 'reload schema';
