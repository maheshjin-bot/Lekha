-- ============================================================================
-- 1840 — update_item: the item master has never had an edit path
-- ============================================================================
-- CONFIRMED LIVE before writing this: no function named update_item existed
-- (select proname from pg_proc where proname='update_item' returned zero
-- rows), ItemManager.tsx (components/items/ItemManager.tsx) only ever calls
-- .from("items").insert(...), and grepping the whole app for any write
-- against the items table outside that one insert found nothing else. Once
-- an item is created there is no way to correct it, including flipping
-- items.is_rcm_applicable — read correctly by the RCM engine on a purchase
-- (0102 and every voucher-creation function since) but impossible to SET on
-- an existing item for a genuine Sec 9(3) case (GTA freight, an advocate's
-- fee, security services, director's fees) short of raw SQL.
--
-- THE ONE THING THIS MIGRATION DOES NOT HAVE TO DO. A live BEFORE UPDATE
-- trigger, app_private.protect_item_master_fields, already sits on
-- public.items (confirmed live via pg_trigger; not present in this tree's
-- own migration files, so it was shipped by a concurrent session working
-- the same item-master-integrity ground in a different worktree — see
-- shared-worktree-hazards). It already refuses, with its own clear
-- exception, any change to item_type or maintain_stock once the item has
-- voucher_items history, and to uom once the item has stock-line or
-- alternate-uom-conversion history, plus admin-gates opening_quantity/
-- opening_value and guards batch_tracking. That is exactly the guard this
-- task's brief asks for on item_type/maintain_stock. Re-deriving it here,
-- separately, in this function, would risk a second implementation quietly
-- disagreeing with the first (e.g. a different is_deleted filter on the
-- usage count) — worse than not guarding at all, because two contradictory
-- "authoritative" answers are harder to trust than one. This function
-- therefore does NOT re-check usage before touching those columns: it does
-- a plain, permission-checked UPDATE and lets that live trigger accept or
-- refuse the change. A refusal surfaces as this call's own error, with the
-- trigger's own reason, exactly like every other write path already going
-- through it (a direct .update() from anywhere, this RPC included).
--
-- FIELDS COVERED. Every column the create-item form (ItemManager.tsx)
-- already collects, plus the three the task brief asks for that the create
-- form never offered: is_rcm_applicable, purchase_rate, and (implicitly)
-- the ability to revisit hsn_sac/gst_rate_percent/cess_rate_percent once
-- issued. Deliberately NOT covered: opening_quantity/opening_value (a
-- materially different, riskier "restate day-one balances" operation, admin-
-- gated by the trigger above and out of this brief), batch_tracking
-- (no create-time UI for it either — a separate feature's surface, not
-- reopened here), and code/category/reorder_level (not part of the item
-- master fields this app's UI has ever exposed).
--
-- WHY THE UNGUARDED FIELDS ARE SAFE TO EDIT AT ANY TIME, EVEN AFTER USE.
-- Traced, not assumed: 0051 (GSTR-1 HSN summary)'s own header states it
-- plainly — "TAX FIGURES ARE ALLOCATED FROM ACTUAL POSTINGS, not recomputed
-- from the item master's current gst_rate_percent — voucher_items does not
-- store the rate that was actually charged at invoice time (only hsn_sac is
-- denormalised there) ... the item's rate can change after the fact.
-- Recomputing from today's item rate would misrepresent a historical
-- invoice." Every voucher-creation function (0102, 0147, 0725, 0865)
-- captures the item's hsn_sac/gst_rate_percent/is_rcm_applicable at posting
-- time and stores/posts from that snapshot; nothing re-reads the item master
-- for a past voucher. So correcting gst_rate_percent, cess_rate_percent,
-- hsn_sac, sale_rate, purchase_rate or is_rcm_applicable on an
-- already-used item changes only what the NEXT voucher for that item does —
-- which is the entire point of this task for is_rcm_applicable, and no
-- different in kind for the others.
--
-- GRANT PATTERN mirrors update_ledger (1330, confirmed live via
-- pg_get_functiondef): SECURITY INVOKER (not DEFINER) — the UPDATE runs as
-- the calling user, subject to the items_write RLS policy exactly as a
-- direct .update() would be, with can_write_company checked explicitly
-- first for a clean error message rather than a bare RLS-denial 0 rows.
-- ============================================================================

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
  p_is_active boolean
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
    -- this migration's header. app_private.protect_item_master_fields (a
    -- live BEFORE UPDATE trigger this migration does not own) refuses any of
    -- the three once the item has real history, with its own clear reason.
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
    is_active = p_is_active
  where id = p_item_id;

  return p_item_id;
end;
$function$;

comment on function public.update_item(uuid, text, text, text, text, boolean, numeric, numeric, text, numeric, numeric, text, text, boolean, boolean) is
  'Edits an existing item master row. item_type/maintain_stock/uom changes are accepted or refused by the live app_private.protect_item_master_fields trigger on public.items, not by this function. Opening quantity/value and batch_tracking are intentionally not exposed here — see 1840 for why.';

revoke all on function public.update_item(uuid, text, text, text, text, boolean, numeric, numeric, text, numeric, numeric, text, text, boolean, boolean) from public, anon;
grant execute on function public.update_item(uuid, text, text, text, text, boolean, numeric, numeric, text, numeric, numeric, text, text, boolean, boolean) to authenticated;
