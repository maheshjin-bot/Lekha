-- ============================================================================
-- 1390 — a GSTIN's legal/trade name had no writer, and a GSTIN could never
-- be surrendered or moved onto QRMP
-- ============================================================================
-- Three defects, one table, one screen. All three were confirmed live before
-- this migration was written, not inferred from the source.
--
-- (A) gst_registrations.legal_name / trade_name have existed since 0005 and
--     NOTHING HAS EVER WRITTEN THEM. add_gst_registration's insert column
--     list (0018:293) omits both; the only frontend write to this table
--     (RegistrationManager.tsx, the LUT editor) sets the four lut_* columns
--     and nothing else; `grep trade_name app components lib` returns zero
--     hits. Live check, 2 Sep 2026: all 13 registrations in this project have
--     legal_name IS NULL and trade_name IS NULL. Every one.
--
--     That is not cosmetic. build_ewb_json reads
--     `coalesce(r.trade_name, r.legal_name)` (1310:67) and emits it as
--     'fromTrdName' (1310:177), and fromTrdName is a REQUIRED field on NIC's
--     EWB-01. get_delivery_challan_* (0510:726,786) reads the same pair.
--     So every e-way bill payload this app has ever produced carried
--     "fromTrdName": null.
--
--     And it carried it SILENTLY. 1310 added a meta.warnings array precisely
--     so a preparer is told when a required from-* field comes out blank —
--     but it only warns about the branch ADDRESS. Verified live on voucher
--     1ccbec67 (Nexgen Softwares, HO/SAL/2026-27/00009, 20 Aug 2026): the
--     address is now populated (1320's Branches screen), warnings is [], and
--     fromTrdName is null. The payload looks clean and gets rejected at the
--     portal instead. This migration closes that: a blank fromTrdName now
--     says why, in the same array, in the same shape 1310 established.
--
-- (B) registered_to has never been settable. It is how a cancelled or
--     surrendered GSTIN stops appearing in future periods, and 0005:50-52
--     spells out the contract: "Historical vouchers under a cancelled
--     registration stay valid and still have to appear in their period's
--     return." Four live functions honour it —
--     app_private.branch_registration, app_private.company_gstin_count,
--     public.get_compliance_calendar, public.get_isd_distribution — and the
--     UI never fetched the column, let alone wrote it. A business that
--     surrenders a GSTIN had no way to say so and its returns kept including
--     that registration forever.
--
-- (C) add_gst_registration has accepted p_registration_type and
--     p_filing_frequency since 0018, and RegistrationManager.tsx:120 passes
--     NEITHER — so every registration in this app is frozen at the column
--     defaults ('regular', 'monthly'). QRMP opt-in/opt-out is a quarterly
--     election every small taxpayer makes, and filing_frequency is what
--     get_compliance_calendar (1020:148,157,169,176) and
--     get_gstr3b_table5_1 (0225:369) read to decide monthly-vs-quarterly
--     due dates. Live: all 13 registrations are 'monthly'. Not because
--     anyone chose monthly — because nothing could choose anything.
--
-- ----------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT EDITABLE, AND WHY
-- ----------------------------------------------------------------------------
-- gstin
--   The table's unique key, denormalised into state_code and overwritten from
--   the GSTIN by the enforce_gstin_state trigger (0005), and the target of
--   branches' composite FK (gst_registration_id, company_id, state_code). A
--   correction path (typo in a GSTIN discovered after invoices exist) is a
--   real need and a real slice of its own — it has to move the branch FK, the
--   seeded tax ledgers and tax_ledger_map together. Named here, not
--   half-built.
--
-- state_code
--   Not user data at all. Derived from the GSTIN by trigger. Editing it would
--   only ever desynchronise it from the GSTIN it is a copy of.
--
-- registration_type — THE DELIBERATE ONE. NOT EDITABLE. Reasoning:
--   1. Nothing computes composition tax from it. Checked live, not recalled:
--      exactly three functions read gst_registrations.registration_type —
--      app_private.company_gstin_count, app_private.module_activation_date
--      and public.get_isd_distribution — and all three only ask
--      `registration_type <> 'isd'`. create_invoice, update_invoice and
--      build_einvoice_json contain the string 'registration_type' only as
--      the PARTY ledger's gst_registration_type (which is what 1230's
--      unregistered/composition ITC rule keys off — the SUPPLIER's status,
--      not the company's own). Sec 10 output tax on this company's own
--      supplies is not implemented anywhere. So flipping 'regular' ->
--      'composition' would change no computation at all: invoices would keep
--      going out with full CGST/SGST while the registration claimed to be a
--      composition dealer. A label that lies is worse than no label.
--   2. A switch INVOLVING 'isd' is retroactive and cross-cutting.
--      company_gstin_count and module_activation_date both exclude 'isd'
--      rows, and module_activation_date feeds the GST module's effective_from
--      — so re-typing an existing registration as 'isd' would move the date
--      GST became active for the company, reaching back across vouchers that
--      are already posted and already reported.
--   3. It is half of a unique key. `unique (company_id, state_code,
--      registration_type)` (0005:66) means a switch can collide with a
--      sibling row, surfacing as a raw 23505 on a field the user thinks of
--      as a dropdown.
--   4. GST law already models this correctly as a DATED event, and so does
--      this schema. Sec 10(3)/10(5) and Rule 6 make a composition<->regular
--      transition effective from a specific date, with ITC-01/ITC-03 filings
--      attached to it. The honest representation is therefore: surrender the
--      old registration with registered_to, then add the new one with its own
--      registered_from — which is a path that EXISTS FOR THE FIRST TIME as of
--      this migration, and which the date-bounded readers then get right per
--      period on their own. Making the type a free dropdown would be
--      building a worse version of something the schema can already say.
--   Set at creation (add_gst_registration already takes it, and now the form
--   actually passes it); changed only by surrender-and-re-register.
--
-- is_active
--   The undated boolean twin of registered_to, read by company_gstin_count,
--   module_activation_date and get_compliance_calendar with no date bound at
--   all. Flipping it false does not mean "stopped on this date", it means
--   "never existed" — it would retroactively move the GST module's activation
--   date off the back of already-posted vouchers. Surrender is a DATE. That
--   is the whole point of registered_to, and it is what this function
--   exposes. is_active stays where it is.
--
-- ----------------------------------------------------------------------------
-- THE SURRENDER-DATE GUARD, AND WHY IT IS NOT OPTIONAL
-- ----------------------------------------------------------------------------
-- Every registration-scoped GST report filters with
--   app_private.branch_registration(v.branch_id, v.voucher_date)
--     = p_gst_registration_id
-- (verified live in get_gstr1_table6b's own body, and the same clause is in
-- its siblings). branch_registration returns NULL when the voucher's date
-- falls outside [registered_from, registered_to]. NULL = anything is NULL,
-- so a voucher dated after the surrender date is excluded from EVERY
-- registration's return — it does not move to another one, it vanishes.
--
-- And it cannot be rescued by re-pointing the branch, because
-- branches.gst_registration_id is a single column with no history: a branch
-- reaches exactly one registration, so the date bound on branch_registration
-- can only ever EXCLUDE a voucher, never route it to a prior registration.
--
-- Which means a backdated registered_to is a silent hole in the returns.
-- This function therefore refuses one: registered_to may not precede the
-- latest posted voucher on any branch attached to this registration, and the
-- error names that voucher. A GSTIN you were still invoicing on after the
-- date you claim to have surrendered it is not a data-entry nuance, it is
-- a contradiction, and the fix is to correct one of the two.
--
-- The reverse direction is safe and is what 0005:50-52 promised: a voucher
-- dated on or before registered_to still resolves, so a surrendered
-- registration's own past periods report exactly as they did before. Proven
-- against real data before this migration was committed.
--
-- ----------------------------------------------------------------------------
-- QRMP: WHAT CHANGING filing_frequency DOES AND DOES NOT DO
-- ----------------------------------------------------------------------------
-- There is NO stored compliance calendar. get_compliance_calendar is a
-- STABLE SQL function computed on demand (confirmed live: no table in this
-- schema matching '%calendar%'), so a QRMP switch cannot leave stale or
-- duplicated rows behind — there are no rows. filing_register's rows are
-- user-entered records of filings that actually happened and are historical
-- facts a switch does not invalidate.
--
-- What it DOES do, stated plainly rather than shipped silently: both readers
-- apply the registration's CURRENT frequency to whatever period they are
-- asked about, including past ones, because the column holds one value with
-- no history.
--   * get_compliance_calendar re-labels the one period of lookback in its
--     window (one month / one quarter) on the new basis. Bounded and small.
--   * get_gstr3b_table5_1 (0225) is the consequential one: it derives a past
--     period's DUE DATE from the current frequency, so interest and late fee
--     for a period filed under the old frequency are computed against the new
--     frequency's due date. A July return filed monthly, looked at after an
--     October QRMP opt-in, is measured against the quarterly due date.
-- The correct fix is an effective-dated filing_frequency history — the same
-- shape company_modules already uses, and the platform's own standing rule
-- that capabilities are effective-dated rather than flags. That is a real
-- slice and it is named as a follow-up, not smuggled in here. Until it
-- exists, the switch is surfaced in the UI with exactly this caveat next to
-- it, so nobody flips it without being told.
--
-- ----------------------------------------------------------------------------
-- SHAPE
-- ----------------------------------------------------------------------------
-- update_gst_registration follows 1320's update_branch exactly: SECURITY
-- INVOKER so gst_registrations_write (0005:409, is_company_admin — admin
-- only) is the real backstop, with an explicit permission check on top purely
-- so the message is 'Only a company admin can...' rather than Postgres'
-- generic row-level-security violation. Constraint violations are pre-empted
-- in plain English for the same reason lib/ledgers/friendlyError.ts exists —
-- 'registered_to (31 Mar 2026) cannot be earlier than registered from
-- (1 Apr 2026)' beats 'violates check constraint
-- "gst_registrations_period_valid"'.
--
-- It is a FULL REPLACE of its four editable fields, like update_branch: the
-- form always sends all of them, so passing null clears legal_name,
-- trade_name or registered_to. filing_frequency is the one exception —
-- the column is NOT NULL, so a null there keeps the current value rather
-- than failing.
--
-- add_gst_registration is DROPPED and recreated rather than overloaded. Two
-- overloads differing only in trailing defaulted parameters make every
-- existing 4-argument named-parameter call from PostgREST ambiguous, which
-- is the exact trap 0163/1020 warn about. Verified first that there is
-- exactly one live overload and that no SQL function anywhere calls it.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. build_ewb_json — say why fromTrdName is blank
-- ----------------------------------------------------------------------------
-- Reproduced as a straight CREATE OR REPLACE of 1310's own body, which was
-- confirmed to be the live definition before this was written (the live
-- pg_get_functiondef body and 1310's differ by zero lines). Everything below
-- is 1310 verbatim except the one if/elsif block marked 1390.
--
-- The block is an if/elsif rather than a second bare `if` on purpose. The
-- trade_name lookup is a LEFT JOIN to the registration in force on the
-- voucher date, so when no registration resolves at all — branch never
-- attached, or the voucher falls outside the registered window — trade_name
-- is null for a completely different reason. Telling that preparer to "add a
-- trade name" would send them to the wrong screen with the wrong idea; they
-- get their own message naming the real problem.
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

  -- 1390 — the same silence, on a different required field. fromTrdName has
  -- been null on every payload this app has ever built, because nothing could
  -- write gst_registrations.trade_name or legal_name until now.
  if v_branch.gstin is null then
    v_warnings := v_warnings || (
      'No GST registration was in force for the branch that raised this invoice on ' ||
      to_char(v_voucher.voucher_date, 'DD Mon YYYY') || ' — fromGstin and fromTrdName below are both blank. ' ||
      'Check under GST registrations that this branch is attached to a registration whose registered-from / ' ||
      'registered-to dates cover this invoice''s date.'
    );
  elsif v_branch.trade_name is null then
    v_warnings := v_warnings || (
      'GSTIN ' || v_branch.gstin || ' has no legal name or trade name on file — fromTrdName below is blank, ' ||
      'and NIC requires it on EWB-01. Add them under GST registrations, copied exactly as they appear on the ' ||
      'GST registration certificate.'
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
  'Assembles an EWB-01-shaped JSON payload for a sales voucher from its own posted data (party/branch/GST registration/HSN lines, actual posted CGST/SGST/IGST/cess) plus ewb_details'' own transporter fields and voucher_ship_to''s own delivery address (0805). Does NOT call the NIC EWB API — this app has no GSP/direct-enrolment credentials to do so. itemList rates are reverse-derived from actually-posted tax via the same implied-tax weighting 0134''s get_gstr1_hsn_summary uses, not read off the item master''s nominal rate. meta.warnings flags a missing branch address (1310) and, since 1390, a blank fromTrdName — either because the registration carries no legal/trade name or because no registration was in force on the voucher date. build_einvoice_json refuses outright for the address gap; this one still builds but says why each from-* field is blank. Raises if the voucher is missing, deleted, or not a sales voucher.';


-- ----------------------------------------------------------------------------
-- 2. add_gst_registration — carry the names in at creation
-- ----------------------------------------------------------------------------
-- Dropped and recreated, not overloaded — see the SHAPE note in the header.
drop function if exists public.add_gst_registration(uuid, char, date, uuid, text, text);

create or replace function public.add_gst_registration(
  p_company_id uuid,
  p_gstin char(15),
  p_registered_from date,
  p_branch_id uuid default null,
  p_registration_type text default 'regular',
  p_filing_frequency text default 'monthly',
  p_legal_name text default null,
  p_trade_name text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_registration_id uuid;
  v_state char(2);
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can add a GST registration';
  end if;

  -- Pre-empted in plain English ahead of the table's own CHECK, for the same
  -- reason update_gst_registration below does it — these are dropdown values
  -- in the UI, so a violation here means a caller sent something the form
  -- cannot produce, and the raw constraint text helps nobody.
  if p_registration_type is null or p_registration_type not in
       ('regular','composition','casual','non_resident','isd','tds','tcs') then
    raise exception 'Registration type must be one of regular, composition, casual, non_resident, isd, tds or tcs — got %', coalesce(p_registration_type, 'nothing');
  end if;
  if p_filing_frequency is null or p_filing_frequency not in ('monthly','qrmp') then
    raise exception 'Filing frequency must be either monthly or qrmp — got %', coalesce(p_filing_frequency, 'nothing');
  end if;

  -- state_code is overwritten by the enforce_gstin_state trigger from the
  -- GSTIN itself; the value here is a placeholder the trigger replaces.
  insert into public.gst_registrations (
    company_id, gstin, state_code, registered_from, registration_type, filing_frequency,
    legal_name, trade_name)
  values (p_company_id, p_gstin, '00', p_registered_from, p_registration_type, p_filing_frequency,
          nullif(trim(p_legal_name), ''), nullif(trim(p_trade_name), ''))
  returning id, state_code into v_registration_id, v_state;

  perform app_private.seed_gst_ledgers(p_company_id, v_registration_id);

  if p_branch_id is not null then
    -- The FK on branches(gst_registration_id, company_id, state_code) refuses
    -- this on its own if the branch is not in the registration's state —
    -- the same guard that makes a Pune warehouse unable to sit under a
    -- Karnataka GSTIN.
    update public.branches
       set gst_registration_id = v_registration_id
     where id = p_branch_id and company_id = p_company_id;
  end if;

  return v_registration_id;
end;
$$;

revoke all on function public.add_gst_registration(uuid, char, date, uuid, text, text, text, text) from public, anon;
grant execute on function public.add_gst_registration(uuid, char, date, uuid, text, text, text, text) to authenticated;

comment on function public.add_gst_registration(uuid, char, date, uuid, text, text, text, text) is
  'Registers a GSTIN for a company, seeds its GST ledgers and tax_ledger_map rows, and optionally attaches it to a branch in the same state. Since 1390 it also carries legal_name and trade_name — the names printed on the GST registration certificate, which build_ewb_json emits as fromTrdName and which nothing could write before. registration_type and filing_frequency were always parameters here but no caller passed them; the Registrations form does now. Admin only.';


-- ----------------------------------------------------------------------------
-- 3. update_gst_registration — names, surrender date, QRMP
-- ----------------------------------------------------------------------------
create or replace function public.update_gst_registration(
  p_registration_id uuid,
  p_legal_name text default null,
  p_trade_name text default null,
  p_registered_to date default null,
  p_filing_frequency text default null
) returns void
language plpgsql
security invoker   -- RLS decides; gst_registrations_write is admin-only
set search_path = ''
as $$
declare
  v_reg record;
  v_frequency text := nullif(trim(p_filing_frequency), '');
  v_last record;
begin
  select r.id, r.company_id, r.gstin, r.registered_from, r.filing_frequency
    into v_reg
    from public.gst_registrations r
   where r.id = p_registration_id;

  if v_reg.id is null then
    raise exception 'GST registration not found';
  end if;

  if not app_private.is_company_admin(v_reg.company_id) then
    raise exception 'Only a company admin can edit a GST registration';
  end if;

  -- The column is NOT NULL, so "no value sent" means "leave it alone" here
  -- rather than the full-replace the three nullable fields get.
  v_frequency := coalesce(v_frequency, v_reg.filing_frequency);
  if v_frequency not in ('monthly', 'qrmp') then
    raise exception 'Filing frequency must be either monthly (GSTR-1 and GSTR-3B every month) or qrmp (quarterly) — got %', v_frequency;
  end if;

  if p_registered_to is not null then
    -- gst_registrations_period_valid, in words. Both dates in the message so
    -- the reader can see which one is wrong without opening another screen.
    if p_registered_to < v_reg.registered_from then
      raise exception 'The surrender date (%) cannot be earlier than the date this GSTIN was registered from (%).',
        to_char(p_registered_to, 'DD Mon YYYY'), to_char(v_reg.registered_from, 'DD Mon YYYY');
    end if;

    -- The guard the header argues for: a voucher dated after the surrender
    -- date resolves to no registration at all and drops out of every
    -- registration-scoped GST return silently.
    select v.voucher_number, v.voucher_date
      into v_last
      from public.vouchers v
      join public.branches b on b.id = v.branch_id
     where b.gst_registration_id = p_registration_id
       and not v.is_deleted
       and v.voucher_date > p_registered_to
     order by v.voucher_date desc, v.voucher_number desc
     limit 1;

    if v_last.voucher_number is not null then
      raise exception 'GSTIN % was still being used to post vouchers after % — % is dated %. A voucher dated after the surrender date would disappear from every GST return, so correct the voucher''s date or the surrender date first.',
        v_reg.gstin,
        to_char(p_registered_to, 'DD Mon YYYY'),
        v_last.voucher_number,
        to_char(v_last.voucher_date, 'DD Mon YYYY');
    end if;
  end if;

  update public.gst_registrations
     set legal_name = nullif(trim(p_legal_name), ''),
         trade_name = nullif(trim(p_trade_name), ''),
         registered_to = p_registered_to,
         filing_frequency = v_frequency
   where id = p_registration_id;
end;
$$;

revoke all on function public.update_gst_registration(uuid, text, text, date, text) from public, anon;
grant execute on function public.update_gst_registration(uuid, text, text, date, text) to authenticated;

comment on function public.update_gst_registration(uuid, text, text, date, text) is
  'Edits the four things about a GST registration that legitimately change over its life: legal_name and trade_name (the names on the registration certificate — build_ewb_json emits trade_name as fromTrdName and nothing could write it before 1390), registered_to (surrender or cancellation — a date, never a delete: vouchers dated on or before it still report in their own period exactly as before), and filing_frequency (the QRMP election). Full replace of the three nullable fields; a null filing_frequency keeps the current one because the column is NOT NULL. Refuses a registered_to that predates registered_from, or one that predates a voucher already posted on a branch under this registration — such a voucher would vanish from every registration-scoped GST return. Deliberately does NOT touch gstin, state_code, registration_type or is_active; see this migration''s header for the reasoning on each.';
