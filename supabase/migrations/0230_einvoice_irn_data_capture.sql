-- ============================================================================
-- 0230 — e-Invoice (IRN) data capture: applicability check, NIC-schema JSON
--         payload builder, and manual IRN/QR recording
-- ============================================================================
-- EXPLICITLY NOT the actual API call to an Invoice Registration Portal (IRP).
-- Submitting to the real IRP needs either NIC's own e-invoice API (which
-- requires the taxpayer to be whitelisted and API-onboarded on the GST
-- portal) or a paid GSP (GST Suvidha Provider) contract — this app has
-- neither. What IS genuinely buildable without one, and is what this
-- migration builds: (1) whether e-invoicing applies to this company at all,
-- from its own turnover history, (2) a NIC-schema-conformant JSON payload
-- assembled from a voucher this app already posted, for the user to review
-- and paste into whatever GSP portal or offline utility they actually use,
-- and (3) somewhere to record the IRN/QR/acknowledgement once obtained
-- elsewhere. Same split every prior "half-buildable" statutory feature in
-- this codebase has drawn (ITC-04 prep, 0072; Tally export, 0146-adjacent).
--
-- ADDENDUM PATTERN, per the task brief and modelled directly on
-- exim_shipment_details (0119): a sibling table keyed by voucher_id, its own
-- small screen reached from the sales invoice / sales return lists, NEVER
-- touching InvoiceForm, create_invoice or update_invoice. Read 0119 in full
-- before this file for the structural precedent this follows.
--
-- WHO E-INVOICING APPLIES TO — AATO THRESHOLD, CONFIRMED LIVE TODAY
-- (26 Aug 2026), WITH A SECOND, DELIBERATELY SKEPTICAL SEARCH, BECAUSE THIS
-- THRESHOLD HAS BEEN LOWERED REPEATEDLY AND "5 crore" LOOKS LIKE THE KIND OF
-- "obvious" FIGURE THAT TURNS OUT STALE.
--   Current threshold: Aggregate Annual Turnover (AATO) exceeding Rs 5 crore
--   (Rs 5,00,00,000) in ANY financial year from 2017-18 onward. Set by CBIC
--   Notification 10/2023-Central Tax (10 May 2023), effective 1 August 2023
--   — the most recent of several step-downs (from Rs 500cr at go-live in
--   Oct 2020, down through 100cr, 50cr, 20cr, 10cr, to 5cr). A first search
--   (aiaccountant.com, xflowpay.com, gimbooks.com, tallysolutions.com, all
--   read today) uniformly gives Rs 5 crore as still current for FY 2026-27,
--   with no notified further reduction. A second, skeptical search
--   specifically hunting for a MORE RECENT cut (lexology.com's Notification
--   10/2023 writeup, taxguru.in, cgstjaipur.gov.in's own CBIC notification
--   digest, all read today) confirms the same figure and same effective
--   date, and explicitly notes discussion of a further cut to Rs 1 crore or
--   universal applicability at GST Council level, NOT YET NOTIFIED as of
--   today. Rs 5,00,00,000 is therefore encoded below, not carried over
--   unverified from training data.
--
--   PERMANENT ONCE CROSSED: crossing the threshold in any one FY makes
--   e-invoicing mandatory from then on, even if a later year's turnover
--   falls back below it — confirmed by the same sources, consistent with
--   how every GST turnover-slab trigger in this codebase already behaves
--   (44AB tax audit, GST registration itself). get_einvoice_applicability
--   below reports the EARLIEST completed FY that crossed the line, and
--   is_applicable stays true forever after that, by construction.
--
--   SCOPE OF WHAT E-INVOICING COVERS: B2B (registered-recipient) supplies,
--   exports, SEZ supplies and deemed exports — NOT B2C (unregistered-
--   recipient) domestic retail. get_einvoice_status below only lists
--   vouchers that fall in the covered set; a genuine B2C sale is correctly
--   never offered a "Generate e-invoice JSON" action, and build_einvoice_json
--   raises a named exception rather than silently building a payload for one.
--
--   TURNOVER SOURCE: this app has no PAN-wide, taxability-classified
--   Sec 2(6) CGST Act turnover figure to read directly. The closest
--   schema-native proxy — same one 0155's own get_gstr9c_turnover_
--   reconciliation already uses and documents for the same reason — is
--   summing every ledger under this company's direct_income account-group
--   nature (get_profit_and_loss) for the FY: GST always posts to separate
--   tax ledgers (0018's own header), so this figure is already tax-
--   exclusive, and it already includes exempt/zero-rated/export supplies
--   since the trading ledger entry equals the taxable value regardless of
--   the rate actually charged (including nil). This is an approximation,
--   stated as one in the function's own `note` output, not a literal
--   Sec 2(6) computation (which is PAN-wide across every GSTIN, a scope
--   this single-company-at-a-time function does not attempt).
--
--   GST'S OWN FINANCIAL YEAR IS FIXED 1 APRIL - 31 MARCH, INDEPENDENT OF
--   THIS COMPANY'S BOOKS financial_year_start_month — this is the exact
--   trap 0180 (GST TDS/TCS suffered, same session) already documented and
--   guarded against for the identical reason: GST return periods and GST
--   turnover slabs are always calendar-April-anchored by Sec 2(56) CGST Act
--   via the General Clauses Act, never the entity's own accounting year. A
--   company on a July-June book year (the demo-data convention per 0001's
--   own comment, chosen specifically to catch this class of bug) would get
--   its AATO test silently misaligned by up to 9 months if this reused
--   app_private.fy_start_date/fy_end_date (which key off the COMPANY's
--   configurable start month) instead of a hardcoded April boundary. Fixed
--   April/March dates are used throughout below, not that helper.
--
-- NIC E-INVOICE SCHEMA (schema is public at einvoice1.gst.gov.in; the
-- underlying reference used here — docs.cleartax.in's e-Invoice Object page,
-- read today, cross-checked against busy.in's and gimbooks.com's own field
-- breakdowns, all three agreeing on section/field names, mandatory/optional
-- status and data-type bounds):
--   Version, TranDtls{TaxSch,SupTyp,RegRev}, DocDtls{Typ,No,Dt},
--   SellerDtls{Gstin,LglNm,TrdNm,Addr1,Addr2,Loc,Pin,Stcd}, BuyerDtls{same
--   shape + Pos}, ItemList[]{SlNo,PrdDesc,IsServc,HsnCd,Qty,Unit,UnitPrice,
--   TotAmt,Discount,AssAmt,GstRt,CgstAmt,SgstAmt,IgstAmt,CesAmt,TotItemVal},
--   ValDtls{AssVal,CgstVal,SgstVal,IgstVal,CesVal,RndOffAmt,TotInvVal,TotInvValFc},
--   ExpDtls (conditional, exports only){ShipBNo,ShipBDt,Port,RefClm,ForCur,
--   CntCode}. DocDtls.Typ is one of INV/CRN/DBN; TranDtls.SupTyp is one of
--   B2B/SEZWP/SEZWOP/EXPWP/EXPWOP/DEXP (confirmed via a second search
--   specifically for these enum values, taxonation.com/vayana GSP docs
--   agreeing). Response-side fields once an IRN is actually obtained
--   elsewhere: Irn (64 lower-case hex characters, a SHA-256 hash — confirmed
--   length and charset via cleartax.in's own IRN explainer), AckNo (numeric,
--   IRP's own sequential transaction reference), AckDt, SignedQRCode (a
--   compact JWS token, short enough to be designed for printing as a QR).
--
--   RULE 46(b) CGST RULES — DocDtls.No (the invoice number itself) MUST be
--   at most 16 characters, letters/digits/hyphen/slash only. THIS APP'S OWN
--   VOUCHER NUMBERING SCHEME (branch-code/type-code/FY-label/padded-serial,
--   e.g. "HO/SAL/2025-26/00001" — 21 characters) DOES NOT FIT THIS LIMIT.
--   Deliberately NOT worked around here by silently truncating or
--   reformatting the number that is actually printed on the legal invoice —
--   that would make the JSON payload disagree with the real document. The
--   /einvoice screen instead runs this exact check client-side and shows a
--   loud warning banner naming the violation, so a user renumbering their
--   voucher series is an informed choice they make, not something this
--   migration makes for them. Documented again in scope_deferred.
--
--   HSN DIGIT COUNT — the e-invoice schema wants HsnCd 6-8 characters, but
--   items.hsn_sac (0013) allows 4-8 digits (a 4-digit HSN is valid for
--   GSTR-1 purposes below the 5cr turnover slab under Notification
--   78/2020-CT, but not for e-invoicing once the SAME threshold is crossed).
--   Not enforced by a new CHECK here (items.hsn_sac is shared by every
--   report and this migration does not own item-master validation) — the
--   /einvoice screen flags any item with fewer than 6 digits the same way
--   it flags an oversized voucher number.
--
--   EXPORT DESTINATION COUNTRY — ExpDtls.CntCode (2-letter ISO country code)
--   is mandatory on the real schema whenever SupTyp is EXPWP/EXPWOP, and
--   THIS APP HAS NO COUNTRY FIELD ANYWHERE (not on ledgers, not on
--   gst_registrations, not on exim_shipment_details) to source it from.
--   build_einvoice_json still emits ExpDtls with whatever it CAN source —
--   ShipBNo/ShipBDt/Port, read from exim_shipment_details (0119) when a
--   shipping-bill row already exists for the same voucher, a genuine reuse
--   of real data rather than a new capture — but CntCode is left absent and
--   the screen says so explicitly, rather than fabricating a country. Also
--   in scope_deferred.
--
--   REVERSE CHARGE (TranDtls.RegRev) — always emitted "N". items.
--   is_rcm_applicable (0102) only gates the self-assessment on a PURCHASE
--   voucher (the recipient's own liability); this app has no equivalent
--   flag for "this item, sold BY us, is one where the BUYER pays tax under
--   Sec 9(3)/9(4)" on the outward side, so it cannot be derived. Stated
--   here rather than guessed.
--
--   SEZ WITH-PAYMENT VS WITHOUT-PAYMENT (SEZWP vs SEZWOP) — vouchers.
--   supply_type carries a single 'sez' value for both routes (0087's own
--   documented limitation: GSTR-1 Table 6B's WPAY/WOPAY split was never
--   added to the CHECK constraint). Recovered here from the ACTUAL POSTED
--   tax rather than re-deriving the registration's LUT window a second
--   time: if this voucher's own posted IGST is nonzero, tax was actually
--   charged, so SEZWP; if the posted IGST is zero, SEZWOP. This is exactly
--   what 0087's create_invoice itself decided at posting time (v_lut_active
--   drove the zero-vs-full-IGST branch there), read back from its own
--   result rather than recomputed — the same "actual postings, not a
--   parallel recomputation" discipline 0051's HSN summary already
--   established and documents in its own header.
--
-- GST RATE PER ITEM LINE (ItemList[].GstRt/CgstAmt/SgstAmt/IgstAmt/CesAmt) —
-- NOT read from items.gst_rate_percent (today's rate, which can drift from
-- what was actually charged — voucher_items never stored a per-line rate,
-- exactly 0051's own stated reason for the same design choice there).
-- Instead this voucher's ACTUAL posted cgst/sgst/igst/cess (read via the
-- same tax_ledger_map join 0051 and 0035 both use) is allocated across its
-- item lines in proportion to each line's share of the voucher's taxable
-- total, and GstRt is BACKED OUT from that allocation
-- (line tax / line taxable x 100) rather than looked up — reconstructing
-- the rate that was actually applied at the time, which is more historically
-- honest than the item master's current rate. Byte-for-byte the same
-- proration technique 0051 already uses and documents, applied to one
-- voucher instead of a whole HSN-grouped period.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. einvoice_details — one row per sales/credit_note voucher, addendum
--    style, same shape discipline as exim_shipment_details (0119).
-- ----------------------------------------------------------------------------
create table public.einvoice_details (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  voucher_id uuid not null,

  -- System-computed by the enforce trigger below from irn/generated_json —
  -- never trusted from the client, the same discipline 0119 applies to
  -- export_realisation_due_date.
  status text not null default 'not_generated'
    check (status in ('not_generated', 'json_ready', 'irn_obtained')),

  -- The payload THIS app assembled (build_einvoice_json's own output, saved
  -- by the caller after review) — kept for audit/reference, and so the
  -- screen can show "what we last generated" without recomputing it from
  -- data that may have since changed (e.g. the voucher was edited).
  generated_json jsonb,
  generated_at timestamptz,

  -- Recorded once obtained elsewhere (a GSP portal, the NIC offline utility,
  -- or manual entry from a printed acknowledgement) — never written by this
  -- app's own code, since this app makes no outbound call to any IRP.
  irn text check (irn is null or irn ~ '^[0-9a-f]{64}$'),
  ack_number text check (ack_number is null or ack_number ~ '^[0-9]{1,20}$'),
  ack_date timestamptz,
  -- The IRP's SignedQRCode JWS string — short enough by design to encode
  -- directly into a QR, per cleartax.in's own IRN/QR explainer.
  signed_qr_payload text check (signed_qr_payload is null or length(trim(signed_qr_payload)) > 0),

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  -- v1 scope, same as 0119: one e-invoice record per voucher. A cancelled-
  -- and-reissued IRN on the SAME voucher number is a real IRP scenario this
  -- single-row shape does not model; out of scope here, same spirit as
  -- 0119's own single-shipment-per-voucher cut.
  unique (voucher_id),
  foreign key (voucher_id, company_id) references public.vouchers (id, company_id),

  -- The IRP always returns IRN, AckNo and AckDt together in one response;
  -- entering one without the other two is either an incomplete copy-paste
  -- or a typo, either way worth rejecting rather than silently accepting a
  -- half-recorded acknowledgement.
  constraint einvoice_details_irn_ack_together
    check ((irn is null) = (ack_number is null) and (irn is null) = (ack_date is null))
);

create index einvoice_details_company_idx on public.einvoice_details (company_id);
create index einvoice_details_status_idx on public.einvoice_details (company_id, status);

comment on table public.einvoice_details is
  'e-Invoice (IRN) addendum for a sales invoice or a credit note this company issued. This app never calls an IRP — generated_json is the NIC-schema payload THIS app assembled (build_einvoice_json) for the user to submit elsewhere; irn/ack_number/ack_date/signed_qr_payload are recorded manually once obtained. One row per voucher (v1 scope). See 0230 for full statutory research.';

comment on column public.einvoice_details.status is
  'System-computed by the enforce_einvoice_voucher trigger from irn/generated_json presence, never client-supplied: not_generated (neither) -> json_ready (payload built, no IRN yet) -> irn_obtained (irn present). See 0230.';

comment on column public.einvoice_details.irn is
  'Invoice Reference Number: a 64-character lower-case hex SHA-256 hash the IRP assigns once THIS app''s generated JSON (or equivalent) is actually submitted through a GSP/the NIC utility — never written by this app''s own code.';

alter table public.einvoice_details enable row level security;

create policy einvoice_details_read on public.einvoice_details
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy einvoice_details_write on public.einvoice_details
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));


-- ----------------------------------------------------------------------------
-- enforce_einvoice_voucher — validates the linked voucher (must exist, same
-- company, not deleted, sales or credit_note only — the only two document
-- types this company itself issues as an outward-supply document, per
-- create_invoice's own tax_prefix='output' classification (0018/0087):
-- 'purchase' and 'debit_note' in this schema are voucher types where THIS
-- company is the recipient/buyer side, never the party obtaining an IRN),
-- and (re)computes status from irn/generated_json. SECURITY DEFINER, same
-- shape as app_private.enforce_exim_shipment_voucher (0119).
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_einvoice_voucher()
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
    raise exception 'Cannot attach e-invoice details to a deleted voucher';
  end if;
  if v_voucher.voucher_type not in ('sales', 'credit_note') then
    raise exception 'e-Invoice details can only be attached to a sales invoice or a credit note you issued, not a % voucher', v_voucher.voucher_type;
  end if;

  if new.irn is not null then
    new.irn := lower(new.irn);
  end if;

  new.status := case
    when new.irn is not null then 'irn_obtained'
    when new.generated_json is not null then 'json_ready'
    else 'not_generated'
  end;

  if new.generated_json is not null
     and (tg_op = 'INSERT' or new.generated_json is distinct from old.generated_json) then
    new.generated_at := now();
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_einvoice_voucher
  before insert or update on public.einvoice_details
  for each row execute function app_private.enforce_einvoice_voucher();

comment on function app_private.enforce_einvoice_voucher() is
  'Validates voucher_id points at a non-deleted sales/credit_note voucher in the same company, lower-cases irn, and (re)computes status from irn/generated_json presence — never trusted from the client. See 0230.';


-- ----------------------------------------------------------------------------
-- 2. get_einvoice_applicability — AATO turnover check against the current
--    Rs 5 crore threshold. See this migration's header for the full
--    statutory sourcing and the fixed-April-FY reasoning.
-- ----------------------------------------------------------------------------
create or replace function public.get_einvoice_applicability(
  p_company_id uuid,
  p_as_of date default current_date
) returns table (
  is_applicable boolean,
  threshold_amount numeric,
  triggering_fy_label text,
  triggering_fy_turnover numeric,
  highest_completed_fy_label text,
  highest_completed_fy_turnover numeric,
  current_fy_label text,
  current_fy_turnover_to_date numeric,
  fy_breakdown jsonb,
  note text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with gst_fy_years as (
    -- GST's financial year is always 1 April - 31 March (Sec 2(56) CGST Act
    -- via the General Clauses Act), fixed regardless of this company's own
    -- books financial_year_start_month — see this migration's header. 2017
    -- is the first GST year (e-invoicing applies "from FY 2017-18 onward").
    select y as fy_start_year
      from generate_series(
             2017,
             extract(year from p_as_of)::int
               - case when extract(month from p_as_of)::int >= 4 then 0 else 1 end
           ) as y
  ),
  fys as (
    select
      fy_start_year,
      fy_start_year::text || '-' || lpad(((fy_start_year + 1) % 100)::text, 2, '0') as fy_label,
      make_date(fy_start_year, 4, 1) as fy_start,
      make_date(fy_start_year + 1, 3, 31) as fy_end,
      (make_date(fy_start_year + 1, 3, 31) < p_as_of) as is_completed
      from gst_fy_years
  ),
  turnovers as (
    select
      f.fy_start_year, f.fy_label, f.fy_start, f.fy_end, f.is_completed,
      coalesce((
        select sum(p.amount)
          from public.get_profit_and_loss(p_company_id, f.fy_start, least(f.fy_end, p_as_of)) p
         where p.nature = 'direct_income'
      ), 0) as turnover
      from fys f
  )
  select
    exists (select 1 from turnovers where is_completed and turnover > 50000000) as is_applicable,
    50000000::numeric as threshold_amount,
    (select fy_label from turnovers where is_completed and turnover > 50000000
       order by fy_start_year asc limit 1) as triggering_fy_label,
    (select round(turnover, 2) from turnovers where is_completed and turnover > 50000000
       order by fy_start_year asc limit 1) as triggering_fy_turnover,
    (select fy_label from turnovers where is_completed
       order by turnover desc, fy_start_year desc limit 1) as highest_completed_fy_label,
    (select round(max(turnover), 2) from turnovers where is_completed) as highest_completed_fy_turnover,
    (select fy_label from turnovers where not is_completed order by fy_start_year desc limit 1) as current_fy_label,
    (select round(turnover, 2) from turnovers where not is_completed
       order by fy_start_year desc limit 1) as current_fy_turnover_to_date,
    (select jsonb_agg(jsonb_build_object(
               'fy_label', fy_label, 'turnover', round(turnover, 2), 'is_completed', is_completed
             ) order by fy_start_year)
       from turnovers) as fy_breakdown,
    'Turnover is this company''s own direct_income (Revenue-from-Operations proxy, tax-exclusive by construction) summed per GST financial year (fixed 1 Apr-31 Mar) from get_profit_and_loss — the closest schema-native approximation of Sec 2(6) CGST Act aggregate turnover, not a literal PAN-wide computation. Years before this company''s own books began show zero turnover because this app holds no records for them, not because turnover was actually nil. is_applicable, once true, stays true permanently even though only the first crossing is reported as triggering_fy_label — crossing the threshold once is a one-way statutory trigger.' as note;
$$;

revoke all on function public.get_einvoice_applicability(uuid, date) from public, anon;
grant execute on function public.get_einvoice_applicability(uuid, date) to authenticated;

comment on function public.get_einvoice_applicability is
  'Whether e-invoicing (Rule 48(4) CGST Rules) applies to this company: is_applicable is true once ANY completed GST financial year (fixed Apr-Mar) from 2017-18 onward shows direct_income turnover exceeding the current Rs 5,00,00,000 threshold (CBIC Notification 10/2023-CT), and stays true permanently once crossed. See 0230 for full sourcing.';


-- ----------------------------------------------------------------------------
-- 3. build_einvoice_json — assembles the NIC-schema payload from a voucher
--    this app already posted. Pure read, no external call, no write to
--    einvoice_details (the caller saves the result if it wants to keep it).
-- ----------------------------------------------------------------------------
create or replace function public.build_einvoice_json(p_voucher_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_voucher record;
  v_company record;
  v_registration_id uuid;
  v_reg record;
  v_branch record;
  v_party record;
  v_taxable_total numeric := 0;
  v_cgst_total numeric := 0;
  v_sgst_total numeric := 0;
  v_igst_total numeric := 0;
  v_cess_total numeric := 0;
  v_doc_typ text;
  v_sup_typ text;
  v_buyer_gstin text;
  v_buyer_addr1 text;
  v_buyer_loc text;
  v_buyer_pin int;
  v_buyer_stcd text;
  v_buyer_pos text;
  v_missing_hsn_count int;
  v_items jsonb;
  v_exp_dtls jsonb;
  v_shipment record;
begin
  select v.*
    into v_voucher
    from public.vouchers v
   where v.id = p_voucher_id;

  if v_voucher.id is null then
    raise exception 'Voucher % not found', p_voucher_id;
  end if;
  if v_voucher.is_deleted then
    raise exception 'Cannot build an e-invoice payload for a deleted voucher';
  end if;
  if v_voucher.voucher_type not in ('sales', 'credit_note') then
    raise exception 'e-Invoice JSON can only be built for a sales invoice or a credit note you issued, not a % voucher', v_voucher.voucher_type;
  end if;
  if v_voucher.supply_type is null then
    raise exception 'GST was not active on % (voucher date %) — no supply type was ever determined for it, so an e-invoice payload cannot be built', v_voucher.voucher_number, v_voucher.voucher_date;
  end if;

  select id, name, legal_name into v_company from public.companies where id = v_voucher.company_id;

  -- Seller: the branch that raised the invoice, and its GST registration in
  -- force on the voucher date (same lookup create_invoice itself used at
  -- posting time — app_private.branch_registration, 0005).
  select b.address_line1, b.address_line2, b.city, b.pincode
    into v_branch
    from public.branches b
   where b.id = v_voucher.branch_id;

  v_registration_id := app_private.branch_registration(v_voucher.branch_id, v_voucher.voucher_date);
  if v_registration_id is null then
    raise exception 'Branch % had no GST registration in force on % — cannot determine the seller GSTIN for this invoice', v_voucher.branch_id, v_voucher.voucher_date;
  end if;
  select gstin, state_code into v_reg from public.gst_registrations where id = v_registration_id;

  if v_branch.address_line1 is null or v_branch.city is null or v_branch.pincode is null then
    raise exception 'The branch that raised this invoice is missing a required address field (address line 1, city or PIN code) — add it under Branches before generating the e-invoice payload';
  end if;

  -- Buyer.
  select gstin, name, address, city, pincode, state_code, gst_registration_type
    into v_party
    from public.ledgers
   where id = v_voucher.party_ledger_id;

  -- Actual posted tax for THIS voucher, read the same way 0051/0035 read it
  -- — never recomputed from today's item rates. abs() because a credit
  -- note's own entries post on the opposite side (see this migration's
  -- header); the e-invoice payload shows a credit note's own value as a
  -- positive magnitude, exactly like voucher_items.amount already does.
  select coalesce(sum(vi.amount), 0) into v_taxable_total
    from public.voucher_items vi where vi.voucher_id = p_voucher_id;

  select
    coalesce(abs(sum(case when m.purpose = 'output_cgst' then e.credit_amount - e.debit_amount else 0 end)), 0),
    coalesce(abs(sum(case when m.purpose = 'output_sgst' then e.credit_amount - e.debit_amount else 0 end)), 0),
    coalesce(abs(sum(case when m.purpose = 'output_igst' then e.credit_amount - e.debit_amount else 0 end)), 0),
    coalesce(abs(sum(case when m.purpose = 'output_cess' then e.credit_amount - e.debit_amount else 0 end)), 0)
    into v_cgst_total, v_sgst_total, v_igst_total, v_cess_total
    from public.voucher_entries e
    join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
   where e.voucher_id = p_voucher_id
     and m.purpose in ('output_cgst', 'output_sgst', 'output_igst', 'output_cess');

  v_missing_hsn_count := (
    select count(*) from public.voucher_items vi
     where vi.voucher_id = p_voucher_id and (vi.hsn_sac is null or length(trim(vi.hsn_sac)) = 0)
  );
  if v_missing_hsn_count > 0 then
    raise exception '% item line(s) on % have no HSN/SAC code recorded — HsnCd is mandatory on every e-invoice item line. Add HSN/SAC to those items first.', v_missing_hsn_count, v_voucher.voucher_number;
  end if;

  v_doc_typ := case v_voucher.voucher_type when 'sales' then 'INV' when 'credit_note' then 'CRN' end;

  -- SupTyp — see this migration's header for the SEZ WP/WOP derivation.
  v_sup_typ := case v_voucher.supply_type
    when 'export_lut'    then 'EXPWOP'
    when 'export_igst'   then 'EXPWP'
    when 'deemed_export' then 'DEXP'
    when 'sez'            then case when v_igst_total > 0 then 'SEZWP' else 'SEZWOP' end
    else 'B2B'
  end;

  -- Buyer identity/address. Exports use the NIC-mandated placeholders (URP /
  -- state 96 / PIN 999999) confirmed live today (accorgconsulting.com's GST
  -- POS 96/97 guide, cross-checked against the ClearTax e-Invoice Object
  -- page) — ref_states already seeds '96' as "Other Country... place of
  -- supply for exports" (0002), so this is this app's own existing
  -- convention, not a new guess.
  if v_voucher.supply_type in ('export_lut', 'export_igst') then
    v_buyer_gstin := 'URP';
    v_buyer_stcd := '96';
    v_buyer_pin := 999999;
    v_buyer_addr1 := coalesce(v_party.address, v_party.name);
    v_buyer_loc := coalesce(v_party.city, 'Overseas');
  else
    if v_party.gstin is null then
      raise exception 'The buyer (%) has no GSTIN on file and this is not an export. e-Invoicing under GST does not apply to B2C (unregistered-buyer) domestic supplies — only B2B, SEZ, deemed-export and export documents are covered.', coalesce(v_party.name, v_voucher.party_ledger_id::text);
    end if;
    if v_party.pincode is null or v_party.city is null or v_party.address is null then
      raise exception 'Buyer (%) is missing a required address field (address, city or PIN code) — add it to the ledger before generating the e-invoice payload', v_party.name;
    end if;
    v_buyer_gstin := v_party.gstin;
    v_buyer_stcd := v_party.state_code;
    v_buyer_pin := v_party.pincode::int;
    v_buyer_addr1 := v_party.address;
    v_buyer_loc := v_party.city;
  end if;
  v_buyer_pos := v_voucher.place_of_supply;

  -- Item lines. RATE-WEIGHTED allocation of the voucher's ACTUAL posted tax
  -- — NOT a plain value-share split. Caught live, hand-verifying this exact
  -- function against a real two-rate voucher (HO/SAL/2026-27/00007, Sharma
  -- Textiles: one line at 18%, one at 12%, seeded on purpose as a
  -- "GSTR1 rate-split test"): a first version of this query allocated by
  -- vi.amount share alone, same technique as get_gstr1_hsn_summary (0051),
  -- and produced a WRONG per-line result — both lines came out at a blended
  -- 15.75% (630/8000 combined) instead of their real 18% and 12% — even
  -- though the VOUCHER TOTAL still matched. 0051 can accept that blending
  -- because it aggregates a whole period's worth of lines into one HSN row
  -- and says so; an e-invoice ItemList is the opposite case — the per-LINE
  -- rate is the entire point of the field, and a blended rate here is not a
  -- rounding nicety, it is a wrong number on a document meant for the IRP.
  --
  -- Fix: weight each line by (taxable value x the ITEM MASTER's current
  -- gst_rate_percent/cess_rate_percent) instead of by taxable value alone.
  -- Within one voucher the intra/inter (or zero-rated) branch is decided
  -- ONCE for the whole voucher, never per line (0018/0087's own v_intrastate
  -- is a single boolean applied to every item in the loop) — so cgst_total,
  -- sgst_total and igst_total are never simultaneously nonzero, and the
  -- SAME rate-weighted share is correct for splitting whichever of the
  -- three actually is. The voucher's ACTUAL posted totals (v_cgst_total
  -- etc, already read from real postings, never recomputed) are still what
  -- gets distributed — only the SPLIT changes, so a real dollar
  -- reconciliation to the voucher total still holds exactly, and GstRt is
  -- now reported directly from the item master's own rate (the best
  -- available per-line source, since voucher_items stores no historical
  -- rate — same limitation 0051 already documents) rather than backed out
  -- from a blended figure. If every line's item happens to carry 0% today
  -- (e.g. rates were zeroed out after this voucher posted) while the
  -- voucher's real posted tax is nonzero, the weights would all be zero;
  -- guarded by falling back to a plain value-share split ONLY in that
  -- drift scenario, so a division by zero never occurs and the dollar
  -- total is still preserved either way.
  with base as (
    select
      vi.line_order, vi.description, it.name as item_name, it.item_type,
      vi.hsn_sac, vi.quantity, vi.uom, vi.rate,
      vi.amount_before_discount, vi.discount_amount, vi.amount,
      it.gst_rate_percent,
      (vi.amount * it.gst_rate_percent) as gst_weight,
      (vi.amount * it.cess_rate_percent) as cess_weight
    from public.voucher_items vi
    join public.items it on it.id = vi.item_id and it.company_id = vi.company_id
    where vi.voucher_id = p_voucher_id
  ),
  totals as (
    select coalesce(sum(gst_weight), 0) as sum_gst_weight, coalesce(sum(cess_weight), 0) as sum_cess_weight
      from base
  )
  select jsonb_agg(line order by rn) into v_items
    from (
      select
        row_number() over (order by b.line_order) as rn,
        jsonb_build_object(
          'SlNo', (row_number() over (order by b.line_order))::text,
          'PrdDesc', coalesce(nullif(trim(b.description), ''), b.item_name),
          'IsServc', case when b.item_type = 'service' then 'Y' else 'N' end,
          'HsnCd', b.hsn_sac,
          'Qty', b.quantity,
          'Unit', b.uom,
          'UnitPrice', b.rate,
          'TotAmt', b.amount_before_discount,
          'Discount', b.discount_amount,
          'AssAmt', b.amount,
          'GstRt', b.gst_rate_percent,
          'CgstAmt', round(sh.gshare * v_cgst_total, 2),
          'SgstAmt', round(sh.gshare * v_sgst_total, 2),
          'IgstAmt', round(sh.gshare * v_igst_total, 2),
          'CesAmt', round(sh.cshare * v_cess_total, 2),
          'TotItemVal', round(
            b.amount + round(sh.gshare * v_cgst_total, 2) + round(sh.gshare * v_sgst_total, 2)
              + round(sh.gshare * v_igst_total, 2) + round(sh.cshare * v_cess_total, 2), 2)
        ) as line
      from base b
      cross join totals t
      cross join lateral (
        select
          case when t.sum_gst_weight = 0 then
                 case when v_taxable_total = 0 then 0 else b.amount / v_taxable_total end
               else b.gst_weight / t.sum_gst_weight end as gshare,
          case when t.sum_cess_weight = 0 then
                 case when v_taxable_total = 0 then 0 else b.amount / v_taxable_total end
               else b.cess_weight / t.sum_cess_weight end as cshare
      ) sh
    ) x;

  -- ExpDtls — see this migration's header on why CntCode is absent.
  -- ShipBNo/ShipBDt/Port are filled in from exim_shipment_details (0119)
  -- when a shipping-bill row already exists for this same voucher.
  if v_voucher.supply_type in ('export_lut', 'export_igst') then
    select document_number, document_date, port_code
      into v_shipment
      from public.exim_shipment_details
     where voucher_id = p_voucher_id and document_type = 'shipping_bill';

    v_exp_dtls := jsonb_strip_nulls(jsonb_build_object(
      'ShipBNo', v_shipment.document_number,
      'ShipBDt', to_char(v_shipment.document_date, 'DD/MM/YYYY'),
      'Port', v_shipment.port_code,
      'RefClm', case when v_voucher.supply_type = 'export_igst' then 'Y' else 'N' end,
      'ForCur', case when v_voucher.txn_currency <> 'INR' then v_voucher.txn_currency else null end
    ));
  else
    v_exp_dtls := null;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'Version', '1.1',
    'TranDtls', jsonb_build_object(
      'TaxSch', 'GST',
      'SupTyp', v_sup_typ,
      -- Always "N" — this app has no outward-side reverse-charge flag. See header.
      'RegRev', 'N'
    ),
    'DocDtls', jsonb_build_object(
      'Typ', v_doc_typ,
      'No', v_voucher.voucher_number,
      'Dt', to_char(v_voucher.voucher_date, 'DD/MM/YYYY')
    ),
    'SellerDtls', jsonb_build_object(
      'Gstin', v_reg.gstin,
      'LglNm', coalesce(v_company.legal_name, v_company.name),
      'TrdNm', v_company.name,
      'Addr1', v_branch.address_line1,
      'Addr2', v_branch.address_line2,
      'Loc', v_branch.city,
      'Pin', v_branch.pincode::int,
      'Stcd', v_reg.state_code
    ),
    'BuyerDtls', jsonb_build_object(
      'Gstin', v_buyer_gstin,
      'LglNm', v_party.name,
      'Pos', v_buyer_pos,
      'Addr1', v_buyer_addr1,
      'Loc', v_buyer_loc,
      'Pin', v_buyer_pin,
      'Stcd', v_buyer_stcd
    ),
    'ItemList', v_items,
    'ValDtls', jsonb_build_object(
      'AssVal', round(v_taxable_total, 2),
      'CgstVal', round(v_cgst_total, 2),
      'SgstVal', round(v_sgst_total, 2),
      'IgstVal', round(v_igst_total, 2),
      'CesVal', round(v_cess_total, 2),
      'RndOffAmt', round(v_voucher.total_amount - (v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total), 2),
      'TotInvVal', round(v_voucher.total_amount, 2),
      -- Books (and TotInvVal above) are always INR — vouchers.total_amount
      -- is never anything else (0007's own design). TotInvValFc is the same
      -- total restated in the voucher's OWN transaction currency using the
      -- rate actually recorded on it, only emitted when that currency isn't
      -- INR (jsonb_strip_nulls drops it otherwise).
      'TotInvValFc', case when v_voucher.txn_currency <> 'INR'
        then round(v_voucher.total_amount / v_voucher.exchange_rate, 2) else null end
    ),
    'ExpDtls', v_exp_dtls
  ));
end;
$$;

revoke all on function public.build_einvoice_json(uuid) from public, anon;
grant execute on function public.build_einvoice_json(uuid) to authenticated;

comment on function public.build_einvoice_json is
  'Assembles a NIC e-invoice-schema JSON payload from a sales invoice or credit note this app already posted — a pure read, no call to any IRP. Tax figures are the voucher''s ACTUAL posted CGST/SGST/IGST/cess allocated per item line by taxable-value share (same technique as get_gstr1_hsn_summary, 0051), not looked up from today''s item master. Raises a named exception (never fabricates a value) when a required NIC field has no honest source: no GST registration on the invoicing branch, missing branch/buyer address fields, missing item HSN, or a B2C (unregistered, non-export) buyer, which e-invoicing categorically does not cover. See 0230 for the full field-by-field sourcing, including what it deliberately cannot populate (ExpDtls.CntCode, reverse-charge on the outward side).';


-- ----------------------------------------------------------------------------
-- 4. get_einvoice_status — every sales/credit_note voucher this company
--    issued that e-invoicing actually covers (B2B/SEZ/deemed-export/export
--    — genuine B2C is excluded, not merely unflagged), with its
--    einvoice_details row if one exists. Backs the /einvoice hub list.
-- ----------------------------------------------------------------------------
create or replace function public.get_einvoice_status(
  p_company_id uuid,
  p_from date default null,
  p_to date default null
) returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  voucher_type text,
  party_name text,
  party_gstin text,
  supply_type text,
  total_amount numeric,
  einvoice_id uuid,
  status text,
  irn text,
  ack_date timestamptz,
  generated_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    v.id, v.voucher_number, v.voucher_date, v.voucher_type,
    l.name, l.gstin, v.supply_type, v.total_amount,
    ed.id, coalesce(ed.status, 'not_generated'), ed.irn, ed.ack_date, ed.generated_at
    from public.vouchers v
    left join public.ledgers l on l.id = v.party_ledger_id
    left join public.einvoice_details ed on ed.voucher_id = v.id
   where v.company_id = p_company_id
     and not v.is_deleted
     and v.voucher_type in ('sales', 'credit_note')
     and v.supply_type is not null
     and (l.gstin is not null or v.supply_type in ('export_lut', 'export_igst', 'sez', 'deemed_export'))
     and (p_from is null or v.voucher_date >= p_from)
     and (p_to is null or v.voucher_date <= p_to)
   order by v.voucher_date desc, v.voucher_number desc;
$$;

revoke all on function public.get_einvoice_status(uuid, date, date) from public, anon;
grant execute on function public.get_einvoice_status(uuid, date, date) to authenticated;

comment on function public.get_einvoice_status is
  'Every sales/credit_note voucher this company issued that e-invoicing actually covers (buyer has a GSTIN, OR the voucher is an export/SEZ/deemed-export supply) — a genuine B2C sale is excluded entirely, not merely unflagged, since e-invoicing categorically does not apply to it. Backs the /einvoice hub list (0230).';
