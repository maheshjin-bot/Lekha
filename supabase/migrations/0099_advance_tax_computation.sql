-- ============================================================================
-- 0099 — Advance tax instalments, and Sec 234B/234C interest for falling short
-- ============================================================================
-- get_income_tax_computation (0026, widened by 0079) produces a full-year tax
-- figure and nets off whatever has already been paid. What it does not do —
-- and says so explicitly in its own note column — is tell you whether what
-- was paid, was paid ON TIME against the four instalment dates the Act
-- prescribes, or what it costs when it wasn't. That is this migration.
--
-- THE SCHEDULE THIS APP ALMOST GOT WRONG.
--
-- The brief for this work assumed non-company assessees follow a different,
-- lighter first-instalment schedule than companies. That WAS the law — before
-- Finance Act 2016. A search against the bare text of Sec 211 turned up both
-- versions side by side: pre-2016, a company paid 15/45/75/100% by
-- Jun/Sep/Dec/Mar while every other assessee paid only 30/60/100% starting at
-- Sep 15, with no June instalment at all. The Finance Act 2016 "rationalised"
-- (its word) this into ONE schedule for everyone — 15% by 15 Jun, 45% by 15
-- Sep, 75% by 15 Dec, 100% by 15 Mar, all cumulative, all identical for a
-- proprietorship, an LLP and a public limited company alike — effective from
-- FY 2016-17 and unchanged since (confirmed by a second, independently
-- worded search rather than trusting the first hit, exactly because this is
-- the kind of "obviously the company schedule is stricter" assumption this
-- codebase has been burnt by before, e.g. deemed exports and Rule 88A). The
-- one surviving exception is Sec 44AD/44ADA presumptive-scheme filers, who
-- still pay the whole amount in a single instalment by 15 March — LEKHA does
-- not track presumptive-scheme election anywhere in the schema (entity_type
-- distinguishes proprietorship/HUF/firm/company, not a 44AD/44ADA flag), so
-- this function always applies the standard four-instalment schedule and
-- says so in the summary notes, rather than silently guessing which of a
-- proprietorship's clients opted for presumptive taxation.
--
-- WHERE "PAID" COMES FROM. tax_payments (0079) already has exactly the column
-- needed: minor_head = '100' IS advance tax — the table's own CHECK
-- constraint already limits minor_head to '100'/'300'/'400' for income tax
-- and 100 is documented there as advance tax. No new column, no new enum
-- value — the brief asked to check before adding one, and this one did not
-- need it. Each instalment's "paid so far" is the sum of every minor-head-100
-- challan with payment_date on or before that instalment's due date, so an
-- early payment counts for every later instalment too and a late one does
-- not retroactively count for an earlier one it missed.
--
-- SEC 234C'S ACTUAL MECHANIC — the part the brief specifically flagged as a
-- common source of miscalculation, confirmed against three independent
-- sources (a ClearTax-style instalment table, myITreturn's explainer, and
-- indiankanoon's text of the section):
--   * The instalment-by-instalment REQUIREMENT is 15/45/75/100% of "tax due
--     on the returned income" — which this app cannot know in advance of a
--     filed return, so it uses get_income_tax_computation's own total_tax
--     less TDS/TCS credit as the best available proxy, exactly like 234B's
--     "assessed tax" already does.
--   * There is a SAFE-HARBOUR TOLERANCE, but only at the first two dates: pay
--     at least 12% by 15 Jun, or at least 36% by 15 Sep, and NO interest is
--     charged for that instalment even though the headline figure (15%/45%)
--     was missed. December's 75% and March's 100% have no such tolerance.
--   * The mistake this function deliberately avoids: when the safe harbour
--     IS missed, the interest is NOT computed on the shortfall from the 12%/
--     36% tolerance line — it reverts to the shortfall from the full 15%/45%
--     headline figure. Paying 11% instead of 12% by June does not mean you
--     only owe interest on 1%; the law does not reward almost meeting the
--     tolerance, it withdraws it entirely.
--   * Interest is 1% per month, simple, for 3 months at each of the first
--     three dates and 1 month at the fourth (Rule 119A(b): any part of a
--     month counts as a whole month) — a FIXED charge per instalment, not a
--     running "interest to date" the way 234B is. A shortfall at June costs
--     exactly 3 months' interest whether it is topped up the next day or
--     never at all; this function does not (and per the statute, should not)
--     keep accruing it past that fixed charge.
--   * NOT modelled: the further proviso that shortfall traceable to capital
--     gains, lottery winnings or similarly unforeseeable income is excused if
--     paid in the very next instalment. This schema has no per-instalment
--     income-source attribution to test that against, so every shortfall is
--     treated as ordinary — which can overstate interest for a business with
--     a genuine late capital gain, and that overstatement is the honest
--     direction to err in rather than fabricating an exemption nobody asked
--     the system to verify.
--
-- SEC 234B — the OTHER interest, computed differently on purpose. Where 234C
-- is four fixed one-time charges, 234B is ONE running charge for the year: if
-- total advance tax paid by year end is under 90% of assessed tax (total_tax
-- less TDS/TCS credit — the plain words of Sec 234B(1), which tests advance
-- tax paid alone, not advance tax plus self-assessment tax), interest runs at
-- 1% per month on the shortfall from 1 April following the year until the
-- date asked about (p_as_of_date, today by default). The Act then gives
-- self-assessment tax paid under Sec 140A a second life: interest is
-- recomputed on the reduced balance from the date of that payment onward
-- (Explanation 1/sub-section (2) to 234B) — a genuine two-slab calculation.
-- This function does NOT implement that second slab: it reports the
-- straight-line 1%-per-month figure on the un-netted advance-tax shortfall
-- for the whole elapsed period, which OVERSTATES interest once self-
-- assessment tax has actually been paid mid-period. That is a deliberate,
-- documented simplification in the same direction as the 234C capital-gains
-- gap above — a number that is too high, never one that is too low, so
-- nobody is told they owe less than they might. self_assessment tax paid is
-- still shown in this app's income-tax report; a future pass could split
-- 234B into two legs the way the statute does.
--
-- WHAT THIS FUNCTION DOES NOT DO. It does not post anything — this is a pure
-- read, like get_gst_setoff_computation (0090) before post_gst_setoff. It
-- does not record a challan — tax_payments and its existing /tax-payments
-- screen (0079) already do that, and the report page links there rather than
-- growing a second entry form. It does not generate a Challan 280 or produce
-- anything upload-ready. And where the financial year asked about is still
-- in progress, it says so plainly in liability_estimate_basis instead of
-- quietly presenting a partial-year figure as if it were the annual one —
-- get_income_tax_computation itself only ever sums vouchers actually posted
-- for the requested date range, so a mid-year call is mechanically a partial
-- figure whether or not the caller remembers that.
-- ============================================================================

create or replace function public.get_advance_tax_status(
  p_company_id uuid,
  p_fy_end date,
  p_as_of_date date default current_date
)
returns table (
  row_kind text,                          -- 'summary' | 'instalment'
  applicable boolean,
  entity_type text,
  sec208_applicable boolean,               -- false when estimated liability < Rs 10,000 (Sec 208)
  advance_tax_liability_estimate numeric,  -- total_tax less TDS/TCS credit — the Sec 209 base
  liability_estimate_basis text,           -- honesty note: full-year actual, or partial-year-so-far
  instalment_no smallint,
  instalment_label text,
  due_date date,
  is_due boolean,                          -- false when due_date is still in the future vs p_as_of_date
  cumulative_percent_required numeric,     -- 15 / 45 / 75 / 100
  cumulative_amount_required numeric,
  cumulative_amount_paid numeric,          -- advance tax (minor_head 100) paid on or before due_date
  shortfall_amount numeric,                -- display only; null while not yet due
  safe_harbour_percent numeric,            -- 12 (Jun) / 36 (Sep) / null (Dec, Mar — no tolerance)
  sec234c_interest numeric,                -- fixed one-time charge for THIS instalment
  sec234c_note text,
  total_advance_tax_paid_for_year numeric, -- summary row only
  sec234b_shortfall numeric,               -- summary row only
  sec234b_months integer,                  -- summary row only
  sec234b_interest numeric,                -- summary row only
  total_interest numeric,                  -- summary row only: sec234b_interest + every instalment's sec234c_interest
  as_of_date date,
  notes text
)
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_fy_start date;
  v_fy_label text;
  v_tax record;
  v_base numeric;
  v_liability_basis text;
  v_total_paid_year numeric;
  v_due_dates date[4];
  v_labels text[4];
  v_pcts numeric[4] := array[15, 45, 75, 100];
  v_safe numeric[4] := array[12, 36, null, null];
  v_months int[4] := array[3, 3, 3, 1];
  i int;
  v_paid_to_date numeric;
  v_required_amt numeric;
  v_safe_amt numeric;
  v_shortfall numeric;
  v_interest numeric;
  v_note text;
  v_total_234c numeric := 0;
  v_234b_start date;
  v_234b_shortfall numeric;
  v_234b_months int;
  v_234b_interest numeric;
begin
  -- The schedule is statutorily tied to the Apr-Mar year, so p_fy_end has to
  -- actually be a 31 March — the same calendar tax year get_income_tax_
  -- computation and the /reports/income-tax page already use, deliberately
  -- ignoring any company book-year setting (see that page's own comment).
  if p_fy_end is distinct from app_private.fy_end_date(p_fy_end, 4::smallint) then
    raise exception 'p_fy_end must be a financial year end (31 March) — got %', p_fy_end;
  end if;

  v_fy_start := app_private.fy_start_date(p_fy_end, 4::smallint);
  v_fy_label := app_private.fy_label(v_fy_start, 4::smallint);

  select * into v_tax
    from public.get_income_tax_computation(p_company_id, v_fy_start, p_fy_end);

  if not found then
    row_kind := 'summary';
    applicable := false;
    as_of_date := p_as_of_date;
    notes := 'No company found, or its entity type is not one this app computes income tax for.';
    return next;
    return;
  end if;

  entity_type := v_tax.entity_type;

  if not coalesce(v_tax.applicable, false) then
    row_kind := 'summary';
    applicable := false;
    as_of_date := p_as_of_date;
    notes := coalesce(v_tax.note, 'Not computed for this entity type.');
    return next;
    return;
  end if;

  v_base := greatest(coalesce(v_tax.total_tax, 0) - coalesce(v_tax.tds_tcs_credit, 0), 0);

  if p_fy_end < p_as_of_date then
    v_liability_basis := 'FY ' || v_fy_label || ' has ended. This reads the full Apr-Mar period''s '
      || 'posted transactions — the best figure available today — and will still move if the books '
      || 'are not yet fully closed for the year.';
  else
    v_liability_basis := 'FY ' || v_fy_label || ' is still in progress. This reflects only '
      || 'transactions posted so far (through today), not a full-year estimate, and will understate '
      || 'the true annual liability — treat the required amounts at instalments not yet due as '
      || 'provisional until closer to year end.';
  end if;

  if v_base < 10000 then
    row_kind := 'summary';
    applicable := true;
    sec208_applicable := false;
    advance_tax_liability_estimate := round(v_base, 2);
    liability_estimate_basis := v_liability_basis;
    as_of_date := p_as_of_date;
    notes := 'Estimated tax liability net of TDS/TCS credit is ' || round(v_base, 2)
      || ', below the Rs 10,000 threshold in Sec 208 — no advance tax obligation arises, and Sec '
      || '234B/234C cannot apply.';
    return next;
    return;
  end if;

  v_due_dates[1] := make_date(extract(year from v_fy_start)::int, 6, 15);
  v_due_dates[2] := make_date(extract(year from v_fy_start)::int, 9, 15);
  v_due_dates[3] := make_date(extract(year from v_fy_start)::int, 12, 15);
  v_due_dates[4] := make_date(extract(year from p_fy_end)::int, 3, 15);
  v_labels[1] := '15 Jun ' || extract(year from v_fy_start)::text;
  v_labels[2] := '15 Sep ' || extract(year from v_fy_start)::text;
  v_labels[3] := '15 Dec ' || extract(year from v_fy_start)::text;
  v_labels[4] := '15 Mar ' || extract(year from p_fy_end)::text;

  -- Total advance tax paid for the year, same definition get_income_tax_
  -- computation already uses (no date cap — a challan is a challan whenever
  -- deposited within the year it is labelled for).
  select coalesce(sum(tp.amount), 0) into v_total_paid_year
    from public.tax_payments tp
   where tp.company_id = p_company_id
     and tp.tax_type = 'income_tax'
     and tp.minor_head = '100'
     and tp.financial_year_label = v_fy_label;

  for i in 1..4 loop
    select coalesce(sum(tp.amount), 0) into v_paid_to_date
      from public.tax_payments tp
     where tp.company_id = p_company_id
       and tp.tax_type = 'income_tax'
       and tp.minor_head = '100'
       and tp.financial_year_label = v_fy_label
       and tp.payment_date <= v_due_dates[i];

    v_required_amt := round(v_base * v_pcts[i] / 100, 2);

    row_kind := 'instalment';
    applicable := true;
    entity_type := v_tax.entity_type;
    instalment_no := i;
    instalment_label := v_labels[i];
    due_date := v_due_dates[i];
    is_due := v_due_dates[i] <= p_as_of_date;
    cumulative_percent_required := v_pcts[i];
    cumulative_amount_required := v_required_amt;
    cumulative_amount_paid := round(v_paid_to_date, 2);
    safe_harbour_percent := v_safe[i];
    as_of_date := p_as_of_date;

    if not is_due then
      shortfall_amount := null;
      sec234c_interest := 0;
      sec234c_note := 'Due date not yet reached — shown for planning only.';
    else
      v_shortfall := greatest(v_required_amt - v_paid_to_date, 0);
      shortfall_amount := round(v_shortfall, 2);

      if v_safe[i] is not null then
        v_safe_amt := round(v_base * v_safe[i] / 100, 2);
        if v_paid_to_date >= v_safe_amt then
          v_interest := 0;
          v_note := case when v_shortfall > 0
            then 'Short of the ' || v_pcts[i] || '% headline figure but at or above the '
              || v_safe[i] || '% Sec 234C safe-harbour paid by this date — no interest.'
            else 'Instalment met in full.' end;
        else
          v_interest := round((v_required_amt - v_paid_to_date) * 0.01 * v_months[i], 2);
          v_note := 'Below the ' || v_safe[i] || '% safe-harbour, so the tolerance is withdrawn '
            || 'entirely — interest at 1% per month for ' || v_months[i]
            || ' month(s) on the shortfall from the full ' || v_pcts[i] || '% headline figure.';
        end if;
      else
        if v_paid_to_date >= v_required_amt then
          v_interest := 0;
          v_note := 'Instalment met in full.';
        else
          v_interest := round((v_required_amt - v_paid_to_date) * 0.01 * v_months[i], 2);
          v_note := 'No safe-harbour tolerance at this instalment — interest at 1% per month for '
            || v_months[i] || ' month(s) on the shortfall.';
        end if;
      end if;

      sec234c_interest := v_interest;
      sec234c_note := v_note;
      v_total_234c := v_total_234c + v_interest;
    end if;

    return next;
  end loop;

  -- ---- Sec 234B: one running charge for the year, not four fixed ones ----
  v_234b_start := p_fy_end + 1;  -- 1 April following the financial year
  if p_as_of_date < v_234b_start then
    v_234b_shortfall := 0;
    v_234b_months := 0;
    v_234b_interest := 0;
  elsif v_total_paid_year >= 0.90 * v_base then
    v_234b_shortfall := 0;
    v_234b_months := 0;
    v_234b_interest := 0;
  else
    v_234b_shortfall := greatest(v_base - v_total_paid_year, 0);
    -- Rule 119A(b): any part of a month counts as a whole month. v_234b_start
    -- is always the 1st of a month, so "calendar months elapsed, plus one for
    -- the month in progress" gives exactly that rounding for free.
    v_234b_months := (extract(year from p_as_of_date)::int - extract(year from v_234b_start)::int) * 12
      + (extract(month from p_as_of_date)::int - extract(month from v_234b_start)::int) + 1;
    v_234b_interest := round(v_234b_shortfall * 0.01 * v_234b_months, 2);
  end if;

  row_kind := 'summary';
  applicable := true;
  entity_type := v_tax.entity_type;
  sec208_applicable := true;
  advance_tax_liability_estimate := round(v_base, 2);
  liability_estimate_basis := v_liability_basis;
  instalment_no := null;
  instalment_label := null;
  due_date := null;
  is_due := null;
  cumulative_percent_required := null;
  cumulative_amount_required := null;
  cumulative_amount_paid := null;
  shortfall_amount := null;
  safe_harbour_percent := null;
  sec234c_interest := null;
  sec234c_note := null;
  total_advance_tax_paid_for_year := round(v_total_paid_year, 2);
  sec234b_shortfall := round(v_234b_shortfall, 2);
  sec234b_months := v_234b_months;
  sec234b_interest := v_234b_interest;
  total_interest := round(coalesce(v_234b_interest, 0) + v_total_234c, 2);
  as_of_date := p_as_of_date;
  notes := 'Presumptive-scheme election (Sec 44AD/44ADA — single instalment by 15 March) is not '
    || 'tracked by this schema, so the standard four-instalment schedule is always shown; confirm '
    || 'applicability before relying on the June/September/December figures if this taxpayer files '
    || 'under 44AD/44ADA. Sec 234B here is a straight-line figure on the un-netted advance-tax '
    || 'shortfall for the whole elapsed period and does not give self-assessment tax paid mid-period '
    || 'credit from its actual payment date the way Sec 234B(2) does — a deliberate simplification '
    || 'that can overstate interest, never understate it. Sec 234C does not account for shortfall '
    || 'traceable to a late capital gain or similar unforeseeable income (its own statutory '
    || 'exception), for the same reason.';
  return next;

  return;
end;
$fn$;

revoke all on function public.get_advance_tax_status(uuid, date, date) from public, anon;
grant execute on function public.get_advance_tax_status(uuid, date, date) to authenticated;

comment on function public.get_advance_tax_status(uuid, date, date) is
  'Sec 211 instalment schedule (unified 15/45/75/100% for every assessee since Finance Act 2016 — '
  'there is no company-vs-non-company split any more), what has actually been paid per tax_payments '
  '(minor_head 100), and Sec 234B/234C interest. 234C is four fixed one-time charges per instalment '
  'with a 12%/36% safe-harbour tolerance at the first two dates only; 234B is one running 1%-per- '
  'month charge on the full-year shortfall from 1 April following the year. Presumptive-scheme '
  '(44AD/44ADA) election is not tracked and so not special-cased. Read-only — posts nothing. See 0099.';
