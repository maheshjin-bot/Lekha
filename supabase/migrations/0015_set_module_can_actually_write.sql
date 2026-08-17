-- ============================================================================
-- 0015 — set_module() could never write
-- ============================================================================
-- company_modules has no INSERT or UPDATE policy, deliberately: module state
-- should only change through set_module() and the conditional resolver, both
-- of which enforce the tier rules.
--
-- The resolver is SECURITY DEFINER, so it worked. set_module was SECURITY
-- INVOKER, so RLS silently filtered its writes to zero rows and the function
-- returned success having done nothing. A user toggling an optional module
-- saw no error and no effect — a worse failure than an exception, because
-- nothing points at the cause.
--
-- The comment in 0004 claimed this function enforced the rules. It enforced
-- the tier rules and then never got past RLS to apply them.
--
-- Now definer, with the authorisation check it should always have had:
-- changing which modules a company runs is an admin decision, and nothing
-- previously said so.
-- ============================================================================

create or replace function public.set_module(
  p_company_id uuid,
  p_module_code text,
  p_enabled boolean,
  p_from_date date default current_date
) returns void
language plpgsql
security definer
set search_path = ''
as $$
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
    select r.name into v_dependent
      from public.ref_modules r
     where p_module_code = any(r.depends_on)
       and app_private.module_active(p_company_id, r.code, p_from_date)
     limit 1;

    if v_dependent is not null then
      raise exception 'Disable % first — it depends on %', v_dependent, v_module.name;
    end if;

    -- Closing the period, not deleting the row: data posted while the module
    -- was on has to stay readable.
    update public.company_modules
       set effective_to = greatest(effective_from, p_from_date - 1)
     where company_id = p_company_id
       and module_code = p_module_code
       and effective_to is null;

    get diagnostics v_rows = row_count;
    -- Turning off something never on is a no-op, not an error — but it must
    -- not be reported as a change either.
    if v_rows = 0 then
      return;
    end if;
  end if;
end;
$$;

revoke execute on function public.set_module(uuid, text, boolean, date) from public, anon;
grant execute on function public.set_module(uuid, text, boolean, date) to authenticated;
