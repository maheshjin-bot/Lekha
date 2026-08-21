-- ============================================================================
-- 0056 — CMA data and ratio analysis: the lender-facing report the banking
--         module (0050) and stock statement (0034) were always building toward
-- ============================================================================
-- LEKHA already computes drawing power per banking facility (0050) and a
-- stock statement (0034) — the two things a bank asks for MONTHLY. This adds
-- what a bank asks for ANNUALLY, at sanction and at renewal: CMA (Credit
-- Monitoring Analysis) data, and the ratio set that goes with it.
--
-- VERIFIED LIVE (WebSearch, Aug 2026), not carried from training data:
--   * Banks require CMA data for business loans above roughly Rs 10 lakh.
--   * MPBF (Maximum Permissible Bank Finance), Tandon Committee:
--       Method I  = 0.75 x (TCA - OCL)      borrower funds 25% of the GAP
--       Method II = 0.75 x TCA - OCL        borrower funds 25% of TOTAL CA
--     where TCA = total current assets and OCL = current liabilities OTHER
--     than bank borrowings. Method II is the stricter test and is what major
--     Indian banks actually sanction against; Method I is computed alongside
--     for reference. Both are returned, for exactly that reason.
--   * Current ratio benchmark >= 1.25 (Method II mathematically implies 1.33).
--
-- BANK BORROWING IS DERIVED, NOT GUESSED: MPBF needs "current liabilities
-- excluding bank borrowings", and this schema has no is_bank_borrowing flag.
-- Rather than match on ledger name, this uses the accounting fact: a
-- cash_bank ledger carrying a CREDIT balance is an overdrawn account — a
-- CC/OD drawdown — and that IS a bank borrowing; the same ledger in debit is
-- cash. Same ledger set, split by sign, which is what a balance sheet does
-- anyway. banking_facilities.sanctioned_limit (0050) is surfaced alongside so
-- the reader can compare MPBF against what the bank actually sanctioned.
--
-- INTEREST AND DEPRECIATION ARE NAME-DETECTED, and the ratios depending on
-- them return NULL rather than a misleading number when nothing matches.
-- Neither is seeded by seed_chart_of_accounts — a business creates them as it
-- needs them — and there is no ledger_role for either. So they are matched on
-- name, the same documented-compromise pattern 0032 already uses to find
-- Cash-in-Hand. Where no interest ledger is found, interest_coverage and DSCR
-- come back NULL with a note, NOT as "infinite coverage" — a company with no
-- identifiable interest cost must not read as infinitely creditworthy.
--
-- SHAPE: returns (section, metric_code, metric_label, value, unit, benchmark,
-- benchmark_note, is_healthy) rows rather than one very wide row — a CMA pack
-- IS a list of line items, it renders as one, and adding a metric later stays
-- an insert-shaped change rather than a signature change every caller must
-- follow.
--
-- NOT ATTEMPTED, documented rather than silently omitted:
--   * The PROJECTED years. Real CMA Forms II-VI carry audited past years plus
--     three projected ones; a projection is the borrower's own forecast, not
--     a fact derivable from the ledger, so LEKHA computes the audited column
--     and leaves projections to the borrower and their CA.
--   * Fund flow statement (Form V) — needs two comparative balance sheets;
--     buildable later on this same base.
--   * The cash-budget method (the alternative to MPBF for seasonal industry).
-- ============================================================================

create or replace function public.get_cma_ratios(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  section text,
  metric_code text,
  metric_label text,
  value numeric,
  unit text,
  benchmark numeric,
  benchmark_note text,
  is_healthy boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
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
  v_networth := v_networth + v_netprofit;

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
$$;

comment on function public.get_cma_ratios is
  'CMA (Credit Monitoring Analysis) data and lender ratio pack for a period: balance-sheet aggregates, operating summary, twelve ratios with bank benchmarks, and MPBF under Tandon Method I and II (formulas verified Aug 2026). Bank borrowing is DERIVED as cash/bank ledgers carrying a credit balance, not name-matched. Interest and depreciation ARE name-matched; interest coverage and DSCR return NULL with a note when no interest ledger exists, rather than reading as infinite coverage. DSCR is interest-only — scheduled principal repayment is not tracked, so true DSCR is lower. Projected years, fund flow (Form V) and the cash-budget method are not attempted.';
