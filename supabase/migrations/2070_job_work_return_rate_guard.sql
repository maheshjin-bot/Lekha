-- ============================================================================
-- 2070 — Job work return Rate defaults to 0, which the database itself
-- refuses, forcing a workaround that corrupts stock valuation
-- ============================================================================
-- REPRODUCED LIVE against TEST Precision Engineering Pvt Ltd, Machined Flange
-- Bracket FB-200 (opening 500 @ 612.00 = 306,000.00, so a real, known
-- ₹612.00/unit cost). Challan HOJWO26/0002 correctly sent 100 units out at
-- 612.00. Its return, HOJWI26/0002, received 85 back -- with the UI's Rate
-- field defaulting to blank/0 and no prefill anywhere, a preparer typed the
-- placeholder "1" (recorded in the return's own notes: "rate=1 typed only to
-- get past the blank-rate/0 posting error") just to get past a raw, opaque
-- Postgres error, because create_job_work_return posts a SELF-CANCELLING
-- Dr/Cr pair on the "Job Work Movement" ledger (0069) and that pair is (0, 0)
-- whenever p_rate is left at its default -- which voucher_entries_check
-- (0007) refuses outright:
--
--   check ((debit_amount > 0 and credit_amount = 0)
--       or (credit_amount > 0 and debit_amount = 0))
--
-- 0069's own header comment claims "If v_amount is zero (no rate given),
-- still post the pair at zero so >=2 lines exists" -- verified here that this
-- has never actually been true; the constraint has always rejected it.
--
-- THE DAMAGE. get_stock_summary (0074, unchanged by this migration -- see
-- part 3 below) folds every inward movement except a credit_note into the
-- weighted-average cost basis, and job_work_in was never added to that
-- exclusion list. The placeholder rate=1 on 85 units fed the average as a
-- real ₹1/unit cost:
--
--   avg = (opening_value + costed_value_in) / (opening_quantity + costed_qty_in)
--       = (306,000.00 + 85 * 1.00) / (500 + 85)
--       = 306,085.00 / 585
--       = 523.22   (rounded)
--
-- against the true 612.00 -- a corruption that applies to EVERY unit in the
-- pool, not just the 85 returned. At the 485 units on hand the moment this
-- posted (500 opening + 85 in - 100 out), that is 485 * (612.00 - 523.22) =
-- 43,058.30 of correct carrying value silently wiped out; at today's 405
-- units on hand it is 405 * (612.00 - 523.22) = 35,955.90 -- and it never
-- self-corrects, because avg_rate here depends only on opening and inward
-- movements, never on what is later sold or shipped out.
--
-- THIS MIGRATION, THREE PARTS:
--
--   1. create_job_work_return and create_job_work_challan now REFUSE a
--      genuinely zero/blank rate with a clear, actionable message, before
--      any insert -- never again the raw voucher_entries_check text.
--   2. The already-live corrupted entry (HOJWI26/0002) is corrected back to
--      the item's real cost, derived from data already on file (the rate its
--      own dispatch challan used), not a hand-typed constant.
--   3. get_stock_summary's treatment of job_work_in is a DELIBERATE
--      non-change -- see the design note ahead of part 3.
--
-- The UI half of this fix (Rate field prefill, components/job-work/
-- JobWorkManager.tsx) ships alongside this migration in the same commit.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Part 1a — create_job_work_challan refuses a zero/blank rate up front.
-- ---------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_job_work_challan' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '2070: public.create_job_work_challan is missing.';
  end if;

  if position('A rate greater than zero is required to value goods sent for job work' in v_def) > 0 then
    raise notice '2070: create_job_work_challan already carries the zero-rate guard.';
  else
    v_before := v_def;
    v_def := replace(
      v_def,
'  if p_statutory_limit_type not in (''input'', ''capital_good'', ''exempt_tool'') then
    raise exception ''% is not a recognised statutory limit type'', p_statutory_limit_type;
  end if;

  v_amount := round(p_quantity * coalesce(p_rate, 0), 2);',
'  if p_statutory_limit_type not in (''input'', ''capital_good'', ''exempt_tool'') then
    raise exception ''% is not a recognised statutory limit type'', p_statutory_limit_type;
  end if;
  -- 2070: a zero/blank rate used to sail through to a raw, unactionable
  -- voucher_entries_check (0,0) failure at the insert below -- see migration
  -- header. Refuse it here instead, before anything is written.
  if coalesce(p_rate, 0) <= 0 then
    raise exception ''A rate greater than zero is required to value goods sent for job work — it prices the dispatch for the job-work-out voucher and the ITC-04 record. Enter the item''''s current cost (the screen suggests one); it cannot be left blank or zero.'';
  end if;

  v_amount := round(p_quantity * coalesce(p_rate, 0), 2);'
    );
    if v_def = v_before then
      raise exception '2070: create_job_work_challan''s statutory-limit-type block did not match; its body has moved. Fix by hand.';
    end if;

    -- The self-cancelling-pair comment claimed a zero pair "still posts" --
    -- verified false (see migration header). p_rate > 0 is now guaranteed,
    -- so say that instead of repeating the disproved claim.
    v_before := v_def;
    v_def := replace(
      v_def,
'  -- Self-cancelling pair — see migration header for why. If v_amount is
  -- zero (no rate given), still post the pair at zero so >=2 lines exists.',
'  -- Self-cancelling pair — see migration header for why. p_rate is now
  -- guaranteed > 0 (checked above), so v_amount is always a real value here;
  -- 0069''s claim that a zero pair "still posts" was never actually true --
  -- voucher_entries_check forbids (0, 0) outright (2070).'
    );
    if v_def = v_before then
      raise exception '2070: create_job_work_challan''s self-cancelling-pair comment did not match. Fix by hand.';
    end if;

    execute v_def;
    raise notice '2070: create_job_work_challan now refuses a zero/blank rate.';
  end if;
end;
$mig$;

revoke all on function public.create_job_work_challan(uuid, uuid, uuid, uuid, numeric, text, uuid, numeric, date, text, date, text, text) from public, anon;
grant execute on function public.create_job_work_challan(uuid, uuid, uuid, uuid, numeric, text, uuid, numeric, date, text, date, text, text) to authenticated;

comment on function public.create_job_work_challan(uuid, uuid, uuid, uuid, numeric, text, uuid, numeric, date, text, date, text, text) is
  'Creates the job_work_out voucher (real stock movement out of the godown, valued at p_rate), the self-cancelling Job Work Movement ledger pair that satisfies check_voucher_balance, and the challan header, atomically. p_rate must be > 0 (2070) -- a zero/blank rate is refused here with an actionable message rather than reaching the raw voucher_entries_check (0,0) violation. v1 is one item per challan.';

-- ---------------------------------------------------------------------------
-- Part 1b — create_job_work_return refuses a zero/blank rate up front, only
-- when goods are actually being received back into stock (a loss/waste-only
-- return posts no voucher and needs no rate at all).
-- ---------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_job_work_return' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '2070: public.create_job_work_return is missing.';
  end if;

  if position('A rate greater than zero is required to receive goods back into stock' in v_def) > 0 then
    raise notice '2070: create_job_work_return already carries the zero-rate guard.';
  else
    v_before := v_def;
    v_def := replace(
      v_def,
'  if p_quantity_received > 0 then
    if p_godown_id is null then
      raise exception ''A godown is required to receive returned goods back into stock'';
    end if;
    v_amount := round(p_quantity_received * coalesce(p_rate, 0), 2);',
'  if p_quantity_received > 0 then
    if p_godown_id is null then
      raise exception ''A godown is required to receive returned goods back into stock'';
    end if;
    -- 2070: a zero/blank rate used to sail through to a raw, unactionable
    -- voucher_entries_check (0,0) failure at the insert below, which drove
    -- preparers to type an arbitrary nonzero placeholder that then corrupted
    -- stock valuation instead -- see migration header. Refuse it here
    -- instead. Goods that are genuinely worth nothing on return are
    -- quantity_loss_or_waste, not a quantity_received at a fictitious rate.
    if coalesce(p_rate, 0) <= 0 then
      raise exception ''A rate greater than zero is required to receive goods back into stock — it values this job-work-in voucher and feeds the item''''s stock valuation. Enter the item''''s current cost (the screen suggests one), or its real value if this batch is genuinely different; if it is worth nothing at all, record it as loss/waste instead.'';
    end if;
    v_amount := round(p_quantity_received * coalesce(p_rate, 0), 2);'
    );
    if v_def = v_before then
      raise exception '2070: create_job_work_return''s quantity_received block did not match; its body has moved. Fix by hand.';
    end if;

    execute v_def;
    raise notice '2070: create_job_work_return now refuses a zero/blank rate when receiving goods back into stock.';
  end if;
end;
$mig$;

revoke all on function public.create_job_work_return(uuid, uuid, uuid, date, numeric, uuid, uuid, numeric, numeric, text) from public, anon;
grant execute on function public.create_job_work_return(uuid, uuid, uuid, date, numeric, uuid, uuid, numeric, numeric, text) to authenticated;

comment on function public.create_job_work_return(uuid, uuid, uuid, date, numeric, uuid, uuid, numeric, numeric, text) is
  'Records a return against a challan — received quantity (posts a real job_work_in voucher moving stock back in at p_rate, which must be > 0 (2070); the item actually returned may differ from what was sent) and/or loss/waste (no voucher, just recorded, no rate needed). Guards received+loss (cumulative across all returns) never exceeding what was sent, and auto-closes the challan when it does.';

-- ---------------------------------------------------------------------------
-- Part 2 — correct the one already-posted casualty of this bug: HOJWI26/0002
-- (TEST Precision Engineering, return_voucher_id 2666c676-9279-489e-8a08-
-- 160fa3b53f77), which posted 85 units of Machined Flange Bracket FB-200 at
-- the typed placeholder rate=1 instead of a real cost. Idempotent and
-- guarded: it touches nothing unless it finds exactly the known pre-fix
-- state, and derives the correction from data already on file (the rate the
-- item's OWN dispatch challan used -- 612.00, matching its 500 @ 306,000.00
-- opening exactly) rather than a typed-in constant.
-- ---------------------------------------------------------------------------
do $data_fix$
declare
  v_vi record;
  v_correct_rate numeric;
  v_correct_amount numeric;
  v_touched integer;
begin
  select id, voucher_id, item_id, quantity, rate, amount
    into v_vi
    from public.voucher_items
   where id = '7fadb7be-22e8-4611-a612-e1a432d3da1f';

  if v_vi.id is null then
    raise notice '2070: reproduction row (voucher_items 7fadb7be...) not found in this database -- nothing to correct here.';
    return;
  end if;

  if v_vi.rate <> 1.00 or v_vi.amount <> 85.00 or v_vi.quantity <> 85.000
     or v_vi.item_id <> '58db0476-e9aa-4035-917e-4399bbbed643'::uuid then
    raise notice '2070: voucher_items 7fadb7be... is no longer in the known pre-fix state (rate %, amount %, qty %, item %) -- presumably already corrected or edited since. Leaving it alone.',
      v_vi.rate, v_vi.amount, v_vi.quantity, v_vi.item_id;
    return;
  end if;

  -- The real cost: what this exact item's own out-challan (the challan this
  -- return is against) was valued at on the way out.
  select vi_out.rate into v_correct_rate
    from public.job_work_returns r
    join public.job_work_challans c on c.id = r.challan_id
    join public.voucher_items vi_out
      on vi_out.voucher_id = c.voucher_id and vi_out.item_id = c.item_id
   where r.return_voucher_id = v_vi.voucher_id;

  if v_correct_rate is null or v_correct_rate <= 0 then
    raise exception '2070: could not derive a real dispatch rate to correct voucher_items % with -- refusing to guess. Fix by hand.', v_vi.id;
  end if;

  v_correct_amount := round(v_vi.quantity * v_correct_rate, 2);

  update public.voucher_items
     set rate = v_correct_rate, amount = v_correct_amount
   where id = v_vi.id;

  -- The self-cancelling Job Work Movement pair on the same voucher carries
  -- the same (now wrong) 85.00 on whichever side each row was posted.
  update public.voucher_entries
     set debit_amount = case when debit_amount = v_vi.amount then v_correct_amount else debit_amount end,
         credit_amount = case when credit_amount = v_vi.amount then v_correct_amount else credit_amount end
   where voucher_id = v_vi.voucher_id
     and (debit_amount = v_vi.amount or credit_amount = v_vi.amount);
  get diagnostics v_touched = row_count;
  if v_touched <> 2 then
    raise exception '2070: expected to correct exactly 2 voucher_entries rows on voucher %, touched % -- fix by hand.', v_vi.voucher_id, v_touched;
  end if;

  -- trg_voucher_entries_balance (deferred constraint trigger) recomputes
  -- vouchers.total_amount from the new debit sum automatically at commit.
  raise notice '2070: corrected HOJWI26/0002 (voucher_items %) from the rate=1 placeholder to the item''s real cost %/unit -- amount % -> %.',
    v_vi.id, v_correct_rate, v_vi.amount, v_correct_amount;
end;
$data_fix$;

-- ---------------------------------------------------------------------------
-- Part 3 — DELIBERATE NON-CHANGE: get_stock_summary keeps folding job_work_in
-- into the weighted-average cost basis exactly as it does today. Explained
-- and justified here rather than silently left alone.
-- ---------------------------------------------------------------------------
-- The task brief asks whether job_work_in should be excluded from
-- costed_value_in the same way credit_note already is (0074), so a return
-- adds its quantity back at the stock's EXISTING average rather than at
-- whatever the return voucher's rate happens to be.
--
-- credit_note is excluded for a structural reason: create_invoice ALWAYS
-- writes its line at the SALE price, and a sale price is categorically never
-- a cost -- there is no path by which a credit note's amount could be right,
-- so it must always be excluded, unconditionally.
--
-- job_work_in is different in kind, not degree. Its rate is not manufactured
-- by the posting function from an unrelated number -- it is exactly whatever
-- the preparer enters for THIS specific batch, precisely because a job-work
-- return can legitimately cost something other than the stock's pre-existing
-- average:
--   * Sec 143(1)(a) CGST Act contemplates goods returning from a job worker
--     "after completion of job work" -- the value received back properly
--     includes the job worker's conversion charge (Ind AS 2 / AS 2 both
--     capitalise conversion costs into inventory), which should legitimately
--     push the average UP, not leave it untouched.
--   * A return can also legitimately be worth LESS than what was sent --
--     material scrapped or degraded in processing coming back at a real,
--     lower value (this migration's own control case).
-- Making job_work_in unconditionally rate-neutral (mirroring credit_note)
-- would make BOTH of those legitimate, real cost events unrepresentable --
-- exactly the opposite of what a preparer who knows a genuinely better number
-- must be able to do (task's explicit requirement).
--
-- What actually caused the ₹43,000 corruption was never "job_work_in
-- participates in the weighted average" -- a weighted-average system is
-- SUPPOSED to absorb a real inward cost, same as a purchase. The corruption
-- was that the preparer was forced to enter a number they knew was fictitious
-- because the screen offered no honest default and the database offered no
-- earlier refusal. Part 1 of this migration removes the forcing (refuse
-- rather than accept 0), and the paired UI change
-- (components/job-work/JobWorkManager.tsx) removes the blankness (prefill
-- the Rate field with the item's own live weighted-average rate from
-- get_stock_summary, editable, never blank-by-default).
--
-- With that fix in place, the common case -- the same item returning with
-- nothing genuinely different about it -- is rate-neutral BY CONSTRUCTION,
-- not by a special-cased exclusion: accepting the suggested default (today's
-- average) adds N units at exactly today's average, which leaves a weighted
-- average unchanged by definition. Verified in this migration's own proof
-- (see the report): 85 units accepted at the suggested 612.00 against an
-- 612.00 pool leaves the average at 612.00 to the cent. A deliberate override
-- (this migration's control case) still moves it, correctly, exactly as a
-- genuinely different-cost purchase would.
--
-- No SQL change follows from this design decision -- get_stock_summary
-- (0074, extended by 1360/1450/1451) is unchanged by this migration.
-- ============================================================================
