-- ============================================================================
-- 0163 — Wiring the real AGM date into get_compliance_calendar (T2-19 close-out)
-- ============================================================================
-- 0092 (meeting register) built public.meetings and public.get_agm_status
-- and deliberately did NOT touch get_compliance_calendar (0062/since
-- extended by 0084) — its own header called that out as "the single most
-- important scope line" in that migration, left for a single-owner follow
-- up. This migration is that follow-up, and touches nothing else: no other
-- task in this batch is authorized to touch get_compliance_calendar.
--
-- THE GAP. roc_aoc4 and roc_annual_return, the two CTEs inside
-- get_compliance_calendar that compute AOC-4 (Sec 137) and MGT-7/MGT-7A
-- (Sec 92) due dates, assume every company's AGM lands on the latest
-- permissible date, 30 September (6 months after a 31 March FY close) for
-- every year, every company, first AGM or not. A company that actually
-- holds its AGM earlier has real filing deadlines that are correspondingly
-- earlier — AOC-4 is due 30 days from the ACTUAL AGM date (Sec 137(1): "...
-- within thirty days of the date of the annual general meeting..."), and
-- MGT-7/MGT-7A within 60 days of it (Sec 92(4): "... within sixty days
-- from the date on which the annual general meeting is held..."). Both
-- re-confirmed live against the Companies Act 2013 bare-act text (Sec 92,
-- Sec 137) during this task, matching what 0062's own header and 0092's
-- header already independently concluded — not a new rate/threshold, so no
-- second skeptical search was needed beyond confirming the section text
-- itself, which has not been amended.
--
-- THE FIX, MADE AS SMALL AND ADDITIVE AS POSSIBLE. One new CTE, real_agms,
-- LEFT JOINed into the two existing CTEs on financial_year_start_year = the
-- years CTE's own y.y (meetings.financial_year_start_year uses exactly the
-- same "y = FY start calendar year" convention 0092's own comment
-- documents, e.g. 2024 = FY 2024-25 — the same value get_compliance_calendar
-- already generates in its years CTE). When a real AGM row exists for that
-- company and that FY, the due date is computed from the real meeting_date
-- (+30 / +60 days) instead of the assumed 30 September; the label gains an
-- "— AGM held DD Mon YYYY" suffix in place of "— assuming AGM by 30 Sep" so
-- the UI is honest about which basis produced the date. Every other CTE in
-- this function, and everything else about these two CTEs (their WHERE
-- clause, their entity-type filter, their column list, their place in
-- all_rows), is untouched.
--
-- THE OPC QUESTION — READ, NOT ASSUMED. get_agm_status (0092) reports
-- applicable = false for entity_type 'opc': under Sec 96(1) proviso an OPC
-- has no AGM to hold at all. get_compliance_calendar's own roc_aoc4/
-- roc_annual_return CTEs, by contrast, correctly keep 'opc' in their
-- entity-type filter, because those are ROC FILING obligations (AOC-4,
-- MGT-7A) an OPC still has even without an AGM — 0092's header already
-- flagged this as "not a contradiction, the two functions answer different
-- questions" and asked this migration to actively confirm they still agree
-- after the wiring. They do, by construction: the real_agms LEFT JOIN below
-- is deliberately gated on e.code in ('pvt_ltd','ltd') — NOT 'opc' — so an
-- OPC's due date is always computed from the pre-existing 30-September
-- assumption, never from a meetings row, even in the never-expected case
-- where a meetings row with meeting_type='agm' exists against an OPC
-- company (nothing in the meetings table's own CHECK constraints stops
-- that from being entered by mistake). This migration does not change how
-- OPC's AOC-4/MGT-7A due date is computed at all — that due date is, in
-- reality, governed by a different, fixed 180-days-from-FY-close basis
-- under the Sec 96(1) proviso rather than "30 days from an AGM that does
-- not exist" — but correcting THAT pre-existing simplification is a
-- separate, out-of-scope bug from the one this migration was asked to
-- close (wiring in a REAL date where one is tracked), and is left exactly
-- as get_compliance_calendar already had it, named here rather than
-- silently touched.
--
-- REGRESSION DISCIPLINE — VERIFIED, NOT ASSUMED. Every company in the live
-- database with no meetings row (the overwhelming majority — only Nexgen
-- Softwares Private Limited has one, from 0092's own committed test data)
-- must see byte-identical get_compliance_calendar output before and after
-- this migration, because the real_agms LEFT JOIN is NULL for all of them
-- and both new CASE branches fall through to the exact same expression
-- (make_date(y.y + 1, 9, 30) + 30/60, and the exact same ' — assuming AGM
-- by 30 Sep' string) that shipped before. Verified live for all 15
-- companies in the database by hashing full get_compliance_calendar output
-- per company across a 2015-01-01..2035-12-31 window before and after
-- applying this migration — see this task's own report for the query and
-- the matching hashes. Nexgen Softwares Private Limited (the one company
-- WITH a recorded AGM: 20 Sep 2025, discharging FY 2024-25, per 0092's own
-- seed) is the only row whose hash changes, and by exactly the expected
-- amount — AOC-4 due date moves from the assumed 30 Oct 2025 to the real
-- 20 Oct 2025 (10 days earlier, matching the 10-day gap between the real
-- 20 Sep AGM and the assumed 30 Sep one), MGT-7 from 29 Nov 2025 to 19 Nov
-- 2025, same 10-day shift. Also verified live in this task's report.
-- ============================================================================


CREATE OR REPLACE FUNCTION public.get_compliance_calendar(p_company_id uuid, p_from date DEFAULT CURRENT_DATE, p_to date DEFAULT (CURRENT_DATE + 120))
 RETURNS TABLE(due_date date, category text, label text, detail text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with modules as (
    select
      coalesce(bool_or(module_code = 'gst'), false) as gst_on,
      coalesce(bool_or(module_code = 'tds'), false) as tds_on,
      coalesce(bool_or(module_code = 'tcs'), false) as tcs_on,
      coalesce(bool_or(module_code = 'income_tax'), false) as income_tax_on,
      coalesce(bool_or(module_code = 'tax_audit'), false) as tax_audit_on,
      coalesce(bool_or(module_code = 'roc'), false) as roc_on,
      coalesce(bool_or(module_code = 'payroll_statutory'), false) as payroll_statutory_on
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

  -- Real AGM dates recorded in public.meetings (0092), keyed by the
  -- financial year they discharge. LEFT JOIN, restricted to pvt_ltd/ltd
  -- only — matching get_agm_status's own Sec 96(1)-proviso OPC exclusion
  -- (0092: an OPC has no AGM to hold at all, so no real date can ever be
  -- meaningful for one even if a stray meetings row exists against it).
  -- When no matching row exists the LEFT JOIN produces NULL and the CTEs
  -- below fall back to the pre-existing 30-September assumption exactly as
  -- before this migration — the regression-critical property this change
  -- was verified not to disturb for every company with no meetings row.
  real_agms as (
    select mt.financial_year_start_year as fy_y, mt.meeting_date
      from public.meetings mt
     where mt.company_id = p_company_id and mt.meeting_type = 'agm'
  ),

  -- AOC-4: 30 days from the AGM. Uses the REAL recorded AGM date (0092)
  -- for the matching financial year when one exists; otherwise falls back
  -- to the pre-existing assumption of the latest permissible date (30
  -- September) — see the migration header. Companies only, not LLP.
  roc_aoc4 as (
    select (case when ra.meeting_date is not null then ra.meeting_date + 30
                 else make_date(y.y + 1, 9, 30) + 30 end),
           'ROC'::text,
           'AOC-4 (financial statements)',
           'FY ' || y.y::text || '-' || right((y.y + 1)::text, 2) ||
             (case when ra.meeting_date is not null
                   then ' — AGM held ' || to_char(ra.meeting_date, 'DD Mon YYYY')
                   else ' — assuming AGM by 30 Sep' end)
      from years y
      cross join modules mo
      cross join entity e
      left join real_agms ra on ra.fy_y = y.y and e.code in ('pvt_ltd','ltd')
     where mo.roc_on and e.code in ('pvt_ltd','ltd','opc')
  ),

  -- MGT-7 (pvt_ltd/ltd) or MGT-7A (opc): 60 days from the same AGM — real
  -- when recorded, otherwise the same assumed date as roc_aoc4 above.
  roc_annual_return as (
    select (case when ra.meeting_date is not null then ra.meeting_date + 60
                 else make_date(y.y + 1, 9, 30) + 60 end),
           'ROC'::text,
           case when e.code = 'opc' then 'MGT-7A (annual return)' else 'MGT-7 (annual return)' end,
           'FY ' || y.y::text || '-' || right((y.y + 1)::text, 2) ||
             (case when ra.meeting_date is not null
                   then ' — AGM held ' || to_char(ra.meeting_date, 'DD Mon YYYY')
                   else ' — assuming AGM by 30 Sep' end)
      from years y
      cross join modules mo
      cross join entity e
      left join real_agms ra on ra.fy_y = y.y and e.code in ('pvt_ltd','ltd')
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

  -- PF: the contributions AND the ECR that carries them share one deadline --
  -- within 15 days of the close of the wage month. There is no grace period:
  -- the concessional five days were withdrawn with effect from the wage month
  -- of February 2016 and have not been restored, so the 15th is the date.
  --
  -- The 15th itself is unchanged, but the law under it is not: the EPF & MP
  -- Act 1952 was subsumed by the Code on Social Security 2020 (operative
  -- 21 Nov 2025), and the EPF Scheme 2026 replaced the 1952 Scheme from
  -- 1 July 2026. The obligation now sits in Para 28(3) of the 2026 Scheme and
  -- the ECR is its Form VII. Labels here name the return, not the paragraph,
  -- so they did not go stale on 1 July -- but anything that starts citing
  -- "Para 38(1) of the EPF Scheme, 1952" would be citing a repealed
  -- instrument.
  pf_payment as (
    select (m.period_start + interval '1 month' + interval '14 days')::date,
           'Payroll'::text,
           'PF payment and ECR',
           'For ' || to_char(m.period_start, 'Mon YYYY')
      from months m cross join modules mo
     where mo.payroll_statutory_on
  ),

  -- ESI: the same 15-day clock as PF, and likewise one deadline covering both
  -- the payment and the monthly contribution filing.
  esi_payment as (
    select (m.period_start + interval '1 month' + interval '14 days')::date,
           'Payroll'::text,
           'ESI payment and monthly contribution',
           'For ' || to_char(m.period_start, 'Mon YYYY')
      from months m cross join modules mo
     where mo.payroll_statutory_on
  ),

  -- ESI half-yearly Return of Contribution: 42 days after the contribution
  -- period ends, which lands on 11 November (for April-September) and 12 May
  -- (for October-March). Those two dates are NOT the 15th and fall out of no
  -- monthly rule -- they are the 42-day count, which is exactly why this needs
  -- its own CTE rather than another row on the monthly one. Getting them
  -- wrong by guessing at "the 15th" would be a fortnight late.
  esi_half_yearly as (
    select d.due, 'Payroll'::text, 'ESI half-yearly return', d.detail
      from years yr
      cross join modules mo
      cross join lateral (values
        (make_date(yr.y, 11, 11), 'Contribution period Apr-Sep ' || yr.y),
        (make_date(yr.y, 5, 12),  'Contribution period Oct ' || (yr.y - 1) || ' - Mar ' || yr.y)
      ) as d(due, detail)
     where mo.payroll_statutory_on
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
    union all select * from pf_payment
    union all select * from esi_payment
    union all select * from esi_half_yearly
  )
  select due_date, category, label, detail
    from all_rows
   where due_date between p_from and p_to
   order by due_date, category, label;
$function$;


comment on function public.get_compliance_calendar(uuid, date, date) is
  'ROC/GST/TDS/TCS/income-tax/payroll compliance calendar. AOC-4 and MGT-7/MGT-7A due dates use the REAL recorded AGM date from public.meetings (0092) for pvt_ltd/ltd whenever one exists for the matching financial year, falling back to the pre-existing 30-September assumption otherwise (0163). OPC due dates are unaffected by this — an OPC has no AGM under Sec 96(1) proviso (the same exclusion get_agm_status applies) and its AOC-4/MGT-7A basis stays the 30-September assumption exactly as before, since OPC''s real basis (180 days from FY close) is a separate, out-of-scope simplification, not this one.';

revoke all on function public.get_compliance_calendar(uuid, date, date) from public, anon;
grant execute on function public.get_compliance_calendar(uuid, date, date) to authenticated;
