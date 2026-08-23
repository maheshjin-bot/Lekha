-- ============================================================================
-- 0078 — Income tax: a destroyed loss, an ignored capital gain, and an
--        add-back of an expense that was never deducted
-- ============================================================================
-- Three defects in get_income_tax_computation, all in the few lines that build
-- taxable income. The function is rewritten (its return type gains columns, so
-- it has to be dropped and recreated — grants re-issued below).
--
-- (1) A LOSS WAS SILENTLY DESTROYED.
--
--     v_taxable := greatest(v_book_profit + v_book_dep + v_msme_addback
--                           - v_tax_dep, 0);
--
-- The clamp to zero is right for the tax CALCULATION -- you do not pay tax on
-- a negative figure -- but it was the only place the number existed, so a loss
-- vanished the moment it was computed. The report then showed "taxable income
-- 0" with nothing to say a loss had occurred at all, and no figure to carry
-- forward. Sec 72 allows a business loss to be carried forward eight
-- assessment years, and unabsorbed depreciation indefinitely under Sec 32(2);
-- in a recovering business that carry-forward is usually the largest single
-- item in the computation. Information was lost permanently every year that
-- passed, and the cost of reconstructing it only grows.
--
-- Business income is now computed UNCLAMPED and reported as its own column,
-- with the clamp applied only where tax rates are actually applied. The
-- amount available to carry forward is reported too.
--
-- STILL NOT DONE, deliberately: setting a brought-forward loss OFF against
-- this year's income. That needs a table of losses by assessment year and head
-- with how much of each has been absorbed, which does not exist. This
-- migration stops destroying the figure and puts it in front of the user; it
-- does not pretend to track it across years.
--
-- (2) SEC 50 CAPITAL GAINS WERE COMPUTED AND IGNORED.
--
-- get_tax_depreciation_blocks already returns short_term_capital_gain and
-- short_term_capital_loss per block (Sec 50: a gain when sale consideration
-- drives the block below zero, a loss when a block ceases with written-down
-- value still in it). The tax computation read only depreciation_for_year and
-- dropped both. The tax-depreciation report meanwhile TELLS the user a taxable
-- event occurred -- so the app said "you have a capital gain" on one screen
-- and omitted it from the tax on the next.
--
-- The two are NOT symmetrical, and treating them as one nettable number would
-- be wrong:
--   * Sec 50 SHORT-TERM CAPITAL GAIN is taxable and is added to total income.
--   * Sec 50 SHORT-TERM CAPITAL LOSS falls under "Capital Gains", and Sec 74
--     allows it to be set off ONLY against capital gains, carried forward
--     eight assessment years. It can NEVER reduce business income.
-- So the two are netted only WITHIN the capital gains head; a net capital loss
-- is reported for carry-forward and excluded from total income.
--
-- The reverse direction is allowed and falls out of the arithmetic: under
-- Sec 71 a business loss MAY be set off against capital gains (Sec 71(2A)
-- bars only salary). Adding a negative business income to a positive capital
-- gain does exactly that, with no special case.
--
-- (3) BOOK DEPRECIATION WAS ADDED BACK EVEN WHEN IT HAD NEVER BEEN DEDUCTED.
--
-- The computation starts from book profit (summed from the P&L ledgers), adds
-- back book depreciation, and deducts Income-tax Act depreciation instead.
-- That is the correct shape -- but the add-back used the FIXED ASSET
-- REGISTER's figure, while book profit came from what was actually POSTED.
-- Until 0077 nothing ever posted depreciation, so book profit contained none,
-- and the register's figure was added back to a profit it had never reduced.
--
-- Measured on live data, before and after, for one real proprietorship:
--                                   before          after
--     book profit               14,01,000.00   14,01,000.00  (no depreciation in it)
--     book dep added back           36,442.27           0.00  (nothing was posted)
--     tax dep deducted              24,000.00      24,000.00
--     taxable income            14,13,442.27   13,77,000.00
--     total tax                     95,696.99      90,012.00
-- Taxable income was overstated by 36,442.27 -- the whole of the phantom
-- add-back -- costing 5,684.99 of tax on income the business did not have.
-- (At this company's marginal slab band; a firm or company at 30% would pay
-- proportionately more on the same phantom figure.)
--
-- The add-back is now what is genuinely in the P&L for the year, so the
-- computation is self-consistent whether or not depreciation has been posted:
-- nothing posted means nothing to add back, and the Income-tax Act figure is
-- still the only depreciation allowed. The register's own figure is reported
-- alongside as book_depreciation_per_register so a divergence is visible
-- rather than silently absorbed -- if the two differ, the BOOKS are behind
-- (run Depreciation -> Post to books), not the tax computation.
--
-- Sec 40(b) ORDERING. The partnership/LLP remuneration ceiling is a function
-- of the firm's BOOK PROFIT, not of total income, so it is now computed before
-- capital gains are brought in rather than inside the rate branch after
-- everything has been mixed together. Same arithmetic, correct base.
-- ============================================================================

drop function if exists public.get_income_tax_computation(uuid, date, date);

create function public.get_income_tax_computation(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
)
returns table (
  entity_type text,
  applicable boolean,
  regime_used text,
  book_profit numeric,
  book_depreciation_addback numeric,
  book_depreciation_per_register numeric,
  msme_disallowance_addback numeric,
  tax_depreciation_deduction numeric,
  partner_remuneration_booked numeric,
  partner_remuneration_disallowed numeric,
  business_income numeric,
  short_term_capital_gain numeric,
  short_term_capital_loss numeric,
  gross_total_income numeric,
  business_loss_carried_forward numeric,
  capital_loss_carried_forward numeric,
  taxable_income numeric,
  tax_before_rebate numeric,
  rebate_87a numeric,
  tax_after_rebate numeric,
  surcharge numeric,
  cess numeric,
  total_tax numeric,
  note text
)
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_entity_type text;
  v_company_regime text;
  v_book_profit numeric := 0;
  v_book_dep_posted numeric := 0;
  v_book_dep_register numeric := 0;
  v_msme_addback numeric := 0;
  v_tax_dep numeric := 0;
  v_stcg numeric := 0;
  v_stcl numeric := 0;
  v_cg_net numeric := 0;
  v_remuneration_booked numeric := 0;
  v_remuneration_disallowed numeric := 0;
  v_remuneration_ceiling numeric;
  v_book_profit_before_remuneration numeric;
  v_business_income numeric := 0;
  v_gti numeric := 0;
  v_business_loss_cf numeric := 0;
  v_capital_loss_cf numeric := 0;
  v_taxable numeric := 0;
  v_tax_before_rebate numeric := 0;
  v_rebate numeric := 0;
  v_tax_after_rebate numeric := 0;
  v_surcharge numeric := 0;
  v_surcharge_rate numeric := 0;
  v_cess numeric := 0;
  v_total numeric := 0;
  v_rate numeric;
  v_dep_note text := '';
begin
  select c.entity_type, c.company_tax_regime into v_entity_type, v_company_regime
    from public.companies c
   where c.id = p_company_id;

  if v_entity_type is null then
    return;
  end if;

  if v_entity_type in ('aop_boi', 'trust', 'society') then
    entity_type := v_entity_type;
    applicable := false;
    note := 'Not computed. AOP/BOI and trust taxation depends on member-share determinacy and, for trusts, Sec 11-13 registration status — neither is tracked by this schema. Consult a tax professional for this entity type.';
    return next;
    return;
  end if;

  select coalesce(sum(e.credit_amount - e.debit_amount), 0) into v_book_profit
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    join public.voucher_entries e on e.ledger_id = l.id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where l.company_id = p_company_id
     and g.nature in ('direct_income', 'direct_expense', 'indirect_income', 'indirect_expense')
     and v.voucher_date between p_fy_start and p_fy_end;

  -- What actually reduced book profit this year. This is the figure to add
  -- back, because it is the one that was deducted — see the header.
  select coalesce(sum(e.debit_amount - e.credit_amount), 0) into v_book_dep_posted
    from public.ledgers l
    join public.voucher_entries e on e.ledger_id = l.id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where l.company_id = p_company_id
     and l.name = 'Depreciation'
     and v.voucher_date between p_fy_start and p_fy_end;

  -- What the fixed asset register says the charge should have been. Reported
  -- for comparison only; never added back.
  select coalesce(sum(
      app_private.compute_book_depreciation(
        fa.gross_value, fa.residual_value_percent, cat.useful_life_years, fa.book_method,
        fa.put_to_use_date, least(coalesce(fa.disposal_date, p_fy_end), p_fy_end)
      )
      - app_private.compute_book_depreciation(
        fa.gross_value, fa.residual_value_percent, cat.useful_life_years, fa.book_method,
        fa.put_to_use_date, p_fy_start - 1
      )
    ), 0) into v_book_dep_register
    from public.fixed_assets fa
    join public.ref_depreciation_categories cat on cat.category_code = fa.category_code
   where fa.company_id = p_company_id;

  select coalesce(sum(po.outstanding), 0) into v_msme_addback
    from public.get_party_outstanding(p_company_id, p_fy_end, 'creditor') po
    join public.ledgers l on l.id = po.ledger_id
   where l.msme_category in ('micro', 'small')
     and po.oldest_date is not null
     and (p_fy_end - po.oldest_date) > coalesce(l.msme_payment_days, 15);

  select
      coalesce(sum(b.depreciation_for_year), 0),
      coalesce(sum(b.short_term_capital_gain), 0),
      coalesce(sum(b.short_term_capital_loss), 0)
    into v_tax_dep, v_stcg, v_stcl
    from public.get_tax_depreciation_blocks(p_company_id, p_fy_start, p_fy_end) b;

  select coalesce(sum(e.credit_amount - e.debit_amount), 0) into v_remuneration_booked
    from public.ledgers l
    join public.voucher_entries e on e.ledger_id = l.id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where l.company_id = p_company_id
     and l.is_partner_remuneration
     and v.voucher_date between p_fy_start and p_fy_end;
  v_remuneration_booked := -v_remuneration_booked;

  -- ---- Business income, Sec 28-44. NOT clamped: a loss is a real result. ----
  v_business_income := v_book_profit + v_book_dep_posted + v_msme_addback - v_tax_dep;

  -- Sec 40(b): the ceiling is a function of the firm's BOOK PROFIT, so it is
  -- settled before capital gains enter.
  if v_entity_type in ('partnership', 'llp') then
    v_book_profit_before_remuneration := v_business_income + v_remuneration_booked;

    v_remuneration_ceiling :=
      greatest(300000, 0.90 * least(v_book_profit_before_remuneration, 600000))
      + 0.60 * greatest(v_book_profit_before_remuneration - 600000, 0);

    v_remuneration_disallowed := greatest(v_remuneration_booked - v_remuneration_ceiling, 0);
    v_business_income := v_business_income + v_remuneration_disallowed;
  end if;

  -- ---- Sec 50 capital gains ----
  -- Netted only WITHIN the capital gains head. A net capital loss is carried
  -- forward under Sec 74 and never reduces business income.
  v_cg_net := v_stcg - v_stcl;
  v_capital_loss_cf := greatest(-v_cg_net, 0);

  -- Sec 71 inter-head set-off is implicit here: a negative business income
  -- reduces a positive capital gain, which is permitted; the reverse is not
  -- possible because only a positive capital gain is added.
  v_gti := v_business_income + greatest(v_cg_net, 0);

  v_taxable := greatest(v_gti, 0);
  v_business_loss_cf := greatest(-v_gti, 0);

  if v_entity_type in ('proprietorship', 'huf') then
    select coalesce(sum(
        greatest(least(v_taxable, s.to_rupees) - s.from_rupees + 1, 0) * s.rate_percent / 100
      ), 0) into v_tax_before_rebate
      from public.ref_income_tax_slabs s
     where s.from_rupees <= v_taxable;

    if v_taxable <= 1200000 then
      v_rebate := least(v_tax_before_rebate, 60000);
    else
      v_rebate := 0;
    end if;
    v_tax_after_rebate := v_tax_before_rebate - v_rebate;

    v_surcharge_rate := case
      when v_taxable <= 5000000 then 0
      when v_taxable <= 10000000 then 0.10
      when v_taxable <= 20000000 then 0.15
      else 0.25
    end;
    v_surcharge := v_tax_after_rebate * v_surcharge_rate;

    entity_type := v_entity_type;
    applicable := true;
    regime_used := 'New regime (Sec 115BAC) — old regime not modelled';
    note := 'Excludes Sec 40(a)/40A(3)/general Sec 43B (non-MSME) disallowances and marginal relief at the Rs 12L rebate taper and each surcharge threshold. Sec 50 short-term capital gains are included at slab rates. Starting estimate, not a filed-return number.';

  elsif v_entity_type in ('partnership', 'llp') then
    v_tax_before_rebate := v_taxable * 0.30;
    v_tax_after_rebate := v_tax_before_rebate;

    v_surcharge := case when v_taxable > 10000000 then v_tax_after_rebate * 0.12 else 0 end;

    entity_type := v_entity_type;
    applicable := true;
    regime_used := 'Flat 30% — firms and LLPs have no regime choice';
    note := 'Excludes Sec 40(a)/40A(3)/general Sec 43B (non-MSME), the Sec 40(b) INTEREST cap (12% p.a. — needs partner capital-balance tracking this schema does not have; only the remuneration cap is computed), and marginal relief at the Rs 1 crore surcharge threshold.';

  elsif v_entity_type in ('opc', 'pvt_ltd', 'ltd') then
    v_rate := case v_company_regime
      when '115baa' then 22
      when '115bab' then 15
      when 'default_25' then 25
      else 30
    end;
    v_tax_before_rebate := v_taxable * v_rate / 100;
    v_tax_after_rebate := v_tax_before_rebate;

    v_surcharge_rate := case
      when v_company_regime in ('115baa', '115bab') then 0.10
      when v_taxable <= 10000000 then 0
      when v_taxable <= 100000000 then 0.07
      else 0.12
    end;
    v_surcharge := v_tax_after_rebate * v_surcharge_rate;

    entity_type := v_entity_type;
    applicable := true;
    regime_used := 'Rate ' || v_rate || '% per Settings''s company_tax_regime (' || v_company_regime || ') — confirm this matches your actual election';
    note := 'Excludes Sec 40(a)/40A(3)/general Sec 43B (non-MSME) and marginal relief at each surcharge threshold. default_25 assumes you have confirmed FY 2023-24 turnover was within the Rs 400 crore ceiling — LEKHA does not hold that history to check it for you.';

  else
    entity_type := v_entity_type;
    applicable := false;
    note := 'Not computed — this entity type is not yet mapped to a rate structure.';
    return next;
    return;
  end if;

  v_cess := v_tax_after_rebate + v_surcharge;
  v_cess := v_cess * 0.04;
  v_total := v_tax_after_rebate + v_surcharge + v_cess;

  -- Say so when the books are behind the register, rather than quietly using
  -- one figure and displaying the other.
  if round(v_book_dep_posted, 2) <> round(v_book_dep_register, 2) then
    v_dep_note := ' Book depreciation actually posted for the year ('
      || round(v_book_dep_posted, 2)
      || ') differs from what the fixed asset register computes ('
      || round(v_book_dep_register, 2)
      || ') — the add-back above uses what was posted, because that is what reduced book profit. Post the depreciation charge to bring the books in line.';
  end if;

  if v_business_loss_cf > 0 then
    v_dep_note := v_dep_note || ' A business loss of ' || round(v_business_loss_cf, 2)
      || ' is available to carry forward (Sec 72, eight assessment years; unabsorbed depreciation indefinitely under Sec 32(2)). LEKHA does not yet carry it into a later year — record it yourself.';
  end if;

  if v_capital_loss_cf > 0 then
    v_dep_note := v_dep_note || ' A short-term capital loss of ' || round(v_capital_loss_cf, 2)
      || ' (Sec 50) is available to carry forward. Under Sec 74 it can be set off only against capital gains, never against business income, so it has NOT reduced the figures above.';
  end if;

  book_profit := round(v_book_profit, 2);
  book_depreciation_addback := round(v_book_dep_posted, 2);
  book_depreciation_per_register := round(v_book_dep_register, 2);
  msme_disallowance_addback := round(v_msme_addback, 2);
  tax_depreciation_deduction := round(v_tax_dep, 2);
  partner_remuneration_booked := round(v_remuneration_booked, 2);
  partner_remuneration_disallowed := round(v_remuneration_disallowed, 2);
  business_income := round(v_business_income, 2);
  short_term_capital_gain := round(v_stcg, 2);
  short_term_capital_loss := round(v_stcl, 2);
  gross_total_income := round(v_gti, 2);
  business_loss_carried_forward := round(v_business_loss_cf, 2);
  capital_loss_carried_forward := round(v_capital_loss_cf, 2);
  taxable_income := round(v_taxable, 2);
  tax_before_rebate := round(v_tax_before_rebate, 2);
  rebate_87a := round(v_rebate, 2);
  tax_after_rebate := round(v_tax_after_rebate, 2);
  surcharge := round(v_surcharge, 2);
  cess := round(v_cess, 2);
  total_tax := round(v_total, 2);
  note := note || v_dep_note;
  return next;
end;
$fn$;

revoke all on function public.get_income_tax_computation(uuid, date, date) from public, anon;
grant execute on function public.get_income_tax_computation(uuid, date, date) to authenticated;

comment on function public.get_income_tax_computation(uuid, date, date) is
  'Income tax computation. Business income is unclamped so a loss survives and is reported for carry-forward; Sec 50 short-term capital gains are included, while a Sec 50 capital loss is carried forward under Sec 74 and never set off against business income; book depreciation is added back at what was actually POSTED, not what the register computes. See 0078.';
