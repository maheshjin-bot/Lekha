-- ============================================================================
-- 1020 — OPC's AOC-4 due date: fixed 180 days from FY-end, not "AGM + 30"
-- ============================================================================
-- CONFIRMED LIVE, not assumed, before writing this:
--
--   * get_compliance_calendar (0024, extended by 0062, most recently
--     redefined by 0163 — 0163 is the current live definition; nothing
--     between 0163 and this migration touches the function again, checked
--     by grepping every migration for both "get_compliance_calendar" and
--     "CREATE OR REPLACE FUNCTION public.get_compliance_calendar").
--   * roc_aoc4, the CTE that computes AOC-4's due date, applies ONE formula
--     to every entity type in its filter (pvt_ltd/ltd/opc alike): the real
--     recorded AGM date + 30 days when public.meetings has one (real_agms,
--     wired by 0163 — itself gated to e.code in ('pvt_ltd','ltd') only), or
--     else the assumed-latest-AGM date of 30 September + 30 days.
--   * For an OPC, real_agms is NEVER populated (0163's own real_agms LEFT
--     JOIN deliberately excludes 'opc'), so an OPC's AOC-4 due date always
--     falls through to the 30-Sep-assumption branch: 30 Oct of the
--     following calendar year. 0163's own header names this exact gap in
--     its "THE OPC QUESTION" section and explicitly leaves it or a
--     follow-up: "OPC's real basis (180 days from FY close) is a separate,
--     out-of-scope simplification... left exactly as get_compliance_calendar
--     already had it."
--   * That assumption is WRONG for an OPC, not just imprecise. Sec 96(1)
--     proviso, Companies Act 2013, exempts a One Person Company from ever
--     holding an AGM — this app's own get_agm_status (0092) already says so
--     (applicable = false for 'opc'; see 0092's header and the invariant
--     test "get_agm_status.applicable is true only for pvt_ltd and ltd
--     companies"). An OPC therefore has no AGM for AOC-4 to be "30 days
--     from" at all. Sec 137(1), second proviso, gives the actual rule
--     instead: "in case of One Person Company, the financial statements
--     shall be filed... within one hundred eighty days from the closure of
--     the financial year" — re-confirmed live against the Companies Act
--     2013 bare-act text (Sec 137) during this task, the same section 0163
--     already cited for the general 30-day rule, just its own OPC proviso.
--   * For FY2025-26 (year end 31 Mar 2026) that is 27 Sep 2026 — a live
--     example that is over a month EARLIER than the 30 Oct 2026 the
--     unmodified formula currently shows, which is exactly backwards for a
--     due-date reminder: it would tell an OPC it has until 30 Oct when the
--     real statutory deadline is 27 Sep, a genuine late-filing risk if
--     relied on. Manually verified against the current live definition:
--     make_date(2026,9,30) + 30 = 30 Oct 2026 (the old, wrong branch);
--     make_date(2026,3,31) + 180 = 27 Sep 2026 (the corrected branch).
--
-- THE FIX, MADE AS SMALL AND ADDITIVE AS 0163's OWN WAS. One new leading
-- WHEN branch inside roc_aoc4's existing due-date CASE: entity_type = 'opc'
-- computes fy_end (make_date(y.y + 1, 3, 31), the same April-March FY this
-- whole function already assumes throughout — see 0062's header) + 180
-- days, unconditionally — no AGM-date lookup at all, matching the statute's
-- own "financial-year-close", not "AGM date", anchor. The pre-existing
-- ra.meeting_date branch is now unreachable for 'opc' (real_agms was
-- already never populated for it) but is left in the CASE rather than
-- removed, since removing it would be a larger, unrequested rewrite of a
-- CASE this task was not asked to restructure. The detail string gains its
-- own OPC-specific suffix so the UI is honest about which basis produced
-- the date, the same discipline 0163 applied for the real-AGM-vs-assumed
-- distinction. Nothing else in roc_aoc4 changes; every other CTE in this
-- function (including roc_annual_return, MGT-7/MGT-7A) is untouched.
--
-- MGT-7A (roc_annual_return), DELIBERATELY NOT TOUCHED HERE. Sec 92(4)'s
-- own OPC proviso gives OPC's annual return a similarly AGM-independent
-- fixed-date basis (60 days from financial-year close rather than 60 days
-- from an AGM that does not exist) — the same shape of bug as AOC-4's. This
-- migration was scoped, and is confirmed live, to the AOC-4 bug specifically
-- (the task that reported it named only AOC-4, with a specific FY2025-26
-- date mismatch). Fixing MGT-7A's parallel simplification is a real,
-- separate gap, named here rather than silently carried forward, and left
-- for its own follow-up rather than bundled into an unrequested second fix.
--
-- CREATE OR REPLACE, SAME SIGNATURE — matching 0163's own comment that the
-- ambiguous-overload trap only bites when the signature itself changes.
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
  -- before 0163 — unaffected by this migration.
  real_agms as (
    select mt.financial_year_start_year as fy_y, mt.meeting_date
      from public.meetings mt
     where mt.company_id = p_company_id and mt.meeting_type = 'agm'
  ),

  -- AOC-4: for an OPC, a FIXED 180 days from the financial-year close (Sec
  -- 137(1), second proviso) — an OPC has no AGM under Sec 96(1) proviso, so
  -- there is no AGM date, real or assumed, for this deadline to be "30 days
  -- from" at all (see this migration's header). For pvt_ltd/ltd, unchanged
  -- from 0163: 30 days from the REAL recorded AGM date when one exists,
  -- otherwise 30 days from the assumed latest-permissible AGM date of
  -- 30 September. Companies only, not LLP.
  roc_aoc4 as (
    select (case when e.code = 'opc' then make_date(y.y + 1, 3, 31) + 180
                 when ra.meeting_date is not null then ra.meeting_date + 30
                 else make_date(y.y + 1, 9, 30) + 30 end),
           'ROC'::text,
           'AOC-4 (financial statements)',
           'FY ' || y.y::text || '-' || right((y.y + 1)::text, 2) ||
             (case when e.code = 'opc'
                   then ' — 180 days from FY-end (Sec 137(1) proviso; OPC has no AGM)'
                   when ra.meeting_date is not null
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
  -- UNCHANGED by this migration — OPC's own parallel fixed-date basis for
  -- MGT-7A (60 days from FY close under Sec 92(4)'s OPC proviso, not 60
  -- days from an AGM that does not exist) is a real, separate gap, named in
  -- this migration's header and deliberately left for its own follow-up.
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


comment on function public.get_compliance_calendar is
  'ROC/GST/TDS/TCS/income-tax/payroll compliance calendar. AOC-4 due date for entity_type = ''opc'' is a fixed 180 days from financial-year end (Sec 137(1) second proviso — an OPC has no AGM under Sec 96(1) proviso) (1020). For pvt_ltd/ltd, AOC-4 and MGT-7/MGT-7A due dates use the REAL recorded AGM date from public.meetings (0092) whenever one exists for the matching financial year, falling back to the pre-existing 30-September assumption otherwise (0163). MGT-7A for OPC still uses the 30-September-assumption formula (a separate, known, not-yet-fixed simplification — see 1020''s header).';

revoke all on function public.get_compliance_calendar(uuid, date, date) from public, anon;
grant execute on function public.get_compliance_calendar(uuid, date, date) to authenticated;
