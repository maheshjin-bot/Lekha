-- ============================================================================
-- 0165 — Physical stock verification, shortage/excess write-off, and stock
-- ageing. Fills the gap 0038 (Form 3CD Clause 35) named explicitly:
--   "NOT COMPUTED: shortage/excess. That column compares the book closing
--    quantity against an actual physical stock count — LEKHA has no
--    physical stock-take feature to compare the book figure against."
-- That sentence is now false where a real count has actually been recorded
-- — see the get_quantitative_stock_details revision at the end of this file.
-- ============================================================================
--
-- WHAT THIS BUILDS
--   1. public.stock_verifications — one row per physical-count EVENT (an
--      item, at a godown, optionally a batch, as at a date): the book
--      quantity the system believed, what was actually counted, and the
--      resulting variance. Written even when the count matches exactly — a
--      clean count is still a real audit fact worth keeping, not just the
--      exceptions.
--   2. public.record_stock_verification — the one write path. Reads the
--      book quantity and rate from get_stock_summary (0013/0074) — never a
--      separate valuation — and, only when the physical count differs from
--      the book figure, posts a stock_journal adjustment voucher for the
--      variance, valued at that same rate.
--   3. public.get_stock_ageing — how long the quantity actually on hand has
--      sat there, FIFO-style, bucketed. No new capture: derived purely from
--      voucher_date + voucher_items, exactly as the task brief specified.
--
-- WHY A DEDICATED SCREEN, NOT VoucherForm — same reason as job work (0069)
-- and manufacturing (0070): VoucherForm's own VOUCHER_TYPES list is
-- receipt/payment/contra/journal only, and VoucherForm is off-limits this
-- batch besides. stock_journal has been sitting in the voucher_type CHECK
-- constraint (0007) since day one with no entry point anywhere in the app.
-- This is its second user, after manufacturing.
--
-- THE SELF-CANCELLING LEDGER, ONE MORE TIME — REUSING THE JOB-WORK /
-- MANUFACTURING RESOLUTION, NOT RE-DECIDING IT. A physical-count adjustment
-- is a REAL stock movement (the shelf now has 5 fewer units, full stop) but,
-- like manufacturing's internal transformation, it is not itself a "supply"
-- with a natural counterparty ledger the way a purchase or sale is —
-- check_voucher_balance (0007) still hard-requires >=2 balanced
-- voucher_entries rows on every voucher regardless. So: Dr and Cr the SAME
-- "Stock Verification Adjustment" memo ledger for the SAME amount, on the
-- SAME voucher — exactly 0069/0070's pattern, applied here rather than
-- re-argued.
--
-- STATED HONESTLY, NOT SILENTLY: in a fuller implementation a shortage
-- would normally be expensed (Dr a "Stock Shortage" P&L account) and an
-- excess taken to other income, which is the real accounting treatment a
-- physical verification write-off deserves. That is a genuine per-P&L
-- decision (which expense/income head, whether it is even allowable under
-- Sec 37/business-loss tests) this task was not asked to make, and the task
-- brief itself named "whatever memo/adjustment ledger convention you use —
-- check the job-work/manufacturing precedent" as the expected shape. v1
-- therefore records the real quantity movement (so get_stock_summary,
-- ageing, and Clause 35 all see the corrected figure) without taking a
-- position on which P&L head absorbs it. Worth revisiting with a real
-- costing/COA conversation, not guessed at here.
--
-- WHY GODOWN IS REQUIRED, NOT OPTIONAL, ON EVERY VERIFICATION ROW. The task
-- brief says "optionally per godown/batch" — read here as: the BATCH
-- dimension is optional, but the GODOWN one cannot honestly be, because a
-- physical count is, by definition, of what is physically sitting in one
-- location. A "company-wide count" is really N per-godown counts done on
-- the same day; nothing is lost by requiring the godown on every row, and
-- it is also the only way to post a well-defined adjustment voucher —
-- voucher_items.godown_id is NOT NULL (0013), so a company-wide count with
-- a variance would have nowhere well-defined to post the adjustment into.
-- A company with exactly one godown (the common case) just always picks it.
--
-- VALUATION: reuses get_stock_summary's own average_rate for the item, at
-- the SAME godown filter used for the book quantity — never a separate
-- valuation, per the task brief. For a batch-scoped count, book_quantity
-- comes from get_batch_stock_summary (0067), which has no per-batch rate of
-- its own, so the RATE still comes from get_stock_summary at the item level
-- — the same "each godown/item has one rate, not a per-lot cost" simplicity
-- 0074 already committed this engine to (weighted-average only, FIFO
-- rejected as a valuation method until a real lot-costing engine exists).
--
-- STOCK AGEING — FIFO-STYLE BUCKETING WITHOUT A COST-LAYER TABLE. Checked
-- live just before writing this: no stock_cost_layers table (or anything
-- FIFO-shaped) exists yet in this database —
--   select table_name from information_schema.tables where table_schema=
--     'public' and table_name in ('stock_cost_layers','stock_verifications');
--   -> [] (neither existed before this migration)
-- — so this uses the task brief's stated fallback: a FIFO-style replay of
-- voucher_items rows themselves (opening_quantity treated as the oldest
-- possible layer; every inward voucher_items row after it, oldest first;
-- outward movements consume the oldest remaining layers first), entirely
-- derived, no new capture. QUANTITY is genuinely FIFO-ordered this way.
-- VALUE is not a fabricated per-layer FIFO cost, though — each bucket's
-- quantity is valued at the item's one weighted-average rate from
-- get_stock_summary, the same rate this whole engine has committed to
-- since 0074 ("the schema accepted a valuation method the engine cannot
-- perform" — FIFO valuation is exactly that trap, so this does not invent
-- a second, undeclared valuation method just for the ageing report).
--
-- A KNOWN, STATED EDGE CASE: an item whose recorded OUTWARD movements
-- exceed its recorded INWARD movements (closing_quantity negative — seen
-- live in this very database on unrelated pre-existing test data, e.g.
-- "Finished Widget" at -375) has no layer to assign the unaccounted excess
-- to; get_stock_ageing floors each layer at zero and cannot report a
-- negative age bucket, so its total for such an item will not match
-- get_stock_summary's negative closing_quantity. This is a pre-existing
-- data-integrity question (stock sold that was never recorded as
-- received), not something this migration introduces or can silently paper
-- over — stated here rather than faked. Verified live against a clean item
-- with no such history (see final report).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- stock_verifications — the physical-count audit record. Written for every
-- count, including a clean one (variance_quantity = 0, adjustment_voucher_id
-- null) — the count itself is the audit fact 3CD Clause 35 cares about, not
-- just the exceptions.
-- ----------------------------------------------------------------------------
create table public.stock_verifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  item_id uuid not null,
  godown_id uuid not null,
  batch_id uuid,

  verification_date date not null,

  -- What get_stock_summary (or get_batch_stock_summary, batch-scoped) said
  -- as at verification_date, at this godown, at the moment of recording.
  -- Can be negative — this schema has real items with a negative book
  -- balance from unrelated prior data issues, and honestly recording
  -- "the book said -22" is correct; there is nothing to floor here.
  book_quantity numeric(18, 3) not null,
  -- What was actually counted. A physical count cannot be negative.
  physical_quantity numeric(18, 3) not null check (physical_quantity >= 0),
  -- Always physical_quantity - book_quantity, enforced by the trigger below
  -- regardless of write path — never trusted from the client even though
  -- record_stock_verification (the intended path) computes it correctly too.
  variance_quantity numeric(18, 3) not null default 0,
  -- The rate applied — get_stock_summary's own average_rate for this item,
  -- at this same godown filter, as at verification_date. Kept on the row
  -- (not just implied by variance_value/variance_quantity) so a reader can
  -- see what valuation was actually used without recomputing it.
  average_rate numeric(18, 4) not null default 0 check (average_rate >= 0),
  -- Always variance_quantity * average_rate, rounded — enforced by trigger.
  variance_value numeric(18, 2) not null default 0,

  -- Set after the fact by record_stock_verification when variance_quantity
  -- <> 0; null for a clean count, or (in principle) if an adjustment was
  -- deliberately not posted. Composite FK, not just a bare uuid — see
  -- AGENTS.md tenancy convention.
  adjustment_voucher_id uuid,

  notes text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (item_id, company_id) references public.items (id, company_id),
  foreign key (godown_id, company_id) references public.godowns (id, company_id),
  foreign key (batch_id, company_id) references public.item_batches (id, company_id),
  foreign key (adjustment_voucher_id, company_id) references public.vouchers (id, company_id)
);

create index stock_verifications_company_idx on public.stock_verifications (company_id, verification_date desc);
create index stock_verifications_item_idx on public.stock_verifications (company_id, item_id, verification_date desc);

comment on table public.stock_verifications is
  'Physical stock-take audit trail: one row per (item, godown, optional batch, date) count event, written even when the count matches the book figure exactly. book_quantity/average_rate are read from get_stock_summary/get_batch_stock_summary at write time — never a separate valuation. When variance_quantity <> 0, record_stock_verification posts a stock_journal adjustment voucher and links it via adjustment_voucher_id; a clean count leaves that null. Fills the gap 0038''s get_quantitative_stock_details (Form 3CD Clause 35) named explicitly as not computed.';

comment on column public.stock_verifications.godown_id is
  'Required, not optional — a physical count is inherently of what is physically in one location, and voucher_items.godown_id (0013) is itself NOT NULL, so a company-wide count would have nowhere well-defined to post an adjustment into. A single-godown company just always picks its one godown. See migration header.';

alter table public.stock_verifications enable row level security;

create policy stock_verifications_read on public.stock_verifications
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy stock_verifications_write on public.stock_verifications
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

create trigger set_updated_at before update on public.stock_verifications
  for each row execute function app_private.set_updated_at();


-- ----------------------------------------------------------------------------
-- enforce_stock_verification_variance — variance_quantity/variance_value
-- are always DERIVED from book/physical/rate, on every insert and update,
-- regardless of write path. Same defensive shape as 0119's
-- enforce_exim_shipment_voucher recomputing export_realisation_due_date.
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_stock_verification_variance()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  new.variance_quantity := new.physical_quantity - new.book_quantity;
  new.variance_value := round(new.variance_quantity * new.average_rate, 2);
  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_stock_verification_variance
  before insert or update on public.stock_verifications
  for each row execute function app_private.enforce_stock_verification_variance();

comment on function app_private.enforce_stock_verification_variance() is
  'variance_quantity = physical_quantity - book_quantity, variance_value = round(variance_quantity * average_rate, 2) — always recomputed here, never trusted from the client, even though record_stock_verification (the intended write path) already computes both correctly.';


-- ----------------------------------------------------------------------------
-- ensure_stock_verification_adjustment_ledger — idempotent auto-provision,
-- same shape as 0069's ensure_job_work_movement_ledger and 0070's
-- ensure_manufacturing_clearing_ledger.
-- ----------------------------------------------------------------------------
create or replace function public.ensure_stock_verification_adjustment_ledger(p_company_id uuid)
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
   where company_id = p_company_id and group_id = v_group and name = 'Stock Verification Adjustment'
   limit 1;

  if v_ledger is not null then
    return v_ledger;
  end if;

  insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
  values (p_company_id, v_group, 'Stock Verification Adjustment', 'debit', 0)
  returning id into v_ledger;

  return v_ledger;
end;
$$;

revoke all on function public.ensure_stock_verification_adjustment_ledger(uuid) from public, anon;
grant execute on function public.ensure_stock_verification_adjustment_ledger(uuid) to authenticated;

comment on function public.ensure_stock_verification_adjustment_ledger(uuid) is
  'Idempotently returns the self-cancelling "Stock Verification Adjustment" memo ledger — shortage/excess adjustment vouchers debit and credit it for the SAME amount on the SAME voucher, so its running balance is always zero. Exists purely so those vouchers satisfy check_voucher_balance while carrying a real total_amount. See migration header on why this is a memo ledger, not a real P&L expense/income head.';


-- ----------------------------------------------------------------------------
-- record_stock_verification — the one write path. Reads book_quantity and
-- average_rate from get_stock_summary/get_batch_stock_summary, inserts the
-- audit row, and — only when the count actually differs — posts the
-- stock_journal adjustment voucher, all atomically.
-- ----------------------------------------------------------------------------
create or replace function public.record_stock_verification(
  p_company_id uuid,
  p_branch_id uuid,
  p_item_id uuid,
  p_godown_id uuid,
  p_verification_date date,
  p_physical_quantity numeric,
  p_batch_id uuid default null,
  p_notes text default null
)
returns table (
  verification_id uuid,
  book_quantity numeric,
  physical_quantity numeric,
  variance_quantity numeric,
  average_rate numeric,
  variance_value numeric,
  adjustment_voucher_id uuid
)
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item record;
  v_batch record;
  v_book_quantity numeric;
  v_rate numeric;
  v_variance_qty numeric;
  v_variance_value numeric;
  v_verification_id uuid;
  v_voucher_id uuid;
  v_voucher_item_id uuid;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_ledger uuid;
  v_direction text;
  v_adj_qty numeric;
  v_adj_amount numeric;
  v_narration text;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to record a physical stock verification for this company';
  end if;
  if not app_private.module_active(p_company_id, 'inventory', p_verification_date) then
    raise exception 'Inventory is not an active module for this company';
  end if;
  if p_physical_quantity < 0 then
    raise exception 'A physical count cannot be negative';
  end if;
  if p_verification_date > current_date then
    raise exception 'Verification date cannot be in the future';
  end if;

  select id, item_type, maintain_stock, uom, batch_tracking into v_item
    from public.items
   where id = p_item_id and company_id = p_company_id;
  if v_item.id is null then
    raise exception 'Item % does not exist in this company', p_item_id;
  end if;
  if v_item.item_type <> 'goods' or not v_item.maintain_stock then
    raise exception 'Only stock-maintained goods items can be physically verified';
  end if;

  if not exists (
    select 1 from public.godowns
     where id = p_godown_id and company_id = p_company_id and is_active
  ) then
    raise exception 'Godown % does not exist (or is inactive) in this company', p_godown_id;
  end if;

  if p_batch_id is not null then
    select id, item_id, company_id into v_batch
      from public.item_batches
     where id = p_batch_id;
    if v_batch.id is null or v_batch.company_id <> p_company_id then
      raise exception 'Batch % does not exist in this company', p_batch_id;
    end if;
    if v_batch.item_id <> p_item_id then
      raise exception 'Batch % belongs to a different item than %', p_batch_id, p_item_id;
    end if;
    if v_item.batch_tracking = 'none' then
      raise exception 'This item is not set up for batch/serial tracking (Items → batch tracking)';
    end if;
  end if;

  -- Book quantity: batch-scoped uses get_batch_stock_summary (0067); the
  -- whole-item/godown case uses get_stock_summary (0013/0074). Either way
  -- the RATE always comes from get_stock_summary at the item level — see
  -- migration header on why (no per-batch rate exists in this schema).
  if p_batch_id is not null then
    select s.quantity_on_hand into v_book_quantity
      from public.get_batch_stock_summary(p_company_id, p_verification_date, p_godown_id) s
     where s.batch_id = p_batch_id;
  else
    select s.closing_quantity into v_book_quantity
      from public.get_stock_summary(p_company_id, p_verification_date, p_godown_id) s
     where s.item_id = p_item_id;
  end if;
  v_book_quantity := coalesce(v_book_quantity, 0);

  select s.average_rate into v_rate
    from public.get_stock_summary(p_company_id, p_verification_date, p_godown_id) s
   where s.item_id = p_item_id;
  v_rate := coalesce(v_rate, 0);

  v_variance_qty := p_physical_quantity - v_book_quantity;
  v_variance_value := round(v_variance_qty * v_rate, 2);

  insert into public.stock_verifications (
    company_id, branch_id, item_id, godown_id, batch_id, verification_date,
    book_quantity, physical_quantity, average_rate, notes, created_by
  ) values (
    p_company_id, p_branch_id, p_item_id, p_godown_id, p_batch_id, p_verification_date,
    v_book_quantity, p_physical_quantity, v_rate, p_notes, auth.uid()
  )
  returning id into v_verification_id;

  if v_variance_qty <> 0 then
    v_direction := case when v_variance_qty > 0 then 'in' else 'out' end;
    v_adj_qty := abs(v_variance_qty);
    v_adj_amount := abs(v_variance_value);
    v_narration := case when v_direction = 'in'
      then 'Physical stock verification — excess written on'
      else 'Physical stock verification — shortage written off'
    end;

    select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
      from app_private.next_voucher_number(p_company_id, p_branch_id, 'stock_journal', p_verification_date);

    insert into public.vouchers (
      company_id, branch_id, voucher_type, voucher_number, sequence_number,
      financial_year_label, voucher_date, narration, created_by)
    values (
      p_company_id, p_branch_id, 'stock_journal', v_display_number, v_seq,
      v_fy, p_verification_date, v_narration, auth.uid())
    returning id into v_voucher_id;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, p_godown_id, p_item_id,
      v_direction, v_adj_qty, v_item.uom, v_rate, v_adj_amount, 0)
    returning id into v_voucher_item_id;

    if p_batch_id is not null then
      perform public.allocate_voucher_item_to_batch(p_company_id, v_voucher_item_id, p_batch_id, v_adj_qty);
    end if;

    -- Self-cancelling pair — see migration header for why. If v_adj_amount
    -- is zero (no cost basis yet for this item), still post the pair at
    -- zero so >=2 lines exists, same as job work/manufacturing.
    v_ledger := public.ensure_stock_verification_adjustment_ledger(p_company_id);
    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_voucher_id, p_company_id, p_branch_id, v_ledger, v_adj_amount, 0, 0);
    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_voucher_id, p_company_id, p_branch_id, v_ledger, 0, v_adj_amount, 1);

    update public.stock_verifications
       set adjustment_voucher_id = v_voucher_id
     where id = v_verification_id;
  end if;

  return query
    select v_verification_id, v_book_quantity, p_physical_quantity, v_variance_qty,
           v_rate, v_variance_value, v_voucher_id;
end;
$$;

revoke all on function public.record_stock_verification(uuid, uuid, uuid, uuid, date, numeric, uuid, text) from public, anon;
grant execute on function public.record_stock_verification(uuid, uuid, uuid, uuid, date, numeric, uuid, text) to authenticated;

comment on function public.record_stock_verification(uuid, uuid, uuid, uuid, date, numeric, uuid, text) is
  'Records a physical stock count against the book figure from get_stock_summary (or get_batch_stock_summary when p_batch_id is given), at p_godown_id, as at p_verification_date. Always writes a stock_verifications audit row. When the physical count differs from the book quantity, also posts a stock_journal adjustment voucher (in for excess, out for shortage) valued at get_stock_summary''s own average_rate, with the self-cancelling Stock Verification Adjustment ledger pair, and links it via adjustment_voucher_id.';


-- ----------------------------------------------------------------------------
-- get_stock_verifications — listing for the /stock-verification screen's
-- history table.
-- ----------------------------------------------------------------------------
create or replace function public.get_stock_verifications(
  p_company_id uuid,
  p_from_date date default null,
  p_to_date date default null
)
returns table (
  verification_id uuid,
  item_id uuid,
  item_name text,
  uom text,
  godown_id uuid,
  godown_name text,
  batch_id uuid,
  batch_no text,
  verification_date date,
  book_quantity numeric,
  physical_quantity numeric,
  variance_quantity numeric,
  average_rate numeric,
  variance_value numeric,
  adjustment_voucher_id uuid,
  adjustment_voucher_number text,
  notes text,
  created_at timestamptz
)
language sql
stable
set search_path to ''
as $$
  select
    sv.id, sv.item_id, i.name, i.uom,
    sv.godown_id, g.name,
    sv.batch_id, b.batch_no,
    sv.verification_date, sv.book_quantity, sv.physical_quantity, sv.variance_quantity,
    sv.average_rate, sv.variance_value,
    sv.adjustment_voucher_id, v.voucher_number,
    sv.notes, sv.created_at
  from public.stock_verifications sv
  join public.items i on i.id = sv.item_id
  join public.godowns g on g.id = sv.godown_id
  left join public.item_batches b on b.id = sv.batch_id
  left join public.vouchers v on v.id = sv.adjustment_voucher_id
  where sv.company_id = p_company_id
    and (p_from_date is null or sv.verification_date >= p_from_date)
    and (p_to_date is null or sv.verification_date <= p_to_date)
  order by sv.verification_date desc, sv.created_at desc;
$$;

revoke all on function public.get_stock_verifications(uuid, date, date) from public, anon;
grant execute on function public.get_stock_verifications(uuid, date, date) to authenticated;

comment on function public.get_stock_verifications(uuid, date, date) is
  'Physical stock verification history for the /stock-verification screen, newest first. Every count is listed, clean ones included (adjustment_voucher_id null, variance_quantity 0).';


-- ----------------------------------------------------------------------------
-- get_stock_ageing — FIFO-style quantity bucketing from voucher_items alone,
-- valued at get_stock_summary's own average_rate. See migration header for
-- the full method and its stated edge case (an item with more recorded
-- outward than inward movement cannot have its shortfall assigned an age).
-- ----------------------------------------------------------------------------
create or replace function public.get_stock_ageing(
  p_company_id uuid,
  p_as_at date default current_date,
  p_godown_id uuid default null
)
returns table (
  item_id uuid,
  item_name text,
  uom text,
  average_rate numeric,
  closing_quantity numeric,
  qty_0_30 numeric,
  qty_31_60 numeric,
  qty_61_90 numeric,
  qty_91_180 numeric,
  qty_181_365 numeric,
  qty_over_365 numeric,
  val_0_30 numeric,
  val_31_60 numeric,
  val_61_90 numeric,
  val_91_180 numeric,
  val_181_365 numeric,
  val_over_365 numeric
)
language sql
stable
set search_path to ''
as $$
  with base_items as (
    select id, name, uom, opening_quantity
      from public.items
     where company_id = p_company_id and item_type = 'goods' and maintain_stock
  ),
  -- Every inward layer, oldest first. opening_quantity is a synthetic layer
  -- dated 1900-01-01 — by construction older than any real voucher, so it is
  -- always consumed last by FIFO and, if any survives, always falls in the
  -- oldest bucket. This mirrors get_stock_summary's own treatment of
  -- opening_quantity as always-in-scope regardless of godown filter (0013)
  -- — see migration header.
  inflows as (
    select id as item_id, date '1900-01-01' as layer_date, opening_quantity as qty, 0 as ord
      from base_items
     where opening_quantity > 0
    union all
    select vi.item_id, v.voucher_date, vi.quantity, 1
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
       and vi.direction = 'in'
       and (p_godown_id is null or vi.godown_id = p_godown_id)
  ),
  ordered as (
    select item_id, layer_date, qty,
           sum(qty) over (partition by item_id order by layer_date, ord
                           rows between unbounded preceding and current row) as running_in
      from inflows
     where qty > 0
  ),
  outflow_totals as (
    select vi.item_id, coalesce(sum(vi.quantity), 0) as total_out
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
       and vi.direction = 'out'
       and (p_godown_id is null or vi.godown_id = p_godown_id)
     group by vi.item_id
  ),
  -- FIFO layer consumption via running totals: a layer's own consumed
  -- amount is however much of total_out falls between this layer's opening
  -- running balance and its closing running balance; whatever is left of
  -- the layer after that is what remains on hand, still aged from its own
  -- layer_date. Floors at zero per layer — see migration header on the
  -- stated edge case this creates for an oversold item.
  remaining as (
    select o.item_id, o.layer_date,
           greatest(
             0,
             o.qty - greatest(0, least(o.qty, coalesce(ot.total_out, 0) - (o.running_in - o.qty)))
           ) as remaining_qty
      from ordered o
      left join outflow_totals ot on ot.item_id = o.item_id
  ),
  aged as (
    select item_id, (p_as_at - layer_date) as age_days, remaining_qty
      from remaining
     where remaining_qty > 0.0005
  ),
  bucketed as (
    select
      item_id,
      coalesce(sum(remaining_qty) filter (where age_days <= 30), 0) as qty_0_30,
      coalesce(sum(remaining_qty) filter (where age_days between 31 and 60), 0) as qty_31_60,
      coalesce(sum(remaining_qty) filter (where age_days between 61 and 90), 0) as qty_61_90,
      coalesce(sum(remaining_qty) filter (where age_days between 91 and 180), 0) as qty_91_180,
      coalesce(sum(remaining_qty) filter (where age_days between 181 and 365), 0) as qty_181_365,
      coalesce(sum(remaining_qty) filter (where age_days > 365), 0) as qty_over_365
    from aged
    group by item_id
  ),
  rates as (
    select item_id, average_rate
      from public.get_stock_summary(p_company_id, p_as_at, p_godown_id)
  )
  select
    bi.id, bi.name, bi.uom,
    coalesce(r.average_rate, 0),
    coalesce(b.qty_0_30, 0) + coalesce(b.qty_31_60, 0) + coalesce(b.qty_61_90, 0)
      + coalesce(b.qty_91_180, 0) + coalesce(b.qty_181_365, 0) + coalesce(b.qty_over_365, 0),
    coalesce(b.qty_0_30, 0), coalesce(b.qty_31_60, 0), coalesce(b.qty_61_90, 0),
    coalesce(b.qty_91_180, 0), coalesce(b.qty_181_365, 0), coalesce(b.qty_over_365, 0),
    round(coalesce(b.qty_0_30, 0) * coalesce(r.average_rate, 0), 2),
    round(coalesce(b.qty_31_60, 0) * coalesce(r.average_rate, 0), 2),
    round(coalesce(b.qty_61_90, 0) * coalesce(r.average_rate, 0), 2),
    round(coalesce(b.qty_91_180, 0) * coalesce(r.average_rate, 0), 2),
    round(coalesce(b.qty_181_365, 0) * coalesce(r.average_rate, 0), 2),
    round(coalesce(b.qty_over_365, 0) * coalesce(r.average_rate, 0), 2)
  from base_items bi
  left join bucketed b on b.item_id = bi.id
  left join rates r on r.item_id = bi.id
  where coalesce(b.qty_0_30, 0) + coalesce(b.qty_31_60, 0) + coalesce(b.qty_61_90, 0)
      + coalesce(b.qty_91_180, 0) + coalesce(b.qty_181_365, 0) + coalesce(b.qty_over_365, 0) <> 0
  order by bi.name;
$$;

revoke all on function public.get_stock_ageing(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_ageing(uuid, date, uuid) to authenticated;

comment on function public.get_stock_ageing(uuid, date, uuid) is
  'Quantity/value of closing stock per item, bucketed by how long it has sat there: FIFO-style replay of voucher_items (oldest inward layers consumed last), no stored cost-layer table (none exists yet — see migration header). closing_quantity is the sum of the six buckets by construction, and matches get_stock_summary''s closing_quantity for the same item/company/as-at/godown UNLESS that item''s recorded outward movements exceed its recorded inward movements (a pre-existing data question, not something this function can assign an age to). Each bucket''s value is its quantity at the item''s single get_stock_summary average_rate, not a fabricated per-layer FIFO cost.';


-- ============================================================================
-- get_quantitative_stock_details (0038) — Form 3CD Clause 35, revised to
-- surface shortage/excess for whichever items were actually physically
-- verified during the year, now that stock_verifications exists. Column set
-- changes (three columns added), so this needs a DROP first — CREATE OR
-- REPLACE cannot change a set-returning function's output columns.
--
-- WHAT "SHORTAGE/EXCESS FOR THE YEAR" MEANS HERE, STATED PRECISELY: every
-- stock_verifications row is scoped to one godown (see this migration's own
-- header on why), so a single row is never "the whole item's" shortage. This
-- SUMS every verification recorded for the item across p_fy_start..p_fy_end
-- (all godowns, all count events, all batches) — a defensible aggregate of
-- however much of the item was actually counted this year, not a claim that
-- 100% of the item's stock was counted. verified_as_at (the most recent
-- count date included) makes that scope legible to whoever reads the report.
-- An item with NO verification row in the year gets NULL in both columns —
-- not zero. Zero would claim "counted, no variance"; the honest answer for
-- an item nobody ever physically counted is "not verified", per AGENTS.md's
-- instruction not to fabricate a zero where the truth is "not tracked".
-- ============================================================================

drop function if exists public.get_quantitative_stock_details(uuid, date, date);

create or replace function public.get_quantitative_stock_details(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  item_id uuid,
  item_name text,
  hsn_sac text,
  uom text,
  opening_quantity numeric,
  purchases_quantity numeric,
  sales_quantity numeric,
  closing_quantity numeric,
  is_principal_item boolean,
  shortage_quantity numeric,
  excess_quantity numeric,
  verified_as_at date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with pre_period as (
    select vi.item_id,
           sum(case when vi.direction = 'in' then vi.quantity else -vi.quantity end) as net_qty
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date < p_fy_start
     group by vi.item_id
  ),
  period_moves as (
    select vi.item_id,
           coalesce(sum(vi.quantity) filter (where v.voucher_type = 'purchase'), 0) as purchases,
           coalesce(sum(vi.quantity) filter (where v.voucher_type = 'debit_note'), 0) as purchase_returns,
           coalesce(sum(vi.quantity) filter (where v.voucher_type = 'sales'), 0) as sales,
           coalesce(sum(vi.quantity) filter (where v.voucher_type = 'credit_note'), 0) as sales_returns
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date between p_fy_start and p_fy_end
     group by vi.item_id
  ),
  valued as (
    select vi.item_id,
           coalesce(sum(vi.amount) filter (where v.voucher_type = 'purchase'), 0) as purchase_value,
           coalesce(sum(vi.amount) filter (where v.voucher_type = 'sales'), 0) as sales_value
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date between p_fy_start and p_fy_end
     group by vi.item_id
  ),
  totals as (
    select coalesce(sum(purchase_value), 0) as total_purchase_value,
           coalesce(sum(sales_value), 0) as total_sales_value
      from valued
  ),
  combined as (
    select
      i.id, i.name, i.hsn_sac, i.uom,
      i.opening_quantity + coalesce(pp.net_qty, 0) as opening_qty,
      coalesce(pm.purchases, 0) - coalesce(pm.purchase_returns, 0) as net_purchases,
      coalesce(pm.sales, 0) - coalesce(pm.sales_returns, 0) as net_sales
    from public.items i
    left join pre_period pp on pp.item_id = i.id
    left join period_moves pm on pm.item_id = i.id
   where i.company_id = p_company_id
     and i.item_type = 'goods'
     and i.maintain_stock
  ),
  -- Every stock_verifications row for the item this year, across every
  -- godown/batch/count-event, summed. See header above.
  year_verifications as (
    select item_id,
           sum(case when variance_quantity < 0 then -variance_quantity else 0 end) as shortage_qty,
           sum(case when variance_quantity > 0 then variance_quantity else 0 end) as excess_qty,
           max(verification_date) as last_verified
      from public.stock_verifications
     where company_id = p_company_id
       and verification_date between p_fy_start and p_fy_end
     group by item_id
  )
  select
    c.id, c.name, c.hsn_sac, c.uom,
    c.opening_qty,
    c.net_purchases,
    c.net_sales,
    c.opening_qty + c.net_purchases - c.net_sales,
    coalesce(v.purchase_value, 0) > t.total_purchase_value * 0.10
      or coalesce(v.sales_value, 0) > t.total_sales_value * 0.10,
    yv.shortage_qty,
    yv.excess_qty,
    yv.last_verified
  from combined c
  left join valued v on v.item_id = c.id
  left join year_verifications yv on yv.item_id = c.id
  cross join totals t
 where c.opening_qty <> 0 or c.net_purchases <> 0 or c.net_sales <> 0
 order by (coalesce(v.sales_value, 0) + coalesce(v.purchase_value, 0)) desc;
$$;

revoke all on function public.get_quantitative_stock_details(uuid, date, date) from public, anon;
grant execute on function public.get_quantitative_stock_details(uuid, date, date) to authenticated;

comment on function public.get_quantitative_stock_details(uuid, date, date) is
  'Form 3CD Clause 35 (trading concern): opening/purchases/sales/closing quantity per item, purchase and sales returns netted against their own side rather than lumped into a raw direction total. is_principal_item flags an item individually over 10% of total purchase or sales value for the period, per the clause''s own threshold. shortage_quantity/excess_quantity sum every stock_verifications row recorded for the item within the year (0165, /stock-verification) — NULL, not zero, for an item never physically counted this year; verified_as_at is the most recent count date included. Manufacturing''s raw-material/consumption/yield variant is out of scope, same as every other manufacturing cut since P3.';
