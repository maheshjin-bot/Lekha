-- ============================================================================
-- 0044 — Company password protection
-- ============================================================================
-- A Tally-style open-company gate: an admin may set an optional password on
-- a company. It is a soft, UI-level lock, not a new authorization boundary —
-- RLS/membership already decide who can reach a company's data, and that is
-- unchanged here. The point is stopping someone who has physically picked up
-- an already-signed-in browser from wandering straight into a company's
-- books, not restricting a legitimate member's own access to data they can
-- already query. See app/(app)/[companyId]/layout.tsx and
-- app/api/companies/[companyId]/unlock/route.ts for the client side.
-- ============================================================================

alter table public.companies
  add column password_hash text,
  add column password_protected boolean
    generated always as (password_hash is not null) stored;

comment on column public.companies.password_hash is
  'bcrypt hash (pgcrypto), set only via set_company_password(). Never
   selectable by authenticated directly -- same column-privilege pattern as
   0028a closes for vouchers.approval_status.';

comment on column public.companies.password_protected is
  'Whether an open-company password is set. Safe to expose (unlike the hash
   itself) -- the client uses it to decide whether to show the unlock gate.';


-- ----------------------------------------------------------------------------
-- Set / clear
-- ----------------------------------------------------------------------------
-- Admin-only, matching who can already change every other company setting
-- (companies_update RLS policy). A null or blank password clears protection.
create or replace function public.set_company_password(p_company_id uuid, p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select app_private.is_company_admin(p_company_id)) then
    raise exception 'Only a company admin can change the company password';
  end if;

  update public.companies
  set password_hash = case
    when p_password is null or length(trim(p_password)) = 0 then null
    else extensions.crypt(p_password, extensions.gen_salt('bf'))
  end
  where id = p_company_id;
end;
$$;

comment on function public.set_company_password(uuid, text) is
  'Sets or clears the open-company gate password. Admin-only; raises otherwise.';


-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
-- Any active member may attempt this -- they are exactly who the gate
-- prompts. A non-member gets false, same as a wrong password, so this leaks
-- nothing about whether p_company_id exists or is protected.
create or replace function public.verify_company_password(p_company_id uuid, p_password text)
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_hash text;
begin
  if not (select app_private.is_company_member(p_company_id)) then
    return false;
  end if;

  select password_hash into v_hash from public.companies where id = p_company_id;

  if v_hash is null then
    return true;
  end if;

  return v_hash = extensions.crypt(coalesce(p_password, ''), v_hash);
end;
$$;

comment on function public.verify_company_password(uuid, text) is
  'Checks a company-open password; true if none is set. Never exposes the hash.';

revoke all on function public.set_company_password(uuid, text) from public;
grant execute on function public.set_company_password(uuid, text) to authenticated;

revoke all on function public.verify_company_password(uuid, text) from public;
grant execute on function public.verify_company_password(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- Column-level lockdown
-- ----------------------------------------------------------------------------
-- `authenticated` also holds a table-wide SELECT/UPDATE grant on
-- public.companies (Supabase's default `grant all ... to authenticated`),
-- which would otherwise let any member read or overwrite password_hash
-- directly, bypassing the RPCs above entirely -- the same gap 0028a closed
-- for vouchers. Re-grant every pre-existing column explicitly, add
-- password_protected to the readable set, and leave password_hash out of
-- both.
revoke select, update on public.companies from authenticated;

grant select (
  id, name, legal_name, entity_type, compliance_mode, pan, tan, iec, cin,
  udyam_number, udyam_category, incorporation_date,
  financial_year_start_month, base_currency, book_beginning_date, lock_date,
  is_active, created_by, created_at, updated_at, inventory_valuation_method,
  company_tax_regime, is_professional, stock_margin_percent,
  debtor_margin_percent, debtor_eligibility_days, password_protected
) on public.companies to authenticated;

grant update (
  id, name, legal_name, entity_type, compliance_mode, pan, tan, iec, cin,
  udyam_number, udyam_category, incorporation_date,
  financial_year_start_month, base_currency, book_beginning_date, lock_date,
  is_active, created_by, created_at, updated_at, inventory_valuation_method,
  company_tax_regime, is_professional, stock_margin_percent,
  debtor_margin_percent, debtor_eligibility_days
) on public.companies to authenticated;
