-- ============================================================================
-- 1450 — Three stock defects that all land in the closing-stock journal
-- ============================================================================
-- A pilot opened TEST Rangoli Spice Works Pvt Ltd, traded it for a month with
-- four preparers and closed it. Three separate things were wrong with the
-- inventory the close capitalised. All three are fixed together because they
-- share one function, get_stock_summary — the only stock valuation in the
-- product, and the number that feeds post_closing_stock, get_drawing_power
-- (the bank's stock statement), get_cma_ratios, Form 3CD clause 14, the
-- balance sheet and cost of sales.
--
-- ---------------------------------------------------------------------------
-- A. A DELIVERY CHALLAN AND ITS INVOICE REMOVED THE SAME GOODS TWICE
-- ---------------------------------------------------------------------------
-- Observed, on Garam Masala 100g Pouch: opening 2,500; a real sale of 1,000 on
-- 05 Sep; a Rule 55 challan sending 500 on approval to the Pune counter on
-- 12 Sep; then invoice SAL/26-27/0004 on 15 Sep for 400 of those same 500.
-- get_stock_summary reported quantity_out 1,900 when only 1,400 was ever sold,
-- and a closing quantity of 600 where 1,100 was on hand — 500 units, 21,000.00
-- at the item's 42.00 carrying rate, missing from the balance sheet and sitting
-- in cost of sales instead.
--
-- The challan is status 'closed' with a delivery_challan_receipts row noting
-- "400 retained, 100 to come back". That receipt posts nothing, by design
-- (0113), so under the old behaviour the 100 never came back either.
--
-- WHY THE CHALLAN MUST NOT RELIEVE STOCK AT ALL. A delivery challan under
-- Rule 55(1) CGST Rules is issued precisely BECAUSE the movement is not a
-- supply — Rule 55(1)(c) is "transportation of goods for reasons other than by
-- way of supply" — or, under Rule 55(5), because it is one instalment of a
-- supply that has ALREADY been invoiced in full (SKD/CKD). Across every purpose
-- 0113 supports (approval/sale-or-return, SKD/CKD, branch transfer on one
-- GSTIN, exhibition, repair, other) the goods stay the company's own property:
--
--   * Section 24, Sale of Goods Act 1930 — on goods delivered "on approval or
--     on sale or return", property passes to the buyer only when the buyer
--     signifies approval or acceptance, or retains them past the fixed or a
--     reasonable time. Until then they are still the seller's goods.
--   * Section 31(7) CGST Act 2017 — for goods sent or taken on approval, the
--     tax invoice is issued before or at the time of supply, or six months from
--     the date of removal, whichever is EARLIER. Six months: several
--     commentaries say "180 days", and that was checked against the section
--     itself rather than recalled.
--   * So the unsold portion is still the consignor's inventory and belongs in
--     its closing stock, exactly as unsold consignment stock does.
--
-- The challan is therefore a movement, not a disposal, and the tax invoice is
-- the one and only event that takes the goods out. That is the whole fix: the
-- goods are counted out exactly once, by the invoice, whenever it comes. The
-- 100 that come back need no posting because they were never removed. Nothing
-- has to be remembered, reconciled or reversed for the arithmetic to stay
-- right, which is what makes this better than a compensating entry.
--
-- The challan's LEDGER pair stays exactly as 0113 built it — a self-cancelling
-- memo, debit and credit of the same amount on the same voucher, so the voucher
-- balances while posting nothing. It was always ledger-neutral. It is now
-- stock-neutral too, which is the half that was missing.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not pretend to know where the
-- goods physically are: a godown-filtered view will show the 500 still in Main
-- Store while they sit at the Pune counter. That is 0113's own declared
-- limitation (its header says the module "is silent about location-level
-- on-hand stock"), and the alternative — relieving the source godown but not
-- the company — would make the per-godown quantities stop adding up to the
-- company quantity, which the stock report explicitly promises on screen that
-- they do. A "goods with third parties" pseudo-location is the right answer and
-- is a feature, not this fix.
--
-- ---------------------------------------------------------------------------
-- B. THE CLOSE CAPITALISED NEGATIVE STOCK
-- ---------------------------------------------------------------------------
-- Red Chilli Powder 500g Pouch closed at -124 units, -16,120.00: opening 900,
-- four sales totalling 1,024, and no purchase anywhere. post_closing_stock
-- summed closing_value across every item and netted the negative in silently.
-- The stock report warns about over-issue after the fact; the posting had no
-- guard at all.
--
-- A negative valuation is not an asset, and it is not really a valuation — it
-- is the books saying a purchase or a delivery is missing. Capitalising it puts
-- a credit inside a debit asset and understates cost of sales by the same
-- amount, and because the journal still balances, every self-consistency check
-- in the app still passes. post_closing_stock now REFUSES, naming the offending
-- items with their quantity and value, rather than posting them or excluding
-- them silently (which would understate inventory just as quietly).
--
-- THE TEST IS closing_value < 0, NOT closing_quantity < 0, and that was
-- measured rather than assumed. A negative quantity on an item that has never
-- had a costed receipt values at rate 0, contributes exactly nothing to the
-- balance sheet, and is already surfaced by the stock report and by 0185's
-- "unpriced quantity". Counted live before choosing: eight seeded companies
-- carry a -100 'Scrap Material' line of precisely that shape. Blocking their
-- close over a figure that capitalises nothing would be a new defect in place
-- of the old one. What must never post is a NEGATIVE VALUE, and that is what is
-- refused.
--
-- ---------------------------------------------------------------------------
-- C. OPENING STOCK WAS REPORTED IN FULL IN EVERY GODOWN
-- ---------------------------------------------------------------------------
-- items.opening_quantity / opening_value carry no godown — there is no table
-- anywhere in this schema that records where opening stock sat. The
-- godown-filtered report handed the WHOLE opening to whichever godown was asked
-- for. Measured live before writing this: Nashik Cold Store, a godown that has
-- never had a single voucher line of any item, reported all eight of the
-- pilot's items at their full opening — 9,84,000.00 of stock that is not there
-- — and the two godowns between them reported the opening twice.
--
-- This is not cosmetic. record_stock_verification reads
-- get_stock_summary(company, date, p_godown_id) as the BOOK quantity for a
-- physical count. A stock-take at Nashik counting zero would have posted a
-- 2,500-unit shortage on Garam Masala alone.
--
-- THE HONEST REPRESENTATION, in the order it is applied:
--
--   1. The opening pre-dates every movement, so the FIRST godown an item was
--      ever recorded in is where its opening stock must have been. That is an
--      inference, and it is written down as one — but it is the only anchor the
--      data contains, it is deterministic, it is stable as the as-at date moves
--      forward, and it preserves the invariant the stock report puts on screen
--      ("quantities filtered to a godown always add up exactly across every
--      godown to the all-godowns figure"). Challan lines count as evidence of
--      location even though they no longer relieve stock.
--   2. Failing that, the company's ONLY godown — with one godown this is not a
--      judgement call at all: the stock is there or it is nowhere. Counted, not
--      assumed active, so a company with one live and one archived godown has
--      two and gets no fallback; fewer inferences is the safer side of that
--      line. Without this step one real company (one godown, one item with
--      opening stock and no movements at all) still failed the adding-up check.
--   3. Failing both — two or more godowns and no movement to go on — the
--      opening is genuinely unplaceable and is placed in NO godown rather than
--      in all of them. Guessing is what produced the reported defect.
--
-- The real fix is to record opening stock per godown, as Tally does. That needs
-- a schema column and an item-master field, i.e. frontend this task does not
-- own; it is written up in the report instead.
--
-- ---------------------------------------------------------------------------
-- HOW THIS IS APPLIED
-- ---------------------------------------------------------------------------
-- Every function is rewritten from its LIVE definition by targeted replace,
-- each replacement asserted, per the 1200/1230/1240 house pattern. No body is
-- retyped: get_stock_summary's weighted-average basis (0074, extended by 1360's
-- landed cost) and get_stock_fifo_layers' layer walk (0185) are both subtle and
-- neither is being changed here.
--
-- Every change is also guarded by a marker so re-running this migration is a
-- no-op rather than an error. That is not decoration: while this was being
-- verified, a concurrent migration replaced get_stock_summary and
-- get_stock_fifo_layers from their pre-1450 source and silently dropped these
-- fixes out of the live database. Re-applicability is how that is recovered.
--
-- get_stock_summary_fifo and get_stock_fifo_layers get the SAME two changes as
-- get_stock_summary even though they feed nothing but the stock report, because
-- they are printed column-by-column beside it on that one screen: a
-- weighted-average closing of 1,100 next to a FIFO closing of 600 for the same
-- item would be a new bug in place of the old one.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The two changes every stock-movement reader needs (A, and C's CTE)
-- ---------------------------------------------------------------------------

do $mig$
declare
  v_fn text;
  v_def text;
  v_before text;
  v_changed boolean;
  v_challan constant text :=
'       and v.voucher_date <= p_as_at
       -- 1450: a Rule 55 delivery challan MOVES goods, it does not dispose of
       -- them -- ownership stays here until a tax invoice is raised (Sec 24
       -- Sale of Goods Act 1930; Sec 31(7) CGST Act). Counting the challan out
       -- as well as the invoice that follows it took the same goods out twice.
       and v.voucher_type <> ''delivery_challan_out''
       and (p_godown_id is null or vi.godown_id = p_godown_id)';
  v_cte constant text :=
'  with item_home_godown as (
    -- 1450: where an item''s OPENING stock sat. items.opening_quantity carries
    -- no godown at all, so a godown-filtered view used to hand the WHOLE
    -- opening to every godown, including ones that never held the item. The
    -- opening pre-dates every movement, so the first godown the item was ever
    -- recorded in is where it must have been; failing that, the company''s ONLY
    -- godown, where there is nowhere else it could be. With two or more godowns
    -- and no movement to go on the opening is genuinely unplaceable, and is
    -- placed in NO godown rather than in all of them. Challan lines count as
    -- evidence of location even though they no longer relieve stock.
    select i2.id as item_id,
           coalesce(f.godown_id, s.godown_id) as godown_id
      from public.items i2
      left join (
        select distinct on (vi.item_id) vi.item_id, vi.godown_id
          from public.voucher_items vi
          join public.vouchers v on v.id = vi.voucher_id
         where vi.company_id = p_company_id
           and not v.is_deleted
           and v.voucher_date <= p_as_at
           and vi.godown_id is not null
         order by vi.item_id, v.voucher_date, v.created_at, vi.id
      ) f on f.item_id = i2.id
      left join (
        select g.id as godown_id
          from public.godowns g
         where g.company_id = p_company_id
           and (select count(*) from public.godowns g2 where g2.company_id = p_company_id) = 1
      ) s on true
     where i2.company_id = p_company_id
  ),
  movements as (';
begin
  foreach v_fn in array array['get_stock_summary', 'get_stock_summary_fifo', 'get_stock_fifo_layers']
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn and p.prokind = 'f'
     limit 1;

    if v_def is null then
      raise exception '1450: public.% is missing.', v_fn;
    end if;

    v_changed := false;

    -- (A) the challan stops relieving stock.
    if position('v.voucher_type <> ''delivery_challan_out''' in v_def) = 0 then
      v_before := v_def;
      v_def := replace(
        v_def,
'       and v.voucher_date <= p_as_at
       and (p_godown_id is null or vi.godown_id = p_godown_id)',
        v_challan
      );
      if v_def = v_before then
        raise exception '1450: %''s movements filter did not match; its body has moved. Fix by hand.', v_fn;
      end if;
      v_changed := true;
    end if;

    -- (C) the opening balance gets somewhere to live.
    if position('item_home_godown' in v_def) = 0 then
      v_before := v_def;
      v_def := replace(v_def, '  with movements as (', v_cte);
      if v_def = v_before then
        raise exception '1450: %''s CTE head did not match. Fix by hand.', v_fn;
      end if;
      v_changed := true;
    end if;

    if v_changed then
      execute v_def;
    else
      raise notice '1450: public.% already carries both movement changes.', v_fn;
    end if;
  end loop;
end;
$mig$;

-- ---------------------------------------------------------------------------
-- 2. C, per function: the opening column stops being unconditional
-- ---------------------------------------------------------------------------

do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_stock_summary' and p.prokind = 'f'
   limit 1;

  if position('loc.godown_id' in v_def) > 0 then
    raise notice '1450: get_stock_summary already attributes its opening balance.';
    return;
  end if;

  v_before := v_def;
  v_def := replace(
    v_def,
'    select i.id, i.name, i.hsn_sac, i.uom,
           i.opening_quantity, i.opening_value,',
'    select i.id, i.name, i.hsn_sac, i.uom,
           case when p_godown_id is null or loc.godown_id = p_godown_id
                then i.opening_quantity else 0 end as opening_quantity,
           case when p_godown_id is null or loc.godown_id = p_godown_id
                then i.opening_value else 0 end as opening_value,'
  );
  if v_def = v_before then
    raise exception '1450: get_stock_summary opening columns did not match. Fix by hand.';
  end if;

  v_before := v_def;
  v_def := replace(
    v_def,
'      left join movements m on m.item_id = i.id',
'      left join movements m on m.item_id = i.id
      left join item_home_godown loc on loc.item_id = i.id'
  );
  if v_def = v_before then
    raise exception '1450: get_stock_summary movements join did not match. Fix by hand.';
  end if;

  v_before := v_def;
  v_def := replace(
    v_def,
'     group by i.id, i.name, i.hsn_sac, i.uom, i.opening_quantity, i.opening_value',
'     group by i.id, i.name, i.hsn_sac, i.uom, i.opening_quantity, i.opening_value, loc.godown_id'
  );
  if v_def = v_before then
    raise exception '1450: get_stock_summary group by did not match. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_stock_summary_fifo' and p.prokind = 'f'
   limit 1;

  if position('loc.godown_id' in v_def) > 0 then
    raise notice '1450: get_stock_summary_fifo already attributes its opening balance.';
    return;
  end if;

  v_before := v_def;
  v_def := replace(
    v_def,
'    select i.id, i.name, i.hsn_sac, i.uom, i.opening_quantity,',
'    select i.id, i.name, i.hsn_sac, i.uom,
           case when p_godown_id is null or loc.godown_id = p_godown_id
                then i.opening_quantity else 0 end as opening_quantity,'
  );
  if v_def = v_before then
    raise exception '1450: get_stock_summary_fifo opening column did not match. Fix by hand.';
  end if;

  v_before := v_def;
  v_def := replace(
    v_def,
'      left join movements m on m.item_id = i.id',
'      left join movements m on m.item_id = i.id
      left join item_home_godown loc on loc.item_id = i.id'
  );
  if v_def = v_before then
    raise exception '1450: get_stock_summary_fifo movements join did not match. Fix by hand.';
  end if;

  v_before := v_def;
  v_def := replace(
    v_def,
'     group by i.id, i.name, i.hsn_sac, i.uom, i.opening_quantity',
'     group by i.id, i.name, i.hsn_sac, i.uom, i.opening_quantity, loc.godown_id'
  );
  if v_def = v_before then
    raise exception '1450: get_stock_summary_fifo group by did not match. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

-- The FIFO layer walk has no opening COLUMN — it has an opening LOT, which is
-- either in this godown or is not a lot of this godown at all.
do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_stock_fifo_layers' and p.prokind = 'f'
   limit 1;

  if position('from item_home_godown h' in v_def) > 0 then
    raise notice '1450: get_stock_fifo_layers already places its opening lot.';
    return;
  end if;

  v_before := v_def;
  v_def := replace(
    v_def,
'      from public.items i
     where i.company_id = p_company_id and i.item_type = ''goods'' and i.maintain_stock
       and i.opening_quantity > 0',
'      from public.items i
     where i.company_id = p_company_id and i.item_type = ''goods'' and i.maintain_stock
       and i.opening_quantity > 0
       -- 1450: the opening lot belongs to the godown the item was first
       -- recorded in, and to no other. See item_home_godown above.
       and (p_godown_id is null
            or exists (select 1 from item_home_godown h
                        where h.item_id = i.id and h.godown_id = p_godown_id))'
  );
  if v_def = v_before then
    raise exception '1450: get_stock_fifo_layers opening lot did not match. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

revoke all on function public.get_stock_summary(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_summary(uuid, date, uuid) to authenticated;

revoke all on function public.get_stock_summary_fifo(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_summary_fifo(uuid, date, uuid) to authenticated;

revoke all on function public.get_stock_fifo_layers(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_fifo_layers(uuid, date, uuid) to authenticated;

comment on function public.get_stock_summary(uuid, date, uuid) is
  'Weighted-average stock valuation — the official closing-stock figure. Closing quantity counts every inward movement; the average rate comes only from inward movements carrying a real cost, so a sales return cannot inflate it (0074, landed cost added 1360). A Rule 55 delivery challan moves goods without disposing of them and never relieves stock; only the tax invoice does, so goods go out exactly once (1450). In a godown-filtered view the unlocated opening balance is attributed to the godown the item was first recorded in, else to the company''s only godown, else to none (1450).';

-- ---------------------------------------------------------------------------
-- 3. B — the close refuses to capitalise a negative valuation
-- ---------------------------------------------------------------------------
-- Rewritten from the live definition, not retyped: 1200 rebound both ledgers in
-- this function to app_private.ledger_for_role, and that binding is the reason
-- a 9,84,000 error is not still live. It must survive untouched.

do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_closing_stock' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1450: post_closing_stock is missing.';
  end if;

  if position('ledger_for_role(p_company_id, ''stock'')' in v_def) = 0 then
    raise exception
      '1450: post_closing_stock no longer binds the stock ledger by role (1200); its body has moved. Fix by hand.';
  end if;

  if position('v_negative' in v_def) > 0 then
    raise notice '1450: post_closing_stock already refuses a negative valuation.';
    return;
  end if;

  v_before := v_def;
  v_def := replace(
    v_def,
'  v_voucher_id uuid;
begin',
'  v_voucher_id uuid;
  v_negative text;
begin'
  );
  if v_def = v_before then
    raise exception '1450: post_closing_stock declare block did not match. Fix by hand.';
  end if;

  v_before := v_def;
  v_def := replace(
    v_def,
'  -- What the stock is actually worth on this date, per the valuation engine.
  select coalesce(sum(s.closing_value), 0) into v_target
    from public.get_stock_summary(p_company_id, p_as_at, null) s;',
'  -- 1450: a negative valuation is not an asset, and it is not really a
  -- valuation either -- it is the books saying a purchase or a delivery is
  -- missing. Summing it in nets a credit inside a debit asset and understates
  -- cost of sales by the same amount, while the journal still balances and
  -- every self-consistency check in the app still passes. Refuse, and name the
  -- items; excluding them silently would be just as wrong the other way.
  -- The test is closing_value, not closing_quantity: a negative quantity on an
  -- item that never had a costed receipt values at rate 0 and capitalises
  -- nothing, and eight live companies carry exactly that shape.
  select string_agg(
           s.item_name
             || '' (''
             || rtrim(trim(to_char(s.closing_quantity, ''FM9999999999990.999'')), ''.'')
             || '' '' || s.uom || '', ''
             || trim(to_char(s.closing_value, ''FM9999999999990.00'')) || '')'',
           ''; '' order by s.item_name)
    into v_negative
    from public.get_stock_summary(p_company_id, p_as_at, null) s
   where s.closing_value < 0;

  if v_negative is not null then
    raise exception
      ''Closing stock cannot be posted as at %. These items value out negative -- more has gone out than ever came in: %. Negative stock is not an asset and must not go onto the balance sheet. Record the missing purchase or delivery, or count the item and post a stock verification adjustment, then post the close again.'',
      to_char(p_as_at, ''DD Mon YYYY''), v_negative;
  end if;

  -- What the stock is actually worth on this date, per the valuation engine.
  select coalesce(sum(s.closing_value), 0) into v_target
    from public.get_stock_summary(p_company_id, p_as_at, null) s;'
  );
  if v_def = v_before then
    raise exception '1450: post_closing_stock valuation read did not match. Fix by hand.';
  end if;

  if position('ledger_for_role(p_company_id, ''changes_in_inventories'')' in v_def) = 0 then
    raise exception '1450: post_closing_stock lost its changes_in_inventories role binding during rewrite. Fix by hand.';
  end if;

  execute v_def;
end;
$mig$;

revoke all on function public.post_closing_stock(uuid, uuid, date, text) from public, anon;
grant execute on function public.post_closing_stock(uuid, uuid, date, text) to authenticated;

comment on function public.post_closing_stock(uuid, uuid, date, text) is
  'Brings inventory onto the balance sheet at a chosen date: Dr the stock ledger, Cr Changes in Inventories (a Direct Expenses contra, NOT an income ledger — see 0076). Posts only the movement since whatever the ledger already carries, so it is safe to re-run as trading continues. Both ledgers are located by ledger_role, never by name (1200). Refuses outright, naming the items, when any item values out negative — negative stock is not an asset (1450).';

-- ---------------------------------------------------------------------------
-- 4. get_stock_ageing — the neighbour that would otherwise now disagree
-- ---------------------------------------------------------------------------
-- The ageing report is not part of this task's stated scope, and it is only
-- touched because the fixes above break it. It walks the SAME movements with
-- its own FIFO consumption to age what is left on hand, so before this
-- migration it agreed with get_stock_summary (both said Garam Masala 600) and
-- after the first three sections it would not (600 against 1,100), on two
-- screens a preparer reads side by side. Measured, not assumed: the
-- disagreement was reproduced live before this section was written.
--
-- It gets exactly the same two changes and nothing else. Its inward leg needs
-- no filter — a challan only ever moves goods 'out'.

do $mig$
declare
  v_def text;
  v_before text;
  v_changed boolean := false;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_stock_ageing' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise notice '1450: get_stock_ageing not present; skipping.';
    return;
  end if;

  if position('v.voucher_type <> ''delivery_challan_out''' in v_def) = 0 then
    v_before := v_def;
    v_def := replace(
      v_def,
'       and v.voucher_date <= p_as_at
       and vi.direction = ''out''
       and (p_godown_id is null or vi.godown_id = p_godown_id)',
'       and v.voucher_date <= p_as_at
       -- 1450: a Rule 55 delivery challan moves goods without disposing of
       -- them, so it is not demand against a FIFO layer either.
       and v.voucher_type <> ''delivery_challan_out''
       and vi.direction = ''out''
       and (p_godown_id is null or vi.godown_id = p_godown_id)'
    );
    if v_def = v_before then
      raise exception '1450: get_stock_ageing outflow filter did not match. Fix by hand.';
    end if;
    v_changed := true;
  end if;

  if position('item_home_godown' in v_def) = 0 then
    v_before := v_def;
    v_def := replace(
      v_def,
'  with base_items as (',
'  with item_home_godown as (
    -- 1450: see get_stock_summary. The synthetic opening layer below belongs
    -- to the godown the item was first recorded in, else the company''s only
    -- godown, else to no godown at all.
    select i2.id as item_id,
           coalesce(f.godown_id, s.godown_id) as godown_id
      from public.items i2
      left join (
        select distinct on (vi.item_id) vi.item_id, vi.godown_id
          from public.voucher_items vi
          join public.vouchers v on v.id = vi.voucher_id
         where vi.company_id = p_company_id
           and not v.is_deleted
           and v.voucher_date <= p_as_at
           and vi.godown_id is not null
         order by vi.item_id, v.voucher_date, v.created_at, vi.id
      ) f on f.item_id = i2.id
      left join (
        select g.id as godown_id
          from public.godowns g
         where g.company_id = p_company_id
           and (select count(*) from public.godowns g2 where g2.company_id = p_company_id) = 1
      ) s on true
     where i2.company_id = p_company_id
  ),
  base_items as ('
    );
    if v_def = v_before then
      raise exception '1450: get_stock_ageing CTE head did not match. Fix by hand.';
    end if;

    v_before := v_def;
    v_def := replace(
      v_def,
'      from base_items
     where opening_quantity > 0',
'      from base_items
     where opening_quantity > 0
       and (p_godown_id is null
            or exists (select 1 from item_home_godown h
                        where h.item_id = base_items.id and h.godown_id = p_godown_id))'
    );
    if v_def = v_before then
      raise exception '1450: get_stock_ageing opening layer did not match. Fix by hand.';
    end if;

    -- Its own comment asserted the old behaviour in so many words. Leaving it
    -- would tell the next reader the opposite of what the code now does.
    v_before := v_def;
    v_def := replace(
      v_def,
'  -- opening_quantity as always-in-scope regardless of godown filter (0013)',
'  -- opening_quantity in a godown view: since 1450 the opening belongs to the
  -- godown the item was first recorded in, and to no other (0013)'
    );
    if v_def = v_before then
      raise exception '1450: get_stock_ageing stale opening comment did not match. Fix by hand.';
    end if;

    v_changed := true;
  end if;

  if v_changed then
    execute v_def;
  else
    raise notice '1450: get_stock_ageing already carries both movement changes.';
  end if;
end;
$mig$;

revoke all on function public.get_stock_ageing(uuid, date, uuid) from public, anon;
grant execute on function public.get_stock_ageing(uuid, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Assert the rewrites actually took, in the live catalogue
-- ---------------------------------------------------------------------------

do $mig$
declare
  v_missing text;
  v_marker text;
begin
  foreach v_marker in array array['delivery_challan_out', 'item_home_godown']
  loop
    select string_agg(p.proname, ', ' order by p.proname) into v_missing
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('get_stock_summary', 'get_stock_summary_fifo',
                         'get_stock_fifo_layers', 'get_stock_ageing')
       and p.prokind = 'f'
       and position(v_marker in pg_get_functiondef(p.oid)) = 0;

    if v_missing is not null then
      raise exception '1450: these stock functions are missing "%": %', v_marker, v_missing;
    end if;
  end loop;

  select pg_get_functiondef(p.oid) into v_missing
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_closing_stock' and p.prokind = 'f'
   limit 1;

  if position('s.closing_value < 0' in v_missing) = 0 then
    raise exception '1450: post_closing_stock has no negative-valuation guard after rewrite.';
  end if;
end;
$mig$;
