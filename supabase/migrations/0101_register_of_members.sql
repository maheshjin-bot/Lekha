-- ============================================================================
-- 0101 — Register of Members and share capital (Sec 88 Companies Act 2013)
-- ============================================================================
-- A repo-wide grep for %share%/%capital% against this schema, run by an
-- earlier audit, found nothing except an unrelated ref_entity_types column.
-- There was no representation ANYWHERE of who owns a company, how many
-- shares they hold, or what the company's authorised/paid-up capital even
-- is. Two currently-impossible things follow directly from that gap and are
-- the reason this migration exists, not "completeness for its own sake":
--   * the Sec 2(85) small-company test needs paid-up share capital, and
--   * the Sec 186 investment-ceiling computation (60% of paid-up capital +
--     free reserves + securities premium, or 100% of free reserves +
--     securities premium, whichever is higher) needs the same figure.
-- Neither could be computed before this. get_share_capital_summary below is
-- built to answer exactly that number, per class and in total.
--
-- LEGAL BASIS (WebSearch, Aug 2026, two passes — the second deliberately
-- skeptical about which entity types this actually reaches).
--
-- Sec 88(1)(a) Companies Act 2013 read with Rule 3 of the Companies
-- (Management and Administration) Rules 2014: every company having share
-- capital must maintain a Register of Members in Form MGT-1 from the date
-- of incorporation, separately for each class of shares, showing — per
-- member — name, address, e-mail, PAN or CIN, father's/mother's/spouse's
-- name, occupation, status, nationality, class of shares, number and
-- nominal value held, folio number, date of becoming a member, date of
-- ceasing to be a member, and (per Form PAS-3, confirmed by a further
-- search) the nature of consideration for the allotment — cash, other than
-- cash, or bonus (capitalised from reserves). Entries must be updated
-- within 7 days of an allotment or transfer being approved.
--
-- WHY ONLY pvt_ltd/ltd/opc, EVEN THOUGH SEC 88 ALSO COVERS GUARANTEE
-- COMPANIES. The skeptical second search confirmed Sec 88 is not actually
-- limited to companies WITH share capital — a company limited by guarantee
-- keeps a register too, just of members' guarantee amounts instead of
-- shareholdings. This app's own entity_type enum has no "company limited by
-- guarantee" value at all (confirmed: select distinct entity_type from
-- companies → aop_boi, huf, llp, ltd, opc, partnership, proprietorship,
-- pvt_ltd, society, trust — ten values, guarantee companies are simply not
-- one of them), so that branch of Sec 88 has nothing to attach to and is
-- out of scope here, not silently wrong. Within what the schema CAN
-- represent, ref_entity_types.roc_forms was checked before inventing a new
-- flag: it lists 'MGT-7' for pvt_ltd/ltd and 'MGT-7A' for opc (the annual
-- return that reports share capital) and neither form for llp, which files
-- Form 8/11 instead and has partner CONTRIBUTION under the LLP Act 2008,
-- not shares under the Companies Act at all. So pvt_ltd/ltd/opc — the three
-- entity types with an MGT-7/MGT-7A obligation — is not an invented list,
-- it is what this app's own reference data already distinguishes. Enforced
-- below by a real trigger on share_classes, not left as a UI-only
-- suggestion: see check_company_has_share_capital.
--
-- WHAT THIS SCHEMA CAPTURES, AND WHAT IT HONESTLY DOES NOT.
-- Built: name, address, PAN, occupation, class, number and nominal value of
-- shares, folio number, date of allotment, date of cessation, and
-- consideration type. NOT built: e-mail, father's/mother's/spouse's name,
-- status (individual/body corporate/trust), nationality, joint-holder
-- names, or a minor's guardian — all real Rule 3 / Form MGT-1 fields this
-- table does not have columns for. A business genuinely needing the full
-- statutory register should treat this as the ledger of WHO HOLDS WHAT
-- (which is what the paid-up-capital computation needs) rather than a
-- filing-ready MGT-1 export. Said here and repeated in the UI copy and the
-- structured report's scope_deferred, per this app's own house rule against
-- fabricating completeness.
--
-- CLASS OF SHARES IS FREE TEXT, NOT AN ENUM. Sec 43 permits equity (with
-- differential rights) and preference (cumulative/non-cumulative,
-- convertible/non-convertible, participating/non-participating — and
-- combinations of those). A fixed list would either be incomplete or grow
-- without bound; "Equity" / "Preference" are the two examples suggested by
-- the task, not a closed set enforced here.
--
-- WHY authorized_shares/shares_held ARE numeric(18,3), NOT AN INTEGER TYPE.
-- Matches this schema's own existing convention for share/unit counts
-- (voucher_items.quantity, order_items.quantity, bom_components.quantity
-- are all numeric(18,3)) rather than inventing a new precision. Real
-- allotments are whole shares in the ordinary case; this does not add a
-- whole-number CHECK because bonus/rights-issue fractional entitlements are
-- a real (if usually trustee-mediated) occurrence and rejecting them would
-- be a false negative, the same reasoning 0085 gives for not over-tightening
-- a format check.
--
-- THE AUTHORIZED-CAPITAL CEILING IS A REAL ENFORCED INVARIANT, NOT JUST
-- ARITHMETIC IN THE SUMMARY. Sec 61(1)(a) lets a company increase its
-- authorised capital, but issuing beyond what is CURRENTLY authorised is
-- not a bookkeeping choice, it is not legally possible. Allowing this
-- schema to silently hold share_holdings that sum past share_classes.
-- authorized_shares would let the paid-up-capital figure this migration
-- exists to compute become a number that could not lawfully exist. See
-- check_share_holdings_within_authorized below — it is a real BEFORE
-- trigger, not a comment.
--
-- CESSATION, NEVER DELETION. Sec 88 requires the register to show who
-- CEASED to be a member and when, not just who currently is one — a
-- deleted row cannot answer that question a year later. date_of_cessation
-- is nullable and the UI records it as a field edit, exactly the same
-- pattern company_directors (0088) already uses for a director who leaves
-- the board. A holding with a cessation date is excluded from "currently
-- held" (and therefore from paid-up capital and from the authorized-ceiling
-- check) but stays in the table.
--
-- WHAT "ISSUED SHARES" MEANS HERE. This schema does not distinguish a
-- transfer (member A's holding ends, member B's begins, total unchanged) from
-- a buyback (a holding ends and nothing replaces it, total falls). Both look
-- identical: one share_holdings row gets a date_of_cessation. So
-- get_share_capital_summary reports issued/paid-up capital as the sum over
-- CURRENTLY HELD rows (date_of_cessation is null) — the capital actually
-- subsisting today — rather than a cumulative historical issuance figure
-- that would double-count every transfer. That is also exactly the number
-- Sec 2(85) and Sec 186 need: paid-up capital AS OF NOW, not ever-issued.
--
-- RLS MIRRORS company_directors (0088) EXACTLY — member read via
-- is_company_member, member-with-write-role write via can_write_company —
-- verified live at `select policyname, cmd, qual, with_check from
-- pg_policies where tablename = 'company_directors'` before writing the
-- policies below. Ownership data is sensitive but this app's own precedent
-- (company_directors, itself public MCA-filed information once filed) puts
-- it at the can_write_company tier, not the stricter is_company_admin tier
-- reserved for salary data.
--
-- WHAT THIS DOES NOT DO: generate Form MGT-1 or MGT-7/MGT-7A itself, verify
-- a PAN against the Income Tax database, compute Sec 2(85)/Sec 186 THEMSELVES
-- (this migration only makes the one input — paid-up capital — computable;
-- those tests also need turnover, borrowings, free reserves and securities
-- premium, none of which is this migration's job), or model share transfers
-- as a linked debit/credit pair — a transfer here is two independent edits
-- (old holder's row gets a cessation date, new holder gets a new row), which
-- is enough to keep the register honest but does not itself enforce that the
-- transferred share count matches, the same manual-linkage tradeoff 0059
-- (orders → vouchers) already made for a different pair of tables.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- public.share_classes
-- ----------------------------------------------------------------------------
create table public.share_classes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  class_name text not null check (length(trim(class_name)) > 0),
  -- Face value per share, in Rupees. Money-shaped, so numeric(18,2) matches
  -- this schema's debit_amount/credit_amount precision, not the (18,3)
  -- quantity convention used just below for share counts.
  nominal_value_per_share numeric(18,2) not null check (nominal_value_per_share > 0),
  -- Share-count precision — see migration header for why (18,3), matching
  -- voucher_items.quantity/order_items.quantity/bom_components.quantity.
  authorized_shares numeric(18,3) not null check (authorized_shares > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, class_name)
);

-- Needed for the composite FK from share_holdings — this schema's own
-- convention (branches_id_company_id_key, and every other tenant-scoped
-- parent a child references) is a bare id-to-id FK lets a write silently
-- attach a row to the wrong tenant's parent, since RLS filters SELECT but
-- not writes.
create unique index share_classes_id_company_id_key on public.share_classes (id, company_id);

create trigger set_updated_at before update on public.share_classes
  for each row execute function app_private.set_updated_at();

-- ----------------------------------------------------------------------------
-- app_private.check_company_has_share_capital — enforces the pvt_ltd/ltd/opc
-- gate as a real invariant, not just a UI suggestion. See migration header.
-- ----------------------------------------------------------------------------
create or replace function app_private.check_company_has_share_capital()
returns trigger
language plpgsql
set search_path to ''
as $fn$
declare
  v_entity_type text;
begin
  select entity_type into v_entity_type from public.companies where id = new.company_id;
  if v_entity_type is null or v_entity_type not in ('pvt_ltd', 'ltd', 'opc') then
    raise exception
      'Share capital does not apply to this company''s entity type (%). Only a company limited by shares — pvt_ltd, ltd or opc in this app''s own entity types — can have a Register of Members under Sec 88; an LLP has partner contribution instead of shares, and a proprietorship/partnership/HUF/AOP/trust/society has no share capital at all.',
      coalesce(v_entity_type, 'unknown');
  end if;
  return new;
end;
$fn$;

create trigger share_classes_entity_type_check
  before insert on public.share_classes
  for each row execute function app_private.check_company_has_share_capital();

-- ----------------------------------------------------------------------------
-- public.share_holdings
-- ----------------------------------------------------------------------------
create table public.share_holdings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  share_class_id uuid not null,
  holder_name text not null check (length(trim(holder_name)) > 0),
  holder_pan text check (app_private.is_valid_pan(holder_pan)),
  holder_address text,
  -- Rule 3(1) fields this table does honour, beyond the task's base column
  -- list — see migration header for why these two were added and the
  -- longer list (e-mail, parent/spouse name, status, nationality, joint
  -- holders, minor's guardian) was not.
  holder_occupation text,
  -- Form PAS-3's own three categories (confirmed by WebSearch) — bonus
  -- shares are capitalised from reserves and are never "other than cash".
  consideration text check (consideration is null or consideration in ('cash', 'other_than_cash', 'bonus')),
  shares_held numeric(18,3) not null check (shares_held > 0),
  date_of_allotment date not null,
  date_of_cessation date,
  folio_number text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (date_of_cessation is null or date_of_cessation >= date_of_allotment),
  -- COMPOSITE, not a plain reference to share_classes(id) — see migration
  -- header and this schema's standing tenancy convention.
  foreign key (share_class_id, company_id) references public.share_classes (id, company_id)
);

create index share_holdings_company_idx on public.share_holdings (company_id, share_class_id);
create index share_holdings_class_current_idx on public.share_holdings (share_class_id) where date_of_cessation is null;

create trigger set_updated_at before update on public.share_holdings
  for each row execute function app_private.set_updated_at();

-- ----------------------------------------------------------------------------
-- app_private.check_share_holdings_within_authorized — Sec 61: issued shares
-- can never exceed what is currently authorised. Real invariant, not just
-- arithmetic in the summary function. See migration header.
-- ----------------------------------------------------------------------------
create or replace function app_private.check_share_holdings_within_authorized()
returns trigger
language plpgsql
set search_path to ''
as $fn$
declare
  v_authorized numeric;
  v_other_current numeric;
begin
  -- A row being recorded as ceased frees capacity rather than consuming it;
  -- nothing to check.
  if new.date_of_cessation is not null then
    return new;
  end if;

  select authorized_shares into v_authorized
    from public.share_classes
    where id = new.share_class_id;

  if v_authorized is null then
    raise exception 'Share class % not found for this company.', new.share_class_id;
  end if;

  select coalesce(sum(shares_held), 0) into v_other_current
    from public.share_holdings
    where share_class_id = new.share_class_id
      and date_of_cessation is null
      and id <> new.id;

  if v_other_current + new.shares_held > v_authorized then
    raise exception
      'This allotment (% shares) would bring total currently-held shares for this class to %, exceeding the authorized % shares. Increase authorized capital (Sec 61) before allotting further, or record a cessation to free up room.',
      new.shares_held, v_other_current + new.shares_held, v_authorized;
  end if;

  return new;
end;
$fn$;

create trigger share_holdings_authorized_check
  before insert or update of shares_held, date_of_cessation, share_class_id on public.share_holdings
  for each row execute function app_private.check_share_holdings_within_authorized();

-- ----------------------------------------------------------------------------
-- RLS — mirrors company_directors (0088) exactly. See migration header.
-- ----------------------------------------------------------------------------
alter table public.share_classes enable row level security;

create policy share_classes_read on public.share_classes
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy share_classes_write on public.share_classes
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

alter table public.share_holdings enable row level security;

create policy share_holdings_read on public.share_holdings
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy share_holdings_write on public.share_holdings
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.share_classes is
  'Share capital structure, Sec 88/Sec 61 Companies Act 2013 — one row per class (e.g. Equity, Preference) with face value and authorized share count. Only insertable for a company whose entity_type is pvt_ltd/ltd/opc (enforced by check_company_has_share_capital) — the three entity types this app''s own ref_entity_types.roc_forms flags as filing MGT-7/MGT-7A. See 0101.';

comment on table public.share_holdings is
  'Register of Members, Sec 88 Companies Act 2013 / Form MGT-1 (partial — see 0101 header for the Rule 3 fields not captured: e-mail, parent/spouse name, status, nationality, joint holders, minor guardian). A holding that ends gets date_of_cessation set, never a delete — Sec 88 requires showing who ceased and when. Currently-held rows (date_of_cessation is null) cannot sum past share_classes.authorized_shares for the same class (enforced by check_share_holdings_within_authorized).';

comment on column public.share_holdings.consideration is
  'Form PAS-3''s three allotment categories: cash, other_than_cash (needs a registered valuer''s report per Sec 39), or bonus (capitalised from reserves, never "other than cash"). Nullable — this app does not require it to record a holding.';

comment on column public.share_holdings.holder_pan is
  'Checked via app_private.is_valid_pan when present, same as company_directors.pan — nullable because a minor or NRI member may genuinely have none on file.';

-- ----------------------------------------------------------------------------
-- public.get_share_capital_summary — the figure Sec 2(85) (small company)
-- and Sec 186 (investment ceiling) both need: paid-up capital, per class and
-- summable to a company total. See migration header for why "issued" here
-- means "currently held", not "ever allotted".
-- ----------------------------------------------------------------------------
create or replace function public.get_share_capital_summary(p_company_id uuid)
returns table (
  share_class_id uuid,
  class_name text,
  nominal_value_per_share numeric,
  authorized_shares numeric,
  authorized_capital numeric,
  issued_shares numeric,
  unissued_shares numeric,
  paid_up_capital numeric,
  current_holder_count bigint
)
language plpgsql
stable
set search_path to ''
as $fn$
begin
  if not app_private.is_company_member(p_company_id) then
    raise exception 'Not permitted to view this company''s share capital.';
  end if;

  return query
    select
      sc.id,
      sc.class_name,
      sc.nominal_value_per_share,
      sc.authorized_shares,
      round(sc.authorized_shares * sc.nominal_value_per_share, 2),
      coalesce(sum(sh.shares_held) filter (where sh.date_of_cessation is null), 0),
      sc.authorized_shares - coalesce(sum(sh.shares_held) filter (where sh.date_of_cessation is null), 0),
      round(coalesce(sum(sh.shares_held) filter (where sh.date_of_cessation is null), 0) * sc.nominal_value_per_share, 2),
      count(sh.id) filter (where sh.date_of_cessation is null)
    from public.share_classes sc
    left join public.share_holdings sh
      on sh.share_class_id = sc.id and sh.company_id = sc.company_id
    where sc.company_id = p_company_id
    group by sc.id, sc.class_name, sc.nominal_value_per_share, sc.authorized_shares
    order by sc.class_name;
end;
$fn$;

revoke all on function public.get_share_capital_summary(uuid) from public, anon;
grant execute on function public.get_share_capital_summary(uuid) to authenticated;

comment on function public.get_share_capital_summary(uuid) is
  'Per share class: authorized capital, currently-issued shares and paid-up capital (shares currently held x nominal value), and headroom left under the authorized ceiling. This is the input Sec 2(85) (small company paid-up-capital test) and Sec 186 (investment ceiling) both need and neither could previously compute — sum paid_up_capital across rows for the company-wide figure. See 0101.';
