-- Manufacturing / Bill of Materials — v1.
-- Deliberately does NOT touch VoucherForm.tsx/InvoiceForm.tsx (locked by a
-- concurrent session): production gets its own dedicated entry surface,
-- same pattern as Orders (0061) and Job Work (0069).
--
-- REUSES the exact balanced-voucher resolution this session already made
-- for Job Work (0069), rather than re-deciding it: manufacturing is an
-- internal transformation of a company's own stock — not a "supply" under
-- Sec 7 CGST Act, so real software (Tally's Manufacturing Journal) posts
-- nothing to any ledger for it — but LEKHA's check_voucher_balance (0007)
-- hard-requires every voucher to have >=2 balanced voucher_entries rows.
-- Resolution: a self-cancelling pair — Dr and Cr the SAME "Manufacturing
-- Clearing" memo ledger for the SAME amount (the effective cost of the
-- batch), on the SAME voucher. See 0069's header comment for the full
-- reasoning; this migration doesn't repeat it, just applies it.
--
-- COSTING: reuses get_stock_summary's (0013) own moving-average formula by
-- CALLING it, not duplicating its arithmetic — each component's rate is
-- read straight from get_stock_summary(company, as_at, null).average_rate
-- for that item, exactly the rate the app already shows everywhere else
-- for that item on that date. Effective cost of the batch = sum(component
-- quantity x that rate) + p_additional_cost; the finished item's own
-- receipt rate = effective cost / quantity produced.
--
-- KNOWN SIMPLIFICATION, stated rather than hidden: p_additional_cost (the
-- Tally term for labour/power/etc. actually spent making the batch) is
-- just a number baked into the self-cancelling Manufacturing Clearing
-- pair here, NOT linked to a real already-posted expense voucher. The
-- research surfaced routing it through a real expense voucher as the more
-- rigorous alternative; v1 takes the simpler path so the feature ships
-- with a genuine effective-cost total_amount, at the cost of that number
-- not tying back to an actual cash/bank movement. Worth revisiting if a
-- real user needs that traceability.
--
-- SCOPE, deliberately narrow (the "simplest shape first" discipline this
-- session applied throughout): one BOM per output item (not Tally's
-- multiple-named-BOMs-per-item), no co-product/by-product/scrap typing,
-- one source godown for every component and one destination godown for
-- the finished item.

create table public.bill_of_materials (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  output_item_id uuid not null,
  name text not null default 'Standard',
  yield_quantity numeric(18, 3) not null check (yield_quantity > 0),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  unique (company_id, output_item_id),
  foreign key (output_item_id, company_id) references public.items (id, company_id),
  check (length(trim(name)) > 0)
);

comment on table public.bill_of_materials is
  'One BOM per output item (v1 scope — no Tally-style multiple named/alternate recipes). yield_quantity is the batch size this recipe''s component quantities are defined for; create_production_voucher scales every component by (quantity_produced / yield_quantity).';

alter table public.bill_of_materials enable row level security;

create policy bill_of_materials_read on public.bill_of_materials for select
  using (app_private.is_company_member(company_id));

create policy bill_of_materials_write on public.bill_of_materials for all
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

create trigger set_updated_at before update on public.bill_of_materials
  for each row execute function app_private.set_updated_at();

create or replace function app_private.enforce_bom_output_is_stock_item()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare v_ok boolean;
begin
  select item_type = 'goods' and maintain_stock into v_ok
    from public.items where id = new.output_item_id;
  if not coalesce(v_ok, false) then
    raise exception 'A BOM''s output must be a stock-maintained goods item';
  end if;
  return new;
end;
$$;

create trigger enforce_bom_output_is_stock_item
  before insert or update of output_item_id on public.bill_of_materials
  for each row execute function app_private.enforce_bom_output_is_stock_item();

create table public.bom_components (
  id uuid primary key default gen_random_uuid(),
  bom_id uuid not null references public.bill_of_materials(id) on delete cascade,
  company_id uuid not null,
  component_item_id uuid not null,
  quantity numeric(18, 3) not null check (quantity > 0),
  line_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (bom_id, company_id) references public.bill_of_materials (id, company_id),
  foreign key (component_item_id, company_id) references public.items (id, company_id)
);

create index bom_components_bom_idx on public.bom_components (bom_id);

comment on table public.bom_components is
  'quantity is required per bill_of_materials.yield_quantity units of the output item. No co-product/by-product/scrap typing in v1 — every row here is consumed as a plain input.';

alter table public.bom_components enable row level security;

create policy bom_components_read on public.bom_components for select
  using (app_private.is_company_member(company_id));

create policy bom_components_write on public.bom_components for all
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

create trigger set_updated_at before update on public.bom_components
  for each row execute function app_private.set_updated_at();

create or replace function app_private.enforce_bom_component_not_self()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_output_item_id uuid;
  v_ok boolean;
begin
  select output_item_id into v_output_item_id
    from public.bill_of_materials where id = new.bom_id;

  if v_output_item_id is null then
    raise exception 'BOM % does not exist', new.bom_id;
  end if;
  if v_output_item_id = new.component_item_id then
    raise exception 'A BOM component cannot be the same item as the BOM''s own output — that''s a circular recipe';
  end if;

  select item_type = 'goods' and maintain_stock into v_ok
    from public.items where id = new.component_item_id;
  if not coalesce(v_ok, false) then
    raise exception 'A BOM component must be a stock-maintained goods item';
  end if;

  return new;
end;
$$;

create trigger enforce_bom_component_not_self
  before insert or update on public.bom_components
  for each row execute function app_private.enforce_bom_component_not_self();

-- ---------------------------------------------------------------------------
-- ensure_manufacturing_clearing_ledger — idempotent auto-provision, the
-- exact shape as 0069's ensure_job_work_movement_ledger.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_manufacturing_clearing_ledger(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_group uuid;
  v_ledger uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to set up ledgers for this company';
  end if;

  select id into v_group
    from public.account_groups
   where company_id = p_company_id and name = 'Current Assets'
   limit 1;

  if v_group is null then
    raise exception 'Chart of accounts is not set up for this company yet (no Current Assets group)';
  end if;

  select id into v_ledger
    from public.ledgers
   where company_id = p_company_id and group_id = v_group and name = 'Manufacturing Clearing'
   limit 1;

  if v_ledger is not null then
    return v_ledger;
  end if;

  insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
  values (p_company_id, v_group, 'Manufacturing Clearing', 'debit', 0)
  returning id into v_ledger;

  return v_ledger;
end;
$$;

revoke all on function public.ensure_manufacturing_clearing_ledger(uuid) from public, anon;
grant execute on function public.ensure_manufacturing_clearing_ledger(uuid) to authenticated;

comment on function public.ensure_manufacturing_clearing_ledger(uuid) is
  'Idempotently returns the self-cancelling "Manufacturing Clearing" memo ledger — production vouchers debit and credit it for the SAME amount on the SAME voucher, so its running balance is always zero. Exists purely so those vouchers satisfy check_voucher_balance while carrying a real total_amount.';

-- ---------------------------------------------------------------------------
-- create_production_voucher — consumes every component at its current
-- weighted-average rate (via get_stock_summary), receives the output at
-- effective cost, posts the self-cancelling pair, all as one voucher.
-- ---------------------------------------------------------------------------
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
  v_output_rate numeric;
  v_clearing_ledger uuid;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_voucher_id uuid;
  v_line int := 0;
  v_component_count int := 0;
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
  v_output_rate := round(v_effective_cost / p_quantity_produced, 4);

  insert into public.voucher_items (
    voucher_id, company_id, branch_id, godown_id, item_id,
    direction, quantity, uom, rate, amount, line_order)
  select v_voucher_id, p_company_id, p_branch_id, p_output_godown_id, v_bom.output_item_id,
         'in', p_quantity_produced, i.uom, v_output_rate, round(v_effective_cost, 2), v_line
    from public.items i where i.id = v_bom.output_item_id;

  v_clearing_ledger := public.ensure_manufacturing_clearing_ledger(p_company_id);

  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_clearing_ledger, round(v_effective_cost, 2), 0, 0);
  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_clearing_ledger, 0, round(v_effective_cost, 2), 1);

  return v_voucher_id;
end;
$$;

revoke all on function public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text) from public, anon;
grant execute on function public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text) to authenticated;

comment on function public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text) is
  'Consumes every BOM component (scaled by quantity_produced/yield_quantity) at its current weighted-average rate from get_stock_summary, receives the output item at effective cost (component cost + additional cost) / quantity, and posts the self-cancelling Manufacturing Clearing pair for the effective cost. Uses the existing stock_journal voucher_type (reserved, previously unimplemented).';

-- ---------------------------------------------------------------------------
-- get_boms — list BOMs with their components, for the BOM editor and the
-- production-voucher item picker.
-- ---------------------------------------------------------------------------
create or replace function public.get_boms(p_company_id uuid)
returns table (
  bom_id uuid,
  output_item_id uuid,
  output_item_name text,
  output_uom text,
  name text,
  yield_quantity numeric,
  is_active boolean,
  component_count integer,
  component_cost_at_yield numeric
)
language sql
stable
set search_path to ''
as $$
  select
    b.id, b.output_item_id, i.name, i.uom, b.name, b.yield_quantity, b.is_active,
    count(bc.id)::int,
    coalesce(sum(bc.quantity * coalesce(s.average_rate, 0)), 0)
  from public.bill_of_materials b
  join public.items i on i.id = b.output_item_id
  left join public.bom_components bc on bc.bom_id = b.id
  left join public.get_stock_summary(p_company_id, current_date, null) s on s.item_id = bc.component_item_id
  where b.company_id = p_company_id
  group by b.id, i.name, i.uom
  order by i.name;
$$;

revoke all on function public.get_boms(uuid) from public, anon;
grant execute on function public.get_boms(uuid) to authenticated;

comment on function public.get_boms(uuid) is
  'BOM list with a live estimated cost-per-batch (at yield_quantity, today''s rates) — the same get_stock_summary rates create_production_voucher will actually use, so the estimate does not drift from what a real production run would cost.';
