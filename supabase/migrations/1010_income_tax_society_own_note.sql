-- ============================================================================
-- 1010 — Co-operative societies get their own income-tax note, not AOP/trust's
-- ============================================================================
-- Bug confirmed live today at /reports/income-tax for a Co-operative Society
-- company: the page shows "Not computed. AOP/BOI and trust taxation depends
-- on member-share determinacy and, for trusts, Sec 11-13 registration status
-- — neither is tracked by this schema." That reasoning has nothing to do
-- with a co-operative society.
--
-- ROOT CAUSE, READ AND CONFIRMED. get_income_tax_computation was introduced
-- by 0026 and re-created with a widened return type by 0029, then 0078, then
-- 0079 — `grep -rn "create function public.get_income_tax_computation\|
-- create or replace function public.get_income_tax_computation"
-- supabase/migrations` turns up exactly those four files, in that order,
-- with no redefinition after 0079, so 0079's body is the one actually live
-- today. All four share the identical branch, unchanged since 0026:
--
--   if v_entity_type in ('aop_boi', 'trust', 'society') then
--     ...
--     note := 'Not computed. AOP/BOI and trust taxation depends on
--       member-share determinacy and, for trusts, Sec 11-13 registration
--       status — neither is tracked by this schema. Consult a tax
--       professional for this entity type.';
--
-- 'society' was lumped into the same branch as 'aop_boi'/'trust' and
-- inherited their message verbatim. It shouldn't have been: a co-operative
-- society (ref_entity_types already labels this code 'Co-operative Society /
-- Society' and its own notable_points array already says "Deduction under
-- Sec 80P may apply" — 0002, lines ~179-183) has real, well-defined
-- provisions of its own, unrelated to an AOP/BOI's member-share-indeterminacy
-- problem or a trust's Sec 11-13 registration problem:
--
--   * ordinary income is taxed at the co-operative society slab rates — 10%
--     up to Rs 10,000, 20% up to the next Rs 10,000, 30% above Rs 20,000,
--     plus surcharge and cess — not at the individual/HUF or flat company
--     rates this function already models for other entity types;
--   * Sec 80P allows a deduction for specified member-facing activities:
--     providing credit facilities or banking to members, marketing
--     agricultural produce grown by members, cottage industry, collective
--     disposal of members' labour, and a handful of others enumerated in
--     80P(2) — with Sec 80P(4) excluding co-operative banks, other than a
--     primary agricultural credit society, from the deduction entirely;
--   * Sec 115BAD offers an optional flat 22% (plus surcharge and cess, no
--     slabs) rate election, analogous to Sec 115BAA for companies — opting
--     in forgoes 80P and most other Chapter VI-A deductions and, once
--     exercised, cannot be withdrawn.
--
-- NONE OF THIS IS COMPUTED HERE, and this migration does not attempt it —
-- that is real, separate future work: Sec 80P needs an activity-by-activity
-- income split this schema has no ledger convention for, and Sec 115BAD
-- needs the same kind of user-stated election company_tax_regime already
-- models for companies, which no equivalent column exists for societies yet.
-- What this migration fixes is narrower and honest about that scope: stop
-- attributing AOP/trust legal reasoning to a co-operative society, and say
-- what actually governs it instead, still flagged not computed.
--
-- 'aop_boi' and 'trust' keep their existing shared message, completely
-- unchanged — nothing about member-share determinacy or Sec 11-13 was wrong
-- for either of them, and downstream callers that already read
-- `applicable = false` for all three codes (get_statutory_bonus_computation
-- 0109, get_deferred_tax_as22 0091, the Form 3CD clause 26 note 0042a, the
-- tax-audit/advance-tax/cash-flow callers) are unaffected either way: society
-- remains not-applicable, just with a correct reason now.
--
-- MECHANICALLY: the return signature is unchanged from 0079 (28 output
-- columns) and no new grant is needed — `create or replace` over the exact
-- same signature is used, rather than 0079's own drop-and-recreate, because
-- only one branch inside the body is changing.
-- ============================================================================

create or replace function public.get_income_tax_computation(
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
  advance_tax_paid numeric,
  self_assessment_tax_paid numeric,
  tds_tcs_credit numeric,
  net_tax_payable numeric,
  note text
)
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_entity_type text;
  v_company_regime text;
  v_fy_label text;
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
  v_advance numeric := 0;
  v_self_assessment numeric := 0;
  v_tds_credit numeric := 0;
  v_net numeric := 0;
  v_rate numeric;
  v_dep_note text := '';
begin
  select c.entity_type, c.company_tax_regime into v_entity_type, v_company_regime
    from public.companies c
   where c.id = p_company_id;

  if v_entity_type is null then
    return;
  end if;

  -- AOP/BOI and trust: unchanged from 0026/0079 — member-share determinacy
  -- and Sec 11-13 registration status are genuinely their problems, and
  -- neither is tracked by this schema.
  if v_entity_type in ('aop_boi', 'trust') then
    entity_type := v_entity_type;
    applicable := false;
    note := 'Not computed. AOP/BOI and trust taxation depends on member-share determinacy and, for trusts, Sec 11-13 registration status — neither is tracked by this schema. Consult a tax professional for this entity type.';
    return next;
    return;
  end if;

  -- Co-operative society: its OWN branch, its OWN reasoning (see the
  -- migration header). Still not computed — Sec 80P needs an
  -- activity-by-activity income split and Sec 115BAD needs an election this
  -- schema does not capture — but no longer misattributed to AOP/trust law.
  if v_entity_type = 'society' then
    entity_type := v_entity_type;
    applicable := false;
    note := 'Not computed. Co-operative societies have their own well-defined provisions, distinct from AOP/BOI or trust taxation: ordinary income is taxed at co-operative society slab rates (10%/20%/30%), a Sec 80P deduction applies to specified member-facing activities such as credit or banking facilities for members and marketing agricultural produce grown by members (Sec 80P(4) excludes co-operative banks, other than a primary agricultural credit society, from the deduction entirely), and a society may instead elect the flat-rate Sec 115BAD regime (22% plus surcharge and cess, no slabs, no 80P) analogous to Sec 115BAA for companies. This schema computes none of it yet. Consult a tax professional for this entity type.';
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

  select coalesce(sum(e.debit_amount - e.credit_amount), 0) into v_book_dep_posted
    from public.ledgers l
    join public.voucher_entries e on e.ledger_id = l.id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where l.company_id = p_company_id
     and l.name = 'Depreciation'
     and v.voucher_date between p_fy_start and p_fy_end;

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

  v_business_income := v_book_profit + v_book_dep_posted + v_msme_addback - v_tax_dep;

  if v_entity_type in ('partnership', 'llp') then
    v_book_profit_before_remuneration := v_business_income + v_remuneration_booked;

    v_remuneration_ceiling :=
      greatest(300000, 0.90 * least(v_book_profit_before_remuneration, 600000))
      + 0.60 * greatest(v_book_profit_before_remuneration - 600000, 0);

    v_remuneration_disallowed := greatest(v_remuneration_booked - v_remuneration_ceiling, 0);
    v_business_income := v_business_income + v_remuneration_disallowed;
  end if;

  v_cg_net := v_stcg - v_stcl;
  v_capital_loss_cf := greatest(-v_cg_net, 0);
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

  -- ---- What has already been paid against this year's liability ----
  v_fy_label := app_private.fy_label(p_fy_start, extract(month from p_fy_start)::smallint);

  select
      coalesce(sum(tp.amount) filter (where tp.minor_head = '100'), 0),
      coalesce(sum(tp.amount) filter (where tp.minor_head in ('300', '400')), 0)
    into v_advance, v_self_assessment
    from public.tax_payments tp
   where tp.company_id = p_company_id
     and tp.tax_type = 'income_tax'
     and tp.financial_year_label = v_fy_label;

  -- The DEBIT MOVEMENT during the year, not the closing balance. The balance
  -- carries forward until a refund actually lands, so using it would credit
  -- last year's TDS against this year's tax as well.
  select coalesce(sum(e.debit_amount - e.credit_amount), 0) into v_tds_credit
    from public.tax_ledger_map m
    join public.voucher_entries e on e.ledger_id = m.ledger_id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where m.company_id = p_company_id
     and m.gst_registration_id is null
     and m.purpose = 'tds_receivable'
     and v.voucher_date between p_fy_start and p_fy_end;

  v_net := v_total - v_advance - v_self_assessment - v_tds_credit;

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

  v_dep_note := v_dep_note
    || ' Interest under Sec 234A/234B/234C for late filing or short/deferred advance tax is NOT computed.';

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
  advance_tax_paid := round(v_advance, 2);
  self_assessment_tax_paid := round(v_self_assessment, 2);
  tds_tcs_credit := round(v_tds_credit, 2);
  net_tax_payable := round(v_net, 2);
  note := note || v_dep_note;
  return next;
end;
$fn$;

revoke all on function public.get_income_tax_computation(uuid, date, date) from public, anon;
grant execute on function public.get_income_tax_computation(uuid, date, date) to authenticated;

comment on function public.get_income_tax_computation(uuid, date, date) is
  'Income tax computation, net of what has already been paid: advance tax and self-assessment from tax_payments, plus TDS suffered read as the year MOVEMENT on the TDS Receivable ledger (never its carried-forward balance). net_tax_payable is positive when tax is due and negative when a refund is. Sec 234A/B/C interest is not computed. AOP/BOI and trust are not computed (member-share determinacy / Sec 11-13 registration) and neither is co-operative society (Sec 80P / Sec 115BAD) — each now has its own correct note; see 1010.';
