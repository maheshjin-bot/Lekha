-- ============================================================================
-- 1310 — e-Way Bill JSON silently null'd the same missing branch address
-- e-invoice hard-blocks on, with nothing to tell the preparer why
-- ============================================================================
-- build_einvoice_json (0230) refuses outright when the raising branch has
-- no address on file (address_line1, city or PIN code) — a deliberate,
-- named exception. build_ewb_json (0190, last redefined by 0805 to read
-- ship-to from the newer voucher_ship_to table) hits the identical gap
-- (the same branches.address_line1/city/pincode columns) but just emits
-- "fromAddr1": null, "fromAddr2": null, "fromPlace": null,
-- "fromPincode": null with no warning anywhere. A real NIC EWB-01
-- submission built from this payload would very likely be rejected, with
-- nothing in this app to say why. Found live (wave 7, 1 Sep 2026).
--
-- Not changed to a hard block like e-invoice's, since this function's own
-- design already tolerates a lot of optional-but-missing fields
-- (transporter, vehicle number) without refusing to build — a warning that
-- travels WITH the JSON is the more consistent fix: added to a new
-- meta.warnings array, read by EwbDetailsForm.tsx to show a banner above
-- the payload.
--
-- Reproduced here as a straight CREATE OR REPLACE against 0805's own
-- function body (the last one to actually redefine it — confirmed by
-- grepping every migration that touches build_ewb_json/ewb_details; 0510
-- and 0865 only mention it in comments), with only the branch-address
-- check and the meta.warnings field added on top. Everything else —
-- voucher_ship_to, the bill-to/ship-to split, transactionType — is 0805
-- unchanged.
-- ============================================================================

create or replace function public.build_ewb_json(p_voucher_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_voucher record;
  v_branch record;
  v_party record;
  v_ship record;
  v_ewb record;
  v_req record;
  v_tax record;
  v_items jsonb;
  v_supply_inter boolean;
  v_warnings text[] := '{}';
begin
  select v.id, v.company_id, v.branch_id, v.voucher_number, v.voucher_date, v.voucher_type,
         v.reference_number, v.reference_date, v.party_ledger_id, v.supply_type, v.place_of_supply,
         v.is_deleted
    into v_voucher
    from public.vouchers v
   where v.id = p_voucher_id;

  if v_voucher.id is null then
    raise exception 'Voucher % not found or not accessible', p_voucher_id;
  end if;
  if v_voucher.is_deleted then
    raise exception 'Cannot build e-Way Bill JSON for a deleted voucher';
  end if;
  if v_voucher.voucher_type <> 'sales' then
    raise exception 'e-Way Bill JSON can only be built for a sales voucher, not a % voucher', v_voucher.voucher_type;
  end if;

  select b.state_code, b.address_line1, b.address_line2, b.city, b.pincode,
         r.gstin, coalesce(r.trade_name, r.legal_name) as trade_name
    into v_branch
    from public.branches b
    left join public.gst_registrations r on r.id = app_private.branch_registration(b.id, v_voucher.voucher_date)
   where b.id = v_voucher.branch_id;

  if v_branch.address_line1 is null or v_branch.city is null or v_branch.pincode is null then
    v_warnings := v_warnings || (
      'The branch that raised this invoice has no address on file (address line 1, city or PIN code) — ' ||
      'fromAddr1/fromPlace/fromPincode below are blank. A real NIC submission with this payload would very likely be rejected.'
    );
  end if;

  select l.name, l.gstin, l.address, l.city, l.pincode, l.state_code
    into v_party
    from public.ledgers l
   where l.id = v_voucher.party_ledger_id;

  -- The invoice's own ship-to (0805) — the single home for a delivery
  -- address, shared with the printed invoice, so the EWB payload and the
  -- document cannot disagree.
  select s.id, s.ship_to_name, s.ship_to_address, s.ship_to_city,
         s.ship_to_gstin, s.ship_to_state_code, s.ship_to_pincode
    into v_ship
    from public.voucher_ship_to s
   where s.voucher_id = p_voucher_id;

  select e.id, e.transporter_id, e.transporter_name, e.vehicle_number, e.transport_mode,
         e.transport_doc_number, e.transport_doc_date, e.approx_distance_km,
         e.ewb_number, e.ewb_generated_date, e.ewb_valid_until, e.status
    into v_ewb
    from public.ewb_details e
   where e.voucher_id = p_voucher_id;

  select * into v_req from public.get_ewb_requirement(p_voucher_id);

  select
      sum(case when t.purpose = 'output_cgst' then e.credit_amount - e.debit_amount else 0 end) as cgst,
      sum(case when t.purpose = 'output_sgst' then e.credit_amount - e.debit_amount else 0 end) as sgst,
      sum(case when t.purpose = 'output_igst' then e.credit_amount - e.debit_amount else 0 end) as igst,
      sum(case when t.purpose = 'output_cess' then e.credit_amount - e.debit_amount else 0 end) as cess
    into v_tax
    from public.voucher_entries e
    join public.tax_ledger_map t on t.ledger_id = e.ledger_id and t.company_id = e.company_id
   where e.voucher_id = p_voucher_id;

  -- Reads the voucher's own supply_type, which under Sec 10(1)(b) follows the
  -- BILL-TO party — never the ship-to state below. The two disagreeing is the
  -- normal, correct shape of a bill-to/ship-to consignment, not a fault.
  v_supply_inter := v_voucher.supply_type is distinct from 'intra';

  with mix as (
    select
      vi.voucher_id,
      sum(vi.amount * coalesce(i.gst_rate_percent, 0) / 100) as total_implied_gst,
      sum(vi.amount * coalesce(i.cess_rate_percent, 0) / 100) as total_implied_cess,
      sum(vi.amount) as total_amount
    from public.voucher_items vi
    join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
    where vi.voucher_id = p_voucher_id
    group by vi.voucher_id
  ),
  grouped as (
    select
      coalesce(vi.hsn_sac, i.hsn_sac, '(no HSN/SAC)') as hsn_sac,
      vi.uom,
      sum(vi.quantity) as quantity,
      sum(vi.amount) as taxable_amount,
      sum(vi.amount * coalesce(i.gst_rate_percent, 0) / 100) as implied_gst,
      sum(vi.amount * coalesce(i.cess_rate_percent, 0) / 100) as implied_cess
    from public.voucher_items vi
    join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
    where vi.voucher_id = p_voucher_id
    group by 1, 2
  )
  select jsonb_agg(jsonb_build_object(
    'hsnCode', g.hsn_sac,
    'qtyUnit', g.uom,
    'quantity', g.quantity,
    'taxableAmount', round(g.taxable_amount, 2),
    'cgstRate', case when v_supply_inter or coalesce(mx.total_implied_gst, 0) = 0 then 0
                     else round((g.implied_gst / mx.total_implied_gst * coalesce(v_tax.cgst, 0)) / nullif(g.taxable_amount, 0) * 100, 2) end,
    'sgstRate', case when v_supply_inter or coalesce(mx.total_implied_gst, 0) = 0 then 0
                     else round((g.implied_gst / mx.total_implied_gst * coalesce(v_tax.sgst, 0)) / nullif(g.taxable_amount, 0) * 100, 2) end,
    'igstRate', case when not v_supply_inter or coalesce(mx.total_implied_gst, 0) = 0 then 0
                     else round((g.implied_gst / mx.total_implied_gst * coalesce(v_tax.igst, 0)) / nullif(g.taxable_amount, 0) * 100, 2) end,
    'cessRate', case when coalesce(mx.total_implied_cess, 0) = 0 then 0
                     else round((g.implied_cess / mx.total_implied_cess * coalesce(v_tax.cess, 0)) / nullif(g.taxable_amount, 0) * 100, 2) end
  ))
    into v_items
    from grouped g
    cross join mix mx;

  return jsonb_build_object(
    'meta', jsonb_build_object(
      'builtBy', 'LEKHA build_ewb_json — offline payload builder, no NIC API call made',
      'voucherId', v_voucher.id,
      'schemaBasis', 'NIC EWB-01 field shape, cross-checked against published GSP integration references (mastergst.com, logitax.in) — see 0190 migration header',
      'warnings', to_jsonb(v_warnings)
    ),
    'supplyType', 'O',
    'subSupplyType', '1',
    -- NIC transactionType 2 = "Bill To - Ship To". A voucher_ship_to row is
    -- exactly that case and cannot exist half-filled, so its presence alone
    -- decides this.
    'transactionType', case when v_ship.id is not null then 2 else 1 end,
    'docType', 'INV',
    'docNo', v_voucher.voucher_number,
    'docDate', to_char(v_voucher.voucher_date, 'DD/MM/YYYY'),
    'fromGstin', v_branch.gstin,
    'fromTrdName', v_branch.trade_name,
    'fromAddr1', v_branch.address_line1,
    'fromAddr2', v_branch.address_line2,
    'fromPlace', v_branch.city,
    'fromPincode', v_branch.pincode,
    'fromStateCode', v_branch.state_code,
    -- to* is the BILL-TO party throughout (toGstin/toTrdName/toStateCode);
    -- actToStateCode and the shipTo* fields carry the physical destination.
    -- That split is NIC's own and it mirrors Sec 10(1)(b) exactly.
    'toGstin', v_party.gstin,
    'toTrdName', v_party.name,
    'toStateCode', v_party.state_code,
    'toAddr1', coalesce(v_ship.ship_to_address, v_party.address),
    'toPlace', coalesce(v_ship.ship_to_city, v_party.city),
    'toPincode', coalesce(v_ship.ship_to_pincode, v_party.pincode),
    'actToStateCode', coalesce(v_ship.ship_to_state_code, v_party.state_code),
    'shipToName', v_ship.ship_to_name,
    'shipToGstin', v_ship.ship_to_gstin,
    'totalValue', round(coalesce(v_req.taxable_value, 0), 2),
    'cgstValue', round(coalesce(v_tax.cgst, 0), 2),
    'sgstValue', round(coalesce(v_tax.sgst, 0), 2),
    'igstValue', round(coalesce(v_tax.igst, 0), 2),
    'cessValue', round(coalesce(v_tax.cess, 0), 2),
    'totInvValue', round(coalesce(v_req.consignment_value, 0), 2),
    'transporterId', v_ewb.transporter_id,
    'transporterName', v_ewb.transporter_name,
    'transMode', case v_ewb.transport_mode when 'road' then '1' when 'rail' then '2' when 'air' then '3' when 'ship' then '4' else null end,
    'transDistance', v_ewb.approx_distance_km,
    'transDocNo', v_ewb.transport_doc_number,
    'transDocDate', case when v_ewb.transport_doc_date is not null then to_char(v_ewb.transport_doc_date, 'DD/MM/YYYY') else null end,
    'vehicleNo', v_ewb.vehicle_number,
    'itemList', coalesce(v_items, '[]'::jsonb),
    'consignmentValue', round(coalesce(v_req.consignment_value, 0), 2),
    'ewbThresholdAmount', v_req.threshold_amount,
    'isEwbRequired', coalesce(v_req.is_ewb_required, false),
    'capturedEwbNumber', v_ewb.ewb_number,
    'capturedEwbGeneratedDate', v_ewb.ewb_generated_date,
    'capturedEwbValidUntil', v_ewb.ewb_valid_until,
    'captureStatus', coalesce(v_ewb.status, 'not_generated')
  );
end;
$$;

revoke all on function public.build_ewb_json(uuid) from public, anon;
grant execute on function public.build_ewb_json(uuid) to authenticated;

comment on function public.build_ewb_json(uuid) is
  'Assembles an EWB-01-shaped JSON payload for a sales voucher from its own posted data (party/branch/GST registration/HSN lines, actual posted CGST/SGST/IGST/cess) plus ewb_details'' own transporter fields and voucher_ship_to''s own delivery address (0805). Does NOT call the NIC EWB API — this app has no GSP/direct-enrolment credentials to do so. itemList rates are reverse-derived from actually-posted tax via the same implied-tax weighting 0134''s get_gstr1_hsn_summary uses, not read off the item master''s nominal rate. meta.warnings (1310) flags a missing branch address instead of silently nulling fromAddr1/fromPlace/fromPincode — build_einvoice_json refuses outright for the identical gap, this one still builds but says why the from-address fields are blank. Raises if the voucher is missing, deleted, or not a sales voucher.';
