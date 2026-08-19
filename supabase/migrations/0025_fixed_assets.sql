-- ============================================================================
-- 0025 — Fixed assets: two depreciation books, one asset register
-- ============================================================================
-- The `fixed_assets` module (0004) has been flagged active on every
-- compliance-mode company since day one, with zero schema behind it. This
-- migration closes that gap for the last of the four modules found active-
-- with-zero-UI in the 19 Aug feature-register audit (compliance_calendar,
-- income_tax, tax_audit, fixed_assets — the first three already shipped).
--
-- Every figure below came from a two-pass independent research workflow,
-- reconciled against disagreements with a further round of primary-source
-- fetches (mca.gov.in-derived Schedule II text, incometaxindia.gov.in's own
-- Section 33 page) — not pulled from training-data memory. Full citations
-- and per-figure confidence live in that research's transcript; only the
-- load-bearing facts are repeated here.
--
-- WHY TWO SEPARATE SCHEDULES. Indian accounting keeps two independent
-- depreciation books for the same asset, and they are never reconciled line
-- by line — only compared in aggregate for the tax computation:
--
--   BOOK depreciation (Companies Act 2013, Schedule II): a useful-life
--   table. A company picks SLM, WDV, or units-of-production; Schedule II
--   only bounds two parameters — useful life (Part C, a ceiling absent
--   disclosed justification) and residual value (Part A, capped at 5% of
--   cost). This migration implements SLM and WDV; units-of-production is
--   not modelled (it needs a units-produced ledger this app doesn't keep).
--
--   TAX depreciation (Income-tax Act 2025, Sec 33, formerly Sec 32(1) of
--   the 1961 Act): a "block of assets" system. Assets lose individual
--   identity — depreciation is computed on the pooled WDV of every asset
--   sharing a rate, not per asset. The rates themselves are not in the Act;
--   they sit in subordinate legislation (Rule 25 / Appendix I of the
--   Income-tax Rules, mirroring old Rule 5 / Appendix I of 1962).
--
-- Both use the "written down value" name for unrelated computations — book
-- WDV is a per-asset running balance; tax WDV is a per-BLOCK pooled one.
-- Conflating them is the single easiest mistake to make in this feature,
-- which is why they get separate functions below rather than one shared
-- "depreciation" concept.
--
-- SCOPE CUTS — deliberate, matching the discipline 0022/0023/0024 already
-- applied (narrow to what this schema can determine correctly, document the
-- rest rather than guessing):
--
--   * TANGIBLE ASSETS ONLY. Schedule II's useful-life table doesn't cover
--     general intangibles at all (software/licence life is a management
--     estimate under Ind AS 38 / AS 26, not a Schedule figure) and its one
--     intangible carve-out (BOT/BOOT toll roads) amortises by a revenue-
--     proportion formula, not a fixed life — neither fits this migration's
--     fixed-useful-life category table. The tax-side INTANGIBLE block (25%)
--     is dropped to match: with no intangible book category, no asset would
--     ever need it. Intangible assets are a real future feature, not folded
--     in here to keep this one internally consistent.
--   * SCHEDULE II NARROWED TO ~20 SME-RELEVANT CATEGORIES, not the full
--     ~90-line official table. Industry-specific plant (textile, chemical,
--     glass, mining, oil & gas, telecom, power, medical — each its own
--     sub-table), ships, aircraft, railway sidings, and civil infrastructure
--     (roads, bridges, culverts) are out of scope; a company in one of
--     those industries needs a dedicated pass, not a guess folded in here.
--   * TAX BLOCKS NARROWED THE SAME WAY: SHIPS (20%) and INTANGIBLE (25%)
--     dropped for the reasons above; every other confirmed block kept.
--   * SHIFT-BASED DEPRECIATION (Schedule II Note 6: +50%/+100% for double/
--     triple shift working) is NOT computed. `is_nesd` is still seeded
--     correctly where the research confirmed it, so a future pass can wire
--     this in without re-deriving the reference data, but no asset's
--     depreciation is uplifted for shift pattern yet.
--   * ADDITIONAL DEPRECIATION (Sec 33(8)-(9): 20% extra, or a 10%+10%
--     carry-forward split, for new manufacturing/power-generation plant) is
--     NOT computed. It has a genuine cross-year carry-forward interaction
--     with the half-year rule that deserves its own careful pass rather
--     than being bolted on here with residual risk of getting the
--     carry-forward wrong. The ordinary block WDV computation below —
--     including the half-year rule and disposal/block-cessation gain-or-
--     loss trigger — is the well-established 90% case and is fully
--     implemented; additional depreciation is the documented remainder.
--   * NO VOUCHER POSTING. This migration computes book and tax depreciation
--     as reports; it does not post a "Dr Depreciation Expense / Cr
--     Accumulated Depreciation" journal voucher. That is real, separate
--     future work — this closes the "there is no fixed asset register at
--     all" gap first, same reasoning 0023 used for TCS: seed what can be
--     gotten right now, keep the larger integration a deliberately later,
--     separate change.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Reference data — world-readable, migration-only-write, same pattern as
-- ref_tds_sections (0022) / ref_tcs_sections (0023) / ref_states (0002).
-- ----------------------------------------------------------------------------
create table public.ref_depreciation_categories (
  category_code text primary key,
  description text not null,
  useful_life_years numeric(5,1) not null check (useful_life_years > 0),
  -- No Extra Shift Depreciation. Seeded where the research confirmed it
  -- (continuous process plant); false elsewhere is the Schedule II default,
  -- not a verified negative for every category — see the migration header.
  -- Not yet read by any computation in this migration.
  is_nesd boolean not null default false,
  sort_order smallint not null,
  is_active boolean not null default true
);

comment on table public.ref_depreciation_categories is
  'Companies Act 2013 Schedule II useful-life table, narrowed to tangible SME-relevant categories. Useful life is a ceiling, not a mandate (Part C, para 3(ii)); residual value is a separate per-company choice, capped at 5%, stored on fixed_assets itself.';

insert into public.ref_depreciation_categories
  (category_code, description, useful_life_years, is_nesd, sort_order) values
  ('BLDG-FACTORY',   'Factory buildings',                                                             30, false, 10),
  ('BLDG-RCC',       'Office / general / residential buildings — RCC frame structure',                60, false, 20),
  ('BLDG-NONRCC',    'Office / general / residential buildings — other than RCC frame structure',     30, false, 30),
  ('BLDG-TEMP',      'Temporary structures (including wooden structures)',                              3, false, 40),
  ('BLDG-FENCE',     'Fences, wells, tube wells',                                                       5, false, 50),
  ('PM-GENERAL',     'General plant & machinery (no special industry rate)',                           15, false, 60),
  ('PM-CONTINUOUS',  'Continuous process plant (designed to operate 24 hours a day)',                  25, true,  70),
  ('COMP-SERVER',    'Computers and data processing — servers and networks',                            6, false, 80),
  ('COMP-ENDUSER',   'Computers and data processing — end-user devices (desktops, laptops)',             3, false, 90),
  ('OFFICE-EQUIP',   'Office equipment',                                                                 5, false, 100),
  ('FURN-GENERAL',   'Furniture and fittings (general)',                                                10, false, 110),
  ('FURN-HOSP',      'Furniture and fittings — hotels, schools/colleges, cinemas, marriage halls etc.',   8, false, 120),
  ('VEH-CAR',        'Motor cars (other than those used in a business of running them on hire)',         8, false, 130),
  ('VEH-HIRE',       'Motor buses, lorries and taxis used in a business of running them on hire',        6, false, 140),
  ('VEH-2W3W',       'Two/three-wheelers — motor cycles, scooters, mopeds',                             10, false, 150),
  ('VEH-ELECTRIC',   'Electrically operated vehicles (including battery/fuel-cell powered)',             8, false, 160),
  ('VEH-HEAVY',      'Motor tractors, harvesting combines, and heavy vehicles',                          8, false, 170),
  ('ELEC-INSTALL',   'Electrical installations and equipment',                                          10, false, 180),
  ('LAB-GENERAL',    'General laboratory equipment',                                                    10, false, 190)
;

alter table public.ref_depreciation_categories enable row level security;
create policy ref_depreciation_categories_read on public.ref_depreciation_categories
  for select to authenticated using (true);


create table public.ref_depreciation_blocks_it (
  block_code text primary key,
  description text not null,
  rate_percent numeric(5,2) not null check (rate_percent >= 0 and rate_percent <= 100),
  sort_order smallint not null,
  is_active boolean not null default true
);

comment on table public.ref_depreciation_blocks_it is
  'Income-tax Act 2025 Sec 33 block-of-assets WDV rates (rates themselves sit in Rule 25/Appendix I, not the Act). Narrowed to tangible SME-relevant blocks — SHIPS and INTANGIBLE dropped to match ref_depreciation_categories excluding intangibles; see the migration header.';

insert into public.ref_depreciation_blocks_it
  (block_code, description, rate_percent, sort_order) values
  ('BLD-RES',       'Buildings used mainly for residential purposes (excl. hotels/boarding houses)', 5,  10),
  ('BLD-NONRES',    'Buildings not used for residential purposes — offices, factories, godowns',      10, 20),
  ('BLD-TEMP',      'Purely temporary erections such as wooden structures',                           40, 30),
  ('FURN',          'Furniture and fittings, including electrical fittings',                          10, 40),
  ('PM-GEN',        'Plant & machinery — general/residual block',                                     15, 50),
  ('PM-MOTORCAR',   'Motor cars, other than those used in a business of running them on hire',         15, 60),
  ('PM-HIREVEH',    'Motor buses, motor lorries and motor taxis used in a business of running them on hire', 30, 70),
  ('PM-COMPUTER',   'Computers, including computer software',                                         40, 80),
  ('PM-ENERGYSAVE', 'Specified energy-saving devices',                                                 40, 90),
  ('PM-POLLUTION',  'Air/water pollution control equipment and solid-waste-control equipment',         40, 100),
  ('PM-RENEWABLE',  'Renewable energy devices (solar/wind/biogas and similar notified items)',         40, 110),
  ('PM-BOOKS',      'Books — annual publications, and books owned by a lending-library business',      40, 120)
;

alter table public.ref_depreciation_blocks_it enable row level security;
create policy ref_depreciation_blocks_it_read on public.ref_depreciation_blocks_it
  for select to authenticated using (true);


-- ----------------------------------------------------------------------------
-- fixed_assets — the register. One row per asset, carrying both the book
-- category and the tax block, so the two depreciation books can be computed
-- independently from the same source row.
-- ----------------------------------------------------------------------------
create table public.fixed_assets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  name text not null check (length(trim(name)) > 0),
  asset_code text,

  category_code text not null references public.ref_depreciation_categories(category_code),
  it_block text not null references public.ref_depreciation_blocks_it(block_code),

  book_method text not null default 'wdv' check (book_method in ('slm', 'wdv')),
  -- Schedule II Part A para 3(i): a ceiling, not a fixed figure — see the
  -- table comment. 5 is the near-universal default in practice.
  residual_value_percent numeric(5,2) not null default 5
    check (residual_value_percent >= 0 and residual_value_percent <= 5),

  acquisition_date date not null,
  -- Depreciation, the <180-day half-year rule, and Schedule II's pro-rata
  -- Note 2 all key off this date, not acquisition_date — they can differ
  -- (an asset bought and commissioned weeks apart).
  put_to_use_date date not null,
  gross_value numeric(18,2) not null check (gross_value > 0),

  disposal_date date,
  disposal_value numeric(18,2),

  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint fixed_assets_put_to_use_not_before_acquisition
    check (put_to_use_date >= acquisition_date),
  constraint fixed_assets_disposal_value_requires_date
    check ((disposal_date is null) = (disposal_value is null)),
  constraint fixed_assets_disposal_not_before_put_to_use
    check (disposal_date is null or disposal_date >= put_to_use_date)
);

comment on table public.fixed_assets is
  'One row per tangible fixed asset. category_code drives book depreciation (get_fixed_asset_register); it_block drives pooled tax depreciation (get_tax_depreciation_blocks) — the two are computed independently and are not expected to reconcile line by line.';

create index fixed_assets_company_idx on public.fixed_assets(company_id);
create index fixed_assets_company_block_idx on public.fixed_assets(company_id, it_block);
create index fixed_assets_company_active_idx on public.fixed_assets(company_id, is_active);

create trigger set_updated_at before update on public.fixed_assets
  for each row execute function app_private.set_updated_at();

alter table public.fixed_assets enable row level security;

create policy fixed_assets_read on public.fixed_assets
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy fixed_assets_write on public.fixed_assets
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));


-- ----------------------------------------------------------------------------
-- Book depreciation — per asset, SLM or WDV, pro-rated by exact date for the
-- year of acquisition and the year of disposal (Schedule II Part C, Note 2).
--
-- WDV rate is derived from useful life and residual value the way Schedule
-- II implies it (no fixed rate table the way the tax side has one):
--   rate = 1 - (residual / cost) ^ (1 / life)
-- which, since residual is stored as a percentage of cost, simplifies to
--   rate = 1 - (residual_value_percent / 100) ^ (1 / life)
-- Depreciation compounds annually on the calendar April-March year (the
-- Act's implicit accounting year for a company incorporated in India),
-- applied to each year's opening WDV, with the first and last year prorated
-- by day count within that year rather than a half-year/month convention —
-- Note 2's text is explicitly date-based, not a rounding convention.
-- ----------------------------------------------------------------------------
create or replace function app_private.compute_book_depreciation(
  p_cost numeric,
  p_residual_pct numeric,
  p_life numeric,
  p_method text,
  p_start date,
  p_end date
) returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_depreciable numeric := p_cost - (p_cost * p_residual_pct / 100);
  v_rate numeric;
  v_accumulated numeric := 0;
  v_opening numeric := p_cost;
  v_fy_year int;
  v_fy_start date;
  v_fy_end date;
  v_period_start date;
  v_period_end date;
  v_days_this_fy int;
  v_days_in_fy int;
  v_dep numeric;
begin
  if p_end < p_start or p_life <= 0 or p_cost <= 0 then
    return 0;
  end if;

  if p_method = 'wdv' then
    if p_residual_pct <= 0 then
      v_rate := 1; -- degenerate case: fully depreciates in year one
    else
      v_rate := 1 - power(p_residual_pct / 100, 1.0 / p_life);
    end if;
  end if;

  v_fy_year := case when extract(month from p_start) >= 4
                     then extract(year from p_start)::int
                     else extract(year from p_start)::int - 1 end;

  loop
    v_fy_start := make_date(v_fy_year, 4, 1);
    v_fy_end := make_date(v_fy_year + 1, 3, 31);
    exit when v_fy_start > p_end;

    v_period_start := greatest(v_fy_start, p_start);
    v_period_end := least(v_fy_end, p_end);
    exit when v_period_start > v_period_end;

    v_days_this_fy := v_period_end - v_period_start + 1;
    v_days_in_fy := v_fy_end - v_fy_start + 1;

    if p_method = 'slm' then
      v_dep := (v_depreciable / p_life) * v_days_this_fy / v_days_in_fy;
    else
      v_dep := v_opening * v_rate * v_days_this_fy / v_days_in_fy;
    end if;

    v_accumulated := least(v_accumulated + v_dep, v_depreciable);
    v_opening := p_cost - v_accumulated;

    exit when v_accumulated >= v_depreciable;
    v_fy_year := v_fy_year + 1;
  end loop;

  return round(v_accumulated, 2);
end;
$$;

comment on function app_private.compute_book_depreciation is
  'One asset''s accumulated Schedule II depreciation from p_start to p_end, floored at residual value. Loops calendar April-March years because Note 2''s pro-rata rule and WDV''s annual-compounding both key off that year, never the company''s own financial_year_start_month.';


create or replace function public.get_fixed_asset_register(
  p_company_id uuid,
  p_as_at date default current_date
) returns table (
  asset_id uuid,
  name text,
  asset_code text,
  category_code text,
  category_description text,
  it_block text,
  book_method text,
  acquisition_date date,
  put_to_use_date date,
  gross_value numeric,
  residual_value_percent numeric,
  accumulated_depreciation numeric,
  net_book_value numeric,
  disposal_date date,
  disposal_value numeric,
  is_active boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    fa.id,
    fa.name,
    fa.asset_code,
    fa.category_code,
    cat.description,
    fa.it_block,
    fa.book_method,
    fa.acquisition_date,
    fa.put_to_use_date,
    fa.gross_value,
    fa.residual_value_percent,
    app_private.compute_book_depreciation(
      fa.gross_value, fa.residual_value_percent, cat.useful_life_years, fa.book_method,
      fa.put_to_use_date, least(coalesce(fa.disposal_date, p_as_at), p_as_at)
    ),
    fa.gross_value - app_private.compute_book_depreciation(
      fa.gross_value, fa.residual_value_percent, cat.useful_life_years, fa.book_method,
      fa.put_to_use_date, least(coalesce(fa.disposal_date, p_as_at), p_as_at)
    ),
    fa.disposal_date,
    fa.disposal_value,
    fa.is_active
  from public.fixed_assets fa
  join public.ref_depreciation_categories cat on cat.category_code = fa.category_code
  where fa.company_id = p_company_id
  order by fa.put_to_use_date, fa.name;
$$;

comment on function public.get_fixed_asset_register is
  'Book depreciation per asset as at p_as_at (Schedule II, SLM or WDV per asset). An asset put to use after p_as_at shows zero accumulated depreciation, not an error — the helper function guards p_end < p_start.';


-- ----------------------------------------------------------------------------
-- Tax depreciation — pooled by block, one financial year at a time. Unlike
-- book depreciation this is never a running "as at any date" number; the
-- block-of-assets system only ever produces one WDV per block per complete
-- tax year, so both functions below take a full [fy_start, fy_end] pair.
--
-- app_private.compute_block_year does one year's arithmetic in isolation
-- (shared by both the opening-balance recursion and the reporting function,
-- so the half-year/disposal/cessation logic exists in exactly one place):
--   depreciation = rate x (opening + full_rate_additions - disposals)
--                + (rate / 2) x half_rate_additions
-- unless the block ceases to exist this year (no assets remain) or the
-- pooled base itself goes negative (disposal proceeds alone exceed opening
-- WDV plus additions) — either case stops ordinary depreciation for the
-- year and reports a short-term capital gain (base negative) or loss (block
-- ceased with WDV unrecovered) instead, per Sec 74 (old Sec 50).
-- ----------------------------------------------------------------------------
create type app_private.block_year_movement as (
  depreciation numeric,
  closing_wdv numeric,
  gain numeric,
  loss numeric
);

create or replace function app_private.compute_block_year(
  p_opening numeric,
  p_additions numeric,
  p_half_additions numeric,
  p_disposals numeric,
  p_rate numeric,
  p_remaining int
) returns app_private.block_year_movement
language plpgsql
stable
set search_path = ''
as $$
declare
  v_base numeric := p_opening + p_additions + p_half_additions - p_disposals;
  v_dep numeric := 0;
  v_gain numeric := 0;
  v_loss numeric := 0;
  v_closing numeric := 0;
begin
  if p_remaining = 0 or v_base <= 0 then
    if v_base < 0 then
      v_gain := -v_base;
    elsif v_base > 0 then
      v_loss := v_base;
    end if;
  else
    v_dep := p_rate * (p_opening + p_additions - p_disposals) + (p_rate / 2) * p_half_additions;
    v_dep := greatest(least(v_dep, v_base), 0);
    v_closing := v_base - v_dep;
  end if;

  return row(round(v_dep, 2), round(v_closing, 2), round(v_gain, 2), round(v_loss, 2))::app_private.block_year_movement;
end;
$$;

comment on function app_private.compute_block_year is
  'One block, one tax year of movement — the single place the half-year rule, the ordinary WDV formula, and the block-cessation gain/loss trigger are implemented. Shared by compute_block_opening_wdv''s recursion and get_tax_depreciation_blocks''s reporting year so the two can never drift apart.';


create or replace function app_private.compute_block_opening_wdv(
  p_company_id uuid,
  p_block_code text,
  p_fy_start date
) returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_earliest date;
  v_rate numeric;
  v_wdv numeric := 0;
  v_year int;
  v_ystart date;
  v_yend date;
  v_additions numeric;
  v_half_additions numeric;
  v_disposals numeric;
  v_remaining int;
  v_move app_private.block_year_movement;
begin
  select min(put_to_use_date) into v_earliest
    from public.fixed_assets
   where company_id = p_company_id and it_block = p_block_code;

  if v_earliest is null or v_earliest >= p_fy_start then
    return 0;
  end if;

  select rate_percent / 100 into v_rate
    from public.ref_depreciation_blocks_it
   where block_code = p_block_code;

  v_year := case when extract(month from v_earliest) >= 4
                  then extract(year from v_earliest)::int
                  else extract(year from v_earliest)::int - 1 end;

  loop
    v_ystart := make_date(v_year, 4, 1);
    v_yend := make_date(v_year + 1, 3, 31);
    exit when v_ystart >= p_fy_start;

    select
      coalesce(sum(gross_value) filter (where v_yend - put_to_use_date >= 179), 0),
      coalesce(sum(gross_value) filter (where v_yend - put_to_use_date < 179), 0)
      into v_additions, v_half_additions
      from public.fixed_assets
     where company_id = p_company_id and it_block = p_block_code
       and put_to_use_date between v_ystart and v_yend;

    select coalesce(sum(disposal_value), 0) into v_disposals
      from public.fixed_assets
     where company_id = p_company_id and it_block = p_block_code
       and disposal_date between v_ystart and v_yend;

    select count(*) into v_remaining
      from public.fixed_assets
     where company_id = p_company_id and it_block = p_block_code
       and put_to_use_date <= v_yend
       and (disposal_date is null or disposal_date > v_yend);

    v_move := app_private.compute_block_year(v_wdv, v_additions, v_half_additions, v_disposals, v_rate, v_remaining);
    v_wdv := v_move.closing_wdv;

    v_year := v_year + 1;
  end loop;

  return v_wdv;
end;
$$;

comment on function app_private.compute_block_opening_wdv is
  'A block''s WDV at the start of p_fy_start, by replaying every complete prior tax year from the block''s earliest asset forward through compute_block_year. Bounded by real asset history, not by company age.';


create or replace function public.get_tax_depreciation_blocks(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  block_code text,
  block_description text,
  rate_percent numeric,
  opening_wdv numeric,
  additions numeric,
  disposals numeric,
  depreciation_for_year numeric,
  closing_wdv numeric,
  short_term_capital_gain numeric,
  short_term_capital_loss numeric,
  block_ceased boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  r record;
  v_opening numeric;
  v_additions numeric;
  v_half_additions numeric;
  v_disposals numeric;
  v_remaining int;
  v_move app_private.block_year_movement;
begin
  for r in
    select b.block_code, b.description, b.rate_percent
      from public.ref_depreciation_blocks_it b
     where b.is_active
       and exists (
         select 1 from public.fixed_assets fa
          where fa.company_id = p_company_id and fa.it_block = b.block_code
            and fa.put_to_use_date <= p_fy_end
       )
     order by b.sort_order
  loop
    v_opening := app_private.compute_block_opening_wdv(p_company_id, r.block_code, p_fy_start);

    select
      coalesce(sum(gross_value) filter (where p_fy_end - put_to_use_date >= 179), 0),
      coalesce(sum(gross_value) filter (where p_fy_end - put_to_use_date < 179), 0)
      into v_additions, v_half_additions
      from public.fixed_assets
     where company_id = p_company_id and it_block = r.block_code
       and put_to_use_date between p_fy_start and p_fy_end;

    select coalesce(sum(disposal_value), 0) into v_disposals
      from public.fixed_assets
     where company_id = p_company_id and it_block = r.block_code
       and disposal_date between p_fy_start and p_fy_end;

    select count(*) into v_remaining
      from public.fixed_assets
     where company_id = p_company_id and it_block = r.block_code
       and put_to_use_date <= p_fy_end
       and (disposal_date is null or disposal_date > p_fy_end);

    v_move := app_private.compute_block_year(v_opening, v_additions, v_half_additions, v_disposals, r.rate_percent / 100, v_remaining);

    block_code := r.block_code;
    block_description := r.description;
    rate_percent := r.rate_percent;
    opening_wdv := v_opening;
    additions := v_additions + v_half_additions;
    disposals := v_disposals;
    depreciation_for_year := v_move.depreciation;
    closing_wdv := v_move.closing_wdv;
    short_term_capital_gain := nullif(v_move.gain, 0);
    short_term_capital_loss := nullif(v_move.loss, 0);
    block_ceased := (v_remaining = 0);
    -- Must be bare: a function with OUT parameters (which RETURNS TABLE
    -- creates implicitly) requires RETURN NEXT with no argument — the OUT
    -- parameters themselves carry the row. Real Postgres rejects the
    -- parameterised form here with "RETURN NEXT cannot have a parameter in
    -- function with OUT parameters" (confirmed by actually applying this
    -- migration). check-sql.js knows this specific gap; see its own
    -- comment for why the bundled parser can't read it.
    return next;
  end loop;
end;
$$;

comment on function public.get_tax_depreciation_blocks is
  'Pooled Sec 33 WDV depreciation per block for one tax year [p_fy_start, p_fy_end] — always the calendar April-March year, never companies.financial_year_start_month. Additional depreciation (Sec 33(8)-(9)) is not computed; see the migration header.';
