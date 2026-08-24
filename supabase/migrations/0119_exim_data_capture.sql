-- ============================================================================
-- 0119 — EXIM data capture: shipping bill / BOE / BRC, and the FEMA
-- export-realisation clock
-- ============================================================================
-- The `exim` module (0004) has been registered since day one — conditional
-- on has_iec, hint text "LUT, shipping bills, BOE, landed cost,
-- realisation" — and, confirmed live just now, has zero code behind it:
--
--   select code, tier, hint from public.ref_modules where code = 'exim';
--     -> conditional, 'LUT, shipping bills, BOE, landed cost, realisation'
--   select count(*) from information_schema.tables
--    where table_schema = 'public' and table_name like 'exim%';
--     -> 0, before this migration.
--
-- NOT TO BE CONFUSED WITH `foreign_currency` (also 0004) — that module is
-- the transaction-level currency/AS 11 restatement machinery already shipped
-- at /forex (0068/0071). This migration does not touch it, or vouchers.
-- txn_currency/exchange_rate/rate_source, at all; it only reads them.
--
-- WHAT 0087 (GST zero-rated supplies) ALREADY BUILT, AND DELIBERATELY LEFT
-- OUT. 0087 added lut_number/lut_valid_from/lut_valid_to/lut_arn to
-- gst_registrations and the export_lut/export_igst/sez/deemed_export
-- supply_type routing to create_invoice — that is the TAX-COMPUTATION side
-- of an export (is IGST charged or not). Its own header explicitly listed
-- "Shipping-bill number / port code capture for exports" under "WHAT THIS
-- MIGRATION DOES NOT DO". This migration is exactly that gap: the
-- DOCUMENT-level facts (shipping bill, Bill of Entry, BRC) that get
-- attached to an export/import voucher AFTER it is posted, as a pure
-- addendum — never touching create_invoice, InvoiceForm, or how the
-- voucher itself gets created (all three are a concurrent session's
-- locked-for-this-run files besides).
--
-- THE FOUR DOCUMENTS AND WHY EACH ONE EXISTS (WebSearch'd today, sources
-- below every field's own comment):
--   - Shipping Bill: the customs export declaration. Filed on ICEGATE,
--     acknowledged with a number, date, and the port code of the customs
--     station it was filed at — a shipping-bill lookup on ICEGATE itself
--     requires all three, not just the number, because the same number can
--     recur across ports.
--   - Bill of Entry (BOE): the mirror-image customs IMPORT declaration.
--     Same three-part shape: BOE number, date, port code.
--   - Port code: 6 characters, "IN" + a 4-character facility code (e.g.
--     INNSA1 = Nhava Sheva/JNPT, INBOM4 = Mumbai air cargo). Confirmed
--     against eximpe.com's ICEGATE shipping-bill guide and Masters India's/
--     eBRC's own port-code list, both read today; both agree independently
--     on the IN+4 shape across all ~362 listed stations. Enforced here as a
--     CHECK, not just a UI hint.
--   - BRC (Bank Realisation Certificate) / eBRC: the bank-issued proof that
--     export proceeds were actually received in foreign exchange — the one
--     document that turns "goods left India" into "payment came back",
--     which is the fact FEMA cares about, not the shipment itself. Under
--     the post-2016 DGFT/RBI framework this is now electronic (eBRC): the
--     exporter's AD bank uploads an Inward Remittance Message to the DGFT
--     portal and the exporter self-certifies the mapping to a shipping
--     bill/invoice. Sourced against xflowpay's and BriskPe's 2026 eBRC
--     guides, both read today, both agree on the AD-bank-upload-then-self-
--     certify flow. BRC/eBRC is an EXPORT-side concept only — nothing
--     mirrors it for an import, so it is a CHECK-enforced no-op field pair
--     for a bill_of_entry row here, not silently ignored.
--
-- THE FEMA EXPORT-REALISATION CLOCK — THE PART THE TASK BRIEF WARNED "RBI
-- HAS REVISED THIS WINDOW BEFORE", AND IT HAS, TWICE, IN THE LAST TEN
-- MONTHS. A first search returned the "obvious" answer of a flat 9 months;
-- a second, deliberately skeptical search (independently against azb
-- Partners, EY India, corplawupdates.in and a Mondaq summary, all read
-- today, all agreeing) found it is NOT a flat constant at all right now —
-- it is a value that depends on the shipment date, because Regulation 9(1)
-- of the FEMA Export of Goods & Services Regulations has itself been
-- amended three times inside one financial year:
--
--   before 14-Nov-2025            : 9 months  (the long-standing baseline)
--   14-Nov-2025 to 04-Jun-2026    : 15 months (FEMA 23(R)/(7)/2025-RB,
--                                    13-Nov-2025 — a temporary relaxation)
--   05-Jun-2026 to 30-Sep-2026    : 9 months  (FEMA 23(R)/(8)/2026-RB,
--                                    05-Jun-2026 — reverted the relaxation;
--                                    THIS is the window today, 23-Aug-2026,
--                                    falls in, and the reason the feature
--                                    brief could correctly call it "the
--                                    9-month clock")
--   01-Oct-2026 onward            : 15 months, or 18 months for exports
--                                    invoiced/settled in INR (the new
--                                    consolidated FEMA (Export and Import
--                                    of Goods and Services) Regulations,
--                                    2026 — Notification FEMA 23(R)/2026-RB
--                                    dated 13-Jan-2026 — permanently
--                                    replacing the 2015 regulations)
--
-- Hard-coding "9 months" here would already be statutorily wrong for any
-- shipping bill dated on or after 1-Oct-2026 — five weeks after today.
-- app_private.fema_export_realisation_period() below encodes the whole
-- timeline instead of the one value that happens to be current, keyed off
-- the shipment date exactly the way the regulation itself is keyed (whoever
-- shipped under a given rule stays under that rule — realisation periods
-- are not retroactively changed for shipments already made under a prior
-- regulation). p_is_inr_settled uses the voucher's own txn_currency = 'INR'
-- as the proxy for "invoiced/settled in Indian Rupees" — the fact this app
-- already records on every voucher — which is honest but imperfect: a
-- voucher could in principle be invoiced in a foreign currency but actually
-- SETTLED in INR under the RBI Vostro mechanism (Nepal/Bhutan trade, for
-- instance), a distinction this schema has no separate field for. Stated
-- here rather than silently assumed away.
--
-- IMPORTS HAVE NO EQUIVALENT FIXED CLOCK, SO THIS SCHEMA DOES NOT INVENT
-- ONE. The same skeptical search found import payment timelines moved, in
-- the same 1-Oct-2026 regulations, from a fixed 6-month rule to "based on
-- the underlying contract between the importer and the overseas seller"
-- (AD banks may extend per their own internal policy) — i.e. no longer a
-- single number RBI prescribes at all. export_realisation_due_date is
-- therefore NULL for every bill_of_entry row, honestly, rather than a
-- fabricated date computed from a rule that no longer exists.
--
-- SCOPE, DELIBERATELY NARROW (the one-item/one-challan-per-voucher
-- discipline this codebase has applied throughout — job work 0069,
-- manufacturing 0070, batch tracking): ONE exim_shipment_details row per
-- voucher. A single export shipped as several partial consignments under
-- several shipping bills needs several sales vouchers in v1, not several
-- rows against one voucher. Worth revisiting if a real user needs
-- partial-shipment tracking against a single invoice.
--
-- NO LEDGER POSTING, NO STOCK MOVEMENT, NOTHING FOR check_voucher_balance
-- TO SATISFY. Unlike job work/manufacturing, this migration represents no
-- new physical or financial movement at all — it is pure paperwork
-- metadata bolted onto a voucher that already posted (and already balanced)
-- through the ordinary sales/purchase flow. The self-cancelling-ledger
-- pattern those two migrations had to invent is therefore not needed here
-- and is not used.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- app_private.fema_export_realisation_period — see header for the full
-- timeline and sources. IMMUTABLE (a pure function of its two inputs, no
-- table reads) so it can be used directly in the enforcement trigger below.
-- ----------------------------------------------------------------------------
create or replace function app_private.fema_export_realisation_period(
  p_shipment_date date,
  p_is_inr_settled boolean default false
)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case
    -- FEMA (Export and Import of Goods and Services) Regulations, 2026
    -- (Notification FEMA 23(R)/2026-RB, 13-Jan-2026) — in force 1-Oct-2026.
    when p_shipment_date >= date '2026-10-01' then
      case when p_is_inr_settled then interval '18 months' else interval '15 months' end
    -- FEMA 23(R)/(8)/2026-RB, 05-Jun-2026 — reverted the Nov-2025
    -- relaxation back to 9 months for shipments made in this window.
    when p_shipment_date >= date '2026-06-05' then interval '9 months'
    -- FEMA 23(R)/(7)/2025-RB, 13-Nov-2025 (effective 14-Nov-2025) —
    -- temporary relaxation from the long-standing 9-month baseline to 15.
    when p_shipment_date >= date '2025-11-14' then interval '15 months'
    -- The long-standing baseline under the 2015 Regulations (Regulation
    -- 9(1), FEMA 23(R)/2015-RB), unchanged since 2016 until Nov 2025.
    else interval '9 months'
  end;
$$;

comment on function app_private.fema_export_realisation_period(date, boolean) is
  'The FEMA Regulation 9(1) export-realisation window for a shipment made on p_shipment_date — NOT a constant, see 0119 header for the full 2025-26 timeline (9 -> 15 -> 9 -> 15/18 months across four amendments in ten months) and sources. p_is_inr_settled is a proxy read from the voucher''s own txn_currency = ''INR'', not a separately tracked fact.';

revoke all on function app_private.fema_export_realisation_period(date, boolean) from public, anon;
grant execute on function app_private.fema_export_realisation_period(date, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- exim_shipment_details — one row per sales (export) or purchase (import)
-- voucher, addendum-style.
-- ----------------------------------------------------------------------------
create table public.exim_shipment_details (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  voucher_id uuid not null,

  document_type text not null check (document_type in ('shipping_bill', 'bill_of_entry')),
  document_number text not null check (length(trim(document_number)) > 0),
  document_date date not null,
  -- "IN" + 4-character facility code — see header for sources. Stored
  -- upper-case; the trigger below also upper-cases whatever is typed in.
  port_code text not null check (port_code ~ '^IN[A-Z0-9]{4}$'),

  -- Export-side only (see header on why BRC has no import mirror). The
  -- CHECK below enforces these three stay null on a bill_of_entry row
  -- rather than silently accepting and ignoring them.
  brc_number text,
  brc_date date,
  -- Computed by the trigger below from document_date + the FEMA window
  -- current on that date — never client-supplied. Null for bill_of_entry.
  export_realisation_due_date date,
  -- When the exporter's own records (or the eBRC) confirm proceeds
  -- actually landed. Distinct from brc_date (when the certificate itself
  -- was issued) — the two are usually close but not required to match.
  realised_date date,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  -- v1 scope: one shipment record per voucher — see header.
  unique (voucher_id),
  foreign key (voucher_id, company_id) references public.vouchers (id, company_id),

  check (document_type = 'shipping_bill' or (
    brc_number is null and brc_date is null and realised_date is null and export_realisation_due_date is null
  )),
  check (brc_date is null or brc_date >= document_date),
  check (realised_date is null or realised_date >= document_date),
  check (export_realisation_due_date is null or export_realisation_due_date >= document_date)
);

create index exim_shipment_details_company_idx on public.exim_shipment_details (company_id);
-- The compliance-risk query's own access path: unrealised shipping bills
-- past due, per company.
create index exim_shipment_details_overdue_idx on public.exim_shipment_details (company_id, export_realisation_due_date)
  where document_type = 'shipping_bill' and realised_date is null;

comment on table public.exim_shipment_details is
  'Document-level EXIM addendum for a sales (export -> shipping_bill) or purchase (import -> bill_of_entry) voucher — shipping bill / BOE reference, port, and (export-side only) BRC/realisation tracking against the FEMA Regulation 9(1) clock. Never touches create_invoice, InvoiceForm, or the voucher''s own postings; one row per voucher (v1 scope). See 0119 header for the full statutory research.';

comment on column public.exim_shipment_details.port_code is
  'ICEGATE customs station code: "IN" + 4-character facility code (e.g. INNSA1 = Nhava Sheva/JNPT, INBOM4 = Mumbai air cargo). A shipping-bill/BOE lookup fails silently if this is wrong even when the document number and date are right — the port is part of the key, not a label.';

comment on column public.exim_shipment_details.export_realisation_due_date is
  'document_date + app_private.fema_export_realisation_period(document_date, ...) — computed by the enforce_exim_shipment_voucher trigger at write time, using whichever FEMA window was actually in force on that shipment date (see 0119 header). Always null for bill_of_entry: import payment timelines are contract-based, not a fixed RBI-prescribed number, since the FEMA (Export and Import of Goods and Services) Regulations, 2026.';

comment on column public.exim_shipment_details.brc_number is
  'Bank Realisation Certificate / eBRC reference — the bank-issued proof that export proceeds actually arrived in foreign exchange (the fact FEMA cares about, distinct from the shipment itself). Export-side only; null and unusable on a bill_of_entry row (enforced by CHECK).';

alter table public.exim_shipment_details enable row level security;

create policy exim_shipment_details_read on public.exim_shipment_details
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy exim_shipment_details_write on public.exim_shipment_details
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));


-- ----------------------------------------------------------------------------
-- enforce_exim_shipment_voucher — the "CHECK or a trigger validating the
-- linked voucher's type" the task brief asked for, done as a trigger
-- because it needs to read the vouchers row (a plain CHECK can't). Also
-- where export_realisation_due_date actually gets computed — see header.
-- SECURITY DEFINER, same shape as 0070's enforce_bom_output_is_stock_item,
-- so this reads the voucher regardless of RLS nuance rather than depending
-- on the writer also happening to have a live SELECT grant path to it (in
-- practice they always do, via is_company_member, but this does not lean
-- on that coincidence).
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_exim_shipment_voucher()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_voucher record;
  v_expected_document_type text;
begin
  select company_id, voucher_type, txn_currency, is_deleted
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
    raise exception 'Cannot attach EXIM shipment details to a deleted voucher';
  end if;
  if v_voucher.voucher_type not in ('sales', 'purchase') then
    raise exception 'EXIM shipment details can only be attached to a sales (export) or purchase (import) voucher, not a % voucher', v_voucher.voucher_type;
  end if;

  v_expected_document_type := case v_voucher.voucher_type
    when 'sales' then 'shipping_bill'
    when 'purchase' then 'bill_of_entry'
  end;
  if new.document_type <> v_expected_document_type then
    raise exception 'A % voucher takes a % document, not a %', v_voucher.voucher_type, v_expected_document_type, new.document_type;
  end if;

  new.port_code := upper(new.port_code);

  -- export_realisation_due_date is a system-computed field on every row
  -- (never trusted from the client even on a shipping_bill row — it is
  -- always overwritten here), so silently overwriting it is correct. BRC
  -- fields are genuine user input, by contrast — silently nulling an
  -- attempted brc_number/brc_date/realised_date on a bill_of_entry row
  -- would discard the mistake instead of surfacing it, so those three are
  -- deliberately left as the client sent them and rejected by the table's
  -- own CHECK constraint instead (a real error, not a silent no-op).
  if new.document_type = 'shipping_bill' then
    new.export_realisation_due_date :=
      new.document_date + app_private.fema_export_realisation_period(new.document_date, v_voucher.txn_currency = 'INR');
  else
    new.export_realisation_due_date := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_exim_shipment_voucher
  before insert or update on public.exim_shipment_details
  for each row execute function app_private.enforce_exim_shipment_voucher();

comment on function app_private.enforce_exim_shipment_voucher() is
  'Validates voucher_id points at a non-deleted sales/purchase voucher in the same company, matches document_type to the voucher direction (sales->shipping_bill, purchase->bill_of_entry), and (re)computes export_realisation_due_date from the FEMA window current on document_date. Runs on every insert AND update so editing document_date after the fact never leaves a stale due date.';


-- ----------------------------------------------------------------------------
-- get_exim_realisation_status — the FEMA compliance-risk view this feature
-- exists to surface, and the data source for the /exim listing screen
-- (both document types; only shipping_bill rows carry a realisation clock).
-- ----------------------------------------------------------------------------
create or replace function public.get_exim_realisation_status(
  p_company_id uuid,
  p_as_at date default current_date
)
returns table (
  shipment_id uuid,
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  party_name text,
  document_type text,
  document_number text,
  document_date date,
  port_code text,
  export_realisation_due_date date,
  brc_number text,
  brc_date date,
  realised_date date,
  is_realised boolean,
  is_overdue boolean,
  days_overdue integer,
  status text
)
language sql
stable
set search_path = ''
as $$
  select
    s.id,
    s.voucher_id,
    v.voucher_number,
    v.voucher_date,
    l.name,
    s.document_type,
    s.document_number,
    s.document_date,
    s.port_code,
    s.export_realisation_due_date,
    s.brc_number,
    s.brc_date,
    s.realised_date,
    (s.realised_date is not null) as is_realised,
    (s.document_type = 'shipping_bill' and s.realised_date is null
       and s.export_realisation_due_date < p_as_at) as is_overdue,
    case when s.document_type = 'shipping_bill' and s.realised_date is null
              and s.export_realisation_due_date < p_as_at
         then (p_as_at - s.export_realisation_due_date)::int
         else 0 end as days_overdue,
    case
      when s.document_type = 'bill_of_entry' then 'not_applicable'
      when s.realised_date is not null then 'realised'
      when s.export_realisation_due_date < p_as_at then 'overdue_unrealised'
      else 'pending'
    end as status
  from public.exim_shipment_details s
  join public.vouchers v on v.id = s.voucher_id
  left join public.ledgers l on l.id = v.party_ledger_id
  where s.company_id = p_company_id
  order by
    (s.document_type = 'shipping_bill' and s.realised_date is null and s.export_realisation_due_date < p_as_at) desc,
    s.export_realisation_due_date nulls last,
    s.document_date desc;
$$;

revoke all on function public.get_exim_realisation_status(uuid, date) from public, anon;
grant execute on function public.get_exim_realisation_status(uuid, date) to authenticated;

comment on function public.get_exim_realisation_status(uuid, date) is
  'Every EXIM shipment record for a company, both directions. status is one of realised / overdue_unrealised / pending (shipping_bill only) or not_applicable (bill_of_entry, which has no FEMA realisation clock). is_overdue/days_overdue are the specific FEMA compliance risk this feature exists to surface: an export past its Regulation 9(1) due date with no BRC/realisation recorded yet.';
