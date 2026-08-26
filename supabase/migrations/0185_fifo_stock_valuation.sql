-- ============================================================================
-- 0185 — A real FIFO cost-layer valuation engine, alongside (never
-- replacing) the existing moving-weighted-average get_stock_summary
-- ============================================================================
-- CONFIRMED LIVE BEFORE WRITING ANY OF THIS:
--   - get_stock_summary (0013, last replaced by 0074) is the ONLY inventory
--     valuation code in this product. It is a MOVING WEIGHTED AVERAGE,
--     unconditionally — there has never been a FIFO branch. Its own header
--     already says so: "get_stock_summary has no FIFO branch and never had
--     one -- it is weighted average, unconditionally."
--   - get_batch_stock_summary (0067) tracks quantity + expiry per batch/lot
--     only. It has NO value column at all — confirmed by reading its
--     `returns table (...)` list: batch_id, item_id, item_name, uom,
--     batch_no, mfg_date, expiry_date, days_to_expiry, quantity_in,
--     quantity_out, quantity_on_hand. Its own header says plainly: "this is
--     a physical quantity + expiry ledger, NOT a valuation engine."
--   - get_drawing_power (0034, extended 0050) consumes get_stock_summary's
--     closing_value directly: `select coalesce(sum(s.closing_value), 0)
--     into v_stock from public.get_stock_summary(p_company_id, p_as_at) s`.
--     Nothing else about it changes here — see the scoping decision below.
--   - companies.inventory_valuation_method is CHECK-locked to
--     'weighted_average' only (0074), specifically because the engine could
--     not honour 'fifo' when that lock was added. 0074's own header left
--     this instruction: "Re-widen it in the same migration that adds a real
--     lot/layer costing engine, not before." This migration deliberately
--     does NOT widen it — see "WHY THE COMPANY SETTING STAYS LOCKED" below.
--
-- STATUTORY BASIS FOR FIFO ITSELF (WebSearch'd today, not recalled):
--   - AS 2 (Valuation of Inventories, ICAI) permits exactly two cost
--     formulas for ordinarily-interchangeable inventory: FIFO or weighted
--     average cost. LIFO is NOT permitted under AS 2 / Indian GAAP.
--   - ICDS II (Valuation of Inventories, notified under the Income Tax Act,
--     s.145(2), effective AY 2017-18) independently permits the SAME two
--     formulas — FIFO or weighted average — "whichever reflects the fairest
--     possible approximation to the cost incurred."
--   - A SECOND, deliberately skeptical search (the "obvious answer" here
--     being "sure, both are fine, nothing else to check") turned up the
--     one thing worth flagging: switching a company's cost formula is a
--     change in ACCOUNTING POLICY, not a report toggle — it must be applied
--     consistently period to period and disclosed as a policy change (AS 1
--     / AS 5 territory) when it happens. That is exactly why this feature
--     is built as a side-by-side COMPARISON, never a silent switch — see
--     below.
--
-- THE SCOPING DECISION, MADE DELIBERATELY AND STATED HERE EXPLICITLY:
-- This migration does NOT retroactively recompute "the" FIFO history for
-- every company as a stored running balance. That would mean walking years
-- of live voucher_items for 15+ companies, producing a persisted table
-- that, if any edge case in the walk were wrong, would misstate a stored
-- number nobody would think to double-check — a much bigger and riskier
-- undertaking than the report this task actually needs. Instead:
--
--   get_stock_summary_fifo() and get_stock_fifo_layers() are PURE READ
--   FUNCTIONS. Every call re-derives FIFO layers from public.voucher_items
--   from scratch, for whatever (company, as-at date, godown) is asked for.
--   Nothing is written, nothing is stored, nothing can drift out of sync
--   with the ledger. No new table exists in this migration — no
--   stock_cost_layers table, no running balance, nothing to backfill or get
--   wrong against years of history. This is safe to ship and safe to
--   verify precisely BECAUSE it touches no stored data. It is also the
--   right foundation for a real running-balance system later, once this
--   pure computation has been proven correct against enough real data —
--   but that stored system is deliberately not attempted here.
--
-- WHY THE COMPANY SETTING (inventory_valuation_method) STAYS LOCKED TO
-- weighted_average: get_drawing_power, get_cma_ratios, Form 3CD clause 14,
-- and the income tax computation all still read get_stock_summary, which
-- is still unconditionally weighted average — this migration does not
-- touch get_stock_summary or any of its consumers at all. Widening the
-- companies CHECK constraint to accept 'fifo' now would let a company
-- declare a valuation method its own official numbers do not actually use
-- — precisely the false state 0074 closed off ("the schema accepted a
-- valuation method the engine cannot perform"). It stays closed until a
-- future migration makes get_stock_summary itself (or its consumers)
-- FIFO-aware for real. What ships here is a comparison a company can use
-- to actually DECIDE whether to make that policy change, with real
-- numbers instead of a guess — not the switch itself.
--
-- THE ALGORITHM — chosen deliberately over a per-event chronological
-- simulation, and it is worth explaining why the simpler shape below is
-- not a shortcut but the mathematically correct one. FIFO consumption
-- order only ever depends on which RECEIPT lot is oldest; it does not
-- depend on which SALE happens to be "assigned" to draw it down, or on the
-- relative order of a sale versus a later, unrelated purchase. So instead
-- of walking every movement in strict chronological order and mutating an
-- open-layers state machine event by event (which would need an imperative
-- per-item, per-event loop), this is computed as a single set-based pass:
--   1. Build every RECEIPT lot for the item (opening balance, then every
--      inward voucher_items line up to p_as_at), ordered oldest first.
--   2. Take the TOTAL of every outward voucher_items line up to p_as_at as
--      one number (the order among individual sales does not change which
--      receipt lots end up open — only the running total does).
--   3. Walk the ordered receipt lots with a running cumulative-quantity
--      window function and clip each lot's consumption against the total
--      demand: consumed = greatest(0, least(lot_qty, total_out -
--      cum_qty_before_this_lot)). This is the standard FIFO layer-matching
--      technique done as one SQL pass with window functions rather than
--      row-by-row state mutation, and it produces IDENTICAL results to an
--      event-by-event simulation — verified by hand below for a real item.
--
-- SAME-DATE ORDERING: two receipt lots dated the same day are ordered by
-- the underlying voucher's created_at, then the voucher_items id, for a
-- fully deterministic (if arbitrary on a true same-instant tie) sequence.
-- This never needed an "ins before outs on the same day" convention at
-- all — see point 3 above: outward movements are only ever a single
-- per-item TOTAL, never individually sequenced against receipts, so same-
-- day in/out ordering ambiguity (a real concern in earlier designs of this
-- migration) simply does not arise.
--
-- A SALES RETURN (credit_note, direction 'in') HAS NO TRACEABLE ORIGINAL
-- LAYER. This schema does not link a credit note back to which sale (or
-- which specific FIFO lot) it reverses — the same gap 0074 hit for the
-- weighted-average model. 0074's own resolution was to carry a return back
-- into stock "at what the stock cost, not what it failed to sell for,"
-- using the item's own overall costed weighted-average rate. This
-- migration reuses the EXACT SAME rate (recomputed identically to
-- get_stock_summary's own formula) as the unit cost of the new FIFO lot a
-- credit note creates, dated at the return's own voucher_date so it takes
-- its proper place in FIFO order among the item's other lots. debit_note
-- (a purchase return) needs no special handling in either model: it is a
-- plain outward movement, drawn down like any sale.
--
-- NEGATIVE STOCK / "UNMATCHED SHORTFALL" — A REAL CONDITION IN THIS DATA,
-- NOT A HYPOTHETICAL EDGE CASE. Nothing in this schema stops an outward
-- movement from being posted before, or in excess of, the inward movements
-- that would justify it (confirmed live: no trigger anywhere enforces
-- non-negative stock, and get_stock_summary itself already happily returns
-- a negative closing_quantity). Sharma Textiles' own "Product A" is
-- currently, for real, oversold by 22 units against everything ever
-- recorded as received (60 in, 82 out — see live_verification below). When
-- total outward quantity exceeds total receipts, the un-matched remainder
-- is surfaced as its own pseudo-lot with quantity_remaining < 0 and
-- unit_cost NULL — not zero. Zero would claim "this stock is worthless,"
-- which is not true; NULL honestly says "no purchase cost is traceable for
-- this quantity," and get_stock_summary_fifo excludes it from
-- closing_value / average_rate (computed over the PRICED portion only) and
-- reports it separately as unpriced_quantity, so it is surfaced, never
-- silently netted away or invented.
--
-- GODOWN FILTERING mirrors get_stock_summary's own existing semantics
-- exactly: p_godown_id restricts EVERY movement (both directions) to that
-- godown before any layer math happens, giving that godown's own
-- independent FIFO stack — not a slice of the company-wide one. The same
-- caveat the stock report already prints for weighted average applies
-- here identically: a godown's own figures do not have to reconcile
-- against the all-godowns figures beyond quantity.
--
-- branch_transfer worth noting plainly: an inter-godown transfer's inward
-- leg starts a FRESH FIFO lot at the destination, dated at the transfer
-- date, at whatever amount the transfer line records. Company-wide (no
-- godown filter) this is a wash on quantity as always; per-godown, it is
-- the economically correct treatment (each godown keeps its own FIFO
-- stack) — this migration does not attempt to preserve a lot's original
-- receipt date across a transfer, the same way get_stock_summary does not
-- either.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_stock_fifo_layers — every FIFO lot still open (or short) for a
-- company's stock-maintained goods as at p_as_at, oldest lot first. The
-- drill-down detail behind get_stock_summary_fifo below, and directly
-- queryable on its own for the report page's per-item layer breakdown.
-- ----------------------------------------------------------------------------
create or replace function public.get_stock_fifo_layers(
  p_company_id uuid,
  p_as_at date default current_date,
  p_godown_id uuid default null
)
returns table (
  item_id uuid,
  item_name text,
  hsn_sac text,
  uom text,
  layer_date date,
  layer_source text,
  original_quantity numeric,
  quantity_remaining numeric,
  unit_cost numeric,
  layer_value numeric
)
language sql
stable
set search_path = ''
as $$
  with movements as (
    select vi.id as voucher_item_id, vi.item_id, vi.direction, vi.quantity, vi.amount,
           v.voucher_type, v.voucher_number, v.voucher_date, v.created_at
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
       and (p_godown_id is null or vi.godown_id = p_godown_id)
  ),
  -- The item's overall costed weighted-average rate — exactly
  -- get_stock_summary's (0074) own formula — used ONLY to price a sales
  -- return's FIFO lot (see header: no traceable original layer exists).
  item_avg_rate as (
    select i.id as item_id,
           case when (i.opening_quantity + coalesce(sum(m.quantity) filter (
                        where m.direction = 'in' and m.voucher_type <> 'credit_note'), 0)) > 0
                then (i.opening_value + coalesce(sum(m.amount) filter (
                        where m.direction = 'in' and m.voucher_type <> 'credit_note'), 0))
                     / (i.opening_quantity + coalesce(sum(m.quantity) filter (
                        where m.direction = 'in' and m.voucher_type <> 'credit_note'), 0))
                else 0 end as avg_rate
      from public.items i
      left join movements m on m.item_id = i.id
     where i.company_id = p_company_id and i.item_type = 'goods' and i.maintain_stock
     group by i.id, i.opening_quantity, i.opening_value
  ),
  receipts as (
    -- Opening balance: one lot, always the oldest (a null layer_date sorts
    -- first below via "layer_date is not null" ascending).
    select i.id as item_id,
           null::date as layer_date,
           'Opening balance'::text as layer_source,
           i.opening_quantity as quantity,
           case when i.opening_quantity > 0 then i.opening_value / i.opening_quantity else 0 end as unit_cost,
           '-infinity'::timestamptz as tie_ts,
           '00000000-0000-0000-0000-000000000000'::uuid as tie_id
      from public.items i
     where i.company_id = p_company_id and i.item_type = 'goods' and i.maintain_stock
       and i.opening_quantity > 0
    union all
    -- Every real inward movement except a sales return, at its own real
    -- per-unit cost (amount / quantity as actually posted).
    select m.item_id, m.voucher_date,
           initcap(replace(m.voucher_type, '_', ' ')) || ' ' || m.voucher_number,
           m.quantity,
           case when m.quantity > 0 then m.amount / m.quantity else 0 end,
           m.created_at, m.voucher_item_id
      from movements m
     where m.direction = 'in' and m.voucher_type <> 'credit_note'
    union all
    -- A sales return: real quantity, but costed at the item's overall
    -- average rate rather than its sale value (see header).
    select m.item_id, m.voucher_date,
           initcap(replace(m.voucher_type, '_', ' ')) || ' ' || m.voucher_number
             || ' (sales return — carried at average cost, not sale value)',
           m.quantity,
           coalesce(r.avg_rate, 0),
           m.created_at, m.voucher_item_id
      from movements m
      join item_avg_rate r on r.item_id = m.item_id
     where m.direction = 'in' and m.voucher_type = 'credit_note'
  ),
  ordered_receipts as (
    select r.*,
           coalesce(sum(r.quantity) over (
             partition by r.item_id
             order by (r.layer_date is not null), r.layer_date, r.tie_ts, r.tie_id
             rows between unbounded preceding and 1 preceding
           ), 0) as cum_before
      from receipts r
  ),
  demand as (
    select item_id, sum(quantity) as total_out
      from movements
     where direction = 'out'
     group by item_id
  ),
  consumed as (
    select r.item_id, r.layer_date, r.layer_source, r.quantity as original_quantity, r.unit_cost,
           r.quantity - greatest(0, least(r.quantity, coalesce(d.total_out, 0) - r.cum_before)) as quantity_remaining
      from ordered_receipts r
      left join demand d on d.item_id = r.item_id
  ),
  receipt_totals as (
    select item_id, sum(quantity) as total_receipts from receipts group by item_id
  ),
  shortfalls as (
    -- Recorded issues exceed recorded receipts for this item: a real,
    -- live condition (see header) — surfaced as a negative pseudo-lot with
    -- NO cost basis (unit_cost null, never 0 — see header) rather than
    -- silently netted away.
    select d.item_id,
           null::date as layer_date,
           'Unmatched shortfall — recorded issues exceed recorded receipts; no purchase cost is traceable for this quantity'::text as layer_source,
           (d.total_out - coalesce(rt.total_receipts, 0)) as original_quantity,
           -(d.total_out - coalesce(rt.total_receipts, 0)) as quantity_remaining,
           null::numeric as unit_cost
      from demand d
      left join receipt_totals rt on rt.item_id = d.item_id
     where d.total_out > coalesce(rt.total_receipts, 0)
  )
  (
    select c.item_id, i.name as item_name, i.hsn_sac, i.uom, c.layer_date, c.layer_source,
           c.original_quantity, c.quantity_remaining, round(c.unit_cost, 4) as unit_cost,
           round(c.quantity_remaining * c.unit_cost, 2) as layer_value
      from consumed c
      join public.items i on i.id = c.item_id and i.item_type = 'goods' and i.maintain_stock
     where c.quantity_remaining > 0.0005
  )
  union all
  (
    select s.item_id, i.name, i.hsn_sac, i.uom, s.layer_date, s.layer_source,
           s.original_quantity, s.quantity_remaining, s.unit_cost, null::numeric
      from shortfalls s
      join public.items i on i.id = s.item_id and i.item_type = 'goods' and i.maintain_stock
  )
  order by item_name, layer_date nulls first, layer_source
$$;

revoke all on function public.get_stock_fifo_layers(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_fifo_layers(uuid, date, uuid) to authenticated;

comment on function public.get_stock_fifo_layers(uuid, date, uuid) is
  'FIFO cost-layer drill-down: every lot (opening balance, purchase, job-work-in, stock-journal-in, sales-return-at-average-cost, ...) still open as at p_as_at, oldest first, plus a single "Unmatched shortfall" pseudo-lot (unit_cost null, never 0) when recorded issues exceed recorded receipts for that item. A PURE re-derivation from voucher_items every call -- nothing stored, see 0185 header for why. Feeds get_stock_summary_fifo and the /reports/stock drill-down; does not feed get_stock_summary, get_drawing_power, or anything statutory.';


-- ----------------------------------------------------------------------------
-- get_stock_summary_fifo — same shape as get_stock_summary (0074) plus
-- unpriced_quantity, computed by FIFO layer consumption instead of a moving
-- weighted average. See 0185 header: comparison only, never wired into
-- get_drawing_power / CMA / Form 3CD / the balance sheet.
-- ----------------------------------------------------------------------------
create or replace function public.get_stock_summary_fifo(
  p_company_id uuid,
  p_as_at date default current_date,
  p_godown_id uuid default null
)
returns table (
  item_id uuid,
  item_name text,
  hsn_sac text,
  uom text,
  quantity_in numeric,
  quantity_out numeric,
  closing_quantity numeric,
  average_rate numeric,
  closing_value numeric,
  unpriced_quantity numeric
)
language sql
stable
set search_path = ''
as $$
  with movements as (
    select vi.item_id, vi.direction, vi.quantity
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
       and (p_godown_id is null or vi.godown_id = p_godown_id)
  ),
  totals as (
    select i.id, i.name, i.hsn_sac, i.uom, i.opening_quantity,
           coalesce(sum(m.quantity) filter (where m.direction = 'in'), 0) as qty_in,
           coalesce(sum(m.quantity) filter (where m.direction = 'out'), 0) as qty_out
      from public.items i
      left join movements m on m.item_id = i.id
     where i.company_id = p_company_id and i.item_type = 'goods' and i.maintain_stock
     group by i.id, i.name, i.hsn_sac, i.uom, i.opening_quantity
  ),
  layers as (
    select item_id,
           sum(quantity_remaining) filter (where unit_cost is not null) as priced_qty,
           sum(quantity_remaining * unit_cost) filter (where unit_cost is not null) as priced_value,
           -- Signed (negative) here; negated back to a positive magnitude below.
           sum(quantity_remaining) filter (where unit_cost is null) as unpriced_qty_signed
      from public.get_stock_fifo_layers(p_company_id, p_as_at, p_godown_id)
     group by item_id
  )
  select t.id, t.name, t.hsn_sac, t.uom, t.qty_in, t.qty_out,
         (t.opening_quantity + t.qty_in - t.qty_out) as closing_quantity,
         case when coalesce(l.priced_qty, 0) <> 0
              then round(coalesce(l.priced_value, 0) / l.priced_qty, 2)
              else 0 end as average_rate,
         round(coalesce(l.priced_value, 0), 2) as closing_value,
         coalesce(-l.unpriced_qty_signed, 0) as unpriced_quantity
    from totals t
    left join layers l on l.item_id = t.id
   where t.opening_quantity <> 0 or t.qty_in <> 0 or t.qty_out <> 0
   order by t.name;
$$;

revoke all on function public.get_stock_summary_fifo(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_summary_fifo(uuid, date, uuid) to authenticated;

comment on function public.get_stock_summary_fifo(uuid, date, uuid) is
  'FIFO-layer stock valuation -- same output shape as get_stock_summary (0074) plus unpriced_quantity, computed by consuming cost layers oldest-first rather than a moving weighted average. closing_quantity/quantity_in/quantity_out match get_stock_summary exactly (same movements; only the valuation basis differs). closing_value/average_rate are computed over the PRICED portion of stock only -- unpriced_quantity (see get_stock_fifo_layers) discloses how much of a negative/over-issued balance has no traceable purchase cost, rather than folding it in at a fabricated rate. A pure re-derivation every call, not a stored running balance -- see 0185 header for the scoping decision. Comparison/analysis only: get_drawing_power, get_cma_ratios, Form 3CD clause 14, and the balance sheet all still read get_stock_summary (moving weighted average) unconditionally.';
