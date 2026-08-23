-- ============================================================================
-- 0076 — Closing stock never reached the books
-- ============================================================================
-- Nothing has ever posted inventory to a ledger. Every company is seeded with
-- a "Stock-in-Hand" account group (nature current_asset, ledger_role 'stock'),
-- and across the entire database that group contains ZERO ledgers. The
-- consequences compound:
--
--   * THE BALANCE SHEET SHOWS NO INVENTORY AT ALL. Purchases are expensed in
--     full when bought and the goods still on the shelf appear nowhere. For a
--     trading or manufacturing business that is usually its single largest
--     current asset.
--
--   * GROSS PROFIT IS SALES MINUS PURCHASES, NOT SALES MINUS COST OF GOODS
--     SOLD. Every period that buys more than it sells is understated, and
--     every period that runs stock down is overstated.
--
--   * THE LENDER PACK CONTRADICTS ITSELF. get_drawing_power reads stock from
--     get_stock_summary, while get_cma_ratios reads it from ledger balances --
--     which are empty. Measured on live data before this fix, for one real
--     company at the same date:
--         CMA "Inventory / stock-in-hand"      0.00
--         Drawing power "closing stock"   12,142.69
--     Two figures in the same submission to the same bank, differing by the
--     whole of the stock. CMA's current ratio excluded stock from current
--     assets, and its quick ratio subtracted a zero, so quick ratio and
--     current ratio were identical -- a tell that should never appear in a
--     ratio pack.
--
-- WHY POST IT RATHER THAN DERIVE IT IN THE REPORTS. 0073 fixed an analogous
-- problem in the reporting layer instead of by posting, and that was right
-- there, because the entry it avoided would have had to touch the P&L ledgers
-- purely to balance. This case is the opposite: the entry that records closing
-- stock is a REAL accounting entry that genuinely belongs in both statements,
-- and get_cma_ratios reads ledgers rather than get_stock_summary. Deriving it
-- instead would mean three or more separate reports each re-deriving stock
-- their own way -- exactly the divergence that produced the contradiction
-- above -- and would leave the seeded Stock-in-Hand group permanently empty.
--
-- THE CONTRA IS AN EXPENSE, NOT AN INCOME. Closing stock is credited to
-- "Changes in Inventories" under Direct Expenses, so it reduces cost, rather
-- than to a direct_income ledger as a trading account is often drawn. That
-- matters concretely: get_cma_ratios derives v_sales from direct_income, so
-- crediting stock there would have inflated reported SALES in the lender pack.
-- Booking it as a negative expense keeps sales honest, gives the same gross
-- profit, and is also what Schedule III actually asks for -- "Changes in
-- inventories of finished goods, work-in-progress and stock-in-trade" is an
-- expense line that is routinely negative.
--
-- INCREMENTAL, NOT REVERSE-AND-REPOST. post_closing_stock posts only the
-- DIFFERENCE between what the stock is worth at the given date and what the
-- ledger already carries there. Running it again after more trading posts just
-- the movement since; running it twice with nothing in between raises rather
-- than double-posting. This is the same additive pattern record_forex_
-- revaluation (0071) uses, and it suits this app's stated principle of
-- immutable posted vouchers -- no entry is ever edited or reversed, the
-- balance is simply the sum of every movement posted to it.
--
-- Deliberately a user action on a chosen date, not a side effect of
-- close_period: a business may want stock in the books monthly for a bank
-- statement, quarterly, or only at year end, and that is its own decision.
--
-- NOT ADDRESSED HERE: perpetual inventory (capitalising each purchase to stock
-- and posting cost of goods sold per sale) would be a far larger change to
-- create_invoice and would re-interpret every voucher already posted. This is
-- the periodic method, which is what the schema supports today. Also note that
-- get_stock_summary can return a NEGATIVE closing value where more has been
-- issued than received -- that is a real data problem in its own right, and
-- this function posts what the valuation says rather than hiding it.
-- ============================================================================

create or replace function app_private.ensure_stock_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_stock_group uuid;
  v_expense_group uuid;
begin
  select id into v_stock_group
    from public.account_groups
   where company_id = p_company_id and name = 'Stock-in-Hand'
   limit 1;

  select id into v_expense_group
    from public.account_groups
   where company_id = p_company_id and name = 'Direct Expenses'
   limit 1;

  if v_stock_group is null or v_expense_group is null then
    raise exception 'Chart of accounts is missing the Stock-in-Hand or Direct Expenses group; seed it first';
  end if;

  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_stock_group and name = 'Stock-in-Hand'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_stock_group, 'Stock-in-Hand', 'debit', 0);
  end if;

  -- Schedule III's own name for this line. Lives under Direct Expenses and
  -- normally carries a CREDIT balance -- see the migration header for why it
  -- is not a direct_income ledger.
  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_expense_group and name = 'Changes in Inventories'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_expense_group, 'Changes in Inventories', 'debit', 0);
  end if;
end;
$fn$;

create or replace function public.post_closing_stock(
  p_company_id uuid,
  p_branch_id uuid,
  p_as_at date,
  p_narration text default null
)
returns uuid
language plpgsql
set search_path to ''
as $fn$
declare
  v_stock_group uuid;
  v_expense_group uuid;
  v_stock_ledger uuid;
  v_change_ledger uuid;
  v_target numeric;
  v_carried numeric;
  v_delta numeric;
  v_lines jsonb;
  v_voucher_id uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to post for this company';
  end if;

  perform app_private.ensure_stock_ledgers(p_company_id);

  select id into v_stock_group from public.account_groups
   where company_id = p_company_id and name = 'Stock-in-Hand' limit 1;
  select id into v_expense_group from public.account_groups
   where company_id = p_company_id and name = 'Direct Expenses' limit 1;

  select id into v_stock_ledger from public.ledgers
   where company_id = p_company_id and group_id = v_stock_group and name = 'Stock-in-Hand' limit 1;
  select id into v_change_ledger from public.ledgers
   where company_id = p_company_id and group_id = v_expense_group and name = 'Changes in Inventories' limit 1;

  -- What the stock is actually worth on this date, per the valuation engine.
  select coalesce(sum(s.closing_value), 0) into v_target
    from public.get_stock_summary(p_company_id, p_as_at, null) s;

  -- What the ledger already carries on this date. ledger_opening_signed at
  -- (date + 1) is "closing as at date" -- the same trick get_balance_sheet and
  -- get_cma_ratios both use.
  v_carried := app_private.ledger_opening_signed(p_company_id, v_stock_ledger, p_as_at + 1, null);

  v_delta := round(v_target - v_carried, 2);

  if v_delta = 0 then
    raise exception
      'Stock-in-Hand already carries % as at % — there is no movement to post.',
      round(v_target, 2), p_as_at;
  end if;

  if v_delta > 0 then
    v_lines := jsonb_build_array(
      jsonb_build_object('ledger_id', v_stock_ledger,  'debit_amount',  v_delta),
      jsonb_build_object('ledger_id', v_change_ledger, 'credit_amount', v_delta)
    );
  else
    v_lines := jsonb_build_array(
      jsonb_build_object('ledger_id', v_change_ledger, 'debit_amount',  -v_delta),
      jsonb_build_object('ledger_id', v_stock_ledger,  'credit_amount', -v_delta)
    );
  end if;

  v_voucher_id := public.create_voucher(
    p_company_id := p_company_id,
    p_branch_id := p_branch_id,
    p_voucher_type := 'journal',
    p_voucher_date := p_as_at,
    p_lines := v_lines,
    p_narration := coalesce(
      p_narration,
      'Closing stock as at ' || to_char(p_as_at, 'DD Mon YYYY')
        || ' — carrying value ' || round(v_target, 2)
    )
  );

  return v_voucher_id;
end;
$fn$;

revoke all on function public.post_closing_stock(uuid, uuid, date, text) from public, anon;
grant execute on function public.post_closing_stock(uuid, uuid, date, text) to authenticated;

comment on function public.post_closing_stock(uuid, uuid, date, text) is
  'Brings inventory onto the balance sheet at a chosen date: Dr Stock-in-Hand, Cr Changes in Inventories (a Direct Expenses contra, NOT an income ledger — see 0076). Posts only the movement since whatever the ledger already carries, so it is safe to re-run as trading continues.';
