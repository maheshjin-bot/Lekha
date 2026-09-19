-- ============================================================================
-- 2122 — Historical correction: HOPUR26/0001 (TEST Precision Engineering)
--        capitalises its own freight line, same as every future invoice will
-- ============================================================================
-- 2121 fixes the CODE PATH for every purchase invoice entered from here on.
-- It does nothing for a purchase that was already posted before today under
-- the old code, on which a same-invoice freight line is still sitting only
-- in the trading ledger. HOPUR26/0001 (voucher
-- ea51825c-1ff7-4adf-bc2d-4c084e3f87ba, TEST Precision Engineering Pvt Ltd,
-- f2557c28-73ec-43a1-9769-d346e21548f6) is exactly that document -- the real
-- reproduction case this whole fix was written against -- and is corrected
-- here, by hand, the same way the Branches screen and update_ledger's own
-- data were recovered rather than left silently wrong (see this repo's build
-- log for both).
--
-- Verified live immediately before writing this file:
--   voucher_items ba16533a-35e9-4078-b71c-27126d61bcf2 -- "Inward Freight &
--   Handling Charges", item_type='service', moves_stock=false, amount=3000.00
--   -- is the ONLY charge line on this voucher, and
--   voucher_items 3ef17ca2-1715-4b0e-a9e4-8d3382044162 -- "MS Round Bar
--   25mm", moves_stock=true, direction='in', amount=126000.00 -- is the ONLY
--   stock line, so 100% of the freight belongs to it.
--
-- This does NOT hand-compute the correction. It sets is_landed_cost = true
-- on the one freight line and calls the exact same
-- app_private.apply_landed_cost_charge_lines that create_invoice and
-- update_invoice now call, so the historical fix and the future code path
-- are provably the same arithmetic, not two implementations that could
-- drift apart. Idempotent: the WHERE clause only ever matches while
-- is_landed_cost is still false, so re-running this file (a real risk in
-- this shared environment -- see 2121's header) is a no-op the second time,
-- and apply_landed_cost_charge_lines' own landed_cost_applied guard backstops
-- it a second way regardless.
-- ============================================================================

update public.voucher_items
   set is_landed_cost = true
 where id = 'ba16533a-35e9-4078-b71c-27126d61bcf2'
   and voucher_id = 'ea51825c-1ff7-4adf-bc2d-4c084e3f87ba'
   and company_id = 'f2557c28-73ec-43a1-9769-d346e21548f6'
   and not moves_stock
   and not is_landed_cost;

select app_private.apply_landed_cost_charge_lines('ea51825c-1ff7-4adf-bc2d-4c084e3f87ba'::uuid);

do $mig$
declare
  v_landed_cost_amount numeric;
  v_applied boolean;
begin
  select landed_cost_amount into v_landed_cost_amount
    from public.voucher_items
   where id = '3ef17ca2-1715-4b0e-a9e4-8d3382044162';

  select landed_cost_applied into v_applied
    from public.voucher_items
   where id = 'ba16533a-35e9-4078-b71c-27126d61bcf2';

  if v_landed_cost_amount is distinct from 3000.00 then
    raise exception '2122: expected MS Round Bar line on HOPUR26/0001 to carry landed_cost_amount = 3000.00 after the backfill, got %. Investigate before trusting this correction.', v_landed_cost_amount;
  end if;

  if v_applied is not true then
    raise exception '2122: expected the freight line on HOPUR26/0001 to be marked landed_cost_applied after the backfill. Investigate before trusting this correction.';
  end if;

  raise notice '2122: HOPUR26/0001 -- MS Round Bar landed_cost_amount is now %, freight line applied.', v_landed_cost_amount;
end;
$mig$;
