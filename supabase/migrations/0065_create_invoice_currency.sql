-- ============================================================================
-- 0065 — create_invoice: accept txn_currency/exchange_rate/rate_source,
--         matching what create_voucher has already accepted since 0007
-- ============================================================================
-- vouchers.txn_currency/exchange_rate/rate_source have existed since the
-- voucher engine was written (0007), and create_voucher has always accepted
-- and stored them. create_invoice never did — every invoice, sale or
-- purchase, has been hard-defaulted to INR/1 regardless of the underlying
-- commercial transaction's real currency. This is the backend half of the
-- `foreign_currency`/`exim` module gap; the other half — a currency picker
-- on the invoice ENTRY form — cannot be built right now because
-- InvoiceForm.tsx is a concurrent session's in-flight, uncommitted rewrite
-- in this shared tree. This migration ships what is safely buildable
-- without it: the RPC itself, ready for whichever UI eventually calls it
-- with something other than the defaults.
--
-- DELIBERATELY DOES NOT CHANGE HOW ITEM AMOUNTS ARE COMPUTED OR POSTED —
-- this is the one design decision worth being explicit about. Mirrors
-- create_voucher's own established convention exactly: that function
-- accepts txn_currency/exchange_rate purely as VOUCHER-level metadata,
-- stored on the vouchers row, and trusts the CALLER to have already done
-- any currency-conversion arithmetic before constructing debit_amount/
-- credit_amount — create_voucher performs zero conversion math itself. This
-- migration does the same: p_items' rate/amount remain, exactly as before,
-- the INR figures actually posted and taxed. txn_currency/exchange_rate/
-- rate_source are recorded as what commercial currency and rate underlie
-- that INR figure — which is also the CORRECT compliance shape for a real
-- export invoice: GST tax invoice rules require the taxable value and tax
-- in INR regardless of the transaction's billing currency (an export
-- invoice commonly states both — the foreign-currency commercial value for
-- the buyer, and the INR-equivalent GST figures) — this is not a
-- simplification made for lack of a UI, it is the accounting-correct shape
-- either way. A future "enter the rate in USD, auto-convert to INR at this
-- exchange rate" UI convenience would still call this same function; it
-- would just do the multiplication before building p_items, exactly the
-- division of responsibility create_voucher already established.
--
-- SAME EXISTING PARAMETERS IN THE SAME ORDER, new ones appended at the end
-- with defaults matching the vouchers table's own column defaults ('INR',
-- 1, null) — every existing caller (the invoice entry UI, bulk invoice
-- import) continues to work completely unchanged. The explicit DROP below
-- is required even so: adding a new parameter changes the function's
-- signature, and CREATE OR REPLACE FUNCTION does not replace a function
-- whose signature differs — it silently creates a second, ambiguous
-- overload instead (the same trap 0050's own header already documented).
-- ============================================================================

drop function if exists public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, character
);

create or replace function public.create_invoice(
  p_company_id uuid,
  p_branch_id uuid,
  p_voucher_type text,
  p_voucher_date date,
  p_party_ledger_id uuid,
  p_trading_ledger_id uuid,
  p_godown_id uuid,
  p_items jsonb,
  p_narration text default null,
  p_reference_number text default null,
  p_reference_date date default null,
  p_place_of_supply character default null,
  p_txn_currency character default 'INR',
  p_exchange_rate numeric default 1,
  p_rate_source text default null
)
returns uuid
language plpgsql
set search_path = ''
as $function$
declare
  v_voucher_id uuid;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_item jsonb;
  v_qty numeric;
  v_rate numeric;
  v_gst_rate numeric;
  v_cess_rate numeric;
  v_amount numeric;
  v_taxable_total numeric := 0;
  v_direction text;
  v_party_side text;
  v_line_no int := 0;
  v_uom text;
  v_hsn text;

  v_gst_on boolean;
  v_registration_id uuid;
  v_supplier_state char(2);
  v_supply_type text;
  v_tax_prefix text;
  v_line_cgst numeric; v_line_sgst numeric; v_line_igst numeric; v_line_cess numeric;
  v_cgst_total numeric := 0; v_sgst_total numeric := 0; v_igst_total numeric := 0; v_cess_total numeric := 0;
  v_grand_total numeric;
  v_ledger uuid;
  v_entry_line int;

  v_tcs_on boolean;
  v_party_pan text;
  v_tcs_section text;
  v_tcs_rate numeric;
  v_tcs_no_pan_rate numeric;
  v_tcs_threshold numeric;
  v_line_gst_total numeric;
  v_line_tcs numeric;
  v_tcs_total numeric := 0;
begin
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'An invoice needs at least one item line';
  end if;

  case p_voucher_type
    when 'sales'       then v_direction := 'out'; v_party_side := 'debit';  v_tax_prefix := 'output';
    when 'purchase'    then v_direction := 'in';  v_party_side := 'credit'; v_tax_prefix := 'input';
    when 'credit_note' then v_direction := 'in';  v_party_side := 'credit'; v_tax_prefix := 'output';
    when 'debit_note'  then v_direction := 'out'; v_party_side := 'debit';  v_tax_prefix := 'input';
    else raise exception '% is not an invoice type', p_voucher_type;
  end case;

  v_gst_on := app_private.module_active(p_company_id, 'gst', p_voucher_date);
  v_tcs_on := v_tax_prefix = 'output' and app_private.module_active(p_company_id, 'tcs', p_voucher_date);

  if v_gst_on then
    v_registration_id := app_private.branch_registration(p_branch_id, p_voucher_date);
    if v_registration_id is null then
      raise exception 'GST is active for this company but branch % has no GST registration attached for %. Attach one before invoicing from it.',
        p_branch_id, p_voucher_date;
    end if;

    select state_code into v_supplier_state
      from public.gst_registrations where id = v_registration_id;

    if p_place_of_supply is not null then
      v_supply_type := app_private.gst_supply_type(v_supplier_state, p_place_of_supply);
    else
      select app_private.gst_supply_type(v_supplier_state, l.state_code), l.state_code
        into v_supply_type, p_place_of_supply
        from public.ledgers l where l.id = p_party_ledger_id;

      if p_place_of_supply is null then
        raise exception 'Cannot determine place of supply: % has no state on file and none was given', p_party_ledger_id;
      end if;
    end if;
  end if;

  if v_tcs_on then
    select pan into v_party_pan from public.ledgers where id = p_party_ledger_id;
  end if;

  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, p_voucher_type, p_voucher_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, reference_number,
    reference_date, party_ledger_id, place_of_supply, supply_type,
    txn_currency, exchange_rate, rate_source, created_by)
  values (
    p_company_id, p_branch_id, p_voucher_type, v_display_number, v_seq,
    v_fy, p_voucher_date, p_narration, p_reference_number,
    p_reference_date, p_party_ledger_id, p_place_of_supply, v_supply_type,
    p_txn_currency, p_exchange_rate, p_rate_source, auth.uid())
  returning id into v_voucher_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty  := (v_item->>'quantity')::numeric;
    v_rate := (v_item->>'rate')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every item line needs a quantity greater than zero';
    end if;

    v_amount := round(v_qty * coalesce(v_rate, 0), 2);
    v_taxable_total := v_taxable_total + v_amount;

    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section
      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section
      from public.items where id = (v_item->>'item_id')::uuid;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, hsn_sac, description, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, p_godown_id,
      (v_item->>'item_id')::uuid,
      v_direction, v_qty, coalesce(v_uom, 'NOS'), coalesce(v_rate, 0), v_amount,
      v_hsn, v_item->>'description', v_line_no);

    v_line_cgst := 0; v_line_sgst := 0; v_line_igst := 0; v_line_cess := 0;

    if v_gst_on then
      if v_supply_type = 'intra' then
        v_line_cgst := round(v_amount * coalesce(v_gst_rate, 0) / 2 / 100, 2);
        v_line_sgst := v_line_cgst;
        v_line_igst := 0;
      else
        v_line_cgst := 0; v_line_sgst := 0;
        v_line_igst := round(v_amount * coalesce(v_gst_rate, 0) / 100, 2);
      end if;
      v_line_cess := round(v_amount * coalesce(v_cess_rate, 0) / 100, 2);

      v_cgst_total := v_cgst_total + v_line_cgst;
      v_sgst_total := v_sgst_total + v_line_sgst;
      v_igst_total := v_igst_total + v_line_igst;
      v_cess_total := v_cess_total + v_line_cess;
    end if;

    if v_tcs_on and v_tcs_section is not null then
      select rate_percent, no_pan_rate_percent, threshold_rupees
        into v_tcs_rate, v_tcs_no_pan_rate, v_tcs_threshold
        from public.ref_tcs_sections
       where section_code = v_tcs_section and is_active;

      if v_tcs_rate is not null and (v_tcs_threshold is null or v_amount > v_tcs_threshold) then
        v_line_gst_total := case when v_gst_on
          then v_line_cgst + v_line_sgst + v_line_igst + v_line_cess
          else 0 end;

        v_line_tcs := round(
          (v_amount + v_line_gst_total) *
          coalesce(case when v_party_pan is null then v_tcs_no_pan_rate else v_tcs_rate end, 0)
          / 100, 2);
        v_tcs_total := v_tcs_total + v_line_tcs;
      end if;
    end if;

    v_line_no := v_line_no + 1;
  end loop;

  if v_taxable_total <= 0 then
    raise exception 'An invoice must come to more than zero';
  end if;

  v_grand_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total + v_tcs_total;

  insert into public.voucher_entries (
    voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values
    (v_voucher_id, p_company_id, p_branch_id, p_party_ledger_id,
     case when v_party_side = 'debit'  then v_grand_total else 0 end,
     case when v_party_side = 'credit' then v_grand_total else 0 end, 0),
    (v_voucher_id, p_company_id, p_branch_id, p_trading_ledger_id,
     case when v_party_side = 'debit'  then 0 else v_taxable_total end,
     case when v_party_side = 'credit' then 0 else v_taxable_total end, 1);

  v_entry_line := 2;

  if v_gst_on then
    for v_ledger, v_amount in
      select app_private.tax_ledger(p_company_id, v_tax_prefix || '_' || t.kind, v_registration_id), t.amt
        from (values ('cgst', v_cgst_total), ('sgst', v_sgst_total),
                     ('igst', v_igst_total), ('cess', v_cess_total)) as t(kind, amt)
       where t.amt > 0
    loop
      if v_ledger is null then
        raise exception 'No % ledger configured for this registration. Seed the GST ledgers for it first.', v_tax_prefix;
      end if;
      insert into public.voucher_entries (
        voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
      values (
        v_voucher_id, p_company_id, p_branch_id, v_ledger,
        case when v_party_side = 'debit'  then 0 else v_amount end,
        case when v_party_side = 'credit' then 0 else v_amount end,
        v_entry_line);
      v_entry_line := v_entry_line + 1;
    end loop;
  end if;

  if v_tcs_total > 0 then
    v_ledger := app_private.tax_ledger(p_company_id, 'output_tcs', null);
    if v_ledger is null then
      raise exception 'No TCS Payable ledger configured for this company. Set a TAN in Settings first — that provisions it automatically.';
    end if;
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, v_ledger,
      case when v_party_side = 'debit'  then 0 else v_tcs_total end,
      case when v_party_side = 'credit' then 0 else v_tcs_total end,
      v_entry_line);
  end if;

  return v_voucher_id;
end;
$function$;

comment on function public.create_invoice is
  'Creates a sales/purchase invoice or credit/debit note, computing GST and TCS per line. txn_currency/exchange_rate/rate_source (0065) are recorded as voucher metadata, matching create_voucher''s own established convention — they do NOT drive any conversion arithmetic here. p_items rate/amount remain the actual INR figures posted and taxed, which is also the correct compliance shape: GST tax invoice rules require the taxable value and tax in INR regardless of the transaction''s billing currency. A caller wanting to enter a rate in a foreign currency should convert to INR before building p_items, the same division of responsibility create_voucher already established for its own callers.';
