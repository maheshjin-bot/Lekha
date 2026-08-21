-- Job work (GST Sec 143 CGST Act, Form GST ITC-04) — v1.
-- Deliberately does NOT touch VoucherForm.tsx/InvoiceForm.tsx (locked by a
-- concurrent session): job work gets its own dedicated entry surface,
-- exactly like Orders (0061) got its own rather than reusing the generic
-- voucher form.
--
-- THE DESIGN QUESTION THIS MIGRATION HAD TO RESOLVE (flagged as genuinely
-- unresolved by this session's research pass, shared with Manufacturing/BOM):
-- job work is a pure stock movement with no consideration — not a "supply"
-- under Sec 7 CGST Act, so real-world software (Tally's own Manufacturing
-- Journal, and job-work delivery challans generally) posts NOTHING to any
-- ledger account. But LEKHA's check_voucher_balance (0007) hard-requires
-- every voucher to have >=2 voucher_entries rows with debit = credit — a
-- voucher with only voucher_items (stock) rows and zero voucher_entries
-- rows fails that constraint outright.
--
-- RESOLUTION CHOSEN: post a self-cancelling pair — Dr and Cr the SAME
-- "Job Work Movement" ledger for the SAME amount (goods-at-cost), as two
-- separate voucher_entries rows on the one voucher. This satisfies
-- check_voucher_balance trivially (debit sum = credit sum by construction)
-- and gives the voucher a real, meaningful total_amount for display and
-- audit trail (the value of goods actually sent/returned) — but the
-- ledger's own running balance is mathematically always zero, so it
-- contributes nothing real to the trial balance, P&L or balance sheet.
-- This is option (a) from the research: the alternative of a genuine
-- non-cancelling "Goods Sent for Job Work" asset ledger was considered and
-- rejected for v1 — it would require deciding how/when to reverse it on
-- return in a way that survives partial returns and losses cleanly, which
-- adds real design surface for a benefit (an asset-side "goods out"
-- balance-sheet figure) nothing asked for. Worth revisiting if a real user
-- wants that visibility later.
--
-- SCOPE, deliberately narrow (same "one item, simplest shape first"
-- discipline used throughout this session — cost centres, batch tracking,
-- forex settlement): one item per challan. A challan with multiple
-- materials needs multiple challans in v1. This keeps the outstanding-
-- balance math (sent - received - loss = still with job worker) a single
-- number per challan rather than a per-item breakdown, and keeps
-- create_job_work_challan a single voucher_items row rather than an array.

alter table public.vouchers drop constraint vouchers_voucher_type_check;
alter table public.vouchers add constraint vouchers_voucher_type_check
  check (voucher_type = any (array[
    'receipt','payment','contra','journal','sales','purchase',
    'credit_note','debit_note','branch_transfer','stock_journal',
    'job_work_out','job_work_in'
  ]));

alter table public.ledgers drop constraint ledgers_party_type_check;
alter table public.ledgers add constraint ledgers_party_type_check
  check (party_type is null or party_type = any (array[
    'customer','supplier','both','employee','bank','government','related_party','other','job_worker'
  ]));

-- app_private.next_voucher_number's generic fallback (upper(left(type,3)))
-- would give job_work_out AND job_work_in the identical "JOB" display
-- prefix, distinguished only by the invisible voucher_type column — a real
-- voucher_number collision-in-appearance a user would notice immediately.
-- Adding two explicit branches is additive and backward-compatible: every
-- existing voucher_type's prefix is untouched, this only names the two new
-- ones so they read distinctly (JWO/JWI) instead of falling through.
create or replace function app_private.next_voucher_number(p_company_id uuid, p_branch_id uuid, p_voucher_type text, p_voucher_date date)
returns table(display_number text, seq_number integer, fy_label text)
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_fy_start_month smallint; v_fy_label text; v_branch_code text;
  v_prefix text; v_padding smallint; v_number int;
begin
  select financial_year_start_month into v_fy_start_month from public.companies where id = p_company_id;
  if v_fy_start_month is null then raise exception 'Company not found'; end if;

  select code into v_branch_code from public.branches where id = p_branch_id and company_id = p_company_id;
  if v_branch_code is null then raise exception 'Branch not found in this company'; end if;

  v_fy_label := app_private.fy_label(p_voucher_date, v_fy_start_month);

  v_prefix := v_branch_code || '/' || case p_voucher_type
    when 'receipt' then 'REC' when 'payment' then 'PAY' when 'contra' then 'CON'
    when 'journal' then 'JRN' when 'sales' then 'SAL' when 'purchase' then 'PUR'
    when 'credit_note' then 'CRN' when 'debit_note' then 'DBN'
    when 'branch_transfer' then 'BTR' when 'stock_journal' then 'STK'
    when 'job_work_out' then 'JWO' when 'job_work_in' then 'JWI'
    else upper(left(p_voucher_type, 3)) end;

  insert into public.voucher_number_sequences
    (company_id, branch_id, voucher_type, financial_year_label, prefix, next_number)
  values (p_company_id, p_branch_id, p_voucher_type, v_fy_label, v_prefix, 2)
  on conflict (company_id, branch_id, voucher_type, financial_year_label)
  do update set next_number = voucher_number_sequences.next_number + 1
  returning (next_number - 1), padding into v_number, v_padding;

  return query select
    (v_prefix || '/' || v_fy_label || '/' || lpad(v_number::text, v_padding, '0')), v_number, v_fy_label;
end;
$$;

-- ---------------------------------------------------------------------------
-- ensure_job_work_movement_ledger — idempotent auto-provision, same shape
-- as this session's ensure_cash_sales_ledger (0066) / ensure_exchange_gain_
-- loss_ledger (0068). Under Current Assets (verified live: seeded on all
-- 15 companies) — placement barely matters functionally since the ledger's
-- balance is always zero by construction, but Current Assets is the
-- honest home for "value of goods temporarily not in a godown."
-- ---------------------------------------------------------------------------
create or replace function public.ensure_job_work_movement_ledger(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_group uuid;
  v_ledger uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to set up ledgers for this company';
  end if;

  select id into v_group
    from public.account_groups
   where company_id = p_company_id and name = 'Current Assets'
   limit 1;

  if v_group is null then
    raise exception 'Chart of accounts is not set up for this company yet (no Current Assets group)';
  end if;

  select id into v_ledger
    from public.ledgers
   where company_id = p_company_id and group_id = v_group and name = 'Job Work Movement'
   limit 1;

  if v_ledger is not null then
    return v_ledger;
  end if;

  insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
  values (p_company_id, v_group, 'Job Work Movement', 'debit', 0)
  returning id into v_ledger;

  return v_ledger;
end;
$$;

revoke all on function public.ensure_job_work_movement_ledger(uuid) from public, anon;
grant execute on function public.ensure_job_work_movement_ledger(uuid) to authenticated;

comment on function public.ensure_job_work_movement_ledger(uuid) is
  'Idempotently returns the self-cancelling "Job Work Movement" memo ledger — job_work_out/in vouchers debit and credit it for the SAME amount on the SAME voucher, so its running balance is always zero. Exists purely so those vouchers satisfy check_voucher_balance while carrying a real total_amount.';

-- ---------------------------------------------------------------------------
-- job_work_challans — one row per job_work_out voucher (header + the one
-- item, since v1 is one-item-per-challan)
-- ---------------------------------------------------------------------------
create table public.job_work_challans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  voucher_id uuid not null references public.vouchers(id) on delete cascade,
  job_worker_ledger_id uuid not null,
  item_id uuid not null,
  quantity_sent numeric(18, 3) not null check (quantity_sent > 0),
  uom text not null,
  nature_of_job_work text,
  challan_date date not null,
  expected_return_date date,
  statutory_limit_type text not null default 'input'
    check (statutory_limit_type = any (array['input', 'capital_good', 'exempt_tool'])),
  statutory_due_date date,
  extended_due_date date,
  status text not null default 'open'
    check (status = any (array['open', 'partially_returned', 'closed'])),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (job_worker_ledger_id, company_id) references public.ledgers (id, company_id),
  foreign key (item_id, company_id) references public.items (id, company_id),
  check (extended_due_date is null or statutory_due_date is null or extended_due_date >= statutory_due_date)
);

create index job_work_challans_company_status_idx on public.job_work_challans (company_id, status);
create index job_work_challans_due_date_idx on public.job_work_challans (company_id, statutory_due_date)
  where statutory_due_date is not null;

comment on table public.job_work_challans is
  'One row per job-work dispatch (the job_work_out voucher that actually moved stock), one item per challan (v1 scope). statutory_due_date is the Sec 143 deemed-supply clock: 1 year from dispatch for inputs, 3 years for capital goods, no limit for exempt tools/dies/jigs/fixtures.';

alter table public.job_work_challans enable row level security;

create policy job_work_challans_read on public.job_work_challans for select
  using (app_private.is_company_member(company_id));

-- No direct-insert policy: the voucher + challan + self-cancelling ledger
-- pair must be created together atomically, so writes go only through
-- create_job_work_challan (SECURITY DEFINER) — same convention as
-- voucher_entries/cost-centre dimensions. Status DOES get updated directly
-- by create_job_work_return, also SECURITY DEFINER, so no client write
-- path is needed on this table at all.

-- ---------------------------------------------------------------------------
-- job_work_returns — one row per return/loss event against a challan
-- ---------------------------------------------------------------------------
create table public.job_work_returns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  challan_id uuid not null references public.job_work_challans(id) on delete cascade,
  return_voucher_id uuid references public.vouchers(id) on delete set null,
  return_date date not null,
  returned_item_id uuid,
  quantity_received numeric(18, 3) not null default 0 check (quantity_received >= 0),
  quantity_loss_or_waste numeric(18, 3) not null default 0 check (quantity_loss_or_waste >= 0),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (returned_item_id, company_id) references public.items (id, company_id),
  check (quantity_received > 0 or quantity_loss_or_waste > 0)
);

create index job_work_returns_challan_idx on public.job_work_returns (challan_id);

comment on table public.job_work_returns is
  'A return event against a challan — received quantity (return_voucher_id links the real job_work_in voucher that moved it back into stock, item may differ from what was sent) and/or reported loss/waste (no stock movement, no voucher). ITC-04 Tables 5A/5B/5C track exactly this split.';

alter table public.job_work_returns enable row level security;

create policy job_work_returns_read on public.job_work_returns for select
  using (app_private.is_company_member(company_id));

-- ---------------------------------------------------------------------------
-- create_job_work_challan — creates the job_work_out voucher (real stock
-- movement) + the self-cancelling ledger pair + the challan header,
-- atomically.
-- ---------------------------------------------------------------------------
create or replace function public.create_job_work_challan(
  p_company_id uuid,
  p_branch_id uuid,
  p_job_worker_ledger_id uuid,
  p_item_id uuid,
  p_quantity numeric,
  p_uom text,
  p_godown_id uuid,
  p_rate numeric,
  p_challan_date date,
  p_nature_of_job_work text default null,
  p_expected_return_date date default null,
  p_statutory_limit_type text default 'input',
  p_narration text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_movement_ledger uuid;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_voucher_id uuid;
  v_amount numeric;
  v_due_date date;
  v_challan_id uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to record job work for this company';
  end if;
  if not app_private.module_active(p_company_id, 'job_work', p_challan_date) then
    raise exception 'Job work is not an active module for this company — turn it on in Settings first';
  end if;
  if not (p_quantity > 0) then
    raise exception 'Quantity sent must be greater than zero';
  end if;
  if p_statutory_limit_type not in ('input', 'capital_good', 'exempt_tool') then
    raise exception '% is not a recognised statutory limit type', p_statutory_limit_type;
  end if;

  v_amount := round(p_quantity * coalesce(p_rate, 0), 2);
  v_movement_ledger := public.ensure_job_work_movement_ledger(p_company_id);

  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, 'job_work_out', p_challan_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, party_ledger_id, created_by)
  values (
    p_company_id, p_branch_id, 'job_work_out', v_display_number, v_seq,
    v_fy, p_challan_date, coalesce(p_narration, 'Sent for job work'), p_job_worker_ledger_id, auth.uid())
  returning id into v_voucher_id;

  insert into public.voucher_items (
    voucher_id, company_id, branch_id, godown_id, item_id,
    direction, quantity, uom, rate, amount, line_order)
  values (
    v_voucher_id, p_company_id, p_branch_id, p_godown_id, p_item_id,
    'out', p_quantity, p_uom, coalesce(p_rate, 0), v_amount, 0);

  -- Self-cancelling pair — see migration header for why. If v_amount is
  -- zero (no rate given), still post the pair at zero so >=2 lines exists.
  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_movement_ledger, v_amount, 0, 0);
  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_movement_ledger, 0, v_amount, 1);

  v_due_date := case p_statutory_limit_type
    when 'input' then p_challan_date + interval '1 year'
    when 'capital_good' then p_challan_date + interval '3 years'
    else null
  end;

  insert into public.job_work_challans (
    company_id, branch_id, voucher_id, job_worker_ledger_id, item_id,
    quantity_sent, uom, nature_of_job_work, challan_date, expected_return_date,
    statutory_limit_type, statutory_due_date, created_by)
  values (
    p_company_id, p_branch_id, v_voucher_id, p_job_worker_ledger_id, p_item_id,
    p_quantity, p_uom, p_nature_of_job_work, p_challan_date, p_expected_return_date,
    p_statutory_limit_type, v_due_date, auth.uid())
  returning id into v_challan_id;

  return v_challan_id;
end;
$$;

revoke all on function public.create_job_work_challan(uuid, uuid, uuid, uuid, numeric, text, uuid, numeric, date, text, date, text, text) from public, anon;
grant execute on function public.create_job_work_challan(uuid, uuid, uuid, uuid, numeric, text, uuid, numeric, date, text, date, text, text) to authenticated;

comment on function public.create_job_work_challan(uuid, uuid, uuid, uuid, numeric, text, uuid, numeric, date, text, date, text, text) is
  'Creates the job_work_out voucher (real stock movement out of the godown, valued at p_rate), the self-cancelling Job Work Movement ledger pair that satisfies check_voucher_balance, and the challan header, atomically. v1 is one item per challan.';

-- ---------------------------------------------------------------------------
-- create_job_work_return — records a return (received quantity and/or
-- loss/waste) against an open challan.
-- ---------------------------------------------------------------------------
create or replace function public.create_job_work_return(
  p_company_id uuid,
  p_branch_id uuid,
  p_challan_id uuid,
  p_return_date date,
  p_quantity_received numeric default 0,
  p_returned_item_id uuid default null,
  p_godown_id uuid default null,
  p_rate numeric default null,
  p_quantity_loss_or_waste numeric default 0,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_challan record;
  v_already_closed numeric;
  v_movement_ledger uuid;
  v_return_voucher_id uuid;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_amount numeric;
  v_return_id uuid;
  v_new_total numeric;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to record job work returns for this company';
  end if;
  if p_quantity_received <= 0 and p_quantity_loss_or_waste <= 0 then
    raise exception 'A return must report a received quantity, a loss/waste quantity, or both';
  end if;
  if p_quantity_received > 0 and p_returned_item_id is null then
    raise exception 'The item actually being returned must be specified when quantity_received > 0';
  end if;

  select item_id, quantity_sent, status, job_worker_ledger_id
    into v_challan
    from public.job_work_challans
   where id = p_challan_id and company_id = p_company_id;

  if v_challan.item_id is null then
    raise exception 'Challan % does not exist in this company', p_challan_id;
  end if;
  if v_challan.status = 'closed' then
    raise exception 'This challan is already fully closed';
  end if;

  select coalesce(sum(quantity_received), 0) + coalesce(sum(quantity_loss_or_waste), 0)
    into v_already_closed
    from public.job_work_returns
   where challan_id = p_challan_id;

  v_new_total := v_already_closed + p_quantity_received + p_quantity_loss_or_waste;
  if v_new_total > v_challan.quantity_sent + 0.0005 then
    raise exception 'This return would take the challan''s received+loss total to % — only % was sent',
      v_new_total, v_challan.quantity_sent;
  end if;

  if p_quantity_received > 0 then
    if p_godown_id is null then
      raise exception 'A godown is required to receive returned goods back into stock';
    end if;
    v_amount := round(p_quantity_received * coalesce(p_rate, 0), 2);
    v_movement_ledger := public.ensure_job_work_movement_ledger(p_company_id);

    select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
      from app_private.next_voucher_number(p_company_id, p_branch_id, 'job_work_in', p_return_date);

    insert into public.vouchers (
      company_id, branch_id, voucher_type, voucher_number, sequence_number,
      financial_year_label, voucher_date, narration, party_ledger_id, created_by)
    values (
      p_company_id, p_branch_id, 'job_work_in', v_display_number, v_seq,
      v_fy, p_return_date, coalesce(p_notes, 'Returned from job work'), v_challan.job_worker_ledger_id, auth.uid())
    returning id into v_return_voucher_id;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, line_order)
    select v_return_voucher_id, p_company_id, p_branch_id, p_godown_id, p_returned_item_id,
           'in', p_quantity_received, c.uom, coalesce(p_rate, 0), v_amount, 0
      from public.job_work_challans c where c.id = p_challan_id;

    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_return_voucher_id, p_company_id, p_branch_id, v_movement_ledger, v_amount, 0, 0);
    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_return_voucher_id, p_company_id, p_branch_id, v_movement_ledger, 0, v_amount, 1);
  end if;

  insert into public.job_work_returns (
    company_id, challan_id, return_voucher_id, return_date, returned_item_id,
    quantity_received, quantity_loss_or_waste, notes, created_by)
  values (
    p_company_id, p_challan_id, v_return_voucher_id, p_return_date, p_returned_item_id,
    p_quantity_received, p_quantity_loss_or_waste, p_notes, auth.uid())
  returning id into v_return_id;

  update public.job_work_challans
     set status = case when v_new_total >= quantity_sent - 0.0005 then 'closed' else 'partially_returned' end,
         updated_at = now()
   where id = p_challan_id;

  return v_return_id;
end;
$$;

revoke all on function public.create_job_work_return(uuid, uuid, uuid, date, numeric, uuid, uuid, numeric, numeric, text) from public, anon;
grant execute on function public.create_job_work_return(uuid, uuid, uuid, date, numeric, uuid, uuid, numeric, numeric, text) to authenticated;

comment on function public.create_job_work_return(uuid, uuid, uuid, date, numeric, uuid, uuid, numeric, numeric, text) is
  'Records a return against a challan — received quantity (posts a real job_work_in voucher moving stock back in, item may differ from what was sent) and/or loss/waste (no voucher, just recorded). Guards received+loss (cumulative across all returns) never exceeding what was sent, and auto-closes the challan when it does.';

-- ---------------------------------------------------------------------------
-- get_job_work_outstanding — per-challan reconciliation and due-date risk.
-- item_id is included alongside item_name so the return screen can default
-- its returned-item picker from a real id rather than a fragile name
-- lookup — the returned item can legitimately differ from what was sent
-- (cloth out, shirts back), so the UI needs the id to let that be an
-- explicit choice, not an assumption.
-- ---------------------------------------------------------------------------
drop function if exists public.get_job_work_outstanding(uuid, date);
create function public.get_job_work_outstanding(
  p_company_id uuid,
  p_as_at date default current_date
)
returns table (
  challan_id uuid,
  challan_number text,
  challan_date date,
  job_worker_name text,
  item_id uuid,
  item_name text,
  uom text,
  quantity_sent numeric,
  quantity_received numeric,
  quantity_loss numeric,
  quantity_outstanding numeric,
  statutory_due_date date,
  extended_due_date date,
  is_overdue boolean,
  status text
)
language sql
stable
set search_path to ''
as $$
  select
    c.id, v.voucher_number, c.challan_date, l.name, i.id, i.name, c.uom,
    c.quantity_sent,
    coalesce(r.received, 0),
    coalesce(r.loss, 0),
    c.quantity_sent - coalesce(r.received, 0) - coalesce(r.loss, 0),
    c.statutory_due_date, c.extended_due_date,
    coalesce(c.extended_due_date, c.statutory_due_date) < p_as_at
      and (c.quantity_sent - coalesce(r.received, 0) - coalesce(r.loss, 0)) > 0.0005,
    c.status
  from public.job_work_challans c
  join public.vouchers v on v.id = c.voucher_id
  join public.ledgers l on l.id = c.job_worker_ledger_id
  join public.items i on i.id = c.item_id
  left join (
    select challan_id, sum(quantity_received) as received, sum(quantity_loss_or_waste) as loss
      from public.job_work_returns
     group by challan_id
  ) r on r.challan_id = c.id
  where c.company_id = p_company_id
  order by c.status = 'closed', c.statutory_due_date nulls last, c.challan_date;
$$;

revoke all on function public.get_job_work_outstanding(uuid, date) from public, anon;
grant execute on function public.get_job_work_outstanding(uuid, date) to authenticated;

comment on function public.get_job_work_outstanding(uuid, date) is
  'Per-challan reconciliation: sent - received - loss = still with job worker, plus the Sec 143 deemed-supply risk flag (past due date with material still outstanding). Direct data source for a future ITC-04 export and for the due-date dashboard.';
