-- ============================================================================
-- 0005 — Organisation structure: GST registrations and branches
-- ============================================================================
-- Most implementations conflate "branch" with "GST registration". They are
-- different, and the difference is load-bearing:
--
--   Company            one PAN, one set of books, one income tax return
--    └─ GST registration   one GSTIN per state; a *distinct person* under
--       │                  Sec 25(4), with its own returns and its own ITC
--       │                  pool that cannot offset another state's liability
--       └─ Branch          a place of business. Several branches can sit
--                          under one GSTIN — Mumbai HO, Pune warehouse and
--                          Nashik depot all file under the Maharashtra GSTIN.
--
-- GST law wants these separated; accounting wants them consolidated. Both
-- readings have to hold at once, which is why the dimension goes in the
-- foundation rather than being added later.
--
-- Branch is a *core* concept, registration is a *tax* concept: a books-only
-- proprietor with three shops gets branches and no registrations at all.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- GST registrations
-- ----------------------------------------------------------------------------
create table public.gst_registrations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  gstin char(15) not null check (app_private.is_valid_gstin(gstin)),

  -- Denormalised from the GSTIN's first two characters, and kept honest by the
  -- trigger below. Stored rather than derived because the branch composite
  -- foreign key needs a real column to point at.
  state_code char(2) not null references public.ref_states(code),

  registration_type text not null default 'regular'
    check (registration_type in ('regular','composition','casual','non_resident','isd','tds','tcs')),

  -- Monthly, or the Quarterly Return Monthly Payment scheme. Drives which
  -- return periods the compliance calendar generates.
  filing_frequency text not null default 'monthly'
    check (filing_frequency in ('monthly','qrmp')),

  legal_name text,
  trade_name text,

  registered_from date not null,
  -- Set on surrender or cancellation. Historical vouchers under a cancelled
  -- registration stay valid and still have to appear in their period's return.
  registered_to date,

  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One GSTIN is unique globally, but enforce per-company too so a typo can't
  -- silently attach another company's registration.
  unique (gstin),
  unique (id, company_id),
  -- The composite target branches point at: guarantees a branch's registration
  -- belongs to the same company AND the same state as the branch itself.
  unique (id, company_id, state_code),
  -- A PAN can hold only one registration per state per registration type.
  unique (company_id, state_code, registration_type),

  constraint gst_registrations_period_valid
    check (registered_to is null or registered_to >= registered_from)
);

create index gst_registrations_company_idx on public.gst_registrations(company_id);

create trigger set_updated_at
  before update on public.gst_registrations
  for each row execute function app_private.set_updated_at();

-- The state code is encoded in the GSTIN. Deriving it rather than trusting
-- input removes a whole class of bug: a Maharashtra GSTIN filed under
-- Karnataka would send every supply down the wrong intra/inter branch.
create or replace function app_private.enforce_gstin_state()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  new.state_code := app_private.gstin_state_code(new.gstin);

  -- The registration's PAN must match the company's, when the company has one.
  -- A GSTIN embedding a different PAN belongs to a different legal entity.
  if exists (
    select 1 from public.companies c
     where c.id = new.company_id
       and c.pan is not null
       and c.pan <> app_private.gstin_pan(new.gstin)
  ) then
    raise exception 'GSTIN % embeds PAN %, which is not this company''s PAN',
      new.gstin, app_private.gstin_pan(new.gstin);
  end if;

  return new;
end;
$$;

create trigger enforce_gstin_state
  before insert or update of gstin, company_id on public.gst_registrations
  for each row execute function app_private.enforce_gstin_state();


-- ----------------------------------------------------------------------------
-- Branches
-- ----------------------------------------------------------------------------
create table public.branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  -- Short prefix used in this branch's voucher numbering. GST requires a
  -- consecutive series unique within a financial year per registration;
  -- distinct branch prefixes are what let several branches share one GSTIN
  -- without their series colliding.
  code text not null check (code ~ '^[A-Z0-9]{1,6}$'),
  name text not null check (length(trim(name)) > 0),

  state_code char(2) not null references public.ref_states(code),
  address_line1 text,
  address_line2 text,
  city text,
  pincode text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),

  -- Null for a books-only company, or a location not separately registered.
  gst_registration_id uuid,

  -- Exactly one per company; see the unique index below.
  is_head_office boolean not null default false,

  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (company_id, code),
  unique (id, company_id),

  -- A branch's registration must belong to the same company *and* be for the
  -- same state. A Pune warehouse cannot file under the Karnataka GSTIN, and
  -- this composite key makes that unrepresentable rather than merely
  -- discouraged.
  foreign key (gst_registration_id, company_id, state_code)
    references public.gst_registrations (id, company_id, state_code)
);

create unique index branches_one_head_office_idx
  on public.branches (company_id) where is_head_office;

create index branches_company_active_idx on public.branches(company_id, is_active);
create index branches_registration_idx on public.branches(gst_registration_id);

create trigger set_updated_at
  before update on public.branches
  for each row execute function app_private.set_updated_at();

comment on table public.branches is
  'Places of business. Every voucher entry carries a branch; single-location companies get a seeded Head Office.';

-- A company must always retain a head office, for the same reason it must
-- always retain an admin: something has to be the default, and losing it
-- silently breaks every default the UI offers.
create or replace function app_private.guard_head_office()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_company_id uuid := coalesce(old.company_id, new.company_id);
begin
  -- Cascade from the company itself: nothing left to protect.
  if TG_OP = 'DELETE'
     and not exists (select 1 from public.companies where id = v_company_id) then
    return old;
  end if;

  if old.is_head_office and (
       TG_OP = 'DELETE'
       or not new.is_head_office
       or not new.is_active
     ) then
    if not exists (
      select 1 from public.branches
       where company_id = v_company_id
         and is_head_office
         and is_active
         and id is distinct from old.id
    ) then
      raise exception 'A company must have an active head office branch';
    end if;
  end if;

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger guard_head_office
  before update or delete on public.branches
  for each row execute function app_private.guard_head_office();


-- ----------------------------------------------------------------------------
-- Branch-scoped membership
-- ----------------------------------------------------------------------------
-- Restricts a member to specific branches. No rows for a member means no
-- restriction — they see the whole company. Modelling it as an allow-list
-- keeps the common case (unrestricted) free of bookkeeping.
create table public.member_branches (
  id uuid primary key default gen_random_uuid(),
  company_member_id uuid not null,
  company_id uuid not null,
  branch_id uuid not null,
  created_at timestamptz not null default now(),

  unique (company_member_id, branch_id),
  foreign key (company_member_id, company_id)
    references public.company_members (id, company_id) on delete cascade,
  foreign key (branch_id, company_id)
    references public.branches (id, company_id) on delete cascade
);

create index member_branches_member_idx on public.member_branches(company_member_id);

-- The predicate RLS uses on every branch-dimensioned table. Security definer
-- so it does not recurse into member_branches' own policies.
create or replace function app_private.can_access_branch(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.branches b
      join public.company_members cm
        on cm.company_id = b.company_id
       and cm.user_id = auth.uid()
       and cm.status = 'active'
     where b.id = p_branch_id
       and (
         -- Unrestricted member, or explicitly granted this branch.
         not exists (select 1 from public.member_branches mb where mb.company_member_id = cm.id)
         or exists (
           select 1 from public.member_branches mb
            where mb.company_member_id = cm.id and mb.branch_id = b.id
         )
       )
  );
$$;

comment on function app_private.can_access_branch is
  'Branch-level authorisation. No member_branches rows means unrestricted; otherwise the branch must be listed.';


-- ----------------------------------------------------------------------------
-- Registration lookups used by the tax engine
-- ----------------------------------------------------------------------------
-- Resolves the registration in force for a branch on a date. Tax determination
-- reads the supplier state from here — never from the company — because in a
-- multi-state business the supplier state is a property of the branch raising
-- the invoice.
create or replace function app_private.branch_registration(
  p_branch_id uuid,
  p_on_date date default current_date
) returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id
    from public.branches b
    join public.gst_registrations r on r.id = b.gst_registration_id
   where b.id = p_branch_id
     and r.registered_from <= p_on_date
     and (r.registered_to is null or r.registered_to >= p_on_date);
$$;

create or replace function app_private.company_gstin_count(
  p_company_id uuid,
  p_on_date date default current_date
) returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.gst_registrations r
   where r.company_id = p_company_id
     and r.is_active
     and r.registration_type <> 'isd'
     and r.registered_from <= p_on_date
     and (r.registered_to is null or r.registered_to >= p_on_date);
$$;


-- ----------------------------------------------------------------------------
-- Extend the module resolver
-- ----------------------------------------------------------------------------
-- 0004 stubbed the GSTIN predicates to false because gst_registrations did not
-- exist yet. Now it does, so replace the function — each migration teaches the
-- resolver about the tables it introduces, rather than referencing tables that
-- have not been created.
create or replace function app_private.module_condition_met(
  p_company_id uuid,
  p_rule jsonb
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company public.companies%rowtype;
  v_entity public.ref_entity_types%rowtype;
  v_key text;
  v_val jsonb;
begin
  if p_rule is null or p_rule = '{}'::jsonb then
    return false;
  end if;

  select * into v_company from public.companies where id = p_company_id;
  if not found then
    return false;
  end if;

  select * into v_entity from public.ref_entity_types where code = v_company.entity_type;

  for v_key, v_val in select * from jsonb_each(p_rule) loop
    case v_key
      when 'compliance_mode' then
        if v_company.compliance_mode is distinct from (v_val #>> '{}') then return false; end if;
      when 'has_tan' then
        if (v_company.tan is not null) is distinct from (v_val::boolean) then return false; end if;
      when 'has_iec' then
        if (v_company.iec is not null) is distinct from (v_val::boolean) then return false; end if;
      when 'has_pan' then
        if (v_company.pan is not null) is distinct from (v_val::boolean) then return false; end if;
      when 'entity_type' then
        if v_company.entity_type is distinct from (v_val #>> '{}') then return false; end if;
      when 'statement_format' then
        if v_entity.statement_format is distinct from (v_val #>> '{}') then return false; end if;
      when 'roc_applicable' then
        if v_entity.roc_applicable is distinct from (v_val::boolean) then return false; end if;
      when 'remuneration_section' then
        if v_entity.remuneration_section is distinct from (v_val #>> '{}') then return false; end if;
      when 'has_gstin' then
        if (app_private.company_gstin_count(p_company_id) > 0) is distinct from (v_val::boolean) then
          return false;
        end if;
      when 'gstin_count_min' then
        if app_private.company_gstin_count(p_company_id) < (v_val::text)::integer then
          return false;
        end if;
      else
        return false; -- unknown predicate: fail closed
    end case;
  end loop;

  return true;
end;
$$;

-- Registrations are facts the conditional rules read, so a change to them has
-- to re-resolve the same way a change to the company profile does.
create or replace function app_private.trg_resolve_modules_from_registration()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  perform app_private.resolve_conditional_modules(coalesce(new.company_id, old.company_id));
  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger resolve_modules_on_registration_change
  after insert or update or delete on public.gst_registrations
  for each row execute function app_private.trg_resolve_modules_from_registration();


-- ----------------------------------------------------------------------------
-- Row level security
-- ----------------------------------------------------------------------------
alter table public.gst_registrations enable row level security;
alter table public.branches enable row level security;
alter table public.member_branches enable row level security;

-- Registrations are company-wide reference data for members: a Bangalore user
-- still needs to see that a Maharashtra registration exists, because an
-- inter-branch transfer to Mumbai depends on it.
create policy gst_registrations_read on public.gst_registrations
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

create policy gst_registrations_write on public.gst_registrations
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

-- Branch rows are visible to any member — the list is needed to render
-- filters and pickers. Branch *data* is what gets scoped, on the tables that
-- carry a branch dimension.
create policy branches_read on public.branches
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

create policy branches_write on public.branches
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

create policy member_branches_read on public.member_branches
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

create policy member_branches_write on public.member_branches
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));
