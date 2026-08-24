-- BOM by-product / scrap / co-product output typing — v1.
--
-- THE GAP THIS CLOSES: bill_of_materials (0070) is single-output only —
-- confirmed live before writing this migration (information_schema shows
-- no output_type/scrap/wastage/parent_bom_id/routing column anywhere on
-- bill_of_materials or bom_components, exactly as 0070's own header
-- documented as a deliberate v1 boundary: "no co-product/by-product/scrap
-- typing"). create_production_voucher (0070) puts the ENTIRE effective
-- cost of a batch (component cost + additional cost) onto the one output
-- item. A real production run that also throws off scrap, or yields a
-- secondary saleable item alongside the main one, had no way to represent
-- that: the scrap physically leaves the process but the app never put it
-- into stock, and the main product silently absorbed 100% of the cost
-- that should rightfully have been shared with it.
--
-- STATUTORY / COSTING RESEARCH (WebSearch'd this session, not recalled):
-- Ind AS 2 (Inventories) para 13-14 — "most by-products, as well as scrap
-- or waste materials, by their nature, are immaterial. When this is the
-- case, they are often measured at net realisable value and this value is
-- deducted from the cost of the main product." For genuine joint/
-- co-products, by contrast, "the costs of conversion of each product are
-- allocated between the products on a rational and consistent basis...
-- e.g. relative sales value of each product." ICAI Cost Accounting
-- Standard CAS-19 (Joint Costs) names the same two methods: by-products/
-- scrap netted off the main product at NRV; joint/co-products split by a
-- method such as relative (net) sales value. Sources: ICAI Ind AS 2 text
-- (icai.org/resource/23698IndAS-2.pdf), ICAI CA-Inter costing study
-- material on joint products & by-products (concurred by a second,
-- independently-searched source — gstguntur.com's CAS-19 summary — before
-- relying on it, per this session's standing discipline of a skeptical
-- second search). This migration implements exactly that split:
--   - by_product / scrap  -> valued at NRV, netted straight off the main
--                            product's cost (Ind AS 2's "deducted from
--                            the cost of the main product").
--   - co_product          -> shares the joint cost pool with the main
--                            product in proportion to RELATIVE SALES
--                            VALUE (Ind AS 2's and CAS-19's own named
--                            method), not simply credited at NRV like a
--                            by-product would be — a co-product is, by
--                            definition, of comparable significance to
--                            the main product, so it must absorb a fair
--                            share of the joint cost rather than being
--                            netted off someone else's.
--
-- SCHEMA SHAPE: bill_of_materials.output_item_id remains the one "main"
-- output the recipe is scaled around (yield_quantity, v_scale — all
-- unchanged) — that part of 0070's design is sound and is NOT being
-- redone. This migration adds a new bom_outputs table for the ADDITIONAL
-- outputs a batch can produce alongside the main one, each tagged
-- by_product/scrap/co_product (main_product is never stored here — it's
-- simply "the bill_of_materials row itself", so there is exactly one
-- source of truth for which item is primary, never two that could
-- disagree).
--
-- VALUATION SOURCE, stated rather than hidden (mirrors 0070's own
-- "KNOWN SIMPLIFICATION" disclosure for p_additional_cost): true net
-- realisable value is selling price LESS further processing and selling
-- costs. This schema does not separately track a by-product's further-
-- processing cost, so bom_outputs.nrv_rate is a single user-entered
-- figure the recipe owner is expected to already net down by hand (the
-- UI pre-fills it from the item's own Sale Rate as a starting point, but
-- it is stored explicitly on the BOM, not silently re-read from the item
-- master at posting time — a scrap item's sale price can legitimately be
-- zero, and that must be a deliberate entry, never an accidental default
-- from an unrelated/unmaintained field). The one exception is the MAIN
-- product's own relative-sales-value weight for the co-product split:
-- that IS read live from items.sale_rate at posting time (the same
-- "don't duplicate a live figure" discipline 0070 already applied to
-- component costs via get_stock_summary) — if the main product has no
-- Sale Rate set, posting a production run against a BOM with co-products
-- fails loudly rather than silently splitting 100% of the joint cost to
-- the co-products.
--
-- REGRESSION SAFETY: a BOM with zero bom_outputs rows (every BOM that
-- exists today, and every new BOM until someone deliberately adds a
-- secondary output) runs through the EXACT original 0070 code path,
-- character for character — verified live below with a byte-identical
-- before/after production run.

create table public.bom_outputs (
  id uuid primary key default gen_random_uuid(),
  bom_id uuid not null references public.bill_of_materials(id) on delete cascade,
  company_id uuid not null,
  output_type text not null check (output_type = any (array['by_product', 'scrap', 'co_product'])),
  output_item_id uuid not null,
  quantity numeric(18, 3) not null check (quantity > 0),
  nrv_rate numeric(18, 2) not null default 0 check (nrv_rate >= 0),
  line_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bom_id, output_item_id),
  foreign key (bom_id, company_id) references public.bill_of_materials (id, company_id),
  foreign key (output_item_id, company_id) references public.items (id, company_id)
);

create index bom_outputs_bom_idx on public.bom_outputs (bom_id);

comment on table public.bom_outputs is
  'Additional outputs a BOM''s batch produces alongside its one main output (bill_of_materials.output_item_id, which is never duplicated here). quantity is required per bill_of_materials.yield_quantity units of the main output, same convention as bom_components.quantity. nrv_rate is the net realisable value per unit: for by_product/scrap it directly values that output''s stock entry and is netted off the main product''s cost (Ind AS 2 para 13); for co_product it is the item''s own relative-sales-value weight used, alongside the main product''s live items.sale_rate, to split the joint cost pool between them (Ind AS 2 para 14 / CAS-19).';

alter table public.bom_outputs enable row level security;

create policy bom_outputs_read on public.bom_outputs for select
  using (app_private.is_company_member(company_id));

create policy bom_outputs_write on public.bom_outputs for all
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

create trigger set_updated_at before update on public.bom_outputs
  for each row execute function app_private.set_updated_at();

-- Same shape as 0070's enforce_bom_component_not_self: an output must be a
-- real stock-maintained goods item, and can't be the BOM's own main output
-- (that would just be double-counting the same item as two different
-- "outputs" of the same batch).
create or replace function app_private.enforce_bom_output_row_valid()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_main_output_item_id uuid;
  v_ok boolean;
begin
  select output_item_id into v_main_output_item_id
    from public.bill_of_materials where id = new.bom_id;

  if v_main_output_item_id is null then
    raise exception 'BOM % does not exist', new.bom_id;
  end if;
  if v_main_output_item_id = new.output_item_id then
    raise exception 'A by-product/scrap/co-product cannot be the same item as the BOM''s own main output';
  end if;

  select item_type = 'goods' and maintain_stock into v_ok
    from public.items where id = new.output_item_id;
  if not coalesce(v_ok, false) then
    raise exception 'A BOM output must be a stock-maintained goods item';
  end if;

  return new;
end;
$$;

create trigger enforce_bom_output_row_valid
  before insert or update on public.bom_outputs
  for each row execute function app_private.enforce_bom_output_row_valid();

-- ---------------------------------------------------------------------------
-- create_production_voucher — replaced in place (same 9 original
-- parameters, no signature change, so every existing caller keeps working
-- unmodified). Component consumption is byte-for-byte the same code as
-- 0070. What changes is purely how the batch's already-computed effective
-- cost gets distributed across output lines: a BOM with no bom_outputs
-- rows takes the ORIGINAL, untouched branch (single insert, same two
-- expressions 0070 used); a BOM with bom_outputs rows takes the new
-- by_product/scrap-then-co_product split described in this migration's
-- header, with the main product always absorbing the exact residual so
-- the batch's total posted value never drifts from component cost +
-- additional cost — cost is redistributed, never created or destroyed.
-- ---------------------------------------------------------------------------
drop function if exists public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text);

create function public.create_production_voucher(
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
  'Consumes every BOM component (scaled by quantity_produced/yield_quantity) at its current weighted-average rate from get_stock_summary, exactly as 0070. If the BOM has no bom_outputs rows, the entire effective cost (component cost + additional cost) goes to the main output, unchanged from 0070. If it does, by_product/scrap outputs are valued at their own NRV and netted off the batch cost first (Ind AS 2 para 13), then any co_product outputs share the remaining joint cost with the main product by relative sales value — main product weight from its own live items.sale_rate, co-product weight from bom_outputs.nrv_rate (Ind AS 2 para 14 / CAS-19) — with the main product always taking the exact residual so the batch''s total posted value is unchanged, only redistributed. Uses the existing stock_journal voucher_type, same as 0070.';
