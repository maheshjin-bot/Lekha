-- ============================================================================
-- 0006 — Chart of accounts, ledgers, and the tax ledger map
-- ============================================================================
-- The group tree and its guards are carried over from HISAB largely unchanged
-- — they are correct and well tested. What is new is on the ledger: statutory
-- identity for the party (GSTIN, PAN, MSME status, TDS deductee details), and
-- a map wiring tax purposes to real ledgers *per registration*, because Output
-- CGST for Maharashtra is not Output CGST for Karnataka.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Account groups
-- ----------------------------------------------------------------------------
create table public.account_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  parent_group_id uuid null,
  name text not null check (length(trim(name)) > 0),
  nature text not null check (nature in (
    'capital','current_asset','current_liability','fixed_asset',
    'direct_expense','direct_income','indirect_expense','indirect_income'
  )),
  normal_balance text not null check (normal_balance in ('debit','credit')),

  -- A second, finer classification the voucher engine uses to filter and rank
  -- the ledger combobox per voucher side. Payment's cash leg must hard-filter
  -- to cash_bank, not to all of "current_asset" — which also holds debtors.
  --
  -- Beyond HISAB's set: duty_tax (GST/TDS control accounts, which the tax
  -- ledger map points at), stock, investment and provision.
  ledger_role text not null default 'other' check (ledger_role in (
    'cash_bank','debtor','creditor','income','expense','capital','loan',
    'fixed_asset','duty_tax','stock','investment','provision','other'
  )),

  statement text generated always as (
    case
      when nature in ('direct_income','direct_expense') then 'trading'
      when nature in ('indirect_income','indirect_expense') then 'profit_loss'
      else 'balance_sheet'
    end
  ) stored,

  is_system boolean not null default false,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (parent_group_id, company_id)
    references public.account_groups (id, company_id)
);

create unique index account_groups_root_name_idx
  on public.account_groups(company_id, name) where parent_group_id is null;
create unique index account_groups_child_name_idx
  on public.account_groups(company_id, parent_group_id, name) where parent_group_id is not null;
create index account_groups_nature_idx on public.account_groups(company_id, nature);
create index account_groups_role_idx on public.account_groups(company_id, ledger_role);

create trigger set_updated_at
  before update on public.account_groups
  for each row execute function app_private.set_updated_at();

-- A child always inherits its parent's nature — a sub-group cannot mix
-- classifications with its parent — and re-parenting is cycle-guarded.
create or replace function app_private.enforce_account_group_nature()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_parent_nature text;
  v_ancestor uuid;
begin
  if new.parent_group_id is not null then
    select nature into v_parent_nature
      from public.account_groups
     where id = new.parent_group_id and company_id = new.company_id;

    if v_parent_nature is null then
      raise exception 'Parent group not found in this company';
    end if;

    new.nature := v_parent_nature;

    if TG_OP = 'UPDATE' then
      v_ancestor := new.parent_group_id;
      while v_ancestor is not null loop
        if v_ancestor = new.id then
          raise exception 'Cannot set parent_group_id: would create a cycle';
        end if;
        select parent_group_id into v_ancestor
          from public.account_groups where id = v_ancestor;
      end loop;
    end if;
  end if;

  return new;
end;
$$;

create trigger enforce_account_group_nature
  before insert or update of parent_group_id, nature on public.account_groups
  for each row execute function app_private.enforce_account_group_nature();

-- The primary groups are structural. Renaming one is fine; reclassifying or
-- deleting it would invalidate every report built on the hierarchy.
create or replace function app_private.protect_system_group()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if TG_OP = 'DELETE' then
    -- On ON DELETE CASCADE the company row goes first, so its absence is how
    -- a child guard tells "the company is being deleted" from "a user is
    -- deleting this group". Without this the guard blocks its own company's
    -- deletion and a company can never be removed at all.
    if not exists (select 1 from public.companies where id = old.company_id) then
      return old;
    end if;
    if old.is_system then
      raise exception 'Cannot delete a system account group';
    end if;
    return old;
  end if;

  if old.is_system and (
    new.nature is distinct from old.nature
    or new.parent_group_id is distinct from old.parent_group_id
    or new.is_system is distinct from old.is_system
  ) then
    raise exception 'Cannot change nature, parent, or system flag of a system account group';
  end if;
  return new;
end;
$$;

create trigger protect_system_group
  before update or delete on public.account_groups
  for each row execute function app_private.protect_system_group();


-- ----------------------------------------------------------------------------
-- Ledgers
-- ----------------------------------------------------------------------------
create table public.ledgers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  group_id uuid not null,
  name text not null check (length(trim(name)) > 0),

  opening_balance_amount numeric(18,2) not null default 0 check (opening_balance_amount >= 0),
  opening_balance_type text not null default 'debit' check (opening_balance_type in ('debit','credit')),

  -- Contact
  contact_person text,
  phone text,
  email text check (email is null or email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  address text,
  city text,
  pincode text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  notes text,

  -- ---- Statutory identity -------------------------------------------------
  party_type text check (party_type is null or party_type in
    ('customer','supplier','both','employee','bank','government','related_party','other')),

  gstin char(15) check (app_private.is_valid_gstin(gstin)),
  pan text check (app_private.is_valid_pan(pan)),

  -- Place of supply defaults to the party's state. Null for an unregistered
  -- party whose state is unknown, in which case the invoice must supply it.
  state_code char(2) references public.ref_states(code),

  gst_registration_type text check (gst_registration_type is null or gst_registration_type in
    ('regular','composition','unregistered','sez','sez_developer','overseas','uin','deemed_export')),

  -- MSME. Drives Sec 43B(h): payment beyond 45 days (or 15 without a written
  -- agreement) is disallowed until actually paid.
  udyam_number text check (app_private.is_valid_udyam(udyam_number)),
  msme_category text check (msme_category is null or msme_category in ('micro','small','medium')),
  msme_payment_days smallint check (msme_payment_days is null or msme_payment_days between 1 and 45),

  -- TDS
  is_tds_deductee boolean not null default false,
  default_tds_section text,
  -- Lower or nil deduction certificate under Sec 197.
  ldc_number text,
  ldc_rate numeric(5,2) check (ldc_rate is null or (ldc_rate >= 0 and ldc_rate <= 100)),
  ldc_valid_from date,
  ldc_valid_to date,
  ldc_amount_cap numeric(18,2),

  -- Foreign trade. Books remain INR; this is the default *transaction*
  -- currency for invoices raised to or received from this party.
  default_currency char(3) not null default 'INR',

  -- Credit control
  credit_limit numeric(18,2),
  credit_days smallint,

  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (group_id, company_id) references public.account_groups (id, company_id),

  constraint ledgers_ldc_period_valid
    check (ldc_valid_to is null or ldc_valid_from is null or ldc_valid_to >= ldc_valid_from),
  -- A certificate without a rate is meaningless, and a rate without a number
  -- cannot be substantiated in an assessment.
  constraint ledgers_ldc_complete
    check ((ldc_number is null) = (ldc_rate is null))
);

-- Exact-name uniqueness, as before.
create unique index ledgers_company_name_idx on public.ledgers(company_id, lower(name));

-- And a normalised index, which is new. HISAB matched ledger names on
-- trim+lower only, so "A. B. Traders" and "A B Traders" were different
-- ledgers and the CSV importer failed to match either reliably (defect F-09).
--
-- Deliberately NOT unique. A near-duplicate deserves a warning and a "did you
-- mean" suggestion, not a hard refusal — "Shah & Co" and "Shah Co" can be two
-- real parties, and blocking the second would be the same over-reach as
-- hard-blocking a repeated supplier bill number. This is the same call made
-- for duplicate bills: detect, surface, let a human decide.
create index ledgers_company_normalized_name_idx
  on public.ledgers(company_id, app_private.normalize_name(name));

create index ledgers_company_active_idx on public.ledgers(company_id, is_active);
create index ledgers_company_group_idx on public.ledgers(company_id, group_id);
create index ledgers_gstin_idx on public.ledgers(company_id, gstin) where gstin is not null;
create index ledgers_msme_idx on public.ledgers(company_id) where udyam_number is not null;

create trigger set_updated_at
  before update on public.ledgers
  for each row execute function app_private.set_updated_at();

-- Changing an opening balance or a group retroactively rewrites every
-- historical report, so it stays admin-only.
create or replace function app_private.protect_ledger_financial_fields()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if (new.opening_balance_amount is distinct from old.opening_balance_amount
      or new.opening_balance_type is distinct from old.opening_balance_type
      or new.group_id is distinct from old.group_id)
     and not app_private.is_company_admin(new.company_id) then
    raise exception 'Only an admin can change a ledger''s opening balance or group';
  end if;
  return new;
end;
$$;

create trigger protect_ledger_financial_fields
  before update on public.ledgers
  for each row execute function app_private.protect_ledger_financial_fields();

-- A party's state must agree with its GSTIN. Deriving it removes the
-- possibility of a Maharashtra GSTIN sitting on a party marked Karnataka,
-- which would send every supply to them down the wrong intra/inter branch.
create or replace function app_private.enforce_ledger_gst_identity()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if new.gstin is not null then
    new.state_code := app_private.gstin_state_code(new.gstin);
    -- The PAN is embedded in the GSTIN; fill it rather than asking twice.
    if new.pan is null then
      new.pan := app_private.gstin_pan(new.gstin);
    elsif new.pan <> app_private.gstin_pan(new.gstin) then
      raise exception 'PAN % does not match the PAN embedded in GSTIN %', new.pan, new.gstin;
    end if;

    if new.gst_registration_type is null then
      new.gst_registration_type := 'regular';
    end if;
  end if;

  return new;
end;
$$;

create trigger enforce_ledger_gst_identity
  before insert or update of gstin, pan on public.ledgers
  for each row execute function app_private.enforce_ledger_gst_identity();


-- ----------------------------------------------------------------------------
-- Tax ledger map
-- ----------------------------------------------------------------------------
-- Wires a *purpose* to a real ledger, per registration. This is the piece that
-- is brutal to retrofit: Output CGST for Maharashtra and Output CGST for
-- Karnataka are different accounts with separate ITC pools that cannot offset
-- each other, so the registration has to be part of the key from the start.
--
-- gst_registration_id is null for purposes that are company-wide rather than
-- per-registration — TDS payable, forex gain and loss, round-off.
create table public.tax_ledger_map (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  gst_registration_id uuid,
  purpose text not null,
  ledger_id uuid not null,
  created_at timestamptz not null default now(),

  foreign key (ledger_id, company_id) references public.ledgers (id, company_id),
  foreign key (gst_registration_id, company_id)
    references public.gst_registrations (id, company_id) on delete cascade
);

-- One ledger per purpose per registration. Two partial indexes because null
-- is not equal to null in a unique constraint, and a company-wide purpose must
-- still be unique.
create unique index tax_ledger_map_scoped_idx
  on public.tax_ledger_map(company_id, gst_registration_id, purpose)
  where gst_registration_id is not null;
create unique index tax_ledger_map_company_idx
  on public.tax_ledger_map(company_id, purpose)
  where gst_registration_id is null;

comment on table public.tax_ledger_map is
  'Maps a tax purpose (output_igst, input_cgst, tds_payable_194c, forex_gain_realised, ...) to a ledger. Per registration where the ITC pool demands it.';

create or replace function app_private.tax_ledger(
  p_company_id uuid,
  p_purpose text,
  p_registration_id uuid default null
) returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ledger_id
    from public.tax_ledger_map
   where company_id = p_company_id
     and purpose = p_purpose
     and gst_registration_id is not distinct from p_registration_id;
$$;


-- ----------------------------------------------------------------------------
-- Seeding
-- ----------------------------------------------------------------------------
-- Pre-loads the Indian chart of accounts for a new company: the eight primary
-- groups (system-protected) plus the conventional sub-groups, which are
-- ordinary editable rows.
create or replace function app_private.seed_chart_of_accounts(p_company_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_capital uuid;
  v_current_assets uuid;
  v_current_liabilities uuid;
  v_fixed_assets uuid;
begin
  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Capital Account', 'capital', 'credit', 'capital', true, 1)
  returning id into v_capital;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Current Assets', 'current_asset', 'debit', 'other', true, 2)
  returning id into v_current_assets;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Current Liabilities', 'current_liability', 'credit', 'other', true, 3)
  returning id into v_current_liabilities;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Fixed Assets', 'fixed_asset', 'debit', 'fixed_asset', true, 4)
  returning id into v_fixed_assets;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values
    (p_company_id, 'Direct Expenses',   'direct_expense',   'debit',  'expense', true, 5),
    (p_company_id, 'Direct Incomes',    'direct_income',    'credit', 'income',  true, 6),
    (p_company_id, 'Indirect Expenses', 'indirect_expense', 'debit',  'expense', true, 7),
    (p_company_id, 'Indirect Incomes',  'indirect_income',  'credit', 'income',  true, 8);

  -- Conventional sub-groups. Deletable and renameable, unlike the eight above.
  insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
  values
    (p_company_id, v_current_assets,      'Bank Accounts',        'current_asset',     'debit',  'cash_bank',  1),
    (p_company_id, v_current_assets,      'Cash-in-Hand',         'current_asset',     'debit',  'cash_bank',  2),
    (p_company_id, v_current_assets,      'Sundry Debtors',       'current_asset',     'debit',  'debtor',     3),
    (p_company_id, v_current_assets,      'Loans & Advances',     'current_asset',     'debit',  'loan',       4),
    (p_company_id, v_current_assets,      'Stock-in-Hand',        'current_asset',     'debit',  'stock',      5),
    (p_company_id, v_current_liabilities, 'Sundry Creditors',     'current_liability', 'credit', 'creditor',   1),
    (p_company_id, v_current_liabilities, 'Duties & Taxes',       'current_liability', 'credit', 'duty_tax',   2),
    (p_company_id, v_current_liabilities, 'Provisions',           'current_liability', 'credit', 'provision',  3),
    (p_company_id, v_current_liabilities, 'Outstanding Expenses', 'current_liability', 'credit', 'other',      4),
    (p_company_id, v_fixed_assets,        'Plant & Machinery',    'fixed_asset',       'debit',  'fixed_asset', 1),
    (p_company_id, v_fixed_assets,        'Office Equipment',     'fixed_asset',       'debit',  'fixed_asset', 2),
    (p_company_id, v_fixed_assets,        'Furniture',            'fixed_asset',       'debit',  'fixed_asset', 3);
end;
$$;

comment on function app_private.seed_chart_of_accounts is
  'Eight system groups plus the conventional sub-groups. Duties & Taxes and Stock-in-Hand are seeded here because GST and inventory both need somewhere to post before their modules are configured.';

-- Creates the GST control ledgers for one registration and wires them into the
-- tax ledger map. Called when a registration is added, not at company
-- creation — a books-only company should never see these accounts.
create or replace function app_private.seed_gst_ledgers(
  p_company_id uuid,
  p_registration_id uuid
) returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_group uuid;
  v_state char(2);
  v_suffix text;
  v_purpose text;
  v_label text;
  v_ledger uuid;
  v_intra text;
begin
  select state_code into v_state
    from public.gst_registrations
   where id = p_registration_id and company_id = p_company_id;
  if v_state is null then
    raise exception 'Registration not found in this company';
  end if;

  -- Union territories without a legislature levy UTGST rather than SGST.
  select intra_state_component into v_intra from public.ref_states where code = v_state;

  select id into v_group
    from public.account_groups
   where company_id = p_company_id and ledger_role = 'duty_tax'
   order by sort_order limit 1;
  if v_group is null then
    raise exception 'No Duties & Taxes group found; seed the chart of accounts first';
  end if;

  -- Suffix the state so a multi-state company's ledgers stay distinguishable
  -- in every report and picker.
  v_suffix := ' (' || v_state || ')';

  foreach v_purpose in array array[
    'output_cgst','output_sgst','output_igst','output_cess',
    'input_cgst','input_sgst','input_igst','input_cess',
    'rcm_payable','gst_payable','gst_refund_receivable'
  ] loop
    v_label := case v_purpose
      when 'output_cgst' then 'Output CGST'
      when 'output_sgst' then case when v_intra = 'utgst' then 'Output UTGST' else 'Output SGST' end
      when 'output_igst' then 'Output IGST'
      when 'output_cess' then 'Output Cess'
      when 'input_cgst'  then 'Input CGST'
      when 'input_sgst'  then case when v_intra = 'utgst' then 'Input UTGST' else 'Input SGST' end
      when 'input_igst'  then 'Input IGST'
      when 'input_cess'  then 'Input Cess'
      when 'rcm_payable' then 'RCM Payable'
      when 'gst_payable' then 'GST Payable'
      else 'GST Refund Receivable'
    end;

    insert into public.ledgers (company_id, group_id, name, opening_balance_type)
    values (p_company_id, v_group, v_label || v_suffix, 'credit')
    returning id into v_ledger;

    insert into public.tax_ledger_map (company_id, gst_registration_id, purpose, ledger_id)
    values (p_company_id, p_registration_id, v_purpose, v_ledger);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- Row level security
-- ----------------------------------------------------------------------------
alter table public.account_groups enable row level security;
alter table public.ledgers enable row level security;
alter table public.tax_ledger_map enable row level security;

create policy account_groups_read on public.account_groups
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

create policy account_groups_write on public.account_groups
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

create policy ledgers_read on public.ledgers
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

-- Accountants create and edit ledgers; the trigger above separately blocks
-- them from touching opening balances and group assignment.
create policy ledgers_write on public.ledgers
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

create policy tax_ledger_map_read on public.tax_ledger_map
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

create policy tax_ledger_map_write on public.tax_ledger_map
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));
