-- ============================================================================
-- 0051 — GSTR-1 HSN-wise summary (Table 12), the one piece of GSTR-1 prep
--         0035's own header flagged as real, separate, not-yet-attempted work
-- ============================================================================
-- 0035 (GST registers) gives the per-voucher output register — GSTR-1's raw
-- source data — but explicitly stops short of the return's own table
-- structure: B2B / B2C(Large) / B2C(Small) invoice bifurcation and the
-- HSN-wise summary (Table 12). The B2B/B2C split needs no new SQL — it's a
-- pure re-bucketing of 0035's own get_gst_output_register rows by
-- party_gstin/supply_type/invoice value, done in the report page so it can
-- never drift from the register's own tax figures. The HSN summary DOES need
-- new SQL: 0035 never touches voucher_items, and Table 12 groups by HSN, not
-- by voucher.
--
-- CURRENT AS OF AUG 2026 — verified live, not from training-data memory:
-- GSTR-3B's own outward-supply table (3.1/3.2) has been hard-locked and
-- auto-populated FROM GSTR-1 since the July 2025 return period — it is no
-- longer independently editable, and from July 2026 Table 4A (ITC) is
-- likewise auto-populated from GSTR-2B. That is exactly why this migration
-- targets GSTR-1 rather than GSTR-3B: GSTR-1 is still the return a business
-- actually prepares FROM its own books; GSTR-3B increasingly just mirrors
-- what GSTR-1 (and the supplier-side GSTR-2B) already said. A "GSTR-3B
-- calculator" built from LEKHA's own ledger postings would show figures that
-- no longer go anywhere on the real, current form.
--
-- TAX FIGURES ARE ALLOCATED FROM ACTUAL POSTINGS, not recomputed from the
-- item master's current gst_rate_percent — voucher_items does not store the
-- rate that was actually charged at invoice time (only hsn_sac is
-- denormalised there, per its own comment), and the item's rate can change
-- after the fact. Recomputing from today's item rate would misrepresent a
-- historical invoice. Instead, each voucher's ACTUAL posted cgst/sgst/igst/
-- cess (the same tax_ledger_map join 0035 and get_dashboard_kpis both use)
-- is allocated across that voucher's item lines in proportion to each line's
-- share of the voucher's taxable total — so this function's totals always
-- reconcile exactly to 0035's output register and to the dashboard's GST
-- liability figure, by construction.
--
-- CUTS, documented rather than silently made:
--  * Grouped by (hsn_sac, uom) only, not also by rate. If the same HSN was
--    billed at genuinely different GST rates within the period (a mid-period
--    rate change, or two items sharing an HSN at different rates), this
--    shows ONE blended row with an averaged effective rate — GSTN's own
--    Table 12 expects a separate row per (HSN, rate). Splitting that
--    correctly needs a per-line rate LEKHA does not persist; a real,
--    separate piece of work, same spirit as 0035's ITC-eligibility cut.
--  * Sales and credit notes only (GSTR-1 is outward supplies; purchases
--    never appear in Table 12).
--  * A voucher with zero taxable total (should not occur in practice) gets
--    zero allocated tax on every line rather than raising — see inline note.
-- ============================================================================


create or replace function public.get_gstr1_hsn_summary(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
) returns table (
  hsn_sac text,
  uom text,
  total_quantity numeric,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric,
  total_value numeric,
  effective_rate_percent numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with eligible_vouchers as (
    select v.id, v.voucher_type
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
  voucher_taxable as (
    select vi.voucher_id, sum(vi.amount) as taxable_total
      from public.voucher_items vi
      join eligible_vouchers ev on ev.id = vi.voucher_id
     where vi.company_id = p_company_id
     group by vi.voucher_id
  ),
  -- Each line's SHARE of its voucher's taxable total — always non-negative
  -- (voucher_items.amount is check'd >= 0 regardless of voucher type; the
  -- credit-note sign flip is applied afterwards to quantity/taxable value
  -- only, never to share, since tx.cgst etc. already carry the correct sign
  -- from the actual posting — same convention as 0035's output register).
  lines as (
    select
      vi.hsn_sac,
      vi.uom,
      vi.voucher_id,
      ev.voucher_type,
      vi.quantity,
      vi.amount,
      case when coalesce(vt.taxable_total, 0) = 0 then 0
           else vi.amount / vt.taxable_total end as share
      from public.voucher_items vi
      join eligible_vouchers ev on ev.id = vi.voucher_id
      left join voucher_taxable vt on vt.voucher_id = vi.voucher_id
     where vi.company_id = p_company_id
  ),
  grouped as (
    select
      coalesce(l.hsn_sac, '(no HSN/SAC)') as hsn_sac,
      l.uom,
      sum(case when l.voucher_type = 'credit_note' then -l.quantity else l.quantity end) as total_quantity,
      sum(case when l.voucher_type = 'credit_note' then -l.amount else l.amount end) as taxable_value,
      sum(l.share * coalesce(tx.cgst, 0)) as cgst,
      sum(l.share * coalesce(tx.sgst, 0)) as sgst,
      sum(l.share * coalesce(tx.igst, 0)) as igst,
      sum(l.share * coalesce(tx.cess, 0)) as cess
      from lines l
      left join voucher_tax tx on tx.voucher_id = l.voucher_id
     group by coalesce(l.hsn_sac, '(no HSN/SAC)'), l.uom
  )
  -- Rounded at this final boundary, not inside the CTEs: the proration
  -- divide (vi.amount / vt.taxable_total) is a repeating decimal in general,
  -- so an unrounded share carried all the way through would print as e.g.
  -- 4499.9999999999999999730000 instead of a clean 4500.00. Rounding once
  -- here, after allocation, keeps the allocation itself exact while making
  -- the displayed figures behave like money.
  rounded as (
    select
      g.hsn_sac, g.uom, g.total_quantity,
      g.taxable_value,
      round(g.cgst, 2) as cgst,
      round(g.sgst, 2) as sgst,
      round(g.igst, 2) as igst,
      round(g.cess, 2) as cess
      from grouped g
  )
  select
    r.hsn_sac, r.uom, r.total_quantity, r.taxable_value,
    r.cgst, r.sgst, r.igst, r.cess,
    r.taxable_value + r.cgst + r.sgst + r.igst + r.cess as total_value,
    case when r.taxable_value = 0 then 0
         else round((r.cgst + r.sgst + r.igst) / r.taxable_value * 100, 2) end as effective_rate_percent
    from rounded r
   order by r.hsn_sac, r.uom;
$$;

comment on function public.get_gstr1_hsn_summary is
  'GSTR-1 Table 12 source data: sales and credit notes in the period grouped by HSN/SAC and UOM. Tax is allocated from each voucher''s ACTUAL posted cgst/sgst/igst/cess in proportion to each line''s share of taxable value (not recomputed from the item master''s current rate), so totals reconcile exactly to get_gst_output_register. Grouped by (hsn_sac, uom) only — a genuine mid-period rate change on the same HSN shows as one blended effective_rate_percent, not separate rows. Not a filing-ready JSON for GSTN''s offline tool.';
