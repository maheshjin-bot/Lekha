-- ============================================================================
-- 0755 — Opening balances can silently unbalance the books: a real ₹57,500
--        gap in Verma & Associates, found live
-- ============================================================================
-- CONFIRMED LIVE, before writing a line of fix:
--
--   * public.ledgers.opening_balance_amount / opening_balance_type (0006) is
--     a bare pair of columns on ONE ledger row. Nothing in 0006 through 0745
--     requires the SET of opening balances across a company to net to zero,
--     and nothing posts an offsetting entry anywhere else when one is set.
--   * app_private.ledger_opening_signed (0009) — the shared helper behind
--     get_trial_balance, get_ledger_statement AND get_balance_sheet — reads
--     that pair straight off the ledger row as its base term:
--
--       coalesce((select case when opening_balance_type = 'debit'
--                             then opening_balance_amount else -opening_balance_amount end
--                   from ledgers where id = p_ledger_id), 0)
--       + <every voucher_entries line before p_before>
--
--     There is no third term anywhere that reconciles one ledger's opening
--     balance against another's. A lone nonzero opening balance is simply
--     carried forever, on every report that calls this helper.
--   * components/ledgers/LedgerManager.tsx creates ledgers ONE AT A TIME via
--     a direct `.insert()` on public.ledgers — there is no "enter the whole
--     trial balance at once" screen, and no batch-commit step. The CSV
--     ledger importer (components/csv/LedgerImport.tsx) and the Tally
--     importer both also insert ledger-by-ledger.
--   * Confirmed: "Chennai Overseas Facilitators" (12,500 Dr) and "Lonestar
--     Apparel Imports LLC" (45,000 Dr) each carry a nonzero opening balance
--     with no offsetting entry anywhere in Verma & Associates' chart of
--     accounts. 12,500 + 45,000 = 57,500 — exactly the live Trial
--     Balance / Balance Sheet gap.
--
-- THE CHOICE: auto-post the offsetting side to a standing "Opening Balance
-- Equity" ledger the moment an opening balance is set (shape (b) in the task),
-- NOT a write-time "the full set must already sum to zero, or reject" trigger
-- (shape (a)). Both were considered; (a) does not fit how this app actually
-- writes ledgers:
--
--   Ledgers are, and are always going to be, created one row at a time
--   (LedgerManager's direct insert, the CSV importer, the Tally importer —
--   none of them are a single multi-row transaction that could be validated
--   as a completed set). A trigger that rejects any single ledger whose
--   opening balance does not, by itself, bring the company-wide sum back to
--   zero would make it impossible to enter a new company's trial balance at
--   all: the sum is nonzero after every ledger except the last one typed in.
--   That would not fix onboarding, it would break it, and it does not
--   distinguish "mid-setup" from "actually wrong" — this schema has no
--   concept of a setup phase to hang a deferred check on. (0073's own
--   precedent — a real "make a running total balance" defect — was fixed in
--   the report layer precisely to avoid inventing new machinery with a wider
--   blast radius than the bug; the same instinct argues against inventing a
--   setup-phase concept here just to make (a) workable.)
--
-- (b), structurally, is what this schema already does for its raw
-- opening-balance representation: it stays a plain field on ledgers (no new
-- voucher_entries, no change to ledger_opening_signed or any of the five
-- report functions in 0009 — they already sum every ledger's opening balance
-- correctly, including this new one, for free). The single new mechanism is:
-- whenever ONE ledger's opening balance changes, a standing per-company
-- "Opening Balance Equity" ledger absorbs the exact equal-and-opposite
-- change, atomically, in the same statement. The company-wide sum of every
-- ledger's opening balance is therefore zero BY CONSTRUCTION after every
-- single write, in any order, from any of the three insert paths above, with
-- zero UI change and zero change to report SQL. Mid-setup, Opening Balance
-- Equity simply carries the not-yet-reclassified balance — which is the
-- normal, expected behaviour of this exact account in Tally/QuickBooks-style
-- systems, not a bug — and an admin journals it out to Capital / Reserves
-- once the trial balance is fully keyed in, the same way they always could.
--
-- MECHANISM
--   app_private.opening_balance_equity_ledger(company_id) finds-or-creates
--   the ledger, filed under the company's system "Capital Account" group
--   (nature = 'capital', is_system — guaranteed present for every company
--   since 0006, unconditionally, unlike the lazily-seeded GST/TDS ledgers).
--
--   app_private.enforce_opening_balance_equity(), an AFTER INSERT OR UPDATE
--   OF opening_balance_amount, opening_balance_type OR DELETE trigger on
--   ledgers, computes the signed delta the write just made to ITS OWN ledger
--   and applies the exact opposite delta to Opening Balance Equity's own raw
--   opening_balance_amount/type. It returns immediately, doing nothing, for:
--     * the Opening Balance Equity ledger's own writes (never offsets
--       itself — this is deliberately how a human corrects or reclassifies
--       it, see below);
--     * any ledger write once the parent company row is already gone, so
--       ON DELETE CASCADE on companies is never blocked (the same guard
--       shape as protect_system_group in 0006).
--
--   protect_ledger_financial_fields (0006) already restricts changing an
--   opening balance to a company admin. The trigger above's own write to
--   Opening Balance Equity's balance is not a human editing that ledger —
--   it is a system-maintained mirror of every OTHER write — so
--   protect_ledger_financial_fields gains one extra escape hatch:
--   pg_trigger_depth() > 1, true precisely when this UPDATE was issued from
--   inside another trigger's execution rather than directly by a top-level
--   client statement. A direct top-level edit (human or API) is always
--   depth 1 and is still admin-gated exactly as before; only the nested,
--   automatic sync bypasses it. Without this, a non-admin accountant could
--   never create their very first ledger with an opening balance, because
--   doing so always writes Opening Balance Equity as a side effect.
--
-- DELIBERATELY NOT DONE HERE
--   * Verma & Associates' actual 57,500 gap is NOT silently corrected. Which
--     ledger is really wrong, and by how much, is a fact about what happened
--     to real money that only a human with the original records can supply —
--     see get_unbalanced_opening_balances below, added for exactly that.
--   * No protection against deleting the Opening Balance Equity ledger
--     itself while it holds a nonzero balance (ledgers carry no is_system
--     flag the way account_groups do — adding one is a bigger schema change
--     than this defect calls for). Deleting it directly is a human action
--     that forfeits whatever balance it held; the trigger will happily
--     create a fresh, zero one the next time it is needed.
--   * No batch "enter the whole trial balance in one screen" UI. Out of
--     scope for a mechanism fix, and (b) does not need it to work correctly.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Opening Balance Equity: find-or-create, race-safe
-- ----------------------------------------------------------------------------
create or replace function app_private.opening_balance_equity_ledger(p_company_id uuid)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_group_id uuid;
begin
  select id into v_id
    from public.ledgers
   where company_id = p_company_id and lower(name) = 'opening balance equity';
  if v_id is not null then
    return v_id;
  end if;

  select id into v_group_id
    from public.account_groups
   where company_id = p_company_id and is_system and nature = 'capital'
   order by sort_order limit 1;

  if v_group_id is null then
    raise exception 'Cannot create the Opening Balance Equity ledger: no system Capital Account group found for company %', p_company_id;
  end if;

  -- ledgers_company_name_idx (0006) is the unique index this ON CONFLICT
  -- target matches — two concurrent first-ever callers for the same company
  -- both fail the SELECT above and race to insert; exactly one wins.
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (p_company_id, v_group_id, 'Opening Balance Equity', 0, 'debit')
  on conflict (company_id, lower(name)) do nothing
  returning id into v_id;

  if v_id is not null then
    return v_id;
  end if;

  select id into v_id
    from public.ledgers
   where company_id = p_company_id and lower(name) = 'opening balance equity';

  return v_id;
end;
$$;

comment on function app_private.opening_balance_equity_ledger is
  'Finds or lazily creates the per-company Opening Balance Equity ledger under the system Capital Account group. Called only from enforce_opening_balance_equity.';

-- ----------------------------------------------------------------------------
-- The auto-offset trigger
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_opening_balance_equity()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_company_id uuid := coalesce(new.company_id, old.company_id);
  v_old_signed numeric := 0;
  v_new_signed numeric := 0;
  v_delta numeric;
  v_obe_id uuid;
  v_obe_signed numeric;
begin
  if TG_OP = 'DELETE' then
    -- Cascade guard: once the parent company row is gone there is nothing
    -- left to keep in balance, and touching another row here would only
    -- race the same ON DELETE CASCADE that is already tearing this company
    -- down (Opening Balance Equity's own row may already be gone, or may
    -- not have been reached yet — either way, do nothing).
    if not exists (select 1 from public.companies where id = v_company_id) then
      return old;
    end if;
  end if;

  -- Opening Balance Equity never offsets itself. Editing or deleting it
  -- directly (still admin-gated by protect_ledger_financial_fields at
  -- depth 1) is how a human reclassifies it to Capital/Reserves, or makes
  -- the correction get_unbalanced_opening_balances calls for.
  if (TG_OP in ('INSERT','UPDATE') and lower(new.name) = 'opening balance equity')
     or (TG_OP = 'DELETE' and lower(old.name) = 'opening balance equity') then
    return coalesce(new, old);
  end if;

  if TG_OP = 'UPDATE'
     and new.opening_balance_amount is not distinct from old.opening_balance_amount
     and new.opening_balance_type is not distinct from old.opening_balance_type then
    return new;
  end if;

  if TG_OP in ('INSERT','UPDATE') then
    v_new_signed := case when new.opening_balance_type = 'debit'
                         then new.opening_balance_amount else -new.opening_balance_amount end;
  end if;
  if TG_OP in ('UPDATE','DELETE') then
    v_old_signed := case when old.opening_balance_type = 'debit'
                         then old.opening_balance_amount else -old.opening_balance_amount end;
  end if;

  -- +ve delta = this ledger's own debit-side opening grew (or a credit
  -- balance shrank); Opening Balance Equity must move by exactly -delta to
  -- hold the company-wide signed sum at zero.
  v_delta := v_new_signed - v_old_signed;
  if v_delta = 0 then
    return coalesce(new, old);
  end if;

  v_obe_id := app_private.opening_balance_equity_ledger(v_company_id);

  select case when opening_balance_type = 'debit' then opening_balance_amount else -opening_balance_amount end
    into v_obe_signed
    from public.ledgers
   where id = v_obe_id
   for update;

  v_obe_signed := coalesce(v_obe_signed, 0) - v_delta;

  update public.ledgers
     set opening_balance_amount = abs(v_obe_signed),
         opening_balance_type = case when v_obe_signed >= 0 then 'debit' else 'credit' end
   where id = v_obe_id;

  return coalesce(new, old);
end;
$$;

comment on function app_private.enforce_opening_balance_equity is
  'Keeps the company-wide sum of every ledger opening balance at zero by construction: any change to one ledger''s opening balance is mirrored, equal and opposite, onto the standing Opening Balance Equity ledger. See 0755 header for why this shape was chosen over a write-time reject-if-nonzero validation.';

create trigger enforce_opening_balance_equity
  after insert or delete or update of opening_balance_amount, opening_balance_type
  on public.ledgers
  for each row execute function app_private.enforce_opening_balance_equity();

-- ----------------------------------------------------------------------------
-- protect_ledger_financial_fields (0006): let the auto-sync above through
-- ----------------------------------------------------------------------------
create or replace function app_private.protect_ledger_financial_fields()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if (new.opening_balance_amount is distinct from old.opening_balance_amount
      or new.opening_balance_type is distinct from old.opening_balance_type
      or new.group_id is distinct from old.group_id)
     and not app_private.is_company_admin(new.company_id)
     -- A direct, top-level UPDATE from a client always fires this trigger at
     -- depth 1. Depth > 1 means this UPDATE was issued from inside another
     -- trigger's execution — in practice, only enforce_opening_balance_equity
     -- (0755) ever updates a ledger's opening balance from within a trigger —
     -- so this is the automatic Opening Balance Equity sync, not a human
     -- editing this ledger's own opening balance, and must not be blocked by
     -- an admin check the acting user has no reason to satisfy.
     and pg_catalog.pg_trigger_depth() <= 1
  then
    raise exception 'Only an admin can change a ledger''s opening balance or group';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Diagnostic: which companies have this exact problem right now
-- ----------------------------------------------------------------------------
-- Read-only. Lists every ledger with a nonzero opening balance for a company
-- ONLY when that company's opening balances do not already net to zero — a
-- healthy company (and every company created after this migration, by
-- construction) returns no rows at all. company_total_imbalance is repeated
-- on every row so the caller sees the size of the gap without a second call.
--
-- Deliberately company-scoped, like every other get_* report (RLS via
-- ledgers_read/account_groups_read restricts it to a company the caller can
-- already see) — a human with service-role access can call it once per
-- company to sweep the whole project.
create or replace function public.get_unbalanced_opening_balances(p_company_id uuid)
returns table (
  ledger_id uuid,
  ledger_name text,
  group_name text,
  opening_balance_amount numeric,
  opening_balance_type text,
  opening_signed numeric,
  company_total_imbalance numeric
)
language sql
stable
set search_path = ''
as $$
  with signed as (
    select l.id, l.name, g.name as group_name,
           l.opening_balance_amount, l.opening_balance_type,
           case when l.opening_balance_type = 'debit'
                then l.opening_balance_amount else -l.opening_balance_amount end as signed
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id
  ),
  total as (
    select coalesce(sum(signed), 0) as t from signed
  )
  select s.id, s.name, s.group_name,
         s.opening_balance_amount, s.opening_balance_type, s.signed,
         t.t
    from signed s, total t
   where t.t <> 0
     and s.signed <> 0
   order by abs(s.signed) desc;
$$;

revoke all on function public.get_unbalanced_opening_balances(uuid) from public, anon;
grant execute on function public.get_unbalanced_opening_balances(uuid) to authenticated;

comment on function public.get_unbalanced_opening_balances is
  'Read-only. For a company whose ledger opening balances do not net to zero (only possible from data written before 0755, or by a direct correcting edit to Opening Balance Equity), lists every contributing ledger and the size of the gap. Returns no rows for a balanced company. Verma & Associates (7bfa2df5-53e4-493d-9925-d360ad6789e6) is confirmed to return two rows here today: Chennai Overseas Facilitators (12,500 Dr) and Lonestar Apparel Imports LLC (45,000 Dr), company_total_imbalance 57,500 — see 0755 header.';
