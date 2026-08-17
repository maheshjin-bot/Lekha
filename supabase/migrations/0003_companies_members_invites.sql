-- ============================================================================
-- 0003 — Companies, entity profile, membership, invites
-- ============================================================================
-- The tenancy root. A company carries its statutory identity here; everything
-- downstream (which modules activate, which statements it produces, which
-- returns it files) is derived from these columns rather than configured
-- separately, so the two can never disagree.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Companies
-- ----------------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  -- Trading name, shown throughout the UI.
  name text not null check (length(trim(name)) > 0),
  -- Registered name as it appears on statutory filings, when it differs.
  legal_name text,

  -- Selects the rule set: statement format, audit forms, ITR form, ROC
  -- obligations, remuneration section. See ref_entity_types.
  entity_type text not null references public.ref_entity_types(code),

  -- 'books_only'  → the simple product: vouchers, ledgers, five reports
  -- 'compliance'  → unlocks the statutory modules per the company profile
  -- Effective-dated module state (0004) is what actually gates features; this
  -- is the headline choice made at company creation that seeds them.
  compliance_mode text not null default 'books_only'
    check (compliance_mode in ('books_only','compliance')),

  -- Entity-level registrations. GSTINs are per-state and live in 0005, since
  -- one PAN can hold a registration in every state it operates in.
  pan text check (app_private.is_valid_pan(pan)),
  tan text check (app_private.is_valid_tan(tan)),
  iec text check (app_private.is_valid_iec(iec)),
  cin text,
  udyam_number text check (app_private.is_valid_udyam(udyam_number)),
  udyam_category text check (udyam_category is null or udyam_category in ('micro','small','medium')),

  incorporation_date date,

  financial_year_start_month smallint not null default 4
    check (financial_year_start_month between 1 and 12),

  -- Reporting currency is INR and only INR. Foreign currency is a property of
  -- a *transaction* — an export invoice carries its own currency and rate, and
  -- posts to voucher_entries in rupees. That scoping decision removes trial
  -- balance translation entirely while still supporting exporters. The column
  -- is retained (rather than dropped) so the constraint documents the choice
  -- instead of the absence looking like an oversight.
  base_currency char(3) not null default 'INR' check (base_currency = 'INR'),

  book_beginning_date date not null,
  lock_date date null,

  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A company in compliance mode must have a PAN: every statutory module
  -- downstream keys off it, and discovering it is missing at return-filing
  -- time is far worse than refusing it here.
  constraint companies_compliance_requires_pan
    check (compliance_mode = 'books_only' or pan is not null),

  -- The lock date cannot precede the opening of the books; a lock earlier than
  -- that would silently freeze the entire ledger.
  constraint companies_lock_after_beginning
    check (lock_date is null or lock_date >= book_beginning_date)
);

create index companies_entity_type_idx on public.companies(entity_type);

create trigger set_updated_at
  before update on public.companies
  for each row execute function app_private.set_updated_at();

comment on column public.companies.base_currency is
  'Always INR. Foreign currency is per-transaction (see the EXIM module), never a reporting currency.';


-- ----------------------------------------------------------------------------
-- Profiles
-- ----------------------------------------------------------------------------
-- Mirrors auth.users so application code never reads the auth schema directly.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create or replace function app_private.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app_private.handle_new_user();


-- ----------------------------------------------------------------------------
-- Membership
-- ----------------------------------------------------------------------------
create table public.company_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','accountant','auditor')),
  status text not null default 'active' check (status in ('active','revoked')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id),
  -- Composite target for branch-scoped foreign keys in 0005: a member's branch
  -- restriction must belong to the same company as the membership itself.
  unique (id, company_id)
);

create index company_members_user_id_idx on public.company_members(user_id);

create trigger set_updated_at
  before update on public.company_members
  for each row execute function app_private.set_updated_at();

-- Without this a company could be left permanently unmanageable.
create or replace function app_private.guard_last_admin()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_company_id uuid := coalesce(old.company_id, new.company_id);
  v_remaining_admins integer;
begin
  -- Cascade from the company itself: nothing left to protect. The company row
  -- is deleted before its children, so its absence distinguishes a cascade
  -- from a user removing one member.
  if TG_OP = 'DELETE'
     and not exists (select 1 from public.companies where id = v_company_id) then
    return old;
  end if;

  if old.role = 'admin' and old.status = 'active' then
    if (TG_OP = 'DELETE')
       or (new.role is distinct from 'admin')
       or (new.status is distinct from 'active') then
      select count(*) into v_remaining_admins
        from public.company_members
        where company_id = v_company_id
          and role = 'admin'
          and status = 'active'
          and id is distinct from old.id;
      if v_remaining_admins = 0 then
        raise exception 'Cannot remove the last active admin of a company';
      end if;
    end if;
  end if;

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger guard_last_admin
  before update or delete on public.company_members
  for each row execute function app_private.guard_last_admin();


-- ----------------------------------------------------------------------------
-- Invites
-- ----------------------------------------------------------------------------
-- Email-based so an invite works before the invitee has an account. Plain text
-- with lower() for case-insensitive matching rather than citext — citext's type
-- name does not resolve inside security-definer functions pinned to an empty
-- search_path, and this sidesteps that entirely.
create table public.company_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin','accountant','auditor')),
  token uuid not null default gen_random_uuid(),
  status text not null default 'pending'
    check (status in ('pending','accepted','revoked','expired')),
  invited_by uuid not null references auth.users(id),
  accepted_by uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create unique index company_invites_token_idx on public.company_invites(token);
create unique index company_invites_pending_unique_idx
  on public.company_invites(company_id, lower(email))
  where status = 'pending';


-- ----------------------------------------------------------------------------
-- Tenancy predicates
-- ----------------------------------------------------------------------------
-- security definer so they do not recurse into RLS on company_members when
-- used inside that table's own policies. Call sites wrap them in
-- `(select ...)` so Postgres treats them as an init-plan evaluated once per
-- statement rather than once per row — the difference is large on a daybook.
create or replace function app_private.is_company_member(p_company_id uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select exists (
    select 1 from public.company_members
    where company_id = p_company_id and user_id = auth.uid() and status = 'active'
  );
$$;

create or replace function app_private.user_role_in_company(p_company_id uuid)
returns text
language sql security definer set search_path = '' stable
as $$
  select role from public.company_members
  where company_id = p_company_id and user_id = auth.uid() and status = 'active';
$$;

create or replace function app_private.is_company_admin(p_company_id uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select app_private.user_role_in_company(p_company_id) = 'admin';
$$;

create or replace function app_private.can_write_company(p_company_id uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select app_private.user_role_in_company(p_company_id) in ('admin','accountant');
$$;

-- Period control. Separated from can_write_company because the lock date is a
-- property of the *voucher date*, not of the user — an admin cannot post into
-- a locked period either, and a report may still read one.
create or replace function app_private.is_period_open(p_company_id uuid, p_date date)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select coalesce(
    (select p_date > lock_date from public.companies where id = p_company_id and lock_date is not null),
    true
  );
$$;


-- ----------------------------------------------------------------------------
-- Entity profile resolution
-- ----------------------------------------------------------------------------
-- One call returning everything the application needs to decide what this
-- company is subject to. Used by the module engine in 0004 and by the UI to
-- decide which navigation exists at all.
create or replace function public.get_company_profile(p_company_id uuid)
returns table (
  company_id uuid,
  name text,
  entity_type text,
  entity_name text,
  compliance_mode text,
  statement_format text,
  statutory_audit_rule text,
  tax_audit_report_form text,
  itr_form text,
  presumptive_allowed boolean,
  remuneration_section text,
  roc_applicable boolean,
  roc_forms text[],
  special_provisions text[],
  has_pan boolean,
  has_tan boolean,
  has_iec boolean,
  financial_year_start_month smallint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id, c.name, c.entity_type, e.name, c.compliance_mode,
    e.statement_format, e.statutory_audit_rule, e.tax_audit_report_form,
    e.itr_form, e.presumptive_allowed, e.remuneration_section,
    e.roc_applicable, e.roc_forms, e.special_provisions,
    c.pan is not null, c.tan is not null, c.iec is not null,
    c.financial_year_start_month
  from public.companies c
  join public.ref_entity_types e on e.code = c.entity_type
  where c.id = p_company_id;
$$;

comment on function public.get_company_profile is
  'Resolves a company against its entity-type rule row. RLS on companies gates access; this function is security invoker so a non-member sees nothing.';


-- create_company() is deliberately not defined here. Creating a company has to
-- seed its chart of accounts, its tax ledgers and its initial module state,
-- none of which exist yet. It lands once those do, so there is never a version
-- of it that half-creates a company.
