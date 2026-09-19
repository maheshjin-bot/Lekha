-- app_private.enforce_batch_allocation (0067) only ever checked ONE
-- voucher_items line: that the allocations on THAT line never exceed that
-- line's own quantity. It never checked the batch's own running balance
-- across every other line, on every other voucher, that has ever drawn
-- from or fed it.
--
-- Reproduced live against real pilot data before this fix (TEST Precision
-- Engineering Pvt Ltd, item "Precision Shaft SH-100", batch SH100-030826):
-- that batch carried exactly 15.000 units on hand (30 in, 15 out). A
-- second, separate voucher line then allocated 20 units OUT of the same
-- batch. The same-line check passed it — the new line's own quantity was
-- comfortably >= 20 — and the insert succeeded, taking the batch to
-- quantity_on_hand = -5.000. Physically impossible: you cannot issue stock
-- a batch doesn't have.
--
-- THE FIX. Alongside the existing same-line total, also sum every OTHER
-- live allocation against this same batch_id — across all voucher_items
-- lines, across all vouchers — signed by each line's own direction ('in'
-- feeds the batch, 'out' draws it), and refuse if applying this row would
-- take that running total negative. This is a real, general aggregate
-- invariant, not time-ordered by voucher_date: Tally-style physical stock
-- ledgers do not require debits and credits to a lot to be entered in
-- strict chronological order, only that the ledger never goes negative
-- once everything entered so far is netted.
--
-- REVERSALS MUST NOT FALSE-POSITIVE. Traced how allocations are actually
-- removed today before writing this: delete_voucher (0052) is a pure
-- `update vouchers set is_deleted = true` — it never touches voucher_items
-- or voucher_item_batches, so a deleted voucher's old allocations are still
-- physically present as ROWS in voucher_item_batches. Excluding them by
-- joining to vouchers and filtering `not v.is_deleted` (exactly the filter
-- get_batch_stock_summary, 0067, already uses) is therefore required, not
-- optional, or deleting a voucher would never free up its batch quantity
-- and the very next legitimate re-allocation would be wrongly refused.
-- Separately, every update_invoice-style edit RPC (0055, 0087, 0102, 0147,
-- 0865, ...) does `delete from voucher_items where voucher_id = ...` before
-- re-inserting fresh lines with fresh ids; voucher_item_batches.voucher_item_id
-- has `on delete cascade`, so a full voucher edit physically removes the
-- old allocation rows outright, in the same transaction, before any new
-- allocation can be (re-)inserted — nothing to special-case there either.
-- The additive re-allocation path (allocate_voucher_item_to_batch's own
-- `on conflict (voucher_item_id, batch_id) do update`) is an UPDATE of the
-- SAME row, so `id is distinct from new.id` below already excludes its own
-- old value and compares against the row's fully-updated new quantity —
-- consistent with how the pre-existing same-line check already excludes it.
--
-- Not date-scoped, not scoped to this company only via a second lookup —
-- batch_id already keys item_batches, which is itself unique per company,
-- so summing by batch_id alone cannot cross a company boundary.

do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'enforce_batch_allocation' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '2180: app_private.enforce_batch_allocation is missing.';
  end if;

  v_before := v_def;

  v_def := replace(
    v_def,
    E'  return new;\nend;\n',
    E'  -- 2180: the same-line check above only guards ONE voucher_items row.\n' ||
    E'  -- Also check the batch''s own aggregate balance across every OTHER line\n' ||
    E'  -- that has ever drawn from or fed it (all vouchers, not just this one),\n' ||
    E'  -- excluding this row itself and excluding lines on soft-deleted\n' ||
    E'  -- vouchers (vouchers.is_deleted — see get_batch_stock_summary, 0067,\n' ||
    E'  -- which already treats a deleted voucher''s allocations as not physically\n' ||
    E'  -- real). direction=''in'' feeds the batch, ''out'' draws it.\n' ||
    E'  select coalesce(sum(\n' ||
    E'           case when vi.direction = ''in'' then vib.quantity else -vib.quantity end\n' ||
    E'         ), 0)\n' ||
    E'    into v_batch_balance\n' ||
    E'    from public.voucher_item_batches vib\n' ||
    E'    join public.voucher_items vi on vi.id = vib.voucher_item_id\n' ||
    E'    join public.vouchers v on v.id = vi.voucher_id\n' ||
    E'   where vib.batch_id = new.batch_id\n' ||
    E'     and vib.id is distinct from new.id\n' ||
    E'     and not v.is_deleted;\n\n' ||
    E'  v_projected := v_batch_balance\n' ||
    E'    + (case when v_line.direction = ''in'' then new.quantity else -new.quantity end);\n\n' ||
    E'  if v_projected < -0.0005 then\n' ||
    E'    raise exception\n' ||
    E'      ''Batch "%" has % on hand (all voucher lines combined) — allocating % more to this % line would take it to %, which is negative. Reduce the quantity, or allocate the shortfall from a different batch.'',\n' ||
    E'      v_batch.batch_no, v_batch_balance, new.quantity, v_line.direction, v_projected;\n' ||
    E'  end if;\n\n' ||
    E'  return new;\nend;\n'
  );

  if v_def = v_before then
    raise exception '2180: enforce_batch_allocation matched no insertion point; its body has moved. Fix by hand.';
  end if;

  -- The batch's own batch_no is now referenced in the new exception message,
  -- so the earlier `select ib.item_id, ib.company_id into v_batch` must also
  -- fetch batch_no, and the declare block needs the two new working variables.
  v_def := replace(
    v_def,
    'select ib.item_id, ib.company_id into v_batch',
    'select ib.item_id, ib.company_id, ib.batch_no into v_batch'
  );
  if v_def !~ 'ib\.batch_no into v_batch' then
    raise exception '2180: could not extend the item_batches lookup to fetch batch_no; body has moved. Fix by hand.';
  end if;

  v_def := replace(
    v_def,
    E'declare\n  v_line record;\n  v_batch record;\n  v_tracking text;\n  v_already_allocated numeric;\n',
    E'declare\n  v_line record;\n  v_batch record;\n  v_tracking text;\n  v_already_allocated numeric;\n  v_batch_balance numeric;\n  v_projected numeric;\n'
  );
  if v_def !~ 'v_batch_balance numeric' then
    raise exception '2180: could not add the new declare-block variables; body has moved. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

revoke all on function app_private.enforce_batch_allocation() from public, anon;
grant execute on function app_private.enforce_batch_allocation() to authenticated;

comment on function app_private.enforce_batch_allocation() is
  'BEFORE INSERT OR UPDATE trigger on voucher_item_batches. Guards two invariants: (1) the same-line total never exceeds that voucher_items line''s own quantity (0067), and (2) the batch''s own aggregate balance — every live allocation against this batch_id, across every voucher line and every voucher, signed by direction, excluding soft-deleted vouchers — never goes negative (2180). A company legitimately holding more than one stock-role ledger, or more than one batch per item, is unaffected: this check is scoped to a single batch_id, never to a ledger role.';
