-- ============================================================================
-- 0014 — Default godown, cascade ordering, and a null-safety hole in the
--        authorisation predicates
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The predicate bug — the important half of this migration
-- ----------------------------------------------------------------------------
-- user_role_in_company returns NULL for a non-member, so is_company_admin and
-- can_write_company returned NULL rather than false.
--
-- In an RLS USING clause a NULL is treated as false and no harm follows. But
-- in a PL/pgSQL guard written the obvious way —
--
--     if not app_private.is_company_admin(p_company_id) then
--       raise exception 'Only an admin can ...';
--     end if;
--
-- — NOT NULL is NULL, which is not true, so the branch never fires and the
-- guard silently passes. delete_company() and protect_ledger_financial_fields
-- were both relying on it.
--
-- Found by calling delete_company() with no session and watching it succeed.
--
-- Fixed at the source rather than by writing `is not true` at each call site,
-- because the next guard someone writes will use the obvious form. A predicate
-- used for authorisation has to be two-valued.
create or replace function app_private.is_company_admin(p_company_id uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select coalesce(app_private.user_role_in_company(p_company_id) = 'admin', false);
$$;

create or replace function app_private.can_write_company(p_company_id uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select coalesce(app_private.user_role_in_company(p_company_id) in ('admin','accountant'), false);
$$;


-- ----------------------------------------------------------------------------
-- Every branch needs a default godown
-- ----------------------------------------------------------------------------
-- A stock line requires one, so a company without any cannot record stock at
-- all. Seeded alongside the head office, the same way the chart of accounts
-- is — there is no useful "configure inventory first" step.
create or replace function public.create_company(
  p_name text,
  p_entity_type text,
  p_book_beginning_date date,
  p_state_code char(2),
  p_compliance_mode text default 'books_only',
  p_pan text default null,
  p_financial_year_start_month smallint default 4
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_branch_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (select 1 from public.ref_states where code = p_state_code and is_active) then
    raise exception 'Unknown or inactive state code %', p_state_code;
  end if;

  insert into public.companies (
    name, entity_type, compliance_mode, pan,
    book_beginning_date, financial_year_start_month, created_by)
  values (
    p_name, p_entity_type, p_compliance_mode, p_pan,
    p_book_beginning_date, p_financial_year_start_month, auth.uid())
  returning id into v_company_id;

  insert into public.company_members (company_id, user_id, role)
  values (v_company_id, auth.uid(), 'admin');

  perform app_private.seed_chart_of_accounts(v_company_id);

  insert into public.branches (company_id, code, name, state_code, is_head_office)
  values (v_company_id, 'HO', 'Head Office', p_state_code, true)
  returning id into v_branch_id;

  insert into public.godowns (company_id, branch_id, code, name, is_default)
  values (v_company_id, v_branch_id, 'MAIN', 'Main Store', true);

  perform app_private.resolve_conditional_modules(v_company_id);

  return v_company_id;
end;
$$;

revoke execute on function public.create_company(text, text, date, char, text, text, smallint) from anon;

-- Backfill for companies created before this migration; without one they
-- cannot record stock.
insert into public.godowns (company_id, branch_id, code, name, is_default)
select b.company_id, b.id, 'MAIN', 'Main Store', true
  from public.branches b
 where not exists (select 1 from public.godowns g where g.branch_id = b.id);


-- ----------------------------------------------------------------------------
-- Cascade ordering, extended for inventory
-- ----------------------------------------------------------------------------
-- Same problem 0010 solved for voucher_entries: items and godowns are
-- referenced by stock lines, which are referenced by nothing that cascades
-- ahead of them. Stock lines cascade from the voucher, so vouchers go first.
create or replace function public.delete_company(p_company_id uuid)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can delete a company';
  end if;

  delete from public.vouchers where company_id = p_company_id;  -- cascades entries and stock lines
  delete from public.items    where company_id = p_company_id;
  delete from public.godowns  where company_id = p_company_id;
  delete from public.ledgers  where company_id = p_company_id;
  delete from public.companies where id = p_company_id;
  delete from public.audit_log where company_id = p_company_id;
end;
$$;

revoke execute on function public.delete_company(uuid) from public, anon;
grant execute on function public.delete_company(uuid) to authenticated;
