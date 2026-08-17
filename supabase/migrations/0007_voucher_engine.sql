-- ============================================================================
-- 0007 — The voucher engine
-- ============================================================================
-- The double-entry core, carried over from HISAB with three changes:
--
--   * branch_id is NOT NULL on every entry, and numbering is keyed per branch
--   * transaction currency and rate live on the header (books stay INR)
--   * two defects found in HISAB are designed out rather than patched later:
--       F-01  editing a date across a year boundary left a stale FY label,
--             so a voucher's number claimed one year while its date said
--             another — and the old year's sequence could mint a collision
--       F-02  nothing stopped the same supplier bill being entered twice
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Numbering
-- ----------------------------------------------------------------------------
-- GST requires a serial number that is consecutive and unique within a
-- financial year for each registration. Several branches can share one GSTIN,
-- so the branch prefix is what keeps their series from colliding — hence
-- branch, not registration, in the key.
create table public.voucher_number_sequences (
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  voucher_type text not null,
  financial_year_label text not null,
  prefix text not null,
  next_number integer not null default 1,
  padding smallint not null default 5,
  primary key (company_id, branch_id, voucher_type, financial_year_label),
  foreign key (branch_id, company_id) references public.branches (id, company_id) on delete cascade
);

create or replace function app_private.next_voucher_number(
  p_company_id uuid,
  p_branch_id uuid,
  p_voucher_type text,
  p_voucher_date date
) returns table(display_number text, seq_number integer, fy_label text)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_fy_start_month smallint;
  v_fy_label text;
  v_branch_code text;
  v_prefix text;
  v_padding smallint;
  v_number int;
begin
  select financial_year_start_month into v_fy_start_month
    from public.companies where id = p_company_id;
  if v_fy_start_month is null then
    raise exception 'Company not found';
  end if;

  select code into v_branch_code
    from public.branches where id = p_branch_id and company_id = p_company_id;
  if v_branch_code is null then
    raise exception 'Branch not found in this company';
  end if;

  v_fy_label := app_private.fy_label(p_voucher_date, v_fy_start_month);

  v_prefix := v_branch_code || '/' || case p_voucher_type
    when 'receipt'         then 'REC'
    when 'payment'         then 'PAY'
    when 'contra'          then 'CON'
    when 'journal'         then 'JRN'
    when 'sales'           then 'SAL'
    when 'purchase'        then 'PUR'
    when 'credit_note'     then 'CRN'
    when 'debit_note'      then 'DBN'
    when 'branch_transfer' then 'BTR'
    when 'stock_journal'   then 'STK'
    else upper(left(p_voucher_type, 3))
  end;

  insert into public.voucher_number_sequences
    (company_id, branch_id, voucher_type, financial_year_label, prefix, next_number)
  values (p_company_id, p_branch_id, p_voucher_type, v_fy_label, v_prefix, 2)
  on conflict (company_id, branch_id, voucher_type, financial_year_label)
  do update set next_number = voucher_number_sequences.next_number + 1
  returning (next_number - 1), padding into v_number, v_padding;

  return query select
    (v_prefix || '/' || v_fy_label || '/' || lpad(v_number::text, v_padding, '0')),
    v_number,
    v_fy_label;
end;
$$;


-- ----------------------------------------------------------------------------
-- Vouchers
-- ----------------------------------------------------------------------------
create table public.vouchers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  -- The branch that raised this voucher. Drives numbering, and — once GST
  -- lands — the supplier state for intra/inter determination.
  branch_id uuid not null,

  voucher_type text not null check (voucher_type in (
    'receipt','payment','contra','journal','sales','purchase',
    'credit_note','debit_note','branch_transfer','stock_journal'
  )),
  voucher_number text not null,
  sequence_number integer not null,
  financial_year_label text not null,
  voucher_date date not null,

  narration text,

  -- The counterparty's document: a supplier's bill number, a customer's PO.
  reference_number text,
  reference_date date,
  -- Denormalised from the entries so the duplicate-bill check has something to
  -- key on without unpacking the lines. Set by the voucher RPCs.
  party_ledger_id uuid,

  -- Transaction currency. Books are INR and only INR; this records what the
  -- counterparty was billed in so the document can print correctly and forex
  -- gain or loss can be computed on settlement. total_amount is always INR.
  txn_currency char(3) not null default 'INR',
  exchange_rate numeric(18,6) not null default 1 check (exchange_rate > 0),
  -- Customs valuation uses the CBIC notified rate; accounting uses the bank or
  -- RBI reference rate. They differ legitimately, so record which this is.
  rate_source text check (rate_source is null or rate_source in ('rbi','bank','cbic','manual')),

  total_amount numeric(18,2) not null default 0,
  is_deleted boolean not null default false,

  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  unique (company_id, branch_id, voucher_type, financial_year_label, voucher_number),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (party_ledger_id, company_id) references public.ledgers (id, company_id),

  -- An INR voucher cannot carry a rate other than 1; a foreign-currency one
  -- must say where its rate came from.
  constraint vouchers_inr_rate_is_one
    check (txn_currency <> 'INR' or exchange_rate = 1),
  constraint vouchers_fc_needs_rate_source
    check (txn_currency = 'INR' or rate_source is not null)
);

create index vouchers_company_date_idx on public.vouchers(company_id, voucher_date);
create index vouchers_company_type_date_idx on public.vouchers(company_id, voucher_type, voucher_date);
create index vouchers_branch_date_idx on public.vouchers(company_id, branch_id, voucher_date);
create index vouchers_company_not_deleted_idx on public.vouchers(company_id, is_deleted) where is_deleted = false;

-- F-02. HISAB had no index and no constraint here, so the same supplier bill
-- could be entered twice silently — double payment, and later a double input
-- credit claim. Deliberately NOT unique: genuine duplicate bill numbers occur
-- across different suppliers, and occasionally from the same one. The app
-- warns and asks for confirmation; the index is what makes that check cheap.
create index vouchers_party_reference_idx
  on public.vouchers(company_id, party_ledger_id, reference_number, financial_year_label)
  where reference_number is not null and is_deleted = false;

create trigger set_updated_at
  before update on public.vouchers
  for each row execute function app_private.set_updated_at();

-- Surfaces a likely duplicate for the UI to confirm. Returns the offending
-- vouchers rather than a boolean so the user can be shown what they clash with.
create or replace function public.find_duplicate_bills(
  p_company_id uuid,
  p_party_ledger_id uuid,
  p_reference_number text,
  p_exclude_voucher_id uuid default null
) returns table (id uuid, voucher_number text, voucher_date date, total_amount numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select v.id, v.voucher_number, v.voucher_date, v.total_amount
    from public.vouchers v
   where v.company_id = p_company_id
     and v.party_ledger_id = p_party_ledger_id
     and v.reference_number is not null
     and app_private.normalize_name(v.reference_number)
         = app_private.normalize_name(p_reference_number)
     and not v.is_deleted
     and (p_exclude_voucher_id is null or v.id <> p_exclude_voucher_id)
   order by v.voucher_date desc;
$$;


-- ----------------------------------------------------------------------------
-- Entries
-- ----------------------------------------------------------------------------
create table public.voucher_entries (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null,
  company_id uuid not null,

  -- NOT NULL, always. Per-branch balance sheets are a requirement, which means
  -- every posting must belong to exactly one branch — a nullable dimension
  -- would let an entry escape every branch trial balance.
  branch_id uuid not null,

  ledger_id uuid not null,
  debit_amount numeric(18,2) not null default 0 check (debit_amount >= 0),
  credit_amount numeric(18,2) not null default 0 check (credit_amount >= 0),

  -- The foreign-currency face value of this line, when the voucher is not in
  -- INR. Never posted or summed — debit/credit are the books.
  fc_amount numeric(18,2),

  -- Analytical dimensions: cost centre, project, salesperson. Branch is a real
  -- column because it drives numbering, RLS and tax determination; these only
  -- slice reports, so a jsonb map avoids a schema change per dimension.
  dimensions jsonb not null default '{}'::jsonb,

  narration text,
  line_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check ((debit_amount > 0 and credit_amount = 0) or (credit_amount > 0 and debit_amount = 0)),
  foreign key (voucher_id, company_id) references public.vouchers (id, company_id) on delete cascade,
  foreign key (ledger_id, company_id) references public.ledgers (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id)
);

create index voucher_entries_company_ledger_idx on public.voucher_entries(company_id, ledger_id);
create index voucher_entries_voucher_idx on public.voucher_entries(voucher_id);
create index voucher_entries_branch_idx on public.voucher_entries(company_id, branch_id);
create index voucher_entries_dimensions_idx on public.voucher_entries using gin (dimensions);

create trigger set_updated_at
  before update on public.voucher_entries
  for each row execute function app_private.set_updated_at();


-- ----------------------------------------------------------------------------
-- Double-entry enforcement
-- ----------------------------------------------------------------------------
-- The database itself rejects any voucher whose lines do not sum debit =
-- credit, or that has fewer than two lines. Deferred, so a header plus N line
-- inserts inside one transaction are only checked at COMMIT.
--
-- This is the single most important guarantee in the system, and it lives here
-- rather than in the client because the client is not the only writer: the CSV
-- importer, a future public API and the mobile app all post through the same
-- tables.
create or replace function app_private.check_voucher_balance(p_voucher_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_exists boolean;
  v_debit numeric(18,2);
  v_credit numeric(18,2);
  v_count integer;
begin
  select exists(select 1 from public.vouchers where id = p_voucher_id) into v_exists;
  if not v_exists then
    return; -- header deleted in this same transaction; nothing to validate
  end if;

  select coalesce(sum(debit_amount),0), coalesce(sum(credit_amount),0), count(*)
    into v_debit, v_credit, v_count
    from public.voucher_entries where voucher_id = p_voucher_id;

  if v_count < 2 then
    raise exception 'Voucher % must have at least two line items (has %)', p_voucher_id, v_count;
  end if;
  if v_debit <> v_credit then
    raise exception 'Voucher % is unbalanced: debit % <> credit %', p_voucher_id, v_debit, v_credit;
  end if;

  update public.vouchers set total_amount = v_debit
   where id = p_voucher_id and total_amount is distinct from v_debit;
end;
$$;

create or replace function app_private.trg_voucher_entries_balance()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if TG_OP = 'DELETE' then
    perform app_private.check_voucher_balance(old.voucher_id);
    return old;
  else
    perform app_private.check_voucher_balance(new.voucher_id);
    if TG_OP = 'UPDATE' and old.voucher_id is distinct from new.voucher_id then
      perform app_private.check_voucher_balance(old.voucher_id);
    end if;
    return new;
  end if;
end;
$$;

create constraint trigger trg_voucher_entries_balance
  after insert or update or delete on public.voucher_entries
  deferrable initially deferred
  for each row execute function app_private.trg_voucher_entries_balance();


-- ----------------------------------------------------------------------------
-- Period control
-- ----------------------------------------------------------------------------
-- The lock date is a property of the voucher date, not of the user: an admin
-- cannot post into a closed period either.
create or replace function app_private.enforce_period_open()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_date date := coalesce(new.voucher_date, old.voucher_date);
  v_company uuid := coalesce(new.company_id, old.company_id);
begin
  if not app_private.is_period_open(v_company, v_date) then
    raise exception 'The books are locked on or before this date; % is in a closed period', v_date;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger enforce_period_open
  before insert or update or delete on public.vouchers
  for each row execute function app_private.enforce_period_open();


-- ----------------------------------------------------------------------------
-- Voucher RPCs
-- ----------------------------------------------------------------------------
-- security invoker, deliberately: RLS must gate role and period checks as the
-- calling user. Posting through an RPC is not a way to write rows you could
-- not write one at a time.
create or replace function public.create_voucher(
  p_company_id uuid,
  p_branch_id uuid,
  p_voucher_type text,
  p_voucher_date date,
  p_narration text,
  p_reference_number text,
  p_reference_date date,
  p_lines jsonb,
  p_party_ledger_id uuid default null,
  p_txn_currency char(3) default 'INR',
  p_exchange_rate numeric default 1,
  p_rate_source text default null
) returns uuid
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_voucher_id uuid;
  v_display_number text;
  v_seq_number int;
  v_fy_label text;
  v_line jsonb;
begin
  select display_number, seq_number, fy_label
    into v_display_number, v_seq_number, v_fy_label
    from app_private.next_voucher_number(p_company_id, p_branch_id, p_voucher_type, p_voucher_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, reference_number,
    reference_date, party_ledger_id, txn_currency, exchange_rate, rate_source,
    created_by
  )
  values (
    p_company_id, p_branch_id, p_voucher_type, v_display_number, v_seq_number,
    v_fy_label, p_voucher_date, p_narration, p_reference_number,
    p_reference_date, p_party_ledger_id, p_txn_currency, p_exchange_rate,
    p_rate_source, auth.uid()
  )
  returning id into v_voucher_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id,
      debit_amount, credit_amount, fc_amount, dimensions, narration, line_order
    )
    values (
      v_voucher_id,
      p_company_id,
      -- A line may sit in a different branch from the header — an inter-branch
      -- journal is one voucher touching two. Defaults to the header's branch.
      coalesce((v_line->>'branch_id')::uuid, p_branch_id),
      (v_line->>'ledger_id')::uuid,
      coalesce((v_line->>'debit_amount')::numeric, 0),
      coalesce((v_line->>'credit_amount')::numeric, 0),
      (v_line->>'fc_amount')::numeric,
      coalesce(v_line->'dimensions', '{}'::jsonb),
      v_line->>'narration',
      coalesce((v_line->>'line_order')::int, 0)
    );
  end loop;

  return v_voucher_id;
end;
$$;

-- F-01. HISAB's update_voucher set the date and left financial_year_label
-- untouched, so a voucher could be re-dated into another year while its number
-- still claimed the original one — and the other year's sequence could then
-- mint a number that collided in every practical sense. Under GST that breaks
-- the consecutive-series requirement outright.
--
-- Blocking is the right answer rather than renumbering: a voucher's number is
-- referenced on documents already sent to the counterparty, so silently
-- changing it is worse than refusing. Accountants expect to delete and
-- re-enter. voucher_type is likewise not editable.
create or replace function public.update_voucher(
  p_voucher_id uuid,
  p_voucher_date date,
  p_narration text,
  p_reference_number text,
  p_reference_date date,
  p_lines jsonb,
  p_party_ledger_id uuid default null
) returns uuid
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_company_id uuid;
  v_branch_id uuid;
  v_existing_fy text;
  v_new_fy text;
  v_fy_start_month smallint;
  v_line jsonb;
begin
  select company_id, branch_id, financial_year_label
    into v_company_id, v_branch_id, v_existing_fy
    from public.vouchers where id = p_voucher_id;

  if v_company_id is null then
    raise exception 'Voucher not found';
  end if;

  select financial_year_start_month into v_fy_start_month
    from public.companies where id = v_company_id;

  v_new_fy := app_private.fy_label(p_voucher_date, v_fy_start_month);

  if v_new_fy is distinct from v_existing_fy then
    raise exception
      'Cannot move this voucher from financial year % to %: its number belongs to the % series. Delete it and re-enter under the correct year.',
      v_existing_fy, v_new_fy, v_existing_fy;
  end if;

  update public.vouchers
     set voucher_date = p_voucher_date,
         narration = p_narration,
         reference_number = p_reference_number,
         reference_date = p_reference_date,
         party_ledger_id = coalesce(p_party_ledger_id, party_ledger_id),
         updated_by = auth.uid()
   where id = p_voucher_id;

  delete from public.voucher_entries where voucher_id = p_voucher_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id,
      debit_amount, credit_amount, fc_amount, dimensions, narration, line_order
    )
    values (
      p_voucher_id,
      v_company_id,
      coalesce((v_line->>'branch_id')::uuid, v_branch_id),
      (v_line->>'ledger_id')::uuid,
      coalesce((v_line->>'debit_amount')::numeric, 0),
      coalesce((v_line->>'credit_amount')::numeric, 0),
      (v_line->>'fc_amount')::numeric,
      coalesce(v_line->'dimensions', '{}'::jsonb),
      v_line->>'narration',
      coalesce((v_line->>'line_order')::int, 0)
    );
  end loop;

  return p_voucher_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- Row level security
-- ----------------------------------------------------------------------------
alter table public.voucher_number_sequences enable row level security;
alter table public.vouchers enable row level security;
alter table public.voucher_entries enable row level security;

-- Numbering is machinery, not data. Only the security-definer allocator
-- touches it, so no policy is granted to clients.

-- Branch scoping is enforced here, not in the UI: a branch-restricted member
-- genuinely cannot read another branch's vouchers.
create policy vouchers_read on public.vouchers
  for select to authenticated
  using (
    (select app_private.is_company_member(company_id))
    and (select app_private.can_access_branch(branch_id))
  );

create policy vouchers_write on public.vouchers
  for all to authenticated
  using (
    (select app_private.can_write_company(company_id))
    and (select app_private.can_access_branch(branch_id))
  )
  with check (
    (select app_private.can_write_company(company_id))
    and (select app_private.can_access_branch(branch_id))
  );

create policy voucher_entries_read on public.voucher_entries
  for select to authenticated
  using (
    (select app_private.is_company_member(company_id))
    and (select app_private.can_access_branch(branch_id))
  );

create policy voucher_entries_write on public.voucher_entries
  for all to authenticated
  using (
    (select app_private.can_write_company(company_id))
    and (select app_private.can_access_branch(branch_id))
  )
  with check (
    (select app_private.can_write_company(company_id))
    and (select app_private.can_access_branch(branch_id))
  );
