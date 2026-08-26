-- ============================================================================
-- 0190 — e-Way Bill (EWB) data capture: ship-to, transporter/vehicle,
-- the ₹50,000 threshold check, an EWB-01-conformant payload builder, and
-- manual EWB-number capture.
-- ============================================================================
-- EXPLICITLY NOT the live NIC EWB API call. Generating an e-Way Bill for
-- real requires either GSP (GST Suvidha Provider) credentials or direct
-- enrolment on ewaybillgst.gov.in as an e-Way Bill API user — this app has
-- neither. What this migration builds instead: everything a user needs to
-- prepare the NIC EWB-01 request themselves (on the portal, or via a GSP of
-- their choice) and then record the real e-Way Bill number/validity once
-- they have it. Same addendum discipline as EXIM (0119, read in full before
-- writing this) and job work (0069)/manufacturing (0070)/delivery challan
-- (0113): a sibling table keyed by voucher_id, its own screen, never
-- touching create_invoice, InvoiceForm, VoucherForm, or update_invoice.
--
-- THE ₹50,000 THRESHOLD — CONFIRMED LIVE, NOT CARRIED FROM TRAINING DATA.
-- CGST Rule 138(1): every registered person who causes movement of goods of
-- consignment value exceeding ₹50,000 must furnish EWB-01 information
-- before the movement starts, whether the movement is caused by a supply,
-- for reasons other than supply, or an inward supply from an unregistered
-- person — and, per a live 2026 search, this national ₹50,000 floor is
-- unchanged and still current. It applies to BOTH inter-state and
-- intra-state movement.
--
-- Explanation 2 to Rule 138(1) defines "consignment value" precisely, and it
-- is NOT simply the voucher's own total_amount:
--   consignment value = value under Section 15, as declared in the
--   invoice/bill of supply/delivery challan, INCLUDING CGST/SGST/IGST/cess
--   charged, EXCLUDING the value of exempt supply of goods where the same
--   invoice covers both exempt and taxable goods.
-- Two consequences this migration gets right that a naive
-- "just use total_amount" implementation would have gotten wrong (caught by
-- hand-verifying a real voucher below, not by inspection):
--   1. TCS collected under Sec 206C of the Income-tax Act is NOT part of GST
--      "value" under Section 15 (CBIC Circular 76/50/2018-GST: TCS has no
--      character of tax on the supply and is excluded from GST valuation),
--      so it must NOT be added into consignment value even though it does
--      sit inside vouchers.total_amount. get_ewb_requirement below sums
--      voucher_items.amount + the voucher's own posted
--      output_cgst/output_sgst/output_igst/output_cess only — never
--      total_amount, and never output_tcs.
--   2. "Exempt supply" in Explanation 2 is Sec 2(47) CGST Act's own defined
--      term, which itself folds in nil-rated and non-taxable supply, not
--      just whatever this app's items.supply_nature literally spells
--      'exempt'. get_ewb_requirement therefore treats
--      supply_nature <> 'taxable' (i.e. nil_rated, exempt, non_gst all
--      alike) as the excludable category, and only excludes it when the
--      SAME voucher also carries at least one truly taxable line — a
--      wholly-exempt invoice is not "mixed" and is not excluded from
--      itself.
--
-- STATE-SPECIFIC INTRA-STATE THRESHOLDS — genuinely still patchy, confirmed
-- by a second, deliberately skeptical search after the first one returned
-- the "obvious" flat ₹50,000 answer. Rule 138(1)'s own first proviso lets a
-- state government notify a DIFFERENT (generally higher) threshold for
-- intra-state movement wholly within that state. As of this search
-- (Aug 2026): Tamil Nadu, Delhi and Bihar are commonly cited as running a
-- higher ₹1,00,000 intra-state threshold; West Bengal's own notified
-- intra-state figure has itself moved more than once in recent years
-- (sources on this point genuinely disagree on the exact effective date,
-- which is itself evidence of how fast-moving and state-specific this is).
-- This schema does NOT attempt to hard-code a 36-jurisdiction threshold
-- table from search snippets of uncertain currency — that would be
-- confidently wrong somewhere. Instead: get_ewb_requirement always flags
-- against the ₹50,000 NATIONAL FLOOR, which is a deliberately
-- CONSERVATIVE (never under-inclusive) choice — an intra-state movement in
-- a state with a higher own threshold may show as "required" here when the
-- state in fact permits waiting until ₹1,00,000; it will never show as
-- "not required" when the law actually requires one. The UI says this
-- plainly rather than fabricating a state-threshold table.
--
-- THE EWB-01 SCHEMA SHAPE — cross-checked today against the mastergst.com
-- and logitax.in GSP API reference documents and the einv-apisandbox.nic.in
-- IRN-linked EWB docs (the live NIC WSDL itself needs the GSP credentials
-- this app doesn't have, so these published GSP integration references are
-- the best available substitute; all three agree independently on the same
-- field set). build_ewb_json below assembles: supplyType/subSupplyType,
-- docType/docNo/docDate, from*/to* party+address+state fields (including
-- the Bill-To vs Ship-To split — toGstin/toTrdName/toStateCode identify the
-- BILLED party, while toAddr1/toPincode/actToStateCode describe where the
-- goods actually go, which can differ, per the GSP docs' own "Bill To –
-- Ship To" transactionType=2 case), valueDetails (taxableValue/cgstValue/
-- sgstValue/igstValue/cessValue/totInvValue), transportDetails
-- (transporterId/transporterName/transDocNo/transDocDate/transMode/
-- transDistance/vehicleNo), and itemList (hsnCode/taxableAmount/
-- cgstRate/sgstRate/igstRate/cessRate per HSN group). Rates in itemList are
-- reverse-derived from the voucher's ACTUAL posted tax (the same
-- implied-tax-weighted allocation 0134's get_gstr1_hsn_summary uses for
-- HSN-wise GSTR-1 reporting), not from the item master's nominal
-- gst_rate_percent — this matters because an LUT export voucher (0087)
-- posts zero IGST despite the item carrying a nonzero gst_rate_percent, and
-- reading the rate off the item master alone would have shown a rate the
-- invoice never actually charged.
--
-- SHIP-TO vs BILL-TO — CONFIRMED THIS GENUINELY NEEDS ITS OWN FIELD, NOT
-- JUST THE PARTY LEDGER'S ADDRESS. EWB-01's transactionType field itself
-- exists to capture exactly this ("Bill To – Ship To" is one of four named
-- transaction types) — a very common real scenario is invoicing a
-- corporate HQ (bill-to) while the goods physically go to a different
-- branch/site/warehouse (ship-to) with its own PIN code and sometimes its
-- own GSTIN. This app's ledgers table (0005) has exactly ONE address per
-- party ledger — there is nowhere else in the schema a per-voucher,
-- different-from-the-ledger ship-to address could live. ewb_details'
-- ship_to_* columns are that field. NULL ship_to_* (the common case: goods
-- go to the same place as the bill) means build_ewb_json defaults to the
-- party ledger's own address and transactionType 1 (Regular); a populated
-- ship_to_* switches to transactionType 2.
--
-- TWO FIELDS ADDED BEYOND THE TASK BRIEF'S LITERAL LIST, AND WHY:
-- ship_to_state_code and ship_to_pincode. The brief's own column list named
-- ship_to_name/address/gstin; toStateCode/toPincode (or their Ship-To
-- equivalent, actToStateCode/toPincode) are themselves MANDATORY fields in
-- the EWB-01 shape every GSP reference document above lists — a payload
-- builder that is genuinely "EWB-01-schema-conformant" cannot leave them
-- unrepresentable. Free-text ship_to_address alone cannot supply a
-- machine-usable state code or PIN, so both get their own column, matching
-- the same char(2)/ref_states convention branches.state_code (0005) and
-- ledgers.state_code (0006) already use.
--
-- SCOPE, DELIBERATELY NARROW, MATCHING THE TASK BRIEF'S OWN FRAMING ("per
-- sales voucher over the threshold"). enforce_ewb_voucher below only
-- accepts a 'sales' voucher, exactly like exim_shipment_details' own
-- directional split. Rule 138 in fact also covers branch transfers,
-- delivery-challan-based job-work movement, and other non-supply
-- movements — those already have their own addendum tables (0113 delivery
-- challans, 0069 job work challans) with their own self-cancelling-ledger
-- voucher types, and wiring EWB capture onto THOSE voucher types too is a
-- real, deliberately deferred gap (see scope_deferred in the build report),
-- not silently assumed unnecessary.
--
-- ONE ROW PER VOUCHER (v1 scope, same discipline as 0119/0069/0070): a
-- single invoice's goods moving via more than one vehicle/multi-vehicle
-- Part-B is a real EWB-01 feature this schema does not model.
--
-- NO LEDGER POSTING, NO STOCK MOVEMENT, NOTHING FOR check_voucher_balance
-- TO SATISFY — pure paperwork metadata bolted onto an already-posted,
-- already-balanced sales voucher, exactly like 0119.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- ewb_details — one row per sales voucher, addendum-style.
-- ----------------------------------------------------------------------------
create table public.ewb_details (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  voucher_id uuid not null,

  -- Ship-to, distinct from the party ledger's own (bill-to) address — see
  -- header. All nullable: the common case is "goods go where the bill
  -- goes", represented by leaving these blank, not by copying the ledger's
  -- address in here.
  ship_to_name text,
  ship_to_address text,
  ship_to_gstin char(15) check (app_private.is_valid_gstin(ship_to_gstin)),
  ship_to_state_code char(2) references public.ref_states(code),
  ship_to_pincode text check (ship_to_pincode is null or ship_to_pincode ~ '^[1-9][0-9]{5}$'),

  transporter_id text check (transporter_id is null or length(transporter_id) = 15),
  transporter_name text,
  vehicle_number text,
  transport_mode text not null default 'road'
    check (transport_mode in ('road', 'rail', 'air', 'ship')),
  transport_doc_number text,
  transport_doc_date date,
  approx_distance_km integer check (approx_distance_km is null or approx_distance_km > 0),

  -- Manually captured AFTER the real e-Way Bill is generated elsewhere (NIC
  -- portal or a GSP) — this app never calls that API. timestamptz, not
  -- date, despite the task brief's own "_date" naming: EWB validity is
  -- computed by NIC to the HOUR (1 day per 200 km, expiring at midnight of
  -- the last day only when generated before a cutoff time), so a bare date
  -- would silently discard the one piece of precision that actually
  -- matters for "is this still valid right now".
  ewb_number text check (ewb_number is null or ewb_number ~ '^[0-9]{12}$'),
  ewb_generated_date timestamptz,
  ewb_valid_until timestamptz,

  status text not null default 'not_generated'
    check (status in ('not_generated', 'generated', 'cancelled')),

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  -- v1 scope: one e-Way Bill record per voucher — see header.
  unique (voucher_id),
  foreign key (voucher_id, company_id) references public.vouchers (id, company_id),

  check (status <> 'generated' or (ewb_number is not null and ewb_generated_date is not null)),
  check (ewb_valid_until is null or ewb_generated_date is null or ewb_valid_until >= ewb_generated_date)
);

create index ewb_details_company_idx on public.ewb_details (company_id);

comment on table public.ewb_details is
  'e-Way Bill (Rule 138 CGST Rules) addendum for a sales voucher — ship-to (distinct from the party ledger''s own bill-to address), transporter/vehicle, and manually-captured real EWB number/validity once generated on the NIC portal or a GSP (this app makes no live EWB API call). One row per voucher (v1 scope). See 0190 header for full statutory research.';

comment on column public.ewb_details.ship_to_gstin is
  'GSTIN of the SHIP-TO location when it differs from the billed party (e.g. goods delivered to a different branch of the same buyer) — distinct from the party ledger''s own gstin, which is always the BILL-TO GSTIN. Null when goods go where the bill goes.';

comment on column public.ewb_details.ewb_generated_date is
  'When the real e-Way Bill was generated on the NIC portal/a GSP — entered by the user AFTER the fact. Never computed or fabricated by this app.';

comment on column public.ewb_details.ewb_valid_until is
  'The real e-Way Bill''s validity expiry, as shown by NIC/the GSP at generation time — entered by the user, not computed here (NIC''s validity formula depends on cargo type and exact generation time, which this app does not have since it never calls the live API).';

alter table public.ewb_details enable row level security;

create policy ewb_details_read on public.ewb_details
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy ewb_details_write on public.ewb_details
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));


-- ----------------------------------------------------------------------------
-- enforce_ewb_voucher — validates voucher_id, restricts to 'sales' vouchers
-- (v1 scope, see header), normalises vehicle/transporter identifiers, and
-- auto-promotes status to 'generated' the moment a real ewb_number is
-- saved (the table's own CHECK independently guards the reverse: you
-- cannot claim status='generated' without a number). Same SECURITY DEFINER
-- shape as 0119's enforce_exim_shipment_voucher, for the same reason: reads
-- the voucher regardless of RLS nuance rather than depending on the writer
-- also happening to have a live SELECT path to it.
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_ewb_voucher()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_voucher record;
begin
  select company_id, voucher_type, is_deleted
    into v_voucher
    from public.vouchers
   where id = new.voucher_id;

  if v_voucher.company_id is null then
    raise exception 'Voucher % does not exist', new.voucher_id;
  end if;
  if v_voucher.company_id <> new.company_id then
    raise exception 'Voucher % does not belong to company %', new.voucher_id, new.company_id;
  end if;
  if v_voucher.is_deleted then
    raise exception 'Cannot attach e-Way Bill details to a deleted voucher';
  end if;
  if v_voucher.voucher_type <> 'sales' then
    raise exception 'e-Way Bill details can only be attached to a sales voucher in this app, not a % voucher', v_voucher.voucher_type;
  end if;

  new.vehicle_number := nullif(upper(trim(new.vehicle_number)), '');
  new.transporter_id := nullif(upper(trim(new.transporter_id)), '');
  new.ship_to_gstin := nullif(upper(trim(new.ship_to_gstin)), '');

  if new.ewb_number is not null and new.status = 'not_generated' then
    new.status := 'generated';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_ewb_voucher
  before insert or update on public.ewb_details
  for each row execute function app_private.enforce_ewb_voucher();

comment on function app_private.enforce_ewb_voucher() is
  'Validates voucher_id points at a non-deleted sales voucher in the same company (v1 scope — see 0190 header), normalises vehicle_number/transporter_id/ship_to_gstin to upper-case, and auto-promotes status to generated the moment ewb_number is filled in.';


-- ----------------------------------------------------------------------------
-- get_ewb_requirement — the read-only ₹50,000 threshold check. Reads
-- voucher_items/items/voucher_entries directly every time; nothing here is
-- stored on the voucher or duplicated into ewb_details, so it can never go
-- stale the way a cached flag would. See header for the Explanation 2
-- consignment-value formula and why it is not simply total_amount.
-- ----------------------------------------------------------------------------
create or replace function public.get_ewb_requirement(p_voucher_id uuid)
returns table (
  voucher_id uuid,
  taxable_value numeric,
  total_gst_tax numeric,
  consignment_value numeric,
  threshold_amount numeric,
  is_ewb_required boolean
)
language sql
stable
set search_path = ''
as $$
  with mix as (
    -- Whether this voucher's own lines mix a truly taxable item with a
    -- nil-rated/exempt/non-GST one — Explanation 2 only excludes the
    -- latter's value when BOTH are present on the same document.
    select
      vi.voucher_id,
      bool_or(i.supply_nature = 'taxable') as has_taxable,
      bool_or(i.supply_nature <> 'taxable') as has_non_taxable
    from public.voucher_items vi
    join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
    where vi.voucher_id = p_voucher_id
    group by vi.voucher_id
  ),
  lines as (
    select
      vi.voucher_id,
      sum(
        case
          when m.has_taxable and m.has_non_taxable and i.supply_nature <> 'taxable' then 0
          else vi.amount
        end
      ) as value_for_consignment
    from public.voucher_items vi
    join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
    join mix m on m.voucher_id = vi.voucher_id
    where vi.voucher_id = p_voucher_id
    group by vi.voucher_id
  ),
  tax as (
    -- Actual posted CGST/SGST/IGST/cess only — never TCS, never a rounding
    -- or other ledger line. See header, point 1.
    select
      e.voucher_id,
      sum(case when t.purpose in ('output_cgst', 'output_sgst', 'output_igst', 'output_cess')
               then e.credit_amount - e.debit_amount else 0 end) as total_gst_tax
    from public.voucher_entries e
    join public.tax_ledger_map t on t.ledger_id = e.ledger_id and t.company_id = e.company_id
    where e.voucher_id = p_voucher_id
    group by e.voucher_id
  )
  select
    v.id,
    coalesce(l.value_for_consignment, 0) as taxable_value,
    coalesce(tx.total_gst_tax, 0) as total_gst_tax,
    coalesce(l.value_for_consignment, 0) + coalesce(tx.total_gst_tax, 0) as consignment_value,
    50000::numeric as threshold_amount,
    (coalesce(l.value_for_consignment, 0) + coalesce(tx.total_gst_tax, 0)) > 50000 as is_ewb_required
  from public.vouchers v
  left join lines l on l.voucher_id = v.id
  left join tax tx on tx.voucher_id = v.id
  where v.id = p_voucher_id
    and not v.is_deleted;
$$;

revoke all on function public.get_ewb_requirement(uuid) from public, anon;
grant execute on function public.get_ewb_requirement(uuid) to authenticated;

comment on function public.get_ewb_requirement(uuid) is
  'Rule 138(1) Explanation 2 consignment-value check for one voucher: sum(voucher_items.amount, excluding non-taxable lines only when the voucher also carries a taxable line) + actual posted output_cgst/sgst/igst/cess (never TCS, never total_amount). is_ewb_required flags against the national ₹50,000 floor only — some states set a higher intra-state threshold this function does not model (deliberately conservative, see 0190 header). Read-only: nothing here is stored, so it can never go stale.';


-- ----------------------------------------------------------------------------
-- get_ewb_status — the per-company hub listing: every sales voucher that
-- either requires an e-Way Bill (get_ewb_requirement) or already has an
-- ewb_details row (so a below-threshold voucher someone started capturing
-- anyway still shows up).
-- ----------------------------------------------------------------------------
create or replace function public.get_ewb_status(p_company_id uuid)
returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  party_name text,
  consignment_value numeric,
  is_ewb_required boolean,
  ewb_id uuid,
  transport_mode text,
  vehicle_number text,
  ewb_number text,
  ewb_generated_date timestamptz,
  ewb_valid_until timestamptz,
  status text
)
language sql
stable
set search_path = ''
as $$
  select
    v.id,
    v.voucher_number,
    v.voucher_date,
    l.name,
    req.consignment_value,
    req.is_ewb_required,
    ed.id,
    ed.transport_mode,
    ed.vehicle_number,
    ed.ewb_number,
    ed.ewb_generated_date,
    ed.ewb_valid_until,
    case
      when ed.status is not null then ed.status
      when req.is_ewb_required then 'pending'
      else 'not_required'
    end as status
  from public.vouchers v
  join lateral public.get_ewb_requirement(v.id) req on true
  left join public.ledgers l on l.id = v.party_ledger_id
  left join public.ewb_details ed on ed.voucher_id = v.id
  where v.company_id = p_company_id
    and v.voucher_type = 'sales'
    and not v.is_deleted
    and (req.is_ewb_required or ed.id is not null)
  order by
    (case when ed.status is not null then ed.status else (case when req.is_ewb_required then 'pending' else 'z' end) end) = 'pending' desc,
    v.voucher_date desc, v.voucher_number desc;
$$;

revoke all on function public.get_ewb_status(uuid) from public, anon;
grant execute on function public.get_ewb_status(uuid) to authenticated;

comment on function public.get_ewb_status(uuid) is
  'Every sales voucher for a company that is over the ₹50,000 Rule 138 threshold (get_ewb_requirement) or already has an ewb_details row. status is not_required / pending (required, nothing captured yet) / not_generated (capture started, no EWB number yet) / generated / cancelled.';


-- ----------------------------------------------------------------------------
-- build_ewb_json — assembles the EWB-01 request shape from the voucher's
-- own posted data plus ewb_details' own fields. See header for field-shape
-- sourcing and the implied-tax-weighted rate derivation.
-- ----------------------------------------------------------------------------
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
  v_ewb record;
  v_req record;
  v_tax record;
  v_items jsonb;
  v_supply_inter boolean;
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

  select l.name, l.gstin, l.address, l.city, l.pincode, l.state_code
    into v_party
    from public.ledgers l
   where l.id = v_voucher.party_ledger_id;

  select e.id, e.ship_to_name, e.ship_to_address, e.ship_to_gstin, e.ship_to_state_code, e.ship_to_pincode,
         e.transporter_id, e.transporter_name, e.vehicle_number, e.transport_mode,
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

  -- inter-state whenever the branch's own registered state differs from
  -- the actual ship-to state (falling back to the party ledger's state
  -- when no ship-to override is recorded) — the same test the tax engine
  -- (0018) itself applies, re-derived here from state codes rather than
  -- trusted from supply_type alone, since supply_type also carries the
  -- export/SEZ/deemed-export routing values which are inter-state for EWB
  -- purposes regardless of place_of_supply's literal state code.
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
    -- Rates reverse-derived from the voucher's ACTUAL posted tax, weighted
    -- by each HSN group's own implied tax share — same method as 0134's
    -- get_gstr1_hsn_summary, and for the same reason: an LUT export posts
    -- zero IGST regardless of the item master's nominal gst_rate_percent,
    -- so reading the rate off the item master directly would misstate what
    -- was actually charged.
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
      'schemaBasis', 'NIC EWB-01 field shape, cross-checked against published GSP integration references (mastergst.com, logitax.in) — see 0190 migration header'
    ),
    'supplyType', 'O',
    'subSupplyType', '1',
    'transactionType', case when v_ewb.id is not null and (v_ewb.ship_to_name is not null or v_ewb.ship_to_address is not null or v_ewb.ship_to_gstin is not null) then 2 else 1 end,
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
    'toGstin', v_party.gstin,
    'toTrdName', v_party.name,
    'toStateCode', v_party.state_code,
    'toAddr1', coalesce(v_ewb.ship_to_address, v_party.address),
    'toPlace', v_party.city,
    'toPincode', coalesce(v_ewb.ship_to_pincode, v_party.pincode),
    'actToStateCode', coalesce(v_ewb.ship_to_state_code, v_party.state_code),
    'shipToName', v_ewb.ship_to_name,
    'shipToGstin', v_ewb.ship_to_gstin,
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
  'Assembles an EWB-01-shaped JSON payload for a sales voucher from its own posted data (party/branch/GST registration/HSN lines, actual posted CGST/SGST/IGST/cess) plus ewb_details'' own ship-to/transporter fields. Does NOT call the NIC EWB API — this app has no GSP/direct-enrolment credentials to do so. itemList rates are reverse-derived from actually-posted tax via the same implied-tax weighting 0134''s get_gstr1_hsn_summary uses, not read off the item master''s nominal rate. Raises if the voucher is missing, deleted, or not a sales voucher.';
