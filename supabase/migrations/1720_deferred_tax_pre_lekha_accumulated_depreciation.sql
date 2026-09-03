-- get_deferred_tax_reconciliation could never see depreciation from before a
-- company started using LEKHA.
--
-- WHAT WAS WRONG. cumulative_book_depreciation summed public.voucher_entries
-- on the depreciation-EXPENSE ledger (role 'depreciation_amortisation') only.
-- That ledger is created by app_private.ensure_depreciation_ledgers with
-- opening_balance_amount hard-coded to 0 — correct for a nominal P&L ledger,
-- which never legitimately carries a cross-year opening balance of its own.
-- But the ordinary case for a real business adopting LEKHA mid-life is that
-- its fixed assets were already in use, and already depreciated for years,
-- before book_beginning_date. That real, pre-LEKHA history has nowhere else
-- to live except as an OPENING BALANCE on Accumulated Depreciation (the
-- contra-asset, role 'accumulated_depreciation') — see 0077's own comment:
-- "Accumulated Depreciation ... normally carries a CREDIT balance", set at
-- ledger creation/import time, not posted through a voucher. Summing only
-- voucher_entries never sees that opening balance, so cumulative_book_
-- depreciation was short by exactly it, forever, for the life of the asset.
--
-- Confirmed live before writing this fix (TEST Vantage Consulting Services,
-- ledger Accumulated Depreciation, company 9e4071b8-dfec-4d4c-86f6-
-- bb9fab84e600): opening_balance_amount 4,93,377.05 credit, against a
-- Depreciation (expense) ledger opening_balance_amount of 0.00. The old query
-- returned cumulative_book_depreciation = 95,572.60 (this FY's posted charge
-- only) and cumulative_timing_difference = 5,00,011.40. The true cumulative
-- book depreciation — what has actually reduced this asset's book value over
-- its whole life — is 5,88,949.65 (4,93,377.05 pre-LEKHA + 95,572.60 posted
-- this FY). Invisible today only because get_income_tax_computation returns
-- rate 0 for a loss-making year (0091's own documented behaviour); the same
-- gap silently OVERSTATES Deferred Tax Liabilities (Net) — understates a net
-- deferred tax ASSET, or fabricates a bigger net LIABILITY, depending on
-- which side of zero the true difference sits — the moment such a company
-- turns a profit and a nonzero rate gets applied to a permanently-wrong base.
--
-- WHICH BASE IS RIGHT, thought through rather than assumed. Two candidates:
--
--   (a) The depreciation EXPENSE ledger's own opening_balance_amount, added
--       to entries since. Rejected: that ledger's opening is always 0 by
--       construction (see ensure_depreciation_ledgers, 0077) — nothing has
--       ever set it to anything else, so this "fix" would be a no-op on
--       every company that exhibits the bug, including the one above.
--       It is also the wrong figure even if someone HAD set it: a nominal
--       P&L ledger's opening balance conventionally represents unposted
--       current-year movement, not a multi-year cumulative stock figure.
--
--   (b) The Accumulated Depreciation ledger's own LIFE-TO-DATE balance —
--       opening_balance_amount plus everything posted against it since,
--       read with app_private.ledger_opening_signed exactly the way
--       post_depreciation (0077) already reads it to decide what to post
--       next, and exactly the way this same function already reads the
--       Deferred Tax Liabilities (Net) ledger a few lines below. This is
--       the RIGHT base: AS 22 (ICAI, "Accounting for Taxes on Income") and
--       Ind AS 12 both define the depreciation timing difference as the
--       cumulative difference between the tax WDV and the BOOK carrying
--       amount over the asset's whole life — not over however much of
--       that life happened to be journaled inside this particular
--       software. Accumulated Depreciation IS the ledger Schedule III
--       presents against Gross Block to reach Net Block; it is definitionally
--       the life-to-date book depreciation figure, pre-LEKHA history and
--       all. cumulative_tax_depreciation is already computed this way on
--       the tax side — app_private.cumulative_tax_depreciation loops from
--       min(fixed_assets.put_to_use_date), the asset's real acquisition,
--       not from book_beginning_date — so (b) is also the only base that
--       makes the two sides of the timing-difference subtraction comparable
--       on the same footing (whole asset life vs whole asset life), which
--       (a) could never be even if it were populated.
--
-- (b) implemented below, verified against the two live cases:
--
--   Vantage (opening 4,93,377.05, this FY's charge 95,572.60):
--     old cumulative_book_depreciation 95,572.60 -> new 5,88,949.65
--     old cumulative_timing_difference 5,00,011.40 -> new 6,634.35
--
--   CONTROL — TEST Rangoli Spice Works Pvt Ltd (8e161d8e-cd2e-4c60-96a4-
--   bad69c42b573), whose Accumulated Depreciation opening_balance_amount is
--   0.00 (every asset put to use after book_beginning_date, so a zero
--   opening is genuinely correct, not merely unset): cumulative_book_
--   depreciation is 63,030.55 both before and after this migration — adding
--   a zero opening changes nothing, so the fix does not double-count for a
--   company that never had pre-LEKHA depreciation to miss in the first
--   place.
--
-- Bound by ROLE, not by the ledger's English name — the same reasoning 1200
-- and 1210 already established for every other close/reconciliation posting
-- in this codebase, and the same resolver (app_private.ledger_for_role) this
-- function already calls two lines below for 'depreciation_amortisation'.
--
-- Rewritten off the live function body so the surrounding arithmetic (already
-- pilot-verified to the paisa by 0091, and untouched by 1210's rename) is not
-- disturbed; asserts the predicate actually moved before executing.

do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_deferred_tax_reconciliation' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1720: get_deferred_tax_reconciliation is missing.';
  end if;

  v_before := v_def;

  -- 1. Declare the new local.
  v_def := replace(
    v_def,
    E'  v_cum_book_dep numeric;\n  v_diff numeric;',
    E'  v_cum_book_dep numeric;\n  v_accum_ledger uuid;\n  v_diff numeric;'
  );

  if v_def = v_before then
    raise exception '1720: declare block for v_cum_book_dep/v_diff not found as expected; body has moved. Fix by hand.';
  end if;

  -- 2. Base cumulative_book_depreciation on Accumulated Depreciation's
  --    life-to-date balance, not on the expense ledger's own postings.
  v_def := replace(
    v_def,
    E'  select coalesce(sum(e.debit_amount - e.credit_amount), 0) into v_cum_book_dep\n'
    || E'    from public.ledgers l\n'
    || E'    join public.voucher_entries e on e.ledger_id = l.id\n'
    || E'    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted\n'
    || E'   where l.company_id = p_company_id\n'
    || E'     and l.id = app_private.ledger_for_role(p_company_id, ''depreciation_amortisation'')\n'
    || E'     and v.voucher_date <= p_fy_end;',
    E'  v_accum_ledger := app_private.ledger_for_role(p_company_id, ''accumulated_depreciation'');\n\n'
    || E'  if v_accum_ledger is null then\n'
    || E'    v_cum_book_dep := 0;\n'
    || E'  else\n'
    || E'    -- Credit-normal contra-asset; negate the same way post_depreciation (0077)\n'
    || E'    -- and the Deferred Tax Liabilities (Net) ledger below negate it, so a\n'
    || E'    -- positive number here always means depreciation actually taken against\n'
    || E'    -- the asset''s book value, life-to-date — including whatever pre-LEKHA\n'
    || E'    -- history is carried as this ledger''s own opening balance. See 1720.\n'
    || E'    v_cum_book_dep := -app_private.ledger_opening_signed(p_company_id, v_accum_ledger, p_fy_end + 1, null);\n'
    || E'  end if;'
  );

  if v_def = v_before then
    raise exception '1720: cumulative_book_depreciation select not found as expected; body has moved. Fix by hand.';
  end if;

  if v_def ~ 'ledger_for_role\(p_company_id, ''depreciation_amortisation''\)' then
    raise exception '1720: cumulative_book_depreciation still reads the expense ledger''s own postings after rewrite. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

revoke all on function public.get_deferred_tax_reconciliation(uuid, date) from public, anon;
grant execute on function public.get_deferred_tax_reconciliation(uuid, date) to authenticated;

comment on function public.get_deferred_tax_reconciliation(uuid, date) is
  'Cumulative tax depreciation (life-to-date, from each asset''s own put_to_use_date) vs cumulative BOOK depreciation (life-to-date, read off Accumulated Depreciation''s own opening balance plus everything posted since — not merely what has been journaled inside LEKHA, see 1720), times the current financial year''s own effective tax rate from get_income_tax_computation (AS 22 / Ind AS 12 converge on the balance-sheet-date enacted rate for Indian entities — see 0091), against what the Deferred Tax Liabilities (Net) ledger already carries. p_fy_end must be 31 March of some year.';
