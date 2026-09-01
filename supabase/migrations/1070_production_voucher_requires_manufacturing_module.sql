-- ============================================================================
-- 1070 — Manufacturing module toggle is decorative: production posts anyway
-- ============================================================================
-- Confirmed live: Sharma Textiles has "Manufacturing and BOM" switched OFF in
-- Settings -> Modules, but /manufacturing loads fully functional regardless —
-- an existing BOM, working "New BOM" / "+Add component" / "+Add by-product" /
-- "Produce" controls, nothing gates on the module flag. Traced to the source:
-- create_production_voucher (0070, replaced whole in 0114 to add by-product/
-- scrap/co-product splitting) has never once called
-- app_private.module_active() for the 'manufacturing' module — not in 0070,
-- not in 0114. Every other optional-tier module with its own posting RPC
-- already enforces this at the RPC itself, which is the real control, since a
-- frontend-only gate is bypassed by anyone calling the RPC directly:
--   - create_job_work_challan (0069): "if not
--     app_private.module_active(p_company_id, 'job_work', p_challan_date)
--     then raise exception 'Job work is not an active module for this
--     company — turn it on in Settings first'; end if;"
--   - create_delivery_challan (0113): same shape, module_code
--     'delivery_challan'.
--   - record_stock_verification (0165): same shape, module_code 'inventory'.
-- This migration applies the exact same pattern to create_production_voucher,
-- checked right after the existing can_write_company check and before any
-- business validation, matching create_job_work_challan's own ordering.
--
-- SAFE SHAPE: CREATE OR REPLACE with the identical 9-parameter signature
-- 0114 already shipped (uuid, uuid, uuid, numeric, uuid, uuid, date, numeric,
-- text) — no new column, no new parameter, nothing the frontend needs to
-- change how it calls. This reads app_private.module_active() and
-- company_modules, both of which have existed since 0004; no new schema.
-- Every other line of 0114's function body — component consumption, the
-- by-product/scrap NRV netting, the co-product relative-sales-value split,
-- the self-cancelling Manufacturing Clearing pair — is carried over
-- character-for-character; only the new module gate is added.
--
-- Checked against p_voucher_date (the transaction date), not today's date,
-- for the same reason 0004's header gives for every module check in this
-- app: module state is effective-dated, so a production run entered for a
-- date when the module was genuinely on must still be postable, and one for
-- a date when it was off must still be rejected even if the module happens
-- to be on again today.
--
-- DOES NOT TOUCH: bill_of_materials / bom_components / bom_outputs CRUD —
-- a company can still define recipes with the module off (harmless; nothing
-- moves stock or posts a voucher from a bare BOM row), matching the app's
-- existing convention that data capture and posting are gated separately
-- elsewhere too (e.g. job work challans can be edited via plain table access
-- rules, only create_job_work_challan itself gates on the module). Also
-- does not touch get_boms — a read-only list is not "postable" and other
-- modules' read RPCs (get_job_work_outstanding, get_stock_verifications)
-- aren't gated either; the frontend page below decides what to show instead.
-- ============================================================================

create or replace function public.create_production_voucher(
  p_company_id uuid,
  p_branch_id uuid,
  p_bom_id uuid,
  p_quantity_produced numeric,
  p_component_godown_id uuid,
  p_output_godown_id uuid,
  p_voucher_date date,
  p_additional_cost numeric default 0,
  p_narration text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_bom record;
  v_comp record;
  v_scale numeric;
  v_rate numeric;
  v_component_cost numeric := 0;
  v_line_amount numeric;
  v_effective_cost numeric;
  v_effective_cost_r numeric;
  v_output_rate numeric;
  v_clearing_ledger uuid;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_voucher_id uuid;
  v_line int := 0;
  v_component_count int := 0;
  v_output_row_count int := 0;
  v_main_line int;
  v_out record;
  v_out_qty numeric;
  v_out_amount numeric;
  v_secondary_total numeric := 0;
  v_joint_pool numeric;
  v_co_product_count int := 0;
  v_co_weight_total numeric := 0;
  v_main_sale_rate numeric;
  v_main_weight numeric;
  v_total_weight numeric;
  v_co_output_total numeric := 0;
  v_out_weight numeric;
  v_out_share numeric;
  v_main_amount numeric;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to record production for this company';
  end if;
  if not app_private.module_active(p_company_id, 'manufacturing', p_voucher_date) then
    raise exception 'Manufacturing and BOM is not an active module for this company — turn it on in Settings first';
  end if;
  if not (p_quantity_produced > 0) then
    raise exception 'Quantity produced must be greater than zero';
  end if;
  if p_additional_cost < 0 then
    raise exception 'Additional cost cannot be negative';
  end if;

  select id, output_item_id, yield_quantity into v_bom
    from public.bill_of_materials
   where id = p_bom_id and company_id = p_company_id and is_active;

  if v_bom.id is null then
    raise exception 'BOM % does not exist (or is inactive) in this company', p_bom_id;
  end if;

  v_scale := p_quantity_produced / v_bom.yield_quantity;

  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, 'stock_journal', p_voucher_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, created_by)
  values (
    p_company_id, p_branch_id, 'stock_journal', v_display_number, v_seq,
    v_fy, p_voucher_date, coalesce(p_narration, 'Production'), auth.uid())
  returning id into v_voucher_id;

  for v_comp in
    select bc.component_item_id, bc.quantity, i.uom, i.name
      from public.bom_components bc
      join public.items i on i.id = bc.component_item_id
     where bc.bom_id = p_bom_id
     order by bc.line_order
  loop
    v_component_count := v_component_count + 1;

    select s.average_rate into v_rate
      from public.get_stock_summary(p_company_id, p_voucher_date, null) s
     where s.item_id = v_comp.component_item_id;
    v_rate := coalesce(v_rate, 0);

    declare
      v_qty numeric := round(v_comp.quantity * v_scale, 3);
    begin
      v_line_amount := round(v_qty * v_rate, 2);
      v_component_cost := v_component_cost + v_line_amount;

      insert into public.voucher_items (
        voucher_id, company_id, branch_id, godown_id, item_id,
        direction, quantity, uom, rate, amount, line_order)
      values (
        v_voucher_id, p_company_id, p_branch_id, p_component_godown_id, v_comp.component_item_id,
        'out', v_qty, v_comp.uom, v_rate, v_line_amount, v_line);
      v_line := v_line + 1;
    end;
  end loop;

  if v_component_count = 0 then
    raise exception 'This BOM has no components — nothing to consume';
  end if;

  v_effective_cost := v_component_cost + p_additional_cost;
  v_effective_cost_r := round(v_effective_cost, 2);

  select count(*) into v_output_row_count from public.bom_outputs where bom_id = p_bom_id;

  if v_output_row_count = 0 then
    -- ORIGINAL 0070 branch, untouched — guarantees byte-identical output
    -- for every BOM that has no by-product/scrap/co-product rows.
    v_output_rate := round(v_effective_cost / p_quantity_produced, 4);

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, line_order)
    select v_voucher_id, p_company_id, p_branch_id, p_output_godown_id, v_bom.output_item_id,
           'in', p_quantity_produced, i.uom, v_output_rate, round(v_effective_cost, 2), v_line
      from public.items i where i.id = v_bom.output_item_id;
  else
    -- Reserve the main output's line position now (it reads right after
    -- the components, matching the plain-BOM layout above) even though
    -- its amount — the residual after by-products/scrap/co-products — is
    -- only known once every other output has been valued.
    v_main_line := v_line;
    v_line := v_line + 1;

    -- Pass 1: by_product / scrap — each valued at its own NRV and netted
    -- straight off the batch cost (Ind AS 2 para 13).
    for v_out in
      select bo.output_item_id, bo.quantity, bo.nrv_rate, i.uom
        from public.bom_outputs bo
        join public.items i on i.id = bo.output_item_id
       where bo.bom_id = p_bom_id and bo.output_type in ('by_product', 'scrap')
       order by bo.line_order
    loop
      v_out_qty := round(v_out.quantity * v_scale, 3);
      v_out_amount := round(v_out_qty * v_out.nrv_rate, 2);
      v_secondary_total := v_secondary_total + v_out_amount;

      insert into public.voucher_items (
        voucher_id, company_id, branch_id, godown_id, item_id,
        direction, quantity, uom, rate, amount, line_order)
      values (
        v_voucher_id, p_company_id, p_branch_id, p_output_godown_id, v_out.output_item_id,
        'in', v_out_qty, v_out.uom, v_out.nrv_rate, v_out_amount, v_line);
      v_line := v_line + 1;
    end loop;

    v_joint_pool := v_effective_cost_r - v_secondary_total;
    if v_joint_pool < 0 then
      raise exception 'The combined net realisable value of this batch''s scrap/by-products (%) exceeds its total process cost (%) — check the NRV rates on this BOM''s outputs',
        v_secondary_total, v_effective_cost_r;
    end if;

    -- Pass 2: co_product — shares the remaining joint cost pool with the
    -- main product in proportion to relative sales value (Ind AS 2 para
    -- 14 / CAS-19), not simply credited at NRV like a by-product.
    select count(*), coalesce(sum(round(bo.quantity * v_scale, 3) * bo.nrv_rate), 0)
      into v_co_product_count, v_co_weight_total
      from public.bom_outputs bo
     where bo.bom_id = p_bom_id and bo.output_type = 'co_product';

    if v_co_product_count > 0 then
      select sale_rate into v_main_sale_rate from public.items where id = v_bom.output_item_id;
      if coalesce(v_main_sale_rate, 0) <= 0 then
        raise exception 'This BOM has co-products, which need the main product''s own Sale Rate (in its item master) to split the joint cost by relative sales value — set a Sale Rate on % first',
          (select name from public.items where id = v_bom.output_item_id);
      end if;

      v_main_weight := v_main_sale_rate * p_quantity_produced;
      v_total_weight := v_main_weight + v_co_weight_total;
      if v_total_weight <= 0 then
        raise exception 'Cannot allocate joint cost: the total relative sales value of the main product and its co-products is zero';
      end if;

      for v_out in
        select bo.output_item_id, bo.quantity, bo.nrv_rate, i.uom
          from public.bom_outputs bo
          join public.items i on i.id = bo.output_item_id
         where bo.bom_id = p_bom_id and bo.output_type = 'co_product'
         order by bo.line_order
      loop
        v_out_qty := round(v_out.quantity * v_scale, 3);
        v_out_weight := v_out_qty * v_out.nrv_rate;
        v_out_share := round(v_joint_pool * v_out_weight / v_total_weight, 2);
        v_co_output_total := v_co_output_total + v_out_share;

        insert into public.voucher_items (
          voucher_id, company_id, branch_id, godown_id, item_id,
          direction, quantity, uom, rate, amount, line_order)
        values (
          v_voucher_id, p_company_id, p_branch_id, p_output_godown_id, v_out.output_item_id,
          'in', v_out_qty, v_out.uom, round(v_out_share / nullif(v_out_qty, 0), 4), v_out_share, v_line);
        v_line := v_line + 1;
      end loop;
    end if;

    -- Main product takes the exact residual, so
    -- main + by_products/scrap + co_products == effective cost, always —
    -- cost is redistributed across outputs, never created or destroyed.
    v_main_amount := v_joint_pool - v_co_output_total;
    if v_main_amount < 0 then
      raise exception 'Rounding of co-product shares produced a negative main-product cost — check the BOM''s output valuations';
    end if;

    v_output_rate := case when p_quantity_produced > 0 then round(v_main_amount / p_quantity_produced, 4) else 0 end;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, line_order)
    select v_voucher_id, p_company_id, p_branch_id, p_output_godown_id, v_bom.output_item_id,
           'in', p_quantity_produced, i.uom, v_output_rate, v_main_amount, v_main_line
      from public.items i where i.id = v_bom.output_item_id;
  end if;

  v_clearing_ledger := public.ensure_manufacturing_clearing_ledger(p_company_id);

  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_clearing_ledger, v_effective_cost_r, 0, 0);
  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_clearing_ledger, 0, v_effective_cost_r, 1);

  return v_voucher_id;
end;
$$;

revoke all on function public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text) from public, anon;
grant execute on function public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text) to authenticated;

comment on function public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text) is
  'Consumes every BOM component (scaled by quantity_produced/yield_quantity) at its current weighted-average rate from get_stock_summary, exactly as 0070/0114. If the BOM has no bom_outputs rows, the entire effective cost (component cost + additional cost) goes to the main output; if it does, by_product/scrap outputs are netted off at NRV first (Ind AS 2 para 13) and any co_product outputs then share the remaining joint cost by relative sales value (Ind AS 2 para 14 / CAS-19), with the main product taking the exact residual. Uses the existing stock_journal voucher_type. 1070 adds the one thing 0070/0114 never checked: the company''s manufacturing module must actually be active on p_voucher_date (app_private.module_active, 0004) or this raises — matching create_job_work_challan (0069), create_delivery_challan (0113), and record_stock_verification (0165), the same defense-in-depth every other optional module''s posting RPC already has.';
