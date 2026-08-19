-- ============================================================================
-- 0026 — Income tax computation: the PGBP bridge, not a full return
-- ============================================================================
-- The `income_tax` module has had a due-date presence since 0024 (compliance
-- calendar) but no actual computation — this closes that gap with the
-- narrowest slice both research passes agreed is realistically buildable
-- from LEKHA's own ledger data: the bridge from book profit to taxable
-- business income, and the resulting tax liability by entity type.
--
-- WHICH LAW GOVERNS THIS FEATURE — read this before touching a rate here.
-- Two-pass research plus a reconciliation pass caught a framing error in
-- its own first pass: for AY 2026-27 (the return covering FY 2025-26
-- income — the filing this app's "today" of 19 Aug 2026 sits inside, with
-- the non-audit ITR due 31 Aug per 0024's own calendar), the OPERATIVE
-- citations are the Income-tax Act 1961's section numbers (115BAC, 87A,
-- 115BAA, 115BAB, 44AD/44ADA/44AE), NOT the Income-tax Act 2025's renumbered
-- ones. The 2025 Act only commences 1 April 2026 and governs "Tax Year
-- 2026-27" (income earned from that date), first filed in 2027 — a
-- DIFFERENT, later filing cycle from the one this feature computes for
-- today. This is the opposite framing from 0022-0025, which correctly cite
-- the 2025 Act because those migrations are about CURRENT transactions
-- (today's TDS deduction, today's asset purchase) happening after the 1
-- April 2026 commencement — not about which Act governs an already-earned
-- year's return. Do not "fix" this migration's 1961-Act citations to match
-- those; they are right for what each migration computes.
--
-- SCOPE — the two passes' own recommendation, taken literally: "prioritize
-- the PGBP-bridge build-out over any Chapter VI-A worksheet". Chapter VI-A
-- personal reliefs (80C/80D/80G/etc.) are out of scope entirely — they
-- never apply to firms/LLPs/companies, and for the one entity type they do
-- apply to (proprietorship), they are personal financial facts about the
-- proprietor with no natural home in a business ledger. What IS in scope:
--
--   Taxable PGBP = book profit (get_profit_and_loss's net result)
--                  + book depreciation (added back in full; tax
--                    depreciation is computed separately)
--                  + Sec 43B(h) MSME dues unpaid past their deadline as at
--                    the year end — mechanical, LEKHA already tracks this
--                    end to end (msme_category/msme_payment_days, the same
--                    fields the MSME dues report already reads)
--                  - tax depreciation for the year (get_tax_depreciation_
--                    blocks, 0025 — sums depreciation_for_year across
--                    blocks; a block's short_term_capital_gain/loss is
--                    deliberately excluded, same as the tax-depreciation
--                    report's own treatment: that is capital gains
--                    territory, not depreciation)
--
-- Then tax is computed on that figure by entity type. NOT computed, each a
-- documented v1 cut rather than an oversight:
--   * Sec 40(a)/40(a)(ia) — TDS-default expense disallowance. LEKHA tracks
--     TDS deductee/section data but not yet whether a deduction was
--     actually made and deposited on a given payment; a real future build,
--     not a guess folded in here.
--   * Sec 40A(3) — cash payments over the daily per-payee threshold. LEKHA
--     has no payment-mode aggregation across vouchers yet.
--   * Sec 43B general (non-MSME) — unpaid GST/PF/ESI/bonus/leave
--     encashment/loan interest. Needs a mapping from specific ledger groups
--     to "statutory due" that does not exist yet; only the MSME-specific
--     variant (stricter, no ITR-due-date grace, and already fully tracked)
--     is computed.
--   * Sec 40(b) — firm/LLP partner remuneration/interest cap. Needs
--     LEKHA to know which ledger postings ARE partner remuneration, which
--     it does not tag today.
--   * Old-regime computation for individuals/HUF. The new regime (Sec
--     115BAC) is the default for AY 2026-27 and the only one modelled;
--     Form 10-IEA opt-out tracking is not built.
--   * Marginal relief at every surcharge/rebate threshold (Sec 87A's
--     taper between Rs 12,00,000 and ~12,75,000; the analogous taper at
--     each surcharge bracket boundary). A simple bracket lookup is used
--     instead — it can overstate tax by a small amount exactly at a
--     threshold, never understate it, and is flagged in the result's
--     own `note` column.
--   * AOP/BOI, Trust, Society entity types are not computed at all —
--     taxation depends on member-share determinacy and, for trusts,
--     registration status under Sec 11-13, neither of which this schema
--     tracks. Flagged not-applicable rather than guessed.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- companies.company_tax_regime — which concessional company regime, if any,
-- this company has elected. LEKHA cannot derive this (it depends on a filed
-- Form 10-IC/10-ID and, for the un-elected default, on FY 2023-24 turnover
-- history this app may not hold) — the user states it, same as TAN/Udyam.
-- Defaults to the higher, safer rate rather than silently assuming the
-- lower one: an unconfigured company is assumed 30%, never 25%.
-- ----------------------------------------------------------------------------
alter table public.companies
  add column company_tax_regime text not null default 'default_30'
    check (company_tax_regime in ('default_30', 'default_25', '115baa', '115bab'));

comment on column public.companies.company_tax_regime is
  'Only meaningful for company-like entity types (opc/pvt_ltd/ltd). default_30/default_25 are the un-elected turnover-based rates (25% requires FY 2023-24 turnover <= Rs 400 crore — the user''s own call, LEKHA does not hold that history); 115baa/115bab are irrevocable elections (Form 10-IC/10-ID) at 22%/15%.';


-- ----------------------------------------------------------------------------
-- ref_income_tax_slabs — individual/HUF NEW REGIME slabs only (Sec 115BAC).
-- The old regime is not modelled; see the migration header. Bounds are
-- inclusive on both ends (bracket 2 starts the rupee after bracket 1 ends),
-- matching how the computation below sums each bracket's own span.
-- ----------------------------------------------------------------------------
create table public.ref_income_tax_slabs (
  from_rupees numeric(18,2) not null,
  to_rupees numeric(18,2) not null,
  rate_percent numeric(5,2) not null check (rate_percent >= 0 and rate_percent <= 100),
  sort_order smallint not null,
  constraint ref_income_tax_slabs_range_valid check (to_rupees >= from_rupees)
);

comment on table public.ref_income_tax_slabs is
  'Sec 115BAC new-regime slabs for individuals/HUF, AY 2026-27. Old regime and every other entity type''s rate is computed directly in get_income_tax_computation rather than looked up, since firms/LLPs/companies are flat or election-based, not bracketed.';

insert into public.ref_income_tax_slabs (from_rupees, to_rupees, rate_percent, sort_order) values
  (0,        400000,      0,  10),
  (400001,   800000,      5,  20),
  (800001,   1200000,    10,  30),
  (1200001,  1600000,    15,  40),
  (1600001,  2000000,    20,  50),
  (2000001,  2400000,    25,  60),
  (2400001,  999999999999, 30, 70)
;

alter table public.ref_income_tax_slabs enable row level security;
create policy ref_income_tax_slabs_read on public.ref_income_tax_slabs
  for select to authenticated using (true);


-- ----------------------------------------------------------------------------
-- get_income_tax_computation(company, fy_start, fy_end)
-- One row per call — a single company/period result, not a line-item table.
-- language plpgsql for named intermediate variables (book profit, each
-- add-back, the bracket sum) rather than one large nested CASE expression;
-- a single `return next` at the end, no loop, since there is exactly one
-- row to emit.
-- ----------------------------------------------------------------------------
create or replace function public.get_income_tax_computation(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  entity_type text,
  applicable boolean,
  regime_used text,
  book_profit numeric,
  book_depreciation_addback numeric,
  msme_disallowance_addback numeric,
  tax_depreciation_deduction numeric,
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
security invoker
set search_path = ''
as $$
declare
  v_entity_type text;
  v_company_regime text;
  v_book_profit numeric := 0;
  v_book_dep numeric := 0;
  v_msme_addback numeric := 0;
  v_tax_dep numeric := 0;
  v_taxable numeric := 0;
  v_tax_before_rebate numeric := 0;
  v_rebate numeric := 0;
  v_tax_after_rebate numeric := 0;
  v_surcharge numeric := 0;
  v_surcharge_rate numeric := 0;
  v_cess numeric := 0;
  v_total numeric := 0;
  v_rate numeric;
begin
  select c.entity_type, c.company_tax_regime into v_entity_type, v_company_regime
    from public.companies c
   where c.id = p_company_id;

  if v_entity_type is null then
    return;
  end if;

  -- Not computed for these — see the migration header. One row, all
  -- numeric columns null, applicable = false.
  if v_entity_type in ('aop_boi', 'trust', 'society') then
    entity_type := v_entity_type;
    applicable := false;
    note := 'Not computed. AOP/BOI and trust taxation depends on member-share determinacy and, for trusts, Sec 11-13 registration status — neither is tracked by this schema. Consult a tax professional for this entity type.';
    return next;
    return;
  end if;

  -- Book profit: for a normal double-entry P&L, summing credit-debit
  -- across every income and expense ledger directly yields net profit —
  -- income's normal credit balance and expense's normal debit balance
  -- combine correctly without branching by nature, unlike a line-item
  -- report (get_profit_and_loss) which must branch to sign each row for
  -- display.
  select coalesce(sum(e.credit_amount - e.debit_amount), 0) into v_book_profit
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    join public.voucher_entries e on e.ledger_id = l.id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where l.company_id = p_company_id
     and g.nature in ('direct_income', 'direct_expense', 'indirect_income', 'indirect_expense')
     and v.voucher_date between p_fy_start and p_fy_end;

  -- Book depreciation for the period: accumulated as at fy_end minus
  -- accumulated as at the day before fy_start, per asset. The "before"
  -- call correctly returns 0 for an asset acquired during this period —
  -- compute_book_depreciation guards p_end < p_start.
  select coalesce(sum(
      app_private.compute_book_depreciation(
        fa.gross_value, fa.residual_value_percent, cat.useful_life_years, fa.book_method,
        fa.put_to_use_date, least(coalesce(fa.disposal_date, p_fy_end), p_fy_end)
      )
      - app_private.compute_book_depreciation(
        fa.gross_value, fa.residual_value_percent, cat.useful_life_years, fa.book_method,
        fa.put_to_use_date, p_fy_start - 1
      )
    ), 0) into v_book_dep
    from public.fixed_assets fa
    join public.ref_depreciation_categories cat on cat.category_code = fa.category_code
   where fa.company_id = p_company_id;

  -- Sec 43B(h): MSME dues outstanding past their own deadline as at
  -- fy_end, mirroring the MSME dues report's own logic (FIFO-inferred
  -- ageing via get_party_outstanding, filtered to micro/small suppliers).
  select coalesce(sum(po.outstanding), 0) into v_msme_addback
    from public.get_party_outstanding(p_company_id, p_fy_end, 'creditor') po
    join public.ledgers l on l.id = po.ledger_id
   where l.msme_category in ('micro', 'small')
     and po.oldest_date is not null
     and (p_fy_end - po.oldest_date) > coalesce(l.msme_payment_days, 15);

  -- Tax depreciation for the year: sum across blocks, excluding the
  -- capital-gains-territory rows (a block that ceased or was over-disposed
  -- reports a gain/loss instead of depreciation for that block that year —
  -- already zero in depreciation_for_year, summed here for clarity anyway).
  select coalesce(sum(b.depreciation_for_year), 0) into v_tax_dep
    from public.get_tax_depreciation_blocks(p_company_id, p_fy_start, p_fy_end) b;

  v_taxable := greatest(v_book_profit + v_book_dep + v_msme_addback - v_tax_dep, 0);

  if v_entity_type in ('proprietorship', 'huf') then
    -- Sec 115BAC new-regime slabs (only regime modelled), progressive
    -- bracket sum. Each bracket's own span, inclusive both ends — bracket
    -- 2 starting at 400001 is why "+1" appears rather than a plain
    -- to-from subtraction.
    select coalesce(sum(
        greatest(least(v_taxable, s.to_rupees) - s.from_rupees + 1, 0) * s.rate_percent / 100
      ), 0) into v_tax_before_rebate
      from public.ref_income_tax_slabs s
     where s.from_rupees <= v_taxable;

    -- Sec 87A rebate: full rebate up to Rs 60,000 for taxable income up to
    -- Rs 12,00,000. The marginal-relief taper between Rs 12L and ~12.75L
    -- is not modelled — see the migration header.
    if v_taxable <= 1200000 then
      v_rebate := least(v_tax_before_rebate, 60000);
    end if;
    v_tax_after_rebate := v_tax_before_rebate - v_rebate;

    v_surcharge_rate := case
      when v_taxable <= 5000000 then 0
      when v_taxable <= 10000000 then 0.10
      when v_taxable <= 20000000 then 0.15
      else 0.25 -- new-regime cap; old regime's 37% above Rs 5cr is not modelled
    end;
    v_surcharge := v_tax_after_rebate * v_surcharge_rate;

    entity_type := v_entity_type;
    applicable := true;
    regime_used := 'New regime (Sec 115BAC) — old regime not modelled';
    note := 'Excludes Sec 40(a)/40A(3)/general Sec 43B (non-MSME) disallowances and marginal relief at the Rs 12L rebate taper and each surcharge threshold. Starting estimate, not a filed-return number.';

  elsif v_entity_type in ('partnership', 'llp') then
    v_tax_before_rebate := v_taxable * 0.30;
    v_tax_after_rebate := v_tax_before_rebate; -- no Sec 87A rebate for firms/LLPs

    v_surcharge := case when v_taxable > 10000000 then v_tax_after_rebate * 0.12 else 0 end;

    entity_type := v_entity_type;
    applicable := true;
    regime_used := 'Flat 30% — firms and LLPs have no regime choice';
    note := 'Excludes Sec 40(a)/40A(3)/general Sec 43B (non-MSME), the Sec 40(b) partner remuneration/interest cap, and marginal relief at the Rs 1 crore surcharge threshold.';

  elsif v_entity_type in ('opc', 'pvt_ltd', 'ltd') then
    v_rate := case v_company_regime
      when '115baa' then 22
      when '115bab' then 15
      when 'default_25' then 25
      else 30
    end;
    v_tax_before_rebate := v_taxable * v_rate / 100;
    v_tax_after_rebate := v_tax_before_rebate; -- no Sec 87A rebate for companies

    v_surcharge_rate := case
      when v_company_regime in ('115baa', '115bab') then 0.10 -- flat, no slabs
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
    -- Every ref_entity_types code is handled above except the three
    -- excluded ones checked earlier; this branch exists only as a guard
    -- against a future entity type being added without updating this
    -- function too.
    entity_type := v_entity_type;
    applicable := false;
    note := 'Not computed — this entity type is not yet mapped to a rate structure.';
    return next;
    return;
  end if;

  v_cess := v_tax_after_rebate + v_surcharge;
  v_cess := v_cess * 0.04;
  v_total := v_tax_after_rebate + v_surcharge + v_cess;

  book_profit := round(v_book_profit, 2);
  book_depreciation_addback := round(v_book_dep, 2);
  msme_disallowance_addback := round(v_msme_addback, 2);
  tax_depreciation_deduction := round(v_tax_dep, 2);
  taxable_income := round(v_taxable, 2);
  tax_before_rebate := round(v_tax_before_rebate, 2);
  rebate_87a := round(v_rebate, 2);
  tax_after_rebate := round(v_tax_after_rebate, 2);
  surcharge := round(v_surcharge, 2);
  cess := round(v_cess, 2);
  total_tax := round(v_total, 2);
  return next;
end;
$$;

comment on function public.get_income_tax_computation is
  'The PGBP bridge and resulting tax by entity type — not a full return. Governed by the Income-tax Act 1961 as amended (AY 2026-27); see the migration header for why that differs from 0022-0025''s 2025-Act citations, and for the full list of deliberately uncomputed provisions (Sec 40(a), 40A(3), general 43B, 40(b), old regime, marginal relief, AOP/BOI/Trust/Society).';
