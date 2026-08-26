-- ============================================================================
-- 0225 — GSTR-3B Table 5.1: Sec 50(1) interest and Sec 47(1) late fee
-- ============================================================================
-- 0129's own header named this table as the one deliberate gap in its GSTR-3B
-- prep work and said exactly why: tax_payments (0079) has no column linking a
-- GST challan to the specific return PERIOD it settles — only
-- financial_year_label (the year, for income tax's own annual computation)
-- and a single payment_date. Guessing that a payment dated in month M settles
-- month M-1's liability would have been precisely the kind of unverified
-- assumption this codebase's own discipline exists to catch. This migration
-- closes that gap the way 0129 itself proposed: by adding the missing period
-- columns, populated going forward, never backfilled as a guess for historical
-- challans.
--
-- SCHEMA CONFIRMED LIVE BEFORE WRITING A LINE OF THIS MIGRATION:
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='tax_payments';
--   -> id, company_id, branch_id, tax_type, minor_head, financial_year_label,
--      payment_date, amount, bsr_code, challan_serial, challan_reference,
--      tds_section, voucher_id, notes, created_by, created_at, updated_at.
--   No period_start/period_end/period_month column existed. Confirms 0129's
--   own claim exactly.
--
-- PERIOD_START/PERIOD_END, NOT A period_label STRING — WHY THIS DIFFERS FROM
-- filing_register's (0095) OWN CHOICE. 0095 deliberately made period_label
-- free TEXT because the statutory grain genuinely differs by FORM (monthly,
-- quarterly, half-yearly on two different halves, annual) and that table's
-- own job is a human-readable log, not date arithmetic — its header states
-- plainly that "sort by period" is NOT reliably possible on that column for
-- exactly this reason. This feature is the opposite case: it has to compare a
-- payment's period against a due date computed to the DAY (20th of the
-- following month, or the 22nd/24th of the month after a QRMP quarter) and a
-- period possibly spanning either a month or a quarter. A checked pair of
-- real DATE columns supports exact equality matching against whatever bounds
-- get_gstr3b_table5_1 below computes for a given registration's own filing
-- frequency, for both grains, with no string-format assumption baked in (the
-- gstr2b_lines.return_period 'YYYY-MM' convention from 0120 was considered
-- and rejected for the same reason: it cannot represent a QRMP quarter
-- without inventing a second, incompatible text convention alongside it).
--
-- NULLABLE, POPULATED GOING FORWARD ONLY. Every existing tax_payments row
-- (income tax, TDS, TCS, and every GST challan recorded before this
-- migration) keeps period_start/period_end at null — there is no reliable
-- way to infer which return period a historical challan settled, and
-- fabricating one would be exactly the guess 0129 refused to make. A null
-- period on a GST row simply never matches any period this feature computes,
-- which is the honest outcome: "we don't know what period this settled."
-- Meaningful only for tax_type = 'gst' in practice (income tax and TDS/TCS
-- already have their own period concepts — financial_year_label and, for
-- TDS, the deduction-voucher-to-challan FIFO match in 0130) but not
-- CHECK-restricted to GST only: a future feature for TDS/TCS quarterly
-- period-tagging could reuse the same two columns rather than inventing a
-- third naming convention.
--
-- LAW, CONFIRMED LIVE WITH A SECOND, SKEPTICAL SEARCH ON EVERY FIGURE BELOW
-- (all August 2026, current for FY 2026-27 / return periods filed in 2026):
--
--   DUE DATE — Sec 39(7) r/w Rule 61(1). Monthly filer: 20th of the month
--   following the return period (confirmed, matches 0129's own header and
--   get_compliance_calendar's gstr3b CTE, reproduced not imported below for
--   the same off-limits reason 0130 already established for its own due-date
--   helpers — get_compliance_calendar is reserved for the agm-calendar-wiring
--   task this round). QRMP filer: NOT a flat date — 22nd of the month after
--   the quarter for "Category X" states, 24th for "Category Y" states
--   (Notification 84/2020-CT and successors; confirmed against three
--   independent 2026 sources — dmifinance.in, gimbooks.com, taxsolver.in, all
--   agreeing on the same state lists). LEKHA already tracks BOTH facts this
--   needs and 0129's own header was WRONG to say otherwise: gst_registrations
--   (0005) has had a filing_frequency ('monthly'/'qrmp') column since day
--   one, and ref_states (0002) carries qrmp_category ('X'/'Y', null only for
--   the two non-state codes 96 "Other Country" / 97 "Other Territory") —
--   confirmed live, reproduced in get_compliance_calendar's own gst_regs CTE
--   (0024) since that function's first version. So unlike 0130's Sec 234E
--   fee (which genuinely had no filing-date field to read), this feature does
--   NOT need the caller to specify a filer type — it reads the registration's
--   own real election and computes the correct due date automatically. Every
--   live registration today is 'monthly' (confirmed below), so the qrmp path
--   is verified in a rolled-back transaction against synthetic category
--   flags, the same discipline 0090 used for its then-unexercised cess lane.
--
--   INTEREST — Sec 50(1), 18% p.a., confirmed still current. The 2019
--   proviso (retrospective from 1 Jul 2017 via Notification 16/2021-CT)
--   confines it to tax paid by DEBITING THE ELECTRONIC CASH LEDGER, not gross
--   output tax — matching what get_gstr3b_table6_1's own cash_tax_payable
--   already isolates, so this migration bases interest on exactly that figure
--   rather than re-deriving it. Computed on a DAILY basis (confirmed:
--   cleartax.in's 2026 interest-changes coverage states the formula as
--   principal x days-delayed/365 x 18%, not TDS's "month or part thereof"
--   convention 0130 used for Sec 201(1A) — a different provision, a different
--   counting rule, not copied from that migration by mistake).
--
--   RULE 88B(1) MINIMUM-CASH-BALANCE NUANCE — CONFIRMED, AND DELIBERATELY NOT
--   MODELLED, SAID SO RATHER THAN SILENTLY SIMPLIFIED. A live GSTN portal
--   advisory (6 Mar 2026, "Re-Computation of Interest under Table 5.1 of
--   GSTR-3B") confirms that from the January 2026 tax period the PORTAL's own
--   auto-computed Table 5.1 interest gives credit for any cash balance
--   already sitting in the Electronic Cash Ledger between the due date and
--   the date it was actually offset — i.e. a taxpayer who deposited cash into
--   the ECL on time but only ran GSTR-3B's own "offset liability" step a few
--   days later owes LESS interest than a naive due-date-to-challan-date
--   calculation would suggest, per the Rule 88B(1) proviso. That advisory is
--   about a PORTAL AUTO-POPULATION bug/fix, not a change to the 18% rate or
--   the underlying law. LEKHA's tax_payments records discrete CHALLAN DEPOSIT
--   events, not a running Electronic Cash Ledger balance — there is no way to
--   know from this schema whether cash sat unoffset in the ECL for days
--   before the return was actually filed. get_gstr3b_table5_1 below therefore
--   uses the simpler, more conservative due-date-to-payment-date calculation
--   (interest never UNDER-stated, may OVER-state it for a taxpayer whose real
--   cash-ledger timing was more generous than their challan date alone
--   suggests) — the same directional choice 0130 made for its own FIFO
--   deduction-to-challan match, stated explicitly rather than left implicit.
--
--   LATE FEE — Sec 47(1), confirmed still current, unchanged since
--   Notification 19/2021-CT (1 Jun 2021): Rs 50/day (Rs 25 CGST + Rs 25
--   SGST/UTGST — NO separate IGST or Cess late fee component; confirmed
--   independently that Sec 47 late fee is charged only under the CGST and
--   SGST Acts, never under the IGST Act or the Compensation Cess Act, so
--   those two columns read 0 by statute, not by omission) for an ordinary
--   return, Rs 20/day (Rs 10 + Rs 10) for a NIL return, both subject to a
--   turnover-tiered cap that a second, skeptical search confirmed is STILL
--   the permanent 2021 structure, not superseded: Rs 2,000 for AATO
--   (Aggregate Annual Turnover, PRECEDING financial year) up to Rs 1.5 crore,
--   Rs 5,000 for Rs 1.5-5 crore, Rs 10,000 above Rs 5 crore; Rs 500 flat for a
--   NIL return regardless of turnover.
--
--   "AATO" HERE IS THE SAME SINGLE-REGISTRATION PROXY 0155 ALREADY USED AND
--   DOCUMENTED, NOT A NEW LIMITATION. "Aggregate turnover" is a Sec 2(6)
--   PAN-WIDE concept, and this schema (like every read function before it —
--   confirmed 0155's header makes the identical point for GSTR-9C Table 5)
--   cannot sum turnover across a company's other GST registrations because
--   nothing links sibling registrations together as one legal person for this
--   purpose. get_turnover_preceding_fy below sums get_gst_output_register's
--   own taxable_value for THIS ONE registration's own preceding financial
--   year (always 1 Apr-31 Mar, GST's own fixed year, never this company's
--   configured book year) — exact for every company in this database today
--   (each holds exactly one registration, same fact 0129 verified) and a
--   proxy, understating a true multi-GSTIN AATO, otherwise.
--
--   NIL-RETURN, THE Rs 20/DAY RATE'S OWN TRIGGER — ALSO A PROXY, STATED AS
--   ONE, AND ONE THAT HAND-VERIFICATION (BELOW) CAUGHT A REAL FIRST DRAFT
--   MISTAKE ON. A genuine "NIL return" under Sec 47(1)'s reduced rate means
--   nothing at all was reported that period — no outward supply, no inward
--   RCM supply, no ITC claimed. Table 3.1/3.2 (outward supplies) are
--   themselves NOT built anywhere in this app (0129's own documented cut —
--   portal auto-populated from GSTR-1, locked for edit) so this cannot read
--   the real Table 3.1 the way a filed return would. The first draft of
--   is_nil_return_proxy read "zero rows from get_gst_output_register (0035)
--   for the period" as its outward-supply signal — live testing against this
--   migration's own hand-verification data (below) immediately proved that
--   wrong: get_gst_output_register filters to
--   voucher_type in ('sales','credit_note') only (confirmed against its own
--   SQL), so a real ₹1.5+ lakh output-tax liability posted through a plain
--   journal voucher (exactly how the verification data below is posted, the
--   same technique 0090/0130 already used) was invisible to it, and the
--   period was wrongly flagged nil. Fixed to use get_gstr3b_table6_1's own
--   gross tax_payable per head (summed across all four) instead — the same
--   ledger-closing-balance computation cash_tax_payable itself already comes
--   from, so it sees every voucher type alike, not only sales/credit_note —
--   combined with Table 4(A)'s total ITC and Table 4's own
--   a3_rcm_memo_liability_accrued (RCM inward supply also makes a period
--   NOT nil even though 0102 posts no matching ITC leg). A company with a
--   genuinely non-taxable outward supply this quarter that touches none of
--   those three signals would still be misclassified by this test — flagged
--   in the note column on every call, not silently trusted as exact.
--
--   MULTIPLE CHALLANS AGAINST ONE PERIOD — A SIMPLER RULE THAN 0130's FIFO,
--   FOR A CONCRETE SCHEMA REASON. 0130's TDS interest FIFO-matches individual
--   challan RUPEES against individual deduction rupees because a single TDS
--   challan genuinely funds a running Payable sub-ledger one voucher at a
--   time. A GST challan is different: tax_payments.amount is ONE scalar per
--   challan row with NO per-head (IGST/CGST/SGST/Cess) breakdown at all
--   (confirmed against the same information_schema query above), so there is
--   no way to know from this schema which HEAD a given rupee of a challan
--   actually funded when more than one challan is tagged to the same period.
--   get_gstr3b_table5_1 therefore does not attempt a per-rupee allocation: it
--   uses the LATEST matched payment_date as the settlement date applied to
--   the FULL net cash liability of every head alike (a deliberately
--   conservative reading — a rupee actually paid via an earlier partial
--   challan is treated as if it waited for the last one too, so this can only
--   OVER-state interest for a split payment, never under-state it) and shows
--   the matched challan count/total alongside the computed liability so a
--   preparer can see and investigate any material mismatch themselves, rather
--   than this function silently picking one figure over the other.
--
--   THE PAYMENT-DATE-AS-FILING-DATE PROXY — THE SAME HONEST GAP 0130's Sec
--   234E FUNCTION ALREADY DOCUMENTED FOR TDS RETURNS, INHERITED HERE FOR GST.
--   No table anywhere in this schema records a GSTR-3B return's own actual
--   filing date (filing_register/0095 COULD hold one if a user logged it, but
--   0095's own header already establishes free-text period_label cannot be
--   safely joined against a computed date range — see above). On the GST
--   portal, though, a return literally cannot be filed until its net cash
--   liability has been offset from a sufficiently funded Electronic Cash
--   Ledger, so the last cash-ledger top-up for a period is very close to,
--   and never later than, the real filing date in ordinary practice. This
--   migration uses the matched challan's own payment_date as that practical
--   proxy for BOTH interest (statutorily exact — Sec 50 cares about the
--   payment date itself, not the filing date) and late fee (a proxy for the
--   actually-unmeasurable filing date) — stated as a proxy, not fabricated as
--   a verified fact, in the note column on every call.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- tax_payments.period_start / period_end
-- ----------------------------------------------------------------------------
alter table public.tax_payments
  add column if not exists period_start date,
  add column if not exists period_end date;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tax_payments_period_bounds_check'
  ) then
    alter table public.tax_payments
      add constraint tax_payments_period_bounds_check
      check (
        (period_start is null and period_end is null)
        or (period_start is not null and period_end is not null and period_end >= period_start)
      );
  end if;
end;
$$;

comment on column public.tax_payments.period_start is
  'First day of the return/deposit period this challan settles (e.g. 2026-09-01 for a September GSTR-3B, or a quarter''s own first day for a QRMP filer). Nullable and NOT backfilled for any challan recorded before migration 0225 -- there is no reliable way to infer a historical challan''s period from payment_date alone (a preparer can legitimately pay two months in one challan, or pay an old period late alongside a current one on time). Meaningful today for tax_type=''gst'' (get_gstr3b_table5_1 matches on this pair) but not CHECK-restricted to GST only. See 0225.';
comment on column public.tax_payments.period_end is
  'Last day of the return/deposit period this challan settles -- paired with period_start, both null or both set, period_end >= period_start. See 0225 and the period_start comment.';


-- ----------------------------------------------------------------------------
-- app_private.gstr3b_due_date -- reproduces get_compliance_calendar's own
-- gstr3b CTE formula (0024), NOT imported: that function is reserved this
-- round for the agm-calendar-wiring task, the same off-limits reason 0130
-- already established for duplicating its own due-date helpers rather than
-- calling the calendar. If either ever changes, keep them in agreement by
-- hand.
-- ----------------------------------------------------------------------------
create or replace function app_private.gstr3b_due_date(
  p_return_period_start date,
  p_filing_frequency text,
  p_qrmp_category text default null
)
returns date
language sql
immutable
set search_path = ''
as $$
  select case
    when p_filing_frequency = 'qrmp' then
      (date_trunc('quarter', p_return_period_start) + interval '3 months'
        + (case p_qrmp_category when 'X' then interval '21 days' else interval '23 days' end)
      )::date
    else
      (date_trunc('month', p_return_period_start) + interval '1 month' + interval '19 days')::date
  end;
$$;

comment on function app_private.gstr3b_due_date(date, text, text) is
  'GSTR-3B due date for the return period containing p_return_period_start: 20th of the following month for a monthly filer, or 22nd (Category X states) / 24th (Category Y) of the month after the quarter for a QRMP filer. Reproduces get_compliance_calendar''s own gstr3b CTE (0024) -- that function is off-limits to this migration, so the rule is duplicated rather than imported. See 0225.';

revoke all on function app_private.gstr3b_due_date(date, text, text) from public, anon;
grant execute on function app_private.gstr3b_due_date(date, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- app_private.gst_late_fee_cap -- Notification 19/2021-CT's turnover-tiered
-- Sec 47(1) cap, confirmed still current (see migration header).
-- ----------------------------------------------------------------------------
create or replace function app_private.gst_late_fee_cap(
  p_is_nil_return boolean,
  p_turnover_preceding_fy numeric
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_is_nil_return then 500
    when p_turnover_preceding_fy <= 15000000 then 2000   -- <= Rs 1.5 crore
    when p_turnover_preceding_fy <= 50000000 then 5000   -- Rs 1.5-5 crore
    else 10000                                            -- > Rs 5 crore
  end;
$$;

comment on function app_private.gst_late_fee_cap(boolean, numeric) is
  'Sec 47(1) late-fee cap per Notification 19/2021-CT: Rs 500 flat for a NIL return, else Rs 2,000 / 5,000 / 10,000 by AATO (preceding FY) up to Rs 1.5cr / 1.5-5cr / above Rs 5cr. Confirmed still current, unchanged since 1 Jun 2021 -- see 0225.';

revoke all on function app_private.gst_late_fee_cap(boolean, numeric) from public, anon;
grant execute on function app_private.gst_late_fee_cap(boolean, numeric) to authenticated;


-- ----------------------------------------------------------------------------
-- get_gstr3b_table5_1(company, gst_registration, period_start, period_end)
-- ----------------------------------------------------------------------------
-- p_period_start/p_period_end are accepted for interface symmetry with
-- get_gstr3b_table4/get_gstr3b_table6_1 and the report page's single month
-- selector -- same documented choice 0129 made for table6_1's own
-- p_period_start. The ACTUAL return period this function evaluates is
-- derived from p_period_start alone, using the REGISTRATION's own real
-- filing_frequency: the calendar month containing it (monthly filer) or the
-- calendar quarter containing it (QRMP filer) -- never trusted as-is from
-- p_period_end, so a QRMP registration queried with a single month's bounds
-- (the report page's own only granularity) still resolves to the correct
-- full quarter.
create or replace function public.get_gstr3b_table5_1(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  tax_head text,
  cash_tax_payable numeric,
  filing_frequency text,
  qrmp_category text,
  return_period_start date,
  return_period_end date,
  due_date date,
  matched_payment_count integer,
  matched_payment_total numeric,
  settlement_date date,
  is_provisional boolean,
  days_late integer,
  interest_rate_percent numeric,
  interest_amount numeric,
  is_nil_return_proxy boolean,
  late_fee_rate_per_day numeric,
  turnover_preceding_fy numeric,
  late_fee_cap numeric,
  late_fee_amount numeric,
  note text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_filing_frequency text;
  v_qrmp_category text;
  v_reg_company_id uuid;
  v_return_start date;
  v_return_end date;
  v_due date;
  v_precede_fy_start date;
  v_precede_fy_end date;
  v_turnover numeric;
  v_gross_output_total numeric;
  v_itc_total numeric;
  v_rcm_memo numeric;
  v_is_nil boolean;
  v_matched_count integer;
  v_matched_total numeric;
  v_matched_max_date date;
  v_net_total numeric;
  v_settlement date;
  v_is_provisional boolean;
  v_days_late integer;
  v_late_fee_rate numeric;
  v_late_fee_cap numeric;
  v_late_fee_before_cap numeric;
  v_late_fee_total numeric;
  v_late_fee_cgst numeric;
  v_late_fee_sgst numeric;
  v_note text;
  r record;
begin
  select gr.filing_frequency, rs.qrmp_category, gr.company_id
    into v_filing_frequency, v_qrmp_category, v_reg_company_id
    from public.gst_registrations gr
    left join public.ref_states rs on rs.code = gr.state_code
   where gr.id = p_gst_registration_id;

  if v_reg_company_id is null then
    raise exception 'GST registration % not found', p_gst_registration_id;
  end if;
  if v_reg_company_id <> p_company_id then
    raise exception 'GST registration % does not belong to company %', p_gst_registration_id, p_company_id;
  end if;
  if v_filing_frequency = 'qrmp' and v_qrmp_category is null then
    raise exception 'Registration % is QRMP but its state has no QRMP category on record -- cannot determine the 22nd/24th due date', p_gst_registration_id;
  end if;

  if v_filing_frequency = 'qrmp' then
    v_return_start := date_trunc('quarter', p_period_start)::date;
    v_return_end := (date_trunc('quarter', p_period_start) + interval '3 months' - interval '1 day')::date;
  else
    v_return_start := date_trunc('month', p_period_start)::date;
    v_return_end := (date_trunc('month', p_period_start) + interval '1 month' - interval '1 day')::date;
  end if;

  v_due := app_private.gstr3b_due_date(v_return_start, v_filing_frequency, v_qrmp_category);

  -- GST's own financial year, always 1 Apr-31 Mar -- NOT this company's
  -- configured book year (same discipline 0155 already established for
  -- get_gstr9_table4_5 and siblings).
  if extract(month from v_return_start)::int >= 4 then
    v_precede_fy_start := make_date(extract(year from v_return_start)::int - 1, 4, 1);
  else
    v_precede_fy_start := make_date(extract(year from v_return_start)::int - 2, 4, 1);
  end if;
  v_precede_fy_end := (v_precede_fy_start + interval '1 year' - interval '1 day')::date;

  select coalesce(sum(g.taxable_value), 0) into v_turnover
    from public.get_gst_output_register(p_company_id, v_precede_fy_start, v_precede_fy_end, p_gst_registration_id) g;

  -- Nil-return proxy -- see migration header for exactly what this can and
  -- cannot detect. Deliberately built from the SAME ledger-balance figures
  -- as cash_tax_payable itself (get_gstr3b_table6_1's own gross tax_payable
  -- per head), not from get_gst_output_register: that function filters to
  -- voucher_type in ('sales','credit_note') only (confirmed live against its
  -- own SQL), so it would silently miss a real output-tax event posted
  -- through any other voucher type (a plain journal, for instance -- exactly
  -- how this migration's OWN hand-verification data below is posted, which
  -- is what first caught this). tax_payable/a_total/a3_rcm_memo_liability
  -- all come from functions that read the control ledgers or their movement
  -- directly, so they see every voucher type alike.
  select coalesce(sum(t6.tax_payable), 0), coalesce(sum(t6.cash_tax_payable), 0)
    into v_gross_output_total, v_net_total
    from public.get_gstr3b_table6_1(p_company_id, p_gst_registration_id, v_return_start, v_return_end) t6;
  select coalesce(t4.a_total, 0), coalesce(t4.a3_rcm_memo_liability_accrued, 0)
    into v_itc_total, v_rcm_memo
    from public.get_gstr3b_table4(p_company_id, p_gst_registration_id, v_return_start, v_return_end) t4;
  v_is_nil := (v_gross_output_total = 0) and (v_itc_total = 0) and (v_rcm_memo = 0);

  -- Company-wide match: tax_payments has no gst_registration_id column at
  -- all (confirmed live, see migration header) -- exact only while every
  -- company holds one GST registration, same limitation 0129 already
  -- documents for Table 4's B-side reversal figures.
  select count(*), coalesce(sum(t.amount), 0), max(t.payment_date)
    into v_matched_count, v_matched_total, v_matched_max_date
    from public.tax_payments t
   where t.company_id = p_company_id
     and t.tax_type = 'gst'
     and t.period_start = v_return_start
     and t.period_end = v_return_end;

  -- Settlement date: the matched challan's own latest payment_date if any
  -- exists (regardless of frequency count -- see migration header on why no
  -- per-rupee FIFO is attempted), else CURRENT_DATE (provisional, still
  -- running) if something is genuinely owed and nothing has been tagged yet,
  -- else null (nothing owed, nothing paid -- no date to reason about at all).
  v_settlement := case
    when v_matched_count > 0 then v_matched_max_date
    when v_net_total > 0 then current_date
    else null
  end;
  v_is_provisional := (v_matched_count = 0) and (v_settlement is not null);
  v_days_late := case when v_settlement is not null then greatest((v_settlement - v_due), 0) else 0 end;

  v_late_fee_rate := case when v_is_nil then 20 else 50 end;
  v_late_fee_cap := app_private.gst_late_fee_cap(v_is_nil, v_turnover);
  v_late_fee_before_cap := v_days_late * v_late_fee_rate;
  v_late_fee_total := least(v_late_fee_before_cap, v_late_fee_cap);
  v_late_fee_cgst := round(v_late_fee_total / 2.0, 2);
  v_late_fee_sgst := v_late_fee_total - v_late_fee_cgst;

  v_note := 'Interest: Sec 50(1), 18% p.a. on a daily basis on the net cash liability from get_gstr3b_table6_1, from the day after '
    || 'the due date to the settlement date below -- does NOT apply the Rule 88B(1) minimum-cash-ledger-balance credit the GST '
    || 'portal itself began giving from Jan 2026 (LEKHA records discrete challan deposits, not a running Electronic Cash Ledger '
    || 'balance), so this figure is conservative (never understated, may overstate a taxpayer whose real cash-ledger timing was '
    || 'more generous). Late fee: Sec 47(1), Rs 50/day (Rs 25 CGST + Rs 25 SGST -- never IGST or Cess, by statute) or Rs 20/day '
    || 'for a NIL return, capped by AATO in the preceding financial year (Notification 19/2021-CT). is_nil_return_proxy is a '
    || 'proxy (zero gross output tax_payable, zero Table 4 ITC, and zero RCM memo liability this period, all read from ledger '
    || 'closing balances so every voucher type is seen alike) -- Table 3.1/3.2 are portal-computed and not built here '
    || '(0129), so the real Sec 47(1) NIL test cannot be run directly. turnover_preceding_fy is this ONE registration''s own '
    || 'taxable-value total, a proxy for the Sec 2(6) PAN-wide AATO the cap actually uses -- exact only while this company holds '
    || 'one registration (verified true for every company in this database today). settlement_date is the matched challan''s own '
    || 'latest payment_date, used as a proxy for the actual filing date (no field anywhere records a GSTR-3B return''s own filing '
    || 'date -- same gap 0130 already documented for TDS/TCS quarterly returns) and, when more than one challan matched, applied '
    || 'to the FULL liability rather than a per-rupee FIFO allocation (tax_payments.amount has no per-head breakdown to allocate '
    || 'against) -- deliberately conservative, never understates interest for a split payment. matched_payment_total is shown '
    || 'alongside cash_tax_payable so a material mismatch between what was computed and what was actually deposited is visible, '
    || 'not silently resolved one way. is_provisional means no challan is tagged to this period yet and the figures below are '
    || 'computed AS IF paid today (CURRENT_DATE), still running. tax_payments is matched company-wide (no gst_registration_id '
    || 'column exists on it) -- exact only while this company holds one GST registration.';

  for r in
    select * from public.get_gstr3b_table6_1(p_company_id, p_gst_registration_id, v_return_start, v_return_end)
  loop
    tax_head := r.tax_head;
    cash_tax_payable := r.cash_tax_payable;
    filing_frequency := v_filing_frequency;
    qrmp_category := v_qrmp_category;
    return_period_start := v_return_start;
    return_period_end := v_return_end;
    due_date := v_due;
    matched_payment_count := v_matched_count;
    matched_payment_total := v_matched_total;
    settlement_date := v_settlement;
    is_provisional := v_is_provisional;
    days_late := v_days_late;
    interest_rate_percent := 18;
    interest_amount := case when r.cash_tax_payable > 0 and v_days_late > 0
                             then round(r.cash_tax_payable * 0.18 * v_days_late / 365.0, 2)
                             else 0 end;
    is_nil_return_proxy := v_is_nil;
    late_fee_rate_per_day := v_late_fee_rate;
    turnover_preceding_fy := round(v_turnover, 2);
    late_fee_cap := v_late_fee_cap;
    late_fee_amount := case
      when v_settlement is null then null
      when r.tax_head = 'cgst' then v_late_fee_cgst
      when r.tax_head = 'sgst' then v_late_fee_sgst
      else 0
    end;
    note := v_note;
    return next;
  end loop;

  return;
end;
$$;

revoke all on function public.get_gstr3b_table5_1(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gstr3b_table5_1(uuid, uuid, date, date) to authenticated;

comment on function public.get_gstr3b_table5_1(uuid, uuid, date, date) is
  'GSTR-3B Table 5.1 (interest and late fee), one row per tax head (IGST/CGST/SGST/Cess), for the return period containing '
  'p_period_start under the REGISTRATION''s own real filing_frequency (monthly -> the calendar month; qrmp -> the calendar '
  'quarter, using ref_states.qrmp_category for the 22nd/24th due-date split -- both facts this schema already tracked, '
  'contrary to 0129''s own header). Sec 50(1) interest at 18% p.a. daily-basis on get_gstr3b_table6_1''s own cash_tax_payable '
  'per head, from the due date to the matched tax_payments challan''s payment_date (company-wide match on '
  '(tax_type=''gst'', period_start, period_end) -- tax_payments has no gst_registration_id column). Sec 47(1) late fee, Rs '
  '50/day (CGST+SGST only, split evenly) or Rs 20/day for a NIL-return proxy, capped by this registration''s own preceding-FY '
  'turnover (Notification 19/2021-CT tiers). No challan tagged and something is owed -> provisional, computed to '
  'CURRENT_DATE. Nothing owed and nothing paid -> late_fee_amount is null (undetermined, not zero). Does not apply Rule '
  '88B(1)''s minimum-cash-ledger-balance credit (no running ECL balance in this schema) -- conservative, never understates. '
  'See 0225 for full statutory research and every proxy/limitation stated above in detail.';

notify pgrst, 'reload schema';
