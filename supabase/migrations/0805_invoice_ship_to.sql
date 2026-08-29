-- 0805 — Bill-to / Ship-to on the invoice itself: one delivery address per voucher,
-- stored ONCE, and pointedly kept out of the place-of-supply determination.
--
-- ============================================================================
-- THE GAP THIS CLOSES
-- ============================================================================
-- "Bill it to the head office, deliver it to the site" is an ordinary trade.
-- Until now LEKHA could not record one on the invoice at all. The only
-- ship-to anywhere in the schema was public.ewb_details.ship_to_* (0190),
-- and that table is an e-Way Bill addendum: it exists to assemble an EWB-01
-- payload, it accepts SALES vouchers only (app_private.enforce_ewb_voucher
-- raises on anything else), and in practice a row is created only when the
-- consignment crosses the Rule 138 threshold. A 6,000-rupee counter sale
-- delivered to the buyer's other shop needs a delivery address on its
-- invoice and needs no e-Way Bill whatsoever; there was nowhere to put it.
--
-- That is a Rule 46 gap, not a convenience gap. CGST Rule 46 clause (o)
-- requires a tax invoice to carry the "address of delivery where the same is
-- different from the place of supply", and clause (f) requires, for an
-- UNREGISTERED recipient where the taxable value is 50,000 rupees or more,
-- the "name and address of the recipient and the address of delivery, along
-- with the name of the State and its code". Neither was recordable.
--
-- ============================================================================
-- WHY A NEW TABLE AND NOT FIVE MORE COLUMNS ON ewb_details
-- ============================================================================
-- Two candidate homes were weighed:
--
--   (a) reuse/extend public.ewb_details — rejected. It is sales-only and
--       Rule-138-shaped. Recording a delivery address there would mean
--       fabricating an "e-Way Bill record" (status 'not_generated', an
--       is_ewb_required = false consignment) for a document that will never
--       have an e-Way Bill, and would leave purchase bills, credit notes and
--       debit notes with no ship-to at all.
--
--   (b) a new one-row-per-voucher addendum — chosen, WITH the five ship_to_*
--       columns MOVED off ewb_details rather than duplicated.
--
-- The duplication risk is the whole reason for the move. Two ship-to homes on
-- one voucher is not a hypothetical drift: the EWB screen writes ewb_details
-- directly from the browser and the invoice screen would write the new table,
-- so the same sales voucher could carry "Plot 14, Andheri" on its printed
-- invoice and "Unit 7, Bhiwandi" in its EWB-01 payload, with nothing to say
-- which one the lorry followed. A cross-table CHECK cannot express that (a
-- CHECK sees one row of one table), and a pair of mirror triggers would only
-- keep two copies of one fact agreeing with each other. So instead of
-- guarding a duplicate, this migration removes it: public.voucher_ship_to is
-- the single home, ewb_details keeps only transporter/vehicle/EWB-number, and
-- the two EWB readers below (get_ewb_requirement, build_ewb_json) are
-- rewritten to source the ship-to from the new table. A contradiction is not
-- caught, it is unrepresentable.
--
-- The existing ewb_details ship-to data is carried over first — one row in
-- this database at the time of writing (Sharma Textiles HO/SAL/2026-27/00002,
-- "Ashoka Traders — Godown 2", state 27, pincode 400093), counted live rather
-- than assumed, and re-counted after the copy.
--
-- ============================================================================
-- STATUTORY RESEARCH — WHY THE SHIP-TO MUST NOT MOVE THE PLACE OF SUPPLY
-- ============================================================================
-- Section 10(1)(b) IGST Act, quoted from the CBIC tax-repository text of the
-- section as in force:
--
--   "where the goods are delivered by the supplier to a recipient or any
--    other person on the direction of a third person, whether acting as an
--    agent or otherwise, before or during movement of goods, either by way of
--    transfer of documents of title to the goods or otherwise, it shall be
--    deemed that the said third person has received the goods and the place
--    of supply of such goods shall be the principal place of business of such
--    person"
--
-- The place of supply is the THIRD PERSON's principal place of business —
-- that is, the party the invoice is billed to, the one directing the
-- delivery. It is NOT the address the goods physically travel to. Reading it
-- the other way round flips intra-state to inter-state (or back) and posts
-- the tax to the wrong head entirely: CGST+SGST where IGST was due, which is
-- not a rounding error but a wrong return, a wrong set-off chain for the
-- recipient, and interest under Sec 50 on the shortfall.
--
--   Worked example. Supplier in Maharashtra (27). Billed to a buyer whose
--   principal place of business is in Maharashtra (27). Goods despatched, on
--   that buyer's direction, to a site in Gujarat (24). Place of supply is 27
--   under 10(1)(b) => INTRA-state => CGST + SGST. The lorry crosses a state
--   line and the e-Way Bill's actToStateCode is 24, but the tax head does not
--   move with the lorry.
--
-- THE SKEPTICAL SECOND PASS, and how it resolves. Searching deliberately for
-- the opposite position finds a real and current one: CBIC Circular
-- 209/3/2024-GST (26 June 2024) says that where the delivery address recorded
-- on the invoice differs from the billing address of an UNREGISTERED person,
-- the place of supply is the DELIVERY address. Read only through a summary
-- that looks like a direct contradiction, so it was traced to the Act.
--
-- It is not a contradiction — the two provisions cover different facts, and
-- the bare statutory text settles it. Section 10(1)(ca), inserted w.e.f.
-- 1 October 2023, is the provision that circular interprets, and its own
-- non-obstante phrase reads:
--
--   "... shall, notwithstanding anything contrary contained in clause (a) or
--    clause (c), be the location as per the address of the said person
--    recorded in the invoice ..."
--
-- It overrides clause (a) and clause (c). It does NOT name clause (b), and a
-- non-obstante clause displaces only what it names. So:
--
--   * genuine bill-to/ship-to — a THIRD PERSON directs delivery to someone
--     else, two supplies in law — stays under 10(1)(b): place of supply
--     follows the bill-to party, registered or not;
--   * one unregistered buyer who simply gives a different delivery address
--     (the e-commerce fact pattern the circular addresses) is a clause
--     (a)/(ca) case with no third person at all, and there the delivery
--     address governs.
--
-- This migration therefore records the ship-to and CHANGES NOTHING about
-- place of supply. public.create_invoice already derives place_of_supply from
-- ledgers.state_code of p_party_ledger_id — the BILL-TO party — when the
-- caller supplies none; that is exactly 10(1)(b) and it was verified in place
-- before writing this, not assumed. It is untouched here, as is update_invoice.
--
-- Sources: IGST Act Sec 10(1)(a), 10(1)(b), 10(1)(ca), CBIC tax repository
-- (taxinformation.cbic.gov.in, 2017_IGST_Act chapter V section 10); CGST
-- Rules Rule 46 clauses (f), (n), (o), same repository; CBIC Circular
-- 209/3/2024-GST dated 26.06.2024.
--
-- ============================================================================
-- DELIBERATELY NOT SOLVED
-- ============================================================================
-- * No automatic place-of-supply change, ever. Recording a ship-to does not
--   touch vouchers.place_of_supply or vouchers.supply_type. See above.
-- * No second-leg invoice. In a real 10(1)(b) chain the bill-to party raises
--   its own invoice on the ship-to party; that is a separate document in a
--   separate books-set and this app does not generate it.
-- * Not extended to delivery_challan_out / job_work_out / branch_transfer
--   vouchers. Those already model their destination elsewhere
--   (delivery_challan_ewb_details.to_state_code from 0510, the job-work
--   challan's own party) and bolting a second destination onto them would
--   recreate the exact duplication this migration exists to remove.
-- * ship_to_ledger_id is a link, not a live lookup. The name/address/state
--   columns are a SNAPSHOT taken when the invoice was prepared. A party's
--   address in the master can legitimately change next year; the invoice must
--   keep printing what was actually on it. The link is kept only so the
--   preparer can see which site was picked and so a later report can group by
--   it.
-- * No pincode/GSTIN cross-validation beyond the state code. A pincode is not
--   derivable from a state code in this schema (no PIN-to-state reference
--   table exists), so claiming to validate it would be theatre.

-- ----------------------------------------------------------------------------
-- voucher_ship_to — one row per voucher, the single home for a delivery
-- address that differs from the billing address.
-- ----------------------------------------------------------------------------
create table public.voucher_ship_to (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  voucher_id uuid not null,

  -- Optional: the ship-to site is itself a party ledger (very common — a
  -- customer shipping to another of their own branches). A snapshot link,
  -- never read through at print time; see header.
  ship_to_ledger_id uuid,

  -- Rule 46(o)'s "address of delivery", and Rule 46(f)'s "name and address of
  -- the recipient and the address of delivery, along with the name of the
  -- State and its code". Name, address and state are NOT NULL because a
  -- delivery address missing any of the three fails the rule it exists to
  -- satisfy, and because ship_to_state_code is a mandatory EWB-01 field
  -- (actToStateCode) that free text cannot supply. The way to say "goods go
  -- where the bill goes" is to have no row here at all, never a half-filled
  -- one.
  ship_to_name text not null check (length(trim(ship_to_name)) > 0),
  ship_to_address text not null check (length(trim(ship_to_address)) > 0),
  ship_to_city text,
  ship_to_state_code char(2) not null references public.ref_states(code),
  ship_to_pincode text check (ship_to_pincode is null or ship_to_pincode ~ '^[1-9][0-9]{5}$'),

  -- The GSTIN of the DELIVERY location when it has one (a different
  -- registered branch of the same buyer, or an unrelated consignee). Distinct
  -- from ledgers.gstin on the party, which is always the BILL-TO GSTIN and is
  -- what decides the tax head. Null is normal.
  ship_to_gstin char(15) check (app_private.is_valid_gstin(ship_to_gstin)),

  -- default auth.uid() so attribution self-fills from the inserting user's
  -- JWT without every caller having to remember to pass it, and ON DELETE SET
  -- NULL so a removed user's historical rows survive with the attribution
  -- merely cleared. The precedent 0079/0095/0117 set and 0651 had to be
  -- written to restore after 0650 forgot it.
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  -- One delivery address per document. A consignment split across two
  -- addresses is two despatches and, in this app, two documents.
  unique (voucher_id),
  foreign key (voucher_id, company_id) references public.vouchers (id, company_id),
  foreign key (ship_to_ledger_id, company_id) references public.ledgers (id, company_id),

  -- Same reasoning as 0735 on ledgers: a GSTIN's first two characters ARE the
  -- state code, so a row claiming 27ABCDE1234F1Z5 while carrying state 07
  -- would print two different states for one delivery and feed the EWB
  -- payload a state that disagrees with the GSTIN beside it.
  constraint voucher_ship_to_gstin_matches_state check (
    ship_to_gstin is null
    or ship_to_state_code = substr(ship_to_gstin, 1, 2)
  )
);

create index voucher_ship_to_company_idx on public.voucher_ship_to (company_id);
create index voucher_ship_to_ledger_idx on public.voucher_ship_to (ship_to_ledger_id)
  where ship_to_ledger_id is not null;

comment on table public.voucher_ship_to is
  'The delivery ("ship-to") address of ONE voucher, when it differs from the billing address — CGST Rule 46(o)/(f). One row per voucher; no row means goods go where the bill goes. This is the ONLY place a ship-to is stored: 0805 moved the five ship_to_* columns off ewb_details into here so an invoice and its e-Way Bill cannot state two different delivery addresses. Recording a row here NEVER changes the voucher''s place_of_supply — under Sec 10(1)(b) IGST Act the place of supply of a bill-to/ship-to supply is the principal place of business of the third person directing the delivery, i.e. the BILL-TO party. See 0805 header.';

comment on column public.voucher_ship_to.ship_to_state_code is
  'State of the delivery address. Feeds the EWB-01 actToStateCode and Rule 46(f)''s "name of the State and its code". It is NOT the place of supply: Sec 10(1)(b) puts that at the bill-to party''s principal place of business, and nothing in this schema derives place_of_supply from this column.';

comment on column public.voucher_ship_to.ship_to_gstin is
  'GSTIN of the delivery location when it has one — a different registered branch of the same buyer, or an unrelated consignee. Never the bill-to GSTIN (that is ledgers.gstin on the party ledger), and never the basis of the intra/inter determination.';

comment on column public.voucher_ship_to.ship_to_ledger_id is
  'The party ledger the ship-to was copied from, when it was picked from the masters rather than typed. A provenance link only — the name/address/state columns beside it are a snapshot as at preparation time and are what actually print, so a later change to the ledger''s address cannot retrospectively alter an issued invoice.';

alter table public.voucher_ship_to enable row level security;

create policy voucher_ship_to_read on public.voucher_ship_to
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy voucher_ship_to_write on public.voucher_ship_to
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

-- Supabase grants anon the same DML default every new public table gets, and
-- RLS then blocks it because both policies above are `to authenticated`.
-- Taken away explicitly anyway: no signed-out caller has any business reading
-- a customer's delivery addresses, and defence in depth here costs nothing.
revoke all on table public.voucher_ship_to from anon;

-- ----------------------------------------------------------------------------
-- enforce_voucher_ship_to — the voucher-side validation the table's composite
-- FK cannot express: not deleted, and a document type that actually moves
-- goods. SECURITY DEFINER for the same reason 0119's
-- enforce_exim_shipment_voucher and 0190's enforce_ewb_voucher are: it must
-- read the voucher regardless of whether the writer happens to have a live
-- SELECT path to it.
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_voucher_ship_to()
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
    raise exception 'Cannot attach a ship-to address to a deleted voucher';
  end if;
  if v_voucher.voucher_type not in ('sales', 'purchase', 'credit_note', 'debit_note') then
    raise exception
      'A ship-to address attaches to an invoice-type voucher (sales, purchase, credit note, debit note), not a % voucher',
      v_voucher.voucher_type;
  end if;

  new.ship_to_gstin := nullif(upper(trim(new.ship_to_gstin)), '');
  new.ship_to_name := trim(new.ship_to_name);
  new.ship_to_address := trim(new.ship_to_address);
  new.ship_to_city := nullif(trim(new.ship_to_city), '');
  new.ship_to_pincode := nullif(trim(new.ship_to_pincode), '');
  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_voucher_ship_to
  before insert or update on public.voucher_ship_to
  for each row execute function app_private.enforce_voucher_ship_to();

revoke all on function app_private.enforce_voucher_ship_to() from public, anon;

comment on function app_private.enforce_voucher_ship_to() is
  'Validates voucher_ship_to.voucher_id points at a non-deleted invoice-type voucher (sales/purchase/credit_note/debit_note — see 0805 header for why delivery challans and job-work challans are excluded) in the same company, normalises the GSTIN to upper case and trims the free-text fields, and stamps updated_at.';

-- ----------------------------------------------------------------------------
-- Carry the existing ewb_details ship-to over, then drop the duplicate. Order
-- matters: copy first, verify, only then drop.
-- ----------------------------------------------------------------------------
insert into public.voucher_ship_to (
  company_id, voucher_id, ship_to_name, ship_to_address,
  ship_to_state_code, ship_to_pincode, ship_to_gstin, created_by, created_at
)
select
  e.company_id,
  e.voucher_id,
  -- A pre-0805 row could carry an address with no name, or a GSTIN with no
  -- state: the old columns were all nullable. Fill from the party ledger
  -- rather than drop the row on the floor, and fall back to a literal only
  -- where the party itself has nothing, so the NOT NULLs above hold without
  -- inventing a delivery address that was never recorded.
  coalesce(e.ship_to_name, l.name, 'Delivery address'),
  coalesce(e.ship_to_address, l.address, '(address not recorded)'),
  coalesce(e.ship_to_state_code, substr(e.ship_to_gstin, 1, 2), l.state_code),
  e.ship_to_pincode,
  e.ship_to_gstin,
  e.created_by,
  e.created_at
from public.ewb_details e
left join public.ledgers l on l.id = (select v.party_ledger_id from public.vouchers v where v.id = e.voucher_id)
where coalesce(e.ship_to_name, e.ship_to_address, e.ship_to_gstin, e.ship_to_state_code, e.ship_to_pincode) is not null
  -- Every such row must end up with a state code; one that cannot is left
  -- behind deliberately rather than given a fabricated state.
  and coalesce(e.ship_to_state_code, substr(e.ship_to_gstin, 1, 2), l.state_code) is not null
on conflict (voucher_id) do nothing;

-- Fails the migration loudly if any ship-to would have been silently lost.
do $$
declare
  v_lost integer;
begin
  select count(*) into v_lost
    from public.ewb_details e
   where coalesce(e.ship_to_name, e.ship_to_address, e.ship_to_gstin, e.ship_to_state_code, e.ship_to_pincode) is not null
     and not exists (select 1 from public.voucher_ship_to s where s.voucher_id = e.voucher_id);
  if v_lost > 0 then
    raise exception '0805: % ewb_details ship-to row(s) could not be carried over (no resolvable state code) — refusing to drop the columns', v_lost;
  end if;
end;
$$;

alter table public.ewb_details
  drop column ship_to_name,
  drop column ship_to_address,
  drop column ship_to_gstin,
  drop column ship_to_state_code,
  drop column ship_to_pincode;

comment on table public.ewb_details is
  'e-Way Bill (Rule 138 CGST Rules) addendum for a sales voucher — transporter/vehicle and the manually-captured real EWB number/validity once generated on the NIC portal or a GSP (this app makes no live EWB API call). One row per voucher (v1 scope). The ship-to no longer lives here: 0805 moved it to public.voucher_ship_to, which is invoice-level and covers documents that never get an e-Way Bill, so an invoice and its EWB payload can never state two different delivery addresses. See 0190 and 0805 headers.';

-- enforce_ewb_voucher, minus the ship_to_gstin normalisation whose column no
-- longer exists here. Everything else is byte-for-byte 0190's.
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

  if new.ewb_number is not null and new.status = 'not_generated' then
    new.status := 'generated';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function app_private.enforce_ewb_voucher() from public, anon;

comment on function app_private.enforce_ewb_voucher() is
  'Validates voucher_id points at a non-deleted sales voucher in the same company (v1 scope — see 0190 header), normalises vehicle_number/transporter_id to upper-case, and auto-promotes status to generated the moment ewb_number is filled in. The ship-to GSTIN it used to normalise moved to voucher_ship_to (0805).';

-- ----------------------------------------------------------------------------
-- get_ewb_requirement — 0510's function verbatim, SAME SIGNATURE, with one
-- change: the ship-to state now comes from voucher_ship_to instead of the
-- dropped ewb_details.ship_to_state_code. The Rule 138(1) Explanation 2
-- consignment-value arithmetic and the state-specific threshold lookup are
-- untouched.
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
    -- Ship-from = the voucher's own branch's registered state. Ship-to = the
    -- invoice's recorded delivery state (voucher_ship_to, 0805) when there is
    -- one, else the party ledger's own state. Physical movement, deliberately
    -- NOT place_of_supply: the Rule 138 threshold turns on where the lorry
    -- actually goes, which under a Sec 10(1)(b) bill-to/ship-to is exactly
    -- the state the tax head does NOT follow.
    select
      v.id as voucher_id,
      b.state_code as from_state_code,
      coalesce(st.ship_to_state_code, l.state_code) as to_state_code
    from public.vouchers v
    left join public.branches b on b.id = v.branch_id
    left join public.ledgers l on l.id = v.party_ledger_id
    left join public.voucher_ship_to st on st.voucher_id = v.id
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
  'Rule 138(1) Explanation 2 consignment-value check for one sales voucher: sum(voucher_items.amount, excluding non-taxable lines only when the voucher also carries a taxable line) + actual posted output_cgst/sgst/igst/cess (never TCS, never total_amount). threshold_amount/is_ewb_required apply the state-specific intra-state threshold (ref_state_ewb_thresholds, 0510) when ship-from and ship-to state match, falling back to the Rs 50,000 national floor otherwise. Ship-to state reads public.voucher_ship_to (0805), the single home for a delivery address. Read-only: nothing here is stored, so it can never go stale.';

-- ----------------------------------------------------------------------------
-- build_ewb_json — 0190's function verbatim, SAME SIGNATURE, with the ship-to
-- read redirected to voucher_ship_to and transactionType simplified: the mere
-- existence of a voucher_ship_to row IS the "Bill To - Ship To" case (NIC
-- transactionType 2), because that table cannot hold a half-filled address
-- the way the old nullable columns could.
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
  v_ship record;
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
  'Assembles an EWB-01-shaped JSON payload for one sales voucher, for the user to submit on the NIC portal or through a GSP — this app never calls that API. Ship-to reads public.voucher_ship_to (0805), the same row the printed invoice shows, so the document and the payload cannot state different delivery addresses. to*/actToStateCode split follows NIC: to* is the bill-to party (which is also the Sec 10(1)(b) place of supply), actToStateCode/shipTo* the physical destination.';
