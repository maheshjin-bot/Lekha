-- ============================================================================
-- 1443 — get_payroll_run must keep projecting a future month, not refuse it
-- ============================================================================
-- WHY. 1440 gave get_payroll_run's COMPUTED branch a ceiling: it stops
-- answering for any month more than one calendar month ahead of today. That
-- was meant to stop a payroll REGISTER preview from showing a fabricated far-
-- future month as if it were real. It reaches further than that, because
-- get_payroll_run is not only the register's preview — it is the shared
-- primitive TWO STATUTORY COMPUTATIONS build an ANNUAL PROJECTION from:
--
--   get_form16_partb              running Sec 392 TDS estimate for the FY
--   get_employee_perquisites_valued   Rule 3 perquisite valuation for the FY
--
-- Both loop get_payroll_run over all twelve months of the current financial
-- year and sum the result. That is not a misuse — projecting the rest of the
-- FY on the CURRENT salary structure is the entire method Sec 392 (and its
-- predecessor Sec 192) prescribes for estimating an employee's annual income
-- during the year, and 1240 deliberately left get_payroll_run able to compute
-- any not-yet-posted month for exactly this reason.
--
-- 1440's ceiling silently drops every month beyond "today + 1" from that
-- projection with no error. Reproduced live: TEST Vikram Rao (Rangoli),
-- joined 1 Aug 2026, real salary structure on file through year end, FY
-- 2026-27, checked 3 Sep 2026 (so the ceiling admits Aug/Sep/Oct only):
--
--   gross_salary reported by get_form16_partb   375,000.00
--   true 8-month projection (Aug 2026-Mar 2027)  1,000,000.00 (125,000 x 8)
--
-- /reports/form16-partb defaults to the current FY and its own copy promises
-- "every figure below projects the employee's ... estimate" — a promise this
-- silently breaks for any employee, in any in-progress FY, the moment the
-- ceiling is crossed. get_employee_perquisites_valued carries the identical
-- defect for the same reason (confirmed live on a real Sharma Textiles
-- accommodation record: rule_salary_base 1,73,828.57 against a true ~1,92,400
-- annual base, months_applicable wrongly rescaled against a partial
-- months_with_data).
--
-- THE ACTUAL PROBLEM 1440 WAS SOLVING DOES NOT NEED THIS CEILING. What made
-- "payroll for Mar 2027 posted in Sep 2026" wrong was that it was POSTED — a
-- real journal voucher, a real TDS liability, on a month nobody has worked.
-- 1442 already refuses exactly that, on post_payroll_run, with the identical
-- one-month-of-headroom rule and a better message naming the earliest month
-- that can be posted. That guard is untouched by this migration and is where
-- the real defect actually lived. A COMPUTED, unposted preview of a future
-- month is not a ledger fabrication — it is precisely what a projection is
-- for, and get_payroll_run already says so in its own comment ("Otherwise
-- compute, which is a PREVIEW of a month you may be about to run").
--
-- WHAT CHANGES. The ceiling clause is removed from get_payroll_run's computed
-- branch, by targeted, asserted replace over the live definition — nothing
-- else in the function moves. The posted-month snapshot branch (1440, point
-- 3) is untouched: a POSTED month still answers from payroll_posting_lines,
-- never recomputed. 1240's employee filter is untouched. post_payroll_run and
-- 1442's posting refusal are untouched — a preview may look as far ahead as
-- it likes; only posting is bounded.
--
-- CONTROL CASE, checked before writing this: a whole-year employee's figures
-- must not move at all, since nothing about days_paid, proration or the
-- snapshot branch changes — only WHICH months the computed branch is willing
-- to answer for.
-- ============================================================================

do $mig$
declare
  v_def text;
  v_new text;
  v_from constant text := $a$   where not exists (
           select 1
             from public.payroll_posting_lines pl2
            where pl2.company_id = p_company_id
              and pl2.period_month = date_trunc('month', p_period_month)::date)
     and date_trunc('month', p_period_month)::date
         <= (date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)
             + interval '1 month')::date
   order by employee_name;$a$;
  v_to constant text := $b$   where not exists (
           select 1
             from public.payroll_posting_lines pl2
            where pl2.company_id = p_company_id
              and pl2.period_month = date_trunc('month', p_period_month)::date)
   order by employee_name;$b$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_payroll_run' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1443: public.get_payroll_run is missing.';
  end if;

  if v_def !~ 'e\.is_active or e\.date_of_leaving is not null' then
    raise exception '1443: get_payroll_run has lost 1240''s employee filter; stop and look.';
  end if;

  if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
    raise exception '1443: get_payroll_run''s computed-branch tail (1440''s ceiling) has moved or is already gone; fix by hand.';
  end if;

  v_new := replace(v_def, v_from, v_to);
  execute v_new;
end;
$mig$;

revoke all on function public.get_payroll_run(uuid, date) from public, anon;
grant execute on function public.get_payroll_run(uuid, date) to authenticated;

comment on function public.get_payroll_run(uuid, date) is
  'One month of payroll per employee. A month that has been POSTED is answered from payroll_posting_lines exactly as it was recorded at posting; any other month is COMPUTED from the effective-dated salary structure as a preview or projection, for any month, near or far (1443 — 1440''s one-month-ahead ceiling here broke get_form16_partb and get_employee_perquisites_valued, which legitimately project the rest of an in-progress FY; posting a future month is what actually needed refusing, and post_payroll_run already does, at 1442). Employees are judged on date_of_joining/date_of_leaving, never on the current is_active flag (1240). A statutory return must read get_posted_payroll_run instead, which never computes (1440).';
