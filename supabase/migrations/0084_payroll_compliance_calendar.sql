-- ============================================================================
-- 0084 — PF and ESI deadlines were missing from the compliance calendar
-- ============================================================================
-- get_compliance_calendar emitted GST, TDS, TCS, income tax, tax audit and ROC
-- dates and not one payroll date. Its prosrc contained no occurrence of pf,
-- esi, payroll or epf at all, so an employer running payroll got no reminder
-- for the two obligations that fall due every single month.
--
-- Part of why it was silent is fixed in 0083: `payroll_statutory` is the module
-- that gates these rows, and until that migration it could never activate,
-- because the resolver never ran when its dependency (`payroll`) was switched
-- on. Adding the rows without that fix would have produced a calendar that was
-- still empty for everyone.
--
-- DATES VERIFIED, NOT RECALLED, and one of them is not what you would guess:
--
--   PF contributions + ECR   15th of the following month
--   ESI contributions + the
--   monthly contribution     15th of the following month
--   ESI half-yearly Return
--   of Contribution          11 NOVEMBER (for Apr-Sep) and 12 MAY (for Oct-Mar)
--
-- That last pair is 42 days after the contribution period ends, not "the 15th"
-- and not month-end. Guessing at a monthly-looking rule would have made the
-- reminder a fortnight late, which is the whole reason it gets its own CTE
-- rather than another row on the monthly one.
--
-- No grace period is applied to the 15th. The concessional five days that used
-- to make PF effectively due on the 20th were withdrawn with effect from the
-- wage month of February 2016 and have not been restored. Ad hoc EPFO
-- extensions have happened since (September 2025 was pushed to 22 October
-- 2025) but an extension granted after the fact is not a rule a calendar can
-- compute forward from.
--
-- WORTH KNOWING WHILE READING THIS: the 15th is unchanged but the law beneath
-- it is not. The EPF & MP Act 1952 was subsumed by the Code on Social Security
-- 2020 (operative 21 November 2025), and on 29 June 2026 the EPF Scheme 2026,
-- EPS 2026 and EDLI 2026 replaced the 1952, 1995 and 1976 Schemes with effect
-- from 1 July 2026. The obligation now sits in Para 28(3) of the 2026 Scheme
-- and the ECR is its Form VII. The labels below deliberately name the RETURN
-- rather than the paragraph, so they did not go stale on 1 July -- but any
-- future text citing "Para 38(1) of the EPF Scheme, 1952", "Section 7Q" or
-- "Form 3A/6A/5A" would be citing repealed instruments. Interest on late
-- remittance is now Section 127 of the Code, not Section 7Q.
--
-- PROFESSIONAL TAX AND LWF ARE DELIBERATELY NOT HERE. They are State levies
-- and the dates genuinely differ: Maharashtra PT is monthly on the 15th,
-- Karnataka on the 20th, West Bengal on the 21st, and Tamil Nadu is not
-- monthly at all but half-yearly on 30 September and 31 March. LWF differs
-- again -- Maharashtra and West Bengal half-yearly (15 July / 15 January),
-- Karnataka annually on 15 January for the preceding CALENDAR year, Tamil Nadu
-- annually by 31 January. This schema records no PT or LWF registration, so
-- there is nothing to pick a state from, and emitting one state's date to
-- everybody would be worse than emitting none. This mirrors the call 0043
-- already made in refusing to hardcode a PT slab table for the same reason.
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
$function$
;

revoke all on function public.get_compliance_calendar(uuid, date, date) from public, anon;
grant execute on function public.get_compliance_calendar(uuid, date, date) to authenticated;
