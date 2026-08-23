-- ============================================================================
-- 0087 — Zero-rated supplies: export, SEZ and deemed export (audit item T2-1)
-- ============================================================================
-- vouchers.supply_type has allowed 'export_lut', 'export_igst', 'sez' and
-- 'deemed_export' since 0018, and ledgers.gst_registration_type has allowed
-- 'sez' / 'sez_developer' / 'overseas' / 'deemed_export' since 0006 — but
-- nothing has ever written any of the four, and no UI has ever set a
-- registration type other than the 'regular' a trigger silently applies the
-- moment a GSTIN is attached. Confirmed again just now, live:
--
--   select supply_type, count(*) from vouchers group by 1;
--     -> only 'intra' and null, nothing else, ever.
--   select gst_registration_type, count(*) from ledgers group by 1;
--     -> only null (no ledger has ever carried a value here).
--
-- THE LAW THIS ENCODES (Sec 16 IGST Act 2017, Sec 147 CGST Act 2017).
--
-- "Zero-rated supply" is defined by Sec 16(1) IGST Act as exactly two things:
-- export of goods/services, and supply to an SEZ unit/developer. Sec 16(3)
-- gives the registered person a CHOICE of route for either:
--   (a) supply under LUT/bond, WITHOUT paying tax, and claim refund of
--       unutilised ITC (Rule 96A) — this is 'export_lut' / zero-tax SEZ.
--   (b) supply ON PAYMENT of integrated tax, and claim refund of the tax
--       itself (Rule 96) — this is 'export_igst' / IGST-charged SEZ.
-- Sec 7(5)(a)/(b) IGST Act deems BOTH an export and a supply to an SEZ to be
-- an INTER-STATE supply, regardless of where the supplier and the recipient
-- actually sit — an SEZ unit next door in the same State is still charged
-- IGST if route (b) is used, never CGST+SGST. Sourced against
-- https://taxinformation.cbic.gov.in (Sec 16, live text) and the GST
-- Council's own "Zero rating of supplies" flyer, both read today.
--
-- DEEMED EXPORTS ARE A DIFFERENT ANIMAL AND MUST NOT BE ZERO-RATED. Sec 147
-- CGST Act (Notification 48/2017-CT) lists specified domestic supplies —
-- against Advance Authorisation/EPCG, and to EOU/EHTP/STP/BTP units — that
-- are treated as exports for REFUND purposes only. Confirmed by a second,
-- skeptical search of Rule 89(1)'s third proviso: deemed exports CANNOT be
-- made under LUT/bond, full GST must be paid at the time of supply exactly
-- as any other domestic sale, and only the tax already paid is refunded
-- afterwards (to the supplier or the recipient). So a deemed-export sale
-- keeps the ordinary CGST+SGST/IGST split by the real place of supply — the
-- only thing that changes is the supply_type label written for GSTR-1's
-- benefit, never the tax computed. This is the one place this migration
-- deliberately does NOT zero the tax.
--
-- LUT FIELDS ON gst_registrations, NOT on companies. An LUT (Form GST RFD-11
-- under Rule 96A) is filed and accepted per GSTIN, not per company, and a
-- multi-registration company can have one branch under LUT while another
-- has none yet. It is also ANNUAL — valid for exactly one financial year
-- (1 April to 31 March), a fresh RFD-11 due before the LUT lapses — so
-- lut_valid_from/lut_valid_to are real dates the tax computation checks
-- against the voucher date, not a standing boolean. ARN (Application
-- Reference Number) is the portal's own acknowledgement, generated
-- immediately on filing with no manual approval step — recorded here purely
-- as the audit trail entry, never validated by format since the portal's own
-- ARN scheme is not publicly documented well enough to pattern-check safely.
-- Sourced against caclubindia's Rule 96A / RFD-11 guide and eximpe's LUT
-- explainer, both read today; both agree independently on annual validity
-- and the ARN-on-filing behaviour.
--
-- THE 'sez' SUPPLY_TYPE VALUE DOES NOT DISTINGUISH ROUTE (a) FROM ROUTE (b),
-- UNLIKE EXPORTS. That is not this migration's choice — 0018's CHECK
-- constraint on vouchers.supply_type already allows only ONE 'sez' value,
-- not a pair the way exports get export_lut/export_igst. GSTR-1 Table 6B's
-- own JSON schema does carry a WPAY/WOPAY flag per SEZ invoice, so widening
-- the CHECK to add 'sez_lut'/'sez_igst' would be the right long-term fix —
-- deliberately NOT done here, because Table 6A/6B/6C reporting is out of
-- scope for this migration (see below) and inventing a second enum split
-- with nothing downstream reading it yet would be schema for its own sake.
-- The TAX actually posted on an SEZ invoice is still fully correct either
-- way (zero under an active LUT, full IGST without one) — only the
-- CATEGORICAL TAG on the voucher can't yet tell the two apart by itself.
--
-- WHAT THIS MIGRATION DOES NOT DO.
--   - GSTR-1 Table 6A/6B/6C reporting of these supplies — a report-building
--     task on top of this, not part of making the fact representable.
--   - Shipping-bill number / port code capture for exports.
--   - Rule 89(4) refund-computation (the turnover-ratio formula that decides
--     how much of a period's ITC a zero-rated exporter can actually claim
--     back) — a separate, substantial report.
--   - Widening vouchers.supply_type's CHECK for the SEZ WPAY/WOPAY split
--     noted above.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. LUT fields on gst_registrations
-- ----------------------------------------------------------------------------
alter table public.gst_registrations
  add column if not exists lut_number text,
  add column if not exists lut_valid_from date,
  add column if not exists lut_valid_to date,
  add column if not exists lut_arn text;

alter table public.gst_registrations
  drop constraint if exists gst_registrations_lut_dates_check;

alter table public.gst_registrations
  add constraint gst_registrations_lut_dates_check
  check (lut_valid_to is null or lut_valid_from is null or lut_valid_to >= lut_valid_from);

comment on column public.gst_registrations.lut_number is
  'LUT reference number from Form GST RFD-11 (Rule 96A) for this GSTIN — lets exports/SEZ supplies go out without paying IGST upfront. Per-GSTIN, not per-company: a multi-registration business can have LUT on one registration and not another. See 0087.';

comment on column public.gst_registrations.lut_valid_from is
  'LUT is annual (1 Apr - 31 Mar). This and lut_valid_to bound the window create_invoice checks the voucher date against — an expired or not-yet-effective LUT falls back to the IGST-refund route automatically. See 0087.';

comment on column public.gst_registrations.lut_valid_to is
  'See lut_valid_from. Nullable only so a freshly-filed LUT can be recorded before its end date is re-typed in; leave it set once known — an open-ended LUT is not how Rule 96A works.';

comment on column public.gst_registrations.lut_arn is
  'Application Reference Number the GST portal generates on filing RFD-11 — audit trail only, not format-checked (the portal''s ARN scheme is not documented precisely enough to pattern-match safely).';

-- ----------------------------------------------------------------------------
-- 2. gst_supply_type: extended, not replaced. The 2-argument shape every
--    existing caller (0018, 0027, 0055, 0065's now-superseded copy) uses
--    keeps working unchanged — the two new parameters are appended with
--    defaults, which Postgres allows on CREATE OR REPLACE without touching
--    the function's OID, so nothing else needs migrating just to compile.
-- ----------------------------------------------------------------------------
create or replace function app_private.gst_supply_type(
  p_supplier_state char(2),
  p_place_of_supply char(2),
  p_party_registration_type text default null,
  p_lut_active boolean default null
)
returns text
language sql
immutable parallel safe
set search_path to ''
as $function$
  select case
    -- Sec 16(1)(a) IGST Act — export of goods/services to a place outside
    -- India. Route (a)/(b) choice per Sec 16(3), decided by whether the
    -- registration used for this voucher has an LUT active on the voucher
    -- date (the caller resolves that boolean, not this function — it has no
    -- date to check against).
    when p_party_registration_type = 'overseas' then
      case when coalesce(p_lut_active, false) then 'export_lut' else 'export_igst' end
    -- Sec 16(1)(b) — supply to an SEZ unit or developer. Same two routes,
    -- but vouchers.supply_type has only one 'sez' value for both — see this
    -- migration's header for why that split isn't added here.
    when p_party_registration_type in ('sez', 'sez_developer') then 'sez'
    -- Sec 147 CGST Act — a notified DOMESTIC supply treated as an export
    -- only for refund eligibility. Tagged for GSTR-1, but the tax itself is
    -- computed the ordinary way by the caller (see create_invoice below) —
    -- this branch exists so the label is right, not so the caller special-
    -- cases the rate.
    when p_party_registration_type = 'deemed_export' then 'deemed_export'
    when p_supplier_state = p_place_of_supply then 'intra'
    else 'inter'
  end;
$function$;

comment on function app_private.gst_supply_type(char, char, text, boolean) is
  'Classifies a supply for vouchers.supply_type. Ordinary domestic sales (party registration null/regular/composition/unregistered/uin) still resolve to plain intra/inter by state comparison, byte-identical to the pre-0087 behaviour. overseas/sez/sez_developer/deemed_export parties route through Sec 16 IGST Act / Sec 147 CGST Act instead. See 0087.';

revoke all on function app_private.gst_supply_type(char, char, text, boolean) from public, anon;
grant execute on function app_private.gst_supply_type(char, char, text, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 3 & 4. create_invoice and update_invoice — the tax computation branch.
--
-- Both functions are patched identically and for the same reason 0055's own
-- header gives: "these two match" is the only source of truth linking them,
-- there is no shared helper, so a change to one without the other is a bug
-- the moment someone edits a zero-rated invoice and watches the tax revert.
--
-- THE CHANGE ITSELF is confined to the block that already decided CGST+SGST
-- vs IGST from v_supply_type. It now also resolves the party ledger's
-- gst_registration_type and, when GST is on, whether the resolved
-- registration has an active LUT for this voucher's date — both feed
-- gst_supply_type's new parameters. A separate v_intrastate boolean is
-- introduced because v_supply_type is no longer purely geographic: for a
-- REGULAR domestic sale v_intrastate is exactly (v_supply_type = 'intra'),
-- so the tax math for every existing sale is unchanged bit for bit; for
-- 'deemed_export' it is what decides CGST+SGST vs IGST per Sec 147 (see
-- header); for 'export_lut'/'export_igst'/'sez' it is not consulted at all,
-- because Sec 7(5) IGST Act deems those inter-State regardless of the real
-- states, and LUT status alone decides zero vs full IGST.
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

    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section
      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section
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

    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section
      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section
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
