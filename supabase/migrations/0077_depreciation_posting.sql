-- ============================================================================
-- 0077 — Depreciation was computed every which way and posted nowhere
-- ============================================================================
-- The fixed asset register (0031-era get_fixed_asset_register) computes
-- accumulated depreciation and net book value per asset as at any date, and
-- get_tax_depreciation_blocks computes the whole Income-tax Act block schedule
-- beside it. Neither has ever posted anything. Verified before writing this:
--
--   * ten companies hold a fixed asset each, 60,000 gross apiece;
--   * NO balance sheet anywhere shows a single fixed asset;
--   * every fixed_asset group (Fixed Assets, Plant & Machinery, Furniture,
--     Office Equipment) contains ZERO ledgers, for every company;
--   * there is no ledger anywhere whose name contains "deprec".
--
-- So the P&L carries no depreciation expense and the balance sheet carries no
-- asset block. Profit is overstated by the depreciation charge, every period.
--
-- WHAT THIS DOES AND DOES NOT POST. It posts the DEPRECIATION CHARGE only:
--     Dr Depreciation                (Indirect Expenses)
--     Cr Accumulated Depreciation    (Fixed Assets, a contra carrying a credit)
-- It deliberately does NOT capitalise the asset itself. Buying an asset is an
-- ordinary purchase voucher — Dr Plant & Machinery, Cr Bank or the supplier —
-- and only the person who paid for it knows which side to credit. The register
-- records that an asset exists and what it is worth; it does not know how it
-- was funded, and inventing a credit (a suspense account, say) would put a
-- fabricated line in the balance sheet rather than fix anything.
--
-- That leaves a real reconciliation the user must close themselves: today
-- their register says 60,000 of assets while their books say nothing, because
-- the purchase voucher was never entered. get_fixed_asset_book_reconciliation
-- below exposes exactly that gap so the UI can say so out loud. It is a
-- warning, never a block — depreciation is a genuine expense whether or not
-- the acquisition was recorded, and refusing to post it would trade one wrong
-- number for two.
--
-- Accumulated Depreciation sits under the Fixed Assets group (nature
-- fixed_asset) and normally carries a CREDIT balance. get_balance_sheet puts
-- fixed_asset natures on the assets side signed debit-positive, so a credit
-- balance surfaces as a negative asset and correctly nets the block down. That
-- is the standard gross-block-less-accumulated-depreciation presentation, and
-- it keeps the gross cost visible rather than silently writing assets down.
--
-- INCREMENTAL, NOT REVERSE-AND-REPOST — the same additive pattern as
-- record_forex_revaluation (0071) and post_closing_stock (0076). Each run
-- posts only the difference between the register's accumulated depreciation at
-- the chosen date and whatever the ledger already carries there, so running it
-- monthly, quarterly or once at year end all converge on the same balance, and
-- running it twice on one date is refused rather than doubled. A NEGATIVE
-- delta is handled too and is not an error: it is what a disposal looks like,
-- when accumulated depreciation leaves the books along with the asset.
--
-- BOOK DEPRECIATION, NOT TAX. This posts the Companies Act / book charge from
-- get_fixed_asset_register. get_tax_depreciation_blocks stays a computation
-- for the tax return and must NOT be posted — the two legitimately differ, and
-- that difference is exactly what a deferred tax working is made of. Deferred
-- tax remains unbuilt; this migration does not pretend otherwise.
-- ============================================================================

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

  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_expense_group and name = 'Depreciation'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_expense_group, 'Depreciation', 'debit', 0);
  end if;

  -- A contra-asset: lives with the assets it reduces and carries a credit.
  if not exists (
    select 1 from public.ledgers
     where company_id = p_company_id and group_id = v_asset_group and name = 'Accumulated Depreciation'
  ) then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
    values (p_company_id, v_asset_group, 'Accumulated Depreciation', 'credit', 0);
  end if;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- What the register says versus what the books say
-- ----------------------------------------------------------------------------
create or replace function public.get_fixed_asset_book_reconciliation(
  p_company_id uuid,
  p_as_at date default current_date
)
returns table (
  register_gross numeric,
  books_gross numeric,
  gross_gap numeric,
  register_accumulated numeric,
  books_accumulated numeric,
  accumulated_gap numeric
)
language sql
stable
set search_path to ''
as $fn$
  with reg as (
    select
      coalesce(sum(r.gross_value), 0) as gross,
      coalesce(sum(r.accumulated_depreciation), 0) as accum
      from public.get_fixed_asset_register(p_company_id, p_as_at) r
     where r.disposal_date is null or r.disposal_date > p_as_at
  ),
  books as (
    select
      -- Every fixed-asset ledger EXCEPT the accumulated-depreciation contra is
      -- gross cost; the contra itself is the accumulated charge (a credit, so
      -- its signed balance is negative and is flipped back here).
      coalesce(sum(case when l.name <> 'Accumulated Depreciation' then s.signed else 0 end), 0) as gross,
      coalesce(sum(case when l.name =  'Accumulated Depreciation' then -s.signed else 0 end), 0) as accum
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
      cross join lateral (
        select app_private.ledger_opening_signed(p_company_id, l.id, p_as_at + 1, null) as signed
      ) s
     where l.company_id = p_company_id and g.nature = 'fixed_asset'
  )
  select
    reg.gross, books.gross, round(reg.gross - books.gross, 2),
    reg.accum, books.accum, round(reg.accum - books.accum, 2)
  from reg, books;
$fn$;

revoke all on function public.get_fixed_asset_book_reconciliation(uuid, date) from public, anon;
grant execute on function public.get_fixed_asset_book_reconciliation(uuid, date) to authenticated;

comment on function public.get_fixed_asset_book_reconciliation(uuid, date) is
  'The fixed asset register against the fixed-asset ledgers. A gross_gap means asset purchases were never entered as vouchers — post_depreciation does not capitalise assets, only the depreciation charge. See 0077.';

-- ----------------------------------------------------------------------------
-- Post the charge
-- ----------------------------------------------------------------------------
create or replace function public.post_depreciation(
  p_company_id uuid,
  p_branch_id uuid,
  p_as_at date,
  p_narration text default null
)
returns uuid
language plpgsql
set search_path to ''
as $fn$
declare
  v_expense_group uuid;
  v_asset_group uuid;
  v_expense_ledger uuid;
  v_accum_ledger uuid;
  v_target numeric;
  v_carried numeric;
  v_delta numeric;
  v_lines jsonb;
  v_voucher_id uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to post for this company';
  end if;

  perform app_private.ensure_depreciation_ledgers(p_company_id);

  select id into v_expense_group from public.account_groups
   where company_id = p_company_id and parent_group_id is null and name = 'Indirect Expenses' limit 1;
  select id into v_asset_group from public.account_groups
   where company_id = p_company_id and name = 'Fixed Assets' limit 1;

  select id into v_expense_ledger from public.ledgers
   where company_id = p_company_id and group_id = v_expense_group and name = 'Depreciation' limit 1;
  select id into v_accum_ledger from public.ledgers
   where company_id = p_company_id and group_id = v_asset_group and name = 'Accumulated Depreciation' limit 1;

  -- The register's own accumulated charge at this date, for assets still held.
  select coalesce(sum(r.accumulated_depreciation), 0) into v_target
    from public.get_fixed_asset_register(p_company_id, p_as_at) r
   where r.disposal_date is null or r.disposal_date > p_as_at;

  -- What the contra already carries. It holds credits, so its signed balance
  -- is negative; flip it to read as an accumulated amount.
  v_carried := -app_private.ledger_opening_signed(p_company_id, v_accum_ledger, p_as_at + 1, null);

  v_delta := round(v_target - v_carried, 2);

  if v_delta = 0 then
    raise exception
      'Accumulated depreciation already stands at % as at % — there is no charge to post.',
      round(v_target, 2), p_as_at;
  end if;

  if v_delta > 0 then
    v_lines := jsonb_build_array(
      jsonb_build_object('ledger_id', v_expense_ledger, 'debit_amount',  v_delta),
      jsonb_build_object('ledger_id', v_accum_ledger,   'credit_amount', v_delta)
    );
  else
    -- Negative is legitimate: accumulated depreciation leaving the books with
    -- a disposed asset, not an error condition.
    v_lines := jsonb_build_array(
      jsonb_build_object('ledger_id', v_accum_ledger,   'debit_amount',  -v_delta),
      jsonb_build_object('ledger_id', v_expense_ledger, 'credit_amount', -v_delta)
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
      'Depreciation to ' || to_char(p_as_at, 'DD Mon YYYY')
        || ' — accumulated ' || round(v_target, 2)
    )
  );

  return v_voucher_id;
end;
$fn$;

revoke all on function public.post_depreciation(uuid, uuid, date, text) from public, anon;
grant execute on function public.post_depreciation(uuid, uuid, date, text) to authenticated;

comment on function public.post_depreciation(uuid, uuid, date, text) is
  'Posts the BOOK depreciation charge to a chosen date: Dr Depreciation, Cr Accumulated Depreciation. Posts only the movement since whatever the contra already carries, so it is safe to re-run. Does NOT capitalise assets — see get_fixed_asset_book_reconciliation — and does not post tax depreciation, which legitimately differs. See 0077.';
