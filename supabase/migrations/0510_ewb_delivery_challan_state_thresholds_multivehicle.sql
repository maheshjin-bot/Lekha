-- ============================================================================
-- 0500 — e-Way Bill: closing three gaps 0190 named in its own scope_deferred
-- ============================================================================
-- 0190 shipped EWB capture for exactly one voucher type ('sales') and flagged
-- three things it deliberately did not do. This migration is those three
-- things, bundled because all three sit inside the same ewb_details/
-- eway-bill feature area and would collide as separate migrations:
--
--   1. EWB capture for delivery challans (Rule 138 also covers "reasons
--      other than supply" and branch/godown transfer, not just sales).
--   2. State-specific intra-state EWB thresholds, replacing 0190's
--      deliberately-conservative flat national-floor check.
--   3. Multi-vehicle Part-B history (trans-shipment) on an existing
--      ewb_details row.
--
-- ----------------------------------------------------------------------------
-- (1) DELIVERY CHALLANS — WHICH VOUCHER TYPE ACTUALLY NEEDS THIS
-- ----------------------------------------------------------------------------
-- The task brief that led to this migration named two non-sales movements
-- Rule 138 covers: delivery challans (0113) and "inter-godown or branch
-- stock transfers (the branch_transfer voucher type)". Checked live before
-- writing a line of this file:
--
--   select voucher_type, count(*) from public.vouchers group by voucher_type;
--     -> branch_transfer: NOT PRESENT. Zero rows, in any company, ever.
--
-- 'branch_transfer' is a voucher_type value the original 0007 voucher-type
-- CHECK constraint has carried since day one, but this codebase has never
-- shipped a dedicated creation path for it (VoucherForm.tsx's generic entry
-- screen is the only route, and it is off-limits to this batch besides).
-- The REAL branch/godown-transfer flow a user actually reaches in this app
-- is delivery_challans with purpose = 'branch_transfer' (0113 already gives
-- that its own destination_branch_id, its own numbering series
-- 'delivery_challan_out', and its own UI at /delivery-challans) — 0113's own
-- header confirms this is deliberately how inter-branch stock movement
-- within one GST registration is modelled here. So giving delivery_challans
-- an EWB linkage, which this migration does, covers the real branch-transfer
-- traffic this app has. A raw voucher_type = 'branch_transfer' row, reached
-- only through the locked-for-this-batch generic voucher form and carrying
-- no voucher_items/HSN/quantity data to build an EWB payload FROM in the
-- first place, stays unlinked — named here, not silently assumed
-- unnecessary (see scope_deferred in the build report for the fuller case).
--
-- delivery_challan_ewb_details MIRRORS ewb_details' OWN SHAPE (ship-to/
-- transporter/vehicle/EWB-number/status), NOT NEW COLUMNS ON
-- delivery_challans ITSELF. Two reasons: (a) delivery_challans is a
-- concurrently-live table this batch explicitly protects — "additive
-- columns or sibling tables only" for its core posting logic — and adding
-- six-plus nullable columns via ALTER TABLE to a table other agents may be
-- reading this same run is exactly the kind of touch a sibling table avoids
-- needing to reason about; (b) it is the same addendum discipline every
-- other EWB/EXIM/job-work/manufacturing feature in this codebase already
-- uses (0069, 0070, 0113, 0119, 0190) — a dedicated table keyed by the
-- parent id, never a widening ALTER on the parent.
--
-- DELIVERY-CHALLAN EWB-01 PAYLOAD SHAPE — RESEARCHED, NOT GUESSED FROM THE
-- TASK BRIEF'S OWN "docType OTH or similar" hint. Fetched and read in full:
-- the NIC EWB-API Technical Document (docs.ewaybillgst.gov.in, "EWB-API
-- Technical Document for Tax Payers/Transporters/GSPs", the primary NIC
-- source, not a tax-prep blog), Annexure B (Master Codes) and Annexure D
-- (the actual JSON Schema draft-04 enum). Both independently list docType's
-- allowed values as exactly: INV, CHL, BIL, BOE, CNT, OTH — with CHL
-- explicitly glossed "Delivery Challan". OTH is "Others", a genuinely
-- different, more residual value. The task brief's own guess ("docType OTH
-- or similar") was WRONG — the brief asked for it to be verified rather
-- than assumed, and it does not survive that check. build_delivery_
-- challan_ewb_json below sets docType = 'CHL', not 'OTH'.
--
-- supplyType = 'O' always: a delivery challan in this app is only ever a
-- DISPATCH — create_delivery_challan (0113) creates exactly one voucher_type,
-- 'delivery_challan_out', with no '_in' counterpart (0113's own header says
-- so explicitly). There is no inward delivery-challan movement this schema
-- represents, so supplyType never needs to be 'I'.
--
-- subSupplyType — mapped from delivery_challans.purpose against the SAME
-- NIC master-code list (Annexure B): 1 Supply, 2 Import, 3 Export, 4 Job
-- Work, 5 For Own Use, 6 Job work Returns, 7 Sales Return, 8 Others,
-- 9 SKD/CKD, 10 Line Sales, 11 Recipient Not Known, 12 Exhibition or Fairs.
-- Cross-checked against three practitioner guides (teachoo.com, authbridge
-- and getswipe's own e-way-bill explainers) for the two purposes that do
-- NOT map onto an obviously-named code:
--   'skd_ckd'         -> 9  (SKD/CKD)              — exact name match.
--   'exhibition'       -> 12 (Exhibition or Fairs)   — exact name match.
--   'branch_transfer'  -> 5  (For Own Use)           — inter-branch stock
--     movement for the registered person's own business use, not a supply
--     to any third party; this is the mapping getswipe's and cleartax's own
--     e-way-bill transaction-type guides give for inter-branch transfer.
--   'approval'         -> 8  (Others)  — "sale on approval" has NO dedicated
--     NIC code; authbridge's and getswipe's guides both independently group
--     it under the residual "Others"/"non-supply, other reasons" bucket.
--   'sale_or_return'   -> 8  (Others)  — same residual bucket. Deliberately
--     NOT code 7 "Sales Return": that code is for goods being returned
--     BACK to their origin, the mirror-image movement to what this purpose
--     represents (goods going OUT on a sale-or-return basis, decision still
--     pending) — mapping it to "Sales Return" would describe the wrong leg
--     of the transaction.
--   'repair'           -> 8  (Others)  — no dedicated code; same guides
--     group "sent for repair" under the residual bucket too.
--   'other'            -> 8  (Others)  — matches the app's own escape hatch.
-- Sources: docs.ewaybillgst.gov.in EWB-API Technical Document Annexure B;
-- teachoo.com "Different Sub-Types of E-Way Bills"; authbridge.com
-- "E-Way Bill for Return Goods"; getswipe.in "Transaction Types in E-Way
-- Bills". All four read today.
--
-- NO TAX VALUES ON MOST CHALLANS, AND THAT IS THE HONEST STATE, NOT A GAP —
-- exactly the same point 0113's own header already established for the
-- printed document: gst_rate_percent is null on a same-GSTIN branch
-- transfer or any movement where no supply has occurred, and the EWB JSON
-- below carries zero cgstValue/sgstValue/igstValue/cessValue in that case,
-- reusing the EXACT SAME quantity_sent * rate * gst_rate_percent / (2 or 1)
-- / 100 formula 0113's own get_delivery_challans already computes live (not
-- re-derived differently here — see build_delivery_challan_ewb_json).
--
-- ----------------------------------------------------------------------------
-- (2) STATE-SPECIFIC INTRA-STATE THRESHOLDS
-- ----------------------------------------------------------------------------
-- 0190 flagged this as a real gap and chose the conservative flat ₹50,000
-- floor rather than fabricate a 36-jurisdiction table from search snippets
-- of uncertain currency. This migration does the actual research the task
-- brief asked for: Tamil Nadu, Delhi, Bihar, West Bengal and Kerala at
-- minimum, each traced with a first pass and then a deliberately skeptical
-- second pass, not taken from a single tax-prep blog's summary table.
--
-- TAMIL NADU — ₹1,00,000 intra-state, effective 2 June 2018. First pass
-- (mybillbook, busy.in, tallysolutions) and second pass (rtsprofessional
-- study.com, cleartax.in) agree on both the figure and the effective date.
-- cleartax cites the underlying notification as issued by the Commissioner
-- of State Tax, Tamil Nadu under clause (d) of sub-rule 14 of Rule 138 TNGST
-- Rules 2017 (cleartax names it "Notification No. 09, dated 31 May 2018" —
-- see the Bihar note below for why that specific citation should be read
-- with caution).
--
-- DELHI — ₹1,00,000 intra-state (intra-Delhi movement not passing through
-- any other state), effective 16 June 2018. Corroborated independently by
-- taxguru.in (which quotes the notification's own operative line verbatim:
-- "no e-Way Bill ... shall be required where the consignment value does not
-- exceed Rs.1,00,000") and teamleaseregtech.com, and again by cleartax
-- (citing "Notification No. 03, dated 15 June 2018"). All UNREGISTERED-
-- consumer supplies within Delhi accompanied by a Sec 31 invoice are
-- separately exempt regardless of value — a finer-grained exemption this
-- state-level table does not attempt to model (see "what this table does
-- NOT model" below).
--
-- BIHAR — ₹1,00,000 intra-state. CONFIRMED FIGURE, BUT THE UNDERLYING
-- NOTIFICATION CITATION GENUINELY DISAGREES ACROSS SOURCES, exactly the
-- kind of thing the task brief warned to expect and trace rather than
-- paper over: busy.in/mybillbook cite "Notification No. 09, dated 31 May
-- 2018"; cleartax.in cites a DIFFERENT reference, "Notification No. S.O.
-- 14, dated 14 Jan 2019, effective 21 Jan 2019" — for the SAME state and
-- the SAME ₹1,00,000 figure. Both cannot be the operative notification
-- number simultaneously. This migration records the ₹1,00,000 AMOUNT (three
-- independent aggregator sources agree on the figure itself) but flags the
-- notification citation as disputed in source_reference rather than picking
-- whichever one sounds more authoritative — the honest position given no
-- access to the Bihar Commercial Tax Department's own gazette archive to
-- adjudicate it directly.
--
-- WEST BENGAL — DELIBERATELY NOT GIVEN AN OVERRIDE ROW, AND THIS IS ITSELF
-- THE FINDING, NOT AN OMISSION. West Bengal's threshold has moved more than
-- once: cleartax/cashfree (writing before mid-2026) describe a reduction
-- from ₹1,00,000 to ₹50,000 effective 1 Dec 2023 (Notification No. 2/2023).
-- A second, independently-sourced batch of 2026-dated reporting (taxguru,
-- knnindia, jurishour.in, a2ztaxcorp.net — four outlets, all citing the SAME
-- notification number and date) says West Bengal's threshold stood at
-- ₹1,00,000 again more recently and was cut BACK to ₹50,000 via
-- Notification No. 02/2026-C.T./GST dated 22 May 2026 (Commissioner of
-- State Tax, West Bengal, under Rule 138(14) WBGST Rules 2017), effective
-- 1 June 2026, with a clarificatory Trade Circular on 25 May 2026 — job-work
-- movements stay exempt regardless. Whatever the exact history in between,
-- BOTH accounts agree on the number that matters for this table: as of
-- today (Aug 2026), West Bengal's intra-state threshold is ₹50,000 — i.e.
-- IDENTICAL to the national floor get_ewb_requirement already applies. An
-- override row that says "50000" would be a silent no-op carrying a real
-- risk: it would look authoritative and then go stale the next time West
-- Bengal's own number moves, without anyone noticing it had become a
-- redundant duplicate of the floor rather than a real override. Left out
-- deliberately; this paragraph is the record of having checked.
--
-- KERALA — DELIBERATELY NOT GIVEN AN OVERRIDE ROW. Kerala's GENERAL
-- intra-state threshold is ₹50,000 (rtsprofessionalstudy.com, busy.in,
-- cashfree.com all agree) — again identical to the national floor, so no
-- override row is needed. Kerala DOES have a real, confirmed, but
-- ITEM-SPECIFIC override: intra-state movement of gold and precious stones
-- valued at ₹10,00,000 or more requires an e-Way Bill regardless of the
-- general floor (Kerala GST Dept notifications of 27 Dec 2024, 8 Jan 2025
-- and 17 Jan 2025, effective 20 Jan 2025 — taxguru.in, a2ztaxcorp.net).
-- ref_state_ewb_thresholds below is keyed by state alone and cannot
-- represent a threshold that depends on WHAT is being moved, only on WHERE
-- — modelling that correctly would need an item/HSN dimension this table
-- does not have. Named here as a real, confirmed gap rather than silently
-- dropped or wrongly folded into a flat Kerala row that would misstate
-- every non-gold Kerala shipment.
--
-- THREE MORE STATES, ADDED BEYOND THE BRIEF'S "AT MINIMUM" LIST BECAUSE
-- THEY CROSS-VALIDATED CLEANLY. Punjab, Jharkhand and Maharashtra each show
-- the same ₹1,00,000 intra-state figure, stable and unchanged since 2018,
-- independently corroborated across two unrelated aggregators (busy.in and
-- cashfree.com agree on all three with no internal disagreement, unlike
-- Bihar/West Bengal above) with no evidence of the notification-churn seen
-- in West Bengal. Included with lower individual citation confidence than
-- TN/Delhi (no verbatim notification text was located for any of the
-- three, only consistent aggregator agreement), flagged as such in each
-- row's source_reference.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT MODEL: (a) item/goods-specific
-- overrides (Kerala gold, and several states' own exemption lists for
-- specified-goods categories) — a state-only key cannot represent these;
-- (b) sub-state geographic carve-outs (Rajasthan's own further concession
-- to ₹2,00,000 for movement wholly within one city; Madhya Pradesh's "no
-- EWB within the same district" rule) — granularity below what
-- get_ewb_requirement's state-code comparison can express; (c) exemptions
-- keyed to the RECIPIENT's registration status (Delhi's unregistered-
-- consumer carve-out above) rather than to value. All three are real,
-- named gaps, not silent omissions — get_ewb_requirement's fallback to the
-- ₹50,000 national floor for every state not listed here remains, as 0190
-- chose, deliberately conservative: it can flag a movement as required
-- slightly earlier than a state's own fuller rule strictly demands, never
-- later.
--
-- ----------------------------------------------------------------------------
-- (3) MULTI-VEHICLE PART-B HISTORY
-- ----------------------------------------------------------------------------
-- Confirmed against the same NIC EWB-API Technical Document (section 7,
-- "UPDATE PART-B/VEHICLE NUMBER - API", and its own Annexure A3/master
-- ReasonCode list) that trans-shipment onto a second (or third...) vehicle
-- mid-journey is a REAL, named NIC workflow, not a hypothetical: the
-- "Vehicle Update Reason Code" master list is exactly four values —
-- 1 Due to Break Down, 2 Due to Transhipment, 3 Others, 4 First Time — and
-- the live "Get e-Way Bill" response shape itself carries a
-- "VehiclListDetails" ARRAY, confirming NIC's own data model already
-- expects more than one update per EWB. ewb_vehicle_updates below is that
-- same append-only history, scoped to ewb_details (the sales-voucher EWB
-- table this migration's own task named "the per-voucher EWB screen" for),
-- not to the new delivery-challan EWB table — see scope_deferred in the
-- build report for why that extension is named but not built today.
-- Inserting a row also refreshes ewb_details.vehicle_number to the newest
-- value via a trigger, so the existing "current vehicle" field on the
-- parent (and every screen that already reads it, unchanged) stays
-- accurate at a glance while the child table keeps the full trail.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- ref_state_ewb_thresholds — one row per state that has a CONFIRMED,
-- currently-effective intra-state Rule 138 threshold different from the
-- ₹50,000 national floor. Absence of a row means "no confirmed override —
-- use the national floor," which is the correct reading for most of
-- India's states/UTs, not missing data. Same global-reference-table
-- discipline as ref_states/ref_entity_types/statutory_rules (0002):
-- authenticated-readable, writable by nobody through the API — a rate
-- change is a migration, not a client write.
-- ----------------------------------------------------------------------------
create table public.ref_state_ewb_thresholds (
  state_code char(2) primary key references public.ref_states(code),
  intra_state_threshold_amount numeric(12, 2) not null
    check (intra_state_threshold_amount > 0),
  effective_from date,
  source_reference text not null,
  notes text
);

comment on table public.ref_state_ewb_thresholds is
  'CGST Rule 138(1) first proviso: states may notify their own, usually higher, threshold for e-Way Bill on intra-state movement wholly within that state. Rows here are confirmed overrides only — a state with no row here uses the national ₹50,000 floor, which is the correct reading for most states, not a gap. See 0500 migration header for the full per-state research trail and what this table deliberately does not model (item-specific and sub-state-geography overrides).';

insert into public.ref_state_ewb_thresholds
  (state_code, intra_state_threshold_amount, effective_from, source_reference, notes)
values
  ('33', 100000.00, '2018-06-02',
   'Tamil Nadu Commissioner of State Tax, under Rule 138(14)/clause (d) sub-rule 14 TNGST Rules 2017. Cross-checked: mybillbook.in, busy.in, tallysolutions.com (2026), rtsprofessionalstudy.com, cleartax.in (2026) — all agree on amount and effective date.',
   null),
  ('07', 100000.00, '2018-06-16',
   'Delhi GST Dept notification (cleartax.in cites "Notification No. 03, dated 15 June 2018"), effective 16 June 2018, for intra-Delhi movement not passing through any other state. taxguru.in quotes the notification''s own operative text verbatim; teamleaseregtech.com and cleartax.in independently corroborate the amount and date.',
   'A separate, narrower Delhi exemption (any value, unregistered-consumer supply with a Sec 31 invoice) is NOT modelled by this state-level table — see 0500 migration header.'),
  ('10', 100000.00, null,
   'Amount corroborated by three independent aggregators (busy.in, mybillbook.in, cleartax.in). Underlying notification citation is DISPUTED between sources: busy.in/mybillbook cite "Notification No. 09, dated 31 May 2018"; cleartax.in cites "Notification No. S.O. 14, dated 14 Jan 2019, effective 21 Jan 2019" — for the same state and figure. effective_from deliberately left null rather than pick one unverified date over the other; see 0500 migration header.',
   'Notification citation genuinely disputed across sources — amount itself is not.'),
  ('03', 100000.00, null,
   'Punjab: cross-checked busy.in and cashfree.com, both agreeing on Rs 1,00,000 with no internal disagreement (unlike Bihar). Neither source quotes the underlying notification number/date; effective_from left null accordingly. Lower individual-citation confidence than Tamil Nadu/Delhi, noted explicitly.',
   null),
  ('20', 100000.00, null,
   'Jharkhand: cross-checked busy.in and cashfree.com, both agreeing on Rs 1,00,000. Same caveat as Punjab — no notification number/date located, effective_from left null.',
   null),
  ('27', 100000.00, null,
   'Maharashtra: cross-checked busy.in and cashfree.com, both agreeing on Rs 1,00,000. Same caveat as Punjab/Jharkhand — no notification number/date located, effective_from left null.',
   null);

alter table public.ref_state_ewb_thresholds enable row level security;

create policy ref_state_ewb_thresholds_read on public.ref_state_ewb_thresholds
  for select to authenticated using (true);

-- No insert/update/delete policy — with RLS enabled this denies every
-- non-superuser write, matching 0002's ref_states/ref_entity_types.


-- ----------------------------------------------------------------------------
-- app_private.get_ewb_threshold_for_states — the shared threshold lookup,
-- used by both get_ewb_requirement (sales vouchers, below) and
-- get_delivery_challan_ewb_requirement (delivery challans, below), so the
-- override-vs-floor decision lives in exactly one place. Returns the
-- state's own confirmed intra-state threshold when the movement is
-- genuinely intra-state (both state codes given and equal) and a row
-- exists for that state; the ₹50,000 national floor otherwise — including
-- when either state code is unknown, which is the same "cannot prove an
-- override applies, so use the conservative floor" stance 0190 already
-- took for the whole table before this migration existed.
-- ----------------------------------------------------------------------------
create or replace function app_private.get_ewb_threshold_for_states(
  p_from_state_code char(2),
  p_to_state_code char(2)
) returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select t.intra_state_threshold_amount
       from public.ref_state_ewb_thresholds t
      where p_from_state_code is not null
        and p_to_state_code is not null
        and p_from_state_code = p_to_state_code
        and t.state_code = p_from_state_code),
    50000::numeric
  );
$$;

revoke all on function app_private.get_ewb_threshold_for_states(char, char) from public, anon;
grant execute on function app_private.get_ewb_threshold_for_states(char, char) to authenticated;

comment on function app_private.get_ewb_threshold_for_states(char, char) is
  'Rule 138(1) first proviso lookup: the confirmed state-specific intra-state EWB threshold when p_from_state_code = p_to_state_code and ref_state_ewb_thresholds has a row for it, else the Rs 50,000 national floor (including whenever either state is unknown/null — the conservative default).';


-- ----------------------------------------------------------------------------
-- get_ewb_requirement — CREATE OR REPLACE of 0190's own function, SAME
-- SIGNATURE, now applying a state-specific threshold instead of the flat
-- ₹50,000. Everything else (the Explanation 2 consignment-value formula:
-- taxable lines + actual posted CGST/SGST/IGST/cess, excluding TCS and,
-- on a mixed invoice, exempt/nil-rated lines) is UNCHANGED from 0190 — only
-- the threshold_amount/is_ewb_required comparison changes. Ship-from state
-- is the voucher's own branch (branches.state_code, same column
-- build_ewb_json already reads); ship-to state is ewb_details.
-- ship_to_state_code when a capture row already exists and set it, else the
-- party ledger's own state_code — the exact same fallback build_ewb_json
-- already uses for toStateCode/actToStateCode, so this reads no field the
-- rest of the feature was not already treating as authoritative.
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
    -- or other ledger line. See 0190 header, point 1.
    select
      e.voucher_id,
      sum(case when t.purpose in ('output_cgst', 'output_sgst', 'output_igst', 'output_cess')
               then e.credit_amount - e.debit_amount else 0 end) as total_gst_tax
    from public.voucher_entries e
    join public.tax_ledger_map t on t.ledger_id = e.ledger_id and t.company_id = e.company_id
    where e.voucher_id = p_voucher_id
    group by e.voucher_id
  ),
  states as (
    -- Ship-from = the voucher's own branch's registered state. Ship-to =
    -- an already-captured ship_to_state_code override, else the party
    -- ledger's own state — same fallback build_ewb_json (0190) already
    -- uses for toStateCode.
    select
      v.id as voucher_id,
      b.state_code as from_state_code,
      coalesce(ed.ship_to_state_code, l.state_code) as to_state_code
    from public.vouchers v
    left join public.branches b on b.id = v.branch_id
    left join public.ledgers l on l.id = v.party_ledger_id
    left join public.ewb_details ed on ed.voucher_id = v.id
    where v.id = p_voucher_id
  )
  select
    v.id,
    coalesce(l.value_for_consignment, 0) as taxable_value,
    coalesce(tx.total_gst_tax, 0) as total_gst_tax,
    coalesce(l.value_for_consignment, 0) + coalesce(tx.total_gst_tax, 0) as consignment_value,
    app_private.get_ewb_threshold_for_states(s.from_state_code, s.to_state_code) as threshold_amount,
    (coalesce(l.value_for_consignment, 0) + coalesce(tx.total_gst_tax, 0))
      > app_private.get_ewb_threshold_for_states(s.from_state_code, s.to_state_code) as is_ewb_required
  from public.vouchers v
  left join lines l on l.voucher_id = v.id
  left join tax tx on tx.voucher_id = v.id
  left join states s on s.voucher_id = v.id
  where v.id = p_voucher_id
    and not v.is_deleted;
$$;

revoke all on function public.get_ewb_requirement(uuid) from public, anon;
grant execute on function public.get_ewb_requirement(uuid) to authenticated;

comment on function public.get_ewb_requirement(uuid) is
  'Rule 138(1) Explanation 2 consignment-value check for one sales voucher: sum(voucher_items.amount, excluding non-taxable lines only when the voucher also carries a taxable line) + actual posted output_cgst/sgst/igst/cess (never TCS, never total_amount). threshold_amount/is_ewb_required now apply a confirmed state-specific intra-state threshold (ref_state_ewb_thresholds, 0500) when ship-from and ship-to state match, falling back to the Rs 50,000 national floor otherwise — see 0500 migration header for the per-state research. Read-only: nothing here is stored, so it can never go stale.';


-- ----------------------------------------------------------------------------
-- delivery_challan_ewb_details — one row per delivery challan, addendum-
-- style, mirroring ewb_details' own shape. See migration header for the
-- design rationale (sibling table, not new columns on delivery_challans).
-- ----------------------------------------------------------------------------
create table public.delivery_challan_ewb_details (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  challan_id uuid not null,

  -- Destination state/pincode OVERRIDE. Usually unnecessary: the challan's
  -- own voucher already carries place_of_supply, computed at creation time
  -- by create_delivery_challan (0113) from whichever party identification
  -- the challan actually has (party ledger's state, or the destination
  -- branch's own registered state for branch_transfer) — this migration's
  -- build_delivery_challan_ewb_json reads that column directly rather than
  -- re-deriving it. These two columns exist only for the residual case
  -- place_of_supply itself could not resolve (a free-text party_name/
  -- party_address with no ledger, or GST not active for the company at the
  -- challan date) — the same "toStateCode/toPincode are mandatory EWB-01
  -- fields; a free-text address alone cannot supply them" reasoning 0190
  -- used for ewb_details.ship_to_state_code/ship_to_pincode.
  to_state_code char(2) references public.ref_states(code),
  to_pincode text check (to_pincode is null or to_pincode ~ '^[1-9][0-9]{5}$'),

  transporter_id text check (transporter_id is null or length(transporter_id) = 15),
  transporter_name text,
  vehicle_number text,
  transport_mode text not null default 'road'
    check (transport_mode in ('road', 'rail', 'air', 'ship')),
  transport_doc_number text,
  transport_doc_date date,
  approx_distance_km integer check (approx_distance_km is null or approx_distance_km > 0),

  -- Manually captured after the real e-Way Bill is generated elsewhere —
  -- this app makes no live NIC/GSP API call, same as ewb_details (0190).
  ewb_number text check (ewb_number is null or ewb_number ~ '^[0-9]{12}$'),
  ewb_generated_date timestamptz,
  ewb_valid_until timestamptz,

  status text not null default 'not_generated'
    check (status in ('not_generated', 'generated', 'cancelled')),

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  -- v1 scope, same as ewb_details: one e-Way Bill record per challan.
  unique (challan_id),
  foreign key (challan_id, company_id) references public.delivery_challans (id, company_id),

  check (status <> 'generated' or (ewb_number is not null and ewb_generated_date is not null)),
  check (ewb_valid_until is null or ewb_generated_date is null or ewb_valid_until >= ewb_generated_date)
);

create index delivery_challan_ewb_details_company_idx on public.delivery_challan_ewb_details (company_id);

comment on table public.delivery_challan_ewb_details is
  'e-Way Bill (Rule 138 CGST Rules) addendum for a delivery challan (0113) — the "reasons other than supply" / branch-transfer movements sales EWB (ewb_details, 0190) does not cover. Mirrors ewb_details'' own shape. One row per challan (v1 scope). See 0500 migration header for the docType=CHL / subSupplyType-from-purpose research.';

alter table public.delivery_challan_ewb_details enable row level security;

create policy delivery_challan_ewb_details_read on public.delivery_challan_ewb_details
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy delivery_challan_ewb_details_write on public.delivery_challan_ewb_details
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));


-- ----------------------------------------------------------------------------
-- enforce_delivery_challan_ewb — validates challan_id, normalises
-- identifiers, auto-promotes status. Same shape as 0190's
-- enforce_ewb_voucher. The composite FK already guarantees company_id
-- matches the challan's own — this trigger's real job is normalisation and
-- the status auto-promotion, not tenant validation (that part is
-- belt-and-braces, matching the existing 0190 pattern rather than assuming
-- the FK alone is self-documenting).
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_delivery_challan_ewb()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_challan record;
begin
  select company_id into v_challan
    from public.delivery_challans
   where id = new.challan_id;

  if v_challan.company_id is null then
    raise exception 'Delivery challan % does not exist', new.challan_id;
  end if;
  if v_challan.company_id <> new.company_id then
    raise exception 'Delivery challan % does not belong to company %', new.challan_id, new.company_id;
  end if;

  new.vehicle_number := nullif(upper(trim(new.vehicle_number)), '');
  new.transporter_id := nullif(upper(trim(new.transporter_id)), '');

  if new.ewb_number is not null and new.status = 'not_generated' then
    new.status := 'generated';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_delivery_challan_ewb
  before insert or update on public.delivery_challan_ewb_details
  for each row execute function app_private.enforce_delivery_challan_ewb();

comment on function app_private.enforce_delivery_challan_ewb() is
  'Validates challan_id points at an existing delivery challan in the same company, normalises vehicle_number/transporter_id to upper-case, and auto-promotes status to generated the moment ewb_number is filled in. Mirrors 0190''s enforce_ewb_voucher.';


-- ----------------------------------------------------------------------------
-- get_delivery_challan_ewb_requirement — the read-only threshold check for
-- one challan, mirroring get_ewb_requirement's shape. Consignment value
-- reuses the EXACT SAME formula get_delivery_challans (0113) already
-- computes live for the printed document (quantity_sent * rate, plus
-- quantity_sent * rate * gst_rate_percent / 100 when a rate is shown) —
-- not re-derived differently here. Threshold applies the same state-aware
-- lookup as get_ewb_requirement, reading the challan's own voucher's
-- place_of_supply (already computed by create_delivery_challan, 0113) as
-- ship-to state rather than re-deriving it from the party/destination
-- branch a second time.
-- ----------------------------------------------------------------------------
create or replace function public.get_delivery_challan_ewb_requirement(p_challan_id uuid)
returns table (
  challan_id uuid,
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
  select
    c.id,
    round(c.quantity_sent * c.rate, 2) as taxable_value,
    case when c.gst_rate_percent is not null
      then round(c.quantity_sent * c.rate * c.gst_rate_percent / 100, 2) else 0 end as total_gst_tax,
    round(c.quantity_sent * c.rate, 2)
      + (case when c.gst_rate_percent is not null
           then round(c.quantity_sent * c.rate * c.gst_rate_percent / 100, 2) else 0 end)
      as consignment_value,
    app_private.get_ewb_threshold_for_states(b.state_code, v.place_of_supply) as threshold_amount,
    (round(c.quantity_sent * c.rate, 2)
      + (case when c.gst_rate_percent is not null
           then round(c.quantity_sent * c.rate * c.gst_rate_percent / 100, 2) else 0 end))
      > app_private.get_ewb_threshold_for_states(b.state_code, v.place_of_supply) as is_ewb_required
  from public.delivery_challans c
  join public.vouchers v on v.id = c.voucher_id
  left join public.branches b on b.id = c.branch_id
  where c.id = p_challan_id;
$$;

revoke all on function public.get_delivery_challan_ewb_requirement(uuid) from public, anon;
grant execute on function public.get_delivery_challan_ewb_requirement(uuid) to authenticated;

comment on function public.get_delivery_challan_ewb_requirement(uuid) is
  'Rule 138(1) consignment-value check for one delivery challan (0113): quantity_sent * rate, plus tax at gst_rate_percent when shown (zero for the honest no-tax case). threshold_amount applies the same state-specific-else-national-floor lookup as get_ewb_requirement (0500), reading the challan''s own place_of_supply as ship-to state.';


-- ----------------------------------------------------------------------------
-- get_delivery_challan_ewb_status — per-company hub listing, mirroring
-- get_ewb_status (0190).
-- ----------------------------------------------------------------------------
create or replace function public.get_delivery_challan_ewb_status(p_company_id uuid)
returns table (
  challan_id uuid,
  challan_number text,
  challan_date date,
  purpose text,
  party_display text,
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
    c.id,
    v.voucher_number,
    c.challan_date,
    c.purpose,
    coalesce(l.name, c.party_name, b.name),
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
  from public.delivery_challans c
  join public.vouchers v on v.id = c.voucher_id
  join lateral public.get_delivery_challan_ewb_requirement(c.id) req on true
  left join public.ledgers l on l.id = c.party_ledger_id
  left join public.branches b on b.id = c.destination_branch_id
  left join public.delivery_challan_ewb_details ed on ed.challan_id = c.id
  where c.company_id = p_company_id
    and (req.is_ewb_required or ed.id is not null)
  order by
    (case when ed.status is not null then ed.status else (case when req.is_ewb_required then 'pending' else 'z' end) end) = 'pending' desc,
    c.challan_date desc;
$$;

revoke all on function public.get_delivery_challan_ewb_status(uuid) from public, anon;
grant execute on function public.get_delivery_challan_ewb_status(uuid) to authenticated;

comment on function public.get_delivery_challan_ewb_status(uuid) is
  'Every delivery challan for a company that is over its Rule 138 threshold (get_delivery_challan_ewb_requirement) or already has a delivery_challan_ewb_details row. Mirrors get_ewb_status (0190).';


-- ----------------------------------------------------------------------------
-- build_delivery_challan_ewb_json — assembles the EWB-01 request shape for
-- a delivery challan. See migration header for docType/subSupplyType
-- sourcing. No invoice, no bill-to/ship-to split, no HSN-rate reverse-
-- derivation (a challan carries exactly one item at one flat
-- gst_rate_percent already, unlike a multi-line invoice) — genuinely
-- simpler than build_ewb_json (0190), not a stripped-down copy of it.
-- ----------------------------------------------------------------------------
create or replace function public.build_delivery_challan_ewb_json(p_challan_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_challan record;
  v_voucher record;
  v_branch record;
  -- Individual scalars, not a `record` — the free-text-party branch below
  -- assigns fields one at a time rather than via SELECT INTO, and a bare
  -- `record` variable has no known structure until its first SELECT INTO
  -- (confirmed live: PL/pgSQL error 55000 "record v_party is not assigned
  -- yet" when this was a record and the free-text branch ran first).
  v_party_name text;
  v_party_gstin text;
  v_party_address text;
  v_party_city text;
  v_party_pincode text;
  v_party_state_code text;
  v_ewb record;
  v_req record;
  v_sub_supply_type text;
begin
  select c.id, c.company_id, c.branch_id, c.voucher_id, c.purpose,
         c.party_ledger_id, c.party_name, c.party_address, c.destination_branch_id,
         c.item_id, c.quantity_sent, c.uom, c.rate, c.gst_rate_percent,
         c.challan_date
    into v_challan
    from public.delivery_challans c
   where c.id = p_challan_id;

  if v_challan.id is null then
    raise exception 'Delivery challan % not found', p_challan_id;
  end if;

  select v.voucher_number, v.voucher_date, v.place_of_supply, v.supply_type
    into v_voucher
    from public.vouchers v
   where v.id = v_challan.voucher_id;

  select b.state_code, b.address_line1, b.address_line2, b.city, b.pincode,
         r.gstin, coalesce(r.trade_name, r.legal_name) as trade_name
    into v_branch
    from public.branches b
    left join public.gst_registrations r on r.id = app_private.branch_registration(b.id, v_challan.challan_date)
   where b.id = v_challan.branch_id;

  -- "To" party: an existing ledger, or the destination branch's own
  -- registration (branch_transfer), or free-text party_name/party_address
  -- with no structured address at all.
  if v_challan.party_ledger_id is not null then
    select l.name, l.gstin, l.address, l.city, l.pincode, l.state_code
      into v_party_name, v_party_gstin, v_party_address, v_party_city, v_party_pincode, v_party_state_code
      from public.ledgers l
     where l.id = v_challan.party_ledger_id;
  elsif v_challan.destination_branch_id is not null then
    select coalesce(r.trade_name, r.legal_name), r.gstin,
           db.address_line1, db.city, db.pincode, db.state_code
      into v_party_name, v_party_gstin, v_party_address, v_party_city, v_party_pincode, v_party_state_code
      from public.branches db
      left join public.gst_registrations r on r.id = app_private.branch_registration(db.id, v_challan.challan_date)
     where db.id = v_challan.destination_branch_id;
  else
    v_party_name := v_challan.party_name;
    v_party_gstin := null;
    v_party_address := v_challan.party_address;
    v_party_city := null;
    v_party_pincode := null;
    v_party_state_code := null;
  end if;

  select e.id, e.to_state_code, e.to_pincode, e.transporter_id, e.transporter_name,
         e.vehicle_number, e.transport_mode, e.transport_doc_number, e.transport_doc_date,
         e.approx_distance_km, e.ewb_number, e.ewb_generated_date, e.ewb_valid_until, e.status
    into v_ewb
    from public.delivery_challan_ewb_details e
   where e.challan_id = p_challan_id;

  select * into v_req from public.get_delivery_challan_ewb_requirement(p_challan_id);

  -- subSupplyType — see migration header for the full purpose -> code
  -- mapping and its sourcing.
  v_sub_supply_type := case v_challan.purpose
    when 'skd_ckd' then '9'
    when 'exhibition' then '12'
    when 'branch_transfer' then '5'
    else '8'
  end;

  return jsonb_build_object(
    'meta', jsonb_build_object(
      'builtBy', 'LEKHA build_delivery_challan_ewb_json — offline payload builder, no NIC API call made',
      'challanId', v_challan.id,
      'schemaBasis', 'NIC EWB-API Technical Document (docs.ewaybillgst.gov.in), Annexure B master codes and Annexure D JSON Schema — see 0500 migration header'
    ),
    'supplyType', 'O',
    'subSupplyType', v_sub_supply_type,
    'docType', 'CHL',
    'docNo', v_voucher.voucher_number,
    'docDate', to_char(v_voucher.voucher_date, 'DD/MM/YYYY'),
    'fromGstin', v_branch.gstin,
    'fromTrdName', v_branch.trade_name,
    'fromAddr1', v_branch.address_line1,
    'fromAddr2', v_branch.address_line2,
    'fromPlace', v_branch.city,
    'fromPincode', v_branch.pincode,
    'fromStateCode', v_branch.state_code,
    'toGstin', v_party_gstin,
    'toTrdName', v_party_name,
    'toAddr1', v_party_address,
    'toPlace', v_party_city,
    'toPincode', coalesce(v_ewb.to_pincode, v_party_pincode),
    'toStateCode', coalesce(v_ewb.to_state_code, v_voucher.place_of_supply, v_party_state_code),
    'totalValue', round(coalesce(v_req.taxable_value, 0), 2),
    'cgstValue', case when v_voucher.supply_type = 'intra' then round(coalesce(v_req.total_gst_tax, 0) / 2, 2) else 0 end,
    'sgstValue', case when v_voucher.supply_type = 'intra' then round(coalesce(v_req.total_gst_tax, 0) / 2, 2) else 0 end,
    'igstValue', case when v_voucher.supply_type = 'inter' then round(coalesce(v_req.total_gst_tax, 0), 2) else 0 end,
    'cessValue', 0,
    'transporterId', v_ewb.transporter_id,
    'transporterName', v_ewb.transporter_name,
    'transMode', case v_ewb.transport_mode when 'road' then '1' when 'rail' then '2' when 'air' then '3' when 'ship' then '4' else null end,
    'transDistance', v_ewb.approx_distance_km,
    'transDocNo', v_ewb.transport_doc_number,
    'transDocDate', case when v_ewb.transport_doc_date is not null then to_char(v_ewb.transport_doc_date, 'DD/MM/YYYY') else null end,
    'vehicleNo', v_ewb.vehicle_number,
    'itemList', jsonb_build_array(jsonb_build_object(
      'hsnCode', (select coalesce(vi.hsn_sac, i.hsn_sac, '(no HSN/SAC)')
                    from public.items i
                    left join public.voucher_items vi on vi.item_id = i.id and vi.voucher_id = v_challan.voucher_id
                   where i.id = v_challan.item_id),
      'qtyUnit', v_challan.uom,
      'quantity', v_challan.quantity_sent,
      'taxableAmount', round(coalesce(v_req.taxable_value, 0), 2),
      'cgstRate', case when v_voucher.supply_type = 'intra' and v_challan.gst_rate_percent is not null then round(v_challan.gst_rate_percent / 2, 2) else 0 end,
      'sgstRate', case when v_voucher.supply_type = 'intra' and v_challan.gst_rate_percent is not null then round(v_challan.gst_rate_percent / 2, 2) else 0 end,
      'igstRate', case when v_voucher.supply_type = 'inter' and v_challan.gst_rate_percent is not null then v_challan.gst_rate_percent else 0 end,
      'cessRate', 0
    )),
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

revoke all on function public.build_delivery_challan_ewb_json(uuid) from public, anon;
grant execute on function public.build_delivery_challan_ewb_json(uuid) to authenticated;

comment on function public.build_delivery_challan_ewb_json(uuid) is
  'Assembles an EWB-01-shaped JSON payload for a delivery challan (0113) — docType=CHL, subSupplyType derived from the challan''s own purpose (see 0500 migration header for the mapping and its sourcing against the NIC EWB-API Technical Document). No invoice or bill-to/ship-to split involved, unlike build_ewb_json (0190) for a sales voucher. Does NOT call the NIC EWB API.';


-- ----------------------------------------------------------------------------
-- ewb_vehicle_updates — multi-vehicle Part-B history for an ewb_details
-- row. Append-only: each row is one real vehicle-change event during the
-- goods' journey (trans-shipment), oldest-first by updated_at. See
-- migration header for why this is scoped to ewb_details (sales vouchers)
-- and not the new delivery-challan EWB table.
-- ----------------------------------------------------------------------------
create table public.ewb_vehicle_updates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  ewb_detail_id uuid not null,

  vehicle_number text not null,
  -- NIC's own "Vehicle Update Reason Code" master list (Annexure B of the
  -- EWB-API Technical Document) — 4 values. 'first_time' names NIC's own
  -- 4th code but is not expected to be used here in practice: the FIRST
  -- vehicle is already ewb_details.vehicle_number itself (captured at
  -- generation, never as a row in this table) — this table only ever
  -- records a CHANGE after that.
  reason_code text check (reason_code in ('breakdown', 'transhipment', 'other', 'first_time')),
  reason text,
  updated_at timestamptz not null default now(),

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (ewb_detail_id, company_id) references public.ewb_details (id, company_id)
);

create index ewb_vehicle_updates_ewb_detail_idx on public.ewb_vehicle_updates (ewb_detail_id, updated_at);

comment on table public.ewb_vehicle_updates is
  'Append-only Part-B vehicle-change history for one ewb_details row — a real, NIC-modelled trans-shipment workflow (see 0500 migration header, citing the EWB-API Technical Document''s own Update Vehicle API and VehiclListDetails array). Oldest-first by updated_at. Does not include the FIRST vehicle, which lives on ewb_details.vehicle_number itself.';

alter table public.ewb_vehicle_updates enable row level security;

create policy ewb_vehicle_updates_read on public.ewb_vehicle_updates
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy ewb_vehicle_updates_write on public.ewb_vehicle_updates
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));


-- ----------------------------------------------------------------------------
-- enforce_ewb_vehicle_update — normalises vehicle_number, defaults
-- created_by. The composite FK already guarantees company_id matches the
-- parent ewb_details row's own company.
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_ewb_vehicle_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.vehicle_number := upper(trim(new.vehicle_number));
  if new.vehicle_number = '' then
    raise exception 'vehicle_number is required';
  end if;
  return new;
end;
$$;

create trigger enforce_ewb_vehicle_update
  before insert on public.ewb_vehicle_updates
  for each row execute function app_private.enforce_ewb_vehicle_update();

comment on function app_private.enforce_ewb_vehicle_update() is
  'Normalises vehicle_number to upper-case and rejects a blank one. Composite FK (ewb_detail_id, company_id) already enforces the tenant match.';


-- ----------------------------------------------------------------------------
-- sync_ewb_vehicle_to_parent — keeps ewb_details.vehicle_number (the
-- "current" vehicle every existing screen already reads) equal to the
-- latest ewb_vehicle_updates row, so this feature is additive to every
-- reader of ewb_details.vehicle_number rather than making that column
-- stale the moment a second vehicle enters the picture. SECURITY DEFINER,
-- like 0190's own enforce_ewb_voucher: it writes a DIFFERENT table than the
-- one the trigger fires on, and should not depend on the inserting role
-- also happening to have a live UPDATE path to that other table (true here
-- via can_write_company on the same company, but not a fact this trigger
-- should have to assume).
-- ----------------------------------------------------------------------------
create or replace function app_private.sync_ewb_vehicle_to_parent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ewb_details
     set vehicle_number = new.vehicle_number,
         updated_at = now()
   where id = new.ewb_detail_id
     and (vehicle_number is distinct from new.vehicle_number);
  return new;
end;
$$;

create trigger sync_ewb_vehicle_to_parent
  after insert on public.ewb_vehicle_updates
  for each row execute function app_private.sync_ewb_vehicle_to_parent();

comment on function app_private.sync_ewb_vehicle_to_parent() is
  'After a new vehicle-update row, refreshes the parent ewb_details.vehicle_number to match — the "current vehicle" field every existing screen already reads stays accurate without those screens needing to know ewb_vehicle_updates exists.';
