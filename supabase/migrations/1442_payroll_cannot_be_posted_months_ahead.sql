-- ============================================================================
-- 1442 — Payroll for a month that has not happened yet
-- ============================================================================
-- WHAT THE PILOT SAW. On 2 Sep 2026, post_payroll_run accepted a payroll month
-- seven months away without a word:
--
--   post_payroll_run(Rangoli, HO, '2027-03-01')
--     -> voucher HO/JRN/2026-27/00008, dated 31 Mar 2027,
--        Dr 2,82,045 — Salary Expense 2,70,000, employer PF and ESI on top,
--        Cr Salaries Payable, PF/ESI/PT/TDS Payable
--
-- Every one of those is a fabrication: nobody has worked March 2027, nobody
-- has been paid, and nothing has been deducted. It lands in the ledger, in the
-- trial balance, in PF/ESI liability and in TDS Payable. And because of the
-- defect 1441 fixes, until 1441 it could not be taken back.
--
-- WHY IT IS WRONG, and under what. s.128(1) of the Companies Act 2013 requires
-- books of account that "give a true and fair view" and that are "kept on
-- accrual basis and according to the double entry system of accounting" —
-- accrual recognises an expense when it is incurred, and salary for a month
-- nobody has worked is not incurred. The TDS half is worse than a
-- presentation error: TDS on salary (Sec 392 of the Income-tax Act, 2025,
-- which replaced Sec 192 of the 1961 Act and is reported on Form 138, the
-- former Form 24Q) is deducted AT THE TIME OF PAYMENT, so crediting TDS
-- Payable for a month not yet paid asserts a statutory liability that does not
-- exist, and feeds a Form 138 quarter with tax nobody deducted.
--
-- WHAT "TOO FAR AHEAD" ACTUALLY MEANS, which is the whole difficulty. Payroll
-- is routinely run BEFORE the month it belongs to has ended — salaries are
-- usually paid on the last working day — and it is not unusual to process the
-- coming month at a month end. This very pilot posted Sep 2026 on 31 Aug 2026,
-- and that is ordinary work that must keep working; a refusal that blocks it
-- would be worse than the bug it fixes. So the line is drawn at one whole
-- month of headroom rather than at the current month:
--
--   posting is allowed for any month up to and including the month AFTER the
--   month today falls in.
--
-- On 2 Sep 2026 that permits Apr 2026 (a month genuinely missed) through Oct
-- 2026, and refuses Nov 2026 onward. It is a cliff nobody normal is near.
-- 1440 already applies the identical window to the payroll register's computed
-- preview, so the screen and the button agree: if a month cannot be posted, it
-- is not shown as a register either.
--
-- DELIBERATELY NOT GUARDED HERE: the lower end. A month before the company's
-- book beginning, or inside a locked period, is already refused — by
-- app_private.enforce_period_open on vouchers, which fires when
-- post_payroll_run's create_voucher runs. Adding a second, differently-worded
-- rejection for the same case would only make the app harder to read.
--
-- The timezone is Asia/Kolkata, not the server's, for the same reason 0871
-- gives: "today" for an Indian statutory app is today in India. With a month
-- of headroom the choice cannot actually change an answer, but it should still
-- say what it means.
-- ============================================================================

do $mig$
declare
  v_def text;
  v_new text;
  v_from constant text := $a1$  v_posted_as text;
begin
  -- Deleting the payroll voucher$a1$;
  v_to constant text := $a2$  v_posted_as text;
begin
  -- A month nobody has worked cannot have accrued a salary expense, and tax
  -- is deducted at the time of payment, not before it (s.128(1) Companies Act
  -- 2013; Sec 392 Income-tax Act 2025, formerly Sec 192). One month of
  -- headroom, not zero: running the coming month's payroll at a month end is
  -- ordinary work -- this app's own pilot posted Sep 2026 on 31 Aug 2026 --
  -- and a refusal that blocks that would be worse than the bug. get_payroll_run
  -- stops computing a preview at the same boundary (1440).
  if v_period_start > (date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)
                       + interval '1 month')::date then
    raise exception
      'Payroll for % is too far ahead to post — today is %, and a month can be posted from the first of the month before it, so % from % onward.',
      to_char(v_period_start, 'Mon YYYY'),
      to_char((now() at time zone 'Asia/Kolkata')::date, 'DD Mon YYYY'),
      to_char(v_period_start, 'Mon YYYY'),
      to_char((v_period_start - interval '1 month')::date, 'DD Mon YYYY');
  end if;

  -- Deleting the payroll voucher$a2$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_payroll_run' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1442: public.post_payroll_run is missing.';
  end if;

  if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
    raise exception
      '1442: post_payroll_run''s opening does not look like 1441 left it; fix by hand.';
  end if;

  v_new := replace(v_def, v_from, v_to);
  execute v_new;
end;
$mig$;

revoke all on function public.post_payroll_run(uuid, uuid, date) from public, anon;
grant execute on function public.post_payroll_run(uuid, uuid, date) to authenticated;

comment on function public.post_payroll_run(uuid, uuid, date) is
  'Posts one month''s payroll as a single journal voucher (Dr Salary Expense + Employer PF/ESI, Cr PF/ESI/PT/TDS Payable + Salaries Payable) and records in payroll_posting_lines exactly what each employee was paid and had deducted at that moment, which is what every statutory return reads afterwards (1440). Refuses a month already posted, naming the voucher to delete if it has to be redone (1441), and a month more than one calendar month ahead of today, which has not been worked and so has nothing to accrue (1442).';
