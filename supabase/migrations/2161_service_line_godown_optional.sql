-- ============================================================================
-- 2160 — A pure-service line does not need a godown it will never use
-- ============================================================================
-- Filed as 2161: this cluster and 2160_gstr3b_rcm_itc_on_payment.sql were
-- assigned overlapping ranges by mistake and both independently picked 2160
-- as their filename. This file is the one renumbered — it was already
-- applied live (including its comment text below, which still says "2160")
-- before the collision was noticed, so only the filename moved; the prose
-- below intentionally still calls this fix "2160" to match what is actually
-- on the comments in the live database.
-- ============================================================================
-- WHY. voucher_items.godown_id has been NOT NULL since 0013, back when every
-- line moved stock. 1480 later taught the table to carry charge lines that
-- move no stock at all (freight, processing, installation — anything billed
-- on a sales/purchase/credit_note/debit_note that is not a stock-maintaining
-- goods item), and it stored exactly that fact per row as voucher_items.
-- moves_stock, derived from the item master by the app_private.
-- enforce_stock_item trigger. But 1480 deliberately left godown_id NOT NULL,
-- reasoning that naming the invoice's godown on a service line is "untidy
-- but harmless" since every company always has a default godown to hand.
--
-- REPRODUCED LIVE. A purchase of "GTA Freight Inward (RCM 5%)" (item
-- 8a69fb1e-1028-449c-95db-0f03eb76db44, item_type='service',
-- maintain_stock=false) against TEST Precision Engineering Pvt Ltd
-- (f2557c28-73ec-43a1-9769-d346e21548f6) from Swift Road Carriers (GTA),
-- with no godown supplied (p_godown_id = null), fails outright:
--
--   ERROR: 23502: null value in column "godown_id" of relation
--   "voucher_items" violates not-null constraint
--
-- create_invoice never asks the preparer for a per-line godown — it takes
-- one p_godown_id for the whole document and stamps it onto every line,
-- moves_stock or not (see its body, migration 0016 as amended). A screen
-- that correctly does not surface a godown field for an all-service
-- document (there is nothing to warehouse) therefore has nothing to pass,
-- and the very first service-only line hits this constraint. There is no
-- arbitrary warehouse a preparer can pick that means anything for freight;
-- the fix is to stop demanding one.
--
-- THE FIX. Not a widening of what may be null in general — only of what may
-- be null on a line that itself does not move stock, which is precisely the
-- fact moves_stock already records and app_private.enforce_stock_item
-- already keeps honest against the item master (a line cannot claim
-- moves_stock=false while sitting on a stock-maintaining goods item, and
-- cannot claim moves_stock=true while sitting on a service/non-stock item —
-- see 1480 section 2). So:
--
--   1. godown_id stops being unconditionally NOT NULL.
--   2. A CHECK constraint takes over the job for exactly the case it must
--      keep protecting: `moves_stock = false OR godown_id IS NOT NULL`.
--      A stock-moving line still cannot be saved without a godown, in any
--      function, on any voucher type, exactly as before. A non-stock line
--      may now be saved with or without one.
--
-- This is a pure schema change. create_invoice needs no edit: it already
-- passes the same p_godown_id (null or not) straight through to every line
-- regardless of moves_stock, and that is exactly right under the new rule —
-- a mixed invoice's service lines still happily inherit whatever real
-- godown was chosen for the document's goods lines (still "untidy but
-- harmless", per 1480), while an all-service document with no godown at
-- all now simply saves every line with godown_id null instead of failing.
-- update_invoice (0055) shares the identical insert shape into this same
-- table and is fixed by the same schema change with no edit of its own —
-- see "What I did not fix and why" in this session's report for the one
-- thing about it that is worth a follow-up look, not a change here.
--
-- Every non-billing stock document (branch_transfer, stock_journal,
-- job_work_out, job_work_in, delivery_challan_out, production, stock
-- verification) still only ever inserts moves_stock=true rows — 1480's
-- own trigger refuses moves_stock=false there — so this migration changes
-- nothing about them: the CHECK collapses to "godown_id IS NOT NULL" on
-- every one of those rows, identical to today.
-- ============================================================================

do $mig$
declare
  v_bad_count int;
begin
  -- Sanity check before loosening anything: every row that exists today was
  -- written while godown_id was NOT NULL, so none can already violate the
  -- new rule. Asserted rather than assumed.
  select count(*) into v_bad_count
    from public.voucher_items
   where godown_id is null;

  if v_bad_count <> 0 then
    raise exception 'Expected zero voucher_items rows with a null godown_id before this migration (godown_id has been NOT NULL since 0013); found %. Investigate before proceeding.', v_bad_count;
  end if;

  alter table public.voucher_items
    alter column godown_id drop not null;

  alter table public.voucher_items
    add constraint voucher_items_godown_required_for_stock
    check (not moves_stock or godown_id is not null);

  comment on constraint voucher_items_godown_required_for_stock on public.voucher_items is
    'A line that moves stock (moves_stock, 1480) must name the godown it moves in or out of, exactly as godown_id NOT NULL required unconditionally before 2160. A line that does not move stock — a freight, processing or other service charge on a sales/purchase/credit_note/debit_note — may now leave it null: there is no warehouse for a preparer to pick, and none is needed.';

  comment on column public.voucher_items.godown_id is
    'The godown a stock-moving line moves goods in or out of. NULL is allowed only when moves_stock is false (2160) — a charge line, e.g. freight or processing, that never touches inventory. Required and enforced by voucher_items_godown_required_for_stock whenever moves_stock is true.';
end;
$mig$;
