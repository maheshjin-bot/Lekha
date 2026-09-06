-- ============================================================================
-- 1350 — balance_opening_balances: the missing "and here is how you fix it"
--        for the gap 0755 diagnosed but deliberately refused to auto-plug
-- ============================================================================
-- 0755 closed the cause (enforce_opening_balance_equity holds the company-wide
-- sum of every ledger opening balance at zero by construction) and shipped a
-- read-only diagnostic (get_unbalanced_opening_balances) for the books that
-- were already out before that trigger existed. It then said, in its own
-- header, what the human is meant to do next: "an admin journals it out to
-- Capital / Reserves once the trial balance is fully keyed in".
--
-- CONFIRMED LIVE, 2 Sep 2026, before writing this:
--   * get_unbalanced_opening_balances has ZERO callers anywhere in app/,
--     components/ or lib/. Nothing has ever shown a user its output.
--   * Three companies are still out, and the number is entirely opening
--     balances in all three — every voucher in the project balances line for
--     line, and period_debit - period_credit is 0.00 for every company:
--       Nexgen Softwares Private Limited  -29,48,500.00  (9 ledgers)
--       Sharma Textiles                    +57,500.00    (2 ledgers)
--       Verma & Associates                 +57,500.00    (2 ledgers)  <- 0755's
--                                                        own motivating example
--     For Nexgen the Balance Sheet page's own `difference` (assets minus
--     liabilities-plus-profit) computes to exactly -29,48,500.00, i.e. the
--     report gap IS the opening-balance gap, to the paisa.
--   * NOT ONE of the three has an "Opening Balance Equity" ledger. That is a
--     precise structural signal, not a guess: after 0755, the very first write
--     of any nonzero opening balance creates that ledger as a side effect, so
--     "no such ledger AND a nonzero total" means every opening balance in
--     these books was keyed before the safeguard shipped. (The one company
--     that does have the ledger — TEST Rangoli Spice Works — carries 0.00 on
--     it and nets to zero.)
--
-- WHAT THIS ADDS, AND WHAT IT REFUSES TO ADD
--   A single admin-invoked RPC that does exactly what 0755's header describes,
--   and nothing else: move the residual difference onto Opening Balance Equity
--   so the statements tally, leaving the reclassification to Capital/Reserves
--   as the ordinary journal it always was.
--
--   It is NOT a migration-time backfill. 0755 declined to correct Verma's
--   57,500 silently because "which ledger is really wrong, and by how much, is
--   a fact about what happened to real money that only a human with the
--   original records can supply". That judgement stands and this migration
--   does not touch a single row of company data — the three companies above
--   are still out the moment this is applied. All this does is give the human
--   0755 was waiting for a button to press, after the UI has shown them the
--   contributing ledgers and the exact write.
--
-- WHY IT IS SAFE TO WRITE OPENING BALANCE EQUITY DIRECTLY
--   Because that is the one write 0755 designed to be done by hand.
--   enforce_opening_balance_equity returns immediately, doing nothing, when
--   the row being written IS Opening Balance Equity — 0755's header: "Editing
--   or deleting it directly (still admin-gated by
--   protect_ledger_financial_fields at depth 1) is how a human reclassifies it
--   to Capital/Reserves, or makes the correction get_unbalanced_opening_balances
--   calls for." So this function's UPDATE does not cascade, does not
--   double-count, and does not need — or get — the pg_trigger_depth() escape
--   hatch 0755 added for the automatic sync. It runs at depth 1 like any other
--   human edit and is admin-gated exactly as that trigger already requires.
--
-- GATE. SECURITY INVOKER, so ledgers_write RLS (can_write_company) still
-- decides the write, plus an explicit app_private.is_company_admin check for a
-- plain-English refusal instead of a generic RLS violation — same shape and
-- same reasoning as update_branch (1320) and delete_company (0010).
-- can_write_company is the wider admin-or-accountant predicate;
-- protect_ledger_financial_fields already narrows opening-balance edits to
-- admins, and the explicit check here says so in words before Postgres says it
-- in jargon.
--
-- CONCURRENCY. The OBE row is locked FOR UPDATE *before* the company-wide sum
-- is computed. Every other path that can change the sum — any opening-balance
-- write on any other ledger — must take that same row lock inside
-- enforce_opening_balance_equity, so two callers cannot both read a stale
-- total. A concurrent ledger insert that has not yet committed is invisible to
-- our snapshot and blocks on our lock; when it resumes, its own trigger applies
-- its delta to OBE and the invariant still holds, because the trigger maintains
-- it incrementally rather than by recomputation.
--
-- p_expected_imbalance IS NOT DECORATION. This changes real financial data
-- from a screen that showed the user a number. If the number moved between the
-- render and the click (another user finishing a trial balance in the next
-- tab), the function refuses rather than quietly absorbing a different figure
-- than the one that was confirmed. Same instinct as showing the write before
-- doing it: never post something the human did not actually see.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The one number this whole feature is about
-- ----------------------------------------------------------------------------
-- The company-wide signed sum of every ledger's opening balance, debit
-- positive — zero for a healthy company, and the figure
-- get_unbalanced_opening_balances (0755) reports as company_total_imbalance.
-- Extracted into a helper because balance_opening_balances below computes it
-- three times (pre-flight refusal, the authoritative read under the row lock,
-- and the post-write assertion) and three hand-copied CASE expressions is
-- three chances for one of them to drift.
create or replace function app_private.opening_balance_total(p_company_id uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select round(coalesce(sum(case when l.opening_balance_type = 'debit'
                                 then l.opening_balance_amount
                                 else -l.opening_balance_amount end), 0), 2)
    from public.ledgers l
   where l.company_id = p_company_id;
$$;

-- Defence in depth, not a live hole. anon holds no USAGE on app_private, so
-- the default PUBLIC EXECUTE grant every function is created with is already
-- unreachable for it — which is exactly why most existing app_private helpers
-- never bothered revoking it. Revoked here anyway: this project has been
-- bitten repeatedly (0064, 0231) by "revoked from anon" quietly being a no-op
-- because PUBLIC still held the grant, and a one-line revoke costs nothing
-- against the day someone widens the schema grant.
revoke all on function app_private.opening_balance_total(uuid) from public, anon;
grant execute on function app_private.opening_balance_total(uuid) to authenticated;

comment on function app_private.opening_balance_total is
  'Company-wide signed sum of ledgers.opening_balance_amount, debit positive. Zero by construction for any company whose opening balances were all written after 0755. Same figure as get_unbalanced_opening_balances.company_total_imbalance.';

create or replace function public.balance_opening_balances(
  p_company_id uuid,
  p_expected_imbalance numeric
) returns table (
  ledger_id uuid,
  ledger_created boolean,
  previous_amount numeric,
  previous_type text,
  new_amount numeric,
  new_type text,
  imbalance_absorbed numeric
)
language plpgsql
security invoker   -- RLS decides; only an admin may edit an opening balance
set search_path = ''
as $$
declare
  v_obe_id uuid;
  v_created boolean := false;
  v_imbalance numeric;
  v_prev_amount numeric;
  v_prev_type text;
  v_prev_signed numeric;
  v_target_signed numeric;
  v_target_amount numeric;
  v_target_type text;
  v_after numeric;
begin
  if not exists (select 1 from public.companies c where c.id = p_company_id) then
    raise exception 'Company not found';
  end if;

  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can move an opening balance difference to Opening Balance Equity';
  end if;

  -- Refuse BEFORE find-or-create, not after. This unlocked read is not the
  -- authoritative one (see the re-read under the row lock below) — its only
  -- job is to make a refusal genuinely side-effect-free, so a company that
  -- already balances, or a screen showing a stale figure, never leaves a
  -- freshly created Opening Balance Equity ledger behind. The exception would
  -- roll the insert back anyway; a function that says it changed nothing
  -- should not have to rely on that.
  v_imbalance := app_private.opening_balance_total(p_company_id);
  if v_imbalance = 0 then
    raise exception 'These opening balances already net to zero — there is nothing to move';
  end if;
  if round(coalesce(p_expected_imbalance, 0), 2) <> v_imbalance then
    raise exception 'The opening balance difference is now %, not the % this screen was showing. Reload the report and check the figures before moving anything.',
      v_imbalance, round(coalesce(p_expected_imbalance, 0), 2);
  end if;

  -- Does it already exist? Asked before the find-or-create below, purely so
  -- the caller can honestly report "created" vs "updated" in its confirmation.
  select l.id into v_obe_id
    from public.ledgers l
   where l.company_id = p_company_id
     and lower(l.name) = 'opening balance equity';
  v_created := v_obe_id is null;

  -- 0755's own race-safe find-or-create, reused rather than reimplemented: it
  -- files the ledger under the company's system Capital Account group and
  -- handles two concurrent first-ever callers via ON CONFLICT. SECURITY
  -- DEFINER there, and authenticated holds USAGE on app_private plus EXECUTE
  -- on this function, so an invoker-rights caller can reach it.
  v_obe_id := app_private.opening_balance_equity_ledger(p_company_id);
  if v_obe_id is null then
    raise exception 'Could not find or create the Opening Balance Equity ledger for this company';
  end if;

  -- Lock first, total second — see CONCURRENCY in the header. This, not the
  -- pre-flight read above, is the total the write is computed from.
  select l.opening_balance_amount, l.opening_balance_type
    into v_prev_amount, v_prev_type
    from public.ledgers l
   where l.id = v_obe_id
   for update;

  v_prev_signed := case when v_prev_type = 'debit' then v_prev_amount else -v_prev_amount end;

  v_imbalance := app_private.opening_balance_total(p_company_id);

  if v_imbalance = 0 then
    raise exception 'These opening balances already net to zero — there is nothing to move';
  end if;

  if round(coalesce(p_expected_imbalance, 0), 2) <> v_imbalance then
    raise exception 'The opening balance difference is now %, not the % this screen was showing. Reload the report and check the figures before moving anything.',
      v_imbalance, round(coalesce(p_expected_imbalance, 0), 2);
  end if;

  -- The whole arithmetic of this function, in one line. v_imbalance already
  -- INCLUDES Opening Balance Equity's own current balance, so the new balance
  -- is the old one less the total, not simply the negated total.
  v_target_signed := round(v_prev_signed - v_imbalance, 2);
  v_target_amount := abs(v_target_signed);
  v_target_type := case when v_target_signed >= 0 then 'debit' else 'credit' end;

  update public.ledgers l
     set opening_balance_amount = v_target_amount,
         opening_balance_type = v_target_type
   where l.id = v_obe_id;

  -- Belt and braces: assert the thing this function exists to guarantee,
  -- rather than trusting that no future trigger quietly broke it. A failed
  -- assertion rolls the whole call back; half-moving a difference would be
  -- worse than not moving it.
  v_after := app_private.opening_balance_total(p_company_id);

  if v_after <> 0 then
    raise exception 'Opening balances still do not net to zero after the move (off by %) — nothing was changed', v_after;
  end if;

  return query
    select v_obe_id, v_created, v_prev_amount, v_prev_type,
           v_target_amount, v_target_type, v_imbalance;
end;
$$;

revoke all on function public.balance_opening_balances(uuid, numeric) from public, anon;
grant execute on function public.balance_opening_balances(uuid, numeric) to authenticated;

comment on function public.balance_opening_balances(uuid, numeric) is
  'Admin-only. Moves a company''s residual ledger-opening-balance difference — the one get_unbalanced_opening_balances (0755) reports — onto the standing Opening Balance Equity ledger, creating it if needed, so the Trial Balance and Balance Sheet tally. Posts no voucher and touches no other ledger. p_expected_imbalance must match the current difference to the paisa, so the write can only ever be the one the user was shown. See 1350 header.';
