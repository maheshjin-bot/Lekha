-- ============================================================================
-- 2150 — get_stock_ageing never received 1451's own fix
-- ============================================================================
-- WHY. 1450 gave get_stock_summary, get_stock_summary_fifo, get_stock_fifo_layers
-- AND get_stock_ageing an identical item_home_godown CTE, each with the same
-- evidence query for "which godown did this item's opening stock come from":
-- the item's first-ever movement, bounded by v.voucher_date <= p_as_at. 1451
-- then found and fixed a real bug in that bound -- an item whose first-ever
-- movement happens to be dated AFTER the as-at being queried has no evidence
-- inside the window, falls through to "genuinely unplaceable", and vanishes
-- from every per-godown view while still showing in the company-wide total.
--
-- 1451's own fix loop was explicit: array['get_stock_summary',
-- 'get_stock_summary_fifo', 'get_stock_fifo_layers']. get_stock_ageing was
-- left out -- not because it does not share the bug (it shares the CTE
-- byte-for-byte, per 1450's own section 4) but simply because it was not in
-- the loop. Its live pg_get_functiondef still carries the old, unfixed bound
-- today.
--
-- REPRODUCED LIVE. TEST Precision Engineering (f2557c28-73ec-43a1-9769-
-- d346e21548f6), Alloy Steel Billet EN8, whose only movement is a purchase
-- into Raw Material Store (fcb27eee-bc78-41a0-9e5b-2067025c1c5b) dated
-- 2026-09-06. Querying "as at 2026-08-31" -- an entirely ordinary month-end
-- statement date, before that purchase -- filtered to Raw Material Store:
--   get_stock_summary  : 2,000.000 kg / Rs 1,90,000.00 (correct)
--   get_stock_ageing   : zero rows for this item (wrong -- should also be
--                        2,000.000, aged into the opening/1900-01-01 bucket)
--
-- THE FIX is exactly 1451's own fix, mirrored mechanically onto the one
-- function 1451's loop did not reach. Nothing else changes: the as-at bound
-- stays exactly where it is everywhere else in this function (the outflow
-- totals, the inward 'in' movements, the FIFO consumption walk) -- only the
-- home-godown EVIDENCE query stops being bounded by p_as_at, because opening
-- stock predates every movement by definition and the item's very first
-- movement, whenever it actually happened, is still the best evidence of
-- where the opening physically sat.
-- ============================================================================

do $mig$
declare
  v_def text;
  v_from constant text :=
'        where vi.company_id = p_company_id
           and not v.is_deleted
           and v.voucher_date <= p_as_at
           and vi.godown_id is not null';
  v_to constant text :=
'        where vi.company_id = p_company_id
           and not v.is_deleted
           -- 2150 (mirrors 1451): NOT bounded by p_as_at. Opening stock
           -- pre-dates every movement by definition, so the item''s very
           -- first movement -- whenever it actually happened -- is still the
           -- best evidence of where the opening sat, even when that first
           -- movement is dated AFTER the date being queried. Bounding this by
           -- p_as_at is what let the opening fall through to "unplaceable"
           -- and vanish from every per-godown view the moment "today" trails
           -- an item''s only recorded movement -- the ordinary case for a
           -- default-dated query, not an edge case.
           and vi.godown_id is not null';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_stock_ageing' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '2150: public.get_stock_ageing is missing.';
  end if;

  if v_def !~ 'item_home_godown' then
    raise exception '2150: public.get_stock_ageing has no item_home_godown CTE -- expected 1450''s body. Fix by hand.';
  end if;

  if position(v_to in v_def) > 0 then
    raise notice '2150: public.get_stock_ageing already carries the fix; no-op.';
    return;
  end if;

  if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
    raise exception '2150: public.get_stock_ageing''s item_home_godown evidence query has moved or already changed; fix by hand.';
  end if;

  execute replace(v_def, v_from, v_to);
end;
$mig$;

revoke all on function public.get_stock_ageing(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_ageing(uuid, date, uuid) to authenticated;

comment on function public.get_stock_ageing(uuid, date, uuid) is
  'FIFO ageing of on-hand stock into 0-30/31-60/61-90/91-180/181-365/over-365 day buckets, valued at get_stock_summary''s weighted-average rate. opening_quantity is a synthetic layer dated 1900-01-01, always consumed last. A Rule 55 delivery challan moves goods without disposing of them and is not demand against a FIFO layer (1450). In a godown-filtered view the opening layer is attributed to the godown the item was first recorded in -- using the item''s first-ever movement as evidence regardless of whether it falls before or after the as-at date being queried, since the opening pre-dates every movement by definition (2150, mirroring 1451) -- else to the company''s only godown, else to none (1450).';
