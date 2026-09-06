-- ============================================================================
-- 1370 — update_item gains batch_tracking: the one item-master field its
-- own edit path (1840) left unwritten
-- ============================================================================
-- items.batch_tracking has existed since 0067 and, before this migration, had
-- no writer anywhere — confirmed live: grepping every call site of
-- update_item and every direct .from("items").update() in the app turns up
-- none that touch it. The consequence is the one 1840's own header already
-- named and deliberately deferred ("batch_tracking — no create-time UI for it
-- either — a separate feature's surface, not reopened here"): /batches
-- filters .neq("batch_tracking","none"), so an item can only ever enter that
-- screen, Reports > Stock expiry, or the batch half of /stock-verification if
-- someone hand-sets the column in SQL. BatchManager.tsx:178 tells a preparer
-- to "set the Batch tracking field" under Items — advice the item edit form
-- could not follow until now.
--
-- NOT reopening opening_quantity/opening_value here. 1840 excluded them as "a
-- materially different, riskier 'restate day-one balances' operation" and
-- that reasoning is unchanged — this migration's brief is the one column
-- that has a real, waiting UI (BatchManager) and zero write path, not a
-- broader reopening of the item master.
--
-- WHY create-or-replace WITH ONE APPENDED, DEFAULTED PARAMETER rather than a
-- fresh signature or a sibling RPC. Postgres allows create-or-replace to add
-- a trailing parameter with a DEFAULT without dropping the function, and
-- every existing caller (ItemManager.tsx's saveEdit) keeps compiling and
-- running unchanged, sending 15 arguments and getting p_batch_tracking's
-- default. Default is NULL, not 'none': NULL means "leave batch_tracking as
-- it is," so a save from before this migration shipped its own frontend
-- change — or any other caller that never learns about the new field — does
-- not silently reset an item that already had batch or serial tracking set.
--
-- WHY NO NEW GUARD HERE. app_private.protect_item_master_fields (already
-- live on public.items — see 1840's own header on why it is not re-derived
-- in the RPC layer) already has a batch_tracking clause: it refuses turning
-- tracking off while allocations exist, and refuses switching to 'serial'
-- while an existing allocation covers more than one unit. This function does
-- a plain, permission-checked UPDATE and lets that trigger accept or refuse
-- the change, exactly as it already does for item_type/maintain_stock/uom —
-- one authoritative guard, not two that could quietly disagree.
--
-- items_batch_tracking_needs_stock (a live CHECK) refuses 'batch'/'serial' on
-- anything but a goods item with maintain_stock — i.e. never on a service.
-- Not re-derived here either: a violation surfaces as this call's own
-- constraint-violation error, same as every other field this function leaves
-- to the database's own rules (e.g. items_non_taxable_has_no_rate is derived
-- client-side and here; items_batch_tracking_needs_stock is deliberately
-- left to the database because the frontend already disables the batch-
-- tracking control for a service/non-stock item rather than pre-computing
-- the same rule twice).
--
-- DROP FIRST, THE SAME REASON AS 1280 (fdf8b20). create-or-replace only
-- replaces a function whose argument TYPE LIST is byte-for-byte identical;
-- appending a new parameter — even one with a DEFAULT — changes the type
-- list and Postgres silently creates a second, overloaded function instead
-- of replacing the first. Confirmed live before writing the final version of
-- this migration: without the DROP below, calling update_item with exactly
-- the original 15 named arguments becomes ambiguous between the old and new
-- overloads ("function ... is not unique", 42725) — a call that worked
-- yesterday breaks today, for every existing caller, until this DROP runs.
-- ============================================================================

drop function if exists public.update_item(
  uuid, text, text, text, text, boolean, numeric, numeric, text, numeric,
  numeric, text, text, boolean, boolean
);

create or replace function public.update_item(
  p_item_id uuid,
  p_name text,
  p_item_type text,
  p_hsn_sac text,
  p_uom text,
  p_maintain_stock boolean,
  p_sale_rate numeric,
  p_purchase_rate numeric,
  p_supply_nature text,
  p_gst_rate_percent numeric,
  p_cess_rate_percent numeric,
  p_itc_blocked_clause text,
  p_default_tcs_section text,
  p_is_rcm_applicable boolean,
  p_is_active boolean,
  p_batch_tracking text default null
)
returns uuid
language plpgsql
set search_path to ''
as $function$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from public.items where id = p_item_id;

  if v_company_id is null then
    raise exception 'Item not found';
  end if;

  if not app_private.can_write_company(v_company_id) then
    raise exception 'You do not have permission to edit items in this company';
  end if;

  update public.items set
    name = p_name,
    -- item_type, maintain_stock and uom: no lock check here on purpose — see
    -- 1840's header. app_private.protect_item_master_fields (a live BEFORE
    -- UPDATE trigger this migration does not own) refuses any of the three
    -- once the item has real history, with its own clear reason.
    item_type = p_item_type,
    hsn_sac = p_hsn_sac,
    uom = p_uom,
    maintain_stock = p_maintain_stock,
    sale_rate = p_sale_rate,
    purchase_rate = p_purchase_rate,
    supply_nature = p_supply_nature,
    -- items_non_taxable_has_no_rate: a non-taxable supply carries no rate.
    -- Derived here, the same way ItemManager.tsx's create form derives it
    -- client-side, so this RPC can never be asked to build a row the
    -- constraint would reject.
    gst_rate_percent = case when p_supply_nature = 'taxable' then coalesce(p_gst_rate_percent, 0) else 0 end,
    cess_rate_percent = case when p_supply_nature = 'taxable' then coalesce(p_cess_rate_percent, 0) else 0 end,
    -- items_itc_clause_matches_eligibility: a block needs a clause and a
    -- clause needs a block. Same derivation as the create form.
    itc_eligibility = case when p_itc_blocked_clause is not null then 'blocked' else 'eligible' end,
    itc_blocked_clause = p_itc_blocked_clause,
    default_tcs_section = p_default_tcs_section,
    is_rcm_applicable = p_is_rcm_applicable,
    is_active = p_is_active,
    -- NULL means "no change requested" — see this migration's header on why
    -- the default is NULL rather than 'none'. app_private.
    -- protect_item_master_fields and items_batch_tracking_needs_stock are
    -- the only guards; neither is re-derived here.
    batch_tracking = coalesce(p_batch_tracking, batch_tracking)
  where id = p_item_id;

  return p_item_id;
end;
$function$;

comment on function public.update_item(uuid, text, text, text, text, boolean, numeric, numeric, text, numeric, numeric, text, text, boolean, boolean, text) is
  'Edits an existing item master row. item_type/maintain_stock/uom/batch_tracking changes are accepted or refused by the live app_private.protect_item_master_fields trigger on public.items, not by this function. p_batch_tracking defaults to NULL, meaning leave unchanged. Opening quantity/value is intentionally not exposed here — see 1840 for why.';

revoke all on function public.update_item(uuid, text, text, text, text, boolean, numeric, numeric, text, numeric, numeric, text, text, boolean, boolean, text) from public, anon;
grant execute on function public.update_item(uuid, text, text, text, text, boolean, numeric, numeric, text, numeric, numeric, text, text, boolean, boolean, text) to authenticated;
