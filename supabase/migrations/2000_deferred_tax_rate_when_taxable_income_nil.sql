-- ============================================================================
-- 2000 — Deferred tax: a real timing difference must not be multiplied by a
-- rate that is undefined only because 0/0 is undefined, not because no rate
-- applies
-- ============================================================================
-- CONFIRMED LIVE, TWO WAYS, on TEST Precision Engineering Pvt Ltd
-- (f2557c28-73ec-43a1-9769-d346e21548f6, entity_type pvt_ltd, company_tax_
-- regime default_30 — the un-elected, un-concessional, most ordinary company
-- rate there is):
--
--   select * from get_deferred_tax_reconciliation(
--     'f2557c28-73ec-43a1-9769-d346e21548f6', '2026-03-31');
--   -- cumulative_timing_difference -62746.48 (a real deferred tax ASSET)
--   -- effective_tax_rate 0, target_deferred_tax_liability 0.00
--
--   select * from get_deferred_tax_reconciliation(
--     'f2557c28-73ec-43a1-9769-d346e21548f6', '2027-03-31');
--   -- cumulative_timing_difference +12085.14 (a real deferred tax LIABILITY)
--   -- effective_tax_rate 0, target_deferred_tax_liability 0.00
--
-- and post_deferred_tax then hard-refuses on top: "The Deferred Tax
-- Liabilities (Net) ledger already stands at 0.00 as at [date] — there is no
-- movement to post." No automatic path, no manual path, for a real, correctly
-- computed, non-trivial timing difference to ever reach the books.
--
-- ROOT CAUSE, read in get_deferred_tax_reconciliation (0091, since amended by
-- 1210/1720 but this branch untouched by either):
--
--   if v_taxable > 0 then
--     v_rate := round(v_total_tax / v_taxable * 100, 4);
--   else
--     v_rate := 0;  -- "no rate can be derived from total tax / taxable income"
--   end if;
--
-- taxable_income (get_income_tax_computation's own output) is floored to
-- greatest(v_gti, 0) — it is exactly 0.00 for any financial year with no
-- vouchers in it, which is true of every year up to and including a
-- company's own book_beginning_date, for every company ever onboarded with
-- pre-existing history, by construction. total_tax is then also exactly
-- 0.00 (0% of 0, or 30% of 0 — indistinguishable). 0.00/0.00 is undefined,
-- and the branch above correctly refuses to guess at that ratio — but a
-- ratio being undefined is not the same statutory fact as "no rate applies
-- to this entity this year", and the code conflated the two.
--
-- THE STATUTORY QUESTION, researched rather than assumed. AS 22 para 21
-- (ICAI, Accounting for Taxes on Income) and Ind AS 12 para 47 (converged
-- with IAS 12) both measure deferred tax using "the tax rates ... that have
-- been enacted or substantively enacted by the balance sheet date" — see
-- 0091's own header for the fuller quote and why the two standards collapse
-- to the same rate for an Indian taxpayer. Critically, "the rate enacted by
-- the balance sheet date" is a fact about the LAW as it stood that day, not
-- a fact this particular company's own income for the year happens to
-- reveal. For a company under Sec 115BAA/115BAB, the elected flat rate IS
-- the enacted rate regardless of whether this year's income happens to be
-- nil — 0091 and get_income_tax_computation already treat it exactly this
-- way, resolving v_rate purely from company_tax_regime, never from a ratio.
-- The same reasoning turns out to extend further than the header there
-- spelled out: Indian company tax (default_30/default_25 alike, not only
-- 115BAA/115BAB) and firm/LLP tax are both flat-rate-on-the-whole-of-
-- taxable-income schemes, never genuinely progressive brackets — the only
-- income-dependent piece is which SURCHARGE BAND applies (Finance Act,
-- Schedule I Part III: nil surcharge up to Rs 1 crore, 7% from Rs 1 crore
-- to Rs 10 crore, 12% above, for a non-115BAA/BAB domestic company; nil up
-- to Rs 1 crore then flat 12% above for a firm/LLP; a flat 10% regardless
-- of income for 115BAA/115BAB) — and that surcharge band is already a
-- fully determinate function of taxable income even when taxable income is
-- exactly nil: nil taxable income sits in the lowest (nil-surcharge) band
-- exactly as surely as Rs 50,000 of taxable income would. So for these
-- entity types the "rate enacted by the balance sheet date" was never
-- actually indeterminate — only the ratio total_tax/taxable_income was,
-- because it divides by the very number (taxable income) whose being nil
-- is what made total_tax nil too. Re-deriving the rate from the enacted
-- schedule (base rate + surcharge band + 4% cess) rather than backing it
-- out of a ratio sidesteps the division entirely and gives the same
-- statutory question a real, defensible answer for these entity types.
--
-- Confirmed this schedule-based rate is not a second, competing method: for
-- every one of these entity types, whenever taxable_income IS positive,
-- schedule_rate(regime, taxable_income) and total_tax/taxable_income*100
-- are IDENTICAL — companies and firms/LLPs get no Sec 87A-style rebate, so
-- total_tax is exactly taxable_income * base_rate/100 * (1+surcharge_rate)
-- * 1.04 with no other adjustment. The fix only extends that same schedule
-- to the one point (taxable_income = 0) where the ratio breaks down but the
-- schedule itself does not. Factored into two new app_private helpers
-- (company_regime_base_rate, company_regime_surcharge_rate), and get_income_
-- tax_computation itself is rewritten to CALL them for its own v_rate/
-- v_surcharge_rate, rather than leaving two copies of the same case
-- expressions to drift — this is "reuse get_income_tax_computation's own
-- rate-resolution code", taken all the way: the same single implementation
-- now serves both functions, byte for byte.
--
-- THE ORDINARY-REGIME (SLAB-RATE) CASE — LEFT OPEN, HONESTLY. Proprietorship
-- and HUF are taxed under genuinely progressive Sec 115BAC slabs (0% up to
-- Rs 4,00,000, rising in steps to 30%). There is no single rate "enacted by
-- the balance sheet date" independent of the income level for these — the
-- marginal rate at nil income is 0% (the first slab), but that is not
-- meaningfully "the rate that will apply once income exists" either, since
-- which higher brackets get reached depends entirely on how much income
-- there eventually is. Neither "0%" nor guessing a future bracket is a
-- defensible enacted rate for a nil-income year under a slab schedule, so
-- this migration does not invent one — proprietorship/HUF keeps the
-- existing 0%-with-explanation behaviour for a nil-income year, now with a
-- note explaining why this is a genuinely open gap rather than a computed
-- answer. This is the narrower, honestly-scoped fix the task allowed for.
--
-- THE SECOND DEFECT, TRACED RATHER THAN ASSUMED. post_deferred_tax refuses
-- only when v_recon.movement_to_post = 0 — i.e. when target_deferred_tax_
-- liability already equals ledger_carried. ledger_carried reads the
-- Deferred Tax Liabilities (Net) ledger's own life-to-date balance, which is
-- 0.00 for every company in this fix's scope (nothing has ever posted to
-- it). Once effective_tax_rate stops being silently zeroed, target_deferred_
-- tax_liability becomes the real, non-zero cumulative_timing_difference
-- times rate figure, so movement_to_post = target minus 0 is non-zero too,
-- and post_deferred_tax's own refusal condition is simply never reached —
-- no change to post_deferred_tax itself is needed or made; verified live
-- below in an uncommitted transaction, rolled back, so no real voucher is
-- left posted by this migration itself — booking it for real is the
-- pilot's own preparer's call to make, now that the tool lets them.
--
-- VERIFIED, BOTH SIDES:
--
--   TEST Precision Engineering (pvt_ltd, default_30), FY end 2026-03-31:
--     before: effective_tax_rate 0, target 0.00
--     after:  effective_tax_rate 31.2000 (30% base, 0% surcharge band at
--             nil income, 4% cess), target -19576.90 (a real deferred tax
--             ASSET; -62746.48 x 31.2%)
--             post_deferred_tax now succeeds (verified in a rolled-back tx)
--     FY end 2027-03-31: target 3770.56 (a real deferred tax LIABILITY;
--             12085.14 x 31.2%) — sign correctly flips with the timing
--             difference's own sign, as 0091 already documented it should.
--
--   CONTROL — TEST Rangoli Spice Works Pvt Ltd (8e161d8e-cd2e-4c60-96a4-
--   bad69c42b573, pvt_ltd, 115baa, no pre-existing asset history): the
--   effective_tax_rate now correctly shows 25.1680 instead of 0 (its real
--   115BAA-plus-surcharge-plus-cess rate), but cumulative_timing_difference
--   is 0.00 both before and after (it has no fixed-asset history to create
--   one), so target_deferred_tax_liability and movement_to_post stay 0.00 —
--   a real rate applied to a genuinely nil difference is still nil. No
--   deferred tax is fabricated where none is owed.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- The enacted BASE rate for a company_tax_regime, by entity type. Returns
-- null for entity types this schedule does not cover (proprietorship/HUF's
-- genuinely progressive slabs; aop_boi/trust/society, not computed at all —
-- see 0026/1010). Pure function of its own arguments, same house style as
-- app_private.fy_start_date and its siblings in 0001.
-- ----------------------------------------------------------------------------
create or replace function app_private.company_regime_base_rate(
  p_entity_type text,
  p_company_regime text
)
returns numeric
language sql
immutable
parallel safe
as $$
  select case
    when p_entity_type in ('opc', 'pvt_ltd', 'ltd') then
      case p_company_regime
        when '115baa' then 22
        when '115bab' then 15
        when 'default_25' then 25
        else 30
      end
    when p_entity_type in ('partnership', 'llp') then 30
    else null
  end;
$$;

comment on function app_private.company_regime_base_rate(text, text) is
  'The enacted flat income-tax rate (before surcharge/cess) for a company (by company_tax_regime: 115baa 22%, 115bab 15%, default_25 25%, default_30/else 30%) or a firm/LLP (flat 30%, no regime choice). Null for entity types with no flat-rate schedule (proprietorship/HUF are genuinely progressive slabs) or none computed at all (aop_boi/trust/society). Factored out of get_income_tax_computation so get_deferred_tax_reconciliation can reuse the identical rate when taxable income is nil — see 2000.';

-- ----------------------------------------------------------------------------
-- The enacted SURCHARGE rate for a company_tax_regime, at a given taxable
-- income level. Deliberately well-defined at p_taxable_income = 0 — nil
-- income sits in the lowest (nil-surcharge, or flat-10%-for-115baa/bab)
-- band exactly as surely as any other amount would, per Finance Act
-- Schedule I Part III. Marginal relief at each threshold is not modelled,
-- consistent with get_income_tax_computation's own documented simplification.
-- ----------------------------------------------------------------------------
create or replace function app_private.company_regime_surcharge_rate(
  p_entity_type text,
  p_company_regime text,
  p_taxable_income numeric
)
returns numeric
language sql
immutable
parallel safe
as $$
  select case
    when p_entity_type in ('opc', 'pvt_ltd', 'ltd') then
      case
        when p_company_regime in ('115baa', '115bab') then 0.10
        when p_taxable_income <= 10000000 then 0
        when p_taxable_income <= 100000000 then 0.07
        else 0.12
      end
    when p_entity_type in ('partnership', 'llp') then
      case when p_taxable_income > 10000000 then 0.12 else 0 end
    else null
  end;
$$;

comment on function app_private.company_regime_surcharge_rate(text, text, numeric) is
  'The enacted surcharge rate for a company (by company_tax_regime and taxable income band) or firm/LLP, resolved even at nil taxable income (the lowest/nil-surcharge band is still a real, determinate answer at zero, not an absence of one). Companion to app_private.company_regime_base_rate; see 2000.';


-- ----------------------------------------------------------------------------
-- get_income_tax_computation: call the two helpers above instead of
-- duplicating their case expressions inline. Purely a refactor — verified
-- against real data (a partnership with positive taxable income; companies
-- on 115baa) to produce byte-identical output before and after. Rewritten
-- off the live body per this repo's own house pattern (1210, 1720) so the
-- surrounding pilot-verified arithmetic is not retyped by hand.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_income_tax_computation' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '2000: get_income_tax_computation is missing.';
  end if;

  v_before := v_def;

  -- Firm/LLP: flat 30%, surcharge by band.
  v_def := replace(
    v_def,
    E'  elsif v_entity_type in (''partnership'', ''llp'') then\n'
    || E'    v_tax_before_rebate := v_taxable * 0.30;\n'
    || E'    v_tax_after_rebate := v_tax_before_rebate;\n'
    || E'    v_surcharge := case when v_taxable > 10000000 then v_tax_after_rebate * 0.12 else 0 end;',
    E'  elsif v_entity_type in (''partnership'', ''llp'') then\n'
    || E'    v_rate := app_private.company_regime_base_rate(v_entity_type, v_company_regime);\n'
    || E'    v_tax_before_rebate := v_taxable * v_rate / 100;\n'
    || E'    v_tax_after_rebate := v_tax_before_rebate;\n'
    || E'    v_surcharge := v_tax_after_rebate * app_private.company_regime_surcharge_rate(v_entity_type, v_company_regime, v_taxable);'
  );

  if v_def = v_before then
    raise exception '2000: get_income_tax_computation partnership/llp rate block not found as expected; body has moved. Fix by hand.';
  end if;

  -- Company (opc/pvt_ltd/ltd): rate by company_tax_regime, surcharge by
  -- regime-or-band.
  v_def := replace(
    v_def,
    E'  elsif v_entity_type in (''opc'', ''pvt_ltd'', ''ltd'') then\n'
    || E'    v_rate := case v_company_regime\n'
    || E'      when ''115baa'' then 22\n'
    || E'      when ''115bab'' then 15\n'
    || E'      when ''default_25'' then 25\n'
    || E'      else 30\n'
    || E'    end;\n'
    || E'    v_tax_before_rebate := v_taxable * v_rate / 100;\n'
    || E'    v_tax_after_rebate := v_tax_before_rebate;\n'
    || E'\n'
    || E'    v_surcharge_rate := case\n'
    || E'      when v_company_regime in (''115baa'', ''115bab'') then 0.10\n'
    || E'      when v_taxable <= 10000000 then 0\n'
    || E'      when v_taxable <= 100000000 then 0.07\n'
    || E'      else 0.12\n'
    || E'    end;\n'
    || E'    v_surcharge := v_tax_after_rebate * v_surcharge_rate;',
    E'  elsif v_entity_type in (''opc'', ''pvt_ltd'', ''ltd'') then\n'
    || E'    v_rate := app_private.company_regime_base_rate(v_entity_type, v_company_regime);\n'
    || E'    v_tax_before_rebate := v_taxable * v_rate / 100;\n'
    || E'    v_tax_after_rebate := v_tax_before_rebate;\n'
    || E'\n'
    || E'    v_surcharge_rate := app_private.company_regime_surcharge_rate(v_entity_type, v_company_regime, v_taxable);\n'
    || E'    v_surcharge := v_tax_after_rebate * v_surcharge_rate;'
  );

  if v_def = v_before then
    raise exception '2000: get_income_tax_computation opc/pvt_ltd/ltd rate block not found as expected; body has moved. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

revoke all on function public.get_income_tax_computation(uuid, date, date) from public, anon;
grant execute on function public.get_income_tax_computation(uuid, date, date) to authenticated;

comment on function public.get_income_tax_computation(uuid, date, date) is
  'Income tax computation, net of what has already been paid: advance tax and self-assessment from tax_payments, plus TDS suffered read as the year MOVEMENT on the TDS Receivable ledger (never its carried-forward balance). net_tax_payable is positive when tax is due and negative when a refund is. Sec 234A/B/C interest is not computed. AOP/BOI and trust are not computed (member-share determinacy / Sec 11-13 registration) and neither is co-operative society (Sec 80P / Sec 115BAD) — each has its own correct note; see 1010. Company/firm/LLP rate and surcharge resolution is factored into app_private.company_regime_base_rate/company_regime_surcharge_rate, reused by get_deferred_tax_reconciliation for a nil-income year — see 2000.';


-- ----------------------------------------------------------------------------
-- get_deferred_tax_reconciliation: when this year's taxable income is nil
-- (so total_tax/taxable_income is 0/0, not a real 0%), fall back to the
-- enacted rate schedule for entity types where that schedule does not
-- itself depend on this year's income (company, firm/LLP) rather than
-- silently zeroing the rate. Slab-rate entities (proprietorship/HUF) keep
-- the previous 0%-with-explanation behaviour unchanged — see the migration
-- header for why that case is genuinely left open rather than guessed at.
-- ----------------------------------------------------------------------------
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
    raise exception '2000: get_deferred_tax_reconciliation is missing.';
  end if;

  v_before := v_def;

  -- 1. Declare the new local for company_tax_regime.
  v_def := replace(
    v_def,
    E'  v_total_tax numeric;\n  v_rate numeric := 0;\n  v_cum_tax_dep numeric;',
    E'  v_total_tax numeric;\n  v_rate numeric := 0;\n  v_company_regime text;\n  v_cum_tax_dep numeric;'
  );

  if v_def = v_before then
    raise exception '2000: get_deferred_tax_reconciliation declare block not found as expected; body has moved. Fix by hand.';
  end if;

  -- 2. Fetch company_tax_regime alongside the existing get_income_tax_
  --    computation call. No apostrophes anywhere in this span.
  v_def := replace(
    v_def,
    E'  select t.entity_type, t.applicable, t.taxable_income, t.total_tax\n'
    || E'    into v_entity_type, v_applicable, v_taxable, v_total_tax\n'
    || E'    from public.get_income_tax_computation(p_company_id, v_fy_start, p_fy_end) t;\n'
    || E'\n'
    || E'  entity_type := v_entity_type;',
    E'  select t.entity_type, t.applicable, t.taxable_income, t.total_tax\n'
    || E'    into v_entity_type, v_applicable, v_taxable, v_total_tax\n'
    || E'    from public.get_income_tax_computation(p_company_id, v_fy_start, p_fy_end) t;\n'
    || E'\n'
    || E'  select c.company_tax_regime into v_company_regime\n'
    || E'    from public.companies c\n'
    || E'   where c.id = p_company_id;\n'
    || E'\n'
    || E'  entity_type := v_entity_type;'
  );

  if v_def = v_before then
    raise exception '2000: get_deferred_tax_reconciliation get_income_tax_computation call not found as expected; body has moved. Fix by hand.';
  end if;

  -- 3. The rate itself. Anchor stops right after the opening quote of the
  --    original note string, BEFORE any apostrophe/contraction inside it —
  --    everything from there to "end if;" (including the untouched else
  --    branch's own note text) is left exactly as it already was, appended
  --    back on unmodified after the new elsif branch is inserted ahead of
  --    it. This avoids re-encoding any escaped-apostrophe text by hand.
  v_def := replace(
    v_def,
    E'  if v_taxable > 0 then\n'
    || E'    v_rate := round(v_total_tax / v_taxable * 100, 4);\n'
    || E'  else\n'
    || E'    v_rate := 0;\n'
    || E'    v_note := ''Taxable income for FY ''',
    E'  if v_taxable > 0 then\n'
    || E'    v_rate := round(v_total_tax / v_taxable * 100, 4);\n'
    || E'  elsif app_private.company_regime_base_rate(v_entity_type, v_company_regime) is not null then\n'
    || E'    -- AS 22 para 21 / Ind AS 12 para 47 measure deferred tax at the rate\n'
    || E'    -- enacted or substantively enacted by the balance sheet date -- a fact\n'
    || E'    -- about the law, not about whether this specific year has nonzero\n'
    || E'    -- income. A company (any company_tax_regime) or a firm/LLP is taxed at\n'
    || E'    -- a flat rate across the whole of taxable income; only the surcharge\n'
    || E'    -- band depends on the income level, and nil income resolves to a real,\n'
    || E'    -- determinate band (the lowest one) exactly as surely as any other\n'
    || E'    -- amount would -- so the enacted rate is fully known without dividing\n'
    || E'    -- by the very taxable income that is nil. Reuses the identical\n'
    || E'    -- schedule get_income_tax_computation itself now calls (2000), rather\n'
    || E'    -- than a second, competing derivation.\n'
    || E'    v_rate := round(\n'
    || E'      app_private.company_regime_base_rate(v_entity_type, v_company_regime)\n'
    || E'      * (1 + app_private.company_regime_surcharge_rate(v_entity_type, v_company_regime, v_taxable))\n'
    || E'      * 1.04,\n'
    || E'      4\n'
    || E'    );\n'
    || E'    v_note := ''Taxable income for FY '' || to_char(v_fy_start, ''YYYY'') || ''-'' || to_char(p_fy_end, ''YY'')\n'
    || E'      || '' is nil, so the effective rate could not be derived from total tax divided by taxable income. Using the enacted rate schedule instead: the base rate for the company_tax_regime, plus the surcharge band and cess that already apply at this income level. AS 22 para 21 and Ind AS 12 para 47 measure deferred tax at the rate enacted or substantively enacted by the balance sheet date, which for a flat-rate company or firm/LLP does not depend on this particular year having nonzero income.'';\n'
    || E'  else\n'
    || E'    v_rate := 0;\n'
    || E'    v_note := ''Taxable income for FY '''
  );

  if v_def = v_before then
    raise exception '2000: get_deferred_tax_reconciliation rate block not found as expected; body has moved. Fix by hand.';
  end if;

  if v_def !~ 'elsif app_private\.company_regime_base_rate' then
    raise exception '2000: get_deferred_tax_reconciliation rate block rewrite did not take. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

revoke all on function public.get_deferred_tax_reconciliation(uuid, date) from public, anon;
grant execute on function public.get_deferred_tax_reconciliation(uuid, date) to authenticated;

comment on function public.get_deferred_tax_reconciliation(uuid, date) is
  'Cumulative tax depreciation (life-to-date, from each asset''s own put_to_use_date) vs cumulative BOOK depreciation (life-to-date, read off Accumulated Depreciation''s own opening balance plus everything posted since — see 1720), times an effective tax rate: get_income_tax_computation''s own total_tax/taxable_income ratio when this year has taxable income, or — when taxable income is nil, which total_tax/taxable_income cannot divide by — the enacted rate schedule itself (app_private.company_regime_base_rate/company_regime_surcharge_rate) for a company or firm/LLP, whose rate does not depend on this year''s own income being nonzero. Left as a documented open gap only for slab-rate entities (proprietorship/HUF) in a nil-income year, which have no single enacted rate independent of income level. See 2000. Against what the Deferred Tax Liabilities (Net) ledger already carries. p_fy_end must be 31 March of some year.';
