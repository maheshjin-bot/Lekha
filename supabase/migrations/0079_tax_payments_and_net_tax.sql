-- ============================================================================
-- 0079 — What was already paid: tax challans, TDS suffered, and a net figure
-- ============================================================================
-- get_income_tax_computation ended at tax + surcharge + cess and called that
-- total_tax. A user reading that as "the amount to pay" pays it a second time,
-- because it takes no account of:
--
--   * ADVANCE TAX already deposited during the year (Sec 208-211, four
--     instalments), and self-assessment tax paid before filing (Sec 140A);
--   * TDS ALREADY DEDUCTED BY THE COMPANY'S OWN CUSTOMERS on its receipts,
--     which is tax paid on its behalf and creditable under Sec 199.
--
-- Neither was representable. There was no record of a tax challan anywhere in
-- the schema, and the company-as-DEDUCTEE was not modelled at all -- live
-- tax_ledger_map carried thirteen purposes and every one of them was a
-- liability or an input-credit; there was no receivable side, and
-- seed_tds_ledgers provably seeds only "TDS Payable". So this migration adds
-- the two missing pieces and then nets the computation with them.
--
-- (1) tax_payments — ONE TABLE FOR EVERY CHALLAN.
--
-- Deliberately one table rather than three. Challan 280 (income tax), challan
-- 281 (TDS/TCS deposits) and GST PMT-06 differ in which fields apply, not in
-- shape: each is an amount, a date, a period, and a bank reference. Three
-- near-identical tables would triple the RLS, the indexes and the UI for no
-- gain, and would make "what have we paid this year" a three-way union.
--
-- FIELDS RESEARCHED, NOT ASSUMED. The Challan Identification Number is not a
-- single opaque string: CIN = the 7-digit BSR code of the receiving bank
-- branch + the date of deposit + a 5-digit challan serial number for that
-- branch on that day. Those three are exactly what an ITR asks for when
-- claiming credit for a payment, so they are stored as separate, format-
-- checked columns rather than as one free-text field that cannot be validated
-- or matched against 26AS later. GST's PMT-06 uses a differently shaped
-- CIN/BRN, so it gets its own free-text column instead of being forced into
-- the BSR/serial pair.
--
-- MINOR HEAD matters and is a documented source of error: 100 is advance tax,
-- 300 is self-assessment, 400 is tax on regular assessment (a demand). Picking
-- the wrong one misclassifies the payment and breaks the credit, so it is a
-- checked column and is REQUIRED for income tax. It is meaningless for TDS
-- deposits and GST, where it must be null.
--
-- (2) TDS RECEIVABLE — the company as deductee.
--
-- A new 'tds_receivable' purpose in tax_ledger_map and a "TDS Receivable"
-- ledger under Current Assets, seeded for every existing company. It is an
-- ASSET: tax paid to the government on the company's behalf, recoverable
-- against its own liability.
--
-- No new posting RPC is needed and none is added. Recording it is an ordinary
-- receipt the user already knows how to enter -- Dr Bank 90, Dr TDS Receivable
-- 10, Cr Customer 100 -- and the only thing that was missing was a ledger to
-- debit. Inventing an RPC would add a second way to do something the voucher
-- form already does correctly.
--
-- (3) NET TAX.
--
-- get_income_tax_computation is rewritten again (return type widened, so
-- dropped and recreated -- grants re-issued, and a test pins them). It now
-- reports advance tax, self-assessment tax and TDS/TCS credit for the year,
-- and a net figure that is positive when tax is still payable and negative
-- when a refund is due.
--
-- The TDS credit is read from the ledger's DEBIT MOVEMENT during the year, not
-- from its closing balance. The balance carries forward until the refund is
-- actually received, so using it would double-count last year's credit against
-- this year's liability -- the same class of error 0073 fixed on the balance
-- sheet, and worth stating explicitly so nobody 'simplifies' it later.
--
-- SCOPE, stated rather than implied. Sec 234A/234B/234C interest for shortfall
-- or deferment of advance tax is NOT computed -- it needs instalment-wise due
-- dates checked against instalment-wise payments, which the table can now
-- support but which is its own piece of work. Nor is this reconciled against
-- 26AS/AIS: those are download-only from the portal, and matching them is a
-- separate feature that this table is the prerequisite for.
-- ============================================================================

create table if not exists public.tax_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,

  -- Which levy this challan settles.
  tax_type text not null check (tax_type in ('income_tax', 'tds', 'tcs', 'gst')),

  -- Challan 280 minor head. Required for income tax, meaningless otherwise.
  minor_head text check (minor_head is null or minor_head in ('100', '300', '400')),

  -- The year the payment belongs TO, which is not always the year it was made
  -- in: self-assessment tax for 2026-27 is typically paid in 2027-28.
  financial_year_label text not null,

  payment_date date not null,
  amount numeric(14, 2) not null check (amount > 0),

  -- CIN components. Kept separate because an ITR asks for each of them
  -- individually when claiming credit, and because a single opaque string
  -- cannot be validated or matched against 26AS later.
  bsr_code text check (bsr_code is null or bsr_code ~ '^[0-9]{7}$'),
  challan_serial text check (challan_serial is null or challan_serial ~ '^[0-9]{1,5}$'),

  -- GST PMT-06 CIN/BRN, which is shaped differently from the OLTAS triple.
  challan_reference text,

  -- For TDS/TCS deposits: the section the tax was deducted under.
  tds_section text,

  -- The payment voucher, when the money movement was also booked.
  voucher_id uuid references public.vouchers(id) on delete set null,

  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A minor head is exactly the set of things challan 280 asks for, so it is
  -- required for income tax and rejected for everything else.
  constraint tax_payments_minor_head_matches_type check (
    (tax_type = 'income_tax' and minor_head is not null)
    or (tax_type <> 'income_tax' and minor_head is null)
  )
);

create index if not exists tax_payments_company_year_idx
  on public.tax_payments (company_id, financial_year_label, tax_type);
create index if not exists tax_payments_company_date_idx
  on public.tax_payments (company_id, payment_date);

alter table public.tax_payments enable row level security;

drop policy if exists tax_payments_read on public.tax_payments;
create policy tax_payments_read on public.tax_payments
  for select using ((select app_private.is_company_member(company_id)));

drop policy if exists tax_payments_write on public.tax_payments;
create policy tax_payments_write on public.tax_payments
  for all using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

drop trigger if exists set_updated_at on public.tax_payments;
create trigger set_updated_at
  before update on public.tax_payments
  for each row execute function app_private.set_updated_at();

comment on table public.tax_payments is
  'Tax challans: income tax (280), TDS/TCS deposits (281) and GST (PMT-06). One table because the three differ in which fields apply, not in shape. CIN is stored as its real components — BSR code, deposit date, challan serial — because an ITR asks for each separately. See 0079.';

-- ----------------------------------------------------------------------------
-- The company as deductee
-- ----------------------------------------------------------------------------
create or replace function app_private.seed_tds_receivable_ledger(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_group uuid;
  v_ledger uuid;
begin
  if exists (
    select 1 from public.tax_ledger_map
     where company_id = p_company_id and gst_registration_id is null and purpose = 'tds_receivable'
  ) then
    return;
  end if;

  -- An asset, not a duty: tax already paid on the company's behalf.
  select id into v_group
    from public.account_groups
   where company_id = p_company_id and name = 'Current Assets'
   limit 1;
  if v_group is null then
    raise exception 'No Current Assets group found; seed the chart of accounts first';
  end if;

  -- ledgers_company_name_idx is case-insensitively unique, so adopt an
  -- existing ledger of this name rather than colliding with it — the same
  -- care seed_tds_ledgers takes.
  select id into v_ledger
    from public.ledgers
   where company_id = p_company_id and lower(name) = 'tds receivable'
   limit 1;

  if v_ledger is null then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type)
    values (p_company_id, v_group, 'TDS Receivable', 'debit')
    returning id into v_ledger;
  end if;

  insert into public.tax_ledger_map (company_id, gst_registration_id, purpose, ledger_id)
  values (p_company_id, null, 'tds_receivable', v_ledger);
end;
$fn$;

do $backfill$
declare
  r record;
begin
  for r in select id from public.companies loop
    perform app_private.seed_tds_receivable_ledger(r.id);
  end loop;
end;
$backfill$;

-- ----------------------------------------------------------------------------
-- Net the computation
-- ----------------------------------------------------------------------------
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
  'Income tax computation, net of what has already been paid: advance tax and self-assessment from tax_payments, plus TDS suffered read as the year MOVEMENT on the TDS Receivable ledger (never its carried-forward balance). net_tax_payable is positive when tax is due and negative when a refund is. Sec 234A/B/C interest is not computed. See 0079.';
