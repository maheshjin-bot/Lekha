-- ============================================================================
-- 2210 — let an item's OPENING stock say which godown it actually sat in
-- ============================================================================
-- WHY. 1450/1451 (and 2150 for stock ageing) built a best-effort "home
-- godown" for an item's opening balance, because items.opening_quantity has
-- never carried a godown of its own — the CTE's own comment says so plainly:
-- "items.opening_quantity carries no godown at all". Evidence comes ONLY
-- from voucher_items movement history: the item's first-ever movement,
-- wherever it happened (1451 widened this off any date bound), else the
-- company's only godown, else — a multi-godown company with an item that has
-- opening stock and has NEVER had a single voucher posted against it — the
-- opening is "genuinely unplaceable" and is deliberately placed in NO
-- godown, by design, rather than guessed.
--
-- That design is correct as far as it goes — refuse rather than guess is
-- this codebase's standing rule (app_private.ledger_for_role, 2030's
-- item_stock_ledger). But it leaves a real, disclosed gap the manufacturing
-- pilot re-surfaced: a brand-new item created with an opening balance in a
-- multi-godown company shows its full value in the company-wide stock report
-- and ZERO in every single per-godown filter — while the report's own
-- on-screen text claims "Quantities filtered to {godown} always add up
-- exactly across every godown to the all-godowns figure above", which is
-- simply false for such an item. Nothing was ever asked at item-creation
-- time about where the opening stock physically sits, so there was never
-- anything for the evidence query to find.
--
-- THE FIX. Give opening stock an explicit, optional godown of its own,
-- exactly the same shape as 2030's items.stock_ledger_id: nullable, so every
-- existing item and every single-godown company (the fallback already
-- handles those correctly) is untouched, but a NEW item in a multi-godown
-- company can now say where its opening balance actually is instead of
-- leaving it to inference that may have nothing to infer from.
--
-- item_home_godown's evidence order becomes: this explicit column first
-- (nobody has to guess when the preparer already said), then the existing
-- first-movement evidence, then the company's-only-godown fallback, then
-- genuinely unplaceable — unchanged for every item that predates this
-- column, and for any item where the preparer leaves it blank.
-- ============================================================================

alter table public.items
  add column opening_godown_id uuid null;

alter table public.items
  add constraint items_opening_godown_id_company_fkey
  foreign key (opening_godown_id, company_id)
  references public.godowns (id, company_id);

comment on column public.items.opening_godown_id is
  'Which godown this item''s opening_quantity/opening_value actually sat in (2210) — the same nullable, explicit-pointer shape as stock_ledger_id (2030). NULL is correct and the default for every item created before this column existed, and for any company with zero or one godown (item_home_godown''s existing "company''s only godown" fallback already places those correctly with no ambiguity to resolve). Only matters for a NEW item with a positive opening_quantity in a company with two or more godowns, where there is otherwise no evidence anywhere of where the opening balance sits until the item''s first voucher movement is posted. Enforced by trigger, not a plain FK alone, because it must also refuse a service item or a non-stock item claiming a godown for stock it can never hold — see enforce_item_opening_godown.';

create or replace function app_private.enforce_item_opening_godown()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.opening_godown_id is null then
    return new;
  end if;

  if new.item_type <> 'goods' or not new.maintain_stock then
    raise exception 'opening_godown_id only applies to a stock-maintained goods item';
  end if;

  if not exists (
    select 1 from public.godowns g
     where g.id = new.opening_godown_id and g.company_id = new.company_id
  ) then
    raise exception 'opening_godown_id must reference a godown belonging to this item''s own company';
  end if;

  return new;
end;
$$;

revoke all on function app_private.enforce_item_opening_godown() from public, anon;

create trigger enforce_item_opening_godown
  before insert or update of opening_godown_id, company_id, item_type, maintain_stock on public.items
  for each row execute function app_private.enforce_item_opening_godown();

-- ----------------------------------------------------------------------------
-- Wire the new column into item_home_godown's evidence order, in all four
-- functions that carry that CTE (1451's three plus 2150's stock-ageing).
-- The coalesce line is byte-identical across all four, so one loop, one
-- assertion, four functions — same house pattern as 1451/2150 themselves.
-- ----------------------------------------------------------------------------

do $mig$
declare
  v_fn text;
  v_def text;
  v_from constant text := '           coalesce(f.godown_id, s.godown_id) as godown_id';
  v_to constant text :=
'           -- 2210: an explicit opening_godown_id (set at item creation,
           -- when the preparer actually knows) beats inferring from
           -- movement that may not exist yet. Movement evidence still wins
           -- when there IS movement and no explicit column was set, exactly
           -- as before -- this only adds a tier ahead of it, never removes
           -- one.
           coalesce(i2.opening_godown_id, f.godown_id, s.godown_id) as godown_id';
begin
  foreach v_fn in array array['get_stock_summary', 'get_stock_summary_fifo', 'get_stock_fifo_layers', 'get_stock_ageing']
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn and p.prokind = 'f'
     limit 1;

    if v_def is null then
      raise exception '2210: public.% is missing.', v_fn;
    end if;

    if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
      raise exception '2210: public.%''s item_home_godown coalesce has moved or already changed; fix by hand.', v_fn;
    end if;

    execute replace(v_def, v_from, v_to);
  end loop;
end;
$mig$;

revoke all on function public.get_stock_summary(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_summary(uuid, date, uuid) to authenticated;
revoke all on function public.get_stock_summary_fifo(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_summary_fifo(uuid, date, uuid) to authenticated;
revoke all on function public.get_stock_fifo_layers(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_fifo_layers(uuid, date, uuid) to authenticated;
revoke all on function public.get_stock_ageing(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_ageing(uuid, date, uuid) to authenticated;
