-- ============================================================================
-- 0865 — Capture stops being purchase-only: a document type on every draft,
--        the confirmed voucher type FOLLOWING that document type, and the
--        outgoing delivery-challan number the invoice was raised against
-- ============================================================================
-- 0740 shipped OCR/vision bill capture as a purchase-only feature and said so
-- in its own header ("WHY 'purchase' ONLY"). capture_drafts has no document
-- type column at all, and app_private.enforce_capture_draft hardcodes the
-- rule: confirm a draft against anything other than a voucher_type =
-- 'purchase' and it raises. That was the honest v1 — the screen's only button
-- read "Post as purchase bill" — but it is not all a trading company
-- actually photographs. The other paper in a textile trader's counter book is
-- the outgoing DELIVERY CHALLAN: goods leave on a challan today, the tax
-- invoice follows. This migration makes capture universal, and adds the one
-- column an invoice raised that way has nowhere to record: the number of the
-- challan the goods actually went out on.
--
-- ============================================================================
-- 1. THE document_type VALUE SET, AND WHY EXACTLY THESE THREE
-- ============================================================================
--   'sales_challan'    — an outgoing delivery challan. Confirms against a
--                        'sales' voucher: the challan moved the goods, the
--                        tax invoice charges for them.
--   'purchase_invoice' — a supplier's bill. Confirms against a 'purchase'
--                        voucher. This is 0740's entire behaviour, unchanged,
--                        and the value every pre-existing row is backfilled
--                        to (section 3).
--   'other'            — anything else the preparer photographs. Storable and
--                        filed; NOT postable (section 2).
--
-- A fourth value, 'sales_invoice' (a photograph of one's own carbon-copy
-- counter bill), was considered and deliberately left out. It maps to the
-- same 'sales' voucher type as 'sales_challan', so it adds no new posting
-- behaviour, only a second tab to the capture screen and a second branch to
-- the vision prompt — two files this migration's author does not own. The
-- mapping in enforce_capture_draft below is written as a CASE precisely so
-- that adding it later is one line and no schema change. Named here rather
-- than silently omitted.
--
-- The value set is deliberately NOT public.vouchers.voucher_type. A document
-- type describes the PAPER on the desk; a voucher type describes the entry
-- LEKHA makes. They are not the same list and must not be conflated: a
-- delivery challan is a real document with no voucher type of its own, and
-- 'other' has no voucher at all. The trigger below is the one place the two
-- vocabularies meet, and it meets them explicitly.
--
-- ============================================================================
-- 2. 'other' IS STORABLE BUT NOT POSTABLE — the decision, and why
-- ============================================================================
-- DECIDED: an 'other' draft may never carry a confirmed_voucher_id, against
-- a voucher of ANY type. It is refused by enforce_capture_draft outright,
-- not left to the UI to avoid.
--
-- The real cases the feature has to serve here are a quotation, a bare
-- delivery note, a covering letter, a bank advice — documents a preparer
-- genuinely wants photographed, stored and searchable, and which post
-- NOTHING. 'other' is also, honestly, what the vision model returns when it
-- cannot tell what the paper is. Letting either confirm against an arbitrary
-- voucher would put a hole straight through the rule this trigger exists to
-- enforce: pick "other" and a scanned quotation could be recorded as the
-- source document of a payment voucher, with the database asserting a link
-- nobody checked. So 'other' captures and files; it does not post.
--
-- An 'other' draft therefore lives at status 'pending_review' (its image in
-- Storage, its extraction in extracted_json, visible and searchable to the
-- company) or is 'rejected' if discarded.
--
-- A FOURTH STATUS, 'filed', WAS CONSIDERED AND REJECTED — recorded because
-- it is the obviously tempting thing to add. 'pending_review' is a slightly
-- awkward resting place for a quotation nobody will ever post, and 'filed'
-- would say it better. It is not worth it: status is a three-value union
-- hardcoded in THREE TypeScript files owned by other authors
-- (components/capture/CaptureWorkspace.tsx, the /capture page, and the
-- WhatsApp confirm page), and a value the database can produce but two of
-- those three screens do not know would render as a raw string in one place
-- and fall through every branch in another. A cosmetic gain is not worth a
-- contract change across three files and two owners mid-batch. See
-- scope_deferred.
--
-- ============================================================================
-- 3. THE BACKFILL, AND WHY IT INVALIDATES NOTHING
-- ============================================================================
-- document_type is added NOT NULL DEFAULT 'purchase_invoice', which fills
-- every existing row in the same statement. That default is not laziness, it
-- is the compatibility contract: purchase is the only thing this feature
-- could produce until today, so every row already in the table IS a purchase
-- bill, and any caller not yet taught about document types (the WhatsApp
-- inbound handler in 0745 inserts capture_drafts without naming it) keeps
-- behaving exactly as it does now.
--
-- Counted live before writing this, not assumed: 4 rows in capture_drafts,
-- all one company, 3 'rejected' and 1 'pending_review', and ZERO with a
-- confirmed_voucher_id. So no already-confirmed draft can be invalidated by
-- the new rule — there are none — and the backfill is checked both ways in
-- this session's verification: every existing row must still satisfy the
-- trigger after the change, re-asserted by re-saving a real confirmed
-- purchase draft created for the purpose.
--
-- ============================================================================
-- 4. THE CHALLAN NUMBER: WHY NOT reference_number
-- ============================================================================
-- public.vouchers already has reference_number/reference_date, and the
-- invoice screen labels reference_number "Their PO no." on a sale and "Their
-- bill no." on a purchase. That column is spoken for: it is the
-- COUNTERPARTY's document reference — a number somebody else issued.
--
-- A delivery challan number is our OWN outgoing document's number, and both
-- facts exist on one invoice at the same time. A customer sends purchase
-- order 4471; the goods go out on our challan DC/26-27/188; the invoice
-- follows. Forcing them into one text column means the preparer types
-- "PO 4471 / DC 188" and from that moment neither fact is a value any more:
-- it cannot be matched against the challan register, cannot be filtered on,
-- and flows into every downstream reader of reference_number (print, GSTR-1
-- workpapers, the e-invoice and e-way-bill payload builders) as a mangled
-- string. One text column cannot honestly carry two documents' numbers, so
-- this adds a second column rather than overloading the first.
--
-- ============================================================================
-- 5. WHY NOT A FOREIGN KEY TO public.delivery_challans
-- ============================================================================
-- LEKHA already has an outgoing-challan feature (0113, public.
-- delivery_challans), so an FK looks like the tidy answer. It is the wrong
-- one, for three independent reasons — decided deliberately rather than
-- assumed, because the choice is the whole point of this half of the feature:
--
--   (a) delivery_challans HAS NO CHALLAN NUMBER COLUMN. Its serial is the
--       voucher_number of its own voucher_id, allocated out of the company's
--       own numbering series. A scanned or hand-written challan already
--       bears a printed number, very often from a pre-printed book or a
--       previous system. Creating a delivery_challans row for it would mint
--       a SECOND, different serial for a document that already has one.
--       Rule 55(1) requires the challan to carry a serial number in a series
--       unique for the financial year (the same discipline Rule 46(b)
--       imposes on invoices); manufacturing a parallel serial after the fact
--       for a document already numbered is precisely the corruption of that
--       series the rule exists to prevent.
--   (b) IT IS ONE ROW PER ITEM. delivery_challans carries item_id,
--       quantity_sent, uom, rate, gst_rate_percent — singular. A scanned
--       multi-line challan would have to be re-keyed as N structured stock
--       rows, and those rows would then describe the same goods movement the
--       invoice's own voucher_items already describes. Two records of one
--       movement is a stock-report defect waiting to happen.
--   (c) IT CARRIES A LIFECYCLE WE DID NOT LIVE THROUGH. A delivery_challans
--       row has a dispatched/received status that 0113 built to track OUR
--       consignments as they are acknowledged. Filing somebody's photograph
--       into that register asserts LEKHA issued and is tracking a challan it
--       never issued.
--
-- So the invoice records the challan's NUMBER and DATE — a reference, which
-- is what it is. Where the company DID raise the challan through 0113's own
-- module, the preparer types that challan's voucher_number here and the two
-- are linked by a number a human (and a later report) can read.
--
-- A NULLABLE FK ALONGSIDE THE TEXT was also weighed and rejected: it can
-- represent only the minority case (a) rules out, and 0805's header already
-- argued at length why two homes for one fact drift apart rather than agree.
-- One home, deliberately the one that can hold every case.
--
-- ============================================================================
-- 6. STATUTORY RESEARCH — WHAT THE LAW ACTUALLY REQUIRES HERE, VERIFIED
-- ============================================================================
-- Read from the CBIC tax repository this session rather than recalled, and
-- the finding is partly NEGATIVE, which is stated plainly rather than
-- dressed up:
--
--   * Rule 46 CGST Rules lists the particulars of a tax invoice, clauses (a)
--     to (s). NONE of them is a delivery-challan number. Checked clause by
--     clause. So this column is NOT a Rule 46 field and this migration does
--     not claim it as one — nothing about the printed invoice's statutory
--     validity changes.
--   * Rule 55(4) is the fact pattern the column serves, quoted from the
--     repository text as in force: "Where the goods being transported are for
--     the purpose of supply to the recipient but the tax invoice could not be
--     issued at the time of removal of goods for the purpose of supply, the
--     supplier shall issue a tax invoice after delivery of goods." That is
--     challan first, invoice after — exactly the flow this migration makes
--     capturable. Rule 55 imposes no requirement that the later invoice cite
--     the challan; checked, and it does not.
--   * Section 31(7) CGST Act is where the linkage genuinely earns its keep:
--     "Notwithstanding anything contained in sub-section (1), where the goods
--     being sent or taken on approval for sale or return are removed before
--     the supply takes place, the invoice shall be issued before or at the
--     time of supply or six months from the date of removal, whichever is
--     earlier." The six-month clock starts at REMOVAL, and the document that
--     evidences the date of removal is the delivery challan. An invoice that
--     names its challan number and date carries its own proof that it was
--     issued in time; one that does not leaves an auditor to reconstruct the
--     link from dates alone.
--
-- HONEST SUMMARY: challan_number/challan_date are an audit-trail and
-- trade-practice field with a real Sec 31(7) use, not a statutory invoice
-- particular. They are therefore nullable, unvalidated against any register,
-- and never required by any code path.
--
-- ============================================================================
-- 7. WHY TWO COLUMNS ON public.vouchers AND NOT AN ADDENDUM TABLE
-- ============================================================================
-- 0805 put ship-to in its own table, so the contrast is worth stating. That
-- was a seven-column address which already had a second home on ewb_details
-- to de-duplicate. This is one scalar pair, at exactly the grain of the
-- voucher, of exactly the kind of the reference_number/reference_date pair
-- sitting on public.vouchers already. A table would be one row per voucher
-- holding two scalars, joined by every reader, to say what a column says.
--
-- THE COLUMN-GRANT TRAP, WHICH THIS TABLE HAS TOO. public.companies is the
-- famous one (0044's allowlist, four shipped bugs), but public.vouchers is
-- the same shape for UPDATE: 0028a revoked the table-wide UPDATE and
-- re-granted 23 named columns, so a new column is invisible to any UPDATE by
-- `authenticated` until it is named. Verified live before writing this:
-- authenticated holds table-wide INSERT on vouchers (so create_invoice, which
-- is SECURITY INVOKER, can write the new columns unaided) but column-level
-- UPDATE on 23 of 31 columns only. update_invoice is SECURITY INVOKER too and
-- would have failed with a bare permission error on the edit screen. The
-- grant below closes it, and this session's verification re-reads
-- information_schema.column_privileges to prove it.
--
-- ============================================================================
-- 8. THE RPC ARGUMENTS ARE ADDITIVE, AND THE OVERLOAD TRAP IS AVOIDED
-- ============================================================================
-- create_invoice and update_invoice each gain the SAME two trailing optional
-- arguments, p_challan_number and p_challan_date, defaulting to null —
-- exactly the pattern 0725 used for p_voucher_number/p_number_series_id.
-- Every existing caller (create_invoices_bulk, the capture screen, the CSV
-- importers, the recurring-voucher generator) keeps compiling and keeps
-- behaving identically.
--
-- Both are DROPped at their old signature first and recreated, never left as
-- a second overload: adding a parameter without dropping leaves two
-- candidates and every subsequent call dies with "function name is not
-- unique". The invariants suite asserts create_invoice has exactly ONE
-- signature for this reason; that assertion still holds after this migration.
-- Both bodies below are the LIVE definitions, taken from pg_get_functiondef
-- and edited only in the places marked "0865", so nothing is silently
-- retyped — the same technique 0102 used on update_invoice.
--
-- update_invoice's "full replace" semantics apply to the new columns as they
-- already do to narration and reference_number: what the caller passes is
-- what the voucher ends up with, and a caller that passes nothing clears
-- them. Its only caller in this repo is components/invoices/InvoiceForm.tsx,
-- which is updated in the same change to send both fields.
--
-- ============================================================================
-- 9. DELIBERATELY NOT DONE HERE (named, not silently omitted)
-- ============================================================================
--   * No change to the vision prompt or RESPONSE_SCHEMA in
--     lib/capture/analyze.ts, and no change to components/capture/
--     CaptureWorkspace.tsx — both are owned by sibling authors in this batch.
--     Only the TypeScript TYPES in analyze.ts move here, so those siblings
--     have a contract to build against.
--   * NOTHING HERE POSTS A VOUCHER. 0740's central promise is untouched:
--     there is still no function anywhere that calls create_invoice on a
--     draft's behalf. The browser calls create_invoice after a human
--     confirms, then writes confirmed_voucher_id, and this trigger checks
--     what it wrote. Widening the accepted voucher type widens what a human
--     may confirm; it does not move the confirming.
--   * No reverse link, and no report joining an invoice to the 0113 challan
--     register by number. The text is a reference a human reads today.
--   * No back-population of challan numbers onto vouchers already posted —
--     there is no source to populate them from.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. public.vouchers — the challan the goods actually went out on.
--    Nullable, and null on every voucher issued before today.
-- ----------------------------------------------------------------------------
alter table public.vouchers
  add column challan_number text,
  add column challan_date date;

-- Blank-but-not-null is the one state that is never a fact: it renders as an
-- empty cell exactly like null but breaks every `is not null` test a later
-- report writes. Both RPCs below normalise '' to null before insert; this
-- constraint catches the direct-table writer they do not cover.
--
-- NOT constrained: challan_date without challan_number. That is a real
-- reading — the paper is dated 12 August and its number is illegible or was
-- never printed — and refusing it would turn an OCR near-miss into a hard
-- error on the confirm screen for no gain.
alter table public.vouchers
  add constraint vouchers_challan_number_not_blank
  check (challan_number is null or btrim(challan_number) <> '');

comment on column public.vouchers.challan_number is
  'The delivery challan this document was raised against — OUR OWN outgoing challan on a sale (Rule 55(4): goods removed on a challan, tax invoice issued after delivery), or the supplier''s challan on a purchase. Deliberately NOT reference_number, which is the counterparty''s own document reference ("Their PO no." / "Their bill no.") and can be present at the same time. Free text by design, NOT a foreign key to public.delivery_challans — see 0865 section 5 for the three reasons. Not a Rule 46 invoice particular; an audit-trail field whose real use is evidencing the Sec 31(7) six-month clock that runs from the date of removal.';

comment on column public.vouchers.challan_date is
  'Date printed on the challan named by challan_number. Deliberately allowed without a challan_number (an illegible or unnumbered challan is still dated) — see 0865.';

-- THE ALLOWLIST. 0028a revoked the table-wide UPDATE on public.vouchers from
-- `authenticated` and re-granted 23 named columns; a column not named here
-- cannot be updated by update_invoice (SECURITY INVOKER) or by any client
-- write, and the failure is a bare permission error with no hint of the
-- cause. INSERT needs no equivalent line: authenticated's INSERT on this
-- table is still table-wide (verified live this session), which is why
-- create_invoice needs nothing extra.
grant update (challan_number, challan_date) on public.vouchers to authenticated;


-- ----------------------------------------------------------------------------
-- 2. public.capture_drafts.document_type — what the paper IS.
--    NOT NULL DEFAULT backfills every existing row in the same statement;
--    see section 3 above for why 'purchase_invoice' is the honest default and
--    not merely the convenient one.
-- ----------------------------------------------------------------------------
alter table public.capture_drafts
  add column document_type text not null default 'purchase_invoice'
    check (document_type in ('sales_challan', 'purchase_invoice', 'other'));

comment on column public.capture_drafts.document_type is
  'What the captured paper is: ''sales_challan'' (an outgoing delivery challan — confirms against a SALES voucher), ''purchase_invoice'' (a supplier''s bill — confirms against a PURCHASE voucher, 0740''s original and only behaviour), or ''other'' (captured and filed, never postable — see 0865 section 2). Enforced by app_private.enforce_capture_draft, which maps this to the voucher type it will accept; it is deliberately NOT the same vocabulary as vouchers.voucher_type. The AUTHORITATIVE, human-confirmed value; the vision model''s own guess lives separately at extracted_json.document_type and is advisory only.';


-- ----------------------------------------------------------------------------
-- 3. app_private.enforce_capture_draft — the voucher type demanded now
--    FOLLOWS document_type instead of being hardcoded to 'purchase'.
--    Every other check 0740 wrote is kept verbatim: terminal status, branch
--    belongs to company, company known before confirming, voucher exists,
--    voucher is same-company, voucher not deleted, status never trusted from
--    the client. Still BEFORE INSERT OR UPDATE only, so it still cannot
--    stand in the way of any ON DELETE CASCADE.
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_capture_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_company uuid;
  v_voucher record;
  v_required_voucher_type text;
begin
  if tg_op = 'UPDATE' and old.status in ('confirmed', 'rejected') then
    raise exception 'This capture draft is already % and its record cannot be changed further', old.status;
  end if;

  if new.branch_id is not null then
    select company_id into v_branch_company from public.branches where id = new.branch_id;
    if v_branch_company is null then
      raise exception 'Branch % does not exist', new.branch_id;
    end if;
    if v_branch_company <> new.company_id then
      raise exception 'Branch % does not belong to company %', new.branch_id, new.company_id;
    end if;
  end if;

  if new.confirmed_voucher_id is not null then
    if new.company_id is null then
      raise exception 'A capture draft cannot be confirmed before it is attached to a company';
    end if;

    select company_id, voucher_type, is_deleted
      into v_voucher
      from public.vouchers
     where id = new.confirmed_voucher_id;

    if v_voucher.company_id is null then
      raise exception 'Voucher % does not exist', new.confirmed_voucher_id;
    end if;
    if v_voucher.company_id <> new.company_id then
      raise exception 'Voucher % does not belong to company %', new.confirmed_voucher_id, new.company_id;
    end if;
    if v_voucher.is_deleted then
      raise exception 'Cannot confirm a capture draft against a deleted voucher';
    end if;

    -- 0865: the one behavioural change. A CASE rather than an if-chain so a
    -- future document type is a single added line — see section 1 above on
    -- the 'sales_invoice' value deliberately not added today. A document
    -- type with no voucher type ('other') is refused outright rather than
    -- being allowed to confirm against anything at all.
    v_required_voucher_type := case new.document_type
      when 'sales_challan'    then 'sales'
      when 'purchase_invoice' then 'purchase'
      else null
    end;

    if v_required_voucher_type is null then
      raise exception 'A capture draft filed as "%" records a document that posts nothing, so it cannot be confirmed against voucher %. Change its document type to a sales challan or a purchase invoice first, or discard it.',
        new.document_type, new.confirmed_voucher_id;
    end if;

    if v_voucher.voucher_type <> v_required_voucher_type then
      raise exception 'A capture draft of a % can only be confirmed against a % voucher, not a % voucher',
        replace(new.document_type, '_', ' '), v_required_voucher_type, v_voucher.voucher_type;
    end if;
  end if;

  -- Unchanged from 0740. Never trust the client for 'confirmed' — only a real
  -- confirmed_voucher_id earns it. 'rejected' is the one status value a
  -- client may set directly (discarding a draft with no voucher); anything
  -- else it sends collapses to 'pending_review'.
  new.status := case
    when new.confirmed_voucher_id is not null then 'confirmed'
    when new.status = 'rejected' then 'rejected'
    else 'pending_review'
  end;

  new.updated_at := now();
  return new;
end;
$$;

comment on function app_private.enforce_capture_draft() is
  'Validates a capture_drafts row''s branch (must belong to the same company) and confirmed_voucher_id (must exist, same company, not deleted, and of the voucher type its document_type calls for: sales_challan -> sales, purchase_invoice -> purchase, other -> not postable at all), computes status from confirmed_voucher_id rather than trusting the client, and makes confirmed/rejected terminal. Was hardcoded to purchase until 0865.';


-- ----------------------------------------------------------------------------
-- 4. public.create_invoice — two trailing optional arguments, nothing else.
--    The body below is the LIVE definition read back with pg_get_functiondef,
--    with exactly two edits, each marked "0865" in place: the vouchers INSERT
--    gains challan_number/challan_date. Every GST, zero-rating, RCM, TCS,
--    discount and numbering branch is byte-for-byte what it was, deliberately
--    not read past to avoid.
--
--    DROP first, at the exact 17-argument signature 0725 left behind, so this
--    replaces rather than overloads — see section 8 of the header.
-- ----------------------------------------------------------------------------
drop function if exists public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  bpchar, bpchar, numeric, text, text, uuid);

create function public.create_invoice(
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
  p_place_of_supply bpchar default null,
  p_txn_currency bpchar default 'INR',
  p_exchange_rate numeric default 1,
  p_rate_source text default null,
  p_voucher_number text default null,
  p_number_series_id uuid default null,
  -- 0865. Trailing and optional, so every existing caller is unaffected.
  -- p_reference_number stays what it has always been: the COUNTERPARTY's
  -- document number. These two are our own outgoing challan's.
  p_challan_number text default null,
  p_challan_date date default null
) returns uuid
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
        if v_supply_type = 'export_lut' or (v_supply_type = 'sez' and v_lut_active) then
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
      raise exception 'No RCM Payable ledger configured for this registration. Seed the GST ledgers for it first.';
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
  bpchar, bpchar, numeric, text, text, uuid, text, date) from public, anon;
grant execute on function public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  bpchar, bpchar, numeric, text, text, uuid, text, date) to authenticated, service_role;

comment on function public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  bpchar, bpchar, numeric, text, text, uuid, text, date) is
  'Posts an invoice (sales/purchase/credit_note/debit_note) with its items, GST, RCM and TCS. p_challan_number/p_challan_date (0865) record the delivery challan the document was raised against and are pure metadata — they change no amount, no tax head and no ledger entry. Distinct from p_reference_number, which is the counterparty''s own document reference.';


-- ----------------------------------------------------------------------------
-- 5. public.update_invoice — the same two trailing optional arguments, so the
--    edit screen writes the challan through the same door the new-invoice
--    screen does rather than a second direct table write. Body below is again
--    the LIVE definition, one edit, marked "0865" in place.
--
--    Extending this was not strictly required by the task, and is done
--    anyway: without it, editing an invoice would silently drop a challan
--    number the create screen had just accepted, which is the sort of quiet
--    data loss nobody reports as a bug.
-- ----------------------------------------------------------------------------
drop function if exists public.update_invoice(
  uuid, date, uuid, uuid, uuid, jsonb, text, text, date, bpchar);

create function public.update_invoice(
  p_voucher_id uuid,
  p_voucher_date date,
  p_party_ledger_id uuid,
  p_trading_ledger_id uuid,
  p_godown_id uuid,
  p_items jsonb,
  p_narration text default null,
  p_reference_number text default null,
  p_reference_date date default null,
  p_place_of_supply char(2) default null,
  -- 0865, matching create_invoice argument-for-argument.
  p_challan_number text default null,
  p_challan_date date default null
) returns uuid
language plpgsql
set search_path to ''
as $function$
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

  -- Sec 9(3)/9(4) reverse charge (0102) — mirrors create_invoice exactly,
  -- kept in sync so re-saving an RCM purchase through the invoice editor
  -- does not silently drop its RCM postings the way voucher_items/
  -- voucher_entries desynced before 0055. See create_invoice's own
  -- comment on this block for the full reasoning.
  v_is_rcm_applicable boolean;
  v_line_rcm numeric;
  v_rcm_tax_total numeric := 0;
  v_rcm_ledger uuid;
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

  -- Full replace, not a diff/patch — same discipline update_voucher already
  -- uses for voucher_entries, extended here to voucher_items.
  delete from public.voucher_items where voucher_id = p_voucher_id;
  delete from public.voucher_entries where voucher_id = p_voucher_id;

  update public.vouchers
     set voucher_date = p_voucher_date,
         narration = p_narration,
         reference_number = p_reference_number,
         reference_date = p_reference_date,
         -- 0865: the ONLY change to this body. Same full-replace
         -- semantics narration and reference_number already have — what
         -- the caller passes is what the voucher keeps.
         challan_number = nullif(btrim(p_challan_number), ''),
         challan_date = p_challan_date,
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

    -- Sec 15(3)(a) / Rule 46(k) — see create_invoice for the full reasoning.
    -- Absent from p_items this resolves to exactly 0, so v_amount stays
    -- round(quantity * rate, 2), byte-identical to the pre-0147 formula.
    v_discount_percent := coalesce((v_item->>'discount_percent')::numeric, 0);
    if v_discount_percent < 0 or v_discount_percent > 100 then
      raise exception 'Discount percent must be between 0 and 100, got % for item %',
        v_discount_percent, v_item->>'item_id';
    end if;

    -- Rounded per line, then summed. Summing unrounded and rounding once
    -- would leave the invoice total disagreeing with the lines a reader can
    -- add up.
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
      p_voucher_id, v_company_id, v_branch_id, p_godown_id,
      (v_item->>'item_id')::uuid,
      v_direction, v_qty, coalesce(v_uom, 'NOS'), coalesce(v_rate, 0), v_amount, v_discount_percent,
      v_hsn, v_item->>'description', v_line_no);

    v_line_cgst := 0; v_line_sgst := 0; v_line_igst := 0; v_line_cess := 0;

    if v_gst_on then
      -- RCM (0102) — see create_invoice for the full reasoning. Mutually
      -- exclusive with the ordinary tax branch below, not additional to
      -- it: under reverse charge the supplier charges no tax at all.
      if v_voucher_type = 'purchase' and coalesce(v_is_rcm_applicable, false) then
        v_line_rcm := round(v_amount * (coalesce(v_gst_rate, 0) + coalesce(v_cess_rate, 0)) / 100, 2);
        v_rcm_tax_total := v_rcm_tax_total + v_line_rcm;
      else
        if v_supply_type = 'export_lut' or (v_supply_type = 'sez' and v_lut_active) then
          null;
        elsif v_supply_type = 'export_igst' or (v_supply_type = 'sez' and not v_lut_active) then
          v_line_igst := round(v_amount * coalesce(v_gst_rate, 0) / 100, 2);
          v_line_cess := round(v_amount * coalesce(v_cess_rate, 0) / 100, 2);
        elsif v_intrastate then
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

  -- RCM (0102) — see create_invoice for the full reasoning: liability
  -- leg only, matching debit capitalised into the trading ledger rather
  -- than an Input GST ledger.
  if v_rcm_tax_total > 0 then
    v_rcm_ledger := app_private.tax_ledger(v_company_id, 'rcm_payable', v_registration_id);
    if v_rcm_ledger is null then
      raise exception 'No RCM Payable ledger configured for this registration. Seed the GST ledgers for it first.';
    end if;
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      p_voucher_id, v_company_id, v_branch_id, v_rcm_ledger,
      0, v_rcm_tax_total, v_entry_line);
    v_entry_line := v_entry_line + 1;

    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      p_voucher_id, v_company_id, v_branch_id, p_trading_ledger_id,
      v_rcm_tax_total, 0, v_entry_line);
    v_entry_line := v_entry_line + 1;
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
$function$;

revoke all on function public.update_invoice(
  uuid, date, uuid, uuid, uuid, jsonb, text, text, date, bpchar, text, date) from public, anon;
grant execute on function public.update_invoice(
  uuid, date, uuid, uuid, uuid, jsonb, text, text, date, bpchar, text, date) to authenticated, service_role;

comment on function public.update_invoice(
  uuid, date, uuid, uuid, uuid, jsonb, text, text, date, bpchar, text, date) is
  'Re-posts an existing invoice from scratch — voucher_items and voucher_entries are deleted and rebuilt together, never patched. p_challan_number/p_challan_date (0865) follow the same full-replace rule as p_narration: what the caller passes is what the voucher keeps.';


-- ----------------------------------------------------------------------------
-- 6. PostgREST caches the schema, including function signatures. Without this
--    the two new arguments 404 from the browser until the pooler happens to
--    restart — a real trap hit in a previous session.
-- ----------------------------------------------------------------------------
notify pgrst, 'reload schema';
