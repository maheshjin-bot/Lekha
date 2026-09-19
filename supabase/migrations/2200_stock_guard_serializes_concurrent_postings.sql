-- ============================================================================
-- 2200 — the stock-availability guard (2090) has no protection against two
--        people posting against the same item at the same moment
-- ============================================================================
-- 2090 added a real, working guard to create_invoice and create_production_
-- voucher: read the item's current stock, and refuse a line that would take
-- it newly negative. Adversarial verification of that fix found a genuine
-- concurrency hole, reproduced live with figures rather than assumed: the
-- CHECK (a plain SELECT through get_stock_summary) and the ACT (the INSERT
-- into voucher_items) are two separate statements with nothing serializing
-- them, so under Postgres's default READ COMMITTED isolation two concurrent
-- transactions each see the SAME pre-posting balance and can BOTH pass.
--
-- Proved: Precision Shaft SH-100 at 745.000 on hand. Two concurrent
-- create_invoice calls for 600 units each — each individually well under
-- 745, so each one's own check correctly passes — both committed, leaving
-- the item at -455.000 with neither call ever raising. This is not a
-- contrived edge case for this app: the pilot this guard was built for ran
-- with FOUR concurrent preparers, which is exactly the condition that
-- defeats an unlocked check-then-write.
--
-- THE FIX. This codebase already has a working pattern for exactly this
-- class of problem — app_private.next_voucher_number hands out voucher
-- numbers race-free via an atomic INSERT ... ON CONFLICT DO UPDATE ...
-- RETURNING. Stock is not a single counter row that pattern fits directly
-- (a balance is a SUM over however many voucher_items rows an item has), so
-- the equivalent here is a session-scoped advisory lock, keyed per
-- (company, item), held for the rest of the transaction: whichever posting
-- reaches the lock first does its whole check-then-write with nobody else
-- able to read a stock figure for that item until it commits or rolls back.
--
-- TAKEN UNCONDITIONALLY, even when p_allow_negative_stock is true for THIS
-- call — a business that has opted itself out of the check must still hold
-- the lock while it writes, or a DIFFERENT, GUARDED concurrent call reading
-- the same item at the same moment sees a stale, not-yet-committed balance
-- and passes a check it should have failed. The lock protects every other
-- caller, not just the one taking it.
--
-- ALWAYS ACQUIRED IN ASCENDING ITEM_ID ORDER, and this is not a style
-- preference — it is what stops a sale and a production run that happen to
-- share two components from deadlocking each other by locking them in
-- different orders. Every caller of app_private.lock_items_for_stock_write
-- must keep using it (or the same ordering rule) rather than locking
-- item-by-item in whatever order a loop happens to visit them.
--
-- WHY session-scoped and NOT `select ... for update` on the item row: there
-- is no single "the item's stock" row to lock — get_stock_summary derives a
-- balance from every voucher_items row for that item, across every
-- godown, and none of them is a natural row to hold a lock on for the
-- purpose. An advisory lock keyed on the item id is a lock on the FACT
-- "who may currently be deciding this item's balance", which is exactly
-- what needs serializing.
-- ============================================================================

create or replace function app_private.lock_items_for_stock_write(
  p_company_id uuid,
  p_item_ids uuid[]
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_item_id uuid;
begin
  -- p_item_ids is expected pre-sorted (ascending) by every caller, so this
  -- loop simply acquires in the order it was handed rather than re-sorting
  -- — callers that build the array via `order by 1` already guarantee it.
  foreach v_item_id in array coalesce(p_item_ids, array[]::uuid[])
  loop
    -- One bigint key per (company, item): the two UUIDs concatenated,
    -- hashed with md5, and the first 16 hex characters read back as a
    -- signed 64-bit integer. pg_advisory_xact_lock takes exactly one
    -- bigint; this is the standard way to fold two UUIDs into one without
    -- a realistic collision risk for this table's actual row count.
    -- Company-scoped (not item id alone) so two DIFFERENT companies can
    -- never contend over what merely looks like the same lock number.
    perform pg_advisory_xact_lock(
      ('x' || substr(md5(p_company_id::text || ':' || v_item_id::text), 1, 16))::bit(64)::bigint
    );
  end loop;
end;
$$;

revoke all on function app_private.lock_items_for_stock_write(uuid, uuid[]) from public, anon;
grant execute on function app_private.lock_items_for_stock_write(uuid, uuid[]) to authenticated;

comment on function app_private.lock_items_for_stock_write(uuid, uuid[]) is
  'Serializes concurrent postings against the same item(s) so the 2090 stock guard cannot be defeated by a check-then-write race. Session-scoped advisory locks (pg_advisory_xact_lock, auto-released at commit/rollback), one per (company, item), keyed by hashing the two ids together. Callers must pass ids already sorted ascending and must acquire UNCONDITIONALLY — even a caller that itself opts out of the guard (p_allow_negative_stock) must still hold this lock while it writes, so a different, guarded concurrent caller cannot read a stale balance. See 2200.';

-- ----------------------------------------------------------------------------
-- create_invoice: lock every stock-tracked item this invoice touches on the
-- OUT side, before the existing 2090 guard reads a balance for any of them.
-- Read live, patched by targeted replace, asserted below — every other line
-- of this function (GST, RCM, TCS, landed cost, numbering) is untouched.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_from constant text := $marker$  if v_direction = 'out' and not p_allow_negative_stock then
    for v_guard_item_id, v_guard_item_name, v_guard_uom, v_guard_requested, v_guard_available in$marker$;
  v_to constant text := $marker$  if v_direction = 'out' then
    -- 2200: taken UNCONDITIONALLY (ahead of the p_allow_negative_stock
    -- check below) -- see this migration's header for why an opted-out
    -- caller must still hold the lock while it writes.
    perform app_private.lock_items_for_stock_write(
      p_company_id,
      array(
        select distinct i.id
          from jsonb_array_elements(p_items) elem
          join public.items i
            on i.id = (elem->>'item_id')::uuid
           and i.item_type = 'goods' and i.maintain_stock
         order by 1
      )
    );
  end if;

  if v_direction = 'out' and not p_allow_negative_stock then
    for v_guard_item_id, v_guard_item_name, v_guard_uom, v_guard_requested, v_guard_available in$marker$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_invoice' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '2200: public.create_invoice is missing.';
  end if;

  if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
    raise exception '2200: create_invoice''s 2090 guard opening has moved or already changed; fix by hand.';
  end if;

  execute replace(v_def, v_from, v_to);
end;
$mig$;

revoke all on function public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  bpchar, bpchar, numeric, text, text, uuid, text, date, boolean) from public, anon;
grant execute on function public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  bpchar, bpchar, numeric, text, text, uuid, text, date, boolean) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- create_production_voucher: lock every stock-tracked component up front, in
-- the SAME ascending item_id order create_invoice uses, before the
-- per-component loop reads or checks anything -- a shared raw material must
-- lock the same way from either function or the two could deadlock each
-- other.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_from constant text := $marker$  select id, output_item_id, yield_quantity into v_bom
    from public.bill_of_materials
   where id = p_bom_id and company_id = p_company_id and is_active;

  if v_bom.id is null then
    raise exception 'BOM % does not exist (or is inactive) in this company', p_bom_id;
  end if;

  v_scale := p_quantity_produced / v_bom.yield_quantity;$marker$;
  v_to constant text := $marker$  select id, output_item_id, yield_quantity into v_bom
    from public.bill_of_materials
   where id = p_bom_id and company_id = p_company_id and is_active;

  if v_bom.id is null then
    raise exception 'BOM % does not exist (or is inactive) in this company', p_bom_id;
  end if;

  -- 2200: locked UNCONDITIONALLY, before any component is checked or
  -- written, in the same ascending item_id order create_invoice uses -- see
  -- that function and this migration's header.
  perform app_private.lock_items_for_stock_write(
    p_company_id,
    array(
      select distinct i.id
        from public.bom_components bc
        join public.items i on i.id = bc.component_item_id
       where bc.bom_id = p_bom_id
         and i.item_type = 'goods' and i.maintain_stock
       order by 1
    )
  );

  v_scale := p_quantity_produced / v_bom.yield_quantity;$marker$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_production_voucher' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '2200: public.create_production_voucher is missing.';
  end if;

  if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
    raise exception '2200: create_production_voucher''s BOM-fetch block has moved or already changed; fix by hand.';
  end if;

  execute replace(v_def, v_from, v_to);
end;
$mig$;

revoke all on function public.create_production_voucher(
  uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text, boolean, uuid) from public, anon;
grant execute on function public.create_production_voucher(
  uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text, boolean, uuid) to authenticated, service_role;

comment on function public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  bpchar, bpchar, numeric, text, text, uuid, text, date, boolean) is
  'Posts an invoice (sales/purchase/credit_note/debit_note) with its items, GST, RCM, TCS and landed cost. The 2090 stock-availability guard now serializes against concurrent postings on the same item via app_private.lock_items_for_stock_write before it trusts a balance (2200) -- p_allow_negative_stock still opts a caller out of the CHECK, never out of the LOCK.';

comment on function public.create_production_voucher(
  uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text, boolean, uuid) is
  'Posts one production run: consumes a BOM''s components at their current average rate and brings the output(s) into stock, sharing joint cost across by-products/scrap/co-products per Ind AS 2. The 2090 stock-availability guard on each component now serializes against concurrent postings via app_private.lock_items_for_stock_write before it trusts a balance (2200), in the same item-id order create_invoice uses so the two can never deadlock each other over a shared raw material.';
