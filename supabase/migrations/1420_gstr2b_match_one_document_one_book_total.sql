-- ============================================================================
-- 1420 — GSTR-2B match: one supplier document must meet ONE book total
-- ============================================================================
-- WHY. A pilot preparer received supplier bill SAE/2026-27/1290 from TEST
-- Saurashtra Agro Exports and booked it across two vouchers, because the
-- freight line on the bill could not be posted on the invoice form (the
-- service item was refused). That is not an unusual thing to do — splitting
-- one supplier document across two vouchers is routine when part of the bill
-- will not go through one screen (freight, a mis-mapped item, a partial GRN,
-- a correction posted as a second voucher).
--
-- match_gstr2b_purchase_register joined the 2B side to the register side on
-- (supplier GSTIN, normalised document number) with nothing stopping the join
-- fanning out. One 2B line met TWO book vouchers, so the report produced two
-- 'matched' rows, each comparing the WHOLE 2B document against ONE HALF of
-- the book entry. Both halves were therefore flagged as amount mismatches:
--
--   voucher                  register value   2B value    Δ reported
--   HO/PUR/2026-27/00007       1,82,952       1,87,677      -4,725
--   HO/PUR/2026-27/00008             225      1,87,677    -1,87,452
--                                                        ----------
--   total false alarm                                     -1,92,177
--
-- Neither number is real. The book actually holds 1,83,177 against this one
-- document, and the only true difference is -4,500.
--
-- IS AGGREGATING THE BOOK SIDE THE RIGHT ANSWER? Worked out rather than
-- assumed. GSTR-2B is a statement of SUPPLIER DOCUMENTS: one row per invoice
-- or note the supplier filed. The purchase register is a statement of
-- VOUCHERS. There is no rule anywhere that these are 1:1, and the app itself
-- has never enforced one — vouchers.reference_number carries the supplier's
-- document number and has never been unique. So the two sides are only
-- comparable once the book side is rolled up to the same grain the 2B is
-- published at: one supplier document. Aggregating first, then comparing, is
-- what a preparer does by hand.
--
-- The 2B side is aggregated on the same key for the same reason and for
-- symmetry: if it were not, two 2B lines sharing a key would each be compared
-- against the whole book total, which is the identical bug mirrored. See the
-- B2BA caveat below.
--
-- A GENUINE MISMATCH MUST STILL BE REPORTED, and is. After this change
-- SAE/2026-27/1290 collapses to one row reading register 1,83,177 vs 2B
-- 1,87,677, Δ -4,500 — still over the page's ±₹2 threshold, still flagged.
-- That residual is real: the freight voucher's 4,500 taxable base never
-- reached get_gst_input_register (it has no voucher_items row, so the
-- register's taxable column reads zero for it while its 225 of tax is
-- captured). This migration does not paper over that; it stops the report
-- inventing 1,92,177 of noise on top of it.
--
-- DOCUMENT TYPE IS PART OF THE KEY. Aggregating on (GSTIN, number) alone
-- would have netted a purchase against a debit note that carries the same
-- reference — which the pilot data also contains: HO/PUR/2026-27/00001
-- (31 Aug, the bill) and HO/DBN/2026-27/00001 (22 Sep, the return) both
-- carry SAE/2026-27/1188. Netting those would merge two different return
-- periods into one row and misstate both. In GSTR-2B they are genuinely
-- different documents in different sections — an invoice sits in B2B under
-- the invoice number, a supplier's credit note sits in CDNR under the NOTE
-- number — so the aggregate key, and the join, now carry a document class
-- ('invoice' for purchase vouchers, 'credit_note' for debit notes) that
-- lines up with gstr2b_lines.document_type. Purchases group with purchases,
-- returns with returns, and a book purchase can no longer match a 2B credit
-- note that happens to share a number.
--
-- ROWS WITH NO REFERENCE NUMBER ARE NEVER GROUPED TOGETHER. inv_key is ''
-- for every voucher with no supplier reference entered. Grouping on that
-- would have collapsed three unreferenced purchases from one supplier into
-- one row and quietly deflated the page's "N more purchases have no supplier
-- reference number" footnote. The group key therefore falls back to the
-- voucher id whenever inv_key is '' (and to the 2B line id on the other
-- side), so those rows stay one-per-document exactly as before.
--
-- WHICH VOUCHER A GROUPED ROW SHOWS. The return type is unchanged (a
-- deliberate constraint — get_gstr9_table8 in 0155 and the report page both
-- consume it), so a group reports its earliest voucher's id and date, and its
-- voucher_number reads e.g. "HO/PUR/2026-27/00007 +1 more" so the reader can
-- see it is a roll-up rather than believing one voucher carries the lot.
--
-- KNOWN LIMITATION, stated rather than hidden: a B2BA amendment line carries
-- the ORIGINAL invoice number, so after this change an original B2B line and
-- its B2BA amendment for the same document are summed rather than the
-- amendment replacing the original. That is wrong in principle. It is however
-- strictly better than the previous behaviour (which compared each of them
-- separately against the whole book total, producing two false alarms exactly
-- as above), and 0120's own scope note already records that gstr2b_table is
-- "kept for audit/display only, never branched on". Handling B2BA as a
-- replacement is a separate change and is not made here.
--
-- get_gstr9_table8 (0155) is unaffected in its money columns: it sums
-- taxable_value_register / tax_register over the matched bucket, and the sum
-- of the fanned-out rows equalled the sum of the grouped rows. Its document
-- COUNT for the matched bucket becomes correct (one per document instead of
-- one per voucher pairing).
-- ============================================================================

-- Guard: refuse to run against a body other than the one this was written
-- against (1260's four-bucket version), rather than silently overwriting a
-- newer one from a concurrent change.
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
    raise exception '1420: match_gstr2b_purchase_register is missing.';
  end if;
  if v_def !~ 'no_gstin_on_file' then
    raise exception '1420: expected 1260''s four-bucket body (no_gstin_on_file absent). Body has moved; fix by hand.';
  end if;
  if v_def ~ 'reg_rows' then
    raise exception '1420: this function already carries a grouped register side. Already applied, or superseded; fix by hand.';
  end if;
end;
$guard$;

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
  voucher_number text,            -- "<earliest voucher> +N more" when a document was booked across several
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
  -- ---- 2B side: raw lines, then one row per supplier document -------------
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
      -- Conservative: if ANY line of the document is not 'available', the
      -- document reports that flag, never the optimistic one.
      coalesce(
        min(r.itc_availability) filter (where r.itc_availability <> 'available'),
        min(r.itc_availability)) as itc_availability,
      coalesce(
        min(r.itc_reason) filter (where r.itc_availability <> 'available'),
        min(r.itc_reason)) as itc_reason
    from b_rows r
    group by r.gstin_key, r.inv_key, r.document_type,
             -- an unmatchable (empty) key never groups rows together
             (case when r.inv_key = '' then r.id::text else '' end)
  ),
  -- ---- register side: raw vouchers, then one row per supplier document ----
  reg_rows as (
    select
      ir.voucher_id, ir.voucher_number, ir.voucher_date, ir.party_name, ir.party_gstin,
      ir.taxable_value, (ir.cgst + ir.sgst + ir.igst + ir.cess) as tax, ir.invoice_value,
      v.reference_number,
      case when ir.voucher_type = 'debit_note' then 'credit_note' else 'invoice' end as document_type,
      upper(trim(ir.party_gstin)) as gstin_key,
      upper(regexp_replace(coalesce(v.reference_number, ''), '[^a-zA-Z0-9]', '', 'g')) as inv_key
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
      sum(r.taxable_value)    as taxable_value,
      sum(r.tax)              as tax,
      sum(r.invoice_value)    as invoice_value,
      count(*)::int           as voucher_count,
      (array_agg(r.voucher_id     order by r.voucher_date, r.voucher_number))[1] as voucher_id,
      (array_agg(r.voucher_number order by r.voucher_date, r.voucher_number))[1] as voucher_number,
      (array_agg(r.voucher_date   order by r.voucher_date, r.voucher_number))[1] as voucher_date,
      -- A rolled-up document belongs to this return period if ANY of the
      -- vouchers making it up is dated inside the period. The lookback window
      -- exists only to find late 2B filings, never to widen what is judged.
      bool_or(r.voucher_date between p.period_start and p.period_end) as in_period
    from reg_rows r, period p
    group by r.gstin_key, r.inv_key, r.document_type,
             (case when r.inv_key = '' then r.voucher_id::text else '' end)
  ),
  reg as (
    select
      a.*,
      case when a.voucher_count > 1
           then a.voucher_number || ' +' || (a.voucher_count - 1) || ' more'
           else a.voucher_number
      end as voucher_label
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
      reg.party_gstin, reg.party_name, coalesce(reg.reference_number, '(no reference number entered)'), reg.voucher_date,
      null::numeric, null::numeric, reg.taxable_value, reg.tax, null::numeric,
      null::text, null::text,
      reg.voucher_id, reg.voucher_label, reg.voucher_date
    from reg
    where reg.in_period
      and not exists (
        select 1 from b
         where b.gstin_key = reg.gstin_key
           and b.inv_key = reg.inv_key
           and b.document_type = reg.document_type
           and reg.inv_key <> ''
      )
  ),
  -- Unchanged from 1260. A party with no GSTIN has no key to group on, so
  -- these stay one row per voucher: an unregistered supplier can never appear
  -- in a 2B, and this bucket exists only so such a purchase does not vanish
  -- from the report entirely.
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
  'Four-bucket GSTR-2B reconciliation for one return period, at SUPPLIER-DOCUMENT grain on both sides: matched, missing_from_register (in 2B, not booked here), missing_from_2b (booked here, not in 2B — Sec 16(2)(aa) ITC at risk), no_gstin_on_file (party has no GSTIN, can never appear in a 2B). Both sides are rolled up to one row per (supplier GSTIN, normalised document number, document class) before being compared, so one supplier bill booked across several vouchers meets one book total instead of fanning out into one false amount-mismatch per voucher (1420). Document class is ''invoice'' for purchase vouchers / B2B lines and ''credit_note'' for debit notes / CDNR lines, so a purchase can never match a credit note sharing a number. Rows with no supplier reference number are never grouped together. A grouped row reports its earliest voucher and reads "<voucher> +N more". Register side reads vouchers.reference_number via get_gst_input_register''s voucher_id, looking back p_lookback_months for late-filed matches, and treats a rolled-up document as in-period if any of its vouchers is. Known limitation: a B2BA amendment carrying the original invoice number is summed with the original rather than replacing it — see 1420''s header.';
