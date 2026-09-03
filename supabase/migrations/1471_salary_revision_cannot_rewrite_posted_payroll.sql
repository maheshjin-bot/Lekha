-- A salary revision must not rewrite a month that has already been posted.
--
-- WHY THIS MIGRATION EXISTS AT ALL. No employee in this application has ever
-- been given a pay rise, because there is no way to give one. The Employees
-- screen creates an employee and their first salary structure together and
-- then says so in its own words — "Editing a salary later needs a new
-- structure row — not yet a form here". Verified live before writing this:
-- every one of the pilot company's six employees has exactly ONE
-- employee_salary_structures row, and so does every employee at every other
-- company in the database. A mistyped starting salary is equally permanent.
--
-- The mechanism itself was designed for from the start and simply never
-- exposed. get_payroll_run's `latest_structure` CTE picks, per employee, the
-- newest structure row in force for the month it is computing — an
-- effective-dated history, in which a second row IS a pay rise: every payroll
-- month from its effective date onward uses it, and every month before it does
-- not. The companion frontend change exposes exactly that, and invents nothing.
--
-- WHY IT NEEDS A GUARD. Effective dating is retrospective by construction:
-- nothing about "the row in force for this month" cares whether that month has
-- already been paid, remitted and filed. Back-dating a rise therefore restates
-- history, and the LEDGER stays untouched while it does, so nothing on screen
-- ever shows a conflict. 1240 fixed one instance of exactly this disease from
-- the other direction (a September resignation restating August's PF ECR).
--
-- HOW MUCH OF THAT IS ALREADY COVERED, checked live rather than assumed —
-- because a concurrent piece of work landed 1440/1442 while this was being
-- written. get_payroll_run now answers a POSTED month from a snapshot table,
-- payroll_posting_lines, and only computes for months that have not been
-- posted. So get_payroll_run itself, and everything built on it (the payroll
-- register, ESI MC, 24Q Annexure I), is already immune to a back-dated
-- revision. That is a good fix and this migration does not duplicate or touch
-- it.
--
-- WHAT IS STILL EXPOSED, and is why this guard is not redundant. Four
-- functions read employee_salary_structures DIRECTLY rather than through
-- get_payroll_run, confirmed by reading their live definitions:
--
--   get_pt_liability_by_state       professional_tax_monthly, per State
--   get_salary_tds_estimate         projected annual gross
--   get_statutory_bonus_computation basic + DA against the Bonus Act ceiling
--   get_fnf_preview                 last drawn wage for gratuity/encashment
--
-- Reproduced on the pilot company, which has August and September 2026 posted:
-- recording a rise effective 1 September moved
--
--   get_pt_liability_by_state(Sep 2026)   1,200  ->  1,400
--
-- for a month whose posted voucher still credits Professional Tax Payable
-- 1,200 and whose PT challan has been paid at 1,200. The PF ECR for the same
-- month did NOT move, because that one now reads the snapshot — which is
-- precisely the shape of the remaining hole.
--
-- Guarding the WRITE closes all four at once and keeps the master data
-- honest besides: a structure row claiming a salary applied from a date inside
-- a month that was actually paid at a different figure is a lie the payroll
-- history has to keep working around.
--
-- WHAT THE GUARD IS. A trigger, not a function argument, so it holds on every
-- path into the table — the new form, a CSV import, a direct PostgREST call.
--
--   INSERT   refused when the employee ALREADY has a structure row (i.e. this
--            is a revision, not a hire) and the new effective date falls in or
--            before a posted month.
--   UPDATE   refused when the row's existing effective date is in or before a
--            posted month, and refused when the new one would be.
--   DELETE   refused when the row's effective date is in or before a posted
--            month.
--
-- WHY THE FIRST ROW FOR AN EMPLOYEE IS EXEMPT. Creating an employee writes
-- their opening structure effective from their date of joining, and a company
-- that posts payroll monthly will routinely enter a joiner after the month has
-- been posted. Refusing that would break the existing hire flow — a behaviour
-- change well beyond a revision guard — for a case that adds a person to a
-- month rather than restating one. It is left alone deliberately, and named
-- here so the exemption is a decision rather than an oversight.
--
-- WHAT IS DELIBERATELY NOT GUARDED.
--
--   * A finalized full-and-final settlement. employee_exit_settlements stores
--     its computed amounts as columns (gratuity_last_drawn_wage,
--     leave_encashment_amount, net_payable and the rest), so a finalized
--     settlement is a snapshot and a later structure change cannot restate it.
--     Checked in information_schema before relying on it.
--   * The period lock. A structure row is master data, not a posting; the
--     posting it feeds is already guarded by post_payroll_run's own
--     "Payroll for % has already been posted" check and by the lock on the
--     voucher it creates.
--   * Any month that has NOT been posted. Restating an unposted month is the
--     entire point of a correction.
--   * Arrears. A rise agreed in October but effective from July is real, and
--     this guard refuses to record it as a back-dated structure row — because
--     doing so would restate July, August and September in the four reports
--     above rather than pay the difference in October. Arrears belong in the
--     month they are paid; the app has no arrears line today, and inventing
--     one is a feature, not a guard. Said plainly here so the refusal reads as
--     a decision rather than an omission.

-- ---------------------------------------------------------------------------
-- 1. "Does this effective date fall inside, or before, a posted month?"
-- ---------------------------------------------------------------------------
-- ONE rule, used by all three arms, deliberately coarser than "is this the row
-- get_payroll_run would pick".
--
-- The first draft of this migration mirrored get_payroll_run's selection
-- exactly — the latest row effective on or before the month's first day. That
-- draft was WRONG within the hour: a concurrent piece of work relaxed
-- get_payroll_run's own predicate to `effective_from <= period_end`, with a
-- two-stage ORDER BY that falls back to the earliest row inside the month when
-- an employee has none before it (so a mid-month joiner is finally paid in
-- their joining month). A guard that reimplements a predicate someone else
-- owns is a guard that silently stops guarding when they improve it.
--
-- So this asks the coarser question the guard actually cares about: is
-- p_effective_from on or before the last day of the newest month that has been
-- posted? Every row a posted month could possibly select satisfies that under
-- BOTH the old predicate and the new one, and under any future predicate that
-- does not reach forward past the month it is computing. It is conservative in
-- one direction only: it also locks a row that a posted month happens not to
-- select — an old structure superseded before the books even began. Refusing
-- to retouch a salary from before the last posted payroll is a cost worth
-- paying for a rule that cannot rot.
--
-- It is also exactly the rule the Employees screen shows the preparer, so the
-- form never offers a date the database will refuse.

drop function if exists app_private.salary_structure_is_posted(uuid, uuid, date);

create or replace function app_private.salary_structure_locked_by_payroll(
  p_company_id uuid, p_effective_from date)
returns boolean
language sql
stable
security definer
set search_path to ''
as $fn$
  select exists (
    select 1
      from public.payroll_postings pp
     where pp.company_id = p_company_id
       and p_effective_from
           < (date_trunc('month', pp.period_month) + interval '1 month')::date
  );
$fn$;

revoke all on function app_private.salary_structure_locked_by_payroll(uuid, date) from public, anon;
grant execute on function app_private.salary_structure_locked_by_payroll(uuid, date) to authenticated;

comment on function app_private.salary_structure_locked_by_payroll(uuid, date) is
  'True when a salary effective from this date falls inside, or before, a payroll month this company has already posted. The single lock rule for employee_salary_structures — deliberately coarser than get_payroll_run''s own row selection, so it cannot drift when that changes. See 1471.';


-- ---------------------------------------------------------------------------
-- 2. The guard
-- ---------------------------------------------------------------------------

create or replace function app_private.guard_posted_payroll_structure()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_company uuid;
  v_last date;
  v_next date;
  v_is_revision boolean;
begin
  -- NEW is unassigned in a DELETE trigger and OLD in an INSERT one, so the
  -- company has to be picked per operation rather than coalesced across both —
  -- touching the unassigned record at all is an error, not a null.
  if TG_OP = 'DELETE' then
    v_company := old.company_id;
  else
    v_company := new.company_id;
  end if;

  select max(pp.period_month) into v_last
    from public.payroll_postings pp
   where pp.company_id = v_company;

  if v_last is null then
    -- This company has never posted payroll; there is nothing to protect.
    if TG_OP = 'DELETE' then return old; else return new; end if;
  end if;

  v_next := (date_trunc('month', v_last) + interval '1 month')::date;

  if TG_OP = 'DELETE' then
    -- On ON DELETE CASCADE the employee (or the company) goes first, so its
    -- absence is how this tells "the parent is being deleted" from "someone is
    -- deleting a structure row". Same escape hatch, and the same reason, as
    -- app_private.protect_system_group (0006).
    if not exists (select 1 from public.employees e where e.id = old.employee_id) then
      return old;
    end if;

    if app_private.salary_structure_locked_by_payroll(old.company_id, old.effective_from) then
      raise exception
        'That salary was in force during payroll that has already been posted (up to %), so it cannot be deleted. Supersede it with a revision from % instead.',
        to_char(v_last, 'Mon YYYY'), to_char(v_next, 'Mon YYYY')
        using errcode = '23514';
    end if;

    return old;
  end if;

  if TG_OP = 'UPDATE' then
    if app_private.salary_structure_locked_by_payroll(old.company_id, old.effective_from) then
      raise exception
        'This salary was in force during payroll that has already been posted (up to %). Correcting it would change a month whose voucher, PF/ESI challans and TDS return are already filed — record a revision effective from % instead.',
        to_char(v_last, 'Mon YYYY'), to_char(v_next, 'Mon YYYY')
        using errcode = '23514';
    end if;

    -- Moving the effective date backwards into a posted month restates that
    -- month even when the row was previously harmless.
    if new.effective_from is distinct from old.effective_from
       and app_private.salary_structure_locked_by_payroll(new.company_id, new.effective_from) then
      raise exception
        'Payroll is posted up to %, so a salary cannot be made effective from %.',
        to_char(v_last, 'Mon YYYY'), to_char(new.effective_from, 'DD Mon YYYY')
        using errcode = '23514';
    end if;

    return new;
  end if;

  -- INSERT. A hire's opening structure is exempt; a revision is not.
  select exists (
    select 1 from public.employee_salary_structures s
     where s.employee_id = new.employee_id
  ) into v_is_revision;

  if v_is_revision
     and app_private.salary_structure_locked_by_payroll(new.company_id, new.effective_from) then
    raise exception
      'Payroll is posted up to %. A revision has to take effect from a later month — the earliest available is %.',
      to_char(v_last, 'Mon YYYY'), to_char(v_next, 'Mon YYYY')
      using errcode = '23514';
  end if;

  return new;
end;
$$;
drop trigger if exists guard_posted_payroll_structure on public.employee_salary_structures;

create trigger guard_posted_payroll_structure
  before insert or update or delete on public.employee_salary_structures
  for each row execute function app_private.guard_posted_payroll_structure();

-- SECURITY DEFINER, so PUBLIC's default EXECUTE grant is taken away rather than
-- left. Safe for the same reason 1470 records: a trigger's privilege check
-- happens at CREATE TRIGGER, not when it fires, and service_role — which holds
-- no USAGE on app_private at all — already fires app_private triggers on every
-- table in this database.
revoke all on function app_private.guard_posted_payroll_structure() from public, anon;
grant execute on function app_private.guard_posted_payroll_structure() to authenticated;

comment on function app_private.guard_posted_payroll_structure() is
  'Stops a salary revision or correction restating a payroll month that has already been posted. A hire''s first structure row is exempt. See 1471.';

-- ---------------------------------------------------------------------------
-- 3. Prove the guard does not condemn data that already exists
-- ---------------------------------------------------------------------------
-- Every structure row in the database today must still be updatable-in-place
-- OR be one a posted month legitimately depends on. This reports the split
-- rather than asserting, because a locked row is the correct outcome, not a
-- fault — what would be a fault is the number being surprising.

do $mig$
declare
  v_total int;
  v_locked int;
begin
  select count(*) into v_total from public.employee_salary_structures;

  select count(*) into v_locked
    from public.employee_salary_structures s
   where app_private.salary_structure_locked_by_payroll(s.company_id, s.effective_from);

  raise notice '1471: % salary structure rows, of which % are locked by posted payroll.',
    v_total, v_locked;
end $mig$;
