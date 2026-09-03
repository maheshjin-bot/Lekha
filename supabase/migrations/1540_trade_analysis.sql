-- ============================================================================
-- 1540 — Trade analysis
-- ============================================================================
-- Quantity, gross, discount, net and tax for a company's sale-side or
-- purchase-side trade over a date range, grouped by party, item, item_group
-- (items.category — there is no dedicated item-group table in this schema),
-- branch or month.
--
-- RETURNS NETTING: a credit note IS the sales return in this schema (0007's
-- own check constraint has no separate 'sales_return' voucher_type) and a
-- debit note IS the purchase return, the same way. A return is not itself a
-- sale/purchase — it is scoped alongside its primary type and given the
-- OPPOSITE sign, so it nets off rather than being counted as more trade.
-- Reporting a credit note as if it were a sale would inflate every number
-- this function returns; that is exactly the mistake this migration exists
-- to avoid.
--
-- TAX is deliberately NOT re-derived from the GST engine's own branching
-- (intra/inter/export-LUT/export-IGST/SEZ/RCM — see 0018, 0102, 0147). Two
-- reasons:
--   1. vouchers.supply_type = 'sez' collapses BOTH the LUT and non-LUT SEZ
--      routes into one stored value (0147's own header explains why) and
--      does not persist which route was actually taken — a reader of the
--      voucher row alone cannot tell whether that line's tax was zero or a
--      full IGST charge. Only the entries actually posted know that.
--   2. Re-implementing that branching here would be a second copy of tax
--      logic that WILL drift from create_invoice/update_invoice the next
--      time either changes — the exact risk 0147's own "kept in lockstep,
--      not shared" comment on those two functions warns about.
-- Instead, the real GST charged/claimed on a voucher is read back from
-- voucher_entries via tax_ledger_map: output_cgst/sgst/igst/cess for a sale
-- side, input_cgst/sgst/igst/cess for a purchase side. RCM (rcm_payable) and
-- TCS (output_tcs) purposes are deliberately excluded — RCM is a
-- self-assessed liability the supplier never charges, and TCS is a
-- collection at source; neither is tax charged ON this trade. A credit note
-- debits the very output ledgers the original sale credited (mirrored by a
-- debit note crediting back what a purchase debited — see create_invoice),
-- so summing credit-amount for output / debit-amount for input over a
-- voucher's own entries already nets a return against the sale/purchase it
-- reverses, without this function re-deriving anything.
--
-- That gives an EXACT tax figure per VOUCHER — GST is charged once per
-- document, not once per item line. Grouping by item or item_group still
-- needs a per-line number, so each line's share of its own voucher's tax is
-- allocated pro-rata by that line's share of the voucher's own net (taxable)
-- value — the same base the real tax was actually computed against. This is
-- an allocation, not a re-derivation: it can only misattribute tax BETWEEN
-- two differently-rated items sharing one invoice; every line's share still
-- sums back to exactly that voucher's real posted tax, so it never invents
-- or drops a rupee at the party/branch/month level, where the whole
-- voucher's tax lands in one group anyway.
--
-- SCOPE, matching this migration's own brief: built over voucher_items
-- joined to vouchers. A sale/purchase voucher with only service lines
-- (invoice_service_lines, migration 1480 — not yet applied as of this
-- migration) contributes nothing here, same as get_stock_summary already
-- only reads stock-moving lines. Extending this to service lines is a
-- separate, later decision.
-- ============================================================================
create or replace function public.get_trade_analysis(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_side text,
  p_group_by text,
  p_branch_id uuid default null
) returns table (
  group_key text,
  group_label text,
  quantity numeric,
  gross numeric,
  discount numeric,
  net numeric,
  tax numeric,
  document_count integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_primary_type text;
  v_return_type text;
  v_tax_prefix text;
begin
  -- Validated against exactly these two values — no silent default on a typo
  -- that would otherwise quietly report the wrong side of the books.
  if p_side = 'sale' then
    v_primary_type := 'sales';
    v_return_type  := 'credit_note';
    v_tax_prefix   := 'output';
  elsif p_side = 'purchase' then
    v_primary_type := 'purchase';
    v_return_type  := 'debit_note';
    v_tax_prefix   := 'input';
  else
    raise exception 'p_side must be ''sale'' or ''purchase'', got %', p_side;
  end if;

  if p_group_by not in ('party', 'item', 'item_group', 'branch', 'month') then
    raise exception 'p_group_by must be one of party, item, item_group, branch, month, got %', p_group_by;
  end if;

  return query
  with scoped_vouchers as (
    select
      v.id, v.voucher_date, v.branch_id, br.name as branch_name,
      v.party_ledger_id, pl.name as party_name,
      -- +1 for the primary type, -1 for its return — safe because the WHERE
      -- clause below admits only these two voucher_type values.
      case v.voucher_type when v_primary_type then 1 else -1 end as doc_sign
    from public.vouchers v
    join public.branches br on br.id = v.branch_id
    left join public.ledgers pl on pl.id = v.party_ledger_id
    where v.company_id = p_company_id
      and not v.is_deleted
      and v.voucher_type in (v_primary_type, v_return_type)
      and v.voucher_date between p_from and p_to
      and (p_branch_id is null or v.branch_id = p_branch_id)
  ),
  -- Ground truth: the GST actually charged/claimed on each voucher, read
  -- back from what create_invoice/update_invoice actually posted (see
  -- migration header for why this is not re-derived). Already correctly
  -- netted per voucher: a credit note's own entries debit output_* (where a
  -- sale credits it), so credit_amount - debit_amount is negative for it
  -- without any extra sign-flipping here; a debit note mirrors this on the
  -- input_* side.
  voucher_tax as (
    select e.voucher_id,
      sum(case when v_tax_prefix = 'output'
                then e.credit_amount - e.debit_amount
                else e.debit_amount - e.credit_amount
          end) as tax_amount
    from public.voucher_entries e
    join public.tax_ledger_map tlm
      on tlm.ledger_id = e.ledger_id and tlm.company_id = e.company_id
    where e.company_id = p_company_id
      and e.voucher_id in (select sv.id from scoped_vouchers sv)
      and tlm.purpose in (
        v_tax_prefix || '_cgst', v_tax_prefix || '_sgst',
        v_tax_prefix || '_igst', v_tax_prefix || '_cess'
      )
    group by e.voucher_id
  ),
  -- One row per stock line, signed by doc_sign so a return already nets
  -- against its sale/purchase at the line level for quantity/gross/
  -- discount/net. raw_net stays UNSIGNED — it is only ever used below as an
  -- allocation weight among one voucher's own lines, never compared or
  -- summed across vouchers.
  voucher_lines as (
    select
      vi.voucher_id, sv.doc_sign,
      vi.item_id, i.name as item_name, i.category as item_category,
      sv.branch_id, sv.branch_name, sv.party_ledger_id, sv.party_name, sv.voucher_date,
      vi.quantity * sv.doc_sign as signed_quantity,
      coalesce(vi.amount_before_discount, vi.amount) * sv.doc_sign as signed_gross,
      coalesce(vi.discount_amount, 0) * sv.doc_sign as signed_discount,
      vi.amount * sv.doc_sign as signed_net,
      vi.amount as raw_net
    from public.voucher_items vi
    join scoped_vouchers sv on sv.id = vi.voucher_id
    join public.items i on i.id = vi.item_id
    where vi.company_id = p_company_id
  ),
  voucher_totals as (
    select voucher_id, sum(raw_net) as total_raw_net
    from voucher_lines
    group by voucher_id
  ),
  lines as (
    select vl.*,
      coalesce(vt.tax_amount, 0)
        * (vl.raw_net / nullif(vtot.total_raw_net, 0)) as signed_tax
    from voucher_lines vl
    join voucher_totals vtot on vtot.voucher_id = vl.voucher_id
    left join voucher_tax vt on vt.voucher_id = vl.voucher_id
  )
  select
    (case p_group_by
      when 'party'      then coalesce(l.party_ledger_id::text, 'none')
      when 'item'       then l.item_id::text
      when 'item_group' then coalesce(l.item_category, 'none')
      when 'branch'     then l.branch_id::text
      when 'month'      then to_char(l.voucher_date, 'YYYY-MM')
     end) as group_key,
    (case p_group_by
      when 'party'      then coalesce(l.party_name, 'Cash / No Party')
      when 'item'       then l.item_name
      when 'item_group' then coalesce(l.item_category, 'Ungrouped')
      when 'branch'     then l.branch_name
      when 'month'      then to_char(l.voucher_date, 'Mon YYYY')
     end) as group_label,
    sum(l.signed_quantity) as quantity,
    sum(l.signed_gross) as gross,
    sum(l.signed_discount) as discount,
    sum(l.signed_net) as net,
    round(sum(coalesce(l.signed_tax, 0)), 2) as tax,
    count(distinct l.voucher_id)::integer as document_count
  from lines l
  group by 1, 2
  order by 4 desc;
end;
$$;

revoke execute on function public.get_trade_analysis(uuid, date, date, text, text, uuid) from public, anon;
grant execute on function public.get_trade_analysis(uuid, date, date, text, text, uuid) to authenticated;

comment on function public.get_trade_analysis(uuid, date, date, text, text, uuid) is
  'Sale/purchase trade totals (quantity, gross, discount, net, tax) over voucher_items, grouped by party, item, item_group (items.category), branch or month, for one company and date range. Credit notes net off against sales and debit notes against purchases (same scope, opposite sign) -- a return is not itself a sale/purchase. Tax is read back from the GST actually posted via tax_ledger_map (output_*/input_* only -- RCM and TCS are excluded, neither is tax charged on the trade) and, for item/item_group grouping, allocated pro-rata across a voucher''s own lines by each line''s share of the voucher''s net value. See migration 1540 for the full reasoning.';
