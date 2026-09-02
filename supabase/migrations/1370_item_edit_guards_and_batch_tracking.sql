-- ============================================================================
-- 1370 — items.batch_tracking had no write path at all, and items were
--        create-only: two halves of one gap in the item master
-- ============================================================================
-- CONFIRMED, before writing a line of fix:
--
--   A. items.batch_tracking (0067:29, default 'none') is READ in five places
--      and WRITTEN in none. /batches filters `.neq("batch_tracking","none")`,
--      so that screen, Reports → Stock expiry and the batch half of
--      /stock-verification are all permanently empty for any company that
--      did not have the column set by hand in SQL. BatchManager.tsx:178 tells
--      the user "Open an item under Items and set its Batch tracking field",
--      upsert_item_batch (0067:162) raises "This item is not set up for
--      batch/serial tracking (Items → batch_tracking)" and
--      record_stock_verification (0165:357) raises the same — three messages
--      naming a field that no screen has ever offered. The batch_serial
--      module can be switched on and add a nav entry to a screen that cannot
--      work.
--
--   B. ItemManager.tsx is insert-only. A wrong hsn_sac, gst_rate_percent or
--      opening_value is permanent, and items.is_active (0013:65) is rendered
--      in the list but never written, so a junk item pollutes every item
--      picker in the app forever.
--
-- THE SHAPE. items_write (0013:256) is already `for all to authenticated`
-- using can_write_company, so the edit itself needs no RPC — the UI updates
-- public.items directly, the way ItemUomPanel already updates
-- item_uom_conversions and CaptureReviewForm already updates items.hsn_sac.
-- What DOES need to live in the database is the small set of changes that are
-- not safe, and those go in a BEFORE UPDATE TRIGGER rather than an RPC on
-- purpose: an RPC only guards its own caller, and there are at least three
-- other write paths into this table today (the CSV item importer, the capture
-- review screen's hsn_sac update, and any future one). A guard that a plain
-- .update() can walk around is not a guard. Same reasoning, and same shape,
-- as protect_ledger_financial_fields (0006/0755) — which is a trigger for
-- exactly this reason and is the direct precedent for the opening-balance
-- half of this problem.
--
-- ---------------------------------------------------------------------------
-- FIELD BY FIELD. Every one of items' 26 columns, surveyed before deciding.
-- ---------------------------------------------------------------------------
--   id, company_id            Identity. Never editable.
--
--   created_by, created_at,
--   updated_at                Managed (set_updated_at trigger, 0013:86).
--
--   name, code, category,
--   sale_rate, purchase_rate,
--   reorder_level             ALWAYS EDITABLE. Nothing downstream reads them
--                             as history: name/code are labels (unique
--                             case-insensitively per company, 0013:81-82),
--                             the two rates are prefill defaults on the
--                             invoice forms, reorder_level is a reporting
--                             threshold. No guard.
--
--   hsn_sac                   ALWAYS EDITABLE — the headline of defect B.
--                             Safe BY CONSTRUCTION, not by luck:
--                             voucher_items.hsn_sac is denormalised at entry
--                             ("so an HSN summary need not trust that the
--                             item master still says what it said at invoice
--                             time", 0013:149), and both consumers read the
--                             denormalised copy — get_gstr1_hsn_summary
--                             (0051) and build_einvoice_json (0230:579,
--                             'HsnCd'). So correcting an HSN fixes every
--                             FUTURE invoice and leaves already-issued
--                             invoices printing what they printed. An
--                             already-issued invoice with a wrong HSN is
--                             corrected through update_invoice (0055:203),
--                             which re-reads the item master — deliberately
--                             not back-filled from here, because silently
--                             rewriting the HSN on an invoice the buyer
--                             already holds is a worse error than the one
--                             being fixed.
--
--   gst_rate_percent,
--   cess_rate_percent,
--   supply_nature,
--   itc_eligibility,
--   itc_blocked_clause,
--   default_tcs_section,
--   is_rcm_applicable         EDITABLE, no guard — and stated plainly rather
--                             than assumed: the rate on the item master is a
--                             DEFAULT FOR FUTURE INVOICES, not a record of
--                             tax charged. Tax already posted lives in
--                             voucher_entries and does not move;
--                             get_gstr1_hsn_summary (0051:26-36) explicitly
--                             allocates each voucher's ACTUAL posted
--                             CGST/SGST/IGST rather than recomputing from
--                             today's item rate, for this exact reason, and
--                             build_einvoice_json (0230) does the same.
--                             A hard guard would be wrong: GST rates change
--                             by notification, and refusing the edit would
--                             leave the master permanently wrong for every
--                             future sale.
--                             ONE HONEST EXCEPTION, not hidden: GSTR-1
--                             Table 12's rate split (get_gstr1_table12,
--                             0098) DOES read i.gst_rate_percent from
--                             today's item master — its own header says so
--                             (0098:89) because the schema stores no
--                             per-line rate. Changing the rate therefore
--                             does move rows between rate buckets in that
--                             one report, retrospectively. The form says so
--                             in as many words when the item has been
--                             invoiced; the fix for that gap is a per-line
--                             rate column, which is 0098's own noted future
--                             work, not this migration's.
--
--   is_active                 EDITABLE, no guard — the second half of defect
--                             B, and verified reachable-and-harmless before
--                             enabling it. Every item picker in the app
--                             already filters .eq("is_active", true):
--                             /invoices/new, /invoices/[id]/edit, /pos,
--                             /orders, /job-work, /manufacturing,
--                             /delivery-challans, /price-lists, /capture,
--                             /stock-verification and the CSV invoice
--                             importer. Nothing that POSTS filters it —
--                             voucher_items' FK is to items(id, company_id)
--                             with no is_active predicate, and
--                             enforce_stock_item (0013:169) checks only
--                             item_type/maintain_stock — so an inactive item
--                             keeps its whole history, keeps its stock
--                             valuation in get_stock_summary (0013/0074,
--                             which does NOT filter is_active) and keeps
--                             appearing on the balance sheet through
--                             post_closing_stock (0076). That combination is
--                             the correct one: hidden from new entry, still
--                             present in the books.
--                             KNOWN CONSEQUENCE, surfaced in the form rather
--                             than guarded here: /stock-verification's own
--                             item picker filters is_active, so deactivating
--                             an item that still has stock on hand drops it
--                             off the physical count sheet while the books
--                             still carry it. The form shows the on-hand
--                             quantity at the moment of deactivation for
--                             precisely that reason. Blocking deactivation
--                             of an item with stock would be wrong — a
--                             discontinued line you still hold stock of is a
--                             real and normal state.
--
--   opening_quantity,
--   opening_value             ADMIN ONLY. This is the item analogue of a
--                             ledger's opening balance, and it is treated the
--                             same way its analogue is: protect_ledger_
--                             financial_fields (0006, extended by 0755:257)
--                             does not forbid changing an opening balance, it
--                             restricts it to app_private.is_company_admin.
--                             Same gate here, for consistency — a wrong
--                             opening is a real thing that has to be
--                             fixable, and 0755's whole premise is that the
--                             fix belongs to an admin.
--                             WHAT A LATE EDIT ACTUALLY DOES, checked rather
--                             than guessed: get_stock_summary (0013:230,
--                             0074:119) adds opening_quantity/opening_value
--                             to every movement total with NO date predicate
--                             on the opening term, and get_stock_ageing
--                             (0165:557) injects opening_quantity as a
--                             synthetic FIFO layer dated 1900-01-01,
--                             "always-in-scope regardless of godown filter".
--                             So an edit here rewrites the stock summary and
--                             the ageing at EVERY past date, including closed
--                             periods. It does not unbalance the books:
--                             post_closing_stock (0076) posts only the
--                             DIFFERENCE between the valuation and what the
--                             stock ledger already carries, so the next run
--                             brings the balance sheet back into step by
--                             itself. Deliberately NOT blocked on
--                             companies.lock_date: protect_ledger_financial_
--                             fields does not block a ledger's opening
--                             balance after a lock either, and being stricter
--                             for stock than for cash would mean any company
--                             that has ever closed a period keeps defect B
--                             forever. The form states the consequence and
--                             points at post_closing_stock.
--
--   uom                       LOCKED ONCE TRANSACTED (trigger below).
--                             voucher_items carries its own uom per line and
--                             get_stock_summary sums vi.quantity while
--                             LABELLING the total with i.uom — so changing
--                             the base unit from KGS to GMS after movements
--                             exist relabels 100 kilos as 100 grams and is
--                             silently wrong by a factor of 1000, on the
--                             stock summary, the bank stock statement
--                             (0034/0050) and GSTR-1 Table 12's UQC. Also
--                             locked once item_uom_conversions rows exist:
--                             every conversion_factor is expressed against
--                             the base unit (0121), so moving the base makes
--                             all of them lie. Freely editable before either
--                             exists, which is when a typo actually gets
--                             noticed.
--
--   item_type, maintain_stock LOCKED ONCE TRANSACTED (trigger below), and
--                             deliberately not offered by the edit form at
--                             all. get_stock_summary, get_stock_ageing and
--                             the FIFO engine (0185) all filter
--                             `item_type = 'goods' and maintain_stock`, so
--                             flipping a transacted goods item to a service
--                             makes its entire stock history — and its share
--                             of closing stock on the balance sheet —
--                             silently vanish, while its voucher_items lines
--                             stay behind (enforce_stock_item, 0013:184,
--                             fires only on insert or update OF item_id, so
--                             it never re-checks them). The trigger closes
--                             that hole for every write path; the form's
--                             answer to "I created this item as the wrong
--                             kind" is to deactivate it and create the right
--                             one, which is exactly what is_active now makes
--                             possible.
--
--   batch_tracking            EDITABLE, WITH TWO GUARDS — defect A. See the
--                             block below.
--
-- ---------------------------------------------------------------------------
-- batch_tracking: which flips are safe, and why the unsafe ones are refused
-- ---------------------------------------------------------------------------
-- 0067 read in full first, including the 409-on-reallocation bug its own
-- header records, before deciding any of this.
--
--   'none' -> 'batch' / 'serial'   ALLOWED FREELY, including for an item that
--     already has un-batched stock. This is not a loophole, it is 0067's
--     entire design: incoming stock is "tagged with a batch AFTER the fact,
--     on a new /batches workbench" (0067:3), and get_unallocated_stock_lines
--     is "the direct, honest answer to what hasn't been batch-tagged yet —
--     the UI must show it, never hide it" (0067:22). Turning tracking on
--     therefore does not corrupt anything; it moves every existing stock line
--     on the item into that work queue, which is the correct and only
--     possible starting state. A guard here would make the feature
--     unreachable for every item that has ever traded, i.e. all of them.
--     The form tells the user how many lines will land in the queue, so
--     "turn it on" is never a silent action.
--
--   'batch' -> 'serial'   REFUSED if any existing allocation for the item has
--     quantity <> 1. enforce_batch_allocation (0067:164) forces quantity = 1
--     for serial-tracked items, but it only fires on INSERT OR UPDATE of
--     voucher_item_batches — it never re-validates rows that already exist.
--     Flipping the flag would therefore leave "serial numbers" carrying 20
--     units each, and tests/db/invariants.test.ts:919 asserts exactly that
--     cannot happen. Refused with the count, so the user knows what to undo.
--     'serial' -> 'batch' is the relaxing direction and is allowed freely.
--
--   'batch' / 'serial' -> 'none'   REFUSED if the item has ANY allocation.
--     Nothing cascades or cleans up: item_batches and voucher_item_batches
--     rows survive untouched, but get_unallocated_stock_lines (0067:326)
--     filters batch_tracking <> 'none' and so silently empties, while
--     get_batch_stock_summary does NOT filter it and keeps returning
--     balances — a half-dead state where Reports → Stock expiry stops
--     covering stock that is still physically on the shelf and can still
--     expire. For a pharma or food business that silence is the whole point
--     of the feature failing. Refused with the allocation count and the
--     on-hand quantity. Turning it off IS allowed when only unused
--     item_batches master rows exist (nothing is stranded: those are just
--     labels, and get_batch_stock_summary already filters them out with
--     `where qty_in <> 0 or qty_out <> 0`).
--
--   Turning tracking on for a service or a non-stock item is already
--   impossible — items_batch_tracking_needs_stock (0067:33). Not re-checked
--   here; the form maps that constraint to a plain-English message instead.
--
-- ---------------------------------------------------------------------------
-- NOT DONE HERE, deliberately
-- ---------------------------------------------------------------------------
--   * No item DELETE path. voucher_items, boms, price_list_items,
--     item_uom_conversions, item_batches and recurring voucher templates all
--     reference items; deactivation is the correct answer for a master record
--     that has been used, and is what this migration makes possible.
--   * No audit-trail trigger on public.items. items carries none today (only
--     set_updated_at), which is a real and separate gap — adding change
--     capture to a master table is its own slice with its own retention
--     question, not a rider on a form fix.
--   * No back-fill of corrected hsn_sac / gst_rate_percent onto existing
--     voucher_items. See hsn_sac above.
--   * No per-line gst_rate_percent column. That is 0098's own noted future
--     work and would touch create_invoice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The guard
-- ----------------------------------------------------------------------------
create or replace function app_private.protect_item_master_fields()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_lines bigint;
  v_conversions bigint;
  v_allocations bigint;
  v_non_unit bigint;
  v_allocated_qty numeric;
begin
  -- Cascade guard, same shape as protect_system_group (0006) and
  -- enforce_opening_balance_equity (0755:190): once the parent company row is
  -- gone there is nothing left to protect, and raising here would only block
  -- the ON DELETE CASCADE already tearing this company down.
  if not exists (select 1 from public.companies where id = new.company_id) then
    return new;
  end if;

  -- Opening quantity / value — the ledger opening-balance analogue, gated the
  -- same way protect_ledger_financial_fields gates its own.
  if new.opening_quantity is distinct from old.opening_quantity
     or new.opening_value is distinct from old.opening_value then
    if not app_private.is_company_admin(new.company_id) then
      raise exception 'Only an admin can change an item''s opening quantity or opening value — it is this item''s share of the balance sheet on day one, the same as a ledger''s opening balance.';
    end if;
  end if;

  -- Base unit of measure. Counted across ALL voucher_items lines, including
  -- lines on soft-deleted vouchers: a line's stored uom is a permanent record
  -- of what was recorded, and the audit trail still shows deleted vouchers.
  -- Being conservative costs the user nothing (deactivate and re-create);
  -- being permissive risks relabelling kilos as grams.
  if new.uom is distinct from old.uom then
    select count(*) into v_lines
      from public.voucher_items where item_id = new.id;
    if v_lines > 0 then
      raise exception 'Cannot change the unit of "%" from % to %: % stock line(s) already recorded quantities in %, and changing the base unit would relabel them all without converting them. Deactivate this item and create a new one in %.',
        new.name, old.uom, new.uom, v_lines, old.uom, new.uom;
    end if;

    select count(*) into v_conversions
      from public.item_uom_conversions where item_id = new.id;
    if v_conversions > 0 then
      raise exception 'Cannot change the unit of "%" from % to %: % alternate-unit conversion(s) are expressed against % and would all become wrong. Remove them first.',
        new.name, old.uom, new.uom, v_conversions, old.uom;
    end if;
  end if;

  -- Goods/service and stock-maintenance. Not offered by the edit form at all;
  -- guarded here so no write path can erase a transacted item's stock history
  -- from the stock summary and the balance sheet.
  if new.item_type is distinct from old.item_type
     or new.maintain_stock is distinct from old.maintain_stock then
    select count(*) into v_lines
      from public.voucher_items where item_id = new.id;
    if v_lines > 0 then
      raise exception 'Cannot change whether "%" is goods or holds stock: % stock line(s) already exist, and every stock report filters on those two fields — the item''s whole history would disappear from the stock summary and from closing stock on the balance sheet while its lines stayed behind. Deactivate this item and create a new one instead.',
        new.name, v_lines;
    end if;
  end if;

  -- Batch / serial / expiry tracking.
  if new.batch_tracking is distinct from old.batch_tracking then
    select count(*),
           count(*) filter (where vib.quantity <> 1),
           coalesce(sum(vib.quantity), 0)
      into v_allocations, v_non_unit, v_allocated_qty
      from public.voucher_item_batches vib
      join public.item_batches b on b.id = vib.batch_id
     where b.item_id = new.id;

    if new.batch_tracking = 'none' and v_allocations > 0 then
      raise exception 'Cannot turn batch/serial tracking off for "%": % stock line allocation(s) covering % % are already recorded against its batches. Turning it off strands them — the batch work queue would empty while Reports → Stock expiry kept reporting balances that can no longer be added to. Remove the allocations under Batches first if this item really should not be tracked.',
        new.name, v_allocations, v_allocated_qty, new.uom;
    end if;

    if new.batch_tracking = 'serial' and v_non_unit > 0 then
      raise exception 'Cannot switch "%" to serial tracking: % existing allocation(s) cover more than one unit each, and a serial number is one physical unit (quantity = 1). Re-allocate those lines one unit at a time under Batches first, or keep this item on batch tracking.',
        new.name, v_non_unit;
    end if;
  end if;

  return new;
end;
$$;

comment on function app_private.protect_item_master_fields is
  'BEFORE UPDATE guard on public.items, the item-master counterpart of protect_ledger_financial_fields (0006/0755). Admin-gates opening_quantity/opening_value; locks uom once any stock line or alternate-unit conversion exists; locks item_type/maintain_stock once any stock line exists; refuses the two unsafe batch_tracking flips (off with live allocations, and batch->serial with multi-unit allocations). A trigger rather than an RPC because items_write (0013) lets any authenticated writer .update() this table directly from at least three existing code paths. See migration 1370 for the full field-by-field survey.';

-- Idempotent so the whole file can be re-applied while it is still being
-- iterated on, the way every function in it already can be.
drop trigger if exists protect_item_master_fields on public.items;

create trigger protect_item_master_fields
  before update on public.items
  for each row execute function app_private.protect_item_master_fields();

-- ----------------------------------------------------------------------------
-- What the edit form needs to know before it offers a field
-- ----------------------------------------------------------------------------
-- One read per company instead of four PostgREST round trips plus client-side
-- grouping, and — more importantly — SECURITY DEFINER on purpose. Every
-- question here ("has this item ever moved?", "is any allocation multi-unit?")
-- is inherently company-wide, and voucher_items_read (0013:270) is
-- branch-scoped: answered through a branch-restricted member's own view, the
-- counts would come back low and the form would offer a field the trigger is
-- about to refuse. Row counts and an on-hand quantity, no amounts, gated on
-- is_company_member.
--
-- stock_line_count counts ALL voucher_items rows, matching the trigger's own
-- lock test exactly so the form and the database can never disagree.
--
-- closing_quantity is READ FROM get_stock_summary rather than re-derived here,
-- and that is not a stylistic choice — the first draft of this function did
-- re-derive it as opening + in - out, and hand-checking it against
-- get_stock_summary on live data found it 500 PAC high on one real item. The
-- reason: a Rule 55 delivery challan MOVES goods without disposing of them
-- (ownership stays with the sender until a tax invoice is raised), so
-- get_stock_summary excludes voucher_type = 'delivery_challan_out' from
-- movements, and a naive re-derivation relieves the same goods twice — once on
-- the challan and again on the invoice that follows it. Understating on-hand
-- stock is the dangerous direction for the one warning this figure drives
-- ("this item still holds stock, deactivating it drops it off the physical
-- count sheet"), so this reads the app's single stock-valuation function
-- instead of keeping a second copy of its rules in step by hand.
-- get_stock_summary is SECURITY INVOKER; called from inside this SECURITY
-- DEFINER function it runs as the owner, which is what gives the company-wide
-- answer a master-data decision needs. As at current_date, the same default
-- every other stock screen uses, so the figure the form quotes is the figure
-- the user can go and check on Reports → Stock summary.
--
-- unallocated_line_count deliberately keeps its own derivation, matching
-- get_unallocated_stock_lines (0067) predicate for predicate EXCEPT for that
-- function's `i.batch_tracking <> 'none'` filter — the whole point of this
-- number is to answer "how many lines land in the Batches queue IF I turn
-- tracking on", which the real function cannot answer for an untracked item.
-- Soft-deleted vouchers excluded, exactly as there.
create or replace function public.get_item_edit_context(p_company_id uuid)
returns table (
  item_id uuid,
  stock_line_count bigint,
  uom_conversion_count bigint,
  batch_master_count bigint,
  batch_allocation_count bigint,
  non_unit_allocation_count bigint,
  unallocated_line_count bigint,
  closing_quantity numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app_private.is_company_member(p_company_id) then
    raise exception 'Not permitted to read this company''s items';
  end if;

  return query
  with all_lines as (
    select vi.item_id, count(*) as line_count
      from public.voucher_items vi
     where vi.company_id = p_company_id
     group by vi.item_id
  ),
  unallocated as (
    select
      vi.item_id,
      count(*) filter (
        where vi.quantity - coalesce(alloc.allocated, 0) > 0.0005
      ) as unallocated_count
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
      left join (
        select vib.voucher_item_id, sum(vib.quantity) as allocated
          from public.voucher_item_batches vib
         group by vib.voucher_item_id
      ) alloc on alloc.voucher_item_id = vi.id
     where vi.company_id = p_company_id
       and not v.is_deleted
     group by vi.item_id
  ),
  on_hand as (
    select s.item_id, s.closing_quantity
      from public.get_stock_summary(p_company_id, current_date, null) s
  ),
  conversions as (
    select c.item_id, count(*) as conversion_count
      from public.item_uom_conversions c
     where c.company_id = p_company_id
     group by c.item_id
  ),
  masters as (
    select b.item_id, count(*) as batch_count
      from public.item_batches b
     where b.company_id = p_company_id
     group by b.item_id
  ),
  allocations as (
    select
      b.item_id,
      count(*) as allocation_count,
      count(*) filter (where vib.quantity <> 1) as non_unit_count
      from public.voucher_item_batches vib
      join public.item_batches b on b.id = vib.batch_id
     where b.company_id = p_company_id
     group by b.item_id
  )
  select
    i.id,
    coalesce(al.line_count, 0),
    coalesce(cv.conversion_count, 0),
    coalesce(ms.batch_count, 0),
    coalesce(ac.allocation_count, 0),
    coalesce(ac.non_unit_count, 0),
    coalesce(un.unallocated_count, 0),
    coalesce(oh.closing_quantity, 0)
    from public.items i
    left join all_lines   al on al.item_id = i.id
    left join unallocated un on un.item_id = i.id
    left join conversions cv on cv.item_id = i.id
    left join masters     ms on ms.item_id = i.id
    left join allocations ac on ac.item_id = i.id
    left join on_hand     oh on oh.item_id = i.id
   where i.company_id = p_company_id;
end;
$$;

revoke all on function public.get_item_edit_context(uuid) from public, anon;
grant execute on function public.get_item_edit_context(uuid) to authenticated;

comment on function public.get_item_edit_context(uuid) is
  'Per-item counts the Items edit form needs before it offers a field: stock lines (all, including soft-deleted vouchers, matching protect_item_master_fields'' own lock test), alternate-unit conversions, batch master rows, batch allocations, multi-unit allocations, not-yet-allocated stock lines (matching get_unallocated_stock_lines except for its batch_tracking filter, so the count answers "what would queue IF tracking were turned on"), and on-hand quantity read straight from get_stock_summary rather than re-derived — a re-derivation double-relieved delivery-challan stock, caught by hand-checking against the real function on live data. SECURITY DEFINER on purpose — these are company-wide master-data questions and voucher_items_read is branch-scoped, so a branch-restricted member''s own view would answer them low and the form would offer a field the trigger then refuses. Gated on is_company_member.';

-- ----------------------------------------------------------------------------
-- The column comment 0067 wrote is now true
-- ----------------------------------------------------------------------------
comment on column public.items.batch_tracking is
  'Opt-in flag: none (default) = untracked, batch = quantities grouped under a batch/lot number, serial = one row per physical unit (quantity always 1). Only valid on stock-maintained goods (items_batch_tracking_needs_stock). Set from the Items screen; protect_item_master_fields (1370) refuses the two unsafe flips — off while allocations exist, and batch->serial while any allocation covers more than one unit.';
