-- ============================================================================
-- 0061 — Sales and purchase orders: a pre-invoice document, not a voucher
-- ============================================================================
-- The `orders` module (0004) has been registered since day one — optional,
-- code "Sales and purchase orders" — with zero code behind it, the same
-- shape of gap 0059/0060/0058 each closed for their own module.
--
-- DELIBERATELY POSTS NOTHING. A sales or purchase order is a commitment, not
-- a transaction — it has no place in a trial balance, and create_order does
-- not touch voucher_entries, ledgers, or stock at all. That is also why this
-- migration can be entirely new tables with zero risk to the voucher
-- engine's own correctness: nothing here can ever unbalance a book, because
-- nothing here posts to one.
--
-- NO SEQUENTIAL NUMBERING. GST tax invoices have a LEGAL requirement to be
-- numbered sequentially (the exact rule create_invoice's own voucher
-- numbering exists to satisfy) — a quotation or purchase order has no such
-- requirement under any Indian statute. Inventing a second numbering series
-- to imitate the voucher one would be authority this document does not need
-- and complexity a business does not benefit from; order_reference is a
-- free-text field for whatever number a business already uses (their own PO
-- book, an external system), not a generated one.
--
-- CONVERSION TO A REAL VOUCHER IS A MANUAL, LINKED STEP, NOT AN
-- AUTO-POPULATE. mark_order_converted(order, voucher_id) records which
-- voucher fulfilled an order after the business creates that voucher
-- normally through the existing invoice/voucher screens — it does not
-- pre-fill or drive InvoiceForm/VoucherForm itself. Two reasons: those
-- screens are a concurrent session's in-flight, uncommitted work in this
-- shared tree, and — independent of that — an order's quoted price, terms
-- or item mix commonly differs from what actually ships, so forcing a
-- straight-through conversion would misrepresent how businesses actually
-- use quotations in practice.
--
-- STATUS IS A ONE-WAY LIFECYCLE: draft -> confirmed -> (fulfilled |
-- cancelled), enforced in advance_order_status rather than left to whatever
-- an UPDATE statement is willing to write, so a fulfilled order can never be
-- silently walked back to draft by a stray client bug.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- orders
-- ----------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  order_type text not null check (order_type in ('sales','purchase')),
  order_reference text,
  order_date date not null,
  expected_date date,
  party_ledger_id uuid,
  notes text,
  status text not null default 'draft' check (status in ('draft','confirmed','fulfilled','cancelled')),
  fulfilled_voucher_id uuid,
  fulfilled_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (party_ledger_id, company_id) references public.ledgers (id, company_id),
  foreign key (fulfilled_voucher_id, company_id) references public.vouchers (id, company_id),
  check (expected_date is null or expected_date >= order_date)
);

create index orders_company_status_idx on public.orders(company_id, order_type, status, order_date desc);

create trigger set_updated_at before update on public.orders
  for each row execute function app_private.set_updated_at();

alter table public.orders enable row level security;

create policy orders_read on public.orders
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy orders_write on public.orders
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.orders is
  'Sales/purchase orders and quotations — a pre-invoice commitment, not a ledger-posting document. Posts nothing to voucher_entries; fulfilled_voucher_id is an optional pointer to whichever voucher a business later created to actually fulfil it, set explicitly by mark_order_converted, never auto-created.';


-- ----------------------------------------------------------------------------
-- order_items
-- ----------------------------------------------------------------------------
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  item_id uuid,
  description text not null check (length(trim(description)) > 0),
  quantity numeric(18,3) not null check (quantity > 0),
  uom text,
  rate numeric(18,2) not null default 0 check (rate >= 0),
  amount numeric(18,2) not null default 0 check (amount >= 0),
  line_order smallint not null default 0,
  foreign key (item_id, company_id) references public.items (id, company_id)
);

create index order_items_order_idx on public.order_items(order_id);

alter table public.order_items enable row level security;

create policy order_items_read on public.order_items
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy order_items_write on public.order_items
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.order_items is
  'Line items on an order. item_id is nullable — a quotation commonly quotes something not yet in the item master (a custom job, a one-off service); description is what always renders, not a derived label.';


-- ----------------------------------------------------------------------------
-- create_order(company, branch, type, party, dates, notes, items jsonb) -> order_id
-- ----------------------------------------------------------------------------
create or replace function public.create_order(
  p_company_id uuid,
  p_branch_id uuid,
  p_order_type text,
  p_party_ledger_id uuid default null,
  p_order_date date default current_date,
  p_expected_date date default null,
  p_order_reference text default null,
  p_notes text default null,
  p_items jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_item jsonb;
begin
  insert into public.orders (
    company_id, branch_id, order_type, party_ledger_id,
    order_date, expected_date, order_reference, notes, created_by
  ) values (
    p_company_id, p_branch_id, p_order_type, p_party_ledger_id,
    p_order_date, p_expected_date, p_order_reference, p_notes, auth.uid()
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items (
      order_id, company_id, item_id, description, quantity, uom, rate, amount, line_order
    ) values (
      v_order_id, p_company_id,
      nullif(v_item->>'item_id','')::uuid,
      v_item->>'description',
      (v_item->>'quantity')::numeric,
      v_item->>'uom',
      coalesce((v_item->>'rate')::numeric, 0),
      coalesce((v_item->>'amount')::numeric, 0),
      coalesce((v_item->>'line_order')::int, 0)
    );
  end loop;

  return v_order_id;
end;
$$;

revoke execute on function public.create_order(uuid, uuid, text, uuid, date, date, text, text, jsonb) from anon;

comment on function public.create_order is
  'Creates an order and its lines in one call, same jsonb-array-of-lines shape create_voucher (0007) uses. Posts nothing to the ledger — see the migration header.';


-- ----------------------------------------------------------------------------
-- advance_order_status(company, order_id, new_status, fulfilled_note)
-- ----------------------------------------------------------------------------
-- The one-way lifecycle gate: draft -> confirmed -> (fulfilled | cancelled).
-- A cancelled or fulfilled order is a closed record; nothing here reopens
-- one, on the same principle a closed accounting period is not silently
-- reopened by an ordinary write path.
create or replace function public.advance_order_status(
  p_company_id uuid,
  p_order_id uuid,
  p_new_status text,
  p_fulfilled_note text default null
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current text;
  v_allowed boolean;
begin
  select status into v_current
    from public.orders
   where id = p_order_id and company_id = p_company_id
   for update;

  if v_current is null then
    raise exception 'Order not found';
  end if;

  v_allowed := (v_current = 'draft' and p_new_status in ('confirmed','cancelled'))
            or (v_current = 'confirmed' and p_new_status in ('fulfilled','cancelled'));

  if not v_allowed then
    raise exception 'Cannot move an order from % to %', v_current, p_new_status;
  end if;

  update public.orders
     set status = p_new_status,
         fulfilled_note = case when p_new_status = 'fulfilled' then p_fulfilled_note else fulfilled_note end
   where id = p_order_id and company_id = p_company_id;
end;
$$;

revoke execute on function public.advance_order_status(uuid, uuid, text, text) from anon;

comment on function public.advance_order_status is
  'Moves an order through its one-way lifecycle: draft -> confirmed -> (fulfilled | cancelled). Any other transition is refused, including reopening a fulfilled or cancelled order — RLS decides WHO may write, this decides WHICH transitions exist at all.';


-- ----------------------------------------------------------------------------
-- mark_order_converted(company, order_id, voucher_id)
-- ----------------------------------------------------------------------------
-- Separate from advance_order_status because linking a fulfilling voucher and
-- marking an order fulfilled are two different facts a caller may know at
-- two different times — a business might mark an order fulfilled from stock
-- already on hand with no voucher yet, then link the invoice once raised.
create or replace function public.mark_order_converted(
  p_company_id uuid,
  p_order_id uuid,
  p_voucher_id uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.vouchers where id = p_voucher_id and company_id = p_company_id
  ) then
    raise exception 'That voucher does not belong to this company';
  end if;

  update public.orders
     set fulfilled_voucher_id = p_voucher_id
   where id = p_order_id and company_id = p_company_id;
end;
$$;

revoke execute on function public.mark_order_converted(uuid, uuid, uuid) from anon;

comment on function public.mark_order_converted is
  'Points an order at whichever voucher actually fulfilled it. Does not require the order to be in any particular status, and does not itself change status — the two are separate facts, recorded independently.';


-- ----------------------------------------------------------------------------
-- get_orders(company, order_type, status_filter)
-- ----------------------------------------------------------------------------
create or replace function public.get_orders(
  p_company_id uuid,
  p_order_type text default null,
  p_status_filter text default null
) returns table (
  id uuid,
  order_type text,
  order_reference text,
  order_date date,
  expected_date date,
  party_name text,
  notes text,
  status text,
  fulfilled_voucher_id uuid,
  fulfilled_voucher_number text,
  fulfilled_note text,
  total_amount numeric,
  item_count integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    o.id, o.order_type, o.order_reference, o.order_date, o.expected_date,
    l.name, o.notes, o.status, o.fulfilled_voucher_id, v.voucher_number, o.fulfilled_note,
    coalesce((select sum(oi.amount) from public.order_items oi where oi.order_id = o.id), 0),
    coalesce((select count(*) from public.order_items oi where oi.order_id = o.id), 0)::integer
    from public.orders o
    left join public.ledgers l on l.id = o.party_ledger_id
    left join public.vouchers v on v.id = o.fulfilled_voucher_id
   where o.company_id = p_company_id
     and (p_order_type is null or o.order_type = p_order_type)
     and (p_status_filter is null or o.status = p_status_filter)
   order by (o.status in ('draft','confirmed')) desc, o.order_date desc;
$$;

comment on function public.get_orders is
  'Orders for a company with their party name, totalled from order_items, and the fulfilling voucher''s number when linked. Open orders (draft/confirmed) sort first.';
