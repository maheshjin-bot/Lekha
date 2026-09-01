-- Close postings find their ledgers by ROLE, not by their English name.
--
-- WHY. A pilot run opened a brand-new company, traded it for a month and
-- closed it. The close reported a profit of 4,11,788.02 on a company that had
-- actually LOST 5,72,211.98 — a swing of exactly 9,84,000.00, the opening
-- stock, counted twice.
--
-- The cause is a single predicate. post_closing_stock locates the inventory
-- ledger with `name = 'Stock-in-Hand'`. That company's ledger was called
-- 'Stock in Hand', with spaces, so ensure_stock_ledgers created a SECOND
-- ledger at zero and the whole closing valuation went there. v_carried read 0
-- instead of 9,84,000, so the posting was the full closing value rather than
-- the movement.
--
-- This is not a naming slip a careful preparer avoids. seed_chart_of_accounts
-- creates the Stock-in-Hand *group* and NO ledger inside it — verified: it
-- contains no `insert into public.ledgers` for stock at all. The preparer
-- invents the ledger name, on a screen that never says the string is
-- load-bearing. Checked across the live database before writing this: of the
-- sixteen companies that have the group, not ONE had a ledger named the
-- required way — including a company that has been trading with inventory for
-- months. Every company was one close away from this.
--
-- What makes it dangerous rather than merely wrong is that nothing catches
-- it. The balance sheet, the P&L and the cash flow all still balanced, still
-- agreed with each other, and still passed their own reconciliation checks —
-- they agreed on the wrong number. Every safety net in this system is a SELF-
-- consistency check, and self-consistency is exactly what this class of bug
-- preserves. It flowed out to the CMA lender pack as a 256.92% gross margin
-- and to get_income_tax_computation as 92,268.80 of tax on a loss.
--
-- WHAT CHANGES
--
-- 1. app_private.ledger_for_role(company, role) — one resolver, used by every
--    close posting. It reads the EFFECTIVE role, coalesce(ledger, group), so
--    both the group-level default and 0210's ledger-level overrides work. It
--    returns null when there is none (the caller then creates it) and RAISES
--    when there are two, naming both. Refusing beats guessing here: picking
--    one arbitrarily is precisely how the reported bug produced a number that
--    looked fine.
--
-- 2. The six functions that bound these ledgers by literal name now bind by
--    role: post_closing_stock, post_depreciation, get_cash_flow_statement,
--    get_fixed_asset_book_reconciliation, and the two ensure_* creators.
--    seed_chart_of_accounts is deliberately NOT changed — it names GROUPS,
--    which the app itself creates and the preparer never types.
--
-- 3. A new role, 'accumulated_depreciation'. The other three keys already
--    existed and were already correct on every ledger involved; accumulated
--    depreciation was the one contra-asset with nothing but its name to
--    identify it. Backfilled for existing companies and set at creation.
--
-- 4. get_balance_sheet resolves coalesce(l.ledger_role, g.ledger_role), which
--    is what get_profit_and_loss has always done. Checked before changing it:
--    NO balance-sheet-side ledger carries its own override today, so this is
--    inert on current data and purely enabling — without it, a ledger-level
--    role is invisible to every balance-sheet consumer, and point 3 could not
--    work.
--
-- 5. Provably-empty duplicates created by the old code are removed: only a
--    ledger with zero opening balance, no voucher entries and a surviving
--    sibling in the same role. A duplicate that carries anything is left
--    alone and reported by the resolver instead — deleting a ledger with
--    postings behind it is not this migration's business.
--
-- WHAT THIS DOES NOT FIX. The pilot's own books are left wrong on purpose, as
-- the evidence; the closing-stock voucher must be deleted and re-posted for
-- that company. And the screen still reads the group while the posting reads
-- the ledger — that is the companion frontend change, not SQL.

-- ---------------------------------------------------------------------------
-- 1. The resolver
-- ---------------------------------------------------------------------------

create or replace function app_private.ledger_for_role(p_company_id uuid, p_role text)
returns uuid
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  v_ids uuid[];
  v_names text;
begin
  select array_agg(l.id order by l.name), string_agg(l.name, ', ' order by l.name)
    into v_ids, v_names
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where l.company_id = p_company_id
     and coalesce(l.ledger_role, g.ledger_role) = p_role;

  if v_ids is null or cardinality(v_ids) = 0 then
    return null;
  end if;

  if cardinality(v_ids) > 1 then
    raise exception
      'This company has more than one % ledger (%). Merge or rename them so exactly one remains, then post again.',
      replace(p_role, '_', ' '), v_names
      using errcode = '23505';
  end if;

  return v_ids[1];
end;
$fn$;

revoke all on function app_private.ledger_for_role(uuid, text) from public, anon;
grant execute on function app_private.ledger_for_role(uuid, text) to authenticated;

comment on function app_private.ledger_for_role(uuid, text) is
  'The single ledger carrying an effective ledger_role, coalesce(ledger, group). Null when absent, raises when ambiguous (1200). The binding key for every close posting — never match a ledger by its English name.';

-- ---------------------------------------------------------------------------
-- 2. The new role, backfilled
-- ---------------------------------------------------------------------------

-- The allowed-role list is a CHECK constraint, so it has to admit the new
-- value before anything can carry it. Rebuilt from the live definition rather
-- than retyped, so no existing role can be dropped by a transcription slip.
do $mig$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conname = 'ledgers_ledger_role_check';

  if v_def is null then
    raise exception '1200: ledgers_ledger_role_check is missing; the role vocabulary has moved.';
  end if;

  if position('accumulated_depreciation' in v_def) > 0 then
    raise notice '1200: accumulated_depreciation already admitted.';
    return;
  end if;

  v_def := replace(
    v_def,
    '''depreciation_amortisation''::text',
    '''depreciation_amortisation''::text, ''accumulated_depreciation''::text'
  );

  execute 'alter table public.ledgers drop constraint ledgers_ledger_role_check';
  execute 'alter table public.ledgers add constraint ledgers_ledger_role_check ' || v_def;
end;
$mig$;

update public.ledgers l
   set ledger_role = 'accumulated_depreciation'
  from public.account_groups g
 where g.id = l.group_id
   and g.nature = 'fixed_asset'
   and l.name = 'Accumulated Depreciation'
   and l.ledger_role is null;

-- ---------------------------------------------------------------------------
-- 3. Balance sheet honours a ledger-level role (inert today; see header)
-- ---------------------------------------------------------------------------

create or replace function public.get_balance_sheet(p_company_id uuid, p_as_at date, p_branch_id uuid default null)
returns table(side text, nature text, group_name text, ledger_name text, ledger_role text, amount numeric)
language sql
stable
set search_path to ''
as $$
  with bal as (
    select g.nature, g.name as group_name, l.name as ledger_name,
           coalesce(l.ledger_role, g.ledger_role) as ledger_role,
           app_private.ledger_opening_signed(p_company_id, l.id, p_as_at + 1, p_branch_id) as signed
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id
       and g.nature in (
         'capital','share_capital','reserves_surplus',
         'current_asset','current_liability','non_current_liability',
         'long_term_borrowing','deferred_tax','long_term_provision',
         'fixed_asset'
       )
  )
  select case when nature in ('current_asset','fixed_asset') then 'assets' else 'liabilities' end,
         nature, group_name, ledger_name, ledger_role,
         case when nature in ('current_asset','fixed_asset') then signed else -signed end
    from bal
   where signed <> 0
   order by 1, 2, 3, 4;
$$;

revoke all on function public.get_balance_sheet(uuid, date, uuid) from public, anon;
grant execute on function public.get_balance_sheet(uuid, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The creators: find by role first, create only when genuinely absent
-- ---------------------------------------------------------------------------

create or replace function app_private.ensure_stock_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_stock_group uuid;
  v_expense_group uuid;
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

  -- By ROLE, not by name. Whatever the preparer called their stock ledger, if
  -- it sits in the group carrying ledger_role='stock' it IS the stock ledger,
  -- and creating a second one is what produced the 9,84,000 error.
  if app_private.ledger_for_role(p_company_id, 'stock') is null then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_stock_group, 'Stock-in-Hand', 'debit', 0);
  end if;

  -- Schedule III's own name for this line. Lives under Direct Expenses and
  -- normally carries a CREDIT balance -- see 0076's header for why it is not
  -- a direct_income ledger. ledger_role='changes_in_inventories' (0210)
  -- overrides Direct Expenses' own group default (cost_of_materials) since
  -- this one specific ledger is not a materials-purchase ledger at all.
  if app_private.ledger_for_role(p_company_id, 'changes_in_inventories') is null then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount, ledger_role)
    values (p_company_id, v_expense_group, 'Changes in Inventories', 'debit', 0, 'changes_in_inventories');
  end if;
end;
$fn$;

create or replace function app_private.ensure_depreciation_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_expense_group uuid;
  v_asset_group uuid;
begin
  select id into v_expense_group
    from public.account_groups
   where company_id = p_company_id and parent_group_id is null and name = 'Indirect Expenses'
   limit 1;

  select id into v_asset_group
    from public.account_groups
   where company_id = p_company_id and name = 'Fixed Assets'
   limit 1;

  if v_expense_group is null or v_asset_group is null then
    raise exception 'Chart of accounts is missing the Indirect Expenses or Fixed Assets group; seed it first';
  end if;

  -- ledger_role='depreciation_amortisation' (0210) overrides Indirect
  -- Expenses' own group default (other_expenses) -- Depreciation is a named
  -- Schedule III head in its own right, not a generic other expense.
  if app_private.ledger_for_role(p_company_id, 'depreciation_amortisation') is null then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount, ledger_role)
    values (p_company_id, v_expense_group, 'Depreciation', 'debit', 0, 'depreciation_amortisation');
  end if;

  -- A contra-asset: lives with the assets it reduces and carries a credit.
  -- Now role-tagged (1200) so the cash flow statement and the fixed-asset
  -- reconciliation can tell it apart from the assets around it without
  -- reading its name.
  if app_private.ledger_for_role(p_company_id, 'accumulated_depreciation') is null then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount, ledger_role)
    values (p_company_id, v_asset_group, 'Accumulated Depreciation', 'credit', 0, 'accumulated_depreciation');
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. The postings
-- ---------------------------------------------------------------------------

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
  v_stock_ledger uuid;
  v_change_ledger uuid;
  v_target numeric;
  v_carried numeric;
  v_delta numeric;
  v_lines jsonb;
  v_voucher_id uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to post for this company';
  end if;

  perform app_private.ensure_stock_ledgers(p_company_id);

  v_stock_ledger  := app_private.ledger_for_role(p_company_id, 'stock');
  v_change_ledger := app_private.ledger_for_role(p_company_id, 'changes_in_inventories');

  if v_stock_ledger is null or v_change_ledger is null then
    raise exception 'This company has no inventory ledger to post against; check the chart of accounts.';
  end if;

  -- What the stock is actually worth on this date, per the valuation engine.
  select coalesce(sum(s.closing_value), 0) into v_target
    from public.get_stock_summary(p_company_id, p_as_at, null) s;

  -- What the ledger already carries on this date. ledger_opening_signed at
  -- (date + 1) is "closing as at date" -- the same trick get_balance_sheet and
  -- get_cma_ratios both use.
  v_carried := app_private.ledger_opening_signed(p_company_id, v_stock_ledger, p_as_at + 1, null);

  v_delta := round(v_target - v_carried, 2);

  if v_delta = 0 then
    raise exception
      'Inventory already carries % as at % — there is no movement to post.',
      round(v_target, 2), p_as_at;
  end if;

  if v_delta > 0 then
    v_lines := jsonb_build_array(
      jsonb_build_object('ledger_id', v_stock_ledger,  'debit_amount',  v_delta),
      jsonb_build_object('ledger_id', v_change_ledger, 'credit_amount', v_delta)
    );
  else
    v_lines := jsonb_build_array(
      jsonb_build_object('ledger_id', v_change_ledger, 'debit_amount',  -v_delta),
      jsonb_build_object('ledger_id', v_stock_ledger,  'credit_amount', -v_delta)
    );
  end if;

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
  'Brings inventory onto the balance sheet at a chosen date: Dr the stock ledger, Cr Changes in Inventories (a Direct Expenses contra, NOT an income ledger — see 0076). Posts only the movement since whatever the ledger already carries, so it is safe to re-run as trading continues. Both ledgers are located by ledger_role, never by name (1200).';

do $mig$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_depreciation' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise notice '1200: post_depreciation not present; skipping its rebind.';
    return;
  end if;

  -- Rewrite only the two name predicates, leaving the rest of the live body
  -- byte-for-byte. The register arithmetic in this function is exact — the
  -- pilot matched all three assets to the paisa against an independent
  -- day-weighted derivation — so nothing else here is worth disturbing.
  v_def := replace(
    v_def,
    'where company_id = p_company_id and group_id = v_expense_group and name = ''Depreciation'' limit 1;',
    'where id = app_private.ledger_for_role(p_company_id, ''depreciation_amortisation'');'
  );
  v_def := replace(
    v_def,
    'where company_id = p_company_id and group_id = v_asset_group and name = ''Accumulated Depreciation'' limit 1;',
    'where id = app_private.ledger_for_role(p_company_id, ''accumulated_depreciation'');'
  );

  if v_def ~ 'name = ''(Depreciation|Accumulated Depreciation)''' then
    raise exception '1200: post_depreciation still binds a ledger by name after rewrite — its body has moved since this migration was written. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

-- ---------------------------------------------------------------------------
-- 6. The reports
-- ---------------------------------------------------------------------------

do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_cash_flow_statement' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1200: get_cash_flow_statement is missing.';
  end if;

  v_before := v_def;

  -- The add-back. Renaming Depreciation to Schedule III's own wording used to
  -- drop this to zero and move the same amount into investing as a fake sale
  -- of plant. The two errors cancel, so the statement's own reconciliation
  -- check still read nil and nothing on screen suggested a problem.
  v_def := replace(
    v_def,
    'where pl.nature = ''indirect_expense'' and pl.ledger_name = ''Depreciation''',
    'where pl.ledger_role = ''depreciation_amortisation'''
  );

  -- The contra-asset exclusion, twice (closing and opening).
  v_def := replace(
    v_def,
    'and bs.ledger_name <> ''Accumulated Depreciation''',
    'and coalesce(bs.ledger_role, '''') <> ''accumulated_depreciation'''
  );

  if v_def = v_before then
    raise exception '1200: get_cash_flow_statement matched none of the expected name predicates; its body has moved. Fix by hand.';
  end if;

  if v_def ~ 'ledger_name (=|<>) ''(Depreciation|Accumulated Depreciation)''' then
    raise exception '1200: get_cash_flow_statement still binds a ledger by name after rewrite. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

do $mig$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_fixed_asset_book_reconciliation' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise notice '1200: get_fixed_asset_book_reconciliation not present; skipping.';
    return;
  end if;

  v_def := replace(
    v_def,
    'case when l.name <> ''Accumulated Depreciation'' then s.signed else 0 end',
    'case when coalesce(l.ledger_role, '''') <> ''accumulated_depreciation'' then s.signed else 0 end'
  );
  v_def := replace(
    v_def,
    'case when l.name =  ''Accumulated Depreciation'' then -s.signed else 0 end',
    'case when coalesce(l.ledger_role, '''') =  ''accumulated_depreciation'' then -s.signed else 0 end'
  );

  if v_def ~ 'l\.name (=|<>) +''Accumulated Depreciation''' then
    raise exception '1200: get_fixed_asset_book_reconciliation still binds by name after rewrite. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

-- ---------------------------------------------------------------------------
-- 7. Remove duplicates the old code created, but only provably empty ones
-- ---------------------------------------------------------------------------

-- Rank the siblings so exactly one is always kept: whichever carries real
-- bookkeeping wins, and only genuinely empty losers are removed. A duplicate
-- holding entries or an opening balance survives and is reported by the
-- resolver instead — deleting a ledger with postings behind it is not this
-- migration's business.
with roles as (
  select l.id, l.company_id, l.name, coalesce(l.ledger_role, g.ledger_role) as role,
         coalesce(l.opening_balance_amount, 0) as opening,
         exists (select 1 from public.voucher_entries ve where ve.ledger_id = l.id) as has_entries
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where coalesce(l.ledger_role, g.ledger_role) in
         ('stock','changes_in_inventories','depreciation_amortisation','accumulated_depreciation')
),
ranked as (
  select r.*,
         row_number() over (
           partition by r.company_id, r.role
           order by r.has_entries desc, r.opening desc, r.name
         ) as rn
    from roles r
)
delete from public.ledgers l
 using ranked d
 where l.id = d.id
   and d.rn > 1
   and d.has_entries = false
   and d.opening = 0;
