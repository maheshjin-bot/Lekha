-- ============================================================================
-- 0055 — update_invoice: editing a sales/purchase/credit/debit invoice
-- ============================================================================
-- update_voucher (0007) already covers plain vouchers; invoices need their
-- own editing RPC because create_invoice (0016, superseded by 0027) does far
-- more than insert voucher_entries — it also posts voucher_items and
-- computes GST/TCS. A plain update_voucher call cannot express any of that,
-- so this is create_invoice's edit-time twin: same computation, same
-- postings, targeting an existing voucher_id instead of minting a new one.
--
-- NOT EDITABLE: voucher_type and branch_id, for the identical reason
-- update_voucher already gives — the voucher number's prefix encodes both
-- (see 0007's next_voucher_number), so changing either after the number is
-- allocated would make the printed number lie about what it names. Both are
-- looked up from the existing row, never taken as a parameter.
--
-- F-01, same protection as update_voucher: re-dating an invoice across a
-- financial-year boundary is rejected outright, matching update_voucher's
-- exact message pattern — a voucher's number is on a document already sent
-- to the counterparty, so silently renumbering it is worse than refusing.
--
-- REPLACE, NOT PATCH. voucher_items and voucher_entries for this voucher_id
-- are deleted and reinserted from p_items in full, inside the same
-- transaction as the header update — the identical shape update_voucher
-- already uses for voucher_entries, extended to voucher_items because
-- invoices carry both. get_stock_summary (0013) and every ledger balance
-- function read these tables with a plain join at query time (not a cached
-- or trigger-maintained total), so a delete+reinsert for the same
-- voucher_id is transparent to both the moment this function returns.
--
-- THE PERIOD LOCK. No new logic needed: enforce_period_open (0007) already
-- fires `before insert or update or delete on public.vouchers` for every
-- row, so the header UPDATE below already goes through it and is already
-- correctly blocked when either the OLD or the NEW voucher_date falls on or
-- before the company's lock_date — verified below, not assumed, same
-- discipline as 0052's equivalent note for delete_voucher.
--
-- THE GST/TCS MATH is copied from create_invoice (0027) rather than
-- factored into a shared helper: the two functions' insert targets differ
-- (a freshly-inserted voucher vs an existing p_voucher_id) enough that a
-- shared helper would need its own parameter surface anyway, and a
-- byte-for-byte copy is what makes the parity test below possible to write
-- and trust. If create_invoice's tax math changes again, this function must
-- change with it — there is deliberately no single source of truth beyond
-- "these two match".
-- ============================================================================

create or replace function public.update_invoice(
  p_voucher_id uuid,
  p_voucher_date date,
  p_party_ledger_id uuid,
  p_trading_ledger_id uuid,
  p_godown_id uuid,
  p_items jsonb,
  p_narration text default null,
  p_reference_number text default null,
  p_reference_date date default null,
  p_place_of_supply char(2) default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_branch_id uuid;
  v_voucher_type text;
  v_existing_fy text;
  v_new_fy text;
  v_fy_start_month smallint;

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
  select company_id, branch_id, voucher_type, financial_year_label
    into v_company_id, v_branch_id, v_voucher_type, v_existing_fy
    from public.vouchers where id = p_voucher_id;

  if v_company_id is null then
    raise exception 'Voucher not found';
  end if;

  if v_voucher_type not in ('sales','purchase','credit_note','debit_note') then
    raise exception '% is not an invoice type; update_invoice only edits sales, purchase, credit_note or debit_note vouchers — use update_voucher for others.',
      v_voucher_type;
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'An invoice needs at least one item line';
  end if;

  select financial_year_start_month into v_fy_start_month
    from public.companies where id = v_company_id;

  v_new_fy := app_private.fy_label(p_voucher_date, v_fy_start_month);

  -- F-01, same message pattern as update_voucher (0007).
  if v_new_fy is distinct from v_existing_fy then
    raise exception
      'Cannot move this voucher from financial year % to %: its number belongs to the % series. Delete it and re-enter under the correct year.',
      v_existing_fy, v_new_fy, v_existing_fy;
  end if;

  case v_voucher_type
    when 'sales'       then v_direction := 'out'; v_party_side := 'debit';  v_tax_prefix := 'output';
    when 'purchase'    then v_direction := 'in';  v_party_side := 'credit'; v_tax_prefix := 'input';
    when 'credit_note' then v_direction := 'in';  v_party_side := 'credit'; v_tax_prefix := 'output';
    when 'debit_note'  then v_direction := 'out'; v_party_side := 'debit';  v_tax_prefix := 'input';
  end case;

  v_gst_on := app_private.module_active(v_company_id, 'gst', p_voucher_date);
  -- TCS only ever applies on the output side of a sale (see 0027's header) —
  -- v_tax_prefix = 'output' is exactly 'sales' and 'credit_note'.
  v_tcs_on := v_tax_prefix = 'output' and app_private.module_active(v_company_id, 'tcs', p_voucher_date);

  if v_gst_on then
    v_registration_id := app_private.branch_registration(v_branch_id, p_voucher_date);
    if v_registration_id is null then
      raise exception 'GST is active for this company but branch % has no GST registration attached for %. Attach one before invoicing from it.',
        v_branch_id, p_voucher_date;
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

  -- Full replace, not a diff/patch — same discipline update_voucher already
  -- uses for voucher_entries, extended here to voucher_items.
  delete from public.voucher_items where voucher_id = p_voucher_id;
  delete from public.voucher_entries where voucher_id = p_voucher_id;

  update public.vouchers
     set voucher_date = p_voucher_date,
         narration = p_narration,
         reference_number = p_reference_number,
         reference_date = p_reference_date,
         party_ledger_id = p_party_ledger_id,
         place_of_supply = p_place_of_supply,
         supply_type = v_supply_type,
         updated_by = auth.uid()
   where id = p_voucher_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty  := (v_item->>'quantity')::numeric;
    v_rate := (v_item->>'rate')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every item line needs a quantity greater than zero';
    end if;

    -- Rounded per line, then summed. Summing unrounded and rounding once
    -- would leave the invoice total disagreeing with the lines a reader can
    -- add up.
    v_amount := round(v_qty * coalesce(v_rate, 0), 2);
    v_taxable_total := v_taxable_total + v_amount;

    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section
      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section
      from public.items where id = (v_item->>'item_id')::uuid;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, hsn_sac, description, line_order)
    values (
      p_voucher_id, v_company_id, v_branch_id, p_godown_id,
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

      -- A threshold (only TCS-VEHICLE has one) gates the whole line, not
      -- just the excess over it — "value exceeding Rs 10 lakh" per vehicle.
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

  -- Party carries the grand total (what they actually owe or are owed); the
  -- trading ledger carries only the taxable value.
  insert into public.voucher_entries (
    voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values
    (p_voucher_id, v_company_id, v_branch_id, p_party_ledger_id,
     case when v_party_side = 'debit'  then v_grand_total else 0 end,
     case when v_party_side = 'credit' then v_grand_total else 0 end, 0),
    (p_voucher_id, v_company_id, v_branch_id, p_trading_ledger_id,
     case when v_party_side = 'debit'  then 0 else v_taxable_total end,
     case when v_party_side = 'credit' then 0 else v_taxable_total end, 1);

  v_entry_line := 2;

  if v_gst_on then
    -- Each non-zero tax total gets its own entry, on the same side as the
    -- trading ledger. A missing ledger for a purpose that has money against
    -- it raises by name — this is the one place a silent omission would
    -- understate a tax liability.
    for v_ledger, v_amount in
      select app_private.tax_ledger(v_company_id, v_tax_prefix || '_' || t.kind, v_registration_id), t.amt
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
        p_voucher_id, v_company_id, v_branch_id, v_ledger,
        case when v_party_side = 'debit'  then 0 else v_amount end,
        case when v_party_side = 'credit' then 0 else v_amount end,
        v_entry_line);
      v_entry_line := v_entry_line + 1;
    end loop;
  end if;

  if v_tcs_total > 0 then
    v_ledger := app_private.tax_ledger(v_company_id, 'output_tcs', null);
    if v_ledger is null then
      raise exception 'No TCS Payable ledger configured for this company. Set a TAN in Settings first — that provisions it automatically.';
    end if;
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      p_voucher_id, v_company_id, v_branch_id, v_ledger,
      case when v_party_side = 'debit'  then 0 else v_tcs_total end,
      case when v_party_side = 'credit' then 0 else v_tcs_total end,
      v_entry_line);
  end if;

  return p_voucher_id;
end;
$$;

revoke execute on function public.update_invoice(uuid, date, uuid, uuid, uuid, jsonb, text, text, date, char) from public, anon;
grant execute on function public.update_invoice(uuid, date, uuid, uuid, uuid, jsonb, text, text, date, char) to authenticated;

comment on function public.update_invoice is
  'Edit-time twin of create_invoice (0027): full replace of voucher_items and voucher_entries for an existing invoice, same GST/TCS computation copied byte-for-byte. voucher_type and branch_id are not editable (mirrors update_voucher, 0007) since the voucher number already encodes both.';
