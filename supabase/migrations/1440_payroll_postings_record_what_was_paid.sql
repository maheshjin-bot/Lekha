-- ============================================================================
-- 1440 — A payroll month that was never run must not appear in a return
-- ============================================================================
-- WHAT THE PILOT SAW. TEST Rangoli Spice Works Pvt Ltd opened its books on
-- 1 Apr 2026 and ran payroll exactly twice — Aug 2026 and Sep 2026, both
-- posted, both in payroll_postings. Ask the app for any other month of the
-- same financial year and it answers with a full month's salary anyway:
--
--   month     employees   gross       TDS        actually run?
--   Apr 2026      4       1,16,000        0      no
--   May 2026      4       1,16,000        0      no
--   Jun 2026      5       1,45,000        0      no
--   Jul 2026      5       1,45,000        0      no
--   Aug 2026      6       2,70,000    8,125      YES  (voucher HO/JRN/2026-27/00001)
--   Sep 2026      6       2,70,000    8,125      YES  (voucher HO/JRN/2026-27/00004)
--   Oct 2026 .. Mar 2027  2,70,000    8,125      no, and Mar 2027 is 7 months away
--
-- Form 138 (the Income-tax Act, 2025 successor to Form 24Q — Sec 392 for
-- salary; confirmed on incometaxindia.gov.in, whose own form index is titled
-- "Form No. 138 (Earlier Form No. 24Q)") reports, per deductee, the amount
-- PAID and the tax DEDUCTED in the quarter, reconciled against the challans
-- that deposited it. On this data the Q4 return would carry 2,43,000 of gross
-- and 24,375 of Sec 392 TDS for Jan-Mar 2027 that nobody has paid, deducted or
-- deposited, and the Annexure II annual figure would be 32,40,000 / 97,500
-- against 5,40,000 / 16,250 genuinely run. The wage register under the Code on
-- Wages Central Rules has the same problem in the other direction: it is a
-- record of wages PAID.
--
-- THE CAUSE. get_payroll_run(company, month) is a pure computation over the
-- employee master and the effective-dated salary structure. That is exactly
-- right for the screen that previews a month you are about to run and then
-- posts it (/reports/payroll-register), and exactly wrong as the source for a
-- statutory return, because it has no idea whether the month happened. It also
-- keeps recomputing after the fact, which is the same disease 1240 treated one
-- symptom of: 1240 stopped a resignation rewriting a posted month, but a salary
-- revision, a corrected joining date or a newly added employee still would.
--
-- WHAT payroll_postings ACTUALLY RECORDS, checked before designing: company,
-- period_month, voucher_id, posted_by, posted_at. One row per posted month and
-- nothing else — no per-employee detail at all. So "read posted payroll only"
-- could not simply mean "join to payroll_postings and recompute"; recomputing
-- is the drift. The posting has to CARRY the detail.
--
-- WHAT THIS MIGRATION DOES.
--   1. payroll_posting_lines — one row per employee per posted month, written
--      by post_payroll_run at the moment of posting, holding every column
--      get_payroll_run returns. This is the record of what was paid and
--      deducted; it never recomputes.
--   2. get_posted_payroll_run(company, month) — same column shape as
--      get_payroll_run, sourced from that snapshot, ZERO ROWS for a month that
--      was never posted. This is the function a statutory report must read.
--   3. get_payroll_run itself now answers from the snapshot for a month that
--      HAS been posted, and only computes for a month that has not. The
--      preview keeps previewing; a posted month stops moving. Nothing about
--      its employee filtering is touched (1240's fix is left exactly as it
--      is) — the change is a union at the tail, applied by targeted replace
--      over pg_get_functiondef, asserted, not a retype.
--   4. The computed branch also stops answering for months more than one
--      month ahead of today. A payroll register for Mar 2027 printed in
--      Sep 2026 is a fabrication, and s.128(1) Companies Act 2013 requires
--      books kept "on accrual basis" — salary for a month nobody has worked
--      is not an accrued expense. One month of headroom, not zero, because
--      running the coming month's payroll at a month end is ordinary work:
--      this pilot posted Sep 2026 on 31 Aug 2026 and that must keep working.
--      1442 puts the matching, and better-worded, refusal on post_payroll_run.
--
-- BACKFILL, AND ITS HONEST LIMIT — WHICH TURNED OUT TO BE THE BEST EVIDENCE
-- FOR THE SNAPSHOT ITSELF. The four payroll_postings rows that already exist
-- were made before any snapshot was kept, so their lines can only be
-- RECONSTRUCTED by running get_payroll_run once more. Reconstructing them and
-- then checking each one against its own posted voucher — the only evidence a
-- reconstruction can ever have — three of the four DISAGREE with the ledger
-- they themselves posted:
--
--   company / month                  reconstructed        posted voucher
--   Bharat Industries    Aug 2026    40,000 / 0 / 38,000  same             tie
--   Sharma Textiles      Jul 2026    1,57,400 gross       1,41,400 gross   NO
--   Rangoli Spice Works  Aug 2026    TDS 0, net 2,58,570  8,125 / 2,50,445 NO
--   Rangoli Spice Works  Sep 2026    TDS 0, net 2,58,570  8,125 / 2,50,445 NO
--
-- Neither variance is caused by this migration, and both are visible on the
-- register today without it: Sharma Textiles' 16,000 is the employee master
-- having moved since July was posted, and Rangoli's 8,125 a month is 1430
-- (applied earlier today) correcting get_salary_tds_estimate to project from
-- the joining date — which makes the estimate right going forward and every
-- already-posted month disagree with its own voucher. That is precisely the
-- drift a snapshot exists to stop.
--
-- So the backfill stores the reconstruction (it is exactly what every payroll
-- screen already shows for those months) and, on the posting,
--   * lines_reconstructed_at — this was rebuilt afterwards, not captured, and
--   * lines_reconstruction_note — the variance against the posted voucher,
--     null when it ties.
-- It does NOT invent a per-employee split to force a tie. The 8,125 a month
-- Rangoli deducted is an over-deduction the pilot has to correct in its own
-- books; guessing which employee bore it, to make a number reconcile, would
-- be inventing a Form 138 line, which is the thing this migration exists to
-- prevent.
--
-- WHAT THIS MIGRATION CANNOT DO. /reports/payroll-registers and
-- /reports/tds-return-24q call get_payroll_run directly from the page, and
-- those page files are outside this task's ownership. They need a one-word
-- change each — get_payroll_run -> get_posted_payroll_run — before the
-- never-run PAST months (Apr-Jul 2026 above) stop appearing in the return.
-- The function they must call is created here and ready.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The composite key the snapshot hangs off. payroll_postings.id is already the
-- primary key; this redundant unique is what lets payroll_posting_lines carry
-- company_id and period_month as real, FK-guaranteed columns rather than as a
-- denormalisation nothing enforces — get_payroll_run's own lookup is by
-- (company_id, period_month), and it must not be able to disagree with the
-- posting it belongs to.
-- ----------------------------------------------------------------------------
alter table public.payroll_postings
  add constraint payroll_postings_id_company_period_key
  unique (id, company_id, period_month);

alter table public.payroll_postings
  add column if not exists lines_reconstructed_at timestamptz;

alter table public.payroll_postings
  add column if not exists lines_reconstruction_note text;

comment on column public.payroll_postings.lines_reconstructed_at is
  'Null when this posting''s payroll_posting_lines were captured at the moment of posting (every posting made from 1440 onwards). Set when they were reconstructed after the fact by re-running get_payroll_run, which is the best that can be done for a month posted before the snapshot existed — a reconstruction is evidence only to the extent it still agrees with the posted voucher.';

comment on column public.payroll_postings.lines_reconstruction_note is
  'Null when this posting''s lines tie to the voucher it posted (and on every posting captured at posting time). Otherwise the variance, in words: a reconstructed month whose figures no longer agree with its own ledger entry. Not an error to be swallowed — the month was paid and remitted on the voucher''s figures, so a variance here is a correction somebody owes the books.';

create table public.payroll_posting_lines (
  id uuid primary key default gen_random_uuid(),
  posting_id uuid not null,
  company_id uuid not null,
  period_month date not null,
  employee_id uuid not null,
  employee_name text not null,
  days_in_month integer not null,
  days_paid integer not null,
  basic numeric not null,
  dearness_allowance numeric not null,
  hra numeric not null,
  special_allowance numeric not null,
  other_allowance numeric not null,
  gross_pay numeric not null,
  pf_wage numeric not null,
  pf_employee numeric not null,
  pf_employer numeric not null,
  edli_employer numeric not null,
  esi_applicable boolean not null,
  esi_employee numeric not null,
  esi_employer numeric not null,
  professional_tax numeric not null,
  tds numeric not null,
  net_pay numeric not null,
  created_at timestamptz not null default now(),
  unique (posting_id, employee_id),
  foreign key (posting_id, company_id, period_month)
    references public.payroll_postings (id, company_id, period_month) on delete cascade
);

create index payroll_posting_lines_period_idx
  on public.payroll_posting_lines (company_id, period_month);

comment on table public.payroll_posting_lines is
  'What each employee was actually paid and had deducted in a month that was POSTED — written once by post_payroll_run and never recomputed. employee_id is deliberately NOT a foreign key and employee_name is stored, not joined: a filed return must survive the employee record being edited or removed. Statutory reports read this (via get_posted_payroll_run); the preview screen keeps computing from the salary structure (get_payroll_run). See 1440.';

alter table public.payroll_posting_lines enable row level security;

create policy payroll_posting_lines_read on public.payroll_posting_lines
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy payroll_posting_lines_write on public.payroll_posting_lines
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

-- ----------------------------------------------------------------------------
-- Backfill, BEFORE get_payroll_run is changed below, so the reconstruction
-- runs against the old, purely-computing definition. (It would in any case:
-- the new snapshot branch is empty until this statement finishes.)
-- ----------------------------------------------------------------------------
insert into public.payroll_posting_lines (
  posting_id, company_id, period_month,
  employee_id, employee_name, days_in_month, days_paid,
  basic, dearness_allowance, hra, special_allowance, other_allowance,
  gross_pay, pf_wage, pf_employee, pf_employer, edli_employer,
  esi_applicable, esi_employee, esi_employer, professional_tax, tds, net_pay)
select pp.id, pp.company_id, pp.period_month, r.*
  from public.payroll_postings pp
  cross join lateral public.get_payroll_run(pp.company_id, pp.period_month) r;

-- Stamp every backfilled posting as reconstructed, and record how far the
-- reconstruction is from the voucher it claims to describe. Gross, TDS and net
-- pay are the three the voucher states unambiguously as single ledger lines —
-- PF Payable carries EDLI and the establishment admin charge, which have no
-- per-employee counterpart, so it is not a fair comparison and is left out.
update public.payroll_postings pp
   set lines_reconstructed_at = now(),
       lines_reconstruction_note = v.note
  from (
    select
      pp2.id,
      nullif(concat_ws('; ',
        case when s.gross is distinct from vch.gross
             then 'gross ' || to_char(s.gross, 'FM9999999990.00')
               || ' vs voucher ' || to_char(vch.gross, 'FM9999999990.00') end,
        case when s.tds is distinct from vch.tds
             then 'TDS ' || to_char(s.tds, 'FM9999999990.00')
               || ' vs voucher ' || to_char(vch.tds, 'FM9999999990.00') end,
        case when s.net is distinct from vch.net
             then 'net pay ' || to_char(s.net, 'FM9999999990.00')
               || ' vs voucher ' || to_char(vch.net, 'FM9999999990.00') end
      ), '') as note
      from public.payroll_postings pp2
      cross join lateral (
        select coalesce(sum(pl.gross_pay), 0) as gross,
               coalesce(sum(pl.tds), 0)       as tds,
               coalesce(sum(pl.net_pay), 0)   as net
          from public.payroll_posting_lines pl
         where pl.posting_id = pp2.id
      ) s
      cross join lateral (
        select
          coalesce(sum(e.debit_amount)  filter (where m.purpose = 'salary_expense'), 0)   as gross,
          coalesce(sum(e.credit_amount) filter (where m.purpose = 'tds_payable'), 0)      as tds,
          coalesce(sum(e.credit_amount) filter (where m.purpose = 'net_pay_payable'), 0)  as net
          from public.voucher_entries e
          join public.payroll_ledger_map m
            on m.ledger_id = e.ledger_id and m.company_id = pp2.company_id
         where e.voucher_id = pp2.voucher_id
      ) vch
  ) v
 where pp.id = v.id
   and exists (select 1 from public.payroll_posting_lines pl where pl.posting_id = pp.id);

-- ----------------------------------------------------------------------------
-- get_posted_payroll_run — the statutory read. Same column shape as
-- get_payroll_run so a report can be moved onto it by changing the RPC name
-- and nothing else. Returns no rows at all for a month that was never posted,
-- which is the whole point: a return reports what happened.
-- ----------------------------------------------------------------------------
create or replace function public.get_posted_payroll_run(
  p_company_id uuid,
  p_period_month date
) returns table (
  employee_id uuid,
  employee_name text,
  days_in_month integer,
  days_paid integer,
  basic numeric,
  dearness_allowance numeric,
  hra numeric,
  special_allowance numeric,
  other_allowance numeric,
  gross_pay numeric,
  pf_wage numeric,
  pf_employee numeric,
  pf_employer numeric,
  edli_employer numeric,
  esi_applicable boolean,
  esi_employee numeric,
  esi_employer numeric,
  professional_tax numeric,
  tds numeric,
  net_pay numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    pl.employee_id, pl.employee_name, pl.days_in_month, pl.days_paid,
    pl.basic, pl.dearness_allowance, pl.hra, pl.special_allowance, pl.other_allowance,
    pl.gross_pay, pl.pf_wage, pl.pf_employee, pl.pf_employer, pl.edli_employer,
    pl.esi_applicable, pl.esi_employee, pl.esi_employer, pl.professional_tax,
    pl.tds, pl.net_pay
    from public.payroll_posting_lines pl
   where pl.company_id = p_company_id
     and pl.period_month = date_trunc('month', p_period_month)::date
   order by pl.employee_name;
$$;

revoke all on function public.get_posted_payroll_run(uuid, date) from public, anon;
grant execute on function public.get_posted_payroll_run(uuid, date) to authenticated;

comment on function public.get_posted_payroll_run(uuid, date) is
  'One POSTED month of payroll, per employee, exactly as it was recorded when the month was posted — never recomputed. Zero rows for a month that was never run. Same column shape as get_payroll_run so a statutory report (Form 138/24Q, the wage register, PF ECR, ESI MC, Form 16 Part B) can read it instead. Use get_payroll_run only to preview a month you are about to post. See 1440.';

-- ----------------------------------------------------------------------------
-- post_payroll_run: write the snapshot. Targeted replace over the live
-- definition, asserted, per the house pattern in 1200/1230/1240 — the function
-- is long and retyping it is how unrelated behaviour drifts.
--
-- ORDERING MATTERS. The lines are read from get_payroll_run AFTER the
-- payroll_postings row is inserted but BEFORE any line exists, and
-- get_payroll_run's new snapshot branch keys on payroll_posting_lines, not on
-- payroll_postings — so this call still computes. Every later call sees the
-- snapshot.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_new text;
  v_decl_from constant text := $a1$  v_lines jsonb := '[]'::jsonb;
begin$a1$;
  v_decl_to constant text := $a2$  v_lines jsonb := '[]'::jsonb;
  v_posting_id uuid;
begin$a2$;
  v_ins_from constant text := $b1$values (p_company_id, v_period_start, v_voucher_id, auth.uid());

  return v_voucher_id;$b1$;
  v_ins_to constant text := $b2$values (p_company_id, v_period_start, v_voucher_id, auth.uid())
  returning id into v_posting_id;

  -- The record of what was actually paid and deducted this month. Read from
  -- get_payroll_run one last time: payroll_posting_lines is still empty for
  -- this month, so that call computes; every call after this one answers from
  -- these rows instead (1440).
  insert into public.payroll_posting_lines (
    posting_id, company_id, period_month,
    employee_id, employee_name, days_in_month, days_paid,
    basic, dearness_allowance, hra, special_allowance, other_allowance,
    gross_pay, pf_wage, pf_employee, pf_employer, edli_employer,
    esi_applicable, esi_employee, esi_employer, professional_tax, tds, net_pay)
  select v_posting_id, p_company_id, v_period_start, r.*
    from public.get_payroll_run(p_company_id, v_period_start) r;

  return v_voucher_id;$b2$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_payroll_run' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1440: public.post_payroll_run is missing.';
  end if;

  if (length(v_def) - length(replace(v_def, v_decl_from, ''))) / length(v_decl_from) <> 1 then
    raise exception '1440: post_payroll_run''s declare block has moved; fix by hand.';
  end if;
  if (length(v_def) - length(replace(v_def, v_ins_from, ''))) / length(v_ins_from) <> 1 then
    raise exception '1440: post_payroll_run''s payroll_postings insert has moved; fix by hand.';
  end if;

  v_new := replace(replace(v_def, v_decl_from, v_decl_to), v_ins_from, v_ins_to);
  execute v_new;
end;
$mig$;

revoke all on function public.post_payroll_run(uuid, uuid, date) from public, anon;
grant execute on function public.post_payroll_run(uuid, uuid, date) to authenticated;

-- ----------------------------------------------------------------------------
-- get_payroll_run: answer from the snapshot for a posted month, compute only
-- for a month that has not been posted and is not more than one month ahead of
-- today. Two targeted replaces at the tail; the employee filtering 1240 fixed
-- is not touched.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_new text;
  v_head_from constant text := $c1$)
  select
    a.employee_id,$c1$;
  v_head_to constant text := $c2$),
  computed_rows as (
  select
    a.employee_id,$c2$;
  v_tail_from constant text := $d1$    from amounts a
   order by a.employee_name;$d1$;
  v_tail_to constant text := $d2$    from amounts a
  )
  -- A month that was POSTED answers from what was posted, not from what the
  -- salary structure says today. This is what stops a later salary revision,
  -- a corrected joining date or a new employee rewriting a month that has
  -- already been paid, remitted and filed (1440; 1240 fixed one instance of
  -- the same disease, resignations, at the employee filter).
  select pl.employee_id, pl.employee_name, pl.days_in_month, pl.days_paid,
         pl.basic, pl.dearness_allowance, pl.hra, pl.special_allowance,
         pl.other_allowance, pl.gross_pay, pl.pf_wage, pl.pf_employee,
         pl.pf_employer, pl.edli_employer, pl.esi_applicable, pl.esi_employee,
         pl.esi_employer, pl.professional_tax, pl.tds, pl.net_pay
    from public.payroll_posting_lines pl
   where pl.company_id = p_company_id
     and pl.period_month = date_trunc('month', p_period_month)::date
  union all
  -- Otherwise compute, which is a PREVIEW of a month you may be about to run
  -- -- but not for a month that is more than one calendar month away. One
  -- month of headroom because running the coming month at a month end is
  -- ordinary work; beyond that there is nothing to preview, only a fabricated
  -- register. post_payroll_run refuses the same window, with a better message
  -- (1442).
  select cr.* from computed_rows cr
   where not exists (
           select 1
             from public.payroll_posting_lines pl2
            where pl2.company_id = p_company_id
              and pl2.period_month = date_trunc('month', p_period_month)::date)
     and date_trunc('month', p_period_month)::date
         <= (date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)
             + interval '1 month')::date
   order by employee_name;$d2$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_payroll_run' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1440: public.get_payroll_run is missing.';
  end if;

  -- 1240's fix must still be in place; this migration relies on it staying
  -- exactly where it is and would be building on sand if it had gone.
  if v_def !~ 'e\.is_active or e\.date_of_leaving is not null' then
    raise exception '1440: get_payroll_run has lost 1240''s employee filter; stop and look.';
  end if;

  if (length(v_def) - length(replace(v_def, v_head_from, ''))) / length(v_head_from) <> 1 then
    raise exception '1440: get_payroll_run''s final select has moved; fix by hand.';
  end if;
  if (length(v_def) - length(replace(v_def, v_tail_from, ''))) / length(v_tail_from) <> 1 then
    raise exception '1440: get_payroll_run''s order by has moved; fix by hand.';
  end if;

  v_new := replace(replace(v_def, v_head_from, v_head_to), v_tail_from, v_tail_to);
  execute v_new;
end;
$mig$;

revoke all on function public.get_payroll_run(uuid, date) from public, anon;
grant execute on function public.get_payroll_run(uuid, date) to authenticated;

comment on function public.get_payroll_run(uuid, date) is
  'One month of payroll per employee. A month that has been POSTED is answered from payroll_posting_lines exactly as it was recorded at posting; any other month is COMPUTED from the effective-dated salary structure as a preview, and only for months up to one month ahead of today. Employees are judged on date_of_joining/date_of_leaving, never on the current is_active flag (1240). A statutory return must read get_posted_payroll_run instead, which never computes (1440).';

comment on function public.post_payroll_run(uuid, uuid, date) is
  'Posts one month''s payroll as a single journal voucher (Dr Salary Expense + Employer PF/ESI, Cr PF/ESI/PT/TDS Payable + Salaries Payable) and records, in payroll_posting_lines, exactly what each employee was paid and had deducted at that moment -- the record every statutory return reads afterwards, so a later change to the employee master or salary structure cannot rewrite a filed month (1440). Raises if the month is already posted.';
