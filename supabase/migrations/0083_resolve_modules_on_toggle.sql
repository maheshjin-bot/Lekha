-- ============================================================================
-- 0083 — A conditional module could never activate from an optional one
-- ============================================================================
-- app_private.resolve_conditional_modules() decides which conditional modules
-- a company should have, and it is correct. The problem is when it RUNS. Its
-- only triggers are:
--
--   companies          AFTER INSERT OR UPDATE OF compliance_mode, entity_type,
--                      pan, tan, iec
--   gst_registrations  AFTER INSERT OR DELETE OR UPDATE
--
-- Turning a module on or off goes through public.set_module, which does not
-- call the resolver at all. So a conditional module whose depends_on names an
-- OPTIONAL module can never activate: enabling the dependency is exactly the
-- event nothing listens for.
--
-- Two modules are in that position — `payroll_statutory` (depends on
-- `payroll`) and `gst_multistate` (depends on `gst` and `multi_branch`) — and
-- two companies are living it right now. Both have payroll enabled and
-- compliance_mode = 'compliance', which is precisely what
-- payroll_statutory.activates_when requires, and neither has it. PF, ESI and
-- professional tax were silently switched off for companies that had asked
-- for payroll and were in compliance mode.
--
-- THE OBVIOUS FIX ALONE WOULD TRAP THE USER. Calling the resolver from
-- set_module activates payroll_statutory — and then set_module's own
-- disable-path guard refuses to switch payroll back off, because a module
-- depends on it:
--
--     "Disable PF, ESI and Professional Tax first — it depends on Payroll"
--
-- but the user cannot disable that one either, because set_module rejects any
-- attempt to toggle a conditional module ("governed by this company's
-- registrations and entity type, not by a setting"). Payroll would become
-- permanently un-disablable. Verified by simulating it before writing this.
--
-- So the guard is narrowed at the same time: it now considers only OPTIONAL
-- dependents, which are the ones a user actually controls and must therefore
-- be asked about. A conditional dependent needs no such question — the
-- resolver deactivates it automatically on the next pass, which is what its
-- "not v_should and v_is_open" branch already exists to do.
--
-- The resolver is idempotent and converges (it loops to a fixpoint, capped at
-- ten passes), so calling it on every toggle is safe and cheap.
--
-- ONE LIMITATION THAT REMAINS, FOUND WHILE TESTING THIS AND LEFT DELIBERATELY.
-- resolve_conditional_modules() reasons entirely "as of today" — it calls
-- module_active() with the default date. set_module, however, accepts a
-- p_from_date. Disable a dependency effective TOMORROW and the resolver, asked
-- today, still sees it active and correctly leaves the dependent on; nothing
-- then re-runs tomorrow to stand it down, because there is no scheduled job.
--
-- Not fixed here because it is unreachable from the application: ModuleManager
-- calls set_module with company, code and enabled only, never a date, so every
-- toggle a user can make is same-day. Fixing it properly means threading a date
-- through resolve_conditional_modules and its two trigger functions, which is a
-- change to the module engine rather than to this bug, and would be a poor
-- thing to smuggle into a fix for a different defect. Named here so it is found
-- deliberately rather than rediscovered as a mystery.
--
-- Related and worth knowing when reading test output: a module enabled and
-- disabled on the SAME DAY stays active for that day. The disable sets
-- effective_to = greatest(effective_from, p_from_date - 1), so a module whose
-- effective_from is today gets effective_to = today, and module_active treats
-- "effective_to >= the date asked about" as still active. That is the existing
-- effective-dating semantics, not a defect — but it makes a same-day
-- enable/disable look like a no-op if you check it today instead of tomorrow.
-- ============================================================================

create or replace function public.set_module(
  p_company_id uuid,
  p_module_code text,
  p_enabled boolean,
  p_from_date date default current_date
)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_module public.ref_modules%rowtype;
  v_dep text;
  v_dependent text;
  v_rows integer;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can change which modules this company uses';
  end if;

  select * into v_module from public.ref_modules where code = p_module_code;
  if not found then
    raise exception 'Unknown module %', p_module_code;
  end if;

  if v_module.tier = 'core' then
    raise exception '% is part of the accounting core and cannot be switched off', v_module.name;
  end if;

  if v_module.tier = 'conditional' then
    raise exception '% is governed by this company''s registrations and entity type, not by a setting. Change the underlying detail instead.', v_module.name;
  end if;

  if p_enabled then
    foreach v_dep in array v_module.depends_on loop
      if not app_private.module_active(p_company_id, v_dep, p_from_date) then
        raise exception '% requires % to be enabled first',
          v_module.name,
          coalesce((select name from public.ref_modules where code = v_dep), v_dep);
      end if;
    end loop;

    if app_private.module_active(p_company_id, p_module_code, p_from_date) then
      return; -- already on
    end if;

    insert into public.company_modules (company_id, module_code, effective_from, enabled_by)
    values (p_company_id, p_module_code, p_from_date, auth.uid());
  else
    -- Only an OPTIONAL dependent is the user's to decide about. A CONDITIONAL
    -- one is the resolver's, and it stands itself down on the next pass — so
    -- blocking on it here would make this module impossible to switch off,
    -- since a conditional module cannot be toggled by hand either.
    select r.name into v_dependent
      from public.ref_modules r
     where p_module_code = any(r.depends_on)
       and r.tier = 'optional'
       and app_private.module_active(p_company_id, r.code, p_from_date)
     limit 1;

    if v_dependent is not null then
      raise exception 'Disable % first — it depends on %', v_dependent, v_module.name;
    end if;

    update public.company_modules
       set effective_to = greatest(effective_from, p_from_date - 1)
     where company_id = p_company_id
       and module_code = p_module_code
       and effective_to is null;

    get diagnostics v_rows = row_count;
    -- Turning off something that was never on is a no-op, not an error — but
    -- it must not be reported as a change either.
    if v_rows = 0 then
      return;
    end if;
  end if;

  -- The point of this migration: a toggle can change what the conditional
  -- tier should contain, in both directions. Idempotent and convergent, so
  -- running it on every real change costs nothing.
  perform app_private.resolve_conditional_modules(p_company_id);
end;
$fn$;

revoke all on function public.set_module(uuid, text, boolean, date) from public, anon;
grant execute on function public.set_module(uuid, text, boolean, date) to authenticated;

comment on function public.set_module(uuid, text, boolean, date) is
  'Turns an optional module on or off, then re-resolves the conditional tier — without which a conditional module depending on an optional one could never activate (see 0083). The disable guard considers only optional dependents; conditional ones stand themselves down.';

-- ----------------------------------------------------------------------------
-- Backfill: every company that has been sitting in the broken state
-- ----------------------------------------------------------------------------
do $backfill$
declare
  r record;
begin
  for r in select id from public.companies loop
    perform app_private.resolve_conditional_modules(r.id);
  end loop;
end;
$backfill$;
