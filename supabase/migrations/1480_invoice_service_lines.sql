-- An invoice must be able to carry a service line.
--
-- WHY. The pilot hit this from both ends of the ledger in the same month, and
-- it is the largest dead end the run produced. voucher_items carries a BEFORE
-- INSERT trigger (app_private.enforce_stock_item, 0013) that refuses any item
-- which is not `item_type = 'goods' and maintain_stock`, and the constraint
-- items_service_has_no_stock guarantees a service can NEVER satisfy that. So
-- freight, processing, installation, or any other charge could not go on a
-- bill at all — not as a line, not at any value.
--
-- The workaround left was a voucher with NO item lines, and the pilot's own
-- books show exactly that, with the reason typed into the narration:
--
--   HO/PUR/2026-27/00008  "Freight line of supplier bill SAE/2026-27/1290 -
--                          could not go on the invoice, service item refused"
--       Freight Inward        Dr  4,500.00
--       Input IGST (27)       Dr    225.00
--          TEST Saurashtra Agro Exports  Cr  4,725.00
--
--   SAL/26-27/0009        "Grinding charges billed to Deccan Foods (service -
--                          not possible on the invoice screen)"
--       TEST Deccan Foods LLP   Dr 11,340.00
--          Grinding Charges Recovered  Cr 10,800.00
--          Output IGST (27)            Cr    540.00
--
-- Both post to the ledger correctly and both are INVISIBLE to the returns.
-- get_gst_input_register and get_gst_output_register take the taxable value
-- from sum(voucher_items.amount); with no item lines that sum is null, so the
-- registers reported these as
--
--   HO/PUR/2026-27/00008   taxable 0.00   IGST 225.00   invoice value    225.00
--   SAL/26-27/0009         taxable 0.00   IGST 540.00   invoice value    540.00
--
-- i.e. tax claimed and tax collected on a taxable value of nothing — a GSTR-1
-- and a GSTR-3B that will not reconcile against themselves. The purchase side
-- was worse still: one real supplier bill (SAE/2026-27/1290) had to be split
-- across HO/PUR/2026-27/00007 and 00008, so the single 2B line matched twice
-- and raised two false mismatch alarms.
--
-- THE LAW. Rule 46 CGST Rules describes a tax invoice line in terms that
-- already cover services, and distinguishes them only where it must:
--   (g) "Harmonised System of Nomenclature code for goods or services"
--   (h) "description of goods or services"
--   (i) "quantity in case of goods and unit or Unique Quantity Code thereof"
--   (k) "taxable value of the supply of goods or services or both taking into
--        account discount or abatement, if any"
-- So a service line legitimately carries a code (its SAC), a description, a
-- taxable value and a rate of tax; only the quantity/UQC is a goods-only
-- particular. Nothing in Rule 46 lets a charge be dropped off the invoice
-- and billed as a separate document, which is what LEKHA was forcing.
--
-- WHAT THIS DOES NOT DO. It does not remove the trigger. The trigger exists
-- for a good reason — a goods line that skipped stock would sell inventory
-- without depleting it, and the valuation would silently drift — so the rule
-- is WIDENED rather than dropped, and it is widened in three parts:
--
--   * a line that claims to move stock must be on a stock-maintaining
--     goods item (this is the original 0013 rule, unchanged);
--   * a line that claims to move no stock must NOT be on a stock-maintaining
--     goods item (this is new, and it is what stops the widening from
--     becoming a way to bill inventory without moving it); and
--   * a line that moves no stock is only allowed on a document that BILLS —
--     sales, purchase, credit_note, debit_note, which is exactly the set
--     create_invoice posts. On branch_transfer, stock_journal, job_work_out,
--     job_work_in and delivery_challan_out the old 0013 rule applies
--     unchanged, because those documents record physical movement and nothing
--     else, and none of create_delivery_challan, create_job_work_challan,
--     create_job_work_return or create_production_voucher filters item types
--     itself — every one of them leans on this trigger to do it. Without this
--     third part, widening the trigger for invoices would have quietly let a
--     freight line onto a Sec 143 job-work challan and from there into the
--     ITC-04 prep.
--
-- The representation is one new column, voucher_items.moves_stock. It ends up
-- with NO default (step 1 adds one purely to backfill, step 4 drops it): left
-- unstated by the caller, the trigger derives it from the item master, which
-- is the single source of truth for what an item is. That is what keeps every
-- OTHER writer of voucher_items
-- correct without being touched — update_invoice, create_delivery_challan,
-- create_job_work_challan, create_job_work_return, create_production_voucher
-- and record_stock_verification all continue to insert exactly the columns
-- they insert today and all continue to get exactly the value they should.
-- create_invoice needs no change at all for the same reason; the only reason
-- this migration mentions it is to restate what it now accepts.
--
-- Storing it rather than re-deriving it on every read follows the precedent
-- 0013 set for hsn_sac on the same table: what a line WAS at entry time is a
-- fact about the document, and must not change under it because someone later
-- edited the item master.
--
-- godown_id stays NOT NULL. A service line names the invoice's godown and
-- means nothing by it, which is untidy but harmless: every stock consumer
-- (get_stock_summary, get_stock_summary_fifo, get_stock_fifo_layers,
-- get_stock_ageing, get_quantitative_stock_details) drives off public.items
-- filtered to `item_type = 'goods' and maintain_stock` and left-joins the
-- movements, so a service line is not merely excluded from stock — it is
-- unreachable by it. Relaxing the column would have widened the read surface
-- of every one of those for no gain, since migration 0014 seeds a default
-- godown for every company and branch, so there is always one to name.

-- ----------------------------------------------------------------------------
-- 1. The representation
-- ----------------------------------------------------------------------------
-- Added WITH a default so the backfill is implicit and instantaneous (every
-- row that exists today is a stock line — the 0013 trigger admitted nothing
-- else) and so any insert racing this migration still lands on the old,
-- stricter behaviour. The default is dropped at step 4, once the trigger that
-- derives the value is in place.
alter table public.voucher_items
  add column if not exists moves_stock boolean not null default true;

comment on column public.voucher_items.moves_stock is
  'True on an ordinary stock line; false on a charge line — freight, processing, installation and the like — which carries HSN/SAC, rate, amount and GST but no inventory effect (1480). Omit it on insert and app_private.enforce_stock_item derives it from the item master; supply it and the same trigger checks it against the item master, in both directions.';

-- ----------------------------------------------------------------------------
-- 2. The widened rule
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_stock_item()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_name text;
  v_stockable boolean;
  v_voucher_type text;
begin
  select i.name, i.item_type = 'goods' and i.maintain_stock
    into v_name, v_stockable
    from public.items i where i.id = new.item_id;

  -- Both selected columns are NOT NULL on a row that exists, so a null here
  -- means no row at all. The composite FK makes that unreachable in practice;
  -- saying so plainly is cheaper than a null quietly reading as "not stock".
  if v_stockable is null then
    raise exception 'Item % is not on the item master, so it cannot appear on a voucher line', new.item_id;
  end if;

  select v.voucher_type into v_voucher_type
    from public.vouchers v where v.id = new.voucher_id;

  -- The caller said nothing, so the item master decides. This is the path
  -- every writer of voucher_items that predates this migration takes, and it
  -- gives each of them exactly what it got before for a stock item.
  if new.moves_stock is null then
    new.moves_stock := v_stockable;
  end if;

  -- A charge line belongs only on a document that bills. Checked before the
  -- other two so the preparer of a challan reads why their document cannot
  -- carry this, rather than a message about stock lines that would send them
  -- to change the item master. A null type is unreachable through the FK and
  -- is treated as the strict case on purpose.
  if not new.moves_stock
     and coalesce(v_voucher_type, '') not in ('sales', 'purchase', 'credit_note', 'debit_note') then
    raise exception '"%" does not maintain stock, so it cannot appear on a stock document (%). A delivery challan, job-work challan, branch transfer or stock journal records the physical movement of goods and nothing else — a charge like this belongs on the tax invoice or bill.',
      v_name, coalesce(v_voucher_type, 'unknown');
  end if;

  if new.moves_stock and not v_stockable then
    raise exception '"%" does not maintain stock, so it cannot be recorded as a stock line. On an invoice it can still be billed as a charge line, which carries its SAC, rate and GST but moves no inventory.', v_name;
  end if;

  -- The other half of the rule, and the reason widening is safe. Without it,
  -- a preparer could bill a stock item as a charge and sell inventory the
  -- books never see leave.
  if not new.moves_stock and v_stockable then
    raise exception '"%" maintains stock, so it cannot be recorded as a charge line — buying or selling it has to move the inventory it represents.', v_name;
  end if;

  return new;
end;
$$;

comment on function app_private.enforce_stock_item() is
  'Keeps a voucher line and its item honest about stock: a line that moves stock must be a stock-maintaining goods item (0013), a line that does not must not be, and a line that moves no stock is only allowed on a billing document — sales, purchase, credit_note, debit_note (1480). Derives voucher_items.moves_stock from the item master when the caller leaves it null.';

-- Restated rather than inherited. create or replace preserves the ACL it
-- finds, and what it found here was `=X/postgres` — EXECUTE held by PUBLIC,
-- which anon inherits. Revoking from anon alone would have been a no-op.
-- Postgres checks EXECUTE on a trigger function when the TRIGGER is created,
-- not when it fires, so narrowing this cannot stop the trigger running for
-- any role (verified live against service_role after applying).
revoke all on function app_private.enforce_stock_item() from public, anon;
grant execute on function app_private.enforce_stock_item() to authenticated;

-- ----------------------------------------------------------------------------
-- 3. The trigger now watches the flag too
-- ----------------------------------------------------------------------------
-- 0013 fired on `insert or update of item_id`, which was complete while the
-- item was the only thing the rule read. It no longer is: without moves_stock
-- in the column list, `update voucher_items set moves_stock = false` on a
-- stock line would slip past unchecked — exactly the case step 2's second
-- guard exists to catch.
drop trigger if exists enforce_stock_item on public.voucher_items;

create trigger enforce_stock_item
  before insert or update of item_id, moves_stock on public.voucher_items
  for each row execute function app_private.enforce_stock_item();

-- ----------------------------------------------------------------------------
-- 4. Hand the decision to the trigger
-- ----------------------------------------------------------------------------
-- With the default gone, an insert that omits the column arrives NULL and the
-- trigger fills it in from the item master. The column stays NOT NULL: a BEFORE
-- ROW trigger runs before constraints are checked, so the value is always set
-- by the time the constraint looks, and anything that ever manages to bypass
-- the trigger fails loudly instead of storing an unanswered question.
alter table public.voucher_items
  alter column moves_stock drop default;

comment on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, character, character, numeric, text, text, uuid, text, date) is
  'Posts a tax invoice, bill, credit or debit note with its GST, RCM and TCS. Lines may be goods or services: a service line carries its SAC, rate, amount and GST into the GST registers and the HSN summary exactly as a goods line does, and moves no stock (1480). No input tax is computed on a purchase or debit note from an unregistered or composition supplier — neither may lawfully collect it, so there is no credit to claim and nothing to add to the payable (1230). RCM is unaffected: it follows the item, not the supplier.';
