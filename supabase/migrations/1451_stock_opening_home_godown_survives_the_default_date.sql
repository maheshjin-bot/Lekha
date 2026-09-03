-- ============================================================================
-- 1451 — an item's opening stock must not vanish before its first movement
-- ============================================================================
-- WHY. 1450 placed an item's opening quantity in the godown of "the first
-- godown the item was ever recorded in" — sound reasoning, since the opening
-- pre-dates every movement. But the evidence query only looked at movements
-- ON OR BEFORE the date being queried (v.voucher_date <= p_as_at), and for
-- the single most common query — the default "today" — that window can be
-- EMPTY: any item whose first-ever movement happens to be dated after the
-- as-at in question (which happens constantly: a company's own system clock
-- can trail its own posted vouchers, and this pilot's own database has that
-- exact gap between current_date and its latest posted voucher) has no
-- evidence at all inside the window, falls through to "genuinely unplaceable"
-- and is placed in NO godown — vanishing from every per-godown view while
-- still showing in the company-wide total, which is exactly the invariant
-- 1450 was written to guarantee ("quantities filtered to a godown always add
-- up exactly across every godown to the all-godowns figure").
--
-- Reproduced live on the flagship pilot company (TEST Rangoli Spice Works) at
-- its own ordinary default query date: Garam Masala 100g Pouch (2,500 units,
-- Rs 1,05,000) and Coriander Powder 500g Pouch (800 units, Rs 84,000) —
-- Rs 1,89,000 combined — show up company-wide but sum to zero across Main
-- Store and Nashik Cold Store. Both items' only movements are dated after the
-- as-at this query used.
--
-- record_stock_verification, a real posting RPC (not a report) used by the
-- stock-verification screen for routine physical counts, inherits the same
-- gap: book_quantity and average_rate both resolve to 0 for such an item, and
-- an ordinary physical count then crashes on a raw voucher_entries_check
-- violation rather than completing or returning a sane error — fixed
-- separately below, since it is a second, independent failure mode of the
-- same root cause.
--
-- THE FIX. Opening stock predates every movement by definition, so the
-- WHICH-GODOWN evidence should be "the first movement this item has EVER
-- had", not "the first movement up to whatever date happens to be queried
-- right now" — the as-at date bounds how much of that movement history
-- counts toward the running QUANTITY (unchanged, still correct, still scoped
-- to <= p_as_at everywhere else in these functions), but it has no bearing on
-- where the pre-existing opening balance physically sat. Dropping the date
-- bound from the home-godown lookup only widens WHICH movement can answer
-- "where has this item ever been recorded" — it does not change what
-- quantity is reported for any date, and does not touch the "company's only
-- godown" or "genuinely unplaceable" fallbacks 1450 already established.
--
-- SAME FIX, THREE FUNCTIONS, because 1450 put the identical item_home_godown
-- CTE in all three. Targeted, asserted replace over each live body, per the
-- house pattern (1200/1230/1240/1420) — not a retype.
-- ============================================================================

do $mig$
declare
  v_fn text;
  v_def text;
  v_from constant text :=
'        where vi.company_id = p_company_id
           and not v.is_deleted
           and v.voucher_date <= p_as_at
           and vi.godown_id is not null';
  v_to constant text :=
'        where vi.company_id = p_company_id
           and not v.is_deleted
           -- 1451: NOT bounded by p_as_at. Opening stock pre-dates every
           -- movement by definition, so the item''s very first movement --
           -- whenever it actually happened -- is still the best evidence of
           -- where the opening sat, even when that first movement is dated
           -- AFTER the date being queried. Bounding this by p_as_at is what
           -- let the opening fall through to "unplaceable" and vanish from
           -- every per-godown view the moment "today" trails an item''s only
           -- recorded movement -- the ordinary case for a default-dated
           -- query, not an edge case.
           and vi.godown_id is not null';
begin
  foreach v_fn in array array['get_stock_summary', 'get_stock_summary_fifo', 'get_stock_fifo_layers']
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn and p.prokind = 'f'
     limit 1;

    if v_def is null then
      raise exception '1451: public.% is missing.', v_fn;
    end if;

    if v_def !~ 'item_home_godown' then
      raise exception '1451: public.% has no item_home_godown CTE -- expected 1450''s body. Fix by hand.', v_fn;
    end if;

    if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
      raise exception '1451: public.%''s item_home_godown evidence query has moved or already changed; fix by hand.', v_fn;
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

-- ---------------------------------------------------------------------------
-- record_stock_verification: a zero-value variance cannot be posted, because
-- the database forbids it, not because it was a good idea in the first
-- place. voucher_entries_check requires exactly one side of an entry to be
-- STRICTLY positive; a self-cancelling 0/0 pair (what the existing comment
-- above the insert calls "still post the pair at zero") has never been a
-- postable voucher under this schema. The godown fix above closes the
-- specific gap the pilot hit (Rangoli's two items now resolve a real rate),
-- but a genuinely unplaceable item -- one with an opening balance and truly
-- NO movement anywhere yet, in a company with two or more godowns -- still
-- has no cost basis to post a value adjustment against. That case, like a
-- zero QUANTITY variance already does two lines above, now records the
-- discrepancy in stock_verifications (book/physical/variance all still
-- stored) and skips the financial voucher rather than attempting an insert
-- the constraint was always going to refuse.
-- ---------------------------------------------------------------------------

do $mig$
declare
  v_def text;
  v_from constant text :=
'  if v_variance_qty <> 0 then';
  v_to constant text :=
'  -- 1451: a variance with no rate to value it at has nothing to post --
  -- voucher_entries_check requires a strictly positive debit or credit on
  -- every line, so a 0/0 self-cancelling pair was never actually postable.
  -- The stock_verifications row above already recorded the discrepancy.
  if v_variance_qty <> 0 and v_rate > 0 then';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_stock_verification' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1451: public.record_stock_verification is missing.';
  end if;

  if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
    raise exception '1451: record_stock_verification''s variance guard has moved or already changed; fix by hand.';
  end if;

  execute replace(v_def, v_from, v_to);
end;
$mig$;

revoke all on function public.record_stock_verification(uuid, uuid, uuid, uuid, date, numeric, uuid, text) from public, anon;
grant execute on function public.record_stock_verification(uuid, uuid, uuid, uuid, date, numeric, uuid, text) to authenticated;

comment on function public.record_stock_verification(uuid, uuid, uuid, uuid, date, numeric, uuid, text) is
  'Records a physical stock count against the book quantity (get_stock_summary/get_batch_stock_summary) and posts a self-cancelling value adjustment for any variance -- except a variance with no resolvable rate (v_rate = 0), which has no cost basis to post against and is recorded in stock_verifications only, never as a voucher (1451 -- voucher_entries_check forbids a 0/0 entries pair, so attempting one always crashed rather than "posting a zero pair" as previously intended).';
