-- ============================================================================
-- 0013 — Inventory
-- ============================================================================
-- The item-line layer HISAB never had. Its absence is why a Rule 46 tax
-- invoice, a GSTR-1 HSN summary and a stock statement were all impossible
-- there — and why this is the gate for both GST and bank stock statements.
-- ============================================================================

-- Units of measure. A closed list, not free text: the UQC on a GST invoice
-- must come from the notified set, and free text here becomes a rejected
-- GSTR-1 later.
create table public.ref_uom (
  code text primary key,
  name text not null,
  decimals smallint not null default 2 check (decimals between 0 and 3)
);

insert into public.ref_uom (code, name, decimals) values
  ('NOS','Numbers',0), ('PCS','Pieces',0), ('BOX','Box',0), ('SET','Set',0),
  ('PAC','Pack',0), ('BAG','Bags',0), ('BTL','Bottles',0), ('ROL','Rolls',0),
  ('KGS','Kilograms',3), ('GMS','Grams',3), ('TON','Tonnes',3), ('QTL','Quintal',3),
  ('LTR','Litres',3), ('MLT','Millilitre',3), ('KLR','Kilolitre',3),
  ('MTR','Metres',3), ('CMS','Centimetre',2), ('KME','Kilometre',3),
  ('SQF','Square Feet',2), ('SQM','Square Metre',2), ('CBM','Cubic Metre',3),
  ('DOZ','Dozen',0), ('HRS','Hours',2), ('DAY','Days',0), ('OTH','Others',2);

alter table public.ref_uom enable row level security;
create policy ref_uom_read on public.ref_uom for select to authenticated using (true);

-- Valuation method is a company policy and a 3CD clause 14 disclosure, so it
-- belongs on the company rather than being implied by whatever the code does.
alter table public.companies
  add column inventory_valuation_method text not null default 'weighted_average'
    check (inventory_valuation_method in ('weighted_average','fifo'));

comment on column public.companies.inventory_valuation_method is
  'Disclosed under 3CD clause 14. Only weighted_average is implemented; fifo needs lot tracking.';


-- ----------------------------------------------------------------------------
-- Items
-- ----------------------------------------------------------------------------
create table public.items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text,
  name text not null check (length(trim(name)) > 0),

  -- Goods carry an HSN, services a SAC. One column: the return distinguishes
  -- them by item type, not by a separate field.
  item_type text not null default 'goods' check (item_type in ('goods','service')),
  hsn_sac text check (hsn_sac is null or hsn_sac ~ '^[0-9]{4,8}$'),

  uom text not null default 'NOS' references public.ref_uom(code),
  category text,
  maintain_stock boolean not null default true,

  opening_quantity numeric(18,3) not null default 0 check (opening_quantity >= 0),
  opening_value numeric(18,2) not null default 0 check (opening_value >= 0),

  sale_rate numeric(18,2),
  purchase_rate numeric(18,2),
  reorder_level numeric(18,3),

  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  -- A service with a stock balance is meaningless and would quietly corrupt
  -- the valuation.
  constraint items_service_has_no_stock
    check (item_type = 'goods' or (maintain_stock = false and opening_quantity = 0)),
  -- An opening quantity with no value gives the weighted average nothing to
  -- start from, and silently values the first issue at zero.
  constraint items_opening_value_with_quantity
    check (opening_quantity = 0 or opening_value > 0)
);

create unique index items_company_name_idx on public.items(company_id, lower(name));
create unique index items_company_code_idx on public.items(company_id, lower(code)) where code is not null;
create index items_company_active_idx on public.items(company_id, is_active);
create index items_hsn_idx on public.items(company_id, hsn_sac) where hsn_sac is not null;

create trigger set_updated_at before update on public.items
  for each row execute function app_private.set_updated_at();


-- ----------------------------------------------------------------------------
-- Godowns
-- ----------------------------------------------------------------------------
-- Stock locations sit under a branch, so a branch-scoped user sees only their
-- own stock and a stock statement can be produced per facility — a lender
-- finances the stock at named locations, not the company total.
create table public.godowns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  code text not null check (code ~ '^[A-Z0-9]{1,6}$'),
  name text not null check (length(trim(name)) > 0),
  address text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code),
  unique (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id) on delete cascade
);

create unique index godowns_one_default_per_branch_idx on public.godowns (branch_id) where is_default;
create index godowns_company_idx on public.godowns(company_id, is_active);

create trigger set_updated_at before update on public.godowns
  for each row execute function app_private.set_updated_at();


-- ----------------------------------------------------------------------------
-- Item lines — the stock movement itself
-- ----------------------------------------------------------------------------
-- Records the STOCK effect of a voucher; voucher_entries records the FINANCIAL
-- effect, linked by voucher_id. The generator that derives entries from these
-- lines arrives with GST; until then a voucher carries both.
create table public.voucher_items (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null,
  company_id uuid not null,
  branch_id uuid not null,
  godown_id uuid not null,
  item_id uuid not null,

  -- Explicit rather than inferred from the voucher type: a credit note moves
  -- stock the opposite way to the sale it reverses, and a stock journal can
  -- do either.
  direction text not null check (direction in ('in','out')),

  quantity numeric(18,3) not null check (quantity > 0),
  uom text not null references public.ref_uom(code),

  -- The transaction value. The VALUATION of an issue comes from the running
  -- weighted average, not from this rate — selling at a margin must not
  -- revalue the stock that remains.
  rate numeric(18,2) not null default 0 check (rate >= 0),
  amount numeric(18,2) not null default 0 check (amount >= 0),

  -- Denormalised at entry so an HSN summary need not trust that the item
  -- master still says what it said at invoice time.
  hsn_sac text,

  description text,
  line_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (voucher_id, company_id) references public.vouchers (id, company_id) on delete cascade,
  foreign key (item_id, company_id) references public.items (id, company_id),
  foreign key (godown_id, company_id) references public.godowns (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id)
);

create index voucher_items_voucher_idx on public.voucher_items(voucher_id);
create index voucher_items_item_idx on public.voucher_items(company_id, item_id);
create index voucher_items_godown_idx on public.voucher_items(company_id, godown_id);

create trigger set_updated_at before update on public.voucher_items
  for each row execute function app_private.set_updated_at();

create or replace function app_private.enforce_stock_item()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_ok boolean;
begin
  select item_type = 'goods' and maintain_stock into v_ok
    from public.items where id = new.item_id;
  if not coalesce(v_ok, false) then
    raise exception 'This item does not maintain stock, so it cannot appear on a stock line';
  end if;
  return new;
end;
$$;

create trigger enforce_stock_item
  before insert or update of item_id on public.voucher_items
  for each row execute function app_private.enforce_stock_item();


-- ----------------------------------------------------------------------------
-- Valuation
-- ----------------------------------------------------------------------------
-- Moving weighted average, replayed from movements rather than stored.
--
-- A stored running balance and a voucher that can be edited or back-dated
-- disagree the moment someone does either, and a stock figure that silently
-- drifts from its own movements is worse than a slower query. If this becomes
-- a bottleneck the answer is a materialised snapshot with an explicit rebuild,
-- not a trigger-maintained total.
create or replace function public.get_stock_summary(
  p_company_id uuid,
  p_as_at date default current_date,
  p_godown_id uuid default null
) returns table (
  item_id uuid, item_name text, hsn_sac text, uom text,
  quantity_in numeric, quantity_out numeric, closing_quantity numeric,
  average_rate numeric, closing_value numeric
)
language sql stable security invoker set search_path = ''
as $$
  with movements as (
    select vi.item_id, vi.direction, vi.quantity, vi.amount
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
       and (p_godown_id is null or vi.godown_id = p_godown_id)
  ),
  totals as (
    select i.id, i.name, i.hsn_sac, i.uom, i.opening_quantity, i.opening_value,
           coalesce(sum(m.quantity) filter (where m.direction = 'in'), 0)  as qty_in,
           coalesce(sum(m.quantity) filter (where m.direction = 'out'), 0) as qty_out,
           coalesce(sum(m.amount)   filter (where m.direction = 'in'), 0)  as value_in
      from public.items i
      left join movements m on m.item_id = i.id
     where i.company_id = p_company_id and i.item_type = 'goods' and i.maintain_stock
     group by i.id, i.name, i.hsn_sac, i.uom, i.opening_quantity, i.opening_value
  )
  select id, name, hsn_sac, uom, qty_in, qty_out,
    (opening_quantity + qty_in - qty_out),
    -- Averaged over everything received including opening, so an issue is
    -- valued at what the stock cost rather than what it sold for.
    case when (opening_quantity + qty_in) > 0
         then round((opening_value + value_in) / (opening_quantity + qty_in), 2) else 0 end,
    case when (opening_quantity + qty_in) > 0
         then round((opening_quantity + qty_in - qty_out)
                    * ((opening_value + value_in) / (opening_quantity + qty_in)), 2) else 0 end
  from totals
  where opening_quantity <> 0 or qty_in <> 0 or qty_out <> 0
  order by name;
$$;

comment on function public.get_stock_summary is
  'Moving weighted average, replayed from movements. Issues are valued at cost, never at sale price.';


-- ----------------------------------------------------------------------------
-- Row level security
-- ----------------------------------------------------------------------------
alter table public.items enable row level security;
alter table public.godowns enable row level security;
alter table public.voucher_items enable row level security;

create policy items_read on public.items
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy items_write on public.items
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

create policy godowns_read on public.godowns
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy godowns_write on public.godowns
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

-- Branch-scoped like vouchers: a branch-restricted member must not see another
-- branch's stock movement.
create policy voucher_items_read on public.voucher_items
  for select to authenticated
  using ((select app_private.is_company_member(company_id))
     and (select app_private.can_access_branch(branch_id)));
create policy voucher_items_write on public.voucher_items
  for all to authenticated
  using ((select app_private.can_write_company(company_id))
     and (select app_private.can_access_branch(branch_id)))
  with check ((select app_private.can_write_company(company_id))
          and (select app_private.can_access_branch(branch_id)));
