-- ============================================================================
-- 0091 — Book-vs-tax depreciation reconciliation and AS 22 deferred tax
-- ============================================================================
-- Confirmed live before writing this (audit item T2-15):
--
--   select g.name, g.nature, count(l.id) from account_groups g
--     left join ledgers l on l.group_id = g.id
--    where g.nature = 'deferred_tax' group by 1, 2;
--
-- returned exactly one row per company: "Deferred Tax Liabilities (Net)",
-- deferred_tax, 0 ledgers. Migration 0037 seeds this Schedule III group for
-- every company — a sibling of Non-current Liabilities, not a child, because
-- app_private.enforce_account_group_nature forces a child's nature to match
-- its parent's and 'deferred_tax' needed to be finer than 'non_current_
-- liability' — but nothing has ever posted a rupee into it. Depreciation
-- (0077) already posts the BOOK charge, and get_tax_depreciation_blocks
-- already computes the Income-tax Act charge; the two legitimately differ,
-- and that difference is exactly what AS 22 / Ind AS 12 deferred tax is made
-- of. This migration computes and, on request, posts the tax EFFECT of that
-- difference. It does not recompute either depreciation figure.
--
-- A LIVE LANDMINE FOUND WHILE VERIFYING (point 6 in force). The company-level
-- lookup for this feature cannot go by NAME:
--
--   select id, company_id, name, nature, parent_group_id, is_system
--     from account_groups where name = 'Deferred Tax Liabilities (Net)';
--
-- returns TWO rows for several companies (Sharma Textiles among them) —
-- the system one (nature='deferred_tax', is_system=true, parent NULL, created
-- by 0037) and a second, is_system=FALSE row with the identical name sitting
-- as a plain child of "Non-current Liabilities" (nature='non_current_
-- liability'), created four minutes earlier on 2026-08-19 during test-data
-- seeding — evidently a hand-created group made before 0037 shipped the real
-- one, left behind rather than cleaned up. Every lookup below selects the
-- group by `nature = 'deferred_tax'`, never by name, specifically because of
-- this. Cleaning up the stray duplicate is someone else's call, not this
-- migration's — it is harmless as long as nothing posts to it, and nothing
-- here will.
--
-- WHICH STANDARD, WHICH RATE — researched, not assumed. AS 22 para 21 (ICAI)
-- reads "deferred tax assets and liabilities should be measured using the tax
-- rates and tax laws that have been enacted or substantively enacted by the
-- balance sheet date." Ind AS 12 (para 47, converged with IAS 12) reads
-- "measured ... using the tax rates ... that are expected to apply ... based
-- on tax rates ... that have been enacted or substantively enacted by the end
-- of the reporting period." The wording genuinely differs — Ind AS 12 asks
-- for the rate expected to apply on REVERSAL, AS 22 does not say that in so
-- many words — but for an Indian taxpayer the two collapse to the same
-- number in practice: the Income-tax Act is amended by a Finance Act that
-- takes effect for the year it is passed, India does not legislate a
-- multi-year forward rate schedule the way some jurisdictions do, so "the
-- rate enacted by the balance sheet date" and "the rate expected to apply on
-- reversal, based on what is enacted by the balance sheet date" are the same
-- rate unless a future change has ALREADY been enacted — which this schema
-- has no way to know about and does not pretend to. THIS MIGRATION USES THE
-- CURRENT FINANCIAL YEAR'S OWN EFFECTIVE RATE for both AS 22 and Ind AS 12
-- entities, applied to the cumulative timing difference at each balance sheet
-- date (so a rate change in a later year automatically re-measures the whole
-- balance then, which is exactly what "substantively enacted by THIS balance
-- sheet date" requires) — and says so on the report. This app does not track
-- which companies have crossed the Ind AS net-worth threshold (Companies
-- (Indian Accounting Standards) Rules, 2015) at all, so it cannot pick
-- between the two standards' wording even if they diverged; today they do
-- not, for the reason above.
--
-- WHICH RATE TO REUSE. get_income_tax_computation (0078/0079) already derives
-- company_tax_regime-based rates for companies and slab rates for
-- proprietorship/HUF, and folds in surcharge and cess to a single total_tax.
-- Rather than re-deriving 22%/25%/30% or the slab table a second time, this
-- migration calls that function for the target financial year and takes
-- effective_rate := total_tax / taxable_income * 100 — the AVERAGE rate this
-- entity actually pays on its taxable income this year, all-in with surcharge
-- and cess. For a company or firm/LLP this is exactly the MARGINAL rate too,
-- because Sec 115BAA/115BAB/default company rates and the firm's flat 30%
-- are proportional across the whole of taxable income (surcharge/cess move in
-- step, ignoring the surcharge-threshold marginal-relief gap this app already
-- documents as excluded everywhere else). For a proprietorship or HUF, whose
-- slabs are genuinely progressive, average and marginal rate differ — using
-- the average is a known, stated simplification, consistent with this app's
-- existing "starting estimate, not a filed-return number" language on the tax
-- computation itself. When taxable_income is nil or negative, no rate can be
-- derived from a ratio; the function returns rate 0 and says so rather than
-- guessing — a real timing difference in a nil-income year then produces zero
-- deferred tax rather than a fabricated number, and will show up the moment
-- the entity has taxable income to divide by.
--
-- WHY "AS AT 31 MARCH" ONLY, not an arbitrary date like the book-depreciation
-- screen. get_tax_depreciation_blocks is genuinely a SINGLE-FINANCIAL-YEAR
-- function: its half-year-addition test (p_fy_end - put_to_use_date >= 179)
-- and its one-shot rate application are only correct when p_fy_start/p_fy_end
-- span exactly one 1-April-to-31-March year — confirmed by reading
-- app_private.compute_block_opening_wdv, which itself only ever loops in
-- whole such years. Calling it with a wider or off-boundary range would
-- silently under- or over-state tax depreciation. So the function below
-- REQUIRES p_fy_end to literally be 31 March of some year and raises a clear
-- error otherwise, and it reconstructs the CUMULATIVE tax depreciation claimed
-- since the earliest asset's put-to-use date by looping one whole financial
-- year at a time up to that date — the same year-by-year idiom compute_block_
-- opening_wdv already uses, just summing depreciation_for_year across years
-- instead of carrying only the closing WDV forward. In this live dataset
-- every company's book_beginning_date is 2026-04-01, so today there is only
-- ever one financial year of history to loop over; the loop exists so the
-- function stays correct once a second year of data exists.
--
-- INCREMENTAL, NOT REVERSE-AND-REPOST — the same additive pattern as
-- post_depreciation (0077) and post_closing_stock (0076). The TARGET is the
-- cumulative timing difference to date (cumulative tax depreciation claimed
-- minus cumulative book depreciation actually POSTED — not the register's
-- figure, deliberately: if book depreciation has not been posted yet, there
-- is nothing in the P&L to have created a timing difference against, exactly
-- the same reasoning 0078 used for the income-tax add-back) times the CURRENT
-- year's effective rate. Posting charges only the movement since whatever the
-- "Deferred Tax Liabilities (Net)" ledger already carries, so re-running it
-- after the rate changes, or after more book/tax depreciation has been
-- recognised, converges rather than double-posts. A NEGATIVE target (tax
-- depreciation below cumulative book depreciation, as is genuinely the case
-- for Sharma Textiles below) is not an error — it is a net deferred tax ASSET,
-- and the single "(Net)" ledger simply carries a debit instead of a credit,
-- exactly as its name promises and exactly how Accumulated Depreciation
-- already carries a credit as a contra-asset in 0077.
--
-- WHAT THIS DOES NOT DO. Only the DEPRECIATION timing difference is covered —
-- the largest and most universal source for this app's users, and the one
-- the audit scoped this item to because both inputs already existed. Sec 43B
-- unpaid-dues disallowances, provisions, and any other timing difference are
-- real sources of deferred tax this does not compute; see the migration's own
-- note text and this repo's structured task report for that scope cut.
-- Deferred tax is also not wired into get_compliance_calendar — that function
-- is explicitly off limits to a drive-by edit from a parallel batch of agents
-- today; a human integrator should add it as its own later change.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Cumulative tax depreciation claimed since the earliest asset, as at a
-- financial-year-end date. Loops one whole 1 April-31 March year at a time,
-- the only span get_tax_depreciation_blocks is valid over — see header.
-- ----------------------------------------------------------------------------
create or replace function app_private.cumulative_tax_depreciation(
  p_company_id uuid,
  p_fy_end date
)
returns numeric
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_earliest date;
  v_year int;
  v_ystart date;
  v_yend date;
  v_year_dep numeric;
  v_total numeric := 0;
begin
  select min(put_to_use_date) into v_earliest
    from public.fixed_assets
   where company_id = p_company_id;

  if v_earliest is null or v_earliest > p_fy_end then
    return 0;
  end if;

  v_year := case when extract(month from v_earliest) >= 4
                 then extract(year from v_earliest)::int
                 else extract(year from v_earliest)::int - 1 end;

  loop
    v_ystart := make_date(v_year, 4, 1);
    v_yend := make_date(v_year + 1, 3, 31);
    exit when v_ystart > p_fy_end;

    select coalesce(sum(b.depreciation_for_year), 0) into v_year_dep
      from public.get_tax_depreciation_blocks(p_company_id, v_ystart, v_yend) b;

    v_total := v_total + v_year_dep;
    v_year := v_year + 1;
  end loop;

  return v_total;
end;
$fn$;

comment on function app_private.cumulative_tax_depreciation(uuid, date) is
  'Sums get_tax_depreciation_blocks.depreciation_for_year one whole 1 Apr-31 Mar year at a time from the earliest fixed asset through p_fy_end (which must itself be 31 March). Never call get_tax_depreciation_blocks with a multi-year span directly — its half-year rule and one-shot rate application are only correct for a single financial year. See 0091.';

-- ----------------------------------------------------------------------------
-- Seed the two ledgers this posts to, the first time either is needed.
-- ----------------------------------------------------------------------------
create or replace function app_private.ensure_deferred_tax_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_expense_group uuid;
  v_dtl_group uuid;
begin
  select id into v_expense_group
    from public.account_groups
   where company_id = p_company_id and parent_group_id is null and name = 'Indirect Expenses'
   limit 1;

  -- By NATURE, never by name — see the migration header for the duplicate
  -- same-named group this dodges.
  select id into v_dtl_group
    from public.account_groups
   where company_id = p_company_id and nature = 'deferred_tax'
   limit 1;

  if v_expense_group is null or v_dtl_group is null then
    raise exception 'Chart of accounts is missing the Indirect Expenses or Deferred Tax Liabilities (Net) group; seed it first';
  end if;

  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_expense_group and name = 'Deferred Tax Expense'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_expense_group, 'Deferred Tax Expense', 'debit', 0);
  end if;

  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_dtl_group and name = 'Deferred Tax Liabilities (Net)'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_dtl_group, 'Deferred Tax Liabilities (Net)', 'credit', 0);
  end if;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- The reconciliation itself: book vs tax depreciation, the rate, the target
-- balance, what is already posted, and the movement.
-- ----------------------------------------------------------------------------
create or replace function public.get_deferred_tax_reconciliation(
  p_company_id uuid,
  p_fy_end date
)
returns table (
  entity_type text,
  applicable boolean,
  fy_start date,
  fy_end date,
  cumulative_tax_depreciation numeric,
  cumulative_book_depreciation numeric,
  cumulative_timing_difference numeric,
  effective_tax_rate numeric,
  target_deferred_tax_liability numeric,
  ledger_carried numeric,
  movement_to_post numeric,
  note text
)
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_fy_start date;
  v_entity_type text;
  v_applicable boolean;
  v_taxable numeric;
  v_total_tax numeric;
  v_rate numeric := 0;
  v_cum_tax_dep numeric;
  v_cum_book_dep numeric;
  v_diff numeric;
  v_target numeric;
  v_carried numeric := 0;
  v_dtl_ledger uuid;
  v_note text := '';
begin
  if extract(month from p_fy_end) <> 3 or extract(day from p_fy_end) <> 31 then
    raise exception
      'Deferred tax is reconciled only as at a financial year end (31 March) — % is not one.',
      p_fy_end;
  end if;
  v_fy_start := make_date(extract(year from p_fy_end)::int - 1, 4, 1);

  select t.entity_type, t.applicable, t.taxable_income, t.total_tax
    into v_entity_type, v_applicable, v_taxable, v_total_tax
    from public.get_income_tax_computation(p_company_id, v_fy_start, p_fy_end) t;

  entity_type := v_entity_type;
  fy_start := v_fy_start;
  fy_end := p_fy_end;

  if not coalesce(v_applicable, false) then
    applicable := false;
    note := 'Not computed — get_income_tax_computation does not derive a tax rate for this entity type or period, so no rate exists to apply to the depreciation timing difference.';
    return next;
    return;
  end if;

  v_cum_tax_dep := app_private.cumulative_tax_depreciation(p_company_id, p_fy_end);

  select coalesce(sum(e.debit_amount - e.credit_amount), 0) into v_cum_book_dep
    from public.ledgers l
    join public.voucher_entries e on e.ledger_id = l.id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where l.company_id = p_company_id
     and l.name = 'Depreciation'
     and v.voucher_date <= p_fy_end;

  v_diff := v_cum_tax_dep - v_cum_book_dep;

  if v_taxable > 0 then
    v_rate := round(v_total_tax / v_taxable * 100, 4);
  else
    v_rate := 0;
    v_note := 'Taxable income for FY ' || to_char(v_fy_start, 'YYYY') || '-' || to_char(p_fy_end, 'YY')
      || ' is nil or negative, so no rate can be derived from total tax / taxable income. Using 0% rather than guessing — no deferred tax is recognised for this year''s movement until there is taxable income to rate it against.';
  end if;

  v_target := round(v_diff * v_rate / 100, 2);

  select l.id into v_dtl_ledger
    from public.account_groups g
    join public.ledgers l on l.group_id = g.id
   where g.company_id = p_company_id and g.nature = 'deferred_tax' and l.name = 'Deferred Tax Liabilities (Net)'
   limit 1;

  if v_dtl_ledger is not null then
    -- Credit-normal ledger; negate the same way 0077 negates Accumulated
    -- Depreciation, so a positive number here always means "net liability".
    v_carried := -app_private.ledger_opening_signed(p_company_id, v_dtl_ledger, p_fy_end + 1, null);
  end if;

  applicable := true;
  cumulative_tax_depreciation := round(v_cum_tax_dep, 2);
  cumulative_book_depreciation := round(v_cum_book_dep, 2);
  cumulative_timing_difference := round(v_diff, 2);
  effective_tax_rate := v_rate;
  target_deferred_tax_liability := v_target;
  ledger_carried := round(v_carried, 2);
  movement_to_post := round(v_target - v_carried, 2);

  if v_diff > 0 then
    v_note := v_note || ' Tax depreciation claimed to date exceeds book depreciation posted to date — more has been deducted for tax than in the books, so tax is being deferred to later: a deferred tax LIABILITY.';
  elsif v_diff < 0 then
    v_note := v_note || ' Book depreciation posted to date exceeds tax depreciation claimed to date — less has been deducted for tax than in the books, so more tax is being paid now than book profit alone would suggest: a deferred tax ASSET, carried as a debit in the same "(Net)" ledger.';
  end if;

  note := trim(v_note);
  return next;
end;
$fn$;

revoke all on function public.get_deferred_tax_reconciliation(uuid, date) from public, anon;
grant execute on function public.get_deferred_tax_reconciliation(uuid, date) to authenticated;

comment on function public.get_deferred_tax_reconciliation(uuid, date) is
  'Cumulative tax depreciation vs cumulative POSTED book depreciation, times the current financial year''s own effective tax rate from get_income_tax_computation (AS 22 / Ind AS 12 converge on the balance-sheet-date enacted rate for Indian entities — see 0091), against what the Deferred Tax Liabilities (Net) ledger already carries. p_fy_end must be 31 March of some year.';

-- ----------------------------------------------------------------------------
-- Post the movement
-- ----------------------------------------------------------------------------
create or replace function public.post_deferred_tax(
  p_company_id uuid,
  p_branch_id uuid,
  p_fy_end date,
  p_narration text default null
)
returns uuid
language plpgsql
set search_path to ''
as $fn$
declare
  v_expense_group uuid;
  v_dtl_group uuid;
  v_expense_ledger uuid;
  v_dtl_ledger uuid;
  v_recon record;
  v_delta numeric;
  v_lines jsonb;
  v_voucher_id uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to post for this company';
  end if;

  select * into v_recon from public.get_deferred_tax_reconciliation(p_company_id, p_fy_end);

  if v_recon is null or not coalesce(v_recon.applicable, false) then
    raise exception
      'Deferred tax cannot be computed for this company and period — %',
      coalesce(v_recon.note, 'no applicable tax computation.');
  end if;

  v_delta := v_recon.movement_to_post;

  if v_delta = 0 then
    raise exception
      'The Deferred Tax Liabilities (Net) ledger already stands at % as at % — there is no movement to post.',
      round(v_recon.target_deferred_tax_liability, 2), p_fy_end;
  end if;

  perform app_private.ensure_deferred_tax_ledgers(p_company_id);

  select id into v_expense_group from public.account_groups
   where company_id = p_company_id and parent_group_id is null and name = 'Indirect Expenses' limit 1;
  select id into v_dtl_group from public.account_groups
   where company_id = p_company_id and nature = 'deferred_tax' limit 1;

  select id into v_expense_ledger from public.ledgers
   where company_id = p_company_id and group_id = v_expense_group and name = 'Deferred Tax Expense' limit 1;
  select id into v_dtl_ledger from public.ledgers
   where company_id = p_company_id and group_id = v_dtl_group and name = 'Deferred Tax Liabilities (Net)' limit 1;

  if v_delta > 0 then
    -- The net liability is growing (or the net asset shrinking): a charge.
    v_lines := jsonb_build_array(
      jsonb_build_object('ledger_id', v_expense_ledger, 'debit_amount',  v_delta),
      jsonb_build_object('ledger_id', v_dtl_ledger,     'credit_amount', v_delta)
    );
  else
    -- The net liability is shrinking (or the net asset growing): a credit.
    v_lines := jsonb_build_array(
      jsonb_build_object('ledger_id', v_dtl_ledger,     'debit_amount',  -v_delta),
      jsonb_build_object('ledger_id', v_expense_ledger, 'credit_amount', -v_delta)
    );
  end if;

  v_voucher_id := public.create_voucher(
    p_company_id := p_company_id,
    p_branch_id := p_branch_id,
    p_voucher_type := 'journal',
    p_voucher_date := p_fy_end,
    p_lines := v_lines,
    p_narration := coalesce(
      p_narration,
      'Deferred tax (AS 22 / Ind AS 12) for FY ending ' || to_char(p_fy_end, 'DD Mon YYYY')
        || ' — cumulative timing difference ' || round(v_recon.cumulative_timing_difference, 2)
        || ' at ' || v_recon.effective_tax_rate || '%'
    )
  );

  return v_voucher_id;
end;
$fn$;

revoke all on function public.post_deferred_tax(uuid, uuid, date, text) from public, anon;
grant execute on function public.post_deferred_tax(uuid, uuid, date, text) to authenticated;

comment on function public.post_deferred_tax(uuid, uuid, date, text) is
  'Posts the movement in AS 22 / Ind AS 12 deferred tax since the ledger was last updated: Dr Deferred Tax Expense / Cr Deferred Tax Liabilities (Net) when the timing difference times the current rate has grown, reversed when it has shrunk (which includes crossing into a net deferred tax ASSET — the same "(Net)" ledger then carries a debit). Depreciation-driven timing differences only; see 0091.';
