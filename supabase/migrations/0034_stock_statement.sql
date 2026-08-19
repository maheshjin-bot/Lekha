-- ============================================================================
-- 0034 — Stock statement / drawing power: the monthly submission to a lender
-- ============================================================================
-- ref_modules (0004) has named this module since the very first migration —
-- code 'stock_statement', tier optional, depends_on {banking,inventory},
-- description "Monthly submission to the lender" — but nothing computed it.
-- 0017's own header comment on get_party_outstanding already anticipated
-- this report by name: "a lender reading a drawing-power calculation is
-- entitled to know whether 'over 90 days' is allocated or inferred". This
-- migration is that report, built from two functions that already exist —
-- get_stock_summary (0013) and get_party_outstanding (0017) — plus three new
-- company-level settings for the one genuinely bank-specific input: margins.
--
-- FORMULA (researched fresh, standard across Indian CC/OD sanction letters):
--   Paid stock      = closing stock value − sundry creditors (floored at 0)
--                      A bank lends against stock the borrower has actually
--                      paid for; stock still financed by trade credit is the
--                      creditor's collateral, not collateral for the bank.
--   DP from stock    = paid stock × (1 − stock margin%)
--   Eligible debtors = total debtors − debtors older than the eligibility
--                      window (typically 90 days; some sanctions use 60 or
--                      30 — see debtor_eligibility_days below)
--   DP from debtors  = eligible debtors × (1 − debtor margin%)
--   Drawing power    = DP from stock + DP from debtors
-- Typical margins run ~25% on stock, ~40% on debtors, but both are genuinely
-- bank/facility-specific — hence the settings, not a hardcoded constant.
--
-- SCOPE CUT — v1, one facility per company, not a loan/facility master.
-- P4 "Banking & stock statement" in the roadmap is explicitly broader (loan
-- master, multiple facilities, drawing power per facility, QIS, Account
-- Aggregator) and stays open; this is the single most valuable slice of it,
-- matching the roadmap's own framing of this item as "not actually an AI
-- feature — a report over data that already exists". A company with two
-- facilities from two different banks, each with its own margins, is not
-- representable yet — the settings are company-wide, not per-facility.
--
-- debtor_eligibility_days is constrained to {30,60,90} rather than a free
-- day count because get_party_outstanding's own ageing buckets are fixed at
-- those boundaries (0017) — a parameterised ageing function is a real,
-- separate piece of work this does not attempt. Also not modelled: excluding
-- specific stock as obsolete/uninsured/at an unapproved location, or specific
-- debtors as disputed — both are manual judgement calls a lender's own field
-- inspection makes, not something ledger data alone can answer. Raw
-- material/WIP/finished-goods stock categorisation (Part A of the standard
-- bank format) is also not modelled — LEKHA's inventory has no manufacturing
-- stage tracking (P3 explicitly excluded manufacturing/BOM), so every item is
-- one undifferentiated stock figure.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- companies: bank facility margin settings
-- ----------------------------------------------------------------------------
alter table public.companies
  add column stock_margin_percent numeric(5,2) not null default 25
    check (stock_margin_percent >= 0 and stock_margin_percent <= 100),
  add column debtor_margin_percent numeric(5,2) not null default 40
    check (debtor_margin_percent >= 0 and debtor_margin_percent <= 100),
  add column debtor_eligibility_days smallint not null default 90
    check (debtor_eligibility_days in (30, 60, 90));

comment on column public.companies.stock_margin_percent is
  'The bank''s margin on paid stock for drawing power, per this company''s CC/OD sanction letter. Defaults to 25% (borrower gets 75% credit), the typical figure — not a statutory rate, a per-facility negotiated one. LEKHA cannot know your actual sanctioned margin; confirm it against your own sanction letter.';
comment on column public.companies.debtor_margin_percent is
  'The bank''s margin on eligible debtors for drawing power. Defaults to 40% (borrower gets 60% credit), the typical figure — same caveat as stock_margin_percent.';
comment on column public.companies.debtor_eligibility_days is
  'Debtors older than this many days from their invoice date are excluded from drawing power entirely (not just margined down). Constrained to {30,60,90} because get_party_outstanding''s ageing buckets are fixed at those boundaries — see this migration''s header.';


-- ----------------------------------------------------------------------------
-- get_drawing_power(company, as_at)
-- ----------------------------------------------------------------------------
create or replace function public.get_drawing_power(
  p_company_id uuid,
  p_as_at date default current_date
) returns table (
  closing_stock_value numeric,
  sundry_creditors numeric,
  paid_stock numeric,
  stock_margin_percent numeric,
  dp_from_stock numeric,
  total_debtors numeric,
  ineligible_debtors numeric,
  eligible_debtors numeric,
  debtor_eligibility_days smallint,
  debtor_margin_percent numeric,
  dp_from_debtors numeric,
  total_drawing_power numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_stock_margin numeric;
  v_debtor_margin numeric;
  v_elig_days smallint;
  v_stock numeric := 0;
  v_creditors numeric := 0;
  v_paid_stock numeric;
  v_total_debtors numeric := 0;
  v_ineligible numeric := 0;
  v_eligible numeric;
begin
  select c.stock_margin_percent, c.debtor_margin_percent, c.debtor_eligibility_days
    into v_stock_margin, v_debtor_margin, v_elig_days
    from public.companies c
   where c.id = p_company_id;

  if v_stock_margin is null then
    return; -- company not found
  end if;

  select coalesce(sum(s.closing_value), 0) into v_stock
    from public.get_stock_summary(p_company_id, p_as_at) s;

  select coalesce(sum(o.outstanding), 0) into v_creditors
    from public.get_party_outstanding(p_company_id, p_as_at, 'creditor') o;

  -- Paid stock: floored at zero rather than letting a creditor balance
  -- larger than the stock itself produce a negative figure.
  v_paid_stock := greatest(v_stock - v_creditors, 0);

  -- Ineligible debtors: whichever buckets fall outside the eligibility
  -- window, summed per ledger row so a mixed book (some old, some fresh)
  -- nets correctly rather than being all-or-nothing per party.
  select
      coalesce(sum(o.outstanding), 0),
      coalesce(sum(
        case v_elig_days
          when 30 then o.outstanding - o.not_due - o.days_0_30
          when 60 then o.outstanding - o.not_due - o.days_0_30 - o.days_31_60
          else        o.outstanding - o.not_due - o.days_0_30 - o.days_31_60 - o.days_61_90
        end
      ), 0)
    into v_total_debtors, v_ineligible
    from public.get_party_outstanding(p_company_id, p_as_at, 'debtor') o;

  v_eligible := greatest(v_total_debtors - v_ineligible, 0);

  closing_stock_value := round(v_stock, 2);
  sundry_creditors := round(v_creditors, 2);
  paid_stock := round(v_paid_stock, 2);
  stock_margin_percent := v_stock_margin;
  dp_from_stock := round(v_paid_stock * (1 - v_stock_margin / 100), 2);
  total_debtors := round(v_total_debtors, 2);
  ineligible_debtors := round(greatest(v_ineligible, 0), 2);
  eligible_debtors := round(v_eligible, 2);
  debtor_eligibility_days := v_elig_days;
  debtor_margin_percent := v_debtor_margin;
  dp_from_debtors := round(v_eligible * (1 - v_debtor_margin / 100), 2);
  total_drawing_power := dp_from_stock + dp_from_debtors;
  return next;
end;
$$;

comment on function public.get_drawing_power is
  'Monthly stock statement / drawing power for a bank CC or OD facility: paid stock (closing stock less sundry creditors) and eligible debtors (within debtor_eligibility_days), each margined per the company''s own settings, summed to a drawing power figure. One facility per company, not a loan master — see the migration header. Not a sanctioned limit; compare this against the actual sanction letter''s limit yourself, the lower of the two is the real drawing power.';
