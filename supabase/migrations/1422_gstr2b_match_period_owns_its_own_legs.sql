-- ============================================================================
-- 1422 — missing_from_2b must not be counted twice when periods are summed
-- ============================================================================
-- WHY. 1420 fixed a document booked across two vouchers in the SAME month
-- fanning out into two false mismatches. Verifying that fix against a
-- document booked across two DIFFERENT months found a second, previously-
-- absent problem in the same mechanism.
--
-- reg_agg groups a supplier document across the full lookback window (this
-- call's [lookback_start, period_end]) and, before this migration, reported
-- the WHOLE group's money whenever ANY of its vouchers fell in the queried
-- period — bool_or(voucher_date between period_start and period_end). For a
-- document split across two calendar months within reach of each other's
-- lookback, this means:
--
--   query August  (window Jun-Aug): sees only the August leg.   reports 500.
--   query September (window Jul-Sep): sees BOTH legs.           reports 750.
--
-- Both calls are individually defensible in isolation. The break is in any
-- caller that sums this function's output across consecutive periods — which
-- is normal usage, not a misuse. get_gstr9_table8 (0155) does exactly that,
-- looping over all twelve months of the FY and summing missing_2b_agg with no
-- dedup, so the August leg is counted once in August's call and AGAIN inside
-- September's combined total: 500 + 750 = 1,250 where the truth is 750.
-- Reproduced live on a synthetic two-voucher document (Aug tax 500, Sep tax
-- 250, no 2B line): before this fix, document_count 3->5 and tax_total
-- 16,160->17,410 when the correct combined figures are 4 and 16,910 — the
-- excess is exactly the August leg counted a second time. The same overlap
-- reaches a human directly: viewing the /reports/gstr2b-match page for August
-- then September for the same document shows 500 then 750, and a preparer
-- who adds the two "at risk" figures by hand double-counts exactly as the
-- program does.
--
-- WHAT CHANGES, and why only missing_from_2b. The two buckets that read
-- reg_agg ask different questions, and only one of them is safe to restrict.
--
--   matched            asks "does what we booked for this ONE document, in
--                       total, agree with what the supplier filed". The 2B
--                       side is a single whole-document value with no period
--                       of its own, so the comparison is only meaningful
--                       against the WHOLE register-side group. Restricting
--                       this to the current period's legs would report a
--                       false partial mismatch on a document whose other leg
--                       simply has not been queried into view yet — trading
--                       a display-aggregation problem for a live false
--                       alarm on the screen a preparer is actually looking
--                       at. Left AS 1420 DEFINED IT. See the limitation note
--                       below.
--
--   missing_from_2b    asks "how much did we book this PERIOD with no 2B
--                       backing at all". There is no whole-document 2B value
--                       to reconcile against — the quantity is inherently
--                       additive across periods, so the period each leg was
--                       actually posted in IS the right home for its money.
--                       Restricting to that period's own legs makes the
--                       across-period sum exactly right with no gap and no
--                       overlap: August reports its 500, September reports
--                       its own 250, and the two add to the true 750.
--
-- reg_agg keeps its full-window totals (taxable_value/tax/invoice_value,
-- used by matched) and gains PERIOD-RESTRICTED siblings computed with a
-- FILTER clause over the same rows (taxable_value_period etc.), used only by
-- missing_from_2b. The "not exists in b" test for missing_from_2b still
-- checks the FULL group's key, unchanged — if any leg of the document,
-- anywhere in the lookback window, was actually filed by the supplier, the
-- whole document correctly stops being flagged as missing, exactly as before.
-- A period with none of the group's own vouchers (voucher_count_period = 0)
-- emits no row at all, rather than a zero-money row.
--
-- KNOWN LIMITATION, stated rather than hidden, matching 1420's own practice:
-- the matched bucket can still report the SAME document from two overlapping
-- monthly calls, each with whatever completeness that call's own window
-- happened to have — an earlier call may show a false partial mismatch
-- before a later leg exists, and if summed blindly across periods the same
-- double-count risk 1420 fixed for missing_from_2b still applies here.
-- Solving that needs the matched row to carry a stable per-document identity
-- a caller can deduplicate on rather than sum, which the row already has
-- (voucher_id, the earliest constituent voucher) — but no live caller today
-- sums the matched bucket across periods the way get_gstr9_table8 sums
-- missing_from_2b, so this migration does not take on that redesign now.
-- ============================================================================

do $guard$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'match_gstr2b_purchase_register'
     and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1422: match_gstr2b_purchase_register is missing.';
  end if;
  if v_def !~ 'reg_agg' then
    raise exception '1422: expected 1420''s grouped-register body (reg_agg absent). Body has moved; fix by hand.';
  end if;
  if v_def ~ 'taxable_value_period' then
    raise exception '1422: this function already carries period-restricted totals. Already applied, or superseded; fix by hand.';
  end if;
end;
$guard$;

create or replace function public.match_gstr2b_purchase_register(
  p_company_id uuid,
  p_return_period text,
  p_gst_registration_id uuid default null,
  p_lookback_months integer default 2
) returns table (
  bucket text,
  supplier_gstin text,
  supplier_name text,
  invoice_number text,
  invoice_date date,
  taxable_value_2b numeric,
  tax_2b numeric,
  taxable_value_register numeric,
  tax_register numeric,
  amount_difference numeric,
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
  b_rows as (
    select
      g.id,
      g.supplier_gstin, g.supplier_name, g.invoice_number, g.invoice_date,
      g.taxable_value, (g.cgst + g.sgst + g.igst + g.cess) as tax, g.invoice_value,
      g.itc_availability, g.itc_reason, g.document_type,
      upper(trim(g.supplier_gstin)) as gstin_key,
      g.invoice_number_normalized as inv_key
    from public.gstr2b_lines g
    where g.company_id = p_company_id
      and g.return_period = p_return_period
      and (p_gst_registration_id is null or g.gst_registration_id = p_gst_registration_id)
  ),
  b as (
    select
      r.gstin_key, r.inv_key, r.document_type,
      min(r.supplier_gstin) as supplier_gstin,
      min(r.supplier_name)  as supplier_name,
      min(r.invoice_number) as invoice_number,
      min(r.invoice_date)   as invoice_date,
      sum(r.taxable_value)  as taxable_value,
      sum(r.tax)            as tax,
      sum(r.invoice_value)  as invoice_value,
      coalesce(
        min(r.itc_availability) filter (where r.itc_availability <> 'available'),
        min(r.itc_availability)) as itc_availability,
      coalesce(
        min(r.itc_reason) filter (where r.itc_availability <> 'available'),
        min(r.itc_reason)) as itc_reason
    from b_rows r
    group by r.gstin_key, r.inv_key, r.document_type,
             (case when r.inv_key = '' then r.id::text else '' end)
  ),
  reg_rows as (
    select
      ir.voucher_id, ir.voucher_number, ir.voucher_date, ir.party_name, ir.party_gstin,
      ir.taxable_value, (ir.cgst + ir.sgst + ir.igst + ir.cess) as tax, ir.invoice_value,
      v.reference_number,
      case when ir.voucher_type = 'debit_note' then 'credit_note' else 'invoice' end as document_type,
      upper(trim(ir.party_gstin)) as gstin_key,
      upper(regexp_replace(coalesce(v.reference_number, ''), '[^a-zA-Z0-9]', '', 'g')) as inv_key,
      (ir.voucher_date between p.period_start and p.period_end) as in_period_voucher
    from period p,
         public.get_gst_input_register(p_company_id, p.lookback_start, p.period_end, p_gst_registration_id) ir
    join public.vouchers v on v.id = ir.voucher_id
    where ir.party_gstin is not null
  ),
  reg_agg as (
    select
      r.gstin_key, r.inv_key, r.document_type,
      min(r.party_gstin)      as party_gstin,
      min(r.party_name)       as party_name,
      min(r.reference_number) as reference_number,
      -- Full lookback-window totals — matched's comparison against the 2B
      -- document's whole value, unchanged from 1420.
      sum(r.taxable_value)    as taxable_value,
      sum(r.tax)              as tax,
      sum(r.invoice_value)    as invoice_value,
      count(*)::int           as voucher_count,
      (array_agg(r.voucher_id     order by r.voucher_date, r.voucher_number))[1] as voucher_id,
      (array_agg(r.voucher_number order by r.voucher_date, r.voucher_number))[1] as voucher_number,
      (array_agg(r.voucher_date   order by r.voucher_date, r.voucher_number))[1] as voucher_date,
      bool_or(r.in_period_voucher) as in_period,
      -- Period-restricted totals (1422) — missing_from_2b's own share only,
      -- so summing this function's output across consecutive periods adds
      -- to the true combined figure instead of counting a shared leg twice.
      coalesce(sum(r.taxable_value) filter (where r.in_period_voucher), 0) as taxable_value_period,
      coalesce(sum(r.tax)           filter (where r.in_period_voucher), 0) as tax_period,
      coalesce(sum(r.invoice_value) filter (where r.in_period_voucher), 0) as invoice_value_period,
      count(*) filter (where r.in_period_voucher)::int as voucher_count_period,
      (array_agg(r.voucher_id     order by r.voucher_date, r.voucher_number) filter (where r.in_period_voucher))[1] as voucher_id_period,
      (array_agg(r.voucher_number order by r.voucher_date, r.voucher_number) filter (where r.in_period_voucher))[1] as voucher_number_period,
      (array_agg(r.voucher_date   order by r.voucher_date, r.voucher_number) filter (where r.in_period_voucher))[1] as voucher_date_period
    from reg_rows r
    group by r.gstin_key, r.inv_key, r.document_type,
             (case when r.inv_key = '' then r.voucher_id::text else '' end)
  ),
  reg as (
    select
      a.*,
      case when a.voucher_count > 1
           then a.voucher_number || ' +' || (a.voucher_count - 1) || ' more'
           else a.voucher_number
      end as voucher_label,
      -- Same "+N more" convention, but scoped to this period's own legs —
      -- a period showing "1 more" means it booked two vouchers of its own
      -- for this document, not that the whole cross-period group has two.
      case when a.voucher_count_period > 1
           then a.voucher_number_period || ' +' || (a.voucher_count_period - 1) || ' more'
           else a.voucher_number_period
      end as voucher_label_period
    from reg_agg a
  ),
  matched as (
    select
      'matched'::text,
      b.supplier_gstin, coalesce(b.supplier_name, reg.party_name), b.invoice_number, b.invoice_date,
      b.taxable_value, b.tax, reg.taxable_value, reg.tax,
      (reg.invoice_value - b.invoice_value),
      b.itc_availability, b.itc_reason,
      reg.voucher_id, reg.voucher_label, reg.voucher_date
    from b
    join reg on reg.gstin_key = b.gstin_key
            and reg.inv_key = b.inv_key
            and reg.document_type = b.document_type
            and reg.inv_key <> ''
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
      select 1 from reg
       where reg.gstin_key = b.gstin_key
         and reg.inv_key = b.inv_key
         and reg.document_type = b.document_type
         and reg.inv_key <> ''
    )
  ),
  missing_from_2b as (
    select
      'missing_from_2b'::text,
      reg.party_gstin, reg.party_name,
      coalesce(reg.reference_number, '(no reference number entered)'), reg.voucher_date_period,
      null::numeric, null::numeric, reg.taxable_value_period, reg.tax_period, null::numeric,
      null::text, null::text,
      reg.voucher_id_period, reg.voucher_label_period, reg.voucher_date_period
    from reg
    where reg.voucher_count_period > 0
      and not exists (
        select 1 from b
         where b.gstin_key = reg.gstin_key
           and b.inv_key = reg.inv_key
           and b.document_type = reg.document_type
           and reg.inv_key <> ''
      )
  ),
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
  'Four-bucket GSTR-2B reconciliation for one return period, at SUPPLIER-DOCUMENT grain on both sides (1420). matched compares a document''s FULL cross-period register total against the 2B document value — correct per call, but see 1422''s header for the known cross-period display limitation this bucket still carries. missing_from_2b reports only the vouchers actually dated inside THIS period (1422), so summing this function''s output across consecutive periods — as get_gstr9_table8 does over a financial year, and as a preparer does by hand — adds to the true combined figure instead of counting a shared leg twice. no_gstin_on_file is one row per voucher, unchanged.';
