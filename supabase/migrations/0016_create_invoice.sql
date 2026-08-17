-- ============================================================================
-- 0016 — Invoicing
-- ============================================================================
-- An invoice is one act with two consequences: stock moves, and money is owed.
-- Recording them separately means a moment where one exists without the other,
-- and a client that dies between the two leaves stock issued against no
-- receivable. This does both in one transaction, so the deferred balance
-- trigger at COMMIT is validating a complete invoice or nothing at all.
--
-- Tax is deliberately absent. When GST lands the tax lines are added here and
-- the shape does not change: items in, entries out. That is the whole reason
-- the generator exists rather than the client assembling entries itself.
-- ============================================================================

create or replace function public.create_invoice(
  p_company_id uuid,
  p_branch_id uuid,
  p_voucher_type text,
  p_voucher_date date,
  p_party_ledger_id uuid,
  -- Sales revenue for a sale, purchases for a purchase. The counter-leg.
  p_trading_ledger_id uuid,
  p_godown_id uuid,
  -- [{"item_id":"...","quantity":10,"rate":50,"description":null}]
  p_items jsonb,
  p_narration text default null,
  p_reference_number text default null,
  p_reference_date date default null
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
  v_amount numeric;
  v_total numeric := 0;
  v_direction text;
  v_party_side text;
  v_line_no int := 0;
  v_uom text;
  v_hsn text;
begin
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'An invoice needs at least one item line';
  end if;

  -- Which way stock moves, and which side the party sits on. A credit note
  -- reverses a sale, so stock comes back in and the customer is credited.
  -- Inferred from the voucher type so the two can never disagree.
  case p_voucher_type
    when 'sales'       then v_direction := 'out'; v_party_side := 'debit';
    when 'purchase'    then v_direction := 'in';  v_party_side := 'credit';
    when 'credit_note' then v_direction := 'in';  v_party_side := 'credit';
    when 'debit_note'  then v_direction := 'out'; v_party_side := 'debit';
    else raise exception '% is not an invoice type', p_voucher_type;
  end case;

  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, p_voucher_type, p_voucher_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, reference_number,
    reference_date, party_ledger_id, created_by)
  values (
    p_company_id, p_branch_id, p_voucher_type, v_display_number, v_seq,
    v_fy, p_voucher_date, p_narration, p_reference_number,
    p_reference_date, p_party_ledger_id, auth.uid())
  returning id into v_voucher_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty  := (v_item->>'quantity')::numeric;
    v_rate := (v_item->>'rate')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every item line needs a quantity greater than zero';
    end if;

    -- Rounded per line, then summed. Summing unrounded and rounding once would
    -- leave the invoice total disagreeing with the lines a reader can add up.
    v_amount := round(v_qty * coalesce(v_rate, 0), 2);
    v_total := v_total + v_amount;

    -- Copied from the master at invoice time, so an HSN summary need not trust
    -- that the item still says today what it said then.
    select uom, hsn_sac into v_uom, v_hsn
      from public.items where id = (v_item->>'item_id')::uuid;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, hsn_sac, description, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, p_godown_id,
      (v_item->>'item_id')::uuid,
      v_direction, v_qty, coalesce(v_uom, 'NOS'), coalesce(v_rate, 0), v_amount,
      v_hsn, v_item->>'description', v_line_no);

    v_line_no := v_line_no + 1;
  end loop;

  if v_total <= 0 then
    raise exception 'An invoice must come to more than zero';
  end if;

  -- The financial effect. Two lines, so the deferred balance trigger has
  -- something to check at COMMIT.
  insert into public.voucher_entries (
    voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values
    (v_voucher_id, p_company_id, p_branch_id, p_party_ledger_id,
     case when v_party_side = 'debit'  then v_total else 0 end,
     case when v_party_side = 'credit' then v_total else 0 end, 0),
    (v_voucher_id, p_company_id, p_branch_id, p_trading_ledger_id,
     case when v_party_side = 'debit'  then 0 else v_total end,
     case when v_party_side = 'credit' then 0 else v_total end, 1);

  return v_voucher_id;
end;
$$;

revoke execute on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date) from public, anon;
grant execute on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date) to authenticated;
