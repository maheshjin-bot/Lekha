-- ============================================================================
-- 2030 — A manufacturer with separate Raw Material and Finished Goods Stock
--        ledgers can never run post_closing_stock
-- ============================================================================
-- REPORTED. TEST Precision Engineering Pvt Ltd (f2557c28-73ec-43a1-9769-
-- d346e21548f6) keeps two ledgers under the one native "Stock-in-Hand"
-- account GROUP: "Raw Material Stock" and "Finished Goods Stock" — Schedule
-- III's own recommended presentation for a manufacturer (see part 3 below),
-- not a data-entry mistake. Neither carries a ledger-level role override, so
-- both inherit the group's ledger_role='stock', and app_private.
-- ledger_for_role('stock') correctly, deliberately refuses: 1200/1210/1220
-- built that refusal on purpose, after a real bug where GUESSING which of
-- two same-role ledgers to use silently produced a 9,84,000 wrong profit.
-- post_closing_stock and app_private.ensure_stock_ledgers both called
-- ledger_for_role(company,'stock') directly and both inherited that refusal
-- — confirmed live before writing this, ledger_for_role('stock') for this
-- company raises 'This company has 2 ledgers acting as stock: Finished
-- Goods Stock (empty); Raw Material Stock (opening 5,70,000.00). Keep
-- "Raw Material Stock"...'. Worse, ensure_stock_ledgers aborts on that same
-- call BEFORE it ever reaches the line that creates the changes_in_
-- inventories ledger, so this company has NONE — confirmed live, zero rows
-- anywhere in public.ledgers for this company with effective role
-- changes_in_inventories, until part 5 below.
--
-- Grepped the whole live catalogue before writing this (see part 6's own
-- assertion): app_private.ledger_for_role is called with p_role='stock' in
-- exactly these two functions, nowhere else — every other report (balance
-- sheet, CMA, drawing power) already reads BOTH stock ledgers correctly
-- today because they group by nature/group, not by resolving a single
-- ledger id. This is a narrowly-scoped defect with a narrowly-scoped fix.
--
-- ----------------------------------------------------------------------------
-- 1. WHAT ALREADY EXISTS TO HANG "which stock ledger does this item belong
--    to" ON — investigated, not assumed, before designing anything new.
-- ----------------------------------------------------------------------------
-- public.items.category is free text, not a foreign key, and is NULL on
-- every single one of this company's five goods items (checked live) — it
-- is used today only as a display/grouping label in trade analysis (1540),
-- never as an accounting classification, and it would need a parallel
-- "which category maps to which ledger" table to mean anything here, which
-- is strictly more machinery than a direct pointer.
-- public.godowns carries no group/ledger pointer of any kind — a godown is
-- a physical location, orthogonal to which balance-sheet ledger an item's
-- value sits in (the same godown can shelve both raw material and finished
-- goods).
-- public.bill_of_materials.output_item_id names the ONE item that is a BOM
-- output (a finished good, by construction) but says nothing about the
-- other four — Machined Flange Bracket FB-200 has no BOM row at all and is
-- just as much a finished good. A BOM is the wrong table to hang this on:
-- a trading company with no manufacturing module can still legitimately
-- split Raw Material Stock from Finished Goods Stock (e.g. an importer who
-- also lightly assembles), and would have no BOM rows to read at all.
-- CONCLUSION: nothing existing does this job. A new, narrow mechanism is
-- needed, exactly as the finding anticipated.
--
-- ----------------------------------------------------------------------------
-- 2. THE MECHANISM: a nullable per-item pointer, default meaning "there is
--    only one company-wide stock ledger; use it."
-- ----------------------------------------------------------------------------
-- public.items.stock_ledger_id — nullable, references public.ledgers(id,
-- company_id) so it can never point at another company's ledger, enforced
-- by trigger (below) to additionally require the target's EFFECTIVE role
-- (coalesce(ledger, group), 1200's own coalesce) actually be 'stock'.
-- NULL is the default and stays correct, unchanged, for every company that
-- has zero or one stock ledger — which, checked live across the WHOLE
-- database before writing this, is every company except this one: a single
-- query for company_id having count(*) > 1 where effective role = 'stock'
-- returns exactly one row, TEST Precision Engineering. Setting the column
-- is only ever REQUIRED when a company has genuinely created more than one,
-- and only for that company's own items.
-- app_private.item_stock_ledger(company, item) is the new resolver:
--   1. the item's own stock_ledger_id, if set;
--   2. else the company's single stock-role ledger, if there is exactly
--      one (the ordinary case, unchanged from today);
--   3. else — more than one exists and this item has no explicit choice —
--      raise, naming the ITEM as well as the candidate ledgers, so the
--      preparer knows exactly which of their five items still needs an
--      answer rather than being told the company-level fact all over again.
-- This does not touch app_private.ledger_for_role itself, does not weaken
-- its refuse-on-ambiguity guarantee for 'stock' or any other role, and does
-- not change what it returns for any existing caller — post_depreciation,
-- the tax computations and get_cash_flow_statement all keep asking a
-- question ("is there exactly one depreciation/accumulated-depreciation
-- ledger?") that a manufacturer's legitimate two-stock-ledger chart has no
-- bearing on.
--
-- ----------------------------------------------------------------------------
-- 3. PER-ITEM STOCK LEDGERS: WHY THIS IS A REAL, SCHEDULE-III-SANCTIONED
--    CHART-OF-ACCOUNTS CHOICE, NOT A DATA ERROR TO MERGE AWAY.
-- ----------------------------------------------------------------------------
-- Schedule III (Companies Act 2013, Division I and II identically), Part I
-- — Balance Sheet, Notes to Accounts — requires Inventories to be
-- sub-classified as (a) Raw materials (b) Work-in-progress (c) Finished
-- goods (d) Stock-in-trade (goods acquired for trading) (e) Stores and
-- spares (f) Loose tools (g) Others. A company is free to carry that
-- split as separate LEDGERS rather than one ledger with a manual note-level
-- break-up, and a manufacturer doing exactly that — Raw Material Stock,
-- Finished Goods Stock — is the textbook case, not an edge case.
-- Sources: https://ca2013.com/schedule/7501/ ,
-- https://resource.cdn.icai.org/56994bos46206cp5annex.pdf (ICAI's own
-- hosted copy of the bare Schedule III text), cross-checked against
-- 0210's own independently-sourced quote of the same clause list.
--
-- ----------------------------------------------------------------------------
-- 4. CHANGES IN INVENTORIES: ONE LEDGER FOR THE WHOLE COMPANY, DECIDED AND
--    JUSTIFIED, NOT ONE PER STOCK LEDGER.
-- ----------------------------------------------------------------------------
-- The SAME Schedule III (Part II — Statement of Profit and Loss, heading
-- "Expenses") presents "Changes in inventories of finished goods,
-- work-in-progress and stock-in-trade" as ONE line, item (c) — unlike the
-- Balance Sheet note, the P&L format has no provision for splitting this by
-- inventory category at all; the whole point of the line is to net the
-- period's total inventory movement against the period's total purchases so
-- Cost of Materials Consumed / Purchases of Stock-in-Trade read as
-- consumption, not gross spend. A second, third, fourth changes_in_
-- inventories ledger would not correspond to any Schedule III line a real
-- company could file — there is nowhere on the face of the P&L for it to
-- go — whereas a second STOCK ledger corresponds directly to the Balance
-- Sheet note's own sub-classification (part 3 above). So: exactly one
-- changes_in_inventories ledger continues to serve the whole company,
-- whatever number of stock ledgers back it, and post_closing_stock (part 5)
-- posts each stock ledger's own movement as its own line in the SAME
-- voucher, netted into that one shared ledger. ensure_stock_ledgers keeps
-- creating it by app_private.ledger_for_role — which is exactly right here:
-- if a company ever ends up with a SECOND changes_in_inventories ledger
-- that really would be a duplicate to merge, the same situation 1200 was
-- built to catch, not a legitimate multiplicity the way two stock ledgers
-- is.
-- Confirmed live before writing this: TEST Precision Engineering's own
-- Changes in Inventories ledger already exists (created earlier, out of
-- band, by a different session's manual workaround journal — see part 5's
-- own note) and is the ONLY ledger of that role for this company, so this
-- design requires no further action for it.
--
-- ----------------------------------------------------------------------------
-- 5. THE ACTUAL FIX
-- ----------------------------------------------------------------------------
-- app_private.ensure_stock_ledgers: the "should I create a default stock
-- ledger" question is answered by COUNTING stock-role ledgers directly
-- instead of calling app_private.ledger_for_role('stock') and treating any
-- exception as fatal. Zero -> create the default, exactly as before. One
-- -> skip, exactly as before (ledger_for_role would have returned that one
-- id and skipped too — no behaviour change for the single-ledger case,
-- which is every other company in the database). Two or more -> skip,
-- because nothing needs creating — this is the one branch that used to
-- raise and abort the function before it ever reached the changes_in_
-- inventories check that follows. The changes_in_inventories check itself
-- is untouched (part 4).
--
-- public.post_closing_stock: instead of resolving ONE v_stock_ledger up
-- front, it groups get_stock_summary's rows by app_private.
-- item_stock_ledger(company, item_id) and computes a separate target /
-- carried / delta for EACH resolved ledger, posting a line for every ledger
-- whose delta is nonzero. The total of those deltas — algebraically the
-- exact same number the single-ledger code already computed as v_delta,
-- since it is the same sum over the same rows just grouped differently —
-- is the one line posted to Changes in Inventories, so the voucher balances
-- by construction with no special-casing. When there genuinely is only one
-- stock ledger (every company except this one) there is exactly one group,
-- and this reduces to arithmetically the SAME target, carried, delta and
-- v_target as the pre-2030 code, over the identical rows — the control
-- case this migration must not move. The 1450 negative-valuation refusal is
-- untouched verbatim: a negative closing value is never an asset regardless
-- of which stock ledger the item resolves to.
--
-- A ONE-TIME DATA BACKFILL for the one real company already in this shape.
-- Confirmed live, not assumed: a query for company_id having count(*) > 1
-- ledgers at effective role 'stock', across every company in this database,
-- returns exactly one row — TEST Precision Engineering Pvt Ltd. Its five
-- goods items are backfilled to the RM/FG split below. This is not a guess:
-- it matches, item for item, the split an earlier session's own manual
-- workaround journal already used and posted into this company's real
-- books (voucher HOJRN26/0004, 12 Sep 2026, narration "manual journal,
-- split by RM/FG... Target RM 780711.68, FG 560372.17") — recomputed
-- independently below from get_stock_summary as at 11 Sep 2026 (the day
-- before that voucher, so unaffected by it) and confirmed to the paisa: RM
-- {Alloy Steel Billet EN8, Hex Bolt M8x40 Zinc Plated, MS Round Bar 25mm} =
-- 2,72,400.00 + 80,097.39 + 4,28,214.29 = 7,80,711.68; FG {Machined Flange
-- Bracket FB-200, Precision Shaft SH-100} = 2,11,905.00 + 3,48,467.17 =
-- 5,60,372.17. It is also independently corroborated by this company's own
-- Bill of Materials: Precision Shaft SH-100 is the one BOM output on
-- record, consuming MS Round Bar 25mm and Hex Bolt M8x40 Zinc Plated as
-- components — exactly the raw-material/finished-good line drawn here.
-- No other company in the database is touched — this is a one-off data fix
-- for the one company the finding names, not a general heuristic; a
-- DIFFERENT company that later creates a second stock ledger will need its
-- own items assigned by hand. There is no on-screen picker for stock_
-- ledger_id yet (see the report's "What I did not fix" section) — that is
-- a frontend change, out of this migration-only task's scope.
--
-- A SECURITY FIX FOUND WHILE RESTATING THIS FUNCTION'S GRANTS, same class
-- as the standing "anon inherits PUBLIC" lesson: app_private.
-- ensure_stock_ledgers held EXECUTE for PUBLIC (confirmed live via
-- information_schema.routine_privileges before writing this), which anon
-- inherits — tightened here to authenticated only, since this migration
-- already has to CREATE OR REPLACE it. app_private.ensure_depreciation_
-- ledgers has the exact same PUBLIC grant and is NOT touched here — it is
-- outside this task's owned-function list — and is reported separately.
--
-- ----------------------------------------------------------------------------
-- 6. GUARDRAILS
-- ----------------------------------------------------------------------------
-- Every live function this migration replaces is read with pg_get_
-- functiondef and asserted to still be the expected pre-2030 version before
-- being replaced, so a concurrent edit to a function this task owns is
-- caught rather than silently clobbered. A closing assertion confirms
-- ledger_for_role itself is untouched by this file (its own source text
-- does not appear as a CREATE OR REPLACE target anywhere below) and that no
-- OTHER live function calls ledger_for_role with p_role='stock' — if one
-- ever does, it has the same bug this migration fixes and needs the same
-- treatment, not a silent pass.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Part A — the column, its guard, and the resolver
-- ---------------------------------------------------------------------------

alter table public.items
  add column stock_ledger_id uuid null;

alter table public.items
  add constraint items_stock_ledger_fk
    foreign key (stock_ledger_id, company_id)
    references public.ledgers (id, company_id)
    on delete set null;

comment on column public.items.stock_ledger_id is
  'Which specific ledger_role=stock ledger this item''s closing value posts to (2030). NULL -- the default, and correct for every company with zero or one stock ledger, which is every company but one as of 2030 -- means "resolve the company''s single stock ledger"; app_private.item_stock_ledger is the only reader and the only place this should ever be resolved. Only needs setting when a company has deliberately created more than one stock-role ledger (e.g. separate Raw Material and Finished Goods Stock for a manufacturer -- a legitimate Schedule III presentation, not a data error) and this item must say which one it belongs to. Enforced by trigger, not a plain CHECK, because it must additionally verify the target ledger''s EFFECTIVE role (coalesce(ledger, group)) is actually ''stock'' -- see enforce_item_stock_ledger_role.';

create or replace function app_private.enforce_item_stock_ledger_role()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_role text;
begin
  if new.stock_ledger_id is null then
    return new;
  end if;

  if new.item_type <> 'goods' or not new.maintain_stock then
    raise exception 'stock_ledger_id only applies to a stock-maintained goods item';
  end if;

  select coalesce(l.ledger_role, g.ledger_role) into v_role
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where l.id = new.stock_ledger_id
     and l.company_id = new.company_id;

  if v_role is null then
    -- The composite FK will also refuse this; this check exists to give a
    -- clearer message and to fire even while the FK's own check is pending
    -- (BEFORE ROW triggers run ahead of FK enforcement).
    raise exception 'stock_ledger_id must reference a ledger belonging to this item''s own company';
  end if;

  if v_role <> 'stock' then
    raise exception 'stock_ledger_id must reference a ledger whose effective role is stock (this one resolves to %)', v_role;
  end if;

  return new;
end;
$fn$;

revoke all on function app_private.enforce_item_stock_ledger_role() from public, anon;

create trigger enforce_item_stock_ledger_role
  before insert or update of stock_ledger_id, company_id, item_type, maintain_stock on public.items
  for each row execute function app_private.enforce_item_stock_ledger_role();

create or replace function app_private.item_stock_ledger(p_company_id uuid, p_item_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  v_explicit uuid;
  v_item_name text;
  v_ids uuid[];
  v_names text;
begin
  select i.stock_ledger_id, i.name into v_explicit, v_item_name
    from public.items i
   where i.id = p_item_id and i.company_id = p_company_id;

  if v_explicit is not null then
    return v_explicit;
  end if;

  -- No explicit choice on the item. The ordinary path: the company's single
  -- stock-role ledger. This mirrors app_private.ledger_for_role's own
  -- candidate query rather than calling it, because the ambiguous case
  -- below needs the ITEM named in the message, which ledger_for_role's own
  -- (correct, and deliberately untouched) exception cannot know about.
  select array_agg(l.id order by l.name), string_agg(l.name, ', ' order by l.name)
    into v_ids, v_names
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where l.company_id = p_company_id
     and coalesce(l.ledger_role, g.ledger_role) = 'stock';

  if v_ids is null or cardinality(v_ids) = 0 then
    return null;
  end if;

  if cardinality(v_ids) = 1 then
    return v_ids[1];
  end if;

  raise exception
    'This company has % ledgers acting as stock (%) and item "%" does not say which one it belongs to. Set that item''s stock ledger to one of them (there is no on-screen picker for this yet -- items.stock_ledger_id needs setting directly), then close again.',
    cardinality(v_ids), v_names, coalesce(v_item_name, p_item_id::text)
    using errcode = '23505';
end;
$fn$;

revoke all on function app_private.item_stock_ledger(uuid, uuid) from public, anon;
grant execute on function app_private.item_stock_ledger(uuid, uuid) to authenticated;

comment on function app_private.item_stock_ledger(uuid, uuid) is
  'Which stock-role ledger ONE ITEM''s closing value belongs to (2030): the item''s own stock_ledger_id if set, else the company''s single stock ledger, else -- more than one exists and this item has no explicit choice -- raises, naming the item and the candidates. The per-item counterpart to app_private.ledger_for_role, which answers the company-level question and is left untouched. Used by post_closing_stock to post each stock ledger its own correct movement instead of assuming there is exactly one.';

-- ---------------------------------------------------------------------------
-- Part B — ensure_stock_ledgers: stop aborting on a legitimate plurality
-- ---------------------------------------------------------------------------

do $mig$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'ensure_stock_ledgers' and p.prokind = 'f';

  if v_def is null then
    raise exception '2030: app_private.ensure_stock_ledgers is missing.';
  end if;

  if position('app_private.ledger_for_role(p_company_id, ''stock'')' in v_def) = 0 then
    raise exception '2030: app_private.ensure_stock_ledgers is not the expected pre-2030 version (no call to ledger_for_role(...,''stock'')); its body has moved. Re-derive this rewrite by hand against the live definition before proceeding.';
  end if;
end;
$mig$;

create or replace function app_private.ensure_stock_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_stock_group uuid;
  v_expense_group uuid;
  v_stock_ledger_count int;
begin
  select id into v_stock_group
    from public.account_groups
   where company_id = p_company_id and name = 'Stock-in-Hand'
   limit 1;

  select id into v_expense_group
    from public.account_groups
   where company_id = p_company_id and name = 'Direct Expenses'
   limit 1;

  if v_stock_group is null or v_expense_group is null then
    raise exception 'Chart of accounts is missing the Stock-in-Hand or Direct Expenses group; seed it first';
  end if;

  -- By ROLE, not by name (1200). COUNTED directly rather than routed through
  -- app_private.ledger_for_role: that resolver RAISES on more than one,
  -- which is exactly right for a caller that needs THE ledger, but this
  -- caller only needs to know whether to CREATE one, and letting that raise
  -- abort the whole function is what left a fresh manufacturer with two
  -- legitimate stock ledgers (Raw Material Stock, Finished Goods Stock --
  -- Schedule III's own recommended presentation, see 2030) with NO
  -- changes_in_inventories ledger anywhere in the database: the function
  -- never reached the block below that creates it. Zero stock ledgers ->
  -- create the default, as before. One -> skip, as before. Two or more ->
  -- skip, because a legitimate plurality needs nothing created for it.
  select count(*) into v_stock_ledger_count
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where l.company_id = p_company_id
     and coalesce(l.ledger_role, g.ledger_role) = 'stock';

  if v_stock_ledger_count = 0 then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_stock_group, 'Stock-in-Hand', 'debit', 0);
  end if;

  -- Schedule III's own name for this line. Lives under Direct Expenses and
  -- normally carries a CREDIT balance -- see 0076's header for why it is not
  -- a direct_income ledger. ledger_role='changes_in_inventories' (0210)
  -- overrides Direct Expenses' own group default (cost_of_materials) since
  -- this one specific ledger is not a materials-purchase ledger at all.
  -- Exactly ONE serves the whole company, whatever number of stock ledgers
  -- back it (2030 part 4): Schedule III's Statement of P&L presents
  -- "changes in inventories" as a single line, unlike the Balance Sheet
  -- inventory note, which does break the closing figure down by category.
  -- Still created and located by ledger_for_role, which correctly still
  -- raises if a company ever ends up with more than one of THIS role --
  -- that really would be a duplicate to merge, not a legitimate plurality.
  if app_private.ledger_for_role(p_company_id, 'changes_in_inventories') is null then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount, ledger_role)
    values (p_company_id, v_expense_group, 'Changes in Inventories', 'debit', 0, 'changes_in_inventories');
  end if;
end;
$fn$;

-- 2030: closing the PUBLIC-execute hole found while restating this
-- function's grants -- anon inherits PUBLIC (the standing lesson; revoking
-- from anon alone is a no-op). app_private.ensure_depreciation_ledgers has
-- the identical hole and is reported separately -- it is not owned by this
-- task.
revoke all on function app_private.ensure_stock_ledgers(uuid) from public, anon;
grant execute on function app_private.ensure_stock_ledgers(uuid) to authenticated;

comment on function app_private.ensure_stock_ledgers(uuid) is
  'Creates the default Stock-in-Hand and Changes in Inventories ledgers for a company that has none, by ROLE not by name (1200). A company with more than one stock-role ledger already (a manufacturer legitimately splitting Raw Material from Finished Goods Stock, 2030) needs nothing created for the stock side and is no longer treated as an error here -- only app_private.ledger_for_role(''stock'') still raises for a caller that needs a single answer. Exactly one changes_in_inventories ledger continues to serve the whole company regardless (2030 part 4).';

-- ---------------------------------------------------------------------------
-- Part C — post_closing_stock: post every resolved stock ledger its own
--          movement, net into the one shared Changes in Inventories ledger
-- ---------------------------------------------------------------------------

do $mig$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_closing_stock' and p.prokind = 'f';

  if v_def is null then
    raise exception '2030: public.post_closing_stock is missing.';
  end if;

  if position('v_stock_ledger  := app_private.ledger_for_role(p_company_id, ''stock'');' in v_def) = 0
     or position('v_negative' in v_def) = 0 then
    raise exception '2030: public.post_closing_stock is not the expected pre-2030 (1450) version -- its body has moved. Re-derive this rewrite by hand against the live definition before proceeding.';
  end if;
end;
$mig$;

create or replace function public.post_closing_stock(
  p_company_id uuid,
  p_branch_id uuid,
  p_as_at date,
  p_narration text default null
) returns uuid
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_change_ledger uuid;
  v_target numeric;
  v_negative text;
  v_lines jsonb := '[]'::jsonb;
  v_total_delta numeric := 0;
  v_any_stock_line boolean := false;
  v_rec record;
  v_carried numeric;
  v_delta numeric;
  v_voucher_id uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to post for this company';
  end if;

  perform app_private.ensure_stock_ledgers(p_company_id);

  v_change_ledger := app_private.ledger_for_role(p_company_id, 'changes_in_inventories');

  if v_change_ledger is null then
    raise exception 'This company has no inventory ledger to post against; check the chart of accounts.';
  end if;

  -- 1450: a negative valuation is not an asset, and it is not really a
  -- valuation either -- it is the books saying a purchase or a delivery is
  -- missing. Summing it in nets a credit inside a debit asset and understates
  -- cost of sales by the same amount, while the journal still balances and
  -- every self-consistency check in the app still passes. Refuse, and name the
  -- items; excluding them silently would be just as wrong the other way.
  -- The test is closing_value, not closing_quantity: a negative quantity on an
  -- item that never had a costed receipt values at rate 0 and capitalises
  -- nothing, and eight live companies carry exactly that shape. Unchanged by
  -- 2030 -- which stock ledger an item resolves to has no bearing on whether
  -- its own valuation is negative.
  select string_agg(
           s.item_name
             || ' ('
             || rtrim(trim(to_char(s.closing_quantity, 'FM9999999999990.999')), '.')
             || ' ' || s.uom || ', '
             || trim(to_char(s.closing_value, 'FM9999999999990.00')) || ')',
           '; ' order by s.item_name)
    into v_negative
    from public.get_stock_summary(p_company_id, p_as_at, null) s
   where s.closing_value < 0;

  if v_negative is not null then
    raise exception
      'Closing stock cannot be posted as at %. These items value out negative -- more has gone out than ever came in: %. Negative stock is not an asset and must not go onto the balance sheet. Record the missing purchase or delivery, or count the item and post a stock verification adjustment, then post the close again.',
      to_char(p_as_at, 'DD Mon YYYY'), v_negative;
  end if;

  -- What the stock is actually worth on this date, per the valuation engine,
  -- across every item -- used only for the narration and the "nothing to
  -- post" message; which LEDGER each item's value belongs to is resolved
  -- below, per item.
  select coalesce(sum(s.closing_value), 0) into v_target
    from public.get_stock_summary(p_company_id, p_as_at, null) s;

  -- 2030: a company may legitimately keep more than one stock-role ledger
  -- (separate Raw Material and Finished Goods Stock, say). Every item
  -- resolves to exactly one of them via app_private.item_stock_ledger
  -- (explicit items.stock_ledger_id, or the company's single stock ledger
  -- when -- as for every company but one today -- there is only one), and
  -- each resolved ledger gets its OWN movement (its own target, its own
  -- carried value, its own delta) posted as its own line. The single-ledger
  -- case (every other company) reduces to exactly one group here, over the
  -- exact same rows the pre-2030 code summed in one shot, so it computes the
  -- identical target/carried/delta and posts the identical two-line voucher
  -- -- this is not a new formula, it is the old formula applied per group.
  -- An item that cannot be resolved (more than one stock ledger, no explicit
  -- choice on that item) makes app_private.item_stock_ledger raise, naming
  -- the item; that exception simply propagates out of the loop.
  for v_rec in
    select resolved.stock_ledger_id, sum(resolved.closing_value) as target
      from (
        select app_private.item_stock_ledger(p_company_id, s.item_id) as stock_ledger_id,
               s.closing_value
          from public.get_stock_summary(p_company_id, p_as_at, null) s
      ) resolved
     group by resolved.stock_ledger_id
  loop
    if v_rec.stock_ledger_id is null then
      raise exception 'This company has no inventory ledger to post against; check the chart of accounts.';
    end if;

    -- What this ONE ledger already carries on this date. ledger_opening_signed
    -- at (date + 1) is "closing as at date" -- the same trick get_balance_sheet
    -- and get_cma_ratios both use.
    v_carried := app_private.ledger_opening_signed(p_company_id, v_rec.stock_ledger_id, p_as_at + 1, null);
    v_delta := round(v_rec.target - v_carried, 2);

    if v_delta <> 0 then
      v_any_stock_line := true;
      v_total_delta := v_total_delta + v_delta;
      v_lines := v_lines || jsonb_build_array(
        case when v_delta > 0
          then jsonb_build_object('ledger_id', v_rec.stock_ledger_id, 'debit_amount', v_delta)
          else jsonb_build_object('ledger_id', v_rec.stock_ledger_id, 'credit_amount', -v_delta)
        end
      );
    end if;
  end loop;

  if not v_any_stock_line then
    raise exception
      'Inventory already carries % as at % — there is no movement to post.',
      round(v_target, 2), p_as_at;
  end if;

  -- The one shared Changes in Inventories line: the NET of every resolved
  -- ledger's own delta (2030 part 4) -- algebraically identical to the
  -- pre-2030 single v_delta when there is only one ledger, and exactly what
  -- keeps this voucher balanced by construction for two or more: each stock
  -- line already contributes its own signed delta to (debits - credits), so
  -- crediting (or debiting) the total of those deltas here always brings the
  -- voucher back to zero, whatever the individual signs were.
  v_total_delta := round(v_total_delta, 2);

  if v_total_delta <> 0 then
    v_lines := v_lines || jsonb_build_array(
      case when v_total_delta > 0
        then jsonb_build_object('ledger_id', v_change_ledger, 'credit_amount', v_total_delta)
        else jsonb_build_object('ledger_id', v_change_ledger, 'debit_amount', -v_total_delta)
      end
    );
  end if;
  -- (v_total_delta = 0 with v_any_stock_line true means two or more stock
  -- ledgers moved in exactly offsetting directions -- e.g. RM up 100, FG
  -- down 100 -- so the stock lines already balance against each other with
  -- no P&L impact at all, and Changes in Inventories correctly gets no line
  -- rather than a pointless zero-amount one.)

  v_voucher_id := public.create_voucher(
    p_company_id := p_company_id,
    p_branch_id := p_branch_id,
    p_voucher_type := 'journal',
    p_voucher_date := p_as_at,
    p_lines := v_lines,
    p_narration := coalesce(
      p_narration,
      'Closing stock as at ' || to_char(p_as_at, 'DD Mon YYYY')
        || ' — carrying value ' || round(v_target, 2)
    )
  );

  return v_voucher_id;
end;
$fn$;

revoke all on function public.post_closing_stock(uuid, uuid, date, text) from public, anon;
grant execute on function public.post_closing_stock(uuid, uuid, date, text) to authenticated;

comment on function public.post_closing_stock(uuid, uuid, date, text) is
  'Brings inventory onto the balance sheet at a chosen date: Dr/Cr each resolved stock ledger its own movement (app_private.item_stock_ledger, 2030 -- a company may legitimately have more than one, e.g. separate Raw Material and Finished Goods Stock), net into the one shared Changes in Inventories ledger (a Direct Expenses contra, NOT an income ledger -- see 0076; Schedule III presents it as a single P&L line regardless of how many stock ledgers back it). Posts only the movement since whatever each ledger already carries, so it is safe to re-run as trading continues. Refuses outright, naming the items, when any item values out negative (1450).';

-- ---------------------------------------------------------------------------
-- Part D — one-time backfill for the one real company already in this shape
-- ---------------------------------------------------------------------------
-- See this file's own header, part 5. Scoped to one hardcoded company_id and
-- matched by item NAME within that company only -- it can never touch any
-- other company's data, named or not. Idempotent: only ever sets a currently-
-- NULL stock_ledger_id, so re-running this migration changes nothing the
-- second time, and it does not overwrite a choice made by hand since.

do $mig$
declare
  v_company_id constant uuid := 'f2557c28-73ec-43a1-9769-d346e21548f6';
  v_rm_ledger uuid;
  v_fg_ledger uuid;
  v_updated int;
begin
  select id into v_rm_ledger from public.ledgers
   where company_id = v_company_id and name = 'Raw Material Stock';
  select id into v_fg_ledger from public.ledgers
   where company_id = v_company_id and name = 'Finished Goods Stock';

  if v_rm_ledger is null or v_fg_ledger is null then
    raise notice '2030: TEST Precision Engineering''s Raw Material Stock / Finished Goods Stock ledgers were not found by name -- skipping the one-time item backfill. Its items will need stock_ledger_id assigned by hand instead.';
    return;
  end if;

  update public.items
     set stock_ledger_id = v_rm_ledger
   where company_id = v_company_id
     and name in ('Alloy Steel Billet EN8', 'Hex Bolt M8x40 Zinc Plated', 'MS Round Bar 25mm')
     and stock_ledger_id is null;
  get diagnostics v_updated = row_count;
  raise notice '2030: backfilled % raw-material item(s) to Raw Material Stock.', v_updated;

  update public.items
     set stock_ledger_id = v_fg_ledger
   where company_id = v_company_id
     and name in ('Machined Flange Bracket FB-200', 'Precision Shaft SH-100')
     and stock_ledger_id is null;
  get diagnostics v_updated = row_count;
  raise notice '2030: backfilled % finished-goods item(s) to Finished Goods Stock.', v_updated;
end;
$mig$;

-- ---------------------------------------------------------------------------
-- Part E — guardrails: prove the scope claims made above still hold
-- ---------------------------------------------------------------------------

do $mig$
declare
  v_offenders text;
  v_def text;
begin
  -- Only ensure_stock_ledgers and post_closing_stock (both rewritten above)
  -- may call ledger_for_role with p_role='stock'. Anything else doing the
  -- same has this exact bug and was missed by this migration's scope.
  select string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname) into v_offenders
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app_private')
     and p.prokind = 'f'
     and p.proname not in ('ensure_stock_ledgers', 'post_closing_stock')
     -- An actual CALL, ledger_for_role(..., 'stock'), not merely the two
     -- substrings appearing anywhere in the body -- app_private.
     -- item_stock_ledger's own comments mention ledger_for_role by name
     -- without ever calling it, and matched the looser ilike this replaced.
     and pg_get_functiondef(p.oid) ~ 'ledger_for_role\(p_company_id,\s*''stock''\)';

  if v_offenders is not null then
    raise exception '2030: these functions also resolve a single stock ledger by role and were not in this migration''s scope -- check them by hand: %', v_offenders;
  end if;

  -- ledger_for_role itself must be untouched: its refuse-on-ambiguity
  -- guarantee is exactly what must NOT be weakened.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'ledger_for_role' and p.prokind = 'f';

  if v_def is null or position('cardinality(v_ids) > 1' in v_def) = 0 then
    raise exception '2030: app_private.ledger_for_role no longer contains its own ambiguity guard -- it must not have been touched by this migration. Investigate before shipping.';
  end if;

  -- Both rewritten functions actually carry the new mechanism.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'ensure_stock_ledgers' and p.prokind = 'f';
  if position('v_stock_ledger_count' in v_def) = 0 then
    raise exception '2030: app_private.ensure_stock_ledgers did not pick up the count-based rewrite.';
  end if;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_closing_stock' and p.prokind = 'f';
  if position('item_stock_ledger' in v_def) = 0 then
    raise exception '2030: public.post_closing_stock did not pick up the per-item resolution rewrite.';
  end if;
end;
$mig$;
