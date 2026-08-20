-- ============================================================================
-- 0038 — Form 3CD Clause 35: quantitative details of stock
-- ============================================================================
-- Researched fresh (memory had this wrong once already — see 0032's
-- migration header, which flagged "clause 44 GST-turnover reconciliation"
-- as a follow-on; clause 44 turned out to be an expenditure-by-GST-
-- registration-status breakup this schema cannot answer accurately, since
-- most expense postings never carry a supplier GSTIN at all, only formal
-- GST purchase invoices do — not attempted here for that reason). Clause 35
-- is different: opening stock, purchases, sales, closing stock, per
-- PRINCIPAL item (one individually making up more than 10% of total
-- purchases or total turnover) — a trading concern's format; the
-- manufacturing variant (raw material/consumption/yield) is out of scope,
-- same as every other manufacturing-adjacent cut this app has made since P3
-- excluded BOM.
--
-- WHY NOT get_stock_summary (0013): that function is cumulative SINCE
-- COMPANY INCEPTION as at one date, not scoped to a period — calling it
-- with p_as_at = fy_end would count every purchase and sale the company has
-- ever made, not just this year's. It also does not distinguish voucher
-- TYPE, only movement DIRECTION — a purchase return (debit_note, direction
-- 'out') and an ordinary sale (also direction 'out') both land in the same
-- "quantity_out" bucket. Fine for computing a running closing balance
-- (a decrease is a decrease either way), wrong for Clause 35, which wants
-- "sales during the year" and "purchases during the year" as their own
-- honest figures — a purchase return should reduce purchases, not inflate
-- sales. This migration nets returns against their own side instead:
-- net purchases = purchase - debit_note (purchase return); net sales =
-- sales - credit_note (sales return).
--
-- NOT COMPUTED: shortage/excess. That column compares the book closing
-- quantity against an actual physical stock count — LEKHA has no
-- stock-take/physical-verification feature, so there is nothing to compare
-- the book figure against. Flagged, not guessed at.
-- ============================================================================

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
  is_principal_item boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with pre_period as (
    -- Net movement before fy_start, added to the item's own opening_quantity
    -- (as at company inception) to get the quantity on hand at fy_start.
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
  -- Purchase/sale VALUE (not quantity) for the principal-item 10% test —
  -- Clause 35's own threshold is "more than 10% of total purchases, total
  -- consumption, or total turnover", a value comparison, not a quantity one.
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
  )
  select
    c.id, c.name, c.hsn_sac, c.uom,
    c.opening_qty,
    c.net_purchases,
    c.net_sales,
    c.opening_qty + c.net_purchases - c.net_sales,
    coalesce(v.purchase_value, 0) > t.total_purchase_value * 0.10
      or coalesce(v.sales_value, 0) > t.total_sales_value * 0.10
  from combined c
  left join valued v on v.item_id = c.id
  cross join totals t
 where c.opening_qty <> 0 or c.net_purchases <> 0 or c.net_sales <> 0
 order by (coalesce(v.sales_value, 0) + coalesce(v.purchase_value, 0)) desc;
$$;

comment on function public.get_quantitative_stock_details is
  'Form 3CD Clause 35 (trading concern): opening/purchases/sales/closing quantity per item, purchase and sales returns netted against their own side rather than lumped into a raw direction total. is_principal_item flags an item individually over 10% of total purchase or sales value for the period, per the clause''s own threshold. Shortage/excess is not computed — LEKHA has no physical stock-take feature to compare the book figure against. Manufacturing''s raw-material/consumption/yield variant is out of scope, same as every other manufacturing cut since P3.';
