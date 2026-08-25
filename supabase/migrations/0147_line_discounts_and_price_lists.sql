-- ============================================================================
-- 0147 — Line-level discount + price lists
-- ============================================================================
-- A whole-schema scan (this session's Aug 23 audit) found zero %price%/
-- %discount% columns anywhere across 60 tables, and create_invoice wrote
-- voucher_items with no discount field to write to — every sale or purchase
-- with a negotiated discount had to be entered as a silently-netted lower
-- rate, which is not just a UX gap but a real statutory problem (see below).
-- This is the "most-felt day-to-day gap" per that audit.
--
-- THE LAW (both confirmed live via WebSearch this task, "obvious answer" and
-- a deliberately skeptical second pass — the second pass caught a garbled
-- search-engine summary that inverted Sec 15(3)'s own polarity, see below).
--
-- Sec 15(3) CGST Act 2017 — exact text, confirmed against the bare Act on
-- indiankanoon.org (https://indiankanoon.org/doc/48149503/) after a first
-- search-engine summary rendered it backwards ("value shall include
-- discount...", the opposite of the statute — exactly the kind of mistake
-- this codebase's own audit trail has caught before, hence the mandatory
-- second skeptical pass):
--   "The value of the supply shall not include any discount which is given—
--    (a) before or at the time of the supply if such discount has been duly
--        recorded in the invoice issued in respect of such supply; and
--    (b) after the supply has been effected, if—
--        (i) such discount is established in terms of an agreement entered
--            into at or before the time of such supply and specifically
--            linked to relevant invoices; and
--        (ii) input tax credit as is attributable to the discount on the
--             basis of document issued by the supplier has been reversed by
--             the recipient of the supply."
--
-- Rule 46 CGST Rules 2017 — clause (k) requires a tax invoice to show "the
-- taxable value of the supply of goods or services or both taking into
-- account discount or abatement, if any" — i.e. the invoice must show the
-- NET taxable value, and (per the Sec 15(3)(a) condition above) the discount
-- itself must be a distinct, recorded particular for the exclusion to apply
-- at all. Netting a discount silently into a lower "rate" with nothing on
-- the document identifying it AS a discount does not satisfy "duly recorded"
-- — it just looks like a lower price, and on audit there is no paper trail
-- showing Sec 15(3)(a)'s condition was met. Sourced against getswipe.in's
-- and studycafe.in's Rule 46 breakdowns, both read today, both agreeing on
-- clause (k)'s wording.
--
-- SCOPE: Sec 15(3)(a) ONLY (pre/at-supply discount, recorded on the invoice
-- itself) is what this migration implements. Sec 15(3)(b) — a POST-supply
-- discount, valid only under a pre-existing written agreement specifically
-- linked to the invoices it applies to, AND only if the recipient has
-- reversed the proportionate ITC — is deliberately OUT OF SCOPE here. It is
-- not a line-entry feature at all: it needs (i) an agreement/contract record
-- this schema has no home for, (ii) a credit note referencing the ORIGINAL
-- invoice by number (this app's credit_note voucher type already exists and
-- can be used for this today, entered as an ordinary credit note against the
-- item at the discounted differential), and (iii) proof of the recipient's
-- ITC reversal, which is the recipient's own GSTR-3B Table 4(B) action, not
-- something the supplier's books can observe or enforce. Building a
-- half-implementation of 15(3)(b) — capturing the agreement but not the ITC-
-- reversal evidence CBIC's own 2024 circular now requires (a CA/CMA
-- certificate with UDIN, per the taxguru/ascgroup sources read during this
-- task's research) — would look done without being done. Said explicitly
-- here and in scope_deferred, not silently assumed away.
--
-- ----------------------------------------------------------------------------
-- DESIGN: discount_percent is the PRIMARY, user-entered representation;
-- discount_amount is DERIVED (generated column) for display and reporting.
-- ----------------------------------------------------------------------------
-- Justification, against this schema's own existing rate x quantity
-- convention: every line here is already "unit rate x quantity", the same
-- convention Tally and virtually every Indian invoicing product uses for its
-- own "Disc %" column — a percentage scales naturally with quantity (if the
-- user later edits quantity, a percent discount is still the same intended
-- deal; a frozen rupee discount would silently become a different effective
-- deal). A flat rupee discount per line is real too (a landlord knocking
-- ₹50 off flat) but is the less common case in this schema's own domain
-- (wholesale/retail trade items, not services with irregular ad-hoc
-- deductions) and can still be entered by typing the equivalent percent —
-- asking for one primary input, not two that could disagree, is the
-- "simplest shape first" choice this session's other features have
-- consistently made. discount_amount is generated straight off
-- (quantity, rate, discount_percent) — never a second independent input —
-- so the two can never drift apart the way two separately-typed fields
-- could.
--
-- amount_before_discount is ALSO generated (quantity x rate, unrounded-then-
-- rounded exactly as the pre-existing 'amount' column always was) purely so
-- the invoice UI/print page can show Gross, Discount and Net as three
-- distinct particulars per Rule 46(k) without recomputing rate x quantity
-- itself in three different places.
--
-- 'amount' ITSELF IS UNCHANGED IN MEANING: it was always "this line's
-- contribution to the taxable total", and it still is — now correctly NET of
-- discount rather than implicitly zero-discount. No downstream report reads
-- voucher_items.rate x quantity and recomputes its own total (confirmed by
-- grep across every migration that touches voucher_items — every reader
-- either reads .amount directly or doesn't touch amounts at all), so nothing
-- outside create_invoice/update_invoice needed to change.
--
-- 'amount' remains a PLAIN column, not generated, deliberately: several
-- other functions (job work, manufacturing/BOM, delivery challans) insert
-- into voucher_items directly with their own valuation logic that does not
-- always satisfy amount = round(quantity * rate, 2) to the cent — BOM's own
-- co-product cost allocation (0114) reverse-engineers a 4-decimal rate FROM
-- an already-decided rupee share, which can legitimately differ from
-- round(quantity * that_rate, 2) by a paisa. A CHECK constraint tying amount
-- to the generated columns was considered and rejected for exactly this
-- reason — it would have risked breaking a live, working, unrelated feature
-- for a constraint this migration does not need (none of those call sites
-- ever set discount_percent away from its default 0, so their
-- discount_amount is always 0 and their own amount stays exactly what it
-- already was).
--
-- ----------------------------------------------------------------------------
-- REGRESSION SAFETY (mandatory per this task's own brief): every existing
-- invoice, and every future invoice from a code path that does not yet know
-- about discounts, must post byte-identical amounts.
-- ----------------------------------------------------------------------------
-- discount_percent defaults to 0 at the column level AND is read from
-- p_items via coalesce((v_item->>'discount_percent')::numeric, 0) in both
-- create_invoice and update_invoice — a caller that never sends the key
-- (every existing InvoiceForm request until this migration ships its own UI
-- change, bulk_invoices, POS quick billing, and any other future caller of
-- create_invoice that has not been taught about discounts) gets exactly 0,
-- so v_gross_amount - v_discount_amount = v_gross_amount - 0 =
-- round(quantity * rate, 2) — bit-for-bit the old formula. Verified live
-- against real pre-existing vouchers below, not just argued from the code.
--
-- ----------------------------------------------------------------------------
-- PRICE LISTS: price_lists (header) + price_list_items (item, price,
-- effective_from) — a simple rate-per-item table, not a slab/customer-tier
-- system. Multiple named lists per company are supported (a business
-- commonly has a retail list and a distributor list) because that costs
-- nothing extra in the schema, but at most one may be is_default — the one
-- InvoiceForm reads for its convenience rate-prefill, so the UI never has to
-- ask "which list" just to suggest a number. effective_from lets a price
-- change be scheduled/back-dated without losing the prior rate's history —
-- get_effective_item_price picks the latest row on or before the date asked
-- for, mirroring how create_invoice itself resolves LUT validity by date
-- (0087) rather than a single mutable flag.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Discount columns on voucher_items
-- ----------------------------------------------------------------------------
alter table public.voucher_items
  add column if not exists discount_percent numeric(5, 2) not null default 0
    check (discount_percent >= 0 and discount_percent <= 100);

alter table public.voucher_items
  add column if not exists amount_before_discount numeric(18, 2)
    generated always as (round(quantity * rate, 2)) stored;

alter table public.voucher_items
  add column if not exists discount_amount numeric(18, 2)
    generated always as (round(quantity * rate * discount_percent / 100, 2)) stored;

comment on column public.voucher_items.discount_percent is
  'Line-level discount, PRIMARY representation (Sec 15(3)(a) CGST Act pre/at-supply discount, "duly recorded in the invoice"). 0 for every line that carries none — the default for every existing row and every caller that does not pass discount_percent, which is what keeps pre-0147 invoices posting byte-identical. See 0147.';

comment on column public.voucher_items.amount_before_discount is
  'Generated, display-only: round(quantity * rate, 2) — the gross line value BEFORE discount. amount (unchanged column) is the NET taxable value create_invoice/update_invoice actually post and tax. Not used by any tax computation — only by the invoice UI/print page to show Gross/Discount/Net as three distinct Rule 46(k) particulars. See 0147.';

comment on column public.voucher_items.discount_amount is
  'Generated, display-only: round(quantity * rate * discount_percent / 100, 2) — the rupee discount, shown as its own distinct particular per Rule 46(k) rather than netted silently into rate. Derived from discount_percent, never a second independent input. See 0147.';

-- ----------------------------------------------------------------------------
-- 2. price_lists — header
-- ----------------------------------------------------------------------------
create table public.price_lists (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  unique (company_id, name)
);

-- At most one default per company — the one InvoiceForm reads for its
-- convenience rate-prefill, so that lookup never has to ask "which list".
create unique index price_lists_one_default_per_company_idx
  on public.price_lists (company_id) where is_default;

create index price_lists_company_idx on public.price_lists (company_id);

create trigger set_updated_at before update on public.price_lists
  for each row execute function app_private.set_updated_at();

alter table public.price_lists enable row level security;

create policy price_lists_read on public.price_lists
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy price_lists_write on public.price_lists
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.price_lists is
  'A named, company-scoped price list (e.g. "Retail", "Distributor"). At most one per company may be is_default (partial unique index) — that is the one the invoice line-item entry screen reads for its rate-prefill convenience. Item-level rates live in price_list_items. See 0147.';

-- ----------------------------------------------------------------------------
-- 3. price_list_items — item, price, effective_from
-- ----------------------------------------------------------------------------
create table public.price_list_items (
  id uuid primary key default gen_random_uuid(),
  price_list_id uuid not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  item_id uuid not null,
  price numeric(18, 2) not null check (price >= 0),
  effective_from date not null default current_date,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, company_id),
  unique (price_list_id, item_id, effective_from),
  foreign key (price_list_id, company_id) references public.price_lists (id, company_id) on delete cascade,
  foreign key (item_id, company_id) references public.items (id, company_id) on delete cascade
);

create index price_list_items_lookup_idx
  on public.price_list_items (company_id, item_id, effective_from desc);

alter table public.price_list_items enable row level security;

create policy price_list_items_read on public.price_list_items
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy price_list_items_write on public.price_list_items
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.price_list_items is
  'One item''s price on one price list, effective from a date. A price change is a NEW row (new effective_from), not an update — get_effective_item_price picks the latest row on or before the date asked for, so history is never lost. See 0147.';

-- ----------------------------------------------------------------------------
-- 4. get_effective_item_price — convenience lookup, NOT a hard lock. The
-- invoice line-item screen calls this to PRE-FILL the rate field; the user
-- can always overtype it. security invoker + RLS (not security definer) —
-- the read policies above already scope this correctly per caller, so this
-- function adds no privilege beyond what the caller already has.
-- ----------------------------------------------------------------------------
create or replace function public.get_effective_item_price(
  p_company_id uuid,
  p_item_id uuid,
  p_as_of_date date default current_date,
  p_price_list_id uuid default null
) returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select pli.price
    from public.price_list_items pli
    join public.price_lists pl on pl.id = pli.price_list_id
   where pli.company_id = p_company_id
     and pli.item_id = p_item_id
     and pli.effective_from <= coalesce(p_as_of_date, current_date)
     and pl.is_active
     and (
       (p_price_list_id is not null and pli.price_list_id = p_price_list_id)
       or
       (p_price_list_id is null and pl.is_default)
     )
   order by pli.effective_from desc
   limit 1;
$$;

revoke all on function public.get_effective_item_price(uuid, uuid, date, uuid) from public, anon;
grant execute on function public.get_effective_item_price(uuid, uuid, date, uuid) to authenticated;

comment on function public.get_effective_item_price(uuid, uuid, date, uuid) is
  'Latest price_list_items row for (item, price list or, if none given, the company''s is_default list) with effective_from <= p_as_of_date. Returns null when nothing applies — callers fall back to items.sale_rate/purchase_rate, exactly as before this migration. Convenience lookup only, never enforced. See 0147.';

-- ----------------------------------------------------------------------------
-- 5 & 6. create_invoice and update_invoice — patched in lockstep, the same
-- discipline 0055's own header established and 0087/0102 have followed
-- since: there is no shared helper linking these two, so "they match" is a
-- fact this migration has to re-assert by hand, not something the schema
-- enforces. Read LIVE via pg_get_functiondef(oid) immediately before writing
-- this migration (not from any locally-checked-out copy) — confirmed the
-- live bodies already carry 0102's RCM branch; 0103 (TDS threshold
-- monitoring) is advisory-only and, per its own migration's comment, does
-- NOT touch either function. The only change below is confined to the
-- per-item loop: v_amount now nets the line's discount before it is added
-- to v_taxable_total and before every GST/RCM/TCS branch below it (all of
-- which already consumed v_amount and are otherwise byte-for-byte
-- untouched) — Sec 15(3)(a) makes this the taxable value, not a
-- reinterpretation of what "taxable value" means.
-- ----------------------------------------------------------------------------
create or replace function public.create_invoice(
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
  p_place_of_supply char(2) default null,
  p_txn_currency char(3) default 'INR',
  p_exchange_rate numeric default 1,
  p_rate_source text default null
) returns uuid
language plpgsql
set search_path to ''
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

  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, p_voucher_type, p_voucher_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, reference_number,
    reference_date, party_ledger_id, place_of_supply, supply_type,
    txn_currency, exchange_rate, rate_source, created_by)
  values (
    p_company_id, p_branch_id, p_voucher_type, v_display_number, v_seq,
    v_fy, p_voucher_date, p_narration, p_reference_number,
    p_reference_date, p_party_ledger_id, p_place_of_supply, v_supply_type,
    p_txn_currency, p_exchange_rate, p_rate_source, auth.uid())
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

revoke all on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, char, char, numeric, text) from public, anon;
grant execute on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, char, char, numeric, text) to authenticated;

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

revoke all on function public.update_invoice(uuid, date, uuid, uuid, uuid, jsonb, text, text, date, char) from public, anon;
grant execute on function public.update_invoice(uuid, date, uuid, uuid, uuid, jsonb, text, text, date, char) to authenticated;
