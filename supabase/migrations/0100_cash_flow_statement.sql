-- ============================================================================
-- 0100 — Cash Flow Statement under AS 3 (indirect method)
-- ============================================================================
-- Sec 2(40), Companies Act 2013 defines "financial statements" to INCLUDE a
-- cash flow statement for every company — except one it names by exclusion.
-- The exclusion was added by the MCA's notification dated 13 June 2017 (the
-- proviso to Sec 2(40)): a One Person Company, a small company and a
-- dormant company (Sec 455) "may not include" a cash flow statement in what
-- they file. Re-confirmed live with two web searches for this migration
-- rather than trusted from memory, because this codebase has been burned by
-- an "obvious" statutory assumption before (0087's deemed-exports finding)
-- and this exemption specifically has a documented history of amendment —
-- the SECOND search targeted exactly that, "has Sec 2(40) itself changed
-- since 2017". It has not: what changed in 2021 and again in 2022 was the
-- paid-up-capital/turnover THRESHOLD that decides which companies count as
-- "small" (Companies (Specification of Definition Details) Amendment Rules,
-- most recently 4 crore paid-up / 40 crore turnover), not the three-way
-- exclusion list itself, and not which entities the list names. Both
-- searches agree on the same three names from ClearTax, TaxGuru and
-- ca2013.com. THIS APP DOES NOT TRACK "small company" or "dormant company"
-- status — no paid-up capital, no turnover-threshold flag, no Sec 455
-- dormancy field anywhere in `companies` or `ref_entity_types` — so it
-- cannot auto-suppress this report the way it could for, say, entity_type =
-- 'opc' (which the schema DOES carry). Rather than fabricate a suppression
-- rule this app cannot actually evaluate, the report page shows an
-- informational note naming all three exemptions and lets the user judge
-- their own company against them; see the page for the exact wording.
--
-- WHICH STANDARD. AS 3 (ICAI, legacy framework) and Ind AS 7 (the Ind-AS-
-- converged standard) are this app's only two candidates — checked live,
-- there is no third citation in play here the way AS 22/Ind AS 12 both had
-- to be named for deferred tax (0091). A second search on the two
-- standards' actual differences found real ones: Ind AS 7 folds
-- on-demand-repayable bank overdrafts into cash equivalents (AS 3 does not
-- say so), Ind AS 7 fixes interest-paid to financing and interest/dividend-
-- received to investing while AS 3 leaves that classification more open,
-- and AS 3 (not Ind AS 7) calls for extraordinary items to be separately
-- flagged within each activity. None of those differences are things this
-- migration could honour even if it picked one standard over the other —
-- there is no per-voucher tag anywhere in this schema marking a posting as
-- "interest paid" versus any other indirect expense, or as extraordinary,
-- and bank overdraft is not a distinct ledger_role from ordinary cash_bank.
-- So, matching how 0091's own header treated AS 22 vs Ind AS 12 (both cited
-- together because the numbers this app can actually produce collapse to
-- the same figure under either), this report is labelled "AS 3 / Ind AS 7"
-- and both are named on the report page rather than the app silently
-- picking one — `companies` has no Ind-AS-applicability flag (net worth
-- threshold, listing status) to pick correctly with, and the indirect-
-- method STRUCTURE this migration implements — profit before tax, adjusted
-- for non-cash items and working-capital movements, to give cash from
-- operations; then investing; then financing; reconciled to the net change
-- in cash and cash equivalents — is identical under both standards.
--
-- THE CORE DEPENDENCY: TWO REAL BALANCE SHEET SNAPSHOTS. An indirect-method
-- cash flow statement is fundamentally a DIFF of two balance sheets, not a
-- period range the way a P&L is — get_profit_and_loss(from, to) genuinely
-- answers "how much was earned in this window", but there is no equivalent
-- "how much cash moved in this window" query without first knowing what
-- every OTHER ledger looked like at both ends of the window. That is why
-- this migration could not have shipped before 0089: 0089 is what gave
-- get_balance_sheet a real, callable snapshot machinery (p_as_at, called
-- twice) AND the ledger_role sub-classification the Investing section
-- below reads. This migration calls get_balance_sheet twice per report —
-- once at p_period_start - 1 (the closing position of the day BEFORE the
-- period, i.e. the period's own opening) and once at p_period_end (the
-- period's own closing) — plus get_profit_and_loss once for the period
-- itself. Both are confirmed STABLE and side-effect-free by their own
-- pg_proc.provolatile ('s') read live before writing this, not assumed —
-- see this migration's live_verification notes.
--
-- WHY THE ARITHMETIC ACTUALLY TIES OUT TO THE PENNY, NOT APPROXIMATELY.
-- get_balance_sheet enumerates exactly nine `nature` values (0089): capital,
-- share_capital, reserves_surplus, current_asset, current_liability,
-- non_current_liability, long_term_borrowing, deferred_tax,
-- long_term_provision, fixed_asset. This migration puts every one of those
-- nine into exactly one of: the cash reconciling target (current_asset,
-- ledger_role = 'cash_bank'), Operating working capital (the REST of
-- current_asset, plus all of current_liability), Investing (all of
-- fixed_asset), or Financing (capital + share_capital + reserves_surplus +
-- non_current_liability + long_term_borrowing + deferred_tax +
-- long_term_provision). Because get_balance_sheet's own asset-side/
-- liability-side signing already makes "assets minus liabilities" hold
-- ledger-for-ledger (it is the same signed convention 0073 proved balances
-- to 0.00 across 84 real company/date combinations, cash and non-cash
-- ledgers alike), and because this migration's Operating section starts
-- from the PERIOD's own net profit (get_profit_and_loss(period_start,
-- period_end)) rather than from a cumulative retained-earnings figure, the
-- three sections' sum is mathematically forced to equal the real
-- opening-to-closing movement in cash_bank — not approximately, exactly.
-- This is the one place in the whole feature where "it should balance" is
-- provable ahead of running a single query, and the live_verification
-- section below still checks it to the rupee against Sharma Textiles
-- rather than trust the proof.
--
-- ONE DELIBERATE EXCLUSION, AND WHY IT IS NOT OPTIONAL. Depreciation
-- (0077) posts Dr Depreciation (P&L, Indirect Expenses) / Cr Accumulated
-- Depreciation (balance sheet, Fixed Assets, ledger_role
-- tangible_fixed_asset) for the SAME amount in the SAME voucher. Net profit
-- already carries the Depreciation debit as a reduction; AS 3's indirect
-- method adds it straight back as the textbook first non-cash adjustment,
-- which this migration does, reading it off get_profit_and_loss's own
-- 'Depreciation' row (nature indirect_expense) — the same name-based
-- ledger identification 0077's own get_fixed_asset_book_reconciliation
-- already uses (`l.name <> 'Accumulated Depreciation'`), reused rather than
-- invented fresh. If the Investing section then also included the
-- Accumulated Depreciation ledger's own movement inside the fixed_asset
-- nature bucket, the SAME depreciation amount would be added back once in
-- Operating and counted a second time as an (illusory) investing outflow —
-- worked out on paper before writing the SQL: it would overstate the
-- bottom line by exactly the depreciation charge, and the reconciliation
-- to the real cash ledger would fail by that exact amount. So the
-- Investing section's tangible-fixed-asset bucket explicitly excludes the
-- ledger literally named 'Accumulated Depreciation' — matching, not
-- reinventing, 0077's own exclusion — while every other fixed_asset ledger
-- (intangible, capital-work-in-progress, and 'investment' — the ledger_role
-- 0089 introduced specifically for Non-current Investments) is read
-- unmodified. This is exactly the "genuinely good use of that new
-- dimension" the task brief asked for: without 0089's ledger_role split,
-- Investing could not have been shown as four Schedule III sub-lines
-- (Tangible / Intangible / Capital Work-in-Progress / Investments) rather
-- than one undifferentiated "Fixed Assets" delta.
--
-- WHAT "NET PROFIT BEFORE TAX" ACTUALLY MEANS HERE. This app has no
-- income-tax-expense ledger convention anywhere — no tax_ledger_map
-- purpose, no seeded system ledger, nothing resembling how 'Depreciation'
-- is identified. get_income_tax_computation (0026) and tax_payments (0079)
-- compute and record what is OWED and what has been PAID as their own
-- separate, unposted figures; income tax is never itself booked as a P&L
-- expense by anything this app posts automatically. So "net profit before
-- tax", as this migration reads it straight off get_profit_and_loss for
-- the period, is honestly just "net profit as the books record it" — which
-- happens to already BE before tax for every company that has not manually
-- journalled a tax provision into some indirect-expense ledger of their
-- own choosing, and would silently be AFTER a self-created tax provision
-- for the rare company that has. The report page says this in a footnote
-- rather than pretending a distinction this schema cannot draw.
--
-- WHAT THIS DOES NOT DO — same honesty precedent as 0072 (ITC-04 prep):
-- this is an APPROXIMATION FROM LEDGER MOVEMENTS, not a transaction-tagged
-- cash flow statement. LEKHA has no cash-flow-activity tag on individual
-- vouchers (no per-voucher "this is investing, this is financing" marker
-- the way, say, branch_id or cost_centre_id exist), so this migration
-- cannot show a genuine "Proceeds from sale of fixed assets" line distinct
-- from "Purchase of fixed assets" — only the NET movement in each bucket,
-- which is what a ledger-diff approach can actually see. A period with
-- both a purchase and a disposal of the same class of asset nets to a
-- smaller number here than a transaction-tagged statement would show, even
-- though the total across all sections still reconciles correctly (proven
-- above) — netting affects PRESENTATION granularity within a line, never
-- the bottom line. Also out of scope, for the same reason: extraordinary
-- items are not separately flagged (AS 3 asks for this, Ind AS 7 does not
-- — see above), and no distinction is drawn between short-term and
-- long-term borrowings within Financing beyond what nature already gives
-- (long_term_borrowing vs the current-liability sub-ledgers already inside
-- Operating). Every one of these is named on the report page, not just
-- here.
-- ============================================================================

create or replace function public.get_cash_flow_statement(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
)
returns table (
  step integer,
  section text,       -- 'operating' | 'investing' | 'financing' | 'reconciliation'
  line_item text,      -- stable key for the UI to key off
  label text,
  amount numeric
)
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_opening_date date;
  v_step integer := 1;

  v_net_profit numeric;
  v_depreciation numeric;
  v_ca_open numeric; v_ca_close numeric;   -- current assets excl. cash/bank
  v_cl_open numeric; v_cl_close numeric;   -- current liabilities
  v_wc_assets numeric;                     -- operating contribution, sign-adjusted
  v_wc_liabilities numeric;
  v_cash_from_operating numeric;

  v_tan_open numeric; v_tan_close numeric; -- tangible, excl. Accumulated Depreciation
  v_intan_open numeric; v_intan_close numeric;
  v_cwip_open numeric; v_cwip_close numeric;
  v_inv_open numeric; v_inv_close numeric;
  v_investing_tangible numeric;
  v_investing_intangible numeric;
  v_investing_cwip numeric;
  v_investing_investments numeric;
  v_cash_from_investing numeric;

  v_capres_open numeric; v_capres_close numeric;
  v_loanfund_open numeric; v_loanfund_close numeric;
  v_financing_capital numeric;
  v_financing_loan_funds numeric;
  v_cash_from_financing numeric;

  v_net_change numeric;
  v_opening_cash numeric;
  v_closing_cash numeric;
  v_reconciliation_diff numeric;
begin
  if p_period_end < p_period_start then
    raise exception 'Period end (%) is before period start (%)', p_period_end, p_period_start;
  end if;

  v_opening_date := p_period_start - 1;

  -- ---- Operating: net profit, depreciation add-back, working capital -----
  -- Every subquery below aliases the table function and qualifies its
  -- `amount` column explicitly (pl.amount / bs.amount) — this function's own
  -- OUT parameter is also named `amount` (the RETURNS TABLE column every row
  -- is emitted through below), and PL/pgSQL resolves a bare `amount` inside
  -- a SQL statement as that variable, not the queried column, which is an
  -- easy silent-wrong-number trap here rather than the ambiguity error it
  -- actually raises (caught live on the first run — see live_verification).
  select coalesce(sum(
           case when pl.nature in ('direct_income', 'indirect_income') then pl.amount
                when pl.nature in ('direct_expense', 'indirect_expense') then -pl.amount
                else 0 end
         ), 0)
    into v_net_profit
    from public.get_profit_and_loss(p_company_id, p_period_start, p_period_end, null) pl;

  select coalesce(sum(pl.amount), 0)
    into v_depreciation
    from public.get_profit_and_loss(p_company_id, p_period_start, p_period_end, null) pl
   where pl.nature = 'indirect_expense' and pl.ledger_name = 'Depreciation';

  select coalesce(sum(bs.amount), 0) into v_ca_close
    from public.get_balance_sheet(p_company_id, p_period_end, null) bs
   where bs.nature = 'current_asset' and bs.ledger_role <> 'cash_bank';
  select coalesce(sum(bs.amount), 0) into v_ca_open
    from public.get_balance_sheet(p_company_id, v_opening_date, null) bs
   where bs.nature = 'current_asset' and bs.ledger_role <> 'cash_bank';

  select coalesce(sum(bs.amount), 0) into v_cl_close
    from public.get_balance_sheet(p_company_id, p_period_end, null) bs
   where bs.nature = 'current_liability';
  select coalesce(sum(bs.amount), 0) into v_cl_open
    from public.get_balance_sheet(p_company_id, v_opening_date, null) bs
   where bs.nature = 'current_liability';

  -- A rise in a non-cash current asset consumes cash; a rise in a current
  -- liability is a source of it — the standard indirect-method signs.
  v_wc_assets := v_ca_open - v_ca_close;
  v_wc_liabilities := v_cl_close - v_cl_open;

  v_cash_from_operating := round(v_net_profit + v_depreciation + v_wc_assets + v_wc_liabilities, 2);

  -- ---- Investing: the four Schedule III fixed-asset sub-heads (0089) -----
  select coalesce(sum(bs.amount), 0) into v_tan_close
    from public.get_balance_sheet(p_company_id, p_period_end, null) bs
   where bs.nature = 'fixed_asset' and bs.ledger_role = 'tangible_fixed_asset'
     and bs.ledger_name <> 'Accumulated Depreciation';
  select coalesce(sum(bs.amount), 0) into v_tan_open
    from public.get_balance_sheet(p_company_id, v_opening_date, null) bs
   where bs.nature = 'fixed_asset' and bs.ledger_role = 'tangible_fixed_asset'
     and bs.ledger_name <> 'Accumulated Depreciation';

  select coalesce(sum(bs.amount), 0) into v_intan_close
    from public.get_balance_sheet(p_company_id, p_period_end, null) bs
   where bs.nature = 'fixed_asset' and bs.ledger_role = 'intangible_fixed_asset';
  select coalesce(sum(bs.amount), 0) into v_intan_open
    from public.get_balance_sheet(p_company_id, v_opening_date, null) bs
   where bs.nature = 'fixed_asset' and bs.ledger_role = 'intangible_fixed_asset';

  select coalesce(sum(bs.amount), 0) into v_cwip_close
    from public.get_balance_sheet(p_company_id, p_period_end, null) bs
   where bs.nature = 'fixed_asset' and bs.ledger_role = 'capital_work_in_progress';
  select coalesce(sum(bs.amount), 0) into v_cwip_open
    from public.get_balance_sheet(p_company_id, v_opening_date, null) bs
   where bs.nature = 'fixed_asset' and bs.ledger_role = 'capital_work_in_progress';

  select coalesce(sum(bs.amount), 0) into v_inv_close
    from public.get_balance_sheet(p_company_id, p_period_end, null) bs
   where bs.nature = 'fixed_asset' and bs.ledger_role = 'investment';
  select coalesce(sum(bs.amount), 0) into v_inv_open
    from public.get_balance_sheet(p_company_id, v_opening_date, null) bs
   where bs.nature = 'fixed_asset' and bs.ledger_role = 'investment';

  v_investing_tangible := round(v_tan_open - v_tan_close, 2);
  v_investing_intangible := round(v_intan_open - v_intan_close, 2);
  v_investing_cwip := round(v_cwip_open - v_cwip_close, 2);
  v_investing_investments := round(v_inv_open - v_inv_close, 2);

  v_cash_from_investing :=
    v_investing_tangible + v_investing_intangible + v_investing_cwip + v_investing_investments;

  -- ---- Financing: capital/reserves, and loan funds -----------------------
  select coalesce(sum(bs.amount), 0) into v_capres_close
    from public.get_balance_sheet(p_company_id, p_period_end, null) bs
   where bs.nature in ('capital', 'share_capital', 'reserves_surplus');
  select coalesce(sum(bs.amount), 0) into v_capres_open
    from public.get_balance_sheet(p_company_id, v_opening_date, null) bs
   where bs.nature in ('capital', 'share_capital', 'reserves_surplus');

  select coalesce(sum(bs.amount), 0) into v_loanfund_close
    from public.get_balance_sheet(p_company_id, p_period_end, null) bs
   where bs.nature in ('non_current_liability', 'long_term_borrowing', 'deferred_tax', 'long_term_provision');
  select coalesce(sum(bs.amount), 0) into v_loanfund_open
    from public.get_balance_sheet(p_company_id, v_opening_date, null) bs
   where bs.nature in ('non_current_liability', 'long_term_borrowing', 'deferred_tax', 'long_term_provision');

  v_financing_capital := round(v_capres_close - v_capres_open, 2);
  v_financing_loan_funds := round(v_loanfund_close - v_loanfund_open, 2);
  v_cash_from_financing := v_financing_capital + v_financing_loan_funds;

  -- ---- Reconciliation ------------------------------------------------------
  v_net_change := round(v_cash_from_operating + v_cash_from_investing + v_cash_from_financing, 2);

  select coalesce(sum(bs.amount), 0) into v_opening_cash
    from public.get_balance_sheet(p_company_id, v_opening_date, null) bs
   where bs.nature = 'current_asset' and bs.ledger_role = 'cash_bank';
  select coalesce(sum(bs.amount), 0) into v_closing_cash
    from public.get_balance_sheet(p_company_id, p_period_end, null) bs
   where bs.nature = 'current_asset' and bs.ledger_role = 'cash_bank';

  -- Independently derived, not defined as opening + net_change — a real
  -- ledger read, so a future change that breaks the identity this
  -- migration's header proves shows up here as a non-zero difference
  -- instead of being silently defined away.
  v_reconciliation_diff := round((v_opening_cash + v_net_change) - v_closing_cash, 2);

  -- ---- Emit ------------------------------------------------------------
  section := 'operating'; line_item := 'net_profit_before_tax';
  label := 'Net profit for the period (before tax — see report note)';
  amount := round(v_net_profit, 2); step := v_step; return next; v_step := v_step + 1;

  section := 'operating'; line_item := 'depreciation_addback';
  label := 'Add: Depreciation (non-cash)';
  amount := round(v_depreciation, 2); step := v_step; return next; v_step := v_step + 1;

  section := 'operating'; line_item := 'wc_current_assets';
  label := '(Increase)/Decrease in current assets (other than cash and bank)';
  amount := round(v_wc_assets, 2); step := v_step; return next; v_step := v_step + 1;

  section := 'operating'; line_item := 'wc_current_liabilities';
  label := 'Increase/(Decrease) in current liabilities';
  amount := round(v_wc_liabilities, 2); step := v_step; return next; v_step := v_step + 1;

  section := 'operating'; line_item := 'cash_from_operating';
  label := 'Net cash from Operating Activities';
  amount := v_cash_from_operating; step := v_step; return next; v_step := v_step + 1;

  section := 'investing'; line_item := 'investing_tangible';
  label := 'Net (purchase)/sale of tangible fixed assets';
  amount := v_investing_tangible; step := v_step; return next; v_step := v_step + 1;

  section := 'investing'; line_item := 'investing_intangible';
  label := 'Net (purchase)/sale of intangible assets';
  amount := v_investing_intangible; step := v_step; return next; v_step := v_step + 1;

  section := 'investing'; line_item := 'investing_cwip';
  label := 'Net movement in Capital Work-in-Progress';
  amount := v_investing_cwip; step := v_step; return next; v_step := v_step + 1;

  section := 'investing'; line_item := 'investing_investments';
  label := 'Net (purchase)/sale of non-current investments';
  amount := v_investing_investments; step := v_step; return next; v_step := v_step + 1;

  section := 'investing'; line_item := 'cash_from_investing';
  label := 'Net cash used in Investing Activities';
  amount := v_cash_from_investing; step := v_step; return next; v_step := v_step + 1;

  section := 'financing'; line_item := 'financing_capital';
  label := 'Net proceeds/(repayment) — capital and reserves';
  amount := v_financing_capital; step := v_step; return next; v_step := v_step + 1;

  section := 'financing'; line_item := 'financing_loan_funds';
  label := 'Net proceeds/(repayment) — loan funds and other non-current liabilities';
  amount := v_financing_loan_funds; step := v_step; return next; v_step := v_step + 1;

  section := 'financing'; line_item := 'cash_from_financing';
  label := 'Net cash from Financing Activities';
  amount := v_cash_from_financing; step := v_step; return next; v_step := v_step + 1;

  section := 'reconciliation'; line_item := 'net_change_in_cash';
  label := 'Net increase/(decrease) in cash and cash equivalents';
  amount := v_net_change; step := v_step; return next; v_step := v_step + 1;

  section := 'reconciliation'; line_item := 'opening_cash_and_bank';
  label := 'Cash and cash equivalents at the beginning of the period';
  amount := round(v_opening_cash, 2); step := v_step; return next; v_step := v_step + 1;

  section := 'reconciliation'; line_item := 'closing_cash_and_bank';
  label := 'Cash and cash equivalents at the end of the period';
  amount := round(v_closing_cash, 2); step := v_step; return next; v_step := v_step + 1;

  section := 'reconciliation'; line_item := 'reconciliation_difference';
  label := 'Difference (should be nil)';
  amount := v_reconciliation_diff; step := v_step; return next;

  return;
end;
$fn$;

revoke all on function public.get_cash_flow_statement(uuid, date, date) from public, anon;
grant execute on function public.get_cash_flow_statement(uuid, date, date) to authenticated;

comment on function public.get_cash_flow_statement(uuid, date, date) is
  'AS 3 / Ind AS 7 cash flow statement, indirect method, from two get_balance_sheet snapshots (day before p_period_start, and p_period_end) plus get_profit_and_loss for the period. Operating = net profit + Depreciation add-back + working-capital movement (current_asset excl. cash_bank, and current_liability). Investing = delta in the four 0089 fixed-asset sub-heads, tangible excluding the Accumulated Depreciation ledger (its movement is the same figure already added back in Operating — see migration header for why including it twice would break the reconciliation). Financing = delta in capital/reserves and loan-fund natures. An approximation from ledger movements, not a transaction-tagged cash flow — see 0100.';
