-- 2090: stock-availability guard on create_invoice and create_production_voucher.
--
-- THE BUG (found independently on two posting paths during the Sept 2026
-- manufacturing pilot): neither function checked whether an item actually
-- had enough on hand before posting a line that reduces its quantity.
-- create_invoice sold 10,000 units of Precision Shaft SH-100 against 745 on
-- hand and succeeded silently, driving quantity to -9,255 and closing value
-- to -Rs 43.3 lakh. create_production_voucher accepted a production run
-- that needed far more raw material than existed and drove a component
-- deeply negative the same way. The ONLY negative-stock guard anywhere in
-- the codebase was inside post_closing_stock (1450), which refuses to
-- CAPITALISE a negative valuation at period-close — months too late, after
-- the goods have shipped, been e-way-billed, and filed in a GSTR-1.
--
-- THE FIX: before finalising the voucher, check the item's current on-hand
-- quantity for every line whose direction REDUCES stock (a sale or a debit
-- note in create_invoice; raw-material consumption in
-- create_production_voucher) and refuse the posting, naming the item, the
-- quantity requested and the quantity actually available, unless the
-- caller explicitly opts in via the new trailing p_allow_negative_stock
-- parameter (default false). No existing caller in the app passes it (see
-- below), so every existing screen gets the new safety automatically with
-- zero behaviour change for an ordinary in-stock sale or production run.
--
-- Reuses public.get_stock_summary — the exact function the Stock Summary
-- report itself reads — rather than inventing a second stock-quantity
-- calculation. create_invoice calls it ONCE for the whole invoice (not once
-- per line); create_production_voucher piggybacks on the SAME
-- get_stock_summary call its costing loop already makes per component, so
-- the guard costs it nothing extra at all.
--
-- SCOPING (checked live before writing this): a read-only sweep of
-- get_stock_summary across every company in the database today
-- (2026-09-12) found 19 items already sitting at negative closing
-- quantity, e.g. "Finished Widget" at -379 in Sharma Textiles and several
-- companies' "Scrap Material" at -100 — pre-existing bad positions from
-- earlier test data / earlier bugs, unrelated to this fix. Blocking every
-- future write that touches an already-negative item would make those
-- positions permanently unfixable, so the guard fires ONLY when an item
-- that is CURRENTLY non-negative would be tipped below zero by THIS
-- posting (v_available >= 0 and v_available - v_requested < 0). An item
-- that is already negative for a historical reason is left alone by this
-- guard entirely — this migration touches only create_invoice and
-- create_production_voucher, never update_invoice or any delete path, so
-- an ordinary edit or voucher deletion on an already-negative item is
-- completely unaffected regardless.
--
-- OPT-IN CHECKED AGAINST EVERY CALLER: grepped every .rpc("create_invoice"
-- and .rpc("create_production_voucher") call in the app (VoucherScreen,
-- InvoiceForm, CaptureReviewForm, QuickBilling/POS, ManufacturingManager) —
-- none passes anything resembling an allow-negative-stock flag today, so
-- defaulting it to false changes no existing screen's behaviour for a
-- legitimate in-stock transaction.

-- ---------------------------------------------------------------------------
-- create_invoice: adds a trailing parameter, so the old signature must be
-- dropped first or Postgres creates a second overload alongside it (the
-- exact "ambiguous overload" trap invariants.test.ts already guards
-- against for this function — see 0065's own header).
-- ---------------------------------------------------------------------------
drop function public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  character, character, numeric, text, text, uuid, text, date);

create function public.create_invoice(
  p_company_id uuid, p_branch_id uuid, p_voucher_type text, p_voucher_date date,
  p_party_ledger_id uuid, p_trading_ledger_id uuid, p_godown_id uuid, p_items jsonb,
  p_narration text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text,
  p_reference_date date DEFAULT NULL::date, p_place_of_supply character DEFAULT NULL::bpchar,
  p_txn_currency character DEFAULT 'INR'::bpchar, p_exchange_rate numeric DEFAULT 1,
  p_rate_source text DEFAULT NULL::text, p_voucher_number text DEFAULT NULL::text,
  p_number_series_id uuid DEFAULT NULL::uuid, p_challan_number text DEFAULT NULL::text,
  p_challan_date date DEFAULT NULL::date,
  -- 2090: the only new parameter. Default false means every existing
  -- caller is unaffected and gets the new safety automatically.
  p_allow_negative_stock boolean DEFAULT false
)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  v_gross_amount numeric;
  v_discount_percent numeric;
  v_discount_amount numeric;
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
  v_party_reg_type text;
  v_lut_active boolean;
  v_intrastate boolean;
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

  -- Sec 9(3)/9(4) reverse charge (0102). v_rcm_tax_total is the
  -- self-assessed tax the RECIPIENT owes the government on notified
  -- inward supplies — never charged by the supplier, so it never touches
  -- v_grand_total (what the party is owed) or the normal input_cgst/
  -- input_sgst/input_igst accumulators (those represent tax the SUPPLIER
  -- charged and that is available for immediate set-off; RCM tax is
  -- neither). See migration header for why the matching debit lands on
  -- the trading ledger rather than an Input GST ledger.
  v_is_rcm_applicable boolean;
  v_line_rcm numeric;
  v_rcm_tax_total numeric := 0;
  v_rcm_ledger uuid;

  -- 2090: stock-availability guard.
  v_guard_item_id uuid;
  v_guard_item_name text;
  v_guard_uom text;
  v_guard_requested numeric;
  v_guard_available numeric;
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

  -- 2090: stock-availability guard — see this migration's header. Fires
  -- only for a line whose direction REDUCES stock (sales, debit notes);
  -- a purchase or credit note is always direction 'in' and can never
  -- drive quantity down, so it is never checked. Placed here, before any
  -- GST/TCS lookups or the voucher-number/header insert, so a rejected
  -- posting does the least possible work and consumes no voucher number.
  --
  -- One single get_stock_summary call for the WHOLE invoice (not one per
  -- line), joined against the per-item quantities already requested,
  -- summed per item so two lines for the same item in one invoice are
  -- checked against their combined total, not each against the same
  -- starting balance.
  if v_direction = 'out' and not p_allow_negative_stock then
    for v_guard_item_id, v_guard_item_name, v_guard_uom, v_guard_requested, v_guard_available in
      select i.id, i.name, i.uom, r.requested_qty, coalesce(s.closing_quantity, 0)
        from (
          select (elem->>'item_id')::uuid as item_id,
                 sum((elem->>'quantity')::numeric) as requested_qty
            from jsonb_array_elements(p_items) elem
           group by 1
        ) r
        join public.items i
          on i.id = r.item_id and i.item_type = 'goods' and i.maintain_stock
        left join public.get_stock_summary(p_company_id, p_voucher_date, null) s
          on s.item_id = i.id
    loop
      -- Deliberately does NOT fire when the item is ALREADY negative
      -- before this posting (v_guard_available < 0): this guard blocks a
      -- posting from newly tipping a non-negative balance below zero, not
      -- every future write that happens to touch an item that is already
      -- broken for some pre-existing, unrelated reason (see header).
      if v_guard_available >= 0 and v_guard_available - v_guard_requested < 0 then
        raise exception
          'Not enough stock to post this %: "%" needs % % but only % % is on hand as of %. Pass p_allow_negative_stock => true if this business genuinely sells or returns stock it does not have on hand.',
          p_voucher_type, v_guard_item_name, v_guard_requested, v_guard_uom,
          v_guard_available, v_guard_uom, to_char(p_voucher_date, 'DD Mon YYYY');
      end if;
    end loop;
  end if;

  v_gst_on := app_private.module_active(p_company_id, 'gst', p_voucher_date);

  -- 1460. GST off for this DATE, while the company's own registration says
  -- it was registered on that date, is a contradiction with no correct
  -- posting: charging tax would contradict every module-gated register, and
  -- posting zero files the return short (Sec 31(1) r/w Rule 46 — a
  -- registered person's tax invoice must show the tax charged). This used
  -- to pass silently and zero-rate the document. A genuinely unregistered
  -- business is untouched: branch_registration returns null for it, so it
  -- keeps invoicing with no tax exactly as before.
  if not v_gst_on
     and app_private.branch_registration(p_branch_id, p_voucher_date) is not null then
    raise exception
      'This document is dated %, and a GST registration for this branch was already in force on that date, but GST is only switched on for this company from %. Saving it would post it at NIL tax and carry that nil into the return. Fix the module''s start date before entering documents dated earlier.',
      to_char(p_voucher_date, 'DD Mon YYYY'),
      coalesce(
        (select to_char(min(m.effective_from), 'DD Mon YYYY')
           from public.company_modules m
          where m.company_id = p_company_id
            and m.module_code = 'gst'),
        'never - it is not switched on for this company at all');
  end if;
  v_tcs_on := v_tax_prefix = 'output' and app_private.module_active(p_company_id, 'tcs', p_voucher_date);

  if v_gst_on then
    v_registration_id := app_private.branch_registration(p_branch_id, p_voucher_date);
    if v_registration_id is null then
      raise exception 'GST is active for this company but branch % has no GST registration attached for %. Attach one before invoicing from it.',
        p_branch_id, p_voucher_date;
    end if;

    select state_code,
           lut_number is not null
             and p_voucher_date >= lut_valid_from
             and (lut_valid_to is null or p_voucher_date <= lut_valid_to)
      into v_supplier_state, v_lut_active
      from public.gst_registrations where id = v_registration_id;

    select gst_registration_type into v_party_reg_type
      from public.ledgers where id = p_party_ledger_id;

    if p_place_of_supply is null then
      select state_code into p_place_of_supply
        from public.ledgers where id = p_party_ledger_id;

      if p_place_of_supply is null then
        raise exception 'Cannot determine place of supply: % has no state on file and none was given', p_party_ledger_id;
      end if;
    end if;

    v_supply_type := app_private.gst_supply_type(v_supplier_state, p_place_of_supply, v_party_reg_type, v_lut_active);
    v_intrastate := v_supplier_state = p_place_of_supply;
  end if;

  if v_tcs_on then
    select pan into v_party_pan from public.ledgers where id = p_party_ledger_id;
  end if;

  -- 0725: the ONLY change to this functions body. Everything above and
  -- below is byte-for-byte what create_invoice did before, including every
  -- GST, RCM and TCS branch, which this migration deliberately does not read
  -- past to avoid.
  if p_voucher_number is not null then
    select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
      from app_private.resolve_manual_voucher_number(
        p_company_id, p_branch_id, p_voucher_type, p_voucher_date, p_voucher_number);
  else
    select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
      from app_private.next_voucher_number(
        p_company_id, p_branch_id, p_voucher_type, p_voucher_date, p_number_series_id);
  end if;

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, reference_number,
    reference_date, party_ledger_id, place_of_supply, supply_type,
    txn_currency, exchange_rate, rate_source,
    challan_number, challan_date, created_by)
  values (
    p_company_id, p_branch_id, p_voucher_type, v_display_number, v_seq,
    v_fy, p_voucher_date, p_narration, p_reference_number,
    p_reference_date, p_party_ledger_id, p_place_of_supply, v_supply_type,
    p_txn_currency, p_exchange_rate, p_rate_source,
    -- 0865: the ONLY other change to this body. '' from an empty form
    -- field is not a challan number; normalised to null here so the
    -- vouchers_challan_number_not_blank CHECK never has to fire on an
    -- ordinary save. p_challan_date is passed through untouched — a
    -- dated challan whose number could not be read is a real reading.
    nullif(btrim(p_challan_number), ''), p_challan_date, auth.uid())
  returning id into v_voucher_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty  := (v_item->>'quantity')::numeric;
    v_rate := (v_item->>'rate')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every item line needs a quantity greater than zero';
    end if;

    -- Sec 15(3)(a) / Rule 46(k): taxable value is NET of any discount
    -- recorded on this invoice. Absent from p_items (every caller before
    -- this migration's own UI change, and every other create_invoice
    -- caller that has not been taught about discounts) this resolves to
    -- exactly 0, so v_amount = v_gross_amount unchanged — byte-identical
    -- to the pre-0147 formula. See migration header.
    v_discount_percent := coalesce((v_item->>'discount_percent')::numeric, 0);
    if v_discount_percent < 0 or v_discount_percent > 100 then
      raise exception 'Discount percent must be between 0 and 100, got % for item %',
        v_discount_percent, v_item->>'item_id';
    end if;

    v_gross_amount := round(v_qty * coalesce(v_rate, 0), 2);
    v_discount_amount := round(v_gross_amount * v_discount_percent / 100, 2);
    v_amount := v_gross_amount - v_discount_amount;
    v_taxable_total := v_taxable_total + v_amount;

    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable
      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section, v_is_rcm_applicable
      from public.items where id = (v_item->>'item_id')::uuid;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, discount_percent, hsn_sac, description, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, p_godown_id,
      (v_item->>'item_id')::uuid,
      v_direction, v_qty, coalesce(v_uom, 'NOS'), coalesce(v_rate, 0), v_amount, v_discount_percent,
      v_hsn, v_item->>'description', v_line_no);

    v_line_cgst := 0; v_line_sgst := 0; v_line_igst := 0; v_line_cess := 0;

    if v_gst_on then
      -- RCM (0102): only on purchases, only lines the item master flags as
      -- notified under Sec 9(3) (or the narrow Sec 9(4) real-estate-
      -- promoter case a preparer represents the same way — see header).
      -- MUTUALLY EXCLUSIVE with the ordinary tax branch below, not
      -- additional to it: under reverse charge the SUPPLIER charges no
      -- tax at all — that is the entire premise of RCM — so v_line_cgst/
      -- sgst/igst/cess stay at the zero they were just set to. Getting
      -- this wrong (computing both) would double the tax: once funded by
      -- the party via v_grand_total as if the supplier had charged it,
      -- and again self-assessed via rcm_payable below. Computed straight
      -- from the item's own rate, deliberately NOT routed through the
      -- export/SEZ zero-rating branch: that branch answers "is OUR
      -- outward supply zero-rated", a question about sales with no
      -- bearing on a self-assessed inward-supply liability.
      if p_voucher_type = 'purchase' and coalesce(v_is_rcm_applicable, false) then
        v_line_rcm := round(v_amount * (coalesce(v_gst_rate, 0) + coalesce(v_cess_rate, 0)) / 100, 2);
        v_rcm_tax_total := v_rcm_tax_total + v_line_rcm;
      else
        if v_tax_prefix = 'input'
           and v_party_reg_type in ('unregistered', 'composition') then
          -- This supplier cannot lawfully have charged us any tax: an
          -- unregistered person may not collect it (Sec 32(1)) and a
          -- composition dealer may not either (Sec 10(4)), issuing a bill
          -- of supply instead of a tax invoice (Rule 49). So there is no
          -- input credit to take and nothing to add to what we owe them.
          -- Reached only when the line is NOT reverse-charge: RCM is a
          -- property of the item, applies whoever sold it, and is still
          -- self-assessed above.
          null;
        elsif v_supply_type = 'export_lut' or (v_supply_type = 'sez' and v_lut_active) then
          -- Sec 16(3)(a): zero-rated under LUT — no CGST/SGST/IGST/cess at all.
          null;
        elsif v_supply_type = 'export_igst' or (v_supply_type = 'sez' and not v_lut_active) then
          -- Sec 16(3)(b): zero-rated via the IGST-refund route — full IGST is
          -- charged (refunded later), always inter-State per Sec 7(5) IGST Act
          -- regardless of whether the two states actually differ.
          v_line_igst := round(v_amount * coalesce(v_gst_rate, 0) / 100, 2);
          v_line_cess := round(v_amount * coalesce(v_cess_rate, 0) / 100, 2);
        elsif v_intrastate then
          -- Ordinary domestic split by the real place of supply. Reached by
          -- plain 'intra' sales exactly as before, and by 'deemed_export'
          -- (Sec 147 supplies are taxed normally, never zero-rated — see this
          -- migration's header).
          v_line_cgst := round(v_amount * coalesce(v_gst_rate, 0) / 2 / 100, 2);
          v_line_sgst := v_line_cgst;
          v_line_cess := round(v_amount * coalesce(v_cess_rate, 0) / 100, 2);
        else
          v_line_igst := round(v_amount * coalesce(v_gst_rate, 0) / 100, 2);
          v_line_cess := round(v_amount * coalesce(v_cess_rate, 0) / 100, 2);
        end if;

        v_cgst_total := v_cgst_total + v_line_cgst;
        v_sgst_total := v_sgst_total + v_line_sgst;
        v_igst_total := v_igst_total + v_line_igst;
        v_cess_total := v_cess_total + v_line_cess;
      end if;
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
        raise exception 'No % GST ledger is mapped for this registration, so there is nowhere to post the tax to. Open Registrations → Tax ledgers and press Repair for this GSTIN.', v_tax_prefix;
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

  -- RCM (0102): the self-assessed liability, and its matching debit.
  -- Never folded into the loop above — rcm_payable is its own purpose,
  -- always a straight Cr regardless of v_party_side (this block is only
  -- reached when p_voucher_type = 'purchase', so v_party_side is always
  -- 'credit' here, but the liability direction is written out plainly
  -- rather than through the case-when idiom the other loop reuses across
  -- four voucher types, since RCM only ever has one). The matching debit
  -- lands on the SAME trading ledger as the taxable value, not on Input
  -- CGST/SGST/IGST — see migration header for why: Sec 49(4) bars using
  -- this tax to pay output tax until the recipient has actually remitted
  -- it in cash, and LEKHA has no event representing that remittance
  -- separately from the ordinary GST-payable postings a later payment
  -- voucher already makes. Booking it as an immediate Input GST credit
  -- here would let get_gst_setoff_clearing (0090) treat it as usable
  -- same-voucher, which is exactly the fabricated-credit outcome this
  -- migration is written to avoid. Capitalising it into the trading
  -- ledger instead is conservative, not final — see scope_deferred.
  if v_rcm_tax_total > 0 then
    v_rcm_ledger := app_private.tax_ledger(p_company_id, 'rcm_payable', v_registration_id);
    if v_rcm_ledger is null then
      raise exception 'No RCM Payable ledger is mapped for this registration, so the reverse-charge liability has nowhere to post. Open Registrations → Tax ledgers and press Repair for this GSTIN.';
    end if;
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, v_rcm_ledger,
      0, v_rcm_tax_total, v_entry_line);
    v_entry_line := v_entry_line + 1;

    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, p_trading_ledger_id,
      v_rcm_tax_total, 0, v_entry_line);
    v_entry_line := v_entry_line + 1;
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

revoke all on function public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  character, character, numeric, text, text, uuid, text, date, boolean)
  from public, anon;
grant execute on function public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  character, character, numeric, text, text, uuid, text, date, boolean)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- create_production_voucher: same trailing-parameter treatment.
-- ---------------------------------------------------------------------------
drop function public.create_production_voucher(
  uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text);

create function public.create_production_voucher(
  p_company_id uuid, p_branch_id uuid, p_bom_id uuid, p_quantity_produced numeric,
  p_component_godown_id uuid, p_output_godown_id uuid, p_voucher_date date,
  p_additional_cost numeric DEFAULT 0, p_narration text DEFAULT NULL::text,
  -- 2090: the only new parameter. Default false means every existing
  -- caller (ManufacturingManager is the only one in the app) is
  -- unaffected and gets the new safety automatically.
  p_allow_negative_stock boolean DEFAULT false
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_bom record;
  v_comp record;
  v_scale numeric;
  v_rate numeric;
  v_avail_qty numeric;
  v_component_cost numeric := 0;
  v_line_amount numeric;
  v_effective_cost numeric;
  v_effective_cost_r numeric;
  v_output_rate numeric;
  v_clearing_ledger uuid;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_voucher_id uuid;
  v_line int := 0;
  v_component_count int := 0;
  v_output_row_count int := 0;
  v_main_line int;
  v_out record;
  v_out_qty numeric;
  v_out_amount numeric;
  v_secondary_total numeric := 0;
  v_joint_pool numeric;
  v_co_product_count int := 0;
  v_co_weight_total numeric := 0;
  v_main_sale_rate numeric;
  v_main_weight numeric;
  v_total_weight numeric;
  v_co_output_total numeric := 0;
  v_out_weight numeric;
  v_out_share numeric;
  v_main_amount numeric;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to record production for this company';
  end if;
  if not app_private.module_active(p_company_id, 'manufacturing', p_voucher_date) then
    raise exception 'Manufacturing and BOM is not an active module for this company — turn it on in Settings first';
  end if;
  if not (p_quantity_produced > 0) then
    raise exception 'Quantity produced must be greater than zero';
  end if;
  if p_additional_cost < 0 then
    raise exception 'Additional cost cannot be negative';
  end if;

  select id, output_item_id, yield_quantity into v_bom
    from public.bill_of_materials
   where id = p_bom_id and company_id = p_company_id and is_active;

  if v_bom.id is null then
    raise exception 'BOM % does not exist (or is inactive) in this company', p_bom_id;
  end if;

  v_scale := p_quantity_produced / v_bom.yield_quantity;

  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, 'stock_journal', p_voucher_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, created_by)
  values (
    p_company_id, p_branch_id, 'stock_journal', v_display_number, v_seq,
    v_fy, p_voucher_date, coalesce(p_narration, 'Production'), auth.uid())
  returning id into v_voucher_id;

  for v_comp in
    select bc.component_item_id, bc.quantity, i.uom, i.name, i.item_type, i.maintain_stock
      from public.bom_components bc
      join public.items i on i.id = bc.component_item_id
     where bc.bom_id = p_bom_id
     order by bc.line_order
  loop
    v_component_count := v_component_count + 1;

    -- 2090: fetch closing_quantity in the SAME get_stock_summary call this
    -- loop already made for average_rate — the guard below costs this
    -- function nothing extra.
    select s.average_rate, s.closing_quantity into v_rate, v_avail_qty
      from public.get_stock_summary(p_company_id, p_voucher_date, null) s
     where s.item_id = v_comp.component_item_id;
    v_rate := coalesce(v_rate, 0);
    v_avail_qty := coalesce(v_avail_qty, 0);

    declare
      v_qty numeric := round(v_comp.quantity * v_scale, 3);
    begin
      -- 2090: stock-availability guard — see this migration's header.
      -- Consuming a component always reduces its stock, so every
      -- component line is checked (unlike create_invoice, there is no
      -- 'in' direction to skip here). Only applies to an item that is
      -- itself stock-tracked ('goods' + maintain_stock — the same two
      -- conditions get_stock_summary itself filters on), and only when
      -- the item is CURRENTLY non-negative: an already-negative component
      -- (a pre-existing, unrelated bad position) is left alone, exactly
      -- as in create_invoice.
      if not p_allow_negative_stock
         and v_comp.item_type = 'goods' and v_comp.maintain_stock
         and v_avail_qty >= 0 and (v_avail_qty - v_qty) < 0 then
        raise exception
          'Not enough % on hand to consume in this production: needs % % but only % % is available as of %. Pass p_allow_negative_stock => true if this business deliberately produces into a negative component balance.',
          v_comp.name, v_qty, v_comp.uom, v_avail_qty, v_comp.uom, to_char(p_voucher_date, 'DD Mon YYYY');
      end if;

      v_line_amount := round(v_qty * v_rate, 2);
      v_component_cost := v_component_cost + v_line_amount;

      insert into public.voucher_items (
        voucher_id, company_id, branch_id, godown_id, item_id,
        direction, quantity, uom, rate, amount, line_order)
      values (
        v_voucher_id, p_company_id, p_branch_id, p_component_godown_id, v_comp.component_item_id,
        'out', v_qty, v_comp.uom, v_rate, v_line_amount, v_line);
      v_line := v_line + 1;
    end;
  end loop;

  if v_component_count = 0 then
    raise exception 'This BOM has no components — nothing to consume';
  end if;

  v_effective_cost := v_component_cost + p_additional_cost;
  v_effective_cost_r := round(v_effective_cost, 2);

  select count(*) into v_output_row_count from public.bom_outputs where bom_id = p_bom_id;

  if v_output_row_count = 0 then
    -- ORIGINAL 0070 branch, untouched — guarantees byte-identical output
    -- for every BOM that has no by-product/scrap/co-product rows.
    v_output_rate := round(v_effective_cost / p_quantity_produced, 4);

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, line_order)
    select v_voucher_id, p_company_id, p_branch_id, p_output_godown_id, v_bom.output_item_id,
           'in', p_quantity_produced, i.uom, v_output_rate, round(v_effective_cost, 2), v_line
      from public.items i where i.id = v_bom.output_item_id;
  else
    -- Reserve the main output's line position now (it reads right after
    -- the components, matching the plain-BOM layout above) even though
    -- its amount — the residual after by-products/scrap/co-products — is
    -- only known once every other output has been valued.
    v_main_line := v_line;
    v_line := v_line + 1;

    -- Pass 1: by_product / scrap — each valued at its own NRV and netted
    -- straight off the batch cost (Ind AS 2 para 13).
    for v_out in
      select bo.output_item_id, bo.quantity, bo.nrv_rate, i.uom
        from public.bom_outputs bo
        join public.items i on i.id = bo.output_item_id
       where bo.bom_id = p_bom_id and bo.output_type in ('by_product', 'scrap')
       order by bo.line_order
    loop
      v_out_qty := round(v_out.quantity * v_scale, 3);
      v_out_amount := round(v_out_qty * v_out.nrv_rate, 2);
      v_secondary_total := v_secondary_total + v_out_amount;

      insert into public.voucher_items (
        voucher_id, company_id, branch_id, godown_id, item_id,
        direction, quantity, uom, rate, amount, line_order)
      values (
        v_voucher_id, p_company_id, p_branch_id, p_output_godown_id, v_out.output_item_id,
        'in', v_out_qty, v_out.uom, v_out.nrv_rate, v_out_amount, v_line);
      v_line := v_line + 1;
    end loop;

    v_joint_pool := v_effective_cost_r - v_secondary_total;
    if v_joint_pool < 0 then
      raise exception 'The combined net realisable value of this batch''s scrap/by-products (%) exceeds its total process cost (%) — check the NRV rates on this BOM''s outputs',
        v_secondary_total, v_effective_cost_r;
    end if;

    -- Pass 2: co_product — shares the remaining joint cost pool with the
    -- main product in proportion to relative sales value (Ind AS 2 para
    -- 14 / CAS-19), not simply credited at NRV like a by-product.
    select count(*), coalesce(sum(round(bo.quantity * v_scale, 3) * bo.nrv_rate), 0)
      into v_co_product_count, v_co_weight_total
      from public.bom_outputs bo
     where bo.bom_id = p_bom_id and bo.output_type = 'co_product';

    if v_co_product_count > 0 then
      select sale_rate into v_main_sale_rate from public.items where id = v_bom.output_item_id;
      if coalesce(v_main_sale_rate, 0) <= 0 then
        raise exception 'This BOM has co-products, which need the main product''s own Sale Rate (in its item master) to split the joint cost by relative sales value — set a Sale Rate on % first',
          (select name from public.items where id = v_bom.output_item_id);
      end if;

      v_main_weight := v_main_sale_rate * p_quantity_produced;
      v_total_weight := v_main_weight + v_co_weight_total;
      if v_total_weight <= 0 then
        raise exception 'Cannot allocate joint cost: the total relative sales value of the main product and its co-products is zero';
      end if;

      for v_out in
        select bo.output_item_id, bo.quantity, bo.nrv_rate, i.uom
          from public.bom_outputs bo
          join public.items i on i.id = bo.output_item_id
         where bo.bom_id = p_bom_id and bo.output_type = 'co_product'
         order by bo.line_order
      loop
        v_out_qty := round(v_out.quantity * v_scale, 3);
        v_out_weight := v_out_qty * v_out.nrv_rate;
        v_out_share := round(v_joint_pool * v_out_weight / v_total_weight, 2);
        v_co_output_total := v_co_output_total + v_out_share;

        insert into public.voucher_items (
          voucher_id, company_id, branch_id, godown_id, item_id,
          direction, quantity, uom, rate, amount, line_order)
        values (
          v_voucher_id, p_company_id, p_branch_id, p_output_godown_id, v_out.output_item_id,
          'in', v_out_qty, v_out.uom, round(v_out_share / nullif(v_out_qty, 0), 4), v_out_share, v_line);
        v_line := v_line + 1;
      end loop;
    end if;

    -- Main product takes the exact residual, so
    -- main + by_products/scrap + co_products == effective cost, always —
    -- cost is redistributed across outputs, never created or destroyed.
    v_main_amount := v_joint_pool - v_co_output_total;
    if v_main_amount < 0 then
      raise exception 'Rounding of co-product shares produced a negative main-product cost — check the BOM''s output valuations';
    end if;

    v_output_rate := case when p_quantity_produced > 0 then round(v_main_amount / p_quantity_produced, 4) else 0 end;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, line_order)
    select v_voucher_id, p_company_id, p_branch_id, p_output_godown_id, v_bom.output_item_id,
           'in', p_quantity_produced, i.uom, v_output_rate, v_main_amount, v_main_line
      from public.items i where i.id = v_bom.output_item_id;
  end if;

  v_clearing_ledger := public.ensure_manufacturing_clearing_ledger(p_company_id);

  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_clearing_ledger, v_effective_cost_r, 0, 0);
  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_clearing_ledger, 0, v_effective_cost_r, 1);

  return v_voucher_id;
end;
$function$;

revoke all on function public.create_production_voucher(
  uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text, boolean)
  from public, anon;
grant execute on function public.create_production_voucher(
  uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text, boolean)
  to authenticated, service_role;
