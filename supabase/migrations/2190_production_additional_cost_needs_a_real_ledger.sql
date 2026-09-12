-- ============================================================================
-- 2190: create_production_voucher's p_additional_cost fabricated finished-
-- goods value out of nothing.
--
-- WHAT WAS WRONG, reproduced live before writing this fix. Every production
-- run on TEST Precision Engineering Pvt Ltd (f2557c28-73ec-43a1-9769-
-- d346e21548f6) that carried a p_additional_cost — real figures of 750.00
-- and 380.00 were found on real vouchers — had that amount added straight
-- into the finished good's valuation (v_effective_cost = v_component_cost +
-- p_additional_cost), but the GL side posted BOTH legs to the SAME
-- "Manufacturing Clearing" ledger, for the SAME amount:
--
--   insert ... values (..., v_clearing_ledger, v_effective_cost_r, 0, 0);
--   insert ... values (..., v_clearing_ledger, 0, v_effective_cost_r, 1);
--
-- Confirmed against this company's real posting history: summed over every
-- production voucher ever posted, Manufacturing Clearing's total debit and
-- total credit are both exactly 9,580.00 — net always zero, by construction,
-- no matter what a preparer types into the additional-cost field. Nothing
-- is reduced anywhere else in the books, no cash moves, no expense goes
-- down — the extra value has no real source. Once a company legitimately
-- has more than one ledger in the finished-goods stock role (this same
-- manufacturer has both Raw Material Stock and Finished Goods Stock), that
-- fabricated value reaches closing stock and inflates gross profit with
-- nothing behind it, and today nothing stops any number being typed in.
--
-- THE FIX. p_additional_cost now requires a real, company-owned, expense-
-- nature ledger (p_cost_ledger_id — direct_expense or indirect_expense; the
-- check constraint on account_groups.nature is the authority for what those
-- values are) to fund it FROM. The raw-material portion of the batch still
-- moves through Manufacturing Clearing both ways exactly as before — that
-- part is a genuine stock-to-stock reclass (raw material becoming finished
-- goods at unchanged total value) with no real GL effect, so it stays
-- self-cancelling. The additional-cost portion no longer rides along on
-- that same wash: it is credited OUT of the named expense ledger instead,
-- so:
--
--   Dr Manufacturing Clearing   v_effective_cost_r   (unchanged amount)
--   Cr Manufacturing Clearing   v_component_cost_r    (component cost only)
--   Cr <named expense ledger>   v_additional_cost_r   (only when > 0)
--
-- Manufacturing Clearing is left carrying a genuine, non-zero debit balance
-- of exactly the additional cost — the overhead now embedded in unsold
-- finished-goods stock — funded by an equal, real reduction in a real
-- expense ledger's balance (AS 2 / Ind AS 2 para 13: costs of conversion,
-- including production overheads, are included in inventory cost, not left
-- sitting in the period's expense). That is a genuine sacrifice: the named
-- ledger's balance actually moves, which is exactly what was missing.
--
-- No ledger of this kind is auto-created — the task named none as an
-- existing convention across companies, and this pilot company's own chart
-- of accounts (checked live) has no ledger already earmarked for
-- "manufacturing overhead absorbed into production": its Direct Expenses
-- group holds only Freight Inward and Changes in Inventories, and its
-- Indirect Expenses group holds Depreciation, Employer ESI/PF Contribution
-- and Salary Expense — none of them is a dedicated absorption ledger. Rather
-- than invent and silently seed a specific name every company may not want,
-- the preparer NAMES an existing expense ledger (or is expected to create
-- one first, through the ordinary ledger screen — out of this migration's
-- scope, see the accompanying report) each time they enter a real additional
-- cost. p_additional_cost = 0 (or NULL, coalesced to 0) needs no ledger at
-- all and posts exactly as it always has — the ordinary, overwhelmingly
-- common case is untouched.
--
-- METHOD. Read the live definition, apply targeted, asserted replacements —
-- the pattern 1200/1230/1240/1430 already use — then execute. Nothing else
-- in the function (the by-product/scrap/co-product joint-cost logic added
-- since 0070/0114) is retyped or disturbed.
-- ============================================================================

do $mig$
declare
  v_def text;
  v_new text;
  v_hits int;
  v_old_identity text;

  -- 0. Signature: add the new (optional-when-zero) parameter at the end, so
  --    every existing positional call remains valid unchanged. Anchored on
  --    the tail AS OF 2090 (p_allow_negative_stock, applied concurrently by
  --    another session in this same shared database/tree while this
  --    migration was being written — re-checked live immediately before
  --    this file's final form) so this still matches whichever of the two
  --    migrations happens to apply second.
  c_t0 constant text := $t0$p_additional_cost numeric DEFAULT 0, p_narration text DEFAULT NULL::text, p_allow_negative_stock boolean DEFAULT false)$t0$;
  c_r0 constant text := $r0$p_additional_cost numeric DEFAULT 0, p_narration text DEFAULT NULL::text, p_allow_negative_stock boolean DEFAULT false, p_cost_ledger_id uuid DEFAULT NULL::uuid)$r0$;

  -- 1. Declare block: the two rounded pieces the GL entries need, plus the
  --    scratch var for the chosen ledger's account-group nature.
  c_t1 constant text := $t1$  v_effective_cost_r numeric;
  v_output_rate numeric;$t1$;
  c_r1 constant text := $r1$  v_effective_cost_r numeric;
  v_component_cost_r numeric;
  v_additional_cost_r numeric;
  v_cost_ledger_nature text;
  v_output_rate numeric;$r1$;

  -- 2. Guard: a nonzero additional cost must name a real, company-owned
  --    expense-nature ledger. (Also null-safes p_additional_cost itself —
  --    passed explicitly as NULL it used to bypass the "< 0" check and
  --    poison every downstream sum.)
  c_t2 constant text := $t2$  if p_additional_cost < 0 then
    raise exception 'Additional cost cannot be negative';
  end if;$t2$;
  c_r2 constant text := $r2$  p_additional_cost := coalesce(p_additional_cost, 0);
  if p_additional_cost < 0 then
    raise exception 'Additional cost cannot be negative';
  end if;

  if p_additional_cost > 0 then
    if p_cost_ledger_id is null then
      raise exception 'Additional cost needs a real ledger to fund it from — name the manufacturing-overhead or direct-cost expense ledger this cost should reduce';
    end if;

    select g.nature into v_cost_ledger_nature
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.id = p_cost_ledger_id
       and l.company_id = p_company_id
       and l.is_active;

    if v_cost_ledger_nature is null then
      raise exception 'The chosen cost ledger does not exist, is inactive, or does not belong to this company';
    end if;

    if v_cost_ledger_nature not in ('direct_expense', 'indirect_expense') then
      raise exception 'Additional cost must be funded from a real expense ledger (manufacturing overhead or a direct cost) — the chosen ledger is a % account, not an expense', v_cost_ledger_nature;
    end if;
  end if;$r2$;

  -- 3. Compute the two rounded pieces separately (v_component_cost is
  --    already an exact sum of 2-decimal line amounts, so
  --    v_component_cost_r + v_additional_cost_r == round(v_component_cost +
  --    p_additional_cost, 2) always — byte-identical to the old single
  --    rounding when p_additional_cost is 0).
  c_t3 constant text := $t3$  v_effective_cost := v_component_cost + p_additional_cost;
  v_effective_cost_r := round(v_effective_cost, 2);$t3$;
  c_r3 constant text := $r3$  v_effective_cost := v_component_cost + p_additional_cost;
  v_component_cost_r := round(v_component_cost, 2);
  v_additional_cost_r := round(p_additional_cost, 2);
  v_effective_cost_r := v_component_cost_r + v_additional_cost_r;$r3$;

  -- 4. The GL entries themselves: split the credit leg instead of routing
  --    the whole effective cost back to the same self-cancelling ledger.
  c_t4 constant text := $t4$  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_clearing_ledger, v_effective_cost_r, 0, 0);
  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_clearing_ledger, 0, v_effective_cost_r, 1);$t4$;
  c_r4 constant text := $r4$  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_clearing_ledger, v_effective_cost_r, 0, 0);
  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_clearing_ledger, 0, v_component_cost_r, 1);

  if v_additional_cost_r > 0 then
    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_voucher_id, p_company_id, p_branch_id, p_cost_ledger_id, 0, v_additional_cost_r, 2);
  end if;$r4$;
begin
  select pg_get_functiondef(p.oid), pg_get_function_identity_arguments(p.oid)
    into v_def, v_old_identity
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'create_production_voucher'
     and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '2190: public.create_production_voucher is missing.';
  end if;

  if position('p_cost_ledger_id' in v_def) > 0 then
    raise exception '2190: create_production_voucher already has p_cost_ledger_id. Nothing to do; review before re-running.';
  end if;

  v_new := v_def;

  v_hits := (length(v_new) - length(replace(v_new, c_t0, ''))) / length(c_t0);
  if v_hits <> 1 then
    raise exception '2190: expected exactly 1 signature tail, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_t0, c_r0);

  v_hits := (length(v_new) - length(replace(v_new, c_t1, ''))) / length(c_t1);
  if v_hits <> 1 then
    raise exception '2190: expected exactly 1 declare-block anchor, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_t1, c_r1);

  v_hits := (length(v_new) - length(replace(v_new, c_t2, ''))) / length(c_t2);
  if v_hits <> 1 then
    raise exception '2190: expected exactly 1 negative-cost guard, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_t2, c_r2);

  v_hits := (length(v_new) - length(replace(v_new, c_t3, ''))) / length(c_t3);
  if v_hits <> 1 then
    raise exception '2190: expected exactly 1 effective-cost computation, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_t3, c_r3);

  v_hits := (length(v_new) - length(replace(v_new, c_t4, ''))) / length(c_t4);
  if v_hits <> 1 then
    raise exception '2190: expected exactly 1 clearing-ledger GL-entry pair, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_t4, c_r4);

  execute v_new;

  -- CREATE OR REPLACE cannot replace a function whose signature gained a
  -- parameter — it creates a second, separate overload alongside the old
  -- one instead (confirmed live: this is exactly what happened on first
  -- application here, leaving the pre-2190 signature still callable and
  -- still carrying the fabrication bug). Drop the old signature explicitly
  -- so every caller — regardless of how many of the trailing DEFAULT
  -- arguments it supplies — resolves to the one, fixed function.
  execute format('drop function if exists public.create_production_voucher(%s)', v_old_identity);
end;
$mig$;

-- Grants restated rather than assumed — CREATE OR REPLACE preserves the ACL
-- of the OLD signature, but this migration changes the signature (adds a
-- trailing uuid parameter), which creates a fresh function identity that
-- needs its own grants stated explicitly. Revoking from anon alone is a
-- no-op (anon inherits PUBLIC's default EXECUTE) — name both.
revoke all on function public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text, boolean, uuid) from public, anon;
grant execute on function public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text, boolean, uuid) to authenticated;
grant execute on function public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text, boolean, uuid) to service_role;

comment on function public.create_production_voucher(uuid, uuid, uuid, numeric, uuid, uuid, date, numeric, text, boolean, uuid) is
  'Posts a production (stock journal) voucher off a BOM: consumes components at their current average rate, values the output(s) at total process cost (component cost + p_additional_cost), splitting joint cost across by-product/scrap/co-product outputs per Ind AS 2 paras 13-14 / CAS-19 where the BOM has them (0114). GL side (2190): the component-cost portion still moves through the self-cancelling Manufacturing Clearing ledger both ways (a pure stock-to-stock reclass, no real P&L effect) — but p_additional_cost > 0 now REQUIRES p_cost_ledger_id, a real, company-owned, expense-nature ledger (direct_expense or indirect_expense) that is credited by that amount, leaving Manufacturing Clearing with a genuine non-zero debit balance equal to the overhead absorbed into unsold finished-goods stock. p_additional_cost = 0/NULL needs no ledger and posts byte-identical to the pre-2190 behaviour. Does not itself unwind that absorbed balance against COGS when the stock is later sold — that reconciliation, if wanted, is a separate, larger piece of work.';
