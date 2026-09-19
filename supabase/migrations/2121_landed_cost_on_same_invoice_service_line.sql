-- ============================================================================
-- 2121 — A same-invoice freight/insurance line can now be BOTH taxed
--        correctly AND capitalised into stock cost, on one purchase voucher
-- ============================================================================
-- THE GAP. Two ways exist to record freight/handling billed on a purchase,
-- and neither got everything right on the ordinary case where ONE tax
-- invoice bills both goods and freight together (1480's own header example
-- does exactly this, and TEST Precision Engineering's real HOPUR26/0001 does
-- it too: Bhavani Steel Traders billed 2,000 kg MS Round Bar and a freight
-- line on the same invoice):
--
--   * A service line on the SAME purchase voucher (1480). GST computes
--     correctly and reaches get_gst_input_register correctly -- that
--     register already sums ALL of a voucher's voucher_items.amount, stock
--     and service lines alike, so nothing there needed to change. But the
--     freight amount never touched voucher_items.landed_cost_amount, so it
--     was expensed to the trading (Purchases) ledger instantly and
--     permanently -- understating closing stock by exactly the freight
--     amount for as long as any of that lot remains unsold. AS 2 para 6
--     (ICAI) puts freight inwards inside the cost of purchase in as many
--     words, and Ind AS 2 para 11 reaches the same place via "transport,
--     handling and other costs directly attributable to the acquisition" --
--     expensing it is not a rounding choice, it is the wrong figure on the
--     balance sheet.
--
--   * allocate_landed_cost (1360/1841, recovered as 2120). Correctly
--     capitalises into landed_cost_amount and the resulting weighted-average
--     rate -- hand-verified exact on this pilot's own HOPUR26/0002. But it
--     has NO tax engine: it posts a bare journal (Dr charge ledgers, Cr
--     settlement) with no CGST/SGST/IGST/cess lines at all, on a voucher
--     whose voucher_type is 'journal' -- a type get_gst_input_register does
--     not even look at (it filters to voucher_type in ('purchase',
--     'debit_note')). So GST on the freight itself, if any, never reaches
--     Input CGST/SGST/IGST and never appears in the input register at all.
--     Teaching allocate_landed_cost to post tax would still not fix this
--     without ALSO widening get_gst_input_register's own voucher_type
--     filter -- a bigger, more central change for a narrower gain, since the
--     ordinary case (one invoice, goods and freight together) already has a
--     document that IS a 'purchase' voucher and already gets its GST right.
--
-- A preparer with one ordinary tax invoice had to choose between correct GST
-- and correct stock costing. This migration closes that for the ordinary
-- case: the SAME-invoice service line now ALSO capitalises, when the
-- preparer flags it as one.
--
-- THE FLAG. items.category was checked first ("Freight" is the live value on
-- HOPUR26/0001's own freight item, but it is one value among many free-text
-- values a preparer types, also used ungoverned as the trade-analysis
-- item-group label in 1540) and rejected: it is free text
-- with no controlled vocabulary, already reused for an unrelated grouping
-- purpose, and would silently misclassify or miss any freight/insurance/
-- loading/customs item a preparer happened to name or categorise
-- differently. items.is_rcm_applicable was checked as a PRECEDENT for a
-- similar-shaped boolean, but living on the item master it would apply the
-- SAME decision to every future invoice that item ever appears on -- wrong
-- for a charge that is sometimes a landed cost and sometimes not (the same
-- "Freight" item can appear on a purchase where it is capitalised and on one
-- where it is immaterial and just expensed).
--
-- So the flag is a new PER-LINE column, voucher_items.is_landed_cost,
-- exactly the same shape as moves_stock (1480): the preparer's call at entry
-- time, defaulting to false so every existing line and every caller that
-- says nothing keeps today's behaviour byte-for-byte. A table CHECK
-- (voucher_items_landed_cost_not_stock) backstops it against ever being set
-- on a line that also moves stock, regardless of which function writes the
-- row -- the same defence-in-depth 1480 used for the moves_stock/item-type
-- pairing. A second column, landed_cost_applied, is bookkeeping only: it
-- marks a charge line's amount as already folded into the stock lines'
-- landed_cost_amount, so app_private.apply_landed_cost_charge_lines (below)
-- can never double-count if it is ever invoked twice for the same voucher --
-- a real risk in this shared environment, where migrations have been known
-- to be re-applied against stale schema_migrations bookkeeping.
--
-- THE METHOD. Pro-rata by each stock line's OWN invoice value, rounding
-- remainder dumped on the largest line -- the identical method
-- allocate_landed_cost already uses (1360 header), so the two paths agree
-- when a company uses both. Apportioning by value rather than by quantity:
-- a landed charge like freight is contracted overwhelmingly by weight/volume
-- in practice, which is exactly what invoice value already tracks for a
-- single-rate item, and by-value is what the existing, independently-
-- reviewed allocate_landed_cost already does — matching it rather than
-- introducing a second, differently-reasoned rule was the deciding factor.
--
-- WHERE IT RUNS. Only on 'purchase' vouchers, only after every line for the
-- voucher is inserted (create_invoice and update_invoice both call
-- app_private.apply_landed_cost_charge_lines once, right after the item
-- loop). Never on sales/credit_note/debit_note: outward freight recovered
-- from a customer is revenue, not a cost of THIS company's inventory, and a
-- debit note here is a purchase RETURN (goods leaving), not an acquisition.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The flag and its guard-rails
-- ----------------------------------------------------------------------------
alter table public.voucher_items
  add column if not exists is_landed_cost boolean not null default false;

comment on column public.voucher_items.is_landed_cost is
  'True on a charge line on a PURCHASE invoice whose own amount is apportioned into the landed_cost_amount of the stock lines on the SAME voucher by app_private.apply_landed_cost_charge_lines, rather than left to expense through the trading ledger alone (2121). The preparer''s call per line, not derived from the item master -- the same freight/insurance/loading item can be a landed cost on one purchase and an ordinary expense on another. Always false on a line that moves stock -- see voucher_items_landed_cost_not_stock.';

alter table public.voucher_items
  add column if not exists landed_cost_applied boolean not null default false;

comment on column public.voucher_items.landed_cost_applied is
  'True once this charge line''s own amount has actually been apportioned into the landed_cost_amount of the stock lines on the same voucher (2121). Guards app_private.apply_landed_cost_charge_lines against double-counting if it is ever invoked twice for the same voucher. Always false unless is_landed_cost is true.';

alter table public.voucher_items
  add constraint voucher_items_landed_cost_not_stock
  check (not is_landed_cost or not moves_stock);

alter table public.voucher_items
  add constraint voucher_items_landed_cost_applied_needs_flag
  check (not landed_cost_applied or is_landed_cost);

-- ----------------------------------------------------------------------------
-- 2. The apportionment, factored out so create_invoice, update_invoice and a
--    one-off data correction (2122) all run the exact same arithmetic.
-- ----------------------------------------------------------------------------
create or replace function app_private.apply_landed_cost_charge_lines(p_voucher_id uuid)
returns void
language plpgsql
set search_path = ''
as $fn$
declare
  v_charge_total numeric(18,2);
  v_base_total numeric(18,2);
begin
  select coalesce(sum(amount), 0)
    into v_charge_total
    from public.voucher_items
   where voucher_id = p_voucher_id
     and is_landed_cost
     and not landed_cost_applied;

  -- Nothing flagged (the ordinary case for every purchase without a
  -- same-invoice landed charge), or already applied earlier -- a cheap,
  -- silent no-op either way.
  if not (v_charge_total > 0) then
    return;
  end if;

  select coalesce(sum(amount), 0)
    into v_base_total
    from public.voucher_items
   where voucher_id = p_voucher_id
     and direction = 'in'
     and moves_stock;

  if not (v_base_total > 0) then
    raise exception 'This voucher has a landed-cost charge line but no stock item lines to capitalise it into';
  end if;

  -- Pro-rata by value, rounding remainder dumped on the largest base-value
  -- line (ties broken by voucher_item id) -- identical to allocate_landed_cost
  -- (1360/2120), so the two paths reconcile exactly to the paisa.
  with base as (
    select vi.id, vi.amount,
           row_number() over (order by vi.amount desc, vi.id) as rn
      from public.voucher_items vi
     where vi.voucher_id = p_voucher_id
       and vi.direction = 'in'
       and vi.moves_stock
  ),
  naive as (
    select id, amount, rn,
           round(v_charge_total * amount / v_base_total, 2) as naive_amount
      from base
  ),
  alloc as (
    select id,
           case when rn = 1
                then v_charge_total - (sum(naive_amount) over () - naive_amount)
                else naive_amount
           end as allocated_amount
      from naive
  )
  update public.voucher_items vi
     set landed_cost_amount = vi.landed_cost_amount + a.allocated_amount
    from alloc a
   where a.id = vi.id;

  update public.voucher_items
     set landed_cost_applied = true
   where voucher_id = p_voucher_id
     and is_landed_cost
     and not landed_cost_applied;
end;
$fn$;

revoke all on function app_private.apply_landed_cost_charge_lines(uuid) from public, anon;
grant execute on function app_private.apply_landed_cost_charge_lines(uuid) to authenticated, service_role;

comment on function app_private.apply_landed_cost_charge_lines(uuid) is
  'Apportions every not-yet-applied is_landed_cost charge line on a voucher across that voucher''s own stock (direction=in, moves_stock) lines, pro-rata by value with the rounding remainder on the largest line -- the same method allocate_landed_cost uses. Adds to landed_cost_amount (never replaces) and marks the charge lines landed_cost_applied so re-invoking it is a no-op. Raises if charge lines exist with no stock line to capitalise into. Called by create_invoice and update_invoice for purchase vouchers, and once, directly, by 2122''s historical correction (2121).';

-- ----------------------------------------------------------------------------
-- 3. create_invoice — targeted rewrite, rest of the body untouched
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_invoice' and p.prokind = 'f';

  if v_def is null then
    raise exception '2121: public.create_invoice not found.';
  end if;

  if position('v_is_landed_cost' in v_def) > 0 then
    raise notice '2121: create_invoice already carries the landed-cost fix; skipping.';
  else
    v_before := v_def;

    -- Anchored on the boundary between the declare section and the first
    -- executable statement (stable regardless of what else has been added
    -- to the declare list -- e.g. 2090's stock-availability guard, live at
    -- the time this migration was written, changes nothing here) rather
    -- than on the tail of the declare list itself.
    if position(E'\nbegin\n  if jsonb_array_length(coalesce(p_items, ''[]''::jsonb)) = 0 then' in v_def) = 0 then
      raise exception '2121: create_invoice''s declare/begin boundary has moved since this migration was written -- edit 1 target not found. Fix by hand.';
    end if;
    v_def := replace(
      v_def,
      E'\nbegin\n  if jsonb_array_length(coalesce(p_items, ''[]''::jsonb)) = 0 then',
      E'\n  -- 2121: a charge line the preparer flags as a landed cost (freight,\n  -- insurance, loading, customs -- never a stock-maintaining item, enforced\n  -- by voucher_items_landed_cost_not_stock) capitalises into the stock\n  -- lines on this SAME voucher instead of reaching only the trading ledger.\n  v_is_landed_cost boolean;\n  v_item_name text;\n  v_item_type text;\n  v_maintain_stock boolean;\nbegin\n  if jsonb_array_length(coalesce(p_items, ''[]''::jsonb)) = 0 then'
    );

    if position(E'    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable\n      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section, v_is_rcm_applicable\n      from public.items where id = (v_item->>''item_id'')::uuid;\n\n    insert into public.voucher_items (\n      voucher_id, company_id, branch_id, godown_id, item_id,\n      direction, quantity, uom, rate, amount, discount_percent, hsn_sac, description, line_order)\n    values (\n      v_voucher_id, p_company_id, p_branch_id, p_godown_id,\n      (v_item->>''item_id'')::uuid,\n      v_direction, v_qty, coalesce(v_uom, ''NOS''), coalesce(v_rate, 0), v_amount, v_discount_percent,\n      v_hsn, v_item->>''description'', v_line_no);' in v_def) = 0 then
      raise exception '2121: create_invoice''s item select+insert has moved since this migration was written -- edit 2 target not found. Fix by hand.';
    end if;
    v_def := replace(
      v_def,
      E'    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable\n      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section, v_is_rcm_applicable\n      from public.items where id = (v_item->>''item_id'')::uuid;\n\n    insert into public.voucher_items (\n      voucher_id, company_id, branch_id, godown_id, item_id,\n      direction, quantity, uom, rate, amount, discount_percent, hsn_sac, description, line_order)\n    values (\n      v_voucher_id, p_company_id, p_branch_id, p_godown_id,\n      (v_item->>''item_id'')::uuid,\n      v_direction, v_qty, coalesce(v_uom, ''NOS''), coalesce(v_rate, 0), v_amount, v_discount_percent,\n      v_hsn, v_item->>''description'', v_line_no);',
      E'    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable, name, item_type, maintain_stock\n      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section, v_is_rcm_applicable, v_item_name, v_item_type, v_maintain_stock\n      from public.items where id = (v_item->>''item_id'')::uuid;\n\n    -- 2121: is_landed_cost is only meaningful on a purchase, and only on a\n    -- line that moves no stock -- a stock line''s own cost is what RECEIVES\n    -- the apportionment, not what supplies it. Checked here in plain\n    -- language ahead of voucher_items_landed_cost_not_stock, which stays as\n    -- the backstop against any other writer of this table.\n    v_is_landed_cost := coalesce((v_item->>''is_landed_cost'')::boolean, false);\n    if v_is_landed_cost and p_voucher_type <> ''purchase'' then\n      raise exception ''A landed-cost charge line is only valid on a purchase voucher, not a % voucher'', p_voucher_type;\n    end if;\n    if v_is_landed_cost and v_item_type = ''goods'' and v_maintain_stock then\n      raise exception ''"%" maintains stock, so it cannot be flagged as a landed-cost charge line -- only a non-stock charge (freight, insurance, loading, customs and the like) apportions into stock cost this way'', v_item_name;\n    end if;\n\n    insert into public.voucher_items (\n      voucher_id, company_id, branch_id, godown_id, item_id,\n      direction, quantity, uom, rate, amount, discount_percent, hsn_sac, description, line_order, is_landed_cost)\n    values (\n      v_voucher_id, p_company_id, p_branch_id, p_godown_id,\n      (v_item->>''item_id'')::uuid,\n      v_direction, v_qty, coalesce(v_uom, ''NOS''), coalesce(v_rate, 0), v_amount, v_discount_percent,\n      v_hsn, v_item->>''description'', v_line_no, v_is_landed_cost);'
    );

    if position(E'  if v_taxable_total <= 0 then\n    raise exception ''An invoice must come to more than zero'';\n  end if;\n\n  v_grand_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total + v_tcs_total;' in v_def) = 0 then
      raise exception '2121: create_invoice''s taxable-total guard has moved since this migration was written -- edit 3 target not found. Fix by hand.';
    end if;
    v_def := replace(
      v_def,
      E'  if v_taxable_total <= 0 then\n    raise exception ''An invoice must come to more than zero'';\n  end if;\n\n  v_grand_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total + v_tcs_total;',
      E'  if v_taxable_total <= 0 then\n    raise exception ''An invoice must come to more than zero'';\n  end if;\n\n  -- 2121: fold any same-invoice landed-cost charge lines into the stock\n  -- lines'' landed_cost_amount before the voucher is otherwise complete.\n  -- GST (computed per line above, already correct) and the trading-ledger\n  -- posting below are unaffected -- this only touches stock costing.\n  if p_voucher_type = ''purchase'' then\n    perform app_private.apply_landed_cost_charge_lines(v_voucher_id);\n  end if;\n\n  v_grand_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total + v_tcs_total;'
    );

    if v_def = v_before then
      raise exception '2121: create_invoice rewrite produced no change -- aborting rather than silently no-op''ing.';
    end if;

    execute v_def;
  end if;
end;
$mig$;

revoke all on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, character, character, numeric, text, text, uuid, text, date, boolean) from public, anon;
grant execute on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, character, character, numeric, text, text, uuid, text, date, boolean) to authenticated, service_role;

comment on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, character, character, numeric, text, text, uuid, text, date, boolean) is
  'Posts a tax invoice, bill, credit or debit note with its GST, RCM and TCS. Lines may be goods or services: a service line carries its SAC, rate, amount and GST into the GST registers and the HSN summary exactly as a goods line does, and moves no stock (1480). On a PURCHASE, a service line the caller flags is_landed_cost apportions its own amount into the landed_cost_amount of the stock lines on the SAME voucher, pro-rata by value (2121) -- see app_private.apply_landed_cost_charge_lines. No input tax is computed on a purchase or debit note from an unregistered or composition supplier -- neither may lawfully collect it, so there is no credit to claim and nothing to add to the payable (1230). RCM is unaffected: it follows the item, not the supplier.';

-- ----------------------------------------------------------------------------
-- 4. update_invoice — the same rewrite, kept in sync for the same reason RCM
--    already had to be (see this function's live comment)
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'update_invoice' and p.prokind = 'f';

  if v_def is null then
    raise exception '2121: public.update_invoice not found.';
  end if;

  if position('v_is_landed_cost' in v_def) > 0 then
    raise notice '2121: update_invoice already carries the landed-cost fix; skipping.';
  else
    v_before := v_def;

    if position(E'  v_changed text[] := ''{}'';\n  v_lines_differ boolean;\n  v_remedy text;\nbegin' in v_def) = 0 then
      raise exception '2121: update_invoice''s declare block has moved since this migration was written -- edit 1 target not found. Fix by hand.';
    end if;
    v_def := replace(
      v_def,
      E'  v_changed text[] := ''{}'';\n  v_lines_differ boolean;\n  v_remedy text;\nbegin',
      E'  v_changed text[] := ''{}'';\n  v_lines_differ boolean;\n  v_remedy text;\n\n  -- 2121: see create_invoice for the full reasoning -- kept in sync here so\n  -- re-saving a purchase invoice through the editor does not silently drop\n  -- the same-invoice landed-cost apportionment.\n  v_is_landed_cost boolean;\n  v_item_name text;\n  v_item_type text;\n  v_maintain_stock boolean;\nbegin'
    );

    if position(E'    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable\n      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section, v_is_rcm_applicable\n      from public.items where id = (v_item->>''item_id'')::uuid;\n\n    insert into public.voucher_items (\n      voucher_id, company_id, branch_id, godown_id, item_id,\n      direction, quantity, uom, rate, amount, discount_percent, hsn_sac, description, line_order)\n    values (\n      p_voucher_id, v_company_id, v_branch_id, p_godown_id,\n      (v_item->>''item_id'')::uuid,\n      v_direction, v_qty, coalesce(v_uom, ''NOS''), coalesce(v_rate, 0), v_amount, v_discount_percent,\n      v_hsn, v_item->>''description'', v_line_no);' in v_def) = 0 then
      raise exception '2121: update_invoice''s item select+insert has moved since this migration was written -- edit 2 target not found. Fix by hand.';
    end if;
    v_def := replace(
      v_def,
      E'    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable\n      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section, v_is_rcm_applicable\n      from public.items where id = (v_item->>''item_id'')::uuid;\n\n    insert into public.voucher_items (\n      voucher_id, company_id, branch_id, godown_id, item_id,\n      direction, quantity, uom, rate, amount, discount_percent, hsn_sac, description, line_order)\n    values (\n      p_voucher_id, v_company_id, v_branch_id, p_godown_id,\n      (v_item->>''item_id'')::uuid,\n      v_direction, v_qty, coalesce(v_uom, ''NOS''), coalesce(v_rate, 0), v_amount, v_discount_percent,\n      v_hsn, v_item->>''description'', v_line_no);',
      E'    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable, name, item_type, maintain_stock\n      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section, v_is_rcm_applicable, v_item_name, v_item_type, v_maintain_stock\n      from public.items where id = (v_item->>''item_id'')::uuid;\n\n    -- 2121: see create_invoice for the full reasoning.\n    v_is_landed_cost := coalesce((v_item->>''is_landed_cost'')::boolean, false);\n    if v_is_landed_cost and v_voucher_type <> ''purchase'' then\n      raise exception ''A landed-cost charge line is only valid on a purchase voucher, not a % voucher'', v_voucher_type;\n    end if;\n    if v_is_landed_cost and v_item_type = ''goods'' and v_maintain_stock then\n      raise exception ''"%" maintains stock, so it cannot be flagged as a landed-cost charge line -- only a non-stock charge (freight, insurance, loading, customs and the like) apportions into stock cost this way'', v_item_name;\n    end if;\n\n    insert into public.voucher_items (\n      voucher_id, company_id, branch_id, godown_id, item_id,\n      direction, quantity, uom, rate, amount, discount_percent, hsn_sac, description, line_order, is_landed_cost)\n    values (\n      p_voucher_id, v_company_id, v_branch_id, p_godown_id,\n      (v_item->>''item_id'')::uuid,\n      v_direction, v_qty, coalesce(v_uom, ''NOS''), coalesce(v_rate, 0), v_amount, v_discount_percent,\n      v_hsn, v_item->>''description'', v_line_no, v_is_landed_cost);'
    );

    if position(E'  if v_taxable_total <= 0 then\n    raise exception ''An invoice must come to more than zero'';\n  end if;\n\n  v_grand_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total + v_tcs_total;' in v_def) = 0 then
      raise exception '2121: update_invoice''s taxable-total guard has moved since this migration was written -- edit 3 target not found. Fix by hand.';
    end if;
    v_def := replace(
      v_def,
      E'  if v_taxable_total <= 0 then\n    raise exception ''An invoice must come to more than zero'';\n  end if;\n\n  v_grand_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total + v_tcs_total;',
      E'  if v_taxable_total <= 0 then\n    raise exception ''An invoice must come to more than zero'';\n  end if;\n\n  -- 2121: see create_invoice for the full reasoning.\n  if v_voucher_type = ''purchase'' then\n    perform app_private.apply_landed_cost_charge_lines(p_voucher_id);\n  end if;\n\n  v_grand_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total + v_tcs_total;'
    );

    if v_def = v_before then
      raise exception '2121: update_invoice rewrite produced no change -- aborting rather than silently no-op''ing.';
    end if;

    execute v_def;
  end if;
end;
$mig$;

revoke all on function public.update_invoice(uuid, date, uuid, uuid, uuid, jsonb, text, text, date, character, text, date) from public, anon;
grant execute on function public.update_invoice(uuid, date, uuid, uuid, uuid, jsonb, text, text, date, character, text, date) to authenticated, service_role;

comment on function public.update_invoice(uuid, date, uuid, uuid, uuid, jsonb, text, text, date, character, text, date) is
  'Edit-time twin of create_invoice: full replace of voucher_items and voucher_entries for an existing invoice, same GST/RCM/TCS computation, and the same same-invoice landed-cost apportionment on a purchase (2121). voucher_type, branch_id and the voucher number are not editable. Once the voucher carries an IRN (einvoice_details.irn), the party, the invoice date, the place of supply and the item lines are frozen and the save is refused with the lawful remedy (1500); narration, reference, challan and godown stay editable.';
