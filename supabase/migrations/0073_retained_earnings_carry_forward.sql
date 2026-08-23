-- ============================================================================
-- 0073 — Retained earnings carry forward: the balance sheet and the CMA net
--        worth both stopped at the current financial year
-- ============================================================================
-- A balance sheet reads every ledger CUMULATIVELY from the day the books
-- began (get_balance_sheet -> app_private.ledger_opening_signed, which sums
-- all entries before the as-at date). The profit added back to the equity
-- side, however, was computed for the CURRENT financial year only. From a
-- company's SECOND year onward, both statements therefore dropped every rupee
-- of profit earned before that year.
--
-- Migration 0020's own header made this call explicitly and got it wrong:
--
--     "This migration adds the two RPCs that were missing and nothing else --
--      no new tables, no 'closing entries': the reports already compute the
--      P&L and balance sheet from a from/to range, so a financial year's
--      numbers are already correct without a year-end journal."
--
-- That reasoning holds for the P&L, which genuinely IS a from/to range. It
-- does not hold for the balance sheet, which is not a range at all. The
-- consequence has never been seen because no company in this database spans
-- two financial years yet -- verified: every company has exactly one distinct
-- FY. It would have detonated on the first user's second year.
--
-- PROVEN NUMERICALLY BEFORE THE FIX WAS WRITTEN, against live data:
--   * a real company's balance sheet was out by 13,29,000 when the profit
--     window was opened at 1 Oct instead of at the book beginning -- exactly
--     equal to the profit of the excluded earlier period, to the paisa;
--   * the same check with the window opened at the book beginning balanced to
--     0.00 across 12 companies x 7 as-at dates each (84 combinations, worst
--     imbalance 0.00). Assets minus liabilities equals profit accumulated
--     since the books began, at every date, by double entry.
--
-- TWO CALL SITES, ONE ROOT CAUSE. The balance sheet's half is a report-layer
-- fix and carries no SQL (see app/(app)/[companyId]/reports/balance-sheet).
-- This migration fixes the other half: get_cma_ratios, whose v_networth is
-- built from the equity ledgers CUMULATIVELY (ledger_opening_signed at
-- p_fy_end + 1) and then had only the CURRENT period's profit added to it.
--
-- That one matters more than it looks. Net worth is the denominator of both
-- debt-equity and TOL/TNW -- the two gearing ratios a lender reads first --
-- and this error understates it, making a profitable multi-year borrower look
-- more leveraged than it is. Note the direction: the comment already sitting
-- at that line was added to stop net worth OVERSTATING the borrower's stake,
-- and it fixed exactly that for a first-year company. The same line then
-- understates it for every year after. Both halves of the bug live in one
-- statement.
--
-- DELIBERATELY NOT DONE HERE: posting a real year-end closing journal. A
-- posted closing entry has to touch the P&L ledgers in order to balance,
-- which would then distort every other consumer that reads those ledgers by
-- nature -- get_budget_variance, get_cost_centre_pnl, get_income_tax_
-- computation, get_tax_audit_applicability and get_cma_ratios itself would
-- each need a matching exclusion, five new regression risks to fix a
-- reporting bug that has a provably correct reporting fix. A real closing
-- voucher (with the appropriation entries a company actually needs to move
-- profit to General Reserve or declare a dividend) stays an open feature,
-- named here rather than silently skipped.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_cma_ratios(p_company_id uuid, p_fy_start date, p_fy_end date)
 RETURNS TABLE(section text, metric_code text, metric_label text, value numeric, unit text, benchmark numeric, benchmark_note text, is_healthy boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_days int := greatest((p_fy_end - p_fy_start) + 1, 1);
  v_cash numeric := 0;
  v_bank_borrow numeric := 0;
  v_stock numeric := 0;
  v_debtors numeric := 0;
  v_other_ca numeric := 0;
  v_tca numeric := 0;
  v_creditors numeric := 0;
  v_ocl numeric := 0;
  v_tcl numeric := 0;
  v_nfa numeric := 0;
  v_ltd numeric := 0;
  v_networth numeric := 0;
  v_sales numeric := 0;
  v_other_inc numeric := 0;
  v_direct_exp numeric := 0;
  v_indirect_exp numeric := 0;
  v_interest numeric := 0;
  v_deprec numeric := 0;
  v_interest_found boolean := false;
  v_gross numeric := 0;
  v_opprofit numeric := 0;
  v_netprofit numeric := 0;
  v_profit_bf numeric := 0;
  v_wcg numeric; v_nwc numeric; v_mpbf1 numeric; v_mpbf2 numeric;
  v_sanctioned numeric;
  v_cr numeric; v_qr numeric; v_de numeric; v_tol_tnw numeric;
  v_ic numeric; v_dscr numeric;
begin
  -- ---------------- Balance sheet, as at p_fy_end ----------------
  -- ledger_opening_signed at (date + 1) is "closing as at date" — the trick
  -- get_balance_sheet and get_dashboard_kpis both already use.
  select
    coalesce(sum(case when g.ledger_role = 'cash_bank' and s.signed > 0 then s.signed else 0 end), 0),
    coalesce(sum(case when g.ledger_role = 'cash_bank' and s.signed < 0 then -s.signed else 0 end), 0),
    coalesce(sum(case when g.ledger_role = 'stock'  then s.signed else 0 end), 0),
    coalesce(sum(case when g.ledger_role = 'debtor' then s.signed else 0 end), 0),
    coalesce(sum(case when g.ledger_role not in ('cash_bank','stock','debtor') then s.signed else 0 end), 0)
  into v_cash, v_bank_borrow, v_stock, v_debtors, v_other_ca
  from public.ledgers l
  join public.account_groups g on g.id = l.group_id
  cross join lateral (
    select app_private.ledger_opening_signed(p_company_id, l.id, p_fy_end + 1, null) as signed
  ) s
  where l.company_id = p_company_id and g.nature = 'current_asset';

  select
    coalesce(sum(-s.signed), 0),
    coalesce(sum(case when g.ledger_role = 'creditor' then -s.signed else 0 end), 0)
  into v_ocl, v_creditors
  from public.ledgers l
  join public.account_groups g on g.id = l.group_id
  cross join lateral (
    select app_private.ledger_opening_signed(p_company_id, l.id, p_fy_end + 1, null) as signed
  ) s
  where l.company_id = p_company_id and g.nature = 'current_liability';

  select coalesce(sum(s.signed), 0) into v_nfa
  from public.ledgers l
  join public.account_groups g on g.id = l.group_id
  cross join lateral (
    select app_private.ledger_opening_signed(p_company_id, l.id, p_fy_end + 1, null) as signed
  ) s
  where l.company_id = p_company_id and g.nature = 'fixed_asset';

  select coalesce(sum(-s.signed), 0) into v_ltd
  from public.ledgers l
  join public.account_groups g on g.id = l.group_id
  cross join lateral (
    select app_private.ledger_opening_signed(p_company_id, l.id, p_fy_end + 1, null) as signed
  ) s
  where l.company_id = p_company_id
    and g.nature in ('long_term_borrowing','non_current_liability','long_term_provision','deferred_tax');

  select coalesce(sum(-s.signed), 0) into v_networth
  from public.ledgers l
  join public.account_groups g on g.id = l.group_id
  cross join lateral (
    select app_private.ledger_opening_signed(p_company_id, l.id, p_fy_end + 1, null) as signed
  ) s
  where l.company_id = p_company_id
    and g.nature in ('share_capital','reserves_surplus','capital');

  v_tca := v_cash + v_stock + v_debtors + v_other_ca;
  v_tcl := v_ocl + v_bank_borrow;

  -- ---------------- Operating, for the period ----------------
  select
    coalesce(sum(case when g.nature = 'direct_income'    then e.credit_amount - e.debit_amount else 0 end), 0),
    coalesce(sum(case when g.nature = 'indirect_income'  then e.credit_amount - e.debit_amount else 0 end), 0),
    coalesce(sum(case when g.nature = 'direct_expense'   then e.debit_amount - e.credit_amount else 0 end), 0),
    coalesce(sum(case when g.nature = 'indirect_expense' then e.debit_amount - e.credit_amount else 0 end), 0),
    coalesce(sum(case when g.nature in ('direct_expense','indirect_expense')
                       and l.name ~* '(interest|finance cost)'
                      then e.debit_amount - e.credit_amount else 0 end), 0),
    coalesce(sum(case when g.nature in ('direct_expense','indirect_expense')
                       and l.name ~* 'deprec'
                      then e.debit_amount - e.credit_amount else 0 end), 0)
  into v_sales, v_other_inc, v_direct_exp, v_indirect_exp, v_interest, v_deprec
  from public.voucher_entries e
  join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
  join public.ledgers l on l.id = e.ledger_id
  join public.account_groups g on g.id = l.group_id
  where e.company_id = p_company_id
    and not v.is_deleted
    and v.voucher_date between p_fy_start and p_fy_end;

  select exists (
    select 1 from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    where l.company_id = p_company_id
      and g.nature in ('direct_expense','indirect_expense')
      and l.name ~* '(interest|finance cost)'
  ) into v_interest_found;

  v_gross     := v_sales - v_direct_exp;
  v_opprofit  := v_gross + v_other_inc - v_indirect_exp;
  v_netprofit := v_opprofit;

  -- Current-period profit or loss has NOT been closed to reserves yet (that is
  -- year-end closing, 0020), so the capital and reserves ledgers alone are
  -- stale by exactly this period's result — get_balance_sheet shows the same
  -- figure as its own separate "Profit/Loss for the period" line rather than
  -- folding it in. Net worth must absorb it, or every ratio built on net worth
  -- (debt-equity, TOL/TNW) overstates the borrower's own stake — the exact
  -- direction of error a lender must never be shown. Caught by hand-verifying
  -- against the balance sheet before this ever shipped.
  -- Profit retained from every year BEFORE this one. v_networth above is
  -- cumulative (ledger_opening_signed sums every entry up to p_fy_end), but
  -- v_netprofit only covers p_fy_start..p_fy_end. Prior years profit has never
  -- been closed to reserves either, so without this term net worth silently
  -- drops every rupee the business earned before the current year -- and net
  -- worth is the denominator of both gearing ratios a lender reads first.
  select coalesce(sum(
           case when g.nature in ('direct_income','indirect_income')
                then e.credit_amount - e.debit_amount
                else -(e.debit_amount - e.credit_amount) end), 0)
    into v_profit_bf
  from public.voucher_entries e
  join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
  join public.ledgers l on l.id = e.ledger_id
  join public.account_groups g on g.id = l.group_id
  where e.company_id = p_company_id
    and not v.is_deleted
    and g.nature in ('direct_income','indirect_income','direct_expense','indirect_expense')
    and v.voucher_date < p_fy_start;

  v_networth := v_networth + v_profit_bf + v_netprofit;

  -- ---------------- MPBF ----------------
  v_wcg   := v_tca - v_ocl;
  v_nwc   := v_tca - v_tcl;
  v_mpbf1 := 0.75 * v_wcg;
  v_mpbf2 := (0.75 * v_tca) - v_ocl;

  select coalesce(sum(bf.sanctioned_limit), 0) into v_sanctioned
    from public.banking_facilities bf
   where bf.company_id = p_company_id and bf.is_active;

  v_cr      := case when v_tcl <> 0 then round(v_tca / v_tcl, 2) end;
  v_qr      := case when v_tcl <> 0 then round((v_tca - v_stock) / v_tcl, 2) end;
  v_de      := case when v_networth > 0 then round((v_ltd + v_bank_borrow) / v_networth, 2) end;
  v_tol_tnw := case when v_networth > 0 then round((v_tcl + v_ltd) / v_networth, 2) end;
  v_ic      := case when v_interest_found and v_interest > 0 then round((v_opprofit + v_interest) / v_interest, 2) end;
  v_dscr    := case when v_interest_found and v_interest > 0 then round((v_netprofit + v_deprec + v_interest) / v_interest, 2) end;

  -- ---------------- Emit ----------------
  return query values
    ('balance_sheet','inventory','Inventory / stock-in-hand', v_stock,'inr',null::numeric,null::text,null::boolean),
    ('balance_sheet','receivables','Sundry debtors', v_debtors,'inr',null,null,null),
    ('balance_sheet','cash_bank','Cash and bank balances', v_cash,'inr',null,null,null),
    ('balance_sheet','other_ca','Other current assets', v_other_ca,'inr',null,null,null),
    ('balance_sheet','tca','Total current assets', v_tca,'inr',null,null,null),
    ('balance_sheet','creditors','Sundry creditors', v_creditors,'inr',null,null,null),
    ('balance_sheet','ocl','Current liabilities (excl. bank borrowing)', v_ocl,'inr',null,
       'MPBF is computed against this, not total CL',null),
    ('balance_sheet','bank_borrowing','Bank borrowing (overdrawn CC/OD)', v_bank_borrow,'inr',null,
       'Derived: cash and bank ledgers carrying a credit balance',null),
    ('balance_sheet','tcl','Total current liabilities', v_tcl,'inr',null,null,null),
    ('balance_sheet','nfa','Net fixed assets', v_nfa,'inr',null,null,null),
    ('balance_sheet','ltd','Long-term debt and provisions', v_ltd,'inr',null,null,null),
    ('balance_sheet','networth','Tangible net worth', v_networth,'inr',null,
       'Capital plus reserves. Intangibles are not separately tracked, so this is not reduced for them',null),

    ('operating','net_sales','Net sales (direct income)', v_sales,'inr',null,null,null),
    ('operating','other_income','Other income', v_other_inc,'inr',null,null,null),
    ('operating','cogs','Cost of sales (direct expense)', v_direct_exp,'inr',null,null,null),
    ('operating','gross_profit','Gross profit', v_gross,'inr',null,null,null),
    ('operating','overheads','Operating overheads (indirect expense)', v_indirect_exp,'inr',null,null,null),
    ('operating','net_profit','Net profit', v_netprofit,'inr',null,
       'Before tax. This app does not post a current-tax provision automatically',null),
    ('operating','interest','Interest / finance cost',
       case when v_interest_found then v_interest end,'inr',null,
       case when v_interest_found then null
            else 'No ledger named like interest or finance cost — the coverage ratios below are not computable' end,null),
    ('operating','depreciation','Depreciation charged', v_deprec,'inr',null,
       'Name-matched on the ledger. Book depreciation itself lives in the Fixed assets report',null),

    ('ratio','current_ratio','Current ratio', v_cr,'ratio',1.25,
       'Banks look for 1.25 or better; Tandon Method II implies 1.33',
       case when v_cr is null then null else v_cr >= 1.25 end),
    ('ratio','quick_ratio','Quick ratio (acid test)', v_qr,'ratio',1.00,
       'Current assets excluding stock, over current liabilities',
       case when v_qr is null then null else v_qr >= 1.00 end),
    ('ratio','debt_equity','Debt-equity ratio', v_de,'ratio',2.00,
       'Lower is safer; most banks cap this at 2:1 for working capital',
       case when v_de is null then null else v_de <= 2.00 end),
    ('ratio','tol_tnw','TOL / TNW', v_tol_tnw,'ratio',3.00,
       'Total outside liabilities to tangible net worth',
       case when v_tol_tnw is null then null else v_tol_tnw <= 3.00 end),
    ('ratio','gross_margin','Gross margin',
       case when v_sales <> 0 then round(v_gross / v_sales * 100, 2) end,'percent',null,null,null),
    ('ratio','net_margin','Net margin',
       case when v_sales <> 0 then round(v_netprofit / v_sales * 100, 2) end,'percent',null,null,null),
    ('ratio','debtor_days','Debtor days',
       case when v_sales > 0 then round(v_debtors * v_days / v_sales, 0) end,'days',null,
       'Receivables expressed as days of sales, over the period selected',null),
    ('ratio','inventory_days','Inventory days',
       case when v_direct_exp > 0 then round(v_stock * v_days / v_direct_exp, 0) end,'days',null,
       'Stock expressed as days of cost of sales',null),
    ('ratio','creditor_days','Creditor days',
       case when v_direct_exp > 0 then round(v_creditors * v_days / v_direct_exp, 0) end,'days',null,
       'Payables expressed as days of cost of sales',null),
    ('ratio','wc_cycle','Working capital cycle',
       case when v_sales > 0 and v_direct_exp > 0
            then round(v_debtors * v_days / v_sales, 0)
               + round(v_stock * v_days / v_direct_exp, 0)
               - round(v_creditors * v_days / v_direct_exp, 0) end,'days',null,
       'Debtor days plus inventory days less creditor days. Shorter is better',null),
    ('ratio','interest_coverage','Interest coverage', v_ic,'times',2.00,
       case when v_ic is not null then 'EBIT over interest'
            else 'Not computable — no interest ledger identified' end,
       case when v_ic is null then null else v_ic >= 2.00 end),
    ('ratio','dscr','Debt service coverage (DSCR)', v_dscr,'times',1.50,
       case when v_dscr is not null
            then 'Interest only — this schema does not track scheduled principal repayment, so true DSCR will be LOWER than shown'
            else 'Not computable — no interest ledger identified' end,
       case when v_dscr is null then null else v_dscr >= 1.50 end),

    ('mpbf','wcg','Working capital gap (TCA less OCL)', v_wcg,'inr',null,null,null),
    ('mpbf','nwc','Net working capital (actual)', v_nwc,'inr',null,
       'Total current assets less ALL current liabilities, including bank borrowing',null),
    ('mpbf','mpbf_1','MPBF — Tandon Method I', v_mpbf1,'inr',null,
       '75% of the working capital gap; the borrower funds 25% of the gap',null),
    ('mpbf','mpbf_2','MPBF — Tandon Method II', v_mpbf2,'inr',null,
       '75% of total current assets less OCL; the borrower funds 25% of ALL current assets. The stricter test, and what banks sanction against',null),
    ('mpbf','sanctioned','Sanctioned limit on record', v_sanctioned,'inr',null,
       'Sum of active banking facilities from Settings. Compare against Method II',null),
    ('mpbf','headroom','Headroom vs Method II', v_mpbf2 - v_sanctioned,'inr',null,
       'Positive means the books support more than is currently sanctioned',
       case when v_sanctioned > 0 then (v_mpbf2 - v_sanctioned) >= 0 end);
end;
$function$;

revoke all on function public.get_cma_ratios(uuid, date, date) from public, anon;
grant execute on function public.get_cma_ratios(uuid, date, date) to authenticated;

comment on function public.get_cma_ratios(uuid, date, date) is
  'CMA data and ratio pack. Tangible net worth absorbs BOTH profit brought forward from earlier years and the current period''s result, because neither has been closed to reserves (there is no year-end closing journal -- see 0073 header).';
