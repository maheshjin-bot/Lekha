-- ============================================================================
-- 0074 — Two inventory valuation defects, both of which reach a lender
-- ============================================================================
-- get_stock_summary is the only stock valuation code in the product. Its
-- closing_value feeds get_drawing_power (the bank's stock statement and
-- drawing-power calculation), get_cma_ratios, Form 3CD clause 14, and the
-- income tax computation. Two things were wrong with it.
--
-- (1) A SALES RETURN RE-ENTERED STOCK AT ITS SALE PRICE.
--
-- create_invoice maps credit_note -> direction 'in' (correct: the goods are
-- physically coming back) and writes voucher_items.amount as the LINE VALUE,
-- which for a credit note is the SELLING price, not cost. get_stock_summary
-- then folded that straight into the numerator of its weighted average:
--
--     avg_rate = (opening_value + value_in) / (opening_quantity + qty_in)
--
-- So goods that cost 100 and sold for 200 came back valued at 200, and
-- inflated the carrying rate of every remaining unit of that item -- not just
-- the returned ones. Worked example: purchase 10 @ 100, sell 5 @ 200, customer
-- returns 2. Before: avg (1000 + 400) / (10 + 2) = 116.67, closing 7 units =
-- 816.67. Correct: avg 100, closing 7 units = 700. Overstated by 116.67, and
-- the error grows with the margin.
--
-- The fix is to derive the average rate only from movements whose amount is
-- genuinely a COST. Returned units still count in closing quantity -- they are
-- really there -- they are just carried at what the stock cost rather than at
-- what it failed to sell for. That is also what makes the return symmetric
-- with the sale it reverses: the sale relieved the units at average cost, and
-- the return puts them back at the same average cost, for a net effect of
-- zero on both quantity and value, which is the whole point of a return.
--
-- Verified against live data before writing this: there are currently NO
-- credit_note or debit_note stock lines anywhere in the database, so this is
-- a latent defect rather than a live misstatement -- which is exactly why it
-- had never been noticed. Inward movements that DO exist are purchase,
-- job_work_in and stock_journal (manufacturing output), and all three carry a
-- real cost in amount, so all three stay in the basis.
--
-- Only credit_note is excluded. debit_note (a purchase return) is deliberately
-- left alone: it moves 'out', so it never touched the numerator, and under a
-- weighted-average model relieving it at the running average is already the
-- right answer -- buy 10 @ 100 and return 2 and you correctly get 8 units at
-- 100, no adjustment needed.
--
-- (2) THE SCHEMA ACCEPTED A VALUATION METHOD THE ENGINE CANNOT PERFORM.
--
-- companies.inventory_valuation_method accepted 'fifo', and three separate
-- places believe it: the stock report prints "valued at fifo" in its own
-- header, and get_form_3cd_particulars reports clause 14(a) "Method of
-- valuation of closing stock" as "FIFO". get_stock_summary has no FIFO branch
-- and never had one -- it is weighted average, unconditionally. A company with
-- that flag set would have had a false valuation method printed on its stock
-- report AND declared in its tax audit report, while the numbers underneath
-- were computed by a different method entirely.
--
-- Verified: all 15 companies are 'weighted_average', and NO user interface
-- anywhere in the app offers FIFO as a choice -- the value was only ever
-- reachable by writing directly to the table. So this narrows the constraint
-- to what the engine can actually honour, with nothing to migrate. Re-widen it
-- in the same migration that adds a real lot/layer costing engine, not before.
-- Fixing it here rather than in the two reports is deliberate: it makes the
-- false state unreachable for every present and future consumer at once.
-- ============================================================================

create or replace function public.get_stock_summary(
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
  closing_value numeric
)
language sql
stable
set search_path to ''
as $$
  with movements as (
    select vi.item_id, vi.direction, vi.quantity, vi.amount, v.voucher_type
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
       and (p_godown_id is null or vi.godown_id = p_godown_id)
  ),
  totals as (
    select i.id, i.name, i.hsn_sac, i.uom,
           i.opening_quantity, i.opening_value,
           coalesce(sum(m.quantity) filter (where m.direction = 'in'), 0)  as qty_in,
           coalesce(sum(m.quantity) filter (where m.direction = 'out'), 0) as qty_out,
           -- The average-rate basis: inward movements whose amount is a real
           -- COST. A credit note comes in at its SALE value, so including it
           -- would inflate the carrying rate of every remaining unit.
           coalesce(sum(m.quantity) filter (
             where m.direction = 'in' and m.voucher_type <> 'credit_note'), 0) as costed_qty_in,
           coalesce(sum(m.amount) filter (
             where m.direction = 'in' and m.voucher_type <> 'credit_note'), 0) as costed_value_in
      from public.items i
      left join movements m on m.item_id = i.id
     where i.company_id = p_company_id
       and i.item_type = 'goods'
       and i.maintain_stock
     group by i.id, i.name, i.hsn_sac, i.uom, i.opening_quantity, i.opening_value
  )
  select
    id, name, hsn_sac, uom,
    qty_in, qty_out,
    -- Closing quantity counts EVERY inward movement, returns included: the
    -- goods are physically back on the shelf whatever they cost.
    (opening_quantity + qty_in - qty_out) as closing_qty,
    -- The rate, however, comes only from what the stock actually cost.
    case when (opening_quantity + costed_qty_in) > 0
         then round((opening_value + costed_value_in) / (opening_quantity + costed_qty_in), 2)
         else 0 end as avg_rate,
    case when (opening_quantity + costed_qty_in) > 0
         then round(
                (opening_quantity + qty_in - qty_out)
                * ((opening_value + costed_value_in) / (opening_quantity + costed_qty_in)), 2)
         else 0 end as closing_value
  from totals
  where opening_quantity <> 0 or qty_in <> 0 or qty_out <> 0
  order by name;
$$;

revoke all on function public.get_stock_summary(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_summary(uuid, date, uuid) to authenticated;

comment on function public.get_stock_summary(uuid, date, uuid) is
  'Weighted-average stock valuation. Closing quantity counts every inward movement; the average rate is derived only from inward movements carrying a real cost, so a sales return (credit note, which comes in at its sale value) cannot inflate the carrying rate -- see 0074.';

alter table public.companies
  drop constraint companies_inventory_valuation_method_check;

alter table public.companies
  add constraint companies_inventory_valuation_method_check
  check (inventory_valuation_method = 'weighted_average');
