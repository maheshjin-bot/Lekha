-- ============================================================================
-- 0018 — GST: rates, supply determination, tax posting
-- ============================================================================
-- The determination this whole phase hangs off: intra-state (CGST+SGST) vs
-- inter-state (IGST), decided by comparing the branch's registered state
-- against the place of supply. Every other GST feature — returns, ITC,
-- e-invoicing — reads what this layer posts; it does not compute anything
-- itself.
--
-- Failure here is deliberately loud rather than silent, throughout: a
-- GST-registered branch with no registration attached, a party with no
-- resolvable state, or a purpose with no configured ledger all raise rather
-- than posting an invoice that quietly understates tax. The one thing worse
-- than blocking an invoice is one that looks fine and is not.
-- ============================================================================

-- GST rate is stored on the item, not looked up from HSN: the same HSN code
-- can legitimately carry different rates for different sellers (composition,
-- exemptions, rate changes not yet reflected everywhere), so the rate a
-- business actually charges belongs to the item master, matching how every
-- working accounting product does it.
alter table public.items
  add column gst_rate_percent numeric(5,2) not null default 0 check (gst_rate_percent between 0 and 100),
  add column cess_rate_percent numeric(5,2) not null default 0 check (cess_rate_percent between 0 and 100);

-- Recorded on the voucher itself, not just derivable from the branch and
-- party, because a return needs to know what was actually determined at the
-- time — a party's registration can change, and history must not move with it.
alter table public.vouchers
  add column place_of_supply char(2) references public.ref_states(code),
  add column supply_type text check (supply_type is null or supply_type in
    ('intra','inter','export_lut','export_igst','sez','deemed_export'));

create or replace function app_private.gst_supply_type(p_supplier_state char(2), p_place_of_supply char(2))
returns text
language sql immutable parallel safe set search_path = ''
as $$
  select case when p_supplier_state = p_place_of_supply then 'intra' else 'inter' end;
$$;


-- ----------------------------------------------------------------------------
-- create_invoice, extended with tax
-- ----------------------------------------------------------------------------
-- A new trailing parameter with a default, so a books-only company that never
-- mentions GST keeps calling this unchanged. Tax is computed only when the
-- gst module is active for this company ON THE VOUCHER DATE — not today's
-- date. That distinction matters: the conditional module resolver always
-- opens a module's effective period starting today (0004), regardless of how
-- far back a registration's registered_from is backdated. A company adding a
-- GSTIN they have held for months does not retroactively owe tax computation
-- on invoices already entered for that earlier period — registered_from is
-- informational, not a re-open of history. This is a design choice, not an
-- oversight, and it is worth stating here because it looks like a bug the
-- first time a backdated registration does not tax an old-dated invoice.
--
-- CREATE OR REPLACE FUNCTION cannot add a parameter to an existing function —
-- a function's identity is its full parameter TYPE list, so appending one
-- (even with a default) creates a second overload rather than replacing the
-- first, and every call with fewer arguments becomes ambiguous between them.
-- 0011 already established the right pattern for this — drop the old
-- signature before creating the new one.
drop function if exists public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date);

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
  -- Defaults to the party's state on file. Left unresolved with GST active,
  -- raises rather than guessing.
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

    select uom, hsn_sac, gst_rate_percent, cess_rate_percent
      into v_uom, v_hsn, v_gst_rate, v_cess_rate
      from public.items where id = (v_item->>'item_id')::uuid;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, hsn_sac, description, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, p_godown_id,
      (v_item->>'item_id')::uuid,
      v_direction, v_qty, coalesce(v_uom, 'NOS'), coalesce(v_rate, 0), v_amount,
      v_hsn, v_item->>'description', v_line_no);

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

    v_line_no := v_line_no + 1;
  end loop;

  if v_taxable_total <= 0 then
    raise exception 'An invoice must come to more than zero';
  end if;

  v_grand_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total;

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
    -- it raises by name — the one place a silent omission would understate a
    -- real tax liability.
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

  return v_voucher_id;
end;
$$;

revoke execute on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, char) from public, anon;
grant execute on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, char) to authenticated;


-- ----------------------------------------------------------------------------
-- Registering a GSTIN
-- ----------------------------------------------------------------------------
-- seed_gst_ledgers is app_private and rightly not directly callable. Nothing
-- in the app could add a registration and end up with working tax ledgers in
-- one step before this existed — every test up to this point did it by hand
-- in SQL.
create or replace function public.add_gst_registration(
  p_company_id uuid,
  p_gstin char(15),
  p_registered_from date,
  p_branch_id uuid default null,
  p_registration_type text default 'regular',
  p_filing_frequency text default 'monthly'
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_registration_id uuid;
  v_state char(2);
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can add a GST registration';
  end if;

  -- state_code is overwritten by the enforce_gstin_state trigger from the
  -- GSTIN itself; the value here is a placeholder the trigger replaces.
  insert into public.gst_registrations (
    company_id, gstin, state_code, registered_from, registration_type, filing_frequency)
  values (p_company_id, p_gstin, '00', p_registered_from, p_registration_type, p_filing_frequency)
  returning id, state_code into v_registration_id, v_state;

  perform app_private.seed_gst_ledgers(p_company_id, v_registration_id);

  if p_branch_id is not null then
    -- The FK on branches(gst_registration_id, company_id, state_code) refuses
    -- this on its own if the branch is not in the registration's state —
    -- the same guard that makes a Pune warehouse unable to sit under a
    -- Karnataka GSTIN.
    update public.branches
       set gst_registration_id = v_registration_id
     where id = p_branch_id and company_id = p_company_id;
  end if;

  return v_registration_id;
end;
$$;

revoke execute on function public.add_gst_registration(uuid, char, date, uuid, text, text) from public, anon;
grant execute on function public.add_gst_registration(uuid, char, date, uuid, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- delete_company: tax_ledger_map was never cleared
-- ----------------------------------------------------------------------------
-- tax_ledger_map references ledgers with a plain FK (no cascade), and
-- delete_company (0010/0014) was never updated when 0006 introduced that
-- table — it only ever cascaded from the company row itself, which happens
-- AFTER ledgers are explicitly deleted in this function's ordering. Every
-- previous test of delete_company used a company with no GST registrations,
-- so tax_ledger_map was always empty and this never fired. The first real
-- GST company would have been undeletable. Found by actually deleting one.
create or replace function public.delete_company(p_company_id uuid)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can delete a company';
  end if;

  delete from public.vouchers        where company_id = p_company_id;  -- cascades entries and stock lines
  delete from public.tax_ledger_map  where company_id = p_company_id;  -- references ledgers; must precede it
  delete from public.items           where company_id = p_company_id;
  delete from public.godowns         where company_id = p_company_id;
  delete from public.ledgers         where company_id = p_company_id;
  delete from public.companies       where id = p_company_id;
  delete from public.audit_log       where company_id = p_company_id;
end;
$$;

revoke execute on function public.delete_company(uuid) from public, anon;
grant execute on function public.delete_company(uuid) to authenticated;
