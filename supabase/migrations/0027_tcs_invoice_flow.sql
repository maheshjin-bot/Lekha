-- ============================================================================
-- 0027 — TCS at invoice time: the collection, not just the rate
-- ============================================================================
-- 0023 closed the "the rates don't even exist anywhere" gap and deliberately
-- stopped there: "Wiring TCS collection into create_invoice is real future
-- work, but a deliberately separate, larger change to the app's most
-- complex function." This is that change.
--
-- SHAPE. TCS (Sec 206C) is collected by the SELLER, over and above the sale
-- consideration, and deposited with the government — the mirror image of
-- GST in mechanics (both ride on the same invoice) but opposite in economic
-- direction (GST is a tax ON the value; TCS is collected IN ADDITION to it).
-- It only ever applies on the output side of a sale, so this reuses
-- create_invoice's existing v_tax_prefix = 'output' classification (already
-- true for exactly 'sales' and 'credit_note') rather than introducing a
-- second voucher-type check that could drift from the first.
--
-- LEDGER: 'output_tcs', company-wide (gst_registration_id null, matching
-- how the tax_ledger_map table comment already names "TDS payable" as an
-- example of a company-wide purpose) — TCS is TAN-scoped, not GSTIN-scoped.
-- Named to fit the SAME 'prefix_kind' convention as output_cgst/output_igst
-- specifically so the voucher print page's existing generic tax-breakup
-- code (purpose.split("_")[1]) picks it up with a one-line label addition
-- and no new logic. Auto-provisioned via a trigger on companies.tan — TAN is
-- set through a plain table update (no dedicated RPC exists to hang an
-- explicit call off, unlike GST's add_gst_registration), so this mirrors
-- 0004's own resolve_conditional_modules trigger rather than GST's
-- explicit-call pattern.
--
-- COMPUTATION, per line, only when the tcs module is active on the voucher
-- date and the item carries a default_tcs_section:
--   * Threshold (only TCS-VEHICLE has one): collect only if the line's
--     taxable amount is strictly GREATER than the threshold — Sec 206C(1F)
--     says "value exceeding", not "at or above" — and then on the WHOLE
--     line, not just the excess (0023's own seed comment: "per vehicle, not
--     aggregated"). Every other seeded section has no threshold at all.
--   * Rate: the no-PAN rate if the party ledger has no PAN on file, else the
--     ordinary rate — ledgers.pan already exists (0006).
--   * Base: the line's taxable amount PLUS that line's own GST (CGST+SGST+
--     IGST+Cess) — Sec 206C collects on the full consideration received,
--     which includes GST, not on the taxable value alone.
-- Explicitly NOT modelled, matching 0023's own scope: TCS on purchases
-- (Sec 206C(1H) is repealed and not recodified — see 0023's header), and
-- the seller-side TCS a company might itself suffer as a buyer (Sec 206C
-- has no input-tax-credit-style mechanism the way GST does, so there is no
-- 'input_tcs' counterpart to model).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Auto-provision the "TCS Payable" ledger the first time a company gets a
-- TAN, mirroring seed_gst_ledgers's shape (idempotent, one ledger, wired
-- into tax_ledger_map) but company-wide rather than per-registration.
-- ----------------------------------------------------------------------------
create or replace function app_private.seed_tcs_ledger(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group uuid;
  v_ledger uuid;
begin
  -- A TAN can be edited more than once; a second call must not create a
  -- second "TCS Payable" ledger.
  if exists (
    select 1 from public.tax_ledger_map
     where company_id = p_company_id and purpose = 'output_tcs' and gst_registration_id is null
  ) then
    return;
  end if;

  select id into v_group
    from public.account_groups
   where company_id = p_company_id and ledger_role = 'duty_tax'
   order by sort_order limit 1;
  if v_group is null then
    -- Chart of accounts not seeded yet — should not happen in practice
    -- (seed_chart_of_accounts runs at company creation), but a company mid-
    -- migration is not a reason to fail a TAN update.
    return;
  end if;

  insert into public.ledgers (company_id, group_id, name, opening_balance_type)
  values (p_company_id, v_group, 'TCS Payable', 'credit')
  returning id into v_ledger;

  insert into public.tax_ledger_map (company_id, gst_registration_id, purpose, ledger_id)
  values (p_company_id, null, 'output_tcs', v_ledger);
end;
$$;

create or replace function app_private.trg_seed_tcs_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tan is not null then
    perform app_private.seed_tcs_ledger(new.id);
  end if;
  return new;
end;
$$;

create trigger seed_tcs_ledger_on_tan_set
  after insert or update of tan
  on public.companies
  for each row execute function app_private.trg_seed_tcs_ledger();

-- Backfill: a company that already has a TAN (TDS/TCS already on) but was
-- created before this migration needs the ledger provisioned once, now.
do $$
declare
  v_company record;
begin
  for v_company in select id from public.companies where tan is not null loop
    perform app_private.seed_tcs_ledger(v_company.id);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- create_invoice, extended with TCS. Every line of the existing GST logic
-- is unchanged; TCS is computed alongside it in the same per-item loop and
-- posted as one more tax entry after the GST entries.
-- ----------------------------------------------------------------------------
drop function if exists public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, char);

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
  p_place_of_supply char(2) default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
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
  -- TCS only ever applies on the output side of a sale (see migration
  -- header) — v_tax_prefix = 'output' is exactly 'sales' and 'credit_note'.
  v_tcs_on := v_tax_prefix = 'output' and app_private.module_active(p_company_id, 'tcs', p_voucher_date);

  if v_gst_on then
    v_registration_id := app_private.branch_registration(p_branch_id, p_voucher_date);
    if v_registration_id is null then
      raise exception 'GST is active for this company but branch % has no GST registration attached for %. Attach one before invoicing from it.',
        p_branch_id, p_voucher_date;
    end if;

    select state_code into v_supplier_state
      from public.gst_registrations where id = v_registration_id;

    if p_place_of_supply is not null then
      v_supply_type := app_private.gst_supply_type(v_supplier_state, p_place_of_supply);
    else
      select app_private.gst_supply_type(v_supplier_state, l.state_code), l.state_code
        into v_supply_type, p_place_of_supply
        from public.ledgers l where l.id = p_party_ledger_id;

      if p_place_of_supply is null then
        raise exception 'Cannot determine place of supply: % has no state on file and none was given', p_party_ledger_id;
      end if;
    end if;
  end if;

  if v_tcs_on then
    select pan into v_party_pan from public.ledgers where id = p_party_ledger_id;
  end if;

  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, p_voucher_type, p_voucher_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, reference_number,
    reference_date, party_ledger_id, place_of_supply, supply_type, created_by)
  values (
    p_company_id, p_branch_id, p_voucher_type, v_display_number, v_seq,
    v_fy, p_voucher_date, p_narration, p_reference_number,
    p_reference_date, p_party_ledger_id, p_place_of_supply, v_supply_type, auth.uid())
  returning id into v_voucher_id;

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
      v_voucher_id, p_company_id, p_branch_id, p_godown_id,
      (v_item->>'item_id')::uuid,
      v_direction, v_qty, coalesce(v_uom, 'NOS'), coalesce(v_rate, 0), v_amount,
      v_hsn, v_item->>'description', v_line_no);

    v_line_cgst := 0; v_line_sgst := 0; v_line_igst := 0; v_line_cess := 0;

    if v_gst_on then
      if v_supply_type = 'intra' then
        v_line_cgst := round(v_amount * coalesce(v_gst_rate, 0) / 2 / 100, 2);
        v_line_sgst := v_line_cgst;
        v_line_igst := 0;
      else
        v_line_cgst := 0; v_line_sgst := 0;
        v_line_igst := round(v_amount * coalesce(v_gst_rate, 0) / 100, 2);
      end if;
      v_line_cess := round(v_amount * coalesce(v_cess_rate, 0) / 100, 2);

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
        -- Computed regardless of v_gst_on to avoid picking up a stale value
        -- from a previous loop iteration; v_line_cgst etc. are reset to 0
        -- above every iteration, so this is always correct either way, but
        -- the explicit case reads clearer than trusting that reset alone.
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
    (v_voucher_id, p_company_id, p_branch_id, p_party_ledger_id,
     case when v_party_side = 'debit'  then v_grand_total else 0 end,
     case when v_party_side = 'credit' then v_grand_total else 0 end, 0),
    (v_voucher_id, p_company_id, p_branch_id, p_trading_ledger_id,
     case when v_party_side = 'debit'  then 0 else v_taxable_total end,
     case when v_party_side = 'credit' then 0 else v_taxable_total end, 1);

  v_entry_line := 2;

  if v_gst_on then
    -- Each non-zero tax total gets its own entry, on the same side as the
    -- trading ledger. A missing ledger for a purpose that has money against
    -- it raises by name — this is the one place a silent omission would
    -- understate a tax liability.
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
$$;

revoke execute on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, char) from public, anon;
grant execute on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, char) to authenticated;

comment on function public.create_invoice is
  'Invoicing with GST and TCS both computed and posted in the same transaction as the stock movement. TCS applies only on the output side of a sale (sales, credit_note), per line, gated by the item''s default_tcs_section and the party ledger''s PAN — see the migration header (0027) for the full rule set and what is deliberately not modelled.';
