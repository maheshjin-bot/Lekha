-- ============================================================================
-- 0121 — Multi-UOM conversion: an item stocked in one unit, transacted in
-- another (e.g. bought in BOX, sold/counted in NOS)
-- ============================================================================
-- THE GAP THIS CLOSES. Confirmed live before writing this migration:
--
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='items';
--     -> items.uom is a single not-null text column (FK to ref_uom(code)),
--        no second/alternate unit column or conversion table anywhere.
--
-- Every quantity in this schema — items.opening_quantity, voucher_items.
-- quantity, get_stock_summary's in/out/closing — is a bare number understood
-- to be in that one uom. A business that buys cloth by the ROL (roll) but
-- sells it by the MTR (metre), or buys a component by the BOX and issues it
-- to production by the NOS, has always had to either (a) fudge the base unit
-- to whichever side matters more and mismeasure the other, or (b) hand-
-- convert on paper before typing a quantity in. This migration gives that
-- conversion a real, auditable home.
--
-- SCOPE, STATED PLAINLY. This migration builds:
--   1. The conversion DATA MODEL (item_uom_conversions).
--   2. A read-only conversion utility (public.convert_quantity).
--   3. A UOM-conversions sub-panel on the item master (additive to the
--      existing screen).
--   4. A dual-unit figure on the Stock Summary report for any item that has
--      at least one alternate unit defined.
-- It deliberately does NOT touch invoice-entry: InvoiceForm.tsx, VoucherForm.
-- tsx and create_invoice/update_invoice are off-limits to this task (house
-- style — they are other in-flight work in this shared tree) and, even set
-- that aside, letting a user key a quantity in an alternate unit at invoice
-- time is a real UI/UX piece of work (a unit selector next to every item
-- line, a converted-quantity preview, deciding whether voucher_items stores
-- the base-unit quantity or the as-entered one) that belongs with whoever
-- next owns that form, not bolted on sideways here. See
-- CAVEATS_FOR_INTEGRATION in the final report for exactly what that follow-up
-- needs to do. Every quantity already in voucher_items, and everything
-- get_stock_summary computes from it, stays in the item's base uom exactly
-- as before — this migration is additive display/lookup only, nothing about
-- existing postings changes.
--
-- STATUTORY NOTE (WebSearched this session): GST does not have a "conversion
-- factor" concept at all. Rule 46 / the e-invoice and GSTR-1 HSN-summary
-- schemas require exactly ONE Unit Quantity Code per invoice line — the unit
-- actually transacted, drawn from the notified UQC list (Masters India's and
-- ClearTax's UQC explainers, both read today, agree: "each tax invoice...
-- must contain a UQC" from that fixed list, with OTH as the catch-all).
-- items.uom already enforces that list via its FK to ref_uom(code) (built in
-- an earlier migration, not re-verified here since nothing about the list
-- itself changes). This migration's alternate_uom is FK'd to the exact same
-- ref_uom(code) table for the same reason: whatever unit ends up on a report
-- or, eventually, an invoice line must be a real notified UQC, never a
-- free-text unit a return would reject. Multi-UOM conversion itself is an
-- ordinary ERP/inventory convenience (the same feature Tally calls
-- "Alternate Units") sitting entirely on the business's side of the
-- boundary — it has no GST-law citation of its own to get right or wrong.
--
-- DIRECTION CONVENTION — READ THIS BEFORE TOUCHING THE FACTOR.
-- conversion_factor is always: how many of the item's BASE (stocking) unit
-- equal ONE of alternate_uom. Worked example used in this migration's own
-- live verification: item base unit NOS, alternate_uom = 'BOX',
-- conversion_factor = 12 means "1 BOX = 12 NOS" — NOT "1 NOS = 12 BOX".
--   base  -> alternate : divide by the factor   (144 NOS / 12 = 12 BOX)
--   alternate -> base  : multiply by the factor  (12 BOX * 12 = 144 NOS)
-- This is the same direction Tally's "Alternate Unit — First Unit = n x
-- Second Unit" dialog uses (secondary/base is the "of" side, the bigger
-- number), chosen specifically because it is the one most bookkeepers
-- already have muscle memory for, and because it makes the common case (a
-- purchase unit that packages many stocking units — a BOX of NOS, a ROLL of
-- MTR) read as a whole number greater than one, not a fraction.
--
-- ONE ROW PER (ITEM, ALTERNATE UNIT), NEVER TWO CONFLICTING FACTORS. The
-- unique constraint below is on (item_id, alternate_uom) — an item cannot
-- have both "1 BOX = 12 NOS" and "1 BOX = 10 NOS" on file at once. Changing
-- an established factor is an UPDATE of the one row, an explicit and
-- auditable act (updated_at moves), not a silent second definition shadowing
-- the first.
--
-- is_purchase_uom / is_sales_uom are independent flags, not a single
-- "direction" enum, because the same alternate unit can legitimately be
-- either, both, or (temporarily, mid-edit) neither — e.g. a business might
-- buy in BOX and also sell in BOX (both true), or buy in BOX but always
-- break it down to sell by the NOS (purchase-only). At least one must be
-- true; a conversion nobody can use anywhere is a data-entry mistake, not a
-- real state to allow silently.
-- ============================================================================

create table public.item_uom_conversions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  item_id uuid not null,
  alternate_uom text not null references public.ref_uom(code),
  -- How many of the item's base (stocking) unit equal ONE alternate_uom.
  -- See this migration's header for the worked example and why this
  -- direction, not its reciprocal, was chosen.
  conversion_factor numeric(18, 6) not null check (conversion_factor > 0),
  is_purchase_uom boolean not null default true,
  is_sales_uom boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An item cannot have two conflicting factors on file for the same
  -- alternate unit at once (see header). Update the row instead.
  constraint item_uom_conversions_item_alt_uom_key unique (item_id, alternate_uom),
  constraint item_uom_conversions_at_least_one_use check (is_purchase_uom or is_sales_uom),

  -- Composite FK: item_id resolves through the SAME company_id this row
  -- carries, per the repo's tenancy convention — a conversion cannot be
  -- silently attached to another company's item.
  constraint item_uom_conversions_item_company_fkey
    foreign key (item_id, company_id) references public.items (id, company_id) on delete cascade
);

create index item_uom_conversions_item_idx on public.item_uom_conversions (item_id);
create index item_uom_conversions_company_idx on public.item_uom_conversions (company_id);

comment on table public.item_uom_conversions is
  'Alternate units of measure for a stock item, each with a conversion_factor back to the item''s own base/stocking uom (items.uom). conversion_factor = how many BASE units equal ONE alternate_uom (see 0121 header for direction and a worked example). Read-only utility for reports today (public.convert_quantity) and the item master''s UOM-conversions panel; wiring an alternate-unit selector into invoice entry itself is explicitly deferred — see 0121''s header.';

comment on column public.item_uom_conversions.conversion_factor is
  '1 alternate_uom = conversion_factor base (items.uom) units. To go base->alternate, divide by this; alternate->base, multiply by this. Get the direction backwards and every converted figure is out by the square of the real factor — see 0121''s header before changing this column''s meaning.';

comment on column public.item_uom_conversions.is_purchase_uom is
  'Whether this alternate unit is offered when the item is being purchased. Independent of is_sales_uom — a unit can be valid for either, both, or (mid-edit) neither is briefly allowed by the schema, but a row with both false fails item_uom_conversions_at_least_one_use.';

alter table public.item_uom_conversions enable row level security;

create policy item_uom_conversions_read on public.item_uom_conversions
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

create policy item_uom_conversions_write on public.item_uom_conversions
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

create trigger set_updated_at before update on public.item_uom_conversions
  for each row execute function app_private.set_updated_at();

-- ----------------------------------------------------------------------------
-- Row-validity trigger: same shape as 0114's enforce_bom_output_row_valid.
-- Two things a CHECK constraint cannot see because they live on another
-- table: the alternate unit must actually differ from the item's own base
-- unit (a "conversion" to the same unit is meaningless, and would make
-- convert_quantity's base/alternate branches ambiguous for that uom), and
-- conversions only make sense for a stock-maintained goods item (a service
-- item is forced to uom='OTH'/maintain_stock=false by the items table's own
-- constraints and never appears in get_stock_summary at all).
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_item_uom_conversion_valid()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_base_uom text;
  v_item_type text;
  v_maintain_stock boolean;
begin
  select uom, item_type, maintain_stock
    into v_base_uom, v_item_type, v_maintain_stock
    from public.items where id = new.item_id;

  if v_base_uom is null then
    raise exception 'Item % does not exist', new.item_id;
  end if;

  if v_item_type <> 'goods' or not v_maintain_stock then
    raise exception 'UOM conversions only apply to stock-maintained goods items';
  end if;

  if new.alternate_uom = v_base_uom then
    raise exception 'Alternate unit % is the same as this item''s own base unit (%) — there is nothing to convert', new.alternate_uom, v_base_uom;
  end if;

  return new;
end;
$$;

create trigger enforce_item_uom_conversion_valid
  before insert or update on public.item_uom_conversions
  for each row execute function app_private.enforce_item_uom_conversion_valid();

-- ----------------------------------------------------------------------------
-- public.convert_quantity — the read-only conversion utility.
--
-- SECURITY INVOKER (the default — no security definer here), deliberately:
-- the lookups against public.items and public.item_uom_conversions run under
-- RLS as the calling user, so an item this user cannot see resolves to "not
-- found" rather than leaking another company's base unit or factor. No
-- separate membership check is needed because RLS already supplies it.
--
-- Converts in BOTH directions from a single call by first normalising
-- p_quantity into the item's base unit (identity if p_from_uom is already
-- the base unit, multiply-by-factor if it is a defined alternate), then
-- converting out of the base unit to p_to_uom (identity if p_to_uom is the
-- base unit, divide-by-factor if it is a defined alternate). This also
-- correctly chains alternate-to-alternate (e.g. BOX -> DOZEN for an item
-- that has both defined) through the base unit, at no extra cost over the
-- two directions the task asked for.
-- ----------------------------------------------------------------------------
create or replace function public.convert_quantity(
  p_item_id uuid,
  p_quantity numeric,
  p_from_uom text,
  p_to_uom text
)
returns numeric
language plpgsql
stable
set search_path to ''
as $$
declare
  v_base_uom text;
  v_qty_base numeric;
  v_factor numeric;
begin
  select uom into v_base_uom from public.items where id = p_item_id;

  if v_base_uom is null then
    raise exception 'Item % not found (or not visible to the current user)', p_item_id;
  end if;

  if p_from_uom is null or p_to_uom is null then
    raise exception 'from_uom and to_uom are both required';
  end if;

  if p_from_uom = p_to_uom then
    return p_quantity;
  end if;

  -- Leg 1: p_from_uom -> the item's base unit.
  if p_from_uom = v_base_uom then
    v_qty_base := p_quantity;
  else
    select conversion_factor into v_factor
      from public.item_uom_conversions
     where item_id = p_item_id and alternate_uom = p_from_uom;

    if v_factor is null then
      raise exception '% is neither item %''s base unit (%) nor a defined alternate unit for it — no conversion is defined',
        p_from_uom, p_item_id, v_base_uom;
    end if;

    v_qty_base := p_quantity * v_factor;
  end if;

  -- Leg 2: the item's base unit -> p_to_uom.
  if p_to_uom = v_base_uom then
    return v_qty_base;
  end if;

  select conversion_factor into v_factor
    from public.item_uom_conversions
   where item_id = p_item_id and alternate_uom = p_to_uom;

  if v_factor is null then
    raise exception '% is neither item %''s base unit (%) nor a defined alternate unit for it — no conversion is defined',
      p_to_uom, p_item_id, v_base_uom;
  end if;

  return v_qty_base / v_factor;
end;
$$;

comment on function public.convert_quantity(uuid, numeric, text, text) is
  'Converts p_quantity of an item between two of its units (base or any defined alternate), via the item''s base unit. Raises if either uom is neither the item''s base unit nor a unit it has a conversion row for. See 0121 for the conversion_factor direction convention.';

revoke all on function public.convert_quantity(uuid, numeric, text, text) from public, anon;
grant execute on function public.convert_quantity(uuid, numeric, text, text) to authenticated;
