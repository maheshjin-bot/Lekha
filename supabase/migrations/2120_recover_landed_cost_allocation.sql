-- ============================================================================
-- 2120 — Recover landed_cost_allocations, landed_cost_allocation_items and
--        allocate_landed_cost: live in the database, missing from git
-- ============================================================================
-- WHY. public.allocate_landed_cost, public.landed_cost_allocations and
-- public.landed_cost_allocation_items are all live and working against real
-- data right now (TEST Precision Engineering's HOPUR26/0002 uses exactly
-- this path -- landed_cost_amount = 4,000.00, hand-verified against the
-- allocation's own base_value/allocated_amount rows). But no migration file
-- in this checked-out tree creates any of the three: the only file that even
-- mentions landed_cost_allocations is 1841 (delete_company's FK cleanup),
-- which assumes the table already exists and only ever DELETEs from it.
--
-- Both the function's own comment and landed_cost_allocation_items' table
-- comment refer to "1360" for the full reasoning -- but migration 1360 on
-- this branch is 1360_company_cin_iec_pan_editable.sql, an unrelated change.
-- The number was reused after the original 1360 (this feature) was applied
-- live from a different, since-abandoned worktree and never committed --
-- the exact "built live, never committed" pattern this codebase has hit
-- before (the Branches screen, lost twice before landing on main 7 Sep; the
-- ledger-edit screen, same fate, recovered 8 Sep as migration 1900). Left
-- alone, the next `supabase db reset` -- or the next fresh environment built
-- from these migrations alone -- silently loses a working, in-use feature.
--
-- WHAT THIS DOES. Recreates all three objects EXACTLY as they stand today:
-- same columns, same defaults, same constraints, same indexes, same RLS
-- policies, same function signature and body, same grants. Read from the
-- live database with pg_get_functiondef / information_schema / pg_catalog
-- immediately before writing this file, and diffed byte-for-byte against a
-- dry run of this migration on the same connection (see the verification
-- note at the end) -- nothing here is retyped from memory or guessed.
--
-- `create table if not exists` (not bare `create table`) so this migration
-- is a no-op against the live database it was written against -- every
-- column, constraint and index below is already there -- while still fully
-- bootstrapping the feature on a fresh database built from migrations alone.
-- The four RLS policies use the ordinary `drop policy if exists` + `create
-- policy` pair this codebase already uses everywhere a policy needs to be
-- replayable (see 1844), since CREATE POLICY has no IF NOT EXISTS.
--
-- Table-level grants to anon/authenticated are NOT restated here on purpose:
-- both tables already carry the same anon+authenticated DELETE/INSERT/
-- SELECT/UPDATE grants every other table in this schema carries (verified
-- against voucher_items and exim_shipment_details, a sibling 1841 lists
-- alongside this one) -- they come from the ALTER DEFAULT PRIVILEGES set up
-- in 0001/0080, not from anything this feature ever granted by hand, and
-- `create table if not exists` on a fresh database will pick the same
-- default up automatically. RLS (enabled below, matching live) is what
-- actually gates access, exactly as it does for every sibling detail table.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. landed_cost_allocations — one row per allocation event
-- ----------------------------------------------------------------------------
create table if not exists public.landed_cost_allocations (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies(id) on delete cascade,
  purchase_voucher_id     uuid not null,
  charges_voucher_id      uuid not null,
  allocation_date         date not null,
  narration               text,
  total_allocated_amount  numeric(18,2) not null check (total_allocated_amount > 0),
  created_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),

  -- v1 is record-once per purchase voucher -- no edit, no reverse.
  unique (purchase_voucher_id),
  -- Referenced as a composite FK target by landed_cost_allocation_items,
  -- so an allocation's rows can be pinned to the same company as the header.
  unique (id, company_id),

  foreign key (purchase_voucher_id, company_id) references public.vouchers(id, company_id),
  foreign key (charges_voucher_id, company_id) references public.vouchers(id, company_id)
);

create index if not exists landed_cost_allocations_company_idx
  on public.landed_cost_allocations (company_id);

comment on table public.landed_cost_allocations is
  'One row per landed-cost allocation event: which purchase voucher was costed, which new journal voucher posted the charges (Dr charge ledgers, Cr settlement ledger), and the total apportioned. purchase_voucher_id is UNIQUE -- v1 is record-once, no edit/reverse (see 1360 header).';

alter table public.landed_cost_allocations enable row level security;

drop policy if exists landed_cost_allocations_read on public.landed_cost_allocations;
create policy landed_cost_allocations_read on public.landed_cost_allocations
  for select to authenticated
  using (app_private.is_company_member(company_id));

drop policy if exists landed_cost_allocations_write on public.landed_cost_allocations;
create policy landed_cost_allocations_write on public.landed_cost_allocations
  for all to authenticated
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

-- ----------------------------------------------------------------------------
-- 2. landed_cost_allocation_items — one row per touched purchase item line
-- ----------------------------------------------------------------------------
create table if not exists public.landed_cost_allocation_items (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  allocation_id     uuid not null,
  voucher_item_id   uuid not null references public.voucher_items(id) on delete cascade,
  item_id           uuid not null,
  base_value        numeric(18,2) not null check (base_value >= 0),
  allocated_amount  numeric(18,2) not null check (allocated_amount >= 0),
  created_at        timestamptz not null default now(),

  foreign key (allocation_id, company_id) references public.landed_cost_allocations(id, company_id) on delete cascade,
  foreign key (item_id, company_id) references public.items(id, company_id)
);

create index if not exists landed_cost_allocation_items_allocation_idx
  on public.landed_cost_allocation_items (allocation_id);
create index if not exists landed_cost_allocation_items_voucher_item_idx
  on public.landed_cost_allocation_items (voucher_item_id);

comment on table public.landed_cost_allocation_items is
  'One row per purchase item line touched by a landed-cost allocation: base_value is that line''s own voucher_items.amount at allocation time (the pro-rata base), allocated_amount is what it received. Sum of allocated_amount across an allocation_id always equals landed_cost_allocations.total_allocated_amount exactly (rounding remainder dumped on the largest line -- see 1360 header).';

alter table public.landed_cost_allocation_items enable row level security;

drop policy if exists landed_cost_allocation_items_read on public.landed_cost_allocation_items;
create policy landed_cost_allocation_items_read on public.landed_cost_allocation_items
  for select to authenticated
  using (app_private.is_company_member(company_id));

drop policy if exists landed_cost_allocation_items_write on public.landed_cost_allocation_items;
create policy landed_cost_allocation_items_write on public.landed_cost_allocation_items
  for all to authenticated
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

-- ----------------------------------------------------------------------------
-- 3. allocate_landed_cost — recreated verbatim from pg_get_functiondef
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.allocate_landed_cost(p_company_id uuid, p_branch_id uuid, p_purchase_voucher_id uuid, p_charge_lines jsonb, p_settlement_ledger_id uuid, p_allocation_date date, p_narration text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_voucher record;
  v_total_charges numeric(18,2);
  v_base_total numeric(18,2);
  v_item_count int;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_new_voucher_id uuid;
  v_allocation_id uuid;
  v_line int := 0;
  v_charge jsonb;
  v_ledger_id uuid;
  v_amount numeric(18,2);
begin
  select id, voucher_number, voucher_date, voucher_type, is_deleted
    into v_voucher
    from public.vouchers
   where id = p_purchase_voucher_id and company_id = p_company_id;

  if v_voucher.id is null then
    raise exception 'Voucher % does not exist in this company', p_purchase_voucher_id;
  end if;
  if v_voucher.is_deleted then
    raise exception 'Cannot allocate landed cost to a deleted voucher';
  end if;
  if v_voucher.voucher_type <> 'purchase' then
    raise exception 'Landed cost can only be allocated against a purchase voucher, not a % voucher', v_voucher.voucher_type;
  end if;
  if p_allocation_date < v_voucher.voucher_date then
    raise exception 'Allocation date cannot be before the purchase voucher''s own date (%)', v_voucher.voucher_date;
  end if;
  if exists (select 1 from public.landed_cost_allocations where purchase_voucher_id = p_purchase_voucher_id) then
    raise exception 'This purchase voucher already has a landed-cost allocation recorded. v1 does not support a second allocation or editing an existing one -- post a manual correcting journal instead.';
  end if;

  if p_charge_lines is null or jsonb_typeof(p_charge_lines) <> 'array' or jsonb_array_length(p_charge_lines) = 0 then
    raise exception 'Enter at least one charge line to allocate';
  end if;

  select coalesce(sum(round(coalesce((c->>'amount')::numeric, 0), 2)), 0)
    into v_total_charges
    from jsonb_array_elements(p_charge_lines) c;

  if not (v_total_charges > 0) then
    raise exception 'Total charges must be greater than zero';
  end if;

  -- The allocation base: every 'in'-direction item line already posted on
  -- this purchase voucher, at its own untouched invoice amount.
  select coalesce(sum(amount), 0), count(*)
    into v_base_total, v_item_count
    from public.voucher_items
   where voucher_id = p_purchase_voucher_id and company_id = p_company_id and direction = 'in';

  if v_item_count = 0 then
    raise exception 'This purchase voucher has no stock item lines to allocate landed cost across';
  end if;
  if not (v_base_total > 0) then
    raise exception 'This purchase voucher''s item lines have zero total value -- there is nothing to allocate landed cost against';
  end if;

  -- Validate every charge line up front (ledger present, belongs to this
  -- company, positive amount) before posting anything.
  for v_charge in select * from jsonb_array_elements(p_charge_lines) loop
    v_ledger_id := (v_charge->>'ledger_id')::uuid;
    v_amount := round(coalesce((v_charge->>'amount')::numeric, 0), 2);
    if v_ledger_id is null then
      raise exception 'Every charge line needs a ledger';
    end if;
    if not (v_amount > 0) then
      raise exception 'Every charge line needs an amount greater than zero';
    end if;
    if not exists (select 1 from public.ledgers where id = v_ledger_id and company_id = p_company_id) then
      raise exception 'Ledger % is not a ledger in this company', v_ledger_id;
    end if;
  end loop;
  if p_settlement_ledger_id is null or not exists (
    select 1 from public.ledgers where id = p_settlement_ledger_id and company_id = p_company_id
  ) then
    raise exception 'Pick the bank/cash/payable ledger the charges were actually settled through';
  end if;

  -- Post the charges voucher: Dr each charge ledger, Cr the settlement
  -- ledger. Same next_voucher_number + header-then-entries shape as
  -- record_forex_settlement (0068).
  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, 'journal', p_allocation_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, party_ledger_id, created_by)
  values (
    p_company_id, p_branch_id, 'journal', v_display_number, v_seq, v_fy,
    p_allocation_date,
    coalesce(p_narration, 'Landed cost for purchase voucher ' || v_voucher.voucher_number),
    p_settlement_ledger_id, auth.uid())
  returning id into v_new_voucher_id;

  for v_charge in select * from jsonb_array_elements(p_charge_lines) loop
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, narration, line_order)
    values (
      v_new_voucher_id, p_company_id, p_branch_id,
      (v_charge->>'ledger_id')::uuid,
      round(coalesce((v_charge->>'amount')::numeric, 0), 2), 0,
      v_charge->>'description', v_line);
    v_line := v_line + 1;
  end loop;

  insert into public.voucher_entries (
    voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_new_voucher_id, p_company_id, p_branch_id, p_settlement_ledger_id, 0, v_total_charges, v_line);

  -- The allocation header.
  insert into public.landed_cost_allocations (
    company_id, purchase_voucher_id, charges_voucher_id, allocation_date, narration, total_allocated_amount, created_by)
  values (p_company_id, p_purchase_voucher_id, v_new_voucher_id, p_allocation_date, p_narration, v_total_charges, auth.uid())
  returning id into v_allocation_id;

  -- Pro-rata by value, rounding remainder dumped on the largest base-value
  -- line (ties broken by voucher_item id) so the total reconciles exactly.
  with base as (
    select vi.id as voucher_item_id, vi.item_id, vi.amount as base_value,
           row_number() over (order by vi.amount desc, vi.id) as rn
      from public.voucher_items vi
     where vi.voucher_id = p_purchase_voucher_id and vi.company_id = p_company_id and vi.direction = 'in'
  ),
  naive as (
    select voucher_item_id, item_id, base_value, rn,
           round(v_total_charges * base_value / v_base_total, 2) as naive_amount
      from base
  ),
  alloc as (
    select voucher_item_id, item_id, base_value,
           case when rn = 1
                then v_total_charges - (sum(naive_amount) over () - naive_amount)
                else naive_amount
           end as allocated_amount
      from naive
  )
  insert into public.landed_cost_allocation_items (
    company_id, allocation_id, voucher_item_id, item_id, base_value, allocated_amount)
  select p_company_id, v_allocation_id, voucher_item_id, item_id, base_value, allocated_amount
    from alloc;

  update public.voucher_items vi
     set landed_cost_amount = vi.landed_cost_amount + a.allocated_amount
    from public.landed_cost_allocation_items a
   where a.allocation_id = v_allocation_id and a.voucher_item_id = vi.id;

  return v_new_voucher_id;
end;
$function$
;

revoke all on function public.allocate_landed_cost(uuid, uuid, uuid, jsonb, uuid, date, text) from public, anon;
grant execute on function public.allocate_landed_cost(uuid, uuid, uuid, jsonb, uuid, date, text) to authenticated, service_role;

comment on function public.allocate_landed_cost(uuid, uuid, uuid, jsonb, uuid, date, text) is
  'Allocates incidental charges (customs duty/freight/insurance/CHA -- the NON-creditable component only, see 1360 header) across a purchase voucher''s item lines, pro-rata by each line''s own invoice value. Posts one new journal voucher (Dr each charge ledger, Cr p_settlement_ledger_id), records a landed_cost_allocations/landed_cost_allocation_items breakdown, and adds the apportioned amount to each touched voucher_items.landed_cost_amount. Record-once per purchase voucher (unique constraint) -- v1 has no edit/reverse. security invoker: RLS gates every write exactly as if posted by hand.';

-- ============================================================================
-- VERIFICATION (run live, not part of the migration): pg_get_functiondef of
-- public.allocate_landed_cost, and the information_schema.columns /
-- pg_constraint / pg_indexes / pg_policies rows for both tables, compared
-- byte-for-byte before and after applying this file to the live database --
-- identical in every case. See this task's final report for the query
-- transcript.
-- ============================================================================
