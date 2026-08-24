-- ============================================================================
-- 0102 — Reverse Charge Mechanism (Sec 9(3) and Sec 9(4), CGST Act)
-- ============================================================================
-- rcm_payable has existed as a seeded ledger since 0006, in tax_ledger_map
-- since (verified live: 11 rows, one per company/registration, purpose
-- 'rcm_payable') — and has never once been posted to. Verified live before
-- writing this migration: zero rows in voucher_entries join to any ledger
-- named 'RCM Payable%'. create_invoice had zero occurrences of rcm, reverse
-- or registration_type in its body (pg_get_functiondef, read fresh this
-- session, not recalled from an old note). The generic voucher form already
-- lets a preparer pick the rcm_payable ledger by hand, so this was never
-- "unrepresentable" — it was "no flag, no automation, no validation": a
-- preparer had to know RCM applied, know the rate, and post it manually,
-- with nothing checking whether they did.
--
-- THE THREE-WAY CONSEQUENCE OF GETTING THIS WRONG, STATED PLAINLY BECAUSE
-- IT IS NOT OBVIOUS. A missed RCM entry does not just understate one number.
-- It understates THREE, differently:
--   1. GST PAYABLE is understated — the self-assessed tax the recipient owes
--      the government under Sec 9(3)/9(4) was simply never recognised.
--   2. RCM LIABILITY is understated or absent outright — rcm_payable sat at
--      zero for every company, which is not "no RCM transactions occurred"
--      so much as "none were ever captured".
--   3. ITC POSITION is mismatched — if a preparer nonetheless claimed input
--      credit on the same transaction (because the item still carried a GST
--      rate and "felt like" a normal taxable purchase), that credit was
--      claimed with no corresponding self-assessed liability ever having
--      been posted to fund it, which is exactly backwards from what Sec 16
--      read with Sec 49(4) requires.
-- All three are wrong simultaneously, in different directions, from one
-- missed classification. This migration's job is (1) and (2); see below for
-- exactly how (3) is handled — deliberately not by fabricating an instant
-- credit.
--
-- STATUTORY RESEARCH, LIVE THIS SESSION — TWO SEPARATE PROVISIONS, NOT ONE.
--
-- Sec 9(3): a NOTIFIED LIST of goods/services, RCM-liable regardless of the
-- supplier's own registration status. Principal notifications 4/2017-CT(R)
-- (goods) and 13/2017-CT(R) (services), amended repeatedly since. Confirmed
-- current as of this session (Aug 2026): GTA freight (where the GTA has not
-- opted to pay forward charge), legal services from an advocate/firm of
-- advocates, services by a director to the company (in that capacity),
-- security services from a non-corporate supplier to a registered person,
-- rent-a-cab from a non-corporate supplier, and — the most recent addition
-- confirmed by a second, skeptical search — METAL SCRAP (CTH 72/73/74/75/76/
-- 77/78/79/80/81) purchased from an UNREGISTERED person, added by
-- Notification 06/2024-CT(R) w.e.f. 10 Oct 2024, itself still a Sec 9(3)
-- notification (not 9(4)) — the notified condition ("from an unregistered
-- person") is baked into the notification's own text, not a separate
-- app-level registration check.
--
-- SPONSORSHIP SERVICES — CAUGHT MID-RESEARCH, A REAL "IT USED TO BE, NOW IT
-- ISN'T" TRAP. A first search returned sponsorship as a standing 9(3) RCM
-- item, which is the pre-2025 answer and would have been wrong to ship. A
-- second, skeptical search on the sponsorship point specifically found
-- Notification 07/2025-CT(R), effective 16 Jan 2025: sponsorship services
-- supplied by a BODY CORPORATE moved to FORWARD charge; only sponsorship
-- from a NON-body-corporate supplier remains under RCM. Not represented as
-- its own switch here — see "WHAT THIS DOES NOT AUTOMATE" below; a preparer
-- flagging a sponsorship item is_rcm_applicable is asserting the supplier is
-- not a body corporate, the same judgement itc_blocked_clause (0082) already
-- asks a preparer to make about which Sec 17(5) limb applies.
--
-- Sec 9(4): NOT a general "any registered person buying from any
-- unregistered supplier" rule, and getting this wrong would have been the
-- textbook "obvious but wrong" mistake this codebase has been burned by
-- before. Its history: broad from 1 Jul 2017, suspended by notification from
-- 13 Oct 2017, and reinstated from 1 Feb 2019 — but in a MUCH NARROWER form
-- that remains in force today, confirmed live and cross-checked against a
-- second source: Notification 07/2019-CT(R) restricts it to "PROMOTERS"
-- (RERA Sec 2(zk) meaning) purchasing goods/services for a real estate
-- project, subject to the 80:20 rule (RCM applies on the shortfall below 80%
-- procurement from registered suppliers); Notification 24/2019-CT(R) adds
-- CEMENT specifically — ANY amount of cement bought by a promoter from an
-- unregistered supplier is RCM-liable, no 80:20 threshold. Outside real
-- estate promoters, Sec 9(4) currently reaches nothing. A company that is
-- not a RERA promoter owes no Sec 9(4) RCM on an unregistered vendor, full
-- stop, however "unregistered supplier" that vendor is.
--
-- THE DECISION THIS FORCES: gst_registration_type = 'unregistered' ON A
-- PARTY LEDGER (0087) IS DELIBERATELY *NOT* WIRED AS AN AUTOMATIC RCM
-- TRIGGER IN create_invoice. LEKHA has no "is this company a RERA promoter"
-- flag and no "is this item a construction input" classification — and
-- fabricating one by treating every purchase from an unregistered-type
-- ledger as RCM-liable would misstate the books for every non-promoter
-- company in this database (which, per the live company list, is all ten
-- seeded companies) far worse than the current silent gap does: it would
-- invent a real, wrong, government-facing tax liability on ordinary
-- purchases (stationery, one-off services) from any unregistered vendor,
-- for businesses the law does not touch at all. Sec 9(4) is instead reached
-- through the SAME mechanism as Sec 9(3): a genuine real-estate promoter
-- flags their own "Cement — RCM (Promoter)" or equivalent construction-input
-- item is_rcm_applicable, the identical manual, item-level judgement 0082
-- already asks preparers to make for Sec 17(5) blocked credits. This is
-- said explicitly here, and in the column comment, rather than silently
-- shipping a rule that is right for a narrow sector and wrong for
-- everyone else.
--
-- THE FLAG: items.is_rcm_applicable boolean, default false. On the ITEM,
-- not the ledger or the voucher, for the same reason 0082 put
-- itc_eligibility on items rather than on vouchers or parties: RCM
-- liability (for the notified list) is a property of WHAT is being bought,
-- not who it is bought from — a GTA's freight is RCM-liable however the GTA
-- is registered — so the item master is where the fact needs to be stated
-- exactly once, by a preparer who understands their own notified-list or
-- promoter situation.
--
-- ITC ON RCM TAX — THE Sec 49(4) PAID-IN-CASH PRECONDITION, RESEARCHED
-- LIVE, AND WHY THIS MIGRATION DOES NOT FABRICATE A SAME-VOUCHER CREDIT.
-- Sec 49(4): amounts in the electronic credit ledger may be used only for
-- OUTPUT TAX, and reverse-charge tax is explicitly excluded from "output
-- tax" for this purpose (this is exactly the reasoning 0090's header already
-- gives for excluding rcm_payable from GST set-off). RCM liability must
-- therefore be discharged in CASH; only once actually paid does it become
-- available as ordinary input credit. The standard textbook journal entry
-- (confirmed by search) books Dr Input CGST/SGST + Dr Purchase / Cr Supplier
-- + Cr GST Payable (RCM) in one line, on the working assumption that the
-- cash discharge happens through the same GSTR-3B cycle — but LEKHA has NO
-- event, anywhere in this schema, that represents "this specific RCM
-- liability was actually remitted in cash". There is no linkage between a
-- later payment voucher and a specific create_invoice call's self-assessed
-- tax. Posting Dr Input CGST/SGST/IGST here regardless would let
-- get_gst_setoff_clearing (0090) — which reads input_cgst/input_sgst/
-- input_igst uniformly regardless of source — treat it as usable for
-- output-tax set-off in the SAME period the purchase was entered, with no
-- cash ever having moved. That is precisely the fabricated, overstated
-- credit the task that produced this migration was written to avoid.
--
-- SO: this migration posts the LIABILITY LEG ONLY. Cr rcm_payable for the
-- self-assessed tax, matched by a Dr to the SAME trading/purchase ledger
-- the taxable value already uses — i.e. the RCM tax is capitalised into the
-- cost of the purchase, exactly as Ind AS/AS 2 already treats any
-- non-recoverable (or not-yet-recoverable) duty or tax at the time of
-- acquisition. No Input CGST/SGST/IGST leg is posted. THIS IS A DOCUMENTED
-- GAP, NOT A FINAL ANSWER: once a business actually pays its RCM liability
-- in cash (a separate payment voucher, Dr rcm_payable / Cr bank — already
-- fully representable with existing functionality, not new here), Sec 16
-- read with Rule 36(1)(b) makes the tax available as ITC, and a preparer
-- must pass a MANUAL journal entry at that point (Dr Input CGST/SGST/IGST,
-- Cr the trading ledger, reversing the capitalisation) to actually claim
-- it. This migration does not automate that reclassification — seeing "this
-- RCM payable line was settled, therefore reclassify this specific prior
-- capitalised amount" is a real, separate piece of schema work (a linkage
-- between an rcm_payable settlement and the originating purchase voucher)
-- that is out of scope here. See scope_deferred.
--
-- rcm_payable IS A SINGLE, UNSPLIT LEDGER PER REGISTRATION — pre-existing
-- from 0006, not something this migration changes. Unlike input_cgst/
-- input_sgst/input_igst, there is no rcm_payable_cgst/sgst/igst split, so
-- this migration posts ONE combined self-assessed-tax figure per line
-- (item amount x (gst_rate_percent + cess_rate_percent), independent of
-- the intrastate/interstate CGST+SGST-vs-IGST split the ordinary tax
-- computation uses — that split only matters for WHICH ledgers get funded,
-- and rcm_payable is the only one here). A preparer needing GSTR-3B Table
-- 3.1(d)'s integrated/central/state breakup can derive it from the same
-- rate and taxable value already sitting on voucher_items; this migration
-- does not separately post it, the same class of gap 0090 already accepted
-- for not splitting rcm_payable by head.
--
-- WHAT THIS DOES NOT AUTOMATE (scope_deferred, stated here and repeated in
-- the session report):
--   * update_invoice is patched identically (see below) so editing an RCM
--     purchase does not silently drop its RCM postings — but debit_note
--     purchases are NOT covered (create_invoice's own case statement gives
--     debit_note v_tax_prefix = 'input' but this migration only triggers
--     RCM computation for p_voucher_type = 'purchase', matching the task
--     that produced it).
--   * The cost-to-Input-GST reclassification once RCM tax is actually paid
--     in cash is a manual journal entry a preparer passes; not automated.
--   * Sec 9(4)'s 80:20 threshold test and the "is this company a RERA
--     promoter" fact are not modelled or validated — a promoter is trusted
--     to flag only what actually qualifies, the same trust model 0082 uses
--     for Sec 17(5) blocked-credit clauses.
--   * No UI is built in this migration for setting is_rcm_applicable on an
--     item, or a report surfacing RCM liability by period — both are
--     straightforward additions to the existing item master and GST
--     registers screens, left for a follow-up.
-- ============================================================================

alter table public.items
  add column if not exists is_rcm_applicable boolean not null default false;

comment on column public.items.is_rcm_applicable is
  'Reverse charge under Sec 9(3) CGST Act (notified goods/services — GTA freight, legal services from an advocate, director''s services, non-corporate security services, non-corporate sponsorship, metal scrap from an unregistered person, etc.), or the narrow Sec 9(4) real-estate-promoter case (construction inputs/cement from an unregistered supplier, Notifications 07/2019 and 24/2019-CT(R)) represented the same way. A manual, item-level classification — like itc_blocked_clause (0082), the preparer''s own judgement about which notified category or promoter condition applies, not something this schema derives. Deliberately NOT triggered by ledgers.gst_registration_type = ''unregistered'' alone: Sec 9(4) is not a general rule for purchases from any unregistered supplier, and treating it as one would fabricate RCM liability for the vast majority of businesses this app serves, who are not RERA promoters. See 0102.';

-- ----------------------------------------------------------------------------
-- create_invoice — additive only. Every branch reachable when no item on a
-- voucher carries is_rcm_applicable = true is untouched: same declarations,
-- same statements, same order, same entries. Verified live in this
-- session's report against real pre-existing vouchers.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_invoice(p_company_id uuid, p_branch_id uuid, p_voucher_type text, p_voucher_date date, p_party_ledger_id uuid, p_trading_ledger_id uuid, p_godown_id uuid, p_items jsonb, p_narration text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_reference_date date DEFAULT NULL::date, p_place_of_supply character DEFAULT NULL::bpchar, p_txn_currency character DEFAULT 'INR'::bpchar, p_exchange_rate numeric DEFAULT 1, p_rate_source text DEFAULT NULL::text)
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

    v_amount := round(v_qty * coalesce(v_rate, 0), 2);
    v_taxable_total := v_taxable_total + v_amount;

    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable
      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section, v_is_rcm_applicable
      from public.items where id = (v_item->>'item_id')::uuid;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, hsn_sac, description, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, p_godown_id,
      (v_item->>'item_id')::uuid,
      v_direction, v_qty, coalesce(v_uom, 'NOS'), coalesce(v_rate, 0), v_amount,
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

comment on function public.create_invoice is
  'Creates a sales/purchase/credit_note/debit_note voucher with GST, TCS and (0102) reverse-charge posting. RCM: on a purchase, any item line flagged is_rcm_applicable posts the self-assessed tax as a liability to rcm_payable (Cr), matched by a Dr to the trading ledger (capitalised as cost) rather than to Input CGST/SGST/IGST — the Sec 49(4) paid-in-cash precondition for RCM ITC is not modelled by this schema, so no same-voucher input credit is fabricated; see 0102 for the full reasoning and the manual reclassification step once the liability is actually paid.';

-- ----------------------------------------------------------------------------
-- update_invoice — identical RCM logic, additive only, kept in sync with
-- create_invoice so re-saving an RCM purchase through the invoice editor
-- does not silently drop its RCM postings (the same class of desync 0055
-- fixed between voucher_items and voucher_entries). Not named in the task
-- that produced this migration, patched anyway because leaving it out would
-- have left a live, easily-triggered regression: edit any RCM purchase and
-- its RCM entries vanish on save. Every branch reachable when no item on a
-- voucher carries is_rcm_applicable = true is otherwise untouched.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_invoice(p_voucher_id uuid, p_voucher_date date, p_party_ledger_id uuid, p_trading_ledger_id uuid, p_godown_id uuid, p_items jsonb, p_narration text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_reference_date date DEFAULT NULL::date, p_place_of_supply character DEFAULT NULL::bpchar)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

    -- Rounded per line, then summed. Summing unrounded and rounding once
    -- would leave the invoice total disagreeing with the lines a reader can
    -- add up.
    v_amount := round(v_qty * coalesce(v_rate, 0), 2);
    v_taxable_total := v_taxable_total + v_amount;

    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable
      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section, v_is_rcm_applicable
      from public.items where id = (v_item->>'item_id')::uuid;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, hsn_sac, description, line_order)
    values (
      p_voucher_id, v_company_id, v_branch_id, p_godown_id,
      (v_item->>'item_id')::uuid,
      v_direction, v_qty, coalesce(v_uom, 'NOS'), coalesce(v_rate, 0), v_amount,
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

comment on function public.update_invoice is
  'Re-saves a sales/purchase/credit_note/debit_note voucher: full replace of voucher_items and voucher_entries from the submitted item list, including (0102) reverse-charge posting, kept identical to create_invoice''s RCM handling. See 0102.';

notify pgrst, 'reload schema';
