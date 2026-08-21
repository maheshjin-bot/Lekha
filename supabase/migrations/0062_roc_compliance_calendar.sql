-- ============================================================================
-- 0062 — ROC filings, added to the existing compliance calendar (0024)
-- ============================================================================
-- The `roc` module (0004) has been registered since day one — conditional,
-- activating on ref_entity_types.roc_applicable — with its own hint text
-- "AOC-4, MGT-7, Form 8/11", and zero code behind it. Rather than a new
-- table or a new function, this extends get_compliance_calendar (0024) in
-- place: ROC due dates are the SAME shape of fact as every GST/TDS/income-
-- tax date already there — a deterministic formula keyed off the calendar
-- financial year, not something that needs looking up per company. One
-- calendar, one function, one screen a business already checks.
--
-- CREATE OR REPLACE, SAME SIGNATURE — no DROP FUNCTION needed; the
-- ambiguous-overload trap only bites when the signature itself changes.
--
-- VERIFIED LIVE (WebSearch, Aug 2026), not carried from training data, and
-- one real correction caught in the process: an early search summary
-- claimed DIR-3 KYC was "once every three years" — a second, more targeted
-- search confirmed it is ANNUAL, due 30 September, exactly as this app's
-- existing `governance` domain knowledge would suggest and as every primary
-- source actually says. A second summary claimed DPT-3's 2026 due date was
-- "31 July, extended... after the data-centre fire" — a follow-up search
-- confirmed 30 June is the STANDING statutory date (three months after the
-- 31 March year-end) and the 31 July figure was a one-off administrative
-- relief for that specific year, not a rule to encode as a permanent
-- formula. Both wrong claims came from the same first search pass; neither
-- survived a skeptical second pass, which is exactly the discipline 0024's
-- own header describes and why it is repeated here.
--
--   AOC-4 (financial statements): 30 days from the AGM.
--   MGT-7 (annual return, pvt_ltd/ltd) / MGT-7A (opc): 60 days from the AGM.
--   DIR-3 KYC (director/designated-partner KYC): 30 September, annual.
--   DPT-3 (return of deposits): 30 June, annual.
--   MSME Form-1 (outstanding MSME dues, half-yearly): 31 October for the
--     Apr-Sep half, 30 April for the Oct-Mar half.
--   LLP Form 11 (annual return): 30 May.
--   LLP Form 8 (statement of account & solvency): 30 October.
--
-- AGM DATE IS ASSUMED, NOT TRACKED — the one genuine estimate in this
-- migration, and the reason AOC-4/MGT-7 carry the caveat 'assuming AGM by
-- 30 Sep' in their own detail column rather than being presented with the
-- same confidence as the fixed-date forms. Indian company law requires the
-- AGM within 6 months of financial year end (so by 30 September for the
-- April-March year every ROC-applicable LEKHA company keeps, per Companies
-- Act Sec 96) — this function assumes that LATEST permissible date, the
-- same worst-case-first principle 0024 already applies elsewhere ("better
-- an unneeded reminder than a missed one"). A company that holds its AGM
-- earlier has an earlier real deadline than shown here.
--
-- WHICH FORMS PER ENTITY TYPE FOLLOWS THIS APP'S OWN ALREADY-SEEDED
-- ref_entity_types.roc_forms exactly, not this migration's own independent
-- judgement, for the forms that table already lists — notably, DPT-3 is
-- seeded for pvt_ltd/ltd but NOT for opc, which differs from generic
-- "applies to all companies" web guidance; the existing seed data is
-- treated as the authoritative, presumably-already-researched source for
-- that specific distinction rather than re-litigated here. MSME Form-1 is
-- NOT in any entity type's seeded roc_forms list (the array reads as
-- illustrative, not exhaustive — the module's own top-level hint text
-- omits DIR-3 KYC and DPT-3 too, which the seeded data DOES include) — its
-- inclusion here for every ROC-applicable company entity (not LLP, which
-- Sec 405 does not cover) is this migration's own addition, verified
-- independently.
--
-- NOT MODELLED, documented rather than silently omitted:
--   * ADT-1 (auditor appointment) — depends on whether an appointment
--     happened this year, which this schema does not track.
--   * MGT-14 / SH-7 / event-based ROC forms — triggered by a specific
--     corporate action (board resolution, share allotment), not a
--     recurring calendar date; nothing here is periodic enough to formula.
--   * A first AGM's extended 9-month window (new companies only) — this
--     function always assumes the ordinary 6-month case.
-- ============================================================================

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
      coalesce(bool_or(module_code = 'tax_audit'), false) as tax_audit_on,
      coalesce(bool_or(module_code = 'roc'), false) as roc_on
      from public.company_modules
     where company_id = p_company_id and effective_to is null
  ),
  entity as (
    select c.entity_type as code
      from public.companies c
     where c.id = p_company_id
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
  -- the window (advance tax / ITR / tax audit / ROC dates only run once a
  -- year, or twice for MSME-1).
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

  -- AOC-4: 30 days from the AGM, assumed at the latest permissible date
  -- (30 September) — see the migration header. Companies only, not LLP.
  roc_aoc4 as (
    select (make_date(y.y + 1, 9, 30) + 30),
           'ROC'::text,
           'AOC-4 (financial statements)',
           'FY ' || y.y::text || '-' || right((y.y + 1)::text, 2) || ' — assuming AGM by 30 Sep'
      from years y cross join modules mo cross join entity e
     where mo.roc_on and e.code in ('pvt_ltd','ltd','opc')
  ),

  -- MGT-7 (pvt_ltd/ltd) or MGT-7A (opc): 60 days from the same assumed AGM.
  roc_annual_return as (
    select (make_date(y.y + 1, 9, 30) + 60),
           'ROC'::text,
           case when e.code = 'opc' then 'MGT-7A (annual return)' else 'MGT-7 (annual return)' end,
           'FY ' || y.y::text || '-' || right((y.y + 1)::text, 2) || ' — assuming AGM by 30 Sep'
      from years y cross join modules mo cross join entity e
     where mo.roc_on and e.code in ('pvt_ltd','ltd','opc')
  ),

  -- DIR-3 KYC: 30 September annually, for every DIN/DPIN holder — companies
  -- and LLPs alike (DPIN was merged into the DIN system in 2018).
  roc_dir3_kyc as (
    select make_date(y.y + 1, 9, 30),
           'ROC'::text,
           'DIR-3 KYC (director/partner KYC)',
           'For FY ' || y.y::text || '-' || right((y.y + 1)::text, 2)
      from years y cross join modules mo cross join entity e
     where mo.roc_on and e.code in ('pvt_ltd','ltd','opc','llp')
  ),

  -- DPT-3: 30 June annually. pvt_ltd/ltd only, per this app's own already-
  -- seeded ref_entity_types.roc_forms — see the migration header.
  roc_dpt3 as (
    select make_date(y.y + 1, 6, 30),
           'ROC'::text,
           'DPT-3 (return of deposits)',
           'For FY ' || y.y::text || '-' || right((y.y + 1)::text, 2)
      from years y cross join modules mo cross join entity e
     where mo.roc_on and e.code in ('pvt_ltd','ltd')
  ),

  -- MSME Form-1: half-yearly, for outstanding dues to micro/small suppliers
  -- beyond 45 days. Companies only (Sec 405 does not cover LLP), any
  -- ROC-applicable company entity — this app's own independent addition,
  -- not from the seeded roc_forms hint; see the migration header.
  roc_msme1 as (
    select make_date(y.y, 10, 31),
           'ROC'::text,
           'MSME Form-1 (outstanding MSE dues)',
           'For Apr-Sep ' || y.y::text
      from years y cross join modules mo cross join entity e
     where mo.roc_on and e.code in ('pvt_ltd','ltd','opc')
    union all
    select make_date(y.y + 1, 4, 30),
           'ROC'::text,
           'MSME Form-1 (outstanding MSE dues)',
           'For Oct ' || y.y::text || '-Mar ' || (y.y + 1)::text
      from years y cross join modules mo cross join entity e
     where mo.roc_on and e.code in ('pvt_ltd','ltd','opc')
  ),

  -- LLP Form 11 (annual return): 30 May.
  roc_llp_form11 as (
    select make_date(y.y + 1, 5, 30),
           'ROC'::text,
           'LLP Form 11 (annual return)',
           'FY ' || y.y::text || '-' || right((y.y + 1)::text, 2)
      from years y cross join modules mo cross join entity e
     where mo.roc_on and e.code = 'llp'
  ),

  -- LLP Form 8 (statement of account & solvency): 30 October.
  roc_llp_form8 as (
    select make_date(y.y + 1, 10, 30),
           'ROC'::text,
           'LLP Form 8 (statement of account & solvency)',
           'FY ' || y.y::text || '-' || right((y.y + 1)::text, 2)
      from years y cross join modules mo cross join entity e
     where mo.roc_on and e.code = 'llp'
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
    union all select * from roc_aoc4
    union all select * from roc_annual_return
    union all select * from roc_dir3_kyc
    union all select * from roc_dpt3
    union all select * from roc_msme1
    union all select * from roc_llp_form11
    union all select * from roc_llp_form8
  )
  select due_date, category, label, detail
    from all_rows
   where due_date between p_from and p_to
   order by due_date, category, label;
$$;

comment on function public.get_compliance_calendar is
  'Statutory due dates computed by formula, not looked up — see 0024''s header for the full list of confidence levels and deliberate scope cuts, and this migration''s own header for the ROC additions (0062). Always runs on the calendar April-March year; never reads companies.financial_year_start_month. AOC-4/MGT-7/MGT-7A assume the AGM happens at the latest permissible date (30 Sep) since this schema does not track the actual AGM date.';
