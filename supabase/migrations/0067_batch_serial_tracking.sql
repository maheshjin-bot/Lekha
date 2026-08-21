-- Batch / serial / expiry tracking — a standalone, additive module.
-- Deliberately does NOT touch VoucherForm.tsx or InvoiceForm.tsx (locked
-- by a concurrent session): incoming stock is tagged with a batch after
-- the fact, on a new /batches workbench, exactly the way cost centres
-- (0057) allocate dimensions after the fact rather than at entry time.
--
-- SCOPE, deliberately narrower than "batch costing": this is a physical
-- quantity + expiry ledger, NOT a valuation engine. get_stock_summary
-- (0013) values stock by moving weighted average across the whole item,
-- and companies.inventory_valuation_method's own column comment already
-- says fifo "needs lot tracking" and is unimplemented — this migration
-- does not change either. Batch balances here are a parallel, physical
-- record; the financial numbers on the balance sheet are untouched.
--
-- ASYMMETRY, stated honestly rather than hidden: tagging INCOMING stock
-- (a purchase/receipt line, direction='in') after receipt is realistic —
-- many businesses physically label cartons on arrival anyway. Tagging
-- OUTGOING stock (a sale/issue line, direction='out') to a specific batch
-- is inherently an after-the-fact reconciliation in this architecture,
-- since InvoiceForm/VoucherForm cannot offer a batch picker while
-- billing. get_unallocated_stock_lines() below is the direct, honest
-- answer to "what hasn't been batch-tagged yet" — the UI must show it,
-- never hide it, exactly like get_cost_centre_pnl's own unallocated row.

-- ---------------------------------------------------------------------------
-- Opt-in flag, mirroring items.maintain_stock's own enforcement style
-- ---------------------------------------------------------------------------
alter table public.items
  add column batch_tracking text not null default 'none'
    check (batch_tracking = any (array['none', 'batch', 'serial']));

alter table public.items
  add constraint items_batch_tracking_needs_stock
    check (batch_tracking = 'none' or (item_type = 'goods' and maintain_stock));

comment on column public.items.batch_tracking is
  'Opt-in flag: none (default) = untracked, batch = quantities grouped under a batch/lot number, serial = one row per physical unit (quantity always 1). Only valid on stock-maintained goods.';

-- ---------------------------------------------------------------------------
-- item_batches — the batch/serial master
-- ---------------------------------------------------------------------------
create table public.item_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  item_id uuid not null,
  batch_no text not null check (length(trim(batch_no)) > 0),
  mfg_date date,
  expiry_date date,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (item_id, company_id) references public.items(id, company_id),
  check (expiry_date is null or mfg_date is null or expiry_date >= mfg_date)
);

-- A batch/serial number is unique per item, case-insensitively (so "B001"
-- and "b001" can't both exist and silently split one physical batch into
-- two ledger rows).
create unique index item_batches_item_batchno_ci_key
  on public.item_batches (company_id, item_id, lower(batch_no));

create index item_batches_expiry_idx on public.item_batches (company_id, expiry_date)
  where expiry_date is not null;

comment on table public.item_batches is
  'Batch/lot or serial-number master for items with batch_tracking <> none. Serial numbers reuse this same table (batch_no repurposed as the serial, quantity forced to 1 by trigger) rather than a parallel table — see enforce_batch_allocation.';

alter table public.item_batches enable row level security;

create policy item_batches_read on public.item_batches for select
  using (app_private.is_company_member(company_id));

create policy item_batches_write on public.item_batches for all
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

create trigger set_updated_at before update on public.item_batches
  for each row execute function app_private.set_updated_at();

-- ---------------------------------------------------------------------------
-- voucher_item_batches — the allocation: which batch(es) a stock line
-- actually was/is, split across multiple batches when needed
-- ---------------------------------------------------------------------------
create table public.voucher_item_batches (
  id uuid primary key default gen_random_uuid(),
  voucher_item_id uuid not null references public.voucher_items(id) on delete cascade,
  -- Denormalised, but never trusted from the client — enforce_batch_allocation
  -- always overwrites it from the voucher_item's own company_id below, so
  -- it can be relied on for RLS without a second join on every read.
  company_id uuid not null,
  batch_id uuid not null,
  quantity numeric(18, 3) not null check (quantity > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (voucher_item_id, batch_id),
  -- Real DB-level guarantee alongside the trigger's business-logic checks
  -- (item match, tracking mode, quantity conservation). Safe to enforce
  -- here even though company_id is client-supplied on insert, because the
  -- BEFORE trigger below overwrites it from the voucher_item's own
  -- company_id before this constraint is checked.
  foreign key (batch_id, company_id) references public.item_batches (id, company_id)
);

create index voucher_item_batches_voucher_item_idx on public.voucher_item_batches (voucher_item_id);
create index voucher_item_batches_batch_idx on public.voucher_item_batches (batch_id);

comment on table public.voucher_item_batches is
  'Which batch(es)/serial(s) a voucher_items stock line belongs to. One line can split across several batches, hence a real join table rather than a single column. Written directly by the client under RLS; enforce_batch_allocation is the actual guard — company_id, item match, serial-quantity-1, and the sum-never-exceeds-the-line invariant all live there, not in application code.';

alter table public.voucher_item_batches enable row level security;

create policy voucher_item_batches_read on public.voucher_item_batches for select
  using (app_private.is_company_member(company_id));

create policy voucher_item_batches_write on public.voucher_item_batches for all
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

create or replace function app_private.enforce_batch_allocation()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_line record;
  v_batch record;
  v_tracking text;
  v_already_allocated numeric;
begin
  select vi.company_id, vi.item_id, vi.direction, vi.quantity
    into v_line
    from public.voucher_items vi
   where vi.id = new.voucher_item_id;

  if v_line is null then
    raise exception 'voucher_item % does not exist', new.voucher_item_id;
  end if;

  -- Never trust a client-supplied company_id — always the line's own.
  new.company_id := v_line.company_id;

  select ib.item_id, ib.company_id into v_batch
    from public.item_batches ib where ib.id = new.batch_id;

  if v_batch is null then
    raise exception 'item_batch % does not exist', new.batch_id;
  end if;
  if v_batch.company_id <> v_line.company_id then
    raise exception 'This batch belongs to a different company than the voucher line';
  end if;
  if v_batch.item_id <> v_line.item_id then
    raise exception 'This batch belongs to a different item than the voucher line — % vs %',
      v_batch.item_id, v_line.item_id;
  end if;

  select batch_tracking into v_tracking
    from public.items where id = v_line.item_id;
  if coalesce(v_tracking, 'none') = 'none' then
    raise exception 'This item is not set up for batch/serial tracking (Items → batch_tracking)';
  end if;
  if v_tracking = 'serial' and new.quantity <> 1 then
    raise exception 'Serial-tracked items must be allocated one unit at a time (quantity = 1)';
  end if;

  select coalesce(sum(quantity), 0) into v_already_allocated
    from public.voucher_item_batches
   where voucher_item_id = new.voucher_item_id
     and id is distinct from new.id;

  if v_already_allocated + new.quantity > v_line.quantity + 0.0005 then
    raise exception 'Allocating % would take this line''s batch total to % — the line is only %',
      new.quantity, v_already_allocated + new.quantity, v_line.quantity;
  end if;

  return new;
end;
$$;

create trigger enforce_batch_allocation
  before insert or update on public.voucher_item_batches
  for each row execute function app_private.enforce_batch_allocation();

-- ---------------------------------------------------------------------------
-- allocate_voucher_item_to_batch — the write path the UI actually uses.
-- A plain client-side insert works for a fresh (line, batch) pair but
-- raises a raw 409 unique-violation the moment someone allocates MORE of
-- the same batch to the same line a second time (e.g. correcting an
-- undercount, or splitting one visit to the workbench into two). Caught by
-- browser-testing this feature before shipping, not assumed away: this RPC
-- makes that case additive (quantity to allocate NOW, on top of whatever
-- this batch already carries on this line) rather than erroring or, worse,
-- silently replacing the earlier quantity if a plain upsert() were used
-- instead.
-- ---------------------------------------------------------------------------
create or replace function public.allocate_voucher_item_to_batch(
  p_company_id uuid,
  p_voucher_item_id uuid,
  p_batch_id uuid,
  p_quantity numeric
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_id uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to allocate batches for this company';
  end if;
  if not (p_quantity > 0) then
    raise exception 'Quantity to allocate must be greater than zero';
  end if;

  insert into public.voucher_item_batches (voucher_item_id, company_id, batch_id, quantity, created_by)
  values (p_voucher_item_id, p_company_id, p_batch_id, p_quantity, auth.uid())
  on conflict (voucher_item_id, batch_id)
  do update set quantity = public.voucher_item_batches.quantity + excluded.quantity
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.allocate_voucher_item_to_batch(uuid, uuid, uuid, numeric) from public, anon;
grant execute on function public.allocate_voucher_item_to_batch(uuid, uuid, uuid, numeric) to authenticated;

comment on function public.allocate_voucher_item_to_batch(uuid, uuid, uuid, numeric) is
  'The allocation write path: adds p_quantity to whatever this batch already carries on this voucher_item line (additive, not a replace), so re-allocating the same batch to the same line a second time tops up instead of raising a unique-constraint conflict or silently discarding the earlier quantity. enforce_batch_allocation (the BEFORE trigger on voucher_item_batches) still does the actual item-match / tracking-mode / quantity-conservation validation on both the insert and the update path this produces.';

-- ---------------------------------------------------------------------------
-- upsert_item_batch — "create batch on the fly" (Tally's own phrase for
-- exactly this UX), idempotent on (company, item, batch_no) case-insensitive
-- ---------------------------------------------------------------------------
create or replace function public.upsert_item_batch(
  p_company_id uuid,
  p_item_id uuid,
  p_batch_no text,
  p_mfg_date date default null,
  p_expiry_date date default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_id uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to manage batches for this company';
  end if;

  insert into public.item_batches (company_id, item_id, batch_no, mfg_date, expiry_date, notes, created_by)
  values (p_company_id, p_item_id, trim(p_batch_no), p_mfg_date, p_expiry_date, p_notes, auth.uid())
  on conflict (company_id, item_id, lower(batch_no))
  do update set
    mfg_date = coalesce(excluded.mfg_date, public.item_batches.mfg_date),
    expiry_date = coalesce(excluded.expiry_date, public.item_batches.expiry_date),
    notes = coalesce(excluded.notes, public.item_batches.notes),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.upsert_item_batch(uuid, uuid, text, date, date, text) from public, anon;
grant execute on function public.upsert_item_batch(uuid, uuid, text, date, date, text) to authenticated;

comment on function public.upsert_item_batch(uuid, uuid, text, date, date, text) is
  'Idempotent "create batch on the fly": finds the existing batch for (item, batch_no) case-insensitively, or creates it. Dates/notes on a repeat call only fill in what was previously null, never overwrite a value someone already set.';

-- ---------------------------------------------------------------------------
-- get_unallocated_stock_lines — the honest work-queue: stock lines on
-- batch-tracked items that don't yet have (full) batch allocation
-- ---------------------------------------------------------------------------
create or replace function public.get_unallocated_stock_lines(
  p_company_id uuid,
  p_direction text default null,
  p_from date default null,
  p_to date default null
)
returns table (
  voucher_item_id uuid,
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  item_id uuid,
  item_name text,
  uom text,
  direction text,
  godown_id uuid,
  godown_name text,
  line_quantity numeric,
  allocated_quantity numeric,
  unallocated_quantity numeric
)
language sql
stable
set search_path to ''
as $$
  select
    vi.id, v.id, v.voucher_number, v.voucher_date,
    i.id, i.name, vi.uom, vi.direction,
    g.id, g.name,
    vi.quantity,
    coalesce(a.allocated, 0),
    vi.quantity - coalesce(a.allocated, 0)
  from public.voucher_items vi
  join public.vouchers v on v.id = vi.voucher_id
  join public.items i on i.id = vi.item_id
  left join public.godowns g on g.id = vi.godown_id
  left join (
    select voucher_item_id, sum(quantity) as allocated
      from public.voucher_item_batches
     group by voucher_item_id
  ) a on a.voucher_item_id = vi.id
  where vi.company_id = p_company_id
    and not v.is_deleted
    and i.batch_tracking <> 'none'
    and (p_direction is null or vi.direction = p_direction)
    and (p_from is null or v.voucher_date >= p_from)
    and (p_to is null or v.voucher_date <= p_to)
    and vi.quantity - coalesce(a.allocated, 0) > 0.0005
  order by v.voucher_date, v.voucher_number;
$$;

revoke all on function public.get_unallocated_stock_lines(uuid, text, date, date) from public, anon;
grant execute on function public.get_unallocated_stock_lines(uuid, text, date, date) to authenticated;

comment on function public.get_unallocated_stock_lines(uuid, text, date, date) is
  'The batch workbench work-queue and the honesty banner for the expiry report: every stock line on a batch-tracked item whose allocated batch quantity is less than the line quantity. Never silently dropped — the expiry report must surface this count, not hide it.';

-- ---------------------------------------------------------------------------
-- get_batch_stock_summary — per item+batch physical balance and expiry
-- ---------------------------------------------------------------------------
create or replace function public.get_batch_stock_summary(
  p_company_id uuid,
  p_as_at date default current_date,
  p_godown_id uuid default null
)
returns table (
  batch_id uuid,
  item_id uuid,
  item_name text,
  uom text,
  batch_no text,
  mfg_date date,
  expiry_date date,
  days_to_expiry integer,
  quantity_in numeric,
  quantity_out numeric,
  quantity_on_hand numeric
)
language sql
stable
set search_path to ''
as $$
  with movements as (
    select vib.batch_id, vi.direction, vib.quantity
      from public.voucher_item_batches vib
      join public.voucher_items vi on vi.id = vib.voucher_item_id
      join public.vouchers v on v.id = vi.voucher_id
     where vib.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
       and (p_godown_id is null or vi.godown_id = p_godown_id)
  ),
  totals as (
    select
      b.id as batch_id, i.id as item_id, i.name as item_name, i.uom,
      b.batch_no, b.mfg_date, b.expiry_date,
      coalesce(sum(m.quantity) filter (where m.direction = 'in'), 0) as qty_in,
      coalesce(sum(m.quantity) filter (where m.direction = 'out'), 0) as qty_out
    from public.item_batches b
    join public.items i on i.id = b.item_id
    left join movements m on m.batch_id = b.id
    where b.company_id = p_company_id
    group by b.id, i.id, i.name, i.uom, b.batch_no, b.mfg_date, b.expiry_date
  )
  select
    batch_id, item_id, item_name, uom, batch_no, mfg_date, expiry_date,
    case when expiry_date is null then null else (expiry_date - p_as_at) end,
    qty_in, qty_out, (qty_in - qty_out)
  from totals
  where qty_in <> 0 or qty_out <> 0
  order by (expiry_date is null), expiry_date, item_name, batch_no;
$$;

revoke all on function public.get_batch_stock_summary(uuid, date, uuid) from public, anon;
grant execute on function public.get_batch_stock_summary(uuid, date, uuid) to authenticated;

comment on function public.get_batch_stock_summary(uuid, date, uuid) is
  'Per item+batch physical quantity balance and days-to-expiry, sourced from voucher_item_batches allocations only — a parallel quantity ledger, deliberately not the same thing as get_stock_summary''s financial valuation.';
