-- ============================================================================
-- 0024 — Compliance calendar: due dates computed, not stored
-- ============================================================================
-- The `compliance_calendar` module (0004) has been flagged active on every
-- compliance-mode company since day one, with zero code behind it. Closing
-- that gap is what this migration does.
--
-- Every due date below came from a two-pass independent research workflow,
-- cross-checked against a reconciliation pass with tie-breaking web search —
-- not pulled from training-data memory, which is exactly wrong on this
-- subject as often as it is right (see the decisions this file bakes in
-- below). The single most consequential fact behind all of it: the
-- Income-tax Act, 2025 replaced the 1961 Act effective 1 April 2026. Section
-- numbers cited below are 2025-Act numbers; where a form was renumbered
-- (24Q->138, 26Q->140, 27EQ->143) both names appear, once, for the reader's
-- benefit.
--
-- SCHEMA SHAPE: a single SQL function, get_compliance_calendar(), not a
-- table of dates. Every rule here is a deterministic formula (Nth of the
-- month after a period, keyed off the calendar April-March year) rather
-- than a value that needs looking up — the same reasoning already used for
-- app_private.fy_start_date/fy_end_date. The one genuine lookup value
-- (which of two QRMP due-dates a state gets) is small, stable since 2021,
-- and fits naturally as a new column on the existing ref_states reference
-- table rather than a new one.
--
-- DELIBERATELY IGNORES companies.financial_year_start_month. Every statutory
-- due date in Indian tax and GST law runs on the calendar April-March year
-- regardless of what accounting year a company keeps its books in — the one
-- LEKHA setting this feature must NOT read.
--
-- SCOPE DECISIONS (each one narrows a real rule to the slice LEKHA can
-- actually determine from its own schema — the same discipline 0022/0023
-- applied to TDS/TCS deductee-type distinctions):
--
--   * TDS's 7th-of-month-after payment date extends to 30 April for March
--     deductions, but ONLY for non-government deductors — LEKHA has no
--     government-deductor flag, so every company is treated as the (correct
--     for LEKHA's user base) non-government case.
--   * TDS's separate 30-days-from-month-end rule for erstwhile 194-IA/
--     194-IB/194M/194S payments (property purchase, individual/HUF rent,
--     individual/HUF contractor payments, virtual digital assets) is not
--     modelled — LEKHA does not tag deductions at that granularity.
--   * TCS return dates (Form 27EQ, recodified as Form 143) genuinely
--     changed effective 1 April 2026: pre-cutover periods were due the 15th
--     of the month after the quarter; from-cutover periods are due the
--     LAST DAY of the month after the quarter, aligned with the TDS return
--     dates (confidence: medium — strong multi-source convergence, no
--     primary CBDT citation located). This function only ever looks
--     forward from the current date, and the current date is already past
--     1 April 2026, so only the new rule is implemented; the old rule is
--     dead code for this app and is not written.
--   * Advance tax always uses the standard four-instalment schedule (15%/
--     45%/75%/100% cumulative on 15 Jun/15 Sep/15 Dec/15 Mar). The single-
--     instalment relief for Sec 44AD/44ADA presumptive taxpayers is not
--     applied — LEKHA does not record whether a company has opted into
--     presumptive taxation, and the standard schedule is the safe default
--     (it only ever asks for tax earlier than the relief would, never
--     later, so a presumptive filer following this calendar overpays no
--     interest under Sec 234C by using it).
--   * ITR due date: AY 2026-27 introduced a split by nature of income (not
--     literally by ITR form) — 31 July for filers with no business or
--     professional income, 31 August for filers with business/professional
--     income not requiring audit (confidence: medium — well-corroborated,
--     no primary clause number located). LEKHA is a business-accounting
--     app; every company using it has business or professional income by
--     construction, so this function always applies 31 August for the
--     non-audit case and never 31 July — that date is dead code here for
--     the same reason the pre-cutover TCS rule is.
--   * Audit-case ITR (31 Oct) is gated on the `tax_audit` module being
--     active for the company, which is how the rest of the app already
--     answers "does this company need an audit" — not by re-deriving the
--     Sec 63 (44AB) turnover threshold here.
--   * Transfer-pricing due dates (Form 3CEB 31 Oct, ITR 30 Nov under Sec
--     92E) are not modelled — LEKHA has no international/specified-
--     domestic-transaction tracking to gate them on.
--   * GSTR-1's optional Invoice Furnishing Facility (IFF, available for
--     months 1-2 of a QRMP quarter, due the 13th of the following month
--     each) is not shown — it is optional, so omitting it is not a missed
--     deadline the way omitting the mandatory quarterly GSTR-1 would be.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- ref_states.qrmp_category — the one real lookup value this feature needs.
-- Category X files GSTR-3B by the 22nd, Category Y by the 24th, of the month
-- after the quarter. Stable since the scheme's 1 Jan 2021 introduction
-- (CBIC Notification No. 84/2020-Central Tax); both research passes
-- reconciled to an identical state list independently.
-- ----------------------------------------------------------------------------
alter table public.ref_states
  add column qrmp_category char(1) check (qrmp_category in ('X', 'Y'));

comment on column public.ref_states.qrmp_category is
  'GST QRMP scheme category: X files GSTR-3B by the 22nd, Y by the 24th, of the month after the quarter. Per CBIC Notification No. 84/2020-Central Tax. Null only for the two non-state placeholder codes (96, 97) used solely as place-of-supply for exports/territorial waters, which no real GST registration is ever issued under.';

update public.ref_states set qrmp_category = 'X' where code in
  ('22','23','24','25','26','27','28','29','30','31','32','33','34','35','36','37');
update public.ref_states set qrmp_category = 'Y' where code in
  ('01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','38');

alter table public.ref_states
  add constraint ref_states_qrmp_category_matches_jurisdiction
    check ((jurisdiction = 'other') = (qrmp_category is null));


-- ----------------------------------------------------------------------------
-- get_compliance_calendar(company, from, to)
-- Every rule is generated independently as its own CTE over a window of
-- candidate months/quarters/years, then filtered down to [p_from, p_to] in
-- the final select — cheap at the row counts involved (a handful of periods
-- times a handful of rules), and keeps each rule's arithmetic isolated and
-- readable rather than folded into one shared, harder-to-audit formula.
-- ----------------------------------------------------------------------------
create or replace function public.get_compliance_calendar(
  p_company_id uuid,
  p_from date default current_date,
  p_to date default current_date + 120
) returns table (
  due_date date,
  category text,
  label text,
  detail text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with modules as (
    select
      coalesce(bool_or(module_code = 'gst'), false) as gst_on,
      coalesce(bool_or(module_code = 'tds'), false) as tds_on,
      coalesce(bool_or(module_code = 'tcs'), false) as tcs_on,
      coalesce(bool_or(module_code = 'income_tax'), false) as income_tax_on,
      coalesce(bool_or(module_code = 'tax_audit'), false) as tax_audit_on
      from public.company_modules
     where company_id = p_company_id and effective_to is null
  ),
  -- One row per calendar month whose "due next month" date could land in
  -- the window — a one-month lookback covers a period whose due date (up
  -- to the ~7th-24th of the following month) falls inside a window that
  -- starts mid-month.
  months as (
    select generate_series(
      date_trunc('month', p_from) - interval '1 month',
      date_trunc('month', p_to),
      interval '1 month'
    )::date as period_start
  ),
  -- Same idea for quarters. date_trunc('quarter', ...) truncates to
  -- Jan/Apr/Jul/Oct starts, which are exactly the Indian FY quarter
  -- boundaries too (FY Q1 = calendar Q2, etc. — the start dates coincide
  -- even though the labels don't), so no separate FY-quarter arithmetic is
  -- needed.
  quarters as (
    select generate_series(
      date_trunc('quarter', p_from) - interval '3 months',
      date_trunc('quarter', p_to),
      interval '3 months'
    )::date as q_start
  ),
  -- One row per FY-start calendar year that could contribute a due date to
  -- the window (advance tax / ITR / tax audit dates only run once a year).
  years as (
    select generate_series(
      extract(year from p_from)::int - 1,
      extract(year from p_to)::int + 1
    ) as y
  ),
  gst_regs as (
    select gr.gstin, gr.filing_frequency, rs.qrmp_category
      from public.gst_registrations gr
      join public.ref_states rs on rs.code = gr.state_code
      cross join modules mo
     where gr.company_id = p_company_id
       and gr.is_active
       and (gr.registered_to is null or gr.registered_to >= p_from)
       and mo.gst_on
  ),

  -- GSTR-3B: 20th of next month (monthly), or 22nd/24th of the month after
  -- the quarter by state category (QRMP).
  gstr3b as (
    select (m.period_start + interval '1 month' + interval '19 days')::date as due_date,
           'GST'::text as category,
           'GSTR-3B — ' || gr.gstin as label,
           'For ' || to_char(m.period_start, 'Mon YYYY') as detail
      from months m cross join gst_regs gr
     where gr.filing_frequency = 'monthly'
    union all
    select (q.q_start + interval '3 months' +
              (case gr.qrmp_category when 'X' then interval '21 days' else interval '23 days' end)
           )::date,
           'GST'::text,
           'GSTR-3B — ' || gr.gstin,
           'For quarter from ' || to_char(q.q_start, 'Mon YYYY') || ' (Category ' || gr.qrmp_category || ')'
      from quarters q cross join gst_regs gr
     where gr.filing_frequency = 'qrmp'
  ),

  -- GSTR-1: 11th of next month (monthly), or 13th of the month after the
  -- quarter (QRMP mandatory quarterly return — the optional IFF is not
  -- shown, see the migration header).
  gstr1 as (
    select (m.period_start + interval '1 month' + interval '10 days')::date,
           'GST'::text,
           'GSTR-1 — ' || gr.gstin,
           'For ' || to_char(m.period_start, 'Mon YYYY')
      from months m cross join gst_regs gr
     where gr.filing_frequency = 'monthly'
    union all
    select (q.q_start + interval '3 months' + interval '12 days')::date,
           'GST'::text,
           'GSTR-1 (quarterly) — ' || gr.gstin,
           'For quarter from ' || to_char(q.q_start, 'Mon YYYY')
      from quarters q cross join gst_regs gr
     where gr.filing_frequency = 'qrmp'
  ),

  -- TDS payment: 7th of next month; March extends to 30 April.
  tds_payment as (
    select (case when extract(month from m.period_start) = 3
                 then (m.period_start + interval '1 month' + interval '29 days')::date
                 else (m.period_start + interval '1 month' + interval '6 days')::date
            end),
           'TDS'::text,
           'TDS payment',
           'For ' || to_char(m.period_start, 'Mon YYYY')
      from months m cross join modules mo
     where mo.tds_on
  ),

  -- TDS return (Form 138/140, was 24Q/26Q): quarterly, +3 months +30 days —
  -- except the Jan-Mar quarter, which is +4 months +30 days (31 May, not
  -- 30 April) and is the one quarter that breaks the otherwise uniform
  -- pattern.
  tds_return as (
    select (case when extract(month from q.q_start) = 1
                 then (q.q_start + interval '4 months' + interval '30 days')::date
                 else (q.q_start + interval '3 months' + interval '30 days')::date
            end),
           'TDS'::text,
           'TDS return (Form 138/140)',
           'For quarter from ' || to_char(q.q_start, 'Mon YYYY')
      from quarters q cross join modules mo
     where mo.tds_on
  ),

  -- TCS payment: 7th of next month, every month — no March extension
  -- (asymmetric with TDS; kept as a separate rule rather than a shared one
  -- with a branch, since the two rules only coincidentally overlap for 11
  -- months of the year).
  tcs_payment as (
    select (m.period_start + interval '1 month' + interval '6 days')::date,
           'TCS'::text,
           'TCS payment',
           'For ' || to_char(m.period_start, 'Mon YYYY')
      from months m cross join modules mo
     where mo.tcs_on
  ),

  -- TCS return (Form 143, was 27EQ): same quarterly shape as the TDS
  -- return under current law (see migration header re: the 1 Apr 2026
  -- cutover this app never needs to look behind).
  tcs_return as (
    select (case when extract(month from q.q_start) = 1
                 then (q.q_start + interval '4 months' + interval '30 days')::date
                 else (q.q_start + interval '3 months' + interval '30 days')::date
            end),
           'TCS'::text,
           'TCS return (Form 143)',
           'For quarter from ' || to_char(q.q_start, 'Mon YYYY')
      from quarters q cross join modules mo
     where mo.tcs_on
  ),

  -- Advance tax: 15%/45%/75%/100% cumulative on 15 Jun / 15 Sep / 15 Dec /
  -- 15 Mar (Mar falling in the following calendar year).
  advance_tax as (
    select d.due_date,
           'Income tax'::text,
           'Advance tax — ' || d.pct || '% cumulative',
           'FY ' || y.y::text || '-' || right((y.y + 1)::text, 2)
      from years y
      cross join modules mo
      cross join lateral (values
        (make_date(y.y, 6, 15), '15'),
        (make_date(y.y, 9, 15), '45'),
        (make_date(y.y, 12, 15), '75'),
        (make_date(y.y + 1, 3, 15), '100')
      ) as d(due_date, pct)
     where mo.income_tax_on
  ),

  -- ITR filing: 31 August for the ordinary (non-audit) case — see the
  -- migration header for why 31 July never applies to a LEKHA company —
  -- 31 October when the tax_audit module is active for this company.
  itr_due as (
    select (case when mo.tax_audit_on then make_date(y.y + 1, 10, 31)
                 else make_date(y.y + 1, 8, 31) end),
           'Income tax'::text,
           'ITR filing',
           'FY ' || y.y::text || '-' || right((y.y + 1)::text, 2) ||
             (case when mo.tax_audit_on then ' (audit case)' else '' end)
      from years y cross join modules mo
     where mo.income_tax_on
  ),

  -- Tax audit report (Form 3CA/3CB-3CD): 30 September, one month ahead of
  -- the audit-case ITR date, only when the tax_audit module is active.
  tax_audit_report as (
    select make_date(y.y + 1, 9, 30),
           'Income tax'::text,
           'Tax audit report (Form 3CA/3CB-3CD)',
           'For FY ' || y.y::text || '-' || right((y.y + 1)::text, 2)
      from years y cross join modules mo
     where mo.tax_audit_on
  ),

  all_rows as (
    select * from gstr3b
    union all select * from gstr1
    union all select * from tds_payment
    union all select * from tds_return
    union all select * from tcs_payment
    union all select * from tcs_return
    union all select * from advance_tax
    union all select * from itr_due
    union all select * from tax_audit_report
  )
  select due_date, category, label, detail
    from all_rows
   where due_date between p_from and p_to
   order by due_date, category, label;
$$;

comment on function public.get_compliance_calendar is
  'Statutory due dates computed by formula, not looked up — see the migration header for the full list of confidence levels and deliberate scope cuts. Always runs on the calendar April-March year; never reads companies.financial_year_start_month.';
