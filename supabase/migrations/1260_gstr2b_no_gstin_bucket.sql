-- ============================================================================
-- 1260 — GSTR-2B match: surface purchases with no GSTIN on file instead of
-- silently dropping them
-- ============================================================================
-- match_gstr2b_purchase_register's `reg` CTE has always filtered with
-- `where ir.party_gstin is not null` — necessary, since a purchase from a
-- ledger with no GSTIN can never be keyed against a 2B row. But that filter
-- ran before any bucket was assigned, so such a purchase disappeared from
-- ALL THREE buckets: not matched, not "missing from 2B," not counted
-- anywhere. It never even reached the summary tiles. The function's own
-- comment already said what should happen instead — "report this count
-- separately, do not fold it into missing_from_2b silently" — but no code
-- (SQL or the page) ever implemented it. Found live: a real, tax-bearing
-- purchase (Bharat Industries Ltd, Bansal Professional Services, ₹94,400 /
-- ₹14,400 tax, Unregistered vendor) was invisible to this report for any
-- period covering its month, with the summary reading "Nothing at risk" —
-- a real Sec 16(2)(aa) exposure with zero indication it was never even
-- considered.
--
-- Fix: a fourth bucket, 'no_gstin_on_file', built directly off
-- get_gst_input_register (not the `reg` CTE, whose gstin_key/inv_key
-- machinery only makes sense for a party that has a GSTIN), restricted to
-- the return period itself exactly like missing_from_2b already is. Same
-- shape/column contract as the other buckets so the page can filter on it
-- the same way it already filters missing_from_2b's "no reference number"
-- rows into their own footnote rather than a false gap.
-- ============================================================================

create or replace function public.match_gstr2b_purchase_register(
  p_company_id uuid,
  p_return_period text,
  p_gst_registration_id uuid default null,
  p_lookback_months integer default 2
) returns table (
  bucket text,                    -- 'matched' | 'missing_from_register' | 'missing_from_2b' | 'no_gstin_on_file'
  supplier_gstin text,
  supplier_name text,
  invoice_number text,
  invoice_date date,
  taxable_value_2b numeric,
  tax_2b numeric,
  taxable_value_register numeric,
  tax_register numeric,
  amount_difference numeric,      -- register total - 2B total, matched rows only
  itc_availability text,
  itc_reason text,
  voucher_id uuid,
  voucher_number text,
  voucher_date date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with period as (
    select
      to_date(p_return_period || '-01', 'YYYY-MM-DD') as period_start,
      (to_date(p_return_period || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date as period_end,
      (to_date(p_return_period || '-01', 'YYYY-MM-DD') - make_interval(months => greatest(coalesce(p_lookback_months, 0), 0)))::date as lookback_start
  ),
  b as (
    select
      g.supplier_gstin, g.supplier_name, g.invoice_number, g.invoice_date,
      g.taxable_value, (g.cgst + g.sgst + g.igst + g.cess) as tax, g.invoice_value,
      g.itc_availability, g.itc_reason,
      upper(trim(g.supplier_gstin)) as gstin_key,
      g.invoice_number_normalized as inv_key
    from public.gstr2b_lines g
    where g.company_id = p_company_id
      and g.return_period = p_return_period
      and (p_gst_registration_id is null or g.gst_registration_id = p_gst_registration_id)
  ),
  reg as (
    select
      ir.voucher_id, ir.voucher_number, ir.voucher_date, ir.party_name, ir.party_gstin,
      ir.taxable_value, (ir.cgst + ir.sgst + ir.igst + ir.cess) as tax, ir.invoice_value,
      v.reference_number,
      upper(trim(ir.party_gstin)) as gstin_key,
      upper(regexp_replace(coalesce(v.reference_number, ''), '[^a-zA-Z0-9]', '', 'g')) as inv_key
    from period p,
         public.get_gst_input_register(p_company_id, p.lookback_start, p.period_end, p_gst_registration_id) ir
    join public.vouchers v on v.id = ir.voucher_id
    where ir.party_gstin is not null
  ),
  matched as (
    select
      'matched'::text,
      b.supplier_gstin, coalesce(b.supplier_name, reg.party_name), b.invoice_number, b.invoice_date,
      b.taxable_value, b.tax, reg.taxable_value, reg.tax,
      (reg.invoice_value - b.invoice_value),
      b.itc_availability, b.itc_reason,
      reg.voucher_id, reg.voucher_number, reg.voucher_date
    from b
    join reg on reg.gstin_key = b.gstin_key and reg.inv_key = b.inv_key and reg.inv_key <> ''
  ),
  missing_from_register as (
    select
      'missing_from_register'::text,
      b.supplier_gstin, b.supplier_name, b.invoice_number, b.invoice_date,
      b.taxable_value, b.tax, null::numeric, null::numeric, null::numeric,
      b.itc_availability, b.itc_reason,
      null::uuid, null::text, null::date
    from b
    where not exists (
      select 1 from reg where reg.gstin_key = b.gstin_key and reg.inv_key = b.inv_key and reg.inv_key <> ''
    )
  ),
  missing_from_2b as (
    select
      'missing_from_2b'::text,
      reg.party_gstin, reg.party_name, coalesce(reg.reference_number, '(no reference number entered)'), reg.voucher_date,
      null::numeric, null::numeric, reg.taxable_value, reg.tax, null::numeric,
      null::text, null::text,
      reg.voucher_id, reg.voucher_number, reg.voucher_date
    from reg, period p
    where reg.voucher_date between p.period_start and p.period_end
      and not exists (
        select 1 from b where b.gstin_key = reg.gstin_key and b.inv_key = reg.inv_key and reg.inv_key <> ''
      )
  ),
  -- A purchase from a party with no GSTIN on file can never be keyed against
  -- a 2B row (there is nothing to match on) and is not itself a compliance
  -- risk — an unregistered supplier was never going to appear in 2B. But it
  -- must still be visible somewhere rather than vanishing without a trace.
  -- Restricted to the return period itself, matching missing_from_2b's own
  -- scope (not the wider lookback window, which exists only to find late
  -- 2B filings for parties that DO have a GSTIN).
  no_gstin as (
    select
      'no_gstin_on_file'::text,
      null::text, ir.party_name, coalesce(v.reference_number, '(no reference number entered)'), ir.voucher_date,
      null::numeric, null::numeric, ir.taxable_value, (ir.cgst + ir.sgst + ir.igst + ir.cess), null::numeric,
      null::text, null::text,
      ir.voucher_id, ir.voucher_number, ir.voucher_date
    from period p,
         public.get_gst_input_register(p_company_id, p.period_start, p.period_end, p_gst_registration_id) ir
    join public.vouchers v on v.id = ir.voucher_id
    where ir.party_gstin is null
  )
  select * from matched
  union all select * from missing_from_register
  union all select * from missing_from_2b
  union all select * from no_gstin
  order by 1, 5;
$$;

revoke all on function public.match_gstr2b_purchase_register(uuid, text, uuid, integer) from public, anon;
grant execute on function public.match_gstr2b_purchase_register(uuid, text, uuid, integer) to authenticated;

comment on function public.match_gstr2b_purchase_register(uuid, text, uuid, integer) is
  'Four-bucket GSTR-2B reconciliation for one return period: matched (found both sides, by supplier GSTIN + normalised supplier invoice number), missing_from_register (in 2B, not booked here — a missed purchase entry), missing_from_2b (booked here, not in 2B — Sec 16(2)(aa) ITC at risk), no_gstin_on_file (booked here against a party with no GSTIN on record — can never appear in a 2B, reported separately rather than folded into missing_from_2b, since it is not itself a compliance risk). Register side reads vouchers.reference_number (the supplier''s own bill number) via get_gst_input_register''s voucher_id, looking back p_lookback_months for late-filed matches, but only flags register rows dated inside the return period''s own month as missing_from_2b or no_gstin_on_file.';
