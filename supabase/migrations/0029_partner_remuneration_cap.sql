-- ============================================================================
-- 0029 — Sec 40(b): the partner remuneration cap, not the interest cap
-- ============================================================================
-- Closes one of the gaps get_income_tax_computation's own `note` column
-- (0026) already named for firms/LLPs: "the Sec 40(b) partner remuneration/
-- interest cap." Only the remuneration half is computed here — see below for
-- why interest stays out.
--
-- TWO SEPARATE SUB-RULES under Sec 40(b), confirmed via web search (taxadda.com,
-- cleartax.in, taxguru.in — Finance (No. 2) Act 2024's doubled slabs, effective
-- FY 2024-25/AY 2025-26 onward, still current for AY 2026-27):
--
--   INTEREST to partners: capped at 12% p.a. simple interest on capital;
--   excess disallowed. NOT modelled here — computing it needs each partner's
--   capital balance through the year (opening balance, additions,
--   withdrawals, time-weighted), which this schema does not track at that
--   granularity. A flat "12% of what was paid" guess would be wrong whenever
--   capital moved during the year, which is common — worse than not
--   computing it at all.
--
--   REMUNERATION (salary/bonus/commission) to working partners: capped by a
--   slab formula on "book profit" (business income before deducting the
--   remuneration itself): the higher of Rs 3,00,000 or 90% of book profit on
--   the first Rs 6,00,000, plus 60% of book profit beyond that. This
--   collapses to one formula that also handles a loss/nil book profit
--   correctly with no special case:
--     ceiling = greatest(300000, 0.90 * least(book_profit, 600000))
--             + 0.60 * greatest(book_profit - 600000, 0)
--   (a negative book_profit makes both max() arguments negative-or-zero,
--   correctly floors the ceiling at 300000, and contributes nothing from the
--   second term — verified by hand for a loss, a small profit under 6L, and
--   a large profit, before this was written into SQL.)
--
-- "Book profit" for this test = get_income_tax_computation's own existing
-- taxable_income figure (which already reflects the MSME/tax-depreciation
-- adjustments 0026 established) PLUS whatever was booked as partner
-- remuneration, since that figure already has remuneration deducted as an
-- expense and the section requires testing the ceiling against profit
-- BEFORE that deduction. Only the EXCESS over the ceiling — not the whole
-- remuneration amount — gets added back to taxable income.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- ledgers.is_partner_remuneration — flags a ledger (e.g. "Partner A Salary",
-- "Partner Remuneration") as a Sec 40(b) remuneration account. Mirrors
-- is_tds_deductee's shape (0006): a plain boolean flag on the ledger, read
-- by the tax computation rather than by any invoice-time engine.
-- ----------------------------------------------------------------------------
alter table public.ledgers
  add column is_partner_remuneration boolean not null default false;

comment on column public.ledgers.is_partner_remuneration is
  'Sec 40(b) remuneration account (salary/bonus/commission to a working partner). Only meaningful for partnership/llp companies; read by get_income_tax_computation to test the slab ceiling, never by create_invoice or create_voucher.';


-- ----------------------------------------------------------------------------
-- get_income_tax_computation, extended with two new output columns.
-- CREATE OR REPLACE cannot change a function's return columns, so the old
-- signature is dropped first — same pattern 0018/0025 already established.
-- Every column and branch from 0026 is unchanged except the partnership/llp
-- branch, which now tests and applies the remuneration ceiling.
-- ----------------------------------------------------------------------------
drop function if exists public.get_income_tax_computation(uuid, date, date);

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
  partner_remuneration_booked numeric,
  partner_remuneration_disallowed numeric,
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
  v_remuneration_booked numeric := 0;
  v_remuneration_disallowed numeric := 0;
  v_remuneration_ceiling numeric;
  v_book_profit_before_remuneration numeric;
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

  select coalesce(sum(po.outstanding), 0) into v_msme_addback
    from public.get_party_outstanding(p_company_id, p_fy_end, 'creditor') po
    join public.ledgers l on l.id = po.ledger_id
   where l.msme_category in ('micro', 'small')
     and po.oldest_date is not null
     and (p_fy_end - po.oldest_date) > coalesce(l.msme_payment_days, 15);

  select coalesce(sum(b.depreciation_for_year), 0) into v_tax_dep
    from public.get_tax_depreciation_blocks(p_company_id, p_fy_start, p_fy_end) b;

  -- Sec 40(b) remuneration: only ever relevant for partnership/llp, but
  -- computed here (before the branch) since v_taxable's baseline needs it
  -- either way — a books_only or non-partnership company simply has no
  -- ledger flagged this way, so this naturally contributes zero elsewhere.
  select coalesce(sum(e.credit_amount - e.debit_amount), 0) into v_remuneration_booked
    from public.ledgers l
    join public.voucher_entries e on e.ledger_id = l.id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where l.company_id = p_company_id
     and l.is_partner_remuneration
     and v.voucher_date between p_fy_start and p_fy_end;
  -- Booked as an expense, so its natural balance is a debit (negative in
  -- the credit-minus-debit convention used above) — flip sign to a positive
  -- "amount booked" figure.
  v_remuneration_booked := -v_remuneration_booked;

  v_taxable := greatest(v_book_profit + v_book_dep + v_msme_addback - v_tax_dep, 0);

  if v_entity_type in ('proprietorship', 'huf') then
    select coalesce(sum(
        greatest(least(v_taxable, s.to_rupees) - s.from_rupees + 1, 0) * s.rate_percent / 100
      ), 0) into v_tax_before_rebate
      from public.ref_income_tax_slabs s
     where s.from_rupees <= v_taxable;

    if v_taxable <= 1200000 then
      v_rebate := least(v_tax_before_rebate, 60000);
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
    note := 'Excludes Sec 40(a)/40A(3)/general Sec 43B (non-MSME) disallowances and marginal relief at the Rs 12L rebate taper and each surcharge threshold. Starting estimate, not a filed-return number.';

  elsif v_entity_type in ('partnership', 'llp') then
    -- Book profit for the ceiling test is BEFORE the remuneration
    -- deduction; v_taxable already has it deducted (it flows through
    -- v_book_profit from the ledgers), so add it back to get there.
    v_book_profit_before_remuneration := v_taxable + v_remuneration_booked;

    v_remuneration_ceiling :=
      greatest(300000, 0.90 * least(v_book_profit_before_remuneration, 600000))
      + 0.60 * greatest(v_book_profit_before_remuneration - 600000, 0);

    v_remuneration_disallowed := greatest(v_remuneration_booked - v_remuneration_ceiling, 0);
    v_taxable := v_taxable + v_remuneration_disallowed;

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

  book_profit := round(v_book_profit, 2);
  book_depreciation_addback := round(v_book_dep, 2);
  msme_disallowance_addback := round(v_msme_addback, 2);
  tax_depreciation_deduction := round(v_tax_dep, 2);
  partner_remuneration_booked := round(v_remuneration_booked, 2);
  partner_remuneration_disallowed := round(v_remuneration_disallowed, 2);
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
  'The PGBP bridge and resulting tax by entity type — not a full return. Governed by the Income-tax Act 1961 as amended (AY 2026-27). Firms/LLPs now test the Sec 40(b) remuneration slab ceiling (not the separate 12% interest cap — see this migration''s header); see 0026''s header for why 1961-Act citations are correct here despite 0022-0025 citing the 2025 Act, and for the full list of other deliberately uncomputed provisions.';
