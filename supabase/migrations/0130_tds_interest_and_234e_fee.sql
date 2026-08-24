-- ============================================================================
-- 0130 — Sec 201(1A) interest on late TDS deposit, and Sec 234E late-filing fee
-- ============================================================================
-- Two distinct, independent statutory exposures a TDS deductor carries once a
-- quarter closes: interest for depositing already-deducted tax late (Sec
-- 201(1A)), and a per-day fee for filing the quarterly TDS return late (Sec
-- 234E). Neither was computed anywhere in the app before this migration.
--
-- LAW, CONFIRMED LIVE, INCLUDING THE INCOME-TAX ACT 2025 RENUMBERING. Two
-- independent web searches (a second, deliberately skeptical one specifically
-- chasing the renumbering, matching every prior migration's discipline on
-- this point — 0022/0023/0024/0026/0032 all had to get this right and 0026's
-- header is the clearest statement of the rule) confirm both provisions and
-- their current section numbers on both sides of the 1 April 2026 cutover:
--   * Sec 201(1A)(i) — failure to DEDUCT: interest at 1% per month or part of
--     a month, from the date the tax was deductible to the date it was
--     actually deducted.
--   * Sec 201(1A)(ii) — failure to DEPOSIT after deducting: interest at 1.5%
--     per month or part of a month, from the date of deduction to the date
--     of actual payment. Interest under this limb is due only when the
--     deposit was LATE relative to the statutory due date; the counting
--     period, once due, runs from the deduction date itself — NOT from the
--     due date — which is the well-known quirk that makes even a one-day
--     delay potentially cost two months' interest if the deduction and the
--     due date straddle a calendar-month boundary.
--   * Sec 234E — a fee of Rs 200 for every day of default in filing a
--     TDS/TCS statement, running from the day after the due date to the day
--     the return is actually filed, capped at the TDS/TCS amount deductible
--     for that quarter's statement. This is a FEE (mandatory, no discretion),
--     distinct from and payable before the separate Sec 271H penalty
--     (Rs 10,000-1,00,000, discretionary, not computed here — a genuinely
--     different, assessing-officer-driven provision, out of scope).
--   * Both rates and the Rs 200/day-capped-at-TDS-deductible cap are
--     unchanged by the Income-tax Act, 2025: Sec 201(1A) is recodified as
--     Sec 398(3) (398(3)(a)(i) = 1%, 398(3)(a)(ii) = 1.5%), and Sec 234E is
--     recodified as Sec 427, both effective 1 April 2026 and both carrying
--     forward the exact same rates/cap as their 1961-Act predecessors.
--     Because the arithmetic is identical either side of the cutover, this
--     migration does not branch its computation by date the way 0022/0023
--     branch TDS SECTION applicability — it computes one number and cites
--     both section numbers together, the same "recodified as" phrasing 0023
--     already uses for TCS-SCRAP.
--
-- WHAT THE TDS-RETURN-PREP PAGES SHIPPED EARLIER TODAY ACTUALLY EXPOSE — read
-- live before writing a line of this migration, per the task's own
-- instruction, not assumed:
--   * tax_payments (0079) has payment_date (deposit date) and
--     financial_year_label (the year the payment belongs to) — confirmed via
--     information_schema.columns, reproduced here: id, company_id,
--     branch_id, tax_type, minor_head, financial_year_label, payment_date,
--     amount, bsr_code, challan_serial, challan_reference, tds_section,
--     voucher_id, notes, created_by, created_at, updated_at. THERE IS NO
--     DEDUCTION-DATE OR PERIOD-COVERED COLUMN. voucher_id, when populated,
--     points at the PAYMENT voucher (the bank entry moving money to the
--     government) — not the deduction voucher; the one real row in the
--     database today (Sharma Textiles, see below) has voucher_id null.
--   * No table anywhere records a TDS/TCS RETURN's own filing date. The
--     three tds-return-24q/26q/27q pages (shipped today per this session's
--     own earlier work) are read-only prep exports of get_tds_deductee_summary
--     and tax_payments; none of them write anything, and their own closing
--     disclaimer says plainly "Sec 234E late-fee ... exposure [is] not
--     computed." filing_register (0095) is the one place in the schema a
--     filing date COULD live, if a user manually logged "Form 140 (26Q) / Q1
--     FY 2026-27" there with a filed_date — but that is a general-purpose,
--     free-text log for every statute this app tracks, not a TDS-specific
--     fact this migration can read as authoritative for a specific quarter
--     without first matching form_code/period_label text, which 0095's own
--     header already documents as unreliable for programmatic joining (see
--     its "CONSEQUENCE, STATED RATHER THAN HIDDEN" paragraph). So: NO field
--     anywhere captures an actual TDS return filing date in a form this
--     migration can safely read as ground truth. get_234e_late_fee is
--     therefore built exactly as the task specifies — the caller supplies
--     p_actual_or_hypothetical_filing_date; the function never guesses one
--     and never silently returns a fabricated zero for "we don't know."
--
-- SEC 201(1A)(i) — LATE DEDUCTION — IS NOT JUST HARD TO DERIVE, IT IS
-- STRUCTURALLY UNREPRESENTABLE IN THIS SCHEMA, AND THIS MIGRATION SAYS SO
-- RATHER THAN APPROXIMATE IT. The interest requires two DIFFERENT dates per
-- deduction event: the date the amount became deductible (when the payment
-- was made or credited to the payee, whichever is earlier) and the date TDS
-- was actually deducted. In LEKHA, a single voucher carries exactly one
-- voucher_date shared by every line on it — the expense/party line and the
-- TDS Payable line are always dated identically, because voucher_entries has
-- no per-line date. There is structurally no way to enter "expense credited
-- 1 May, TDS actually deducted 15 May" as two dates in one voucher. Every
-- deduction this schema can record is, by construction, deducted on the same
-- date the liability arose — so late-deduction interest computed from this
-- data would always be zero, not because businesses using this app never
-- deduct late, but because the schema cannot capture the distinction at all.
-- Building a function that always returns 0 for this limb would misrepresent
-- silence as a genuine finding of "no late deduction ever happened" — so
-- Sec 201(1A)(i) is not attempted here. get_tds_late_deposit_interest computes
-- ONLY the late-DEPOSIT limb (201(1A)(ii)) and its own comment says so.
--
-- THE MISSING CHALLAN-TO-DEDUCTION LINK, AND HOW THIS MIGRATION SCOPES
-- AROUND IT. Sec 201(1A)(ii) interest is legally a PER-DEDUCTION calculation
-- (each deduction has its own date, so its own interest clock), but a real
-- deductor deposits ONE lump-sum challan covering a month's worth of
-- deductions, and OLTAS challan 281 itself carries no section-wise or
-- deduction-wise break-up at deposit time (the tds-return-26q page's own
-- header already establishes this for the same reason: "a single challan can
-- legitimately fund entries split across more than one return"). LEKHA's
-- tax_payments has no FK to the deduction voucher(s) a challan settles, and
-- none is invented here. Instead, get_tds_late_deposit_interest treats the
-- TDS-Payable ledger as a single running sub-ledger and FIFO-matches its
-- CREDIT side (deduction events, one row per voucher, from voucher_entries
-- via tax_ledger_map purpose='tds_payable' — the identical event definition
-- 0053's get_tds_deductee_summary already uses) against tax_payments' DEBIT
-- side (challan amounts) in date order: the oldest unpaid deduction rupee is
-- assumed settled by the oldest not-yet-fully-applied challan rupee. This is
-- the same oldest-first assumption every FIFO ageing calculation in
-- accounting makes when a real one-to-one link isn't kept, stated plainly as
-- a candidate allocation, not a verified one — deliberately NOT segmented by
-- tds_section, because a real challan is not section-specific either.
-- Deduction rupees with no challan covering them yet (as of CURRENT_DATE) are
-- shown as 'not_yet_deposited' with interest computed provisionally to
-- today, not silently omitted and not silently zeroed.
--
-- HAND-VERIFICATION DATA ADDED THIS SESSION, both real, both stated in their
-- own tax_payments.notes exactly like the pre-existing 0079/0106 rows did:
--   1. The pre-existing on-time challan (Sharma Textiles, Rs 5,000, 194J-PROF,
--      deducted 20 May 2026, deposited 5 Jun 2026 — 2 days BEFORE the 7 Jun
--      due date) is left untouched and used here to prove the ON-TIME path
--      returns zero interest, not a fabricated non-zero number.
--   2. A NEW real voucher (Sharma Textiles, journal, 3 Jun 2026: Dr
--      Professional Fees 10,000 / Cr Bansal Professional Services (Vendor)
--      9,000 / Cr TDS Payable 1,000, Sec 194J-PROF) plus a NEW real
--      tax_payments challan (Rs 1,000, deposited 20 Jul 2026) were posted via
--      public.create_voucher specifically so this migration has one genuinely
--      LATE deposit to verify against: due 7 Jul 2026, actually paid 20 Jul
--      2026 (13 days late), spanning Jun and Jul — 2 calendar months under
--      the "month or part thereof" rule — expected interest Rs 1,000 x 1.5%
--      x 2 = Rs 30, verified live below.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- app_private.tds_deposit_due_date — the 7th-of-next-month / 30 April rule.
-- Deliberately re-implemented here rather than imported: get_compliance_calendar
-- (0024, extended by 0062/0084/0087/0094) is off-limits to this task and its
-- tds_payment due-date rule lives as a private CTE inside that one function,
-- not callable on its own. This reproduces the EXACT SAME formula, verified
-- against 0084's own tds_payment CTE: month-start of the deduction date, +1
-- month +6 days (7th of next month) — except a March deduction, which gets
-- +1 month +29 days (30 April) instead.
-- ----------------------------------------------------------------------------
create or replace function app_private.tds_deposit_due_date(p_deduction_date date)
returns date
language sql
immutable
set search_path = ''
as $$
  select case when extract(month from date_trunc('month', p_deduction_date)) = 3
              then (date_trunc('month', p_deduction_date) + interval '1 month' + interval '29 days')::date
              else (date_trunc('month', p_deduction_date) + interval '1 month' + interval '6 days')::date
         end;
$$;

comment on function app_private.tds_deposit_due_date is
  'TDS deposit due date for a deduction made on p_deduction_date: 7th of the following month, or 30 April if the deduction was in March. Reproduces get_compliance_calendar''s own tds_payment CTE formula (0024/0084) — that function is off-limits to this migration, so the rule is duplicated here rather than imported; if either ever changes, keep them in agreement by hand.';

-- ----------------------------------------------------------------------------
-- get_tds_late_deposit_interest(company, financial_year_label)
-- ----------------------------------------------------------------------------
create or replace function public.get_tds_late_deposit_interest(
  p_company_id uuid,
  p_financial_year_label text
) returns table (
  deduction_voucher_id uuid,
  deduction_date date,
  due_date date,
  amount_matched numeric,
  challan_id uuid,
  deposit_date date,
  status text,
  months_delayed integer,
  interest_rate_percent numeric,
  interest_amount numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_fy_start int;
  v_fy_start_date date;
  v_fy_end_date date;
  v_today date := current_date;
  d_ids uuid[];
  d_dates date[];
  d_amts numeric[];
  d_remaining numeric[];
  c_ids uuid[];
  c_dates date[];
  c_amts numeric[];
  n_d integer;
  n_c integer;
  di integer := 1;
  v_take numeric;
  v_alloc numeric;
  v_due date;
  v_months integer;
  v_late boolean;
begin
  if p_financial_year_label !~ '^\d{4}-\d{2}$' then
    raise exception 'p_financial_year_label must look like "2026-27"';
  end if;

  v_fy_start := split_part(p_financial_year_label, '-', 1)::int;
  v_fy_start_date := make_date(v_fy_start, 4, 1);
  v_fy_end_date := make_date(v_fy_start + 1, 3, 31);

  -- Deduction events: one row per voucher, credit-side TDS-Payable movement
  -- only — identical event definition to get_tds_deductee_summary (0053).
  select array_agg(x.voucher_id order by x.voucher_date, x.voucher_id),
         array_agg(x.voucher_date order by x.voucher_date, x.voucher_id),
         array_agg(x.amt order by x.voucher_date, x.voucher_id)
    into d_ids, d_dates, d_amts
    from (
      select e.voucher_id, v.voucher_date, sum(e.credit_amount) as amt
        from public.voucher_entries e
        join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
        join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
       where e.company_id = p_company_id
         and m.purpose = 'tds_payable'
         and e.credit_amount > 0
         and not v.is_deleted
         and v.voucher_date between v_fy_start_date and v_fy_end_date
       group by e.voucher_id, v.voucher_date
    ) x;

  n_d := coalesce(array_length(d_ids, 1), 0);
  if n_d = 0 then
    return;
  end if;
  d_remaining := d_amts;

  -- Challans: tax_payments' own financial_year_label is the year the PAYMENT
  -- belongs to (0079's own convention) — trusted as-entered, not re-derived
  -- from payment_date, so a March deduction paid in April still lands in the
  -- FY it was deducted for if the preparer followed that convention.
  select array_agg(t.id order by t.payment_date, t.id),
         array_agg(t.payment_date order by t.payment_date, t.id),
         array_agg(t.amount order by t.payment_date, t.id)
    into c_ids, c_dates, c_amts
    from public.tax_payments t
   where t.company_id = p_company_id
     and t.tax_type = 'tds'
     and t.financial_year_label = p_financial_year_label;

  n_c := coalesce(array_length(c_ids, 1), 0);

  -- FIFO: walk challans oldest-first, consuming the oldest not-yet-settled
  -- deduction rupees first. See migration header for why this is a candidate
  -- allocation, not a verified per-challan link.
  for c_idx in 1..n_c loop
    v_take := c_amts[c_idx];
    while v_take > 0 and di <= n_d loop
      if d_remaining[di] <= 0 then
        di := di + 1;
        continue;
      end if;

      v_alloc := least(v_take, d_remaining[di]);
      v_due := app_private.tds_deposit_due_date(d_dates[di]);
      v_late := c_dates[c_idx] > v_due;
      v_months := case when v_late then
        (extract(year from c_dates[c_idx])::int - extract(year from d_dates[di])::int) * 12
        + (extract(month from c_dates[c_idx])::int - extract(month from d_dates[di])::int) + 1
      else 0 end;

      deduction_voucher_id := d_ids[di];
      deduction_date := d_dates[di];
      due_date := v_due;
      amount_matched := v_alloc;
      challan_id := c_ids[c_idx];
      deposit_date := c_dates[c_idx];
      status := case when v_late then 'late' else 'on_time' end;
      months_delayed := v_months;
      interest_rate_percent := 1.5;
      interest_amount := case when v_late then round(v_alloc * 0.015 * v_months, 2) else 0 end;
      return next;

      d_remaining[di] := d_remaining[di] - v_alloc;
      v_take := v_take - v_alloc;
      if d_remaining[di] <= 0 then
        di := di + 1;
      end if;
    end loop;
  end loop;

  -- Whatever is left unconsumed has no challan yet — interest accrues
  -- provisionally to today (or is not yet due at all if today is still
  -- within the deposit grace period).
  while di <= n_d loop
    if d_remaining[di] > 0 then
      v_due := app_private.tds_deposit_due_date(d_dates[di]);
      v_late := v_today > v_due;
      v_months := case when v_late then
        (extract(year from v_today)::int - extract(year from d_dates[di])::int) * 12
        + (extract(month from v_today)::int - extract(month from d_dates[di])::int) + 1
      else 0 end;

      deduction_voucher_id := d_ids[di];
      deduction_date := d_dates[di];
      due_date := v_due;
      amount_matched := d_remaining[di];
      challan_id := null;
      deposit_date := null;
      status := 'not_yet_deposited';
      months_delayed := v_months;
      interest_rate_percent := 1.5;
      interest_amount := case when v_late then round(d_remaining[di] * 0.015 * v_months, 2) else 0 end;
      return next;
    end if;
    di := di + 1;
  end loop;

  return;
end;
$$;

comment on function public.get_tds_late_deposit_interest is
  'Sec 201(1A)(ii) [Income-tax Act 1961; recodified as Sec 398(3)(a)(ii), Income-tax Act 2025 w.e.f. 1 Apr 2026] interest on LATE DEPOSIT of already-deducted TDS, at 1.5% per month or part thereof, from the date of deduction to the date of actual payment -- computed only when the deposit was after app_private.tds_deposit_due_date(deduction_date). Does NOT compute Sec 201(1A)(i) late-DEDUCTION interest (1%): that limb needs two different dates per event (when deductible vs. when actually deducted) and LEKHA''s voucher model shares one voucher_date across every line, so a late deduction is structurally unrepresentable here, not merely hard to find -- see migration header. Matches deduction events (TDS-Payable credit-side voucher movements, one row per voucher, same definition as get_tds_deductee_summary/0053) against tax_payments challans (tax_type=''tds'') for the same financial_year_label using FIFO date-ordered allocation, because tax_payments has no structural link to which deduction(s) a specific challan settles and OLTAS challan 281 itself carries none either. One result row per (deduction, challan) allocation slice, plus a ''not_yet_deposited'' row for any deduction amount no challan has covered yet, with interest computed provisionally to CURRENT_DATE. A candidate FIFO allocation, not a verified per-challan link.';

revoke all on function public.get_tds_late_deposit_interest(uuid, text) from public, anon;
grant execute on function public.get_tds_late_deposit_interest(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- get_234e_late_fee(company, financial_year_label, quarter, filing_date)
-- ----------------------------------------------------------------------------
create or replace function public.get_234e_late_fee(
  p_company_id uuid,
  p_financial_year_label text,
  p_quarter integer,
  p_actual_or_hypothetical_filing_date date
) returns table (
  quarter_label text,
  quarter_start date,
  quarter_end date,
  due_date date,
  filing_date date,
  days_late integer,
  fee_before_cap numeric,
  tds_deductible_for_quarter numeric,
  fee_after_cap numeric,
  cap_applied boolean,
  note text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_fy_start int;
  v_q_start date;
  v_q_end date;
  v_due date;
  v_days int;
  v_fee_raw numeric;
  v_tds numeric;
  v_fee_capped boolean;
begin
  if p_financial_year_label !~ '^\d{4}-\d{2}$' then
    raise exception 'p_financial_year_label must look like "2026-27"';
  end if;
  if p_quarter not in (1, 2, 3, 4) then
    raise exception 'p_quarter must be 1, 2, 3 or 4';
  end if;
  if p_actual_or_hypothetical_filing_date is null then
    raise exception 'p_actual_or_hypothetical_filing_date is required -- LEKHA has no field anywhere that records a TDS/TCS return''s actual filing date, so this function cannot look one up. Pass the real filing date if known, or a hypothetical "what if filed on X" date to see the exposure at that point -- see migration header.';
  end if;

  v_fy_start := split_part(p_financial_year_label, '-', 1)::int;
  v_q_start := case p_quarter
    when 1 then make_date(v_fy_start, 4, 1)
    when 2 then make_date(v_fy_start, 7, 1)
    when 3 then make_date(v_fy_start, 10, 1)
    when 4 then make_date(v_fy_start + 1, 1, 1)
  end;
  v_q_end := (v_q_start + interval '3 months' - interval '1 day')::date;

  -- Same quarterly due-date rule as get_compliance_calendar's tds_return CTE
  -- (0024/0084) -- Q4 (Jan-Mar) alone gets +4 months, everything else +3,
  -- both +30 days. Reproduced, not imported, for the same off-limits reason
  -- as app_private.tds_deposit_due_date above.
  v_due := case when extract(month from v_q_start) = 1
                then (v_q_start + interval '4 months' + interval '30 days')::date
                else (v_q_start + interval '3 months' + interval '30 days')::date
           end;

  v_days := greatest((p_actual_or_hypothetical_filing_date - v_due), 0);
  v_fee_raw := v_days * 200;

  -- The cap: TDS amount deductible for the quarter. Reuses
  -- get_tds_deductee_summary (0053) rather than re-deriving the same sum a
  -- second way -- this is exactly the Annexure I total already shown on the
  -- tds-return-24q/26q/27q pages for the same quarter, so the cap agrees
  -- with what a preparer already sees there.
  select coalesce(sum(s.tds_deducted), 0) into v_tds
    from public.get_tds_deductee_summary(p_company_id, v_q_start, v_q_end) s;

  v_fee_capped := v_fee_raw > v_tds;

  quarter_label := 'Q' || p_quarter || ' FY ' || p_financial_year_label;
  quarter_start := v_q_start;
  quarter_end := v_q_end;
  due_date := v_due;
  filing_date := p_actual_or_hypothetical_filing_date;
  days_late := v_days;
  fee_before_cap := v_fee_raw;
  tds_deductible_for_quarter := v_tds;
  fee_after_cap := least(v_fee_raw, v_tds);
  cap_applied := v_fee_capped;
  note := case
    when v_days = 0 then 'Filed on or before the due date -- no Sec 234E fee.'
    when v_fee_capped then 'Fee capped at the TDS deductible for the quarter (Sec 234E''s statutory ceiling) -- the uncapped Rs 200/day figure would have been higher.'
    else 'Below the TDS-deductible cap -- the full Rs 200/day figure applies.'
  end;
  return next;
end;
$$;

comment on function public.get_234e_late_fee is
  'Sec 234E [Income-tax Act 1961; recodified as Sec 427, Income-tax Act 2025 w.e.f. 1 Apr 2026] late fee for a TDS/TCS quarterly statement: Rs 200 for every day of default from the day after the statutory due date to p_actual_or_hypothetical_filing_date, capped at the TDS amount deductible for that quarter (from get_tds_deductee_summary/0053, the same total the tds-return-*q prep pages already show). p_actual_or_hypothetical_filing_date is REQUIRED and never defaulted or looked up: verified live that no table in this schema records a TDS/TCS return''s actual filing date (tax_payments has none; filing_register/0095 is a general free-text log this function does not attempt to match programmatically -- see migration header) -- so the caller supplies either the real filing date, if known from outside this app, or a hypothetical one to see the exposure "as if" filed on that date. Does not compute the separate, discretionary Sec 271H penalty.';

revoke all on function public.get_234e_late_fee(uuid, text, integer, date) from public, anon;
grant execute on function public.get_234e_late_fee(uuid, text, integer, date) to authenticated;

notify pgrst, 'reload schema';
