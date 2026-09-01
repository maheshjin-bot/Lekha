-- Payroll history must not change when somebody resigns.
--
-- WHY. A pilot preparer recorded an ordinary September resignation through the
-- app's own F&F screen, correctly, after August had been posted, paid and
-- remitted. August's figures immediately became:
--
--   August report              before      after     actually remitted
--   PF ECR members / EE        6 / 9,960   5 / 8,640  challan on EE 9,960
--   ESI insured / wages        2 / 36,000  1 / 19,000 challan on 36,000
--   PT liability               6 / 1,200   5 / 1,000  1,200
--   24Q Annexure I gross       2,70,000    2,53,000   2,70,000
--   Ledger (Salary Expense)    2,70,000    2,70,000   2,70,000
--
-- The employee was employed and paid for the whole of August. Reprint the
-- August ECR after the exit and it no longer matches the challan filed or the
-- ledger — and because the LEDGER is untouched, nothing on screen shows a
-- conflict. These are statutory returns that have already been submitted.
--
-- THE CAUSE, and why the fix is a deletion. Three period-scoped functions
-- filter on employees.is_active — a CURRENT-STATE flag — inside a HISTORICAL
-- report. Every one of them already sits directly beside the correct
-- period-aware test:
--
--   and (e.date_of_leaving is null or e.date_of_leaving >= <period start>)
--   and e.is_active                                   <-- redundant, and wrong
--
-- The first line is complete on its own. record_fnf_settlement is the only
-- writer of is_active anywhere and it always sets date_of_leaving in the same
-- statement (verified), so the second line adds nothing except to exclude
-- exactly the people the first line correctly included: those who left after
-- the period began. Both functions already pro-rate days worked against
-- date_of_leaving too, so a mid-month leaver is paid correctly once included.
--
-- WHAT REPLACES IT, and why not simply nothing. An employee marked inactive
-- with NO leaving date cannot be placed in time at all, and dropping the flag
-- outright would put such a row into every period for ever. None exist today
-- (checked: 0 rows) and no UI writes the flag, so this is defence against a
-- future path rather than present data — the condition becomes
--
--   and (e.is_active or e.date_of_leaving is not null)
--
-- which is "still here, or gone on a known date", and leaves the dating to the
-- line above.
--
-- SCOPE. Three functions carry the pattern in a period context. Everything
-- downstream — get_pf_ecr_data, get_esi_mc_data, the payroll register, Form
-- 24Q Annexure I — is built on get_payroll_run and is fixed by fixing it.
--
-- DELIBERATELY UNCHANGED: get_gratuity_estimates and get_salary_tds_estimate
-- also read is_active, and there it is correct — both answer a question about
-- who is employed NOW (what gratuity would cost, what to withhold this month),
-- not what was true in a past month. get_salary_tds_estimate has its own
-- separate defect, projecting annual pay as monthly x 12 regardless of joining
-- date; that is a different bug and is not touched here.

do $mig$
declare
  v_fn text;
  v_def text;
  v_hits int;
  v_target constant text := 'and e.is_active';
  v_replacement constant text := 'and (e.is_active or e.date_of_leaving is not null)';
begin
  foreach v_fn in array array[
    'get_payroll_run',
    'get_pt_liability_by_state',
    'accrue_leave_for_month'
  ] loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn and p.prokind = 'f'
     limit 1;

    if v_def is null then
      raise exception '1240: % is missing.', v_fn;
    end if;

    v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);

    if v_hits <> 1 then
      raise exception
        '1240: expected exactly one is_active filter in %, found %. Its body has moved; fix by hand.',
        v_fn, v_hits;
    end if;

    -- The period-aware test this relies on must actually be present, or
    -- removing the flag would widen the report rather than correct it.
    if v_def !~ 'date_of_leaving is null or e\.date_of_leaving >=' then
      raise exception
        '1240: % has no date_of_leaving period test to fall back on; removing is_active would be wrong. Fix by hand.',
        v_fn;
    end if;

    execute replace(v_def, v_target, v_replacement);
  end loop;
end;
$mig$;

comment on function public.get_payroll_run is
  'One month of payroll for every employee employed during THAT month — judged on date_of_joining and date_of_leaving, never on the current is_active flag, so recording a resignation cannot rewrite a month already posted, paid and filed (1240).';
