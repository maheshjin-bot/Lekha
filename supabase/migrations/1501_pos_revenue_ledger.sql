-- The till must be told which ledger it credits, and must remember the answer.
--
-- WHY. app/(app)/[companyId]/pos/page.tsx picked the counter's revenue ledger
-- with
--
--     salesLedgers.find(l => l.name === "Sales Account") ?? salesLedgers[0]
--
-- over a query ordered by name. In TEST Rangoli Spice Works Pvt Ltd the income
-- ledgers sort Discount Received, Grinding Charges Recovered, Sales - Packaged
-- Foods, Sales - Spices & Masala, Scrap Sales. Nobody there ever named a
-- ledger "Sales Account", so the find missed, the fallback took the first row,
-- and SAL/26-27/0006 -- a real counter sale of 1,356.00 plus 67.80 GST --
-- credited DISCOUNT RECEIVED. The takings landed in indirect income: revenue
-- from operations understated by 1,356.00, other income overstated by the
-- same, and both the Schedule III P&L and the CMA gross-margin pack quietly
-- wrong. The screen never named the ledger it was about to credit, so there
-- was nothing to notice.
--
-- A CORRECTION TO THE REPORT, because it changes who is exposed. The bug was
-- described as "the find ALWAYS misses -- no migration creates that string".
-- Half right. No migration does create it (grep of supabase/migrations: zero
-- hits), but ELEVEN of the sixteen companies in this database do have a ledger
-- named exactly "Sales Account", every one of them seeded demo data. For those
-- the old line happens to land correctly, which is precisely why this survived
-- so long. It is the companies whose preparer named their own revenue ledgers
-- -- which is every real one, starting with the pilot -- that get the
-- alphabetically-first income ledger instead. The old rule, evaluated over the
-- whole database today, would credit: Exchange Gain/Loss for three companies,
-- Donations Received for a charitable trust, Maintenance Charges Collected for
-- an RWA, and Discount Received for the pilot.
--
-- THE LESSON FROM 1200, APPLIED, AND ITS LIMIT. 1200's rule is that a ledger
-- is bound by ledger_role, never by its English name, and app_private.
-- ledger_for_role is the resolver. That is the right instinct here and it is
-- not, on its own, sufficient: ledger_for_role RAISES when a company has more
-- than one ledger in a role, and having several INCOME ledgers is not a data
-- error to be merged away -- it is how any real business splits its revenue.
-- Five of them is a well-kept chart of accounts, not a mess.
--
-- So the role narrows the candidates and a human picks inside them:
--
--   1. Candidates are the ACTIVE ledgers whose EFFECTIVE role --
--      coalesce(ledger.ledger_role, group.ledger_role), the same coalesce
--      1200 taught every close posting to use -- is 'income'. Nothing is
--      matched on a name, ever.
--   2. The choice is stored per company AND per branch in
--      public.pos_revenue_ledger, so a counter picks once and never again,
--      exactly as 0725's named series is picked once a shift.
--   3. With nothing stored, the default is taken ONLY when it is unambiguous:
--      exactly one candidate under a direct_income group. A counter sale is
--      revenue from operations by definition, so Scrap Sales and Discount
--      Received are never a silent default. If that is ambiguous the resolver
--      returns NULL and the screen makes the operator choose before it will
--      post. Refusing beats guessing -- guessing is the entire bug.
--
-- WHY NOT A NEW ledger_role VALUE. Tempting, and wrong. ledgers.ledger_role is
-- the Schedule III classification: get_profit_and_loss, get_balance_sheet, the
-- notes and the cash flow all read coalesce(ledger, group) and expect a value
-- from the constraint's vocabulary. Inventing 'counter_sales' would either be
-- rejected by ledgers_ledger_role_check or, once admitted, would make that
-- ledger stop reading as income everywhere else. The till's preference is a
-- setting, not an accounting classification, and it lives in its own table.
--
-- WHY BRANCH-LEVEL. Quick billing bills from one branch (pos/page.tsx takes
-- branches[0]) and a company with two counters in two states can easily keep
-- two revenue ledgers. Company-level would have forced them to share one.
--
-- NOT TOUCHED: create_invoice, which still takes the trading ledger as a plain
-- argument and still validates nothing about it. That is a real gap -- it is
-- what let a POS credit an indirect-income ledger without a murmur -- but it
-- belongs to whoever owns create_invoice, and is reported rather than fixed
-- here. This migration makes the POS incapable of sending a wrong one; it does
-- not stop a caller that insists.

-- ---------------------------------------------------------------------------
-- 1. The stored choice
-- ---------------------------------------------------------------------------

create table if not exists public.pos_revenue_ledger (
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id  uuid not null references public.branches(id)  on delete cascade,
  -- cascade, not restrict: if the chosen ledger is ever removed the till
  -- falls back to "nothing chosen" and asks again, which is the safe state.
  -- Blocking a ledger deletion because a POS setting points at it would be
  -- the tail wagging the dog.
  ledger_id  uuid not null references public.ledgers(id)   on delete cascade,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (company_id, branch_id)
);

comment on table public.pos_revenue_ledger is
  'Which income ledger quick billing credits, per company and branch. A setting, NOT an accounting classification — see 1501 for why this is not a ledgers.ledger_role value. Written only through set_pos_revenue_ledger, which checks the ledger really carries the income role.';

alter table public.pos_revenue_ledger enable row level security;

drop policy if exists pos_revenue_ledger_read on public.pos_revenue_ledger;
drop policy if exists pos_revenue_ledger_write on public.pos_revenue_ledger;

create policy pos_revenue_ledger_read on public.pos_revenue_ledger
  for select to authenticated using ((select app_private.is_company_member(company_id)));

create policy pos_revenue_ledger_write on public.pos_revenue_ledger
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

-- 0080's revoke, restated for a table 0080 could not have seen. RLS does not
-- filter TRUNCATE, so holding it would empty this table whatever the policies
-- say; TRIGGER and REFERENCES are unused by PostgREST and only widen a
-- compromised role. The invariants suite asserts this for every table.
revoke truncate, trigger, references on table public.pos_revenue_ledger from anon, authenticated;
revoke all on table public.pos_revenue_ledger from anon;

-- ---------------------------------------------------------------------------
-- 2. The resolver — role first, stored choice second, unambiguous default
--    third, and NULL rather than a guess
-- ---------------------------------------------------------------------------

create or replace function app_private.pos_revenue_ledger(p_company_id uuid, p_branch_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  v_id uuid;
  v_candidates uuid[];
begin
  -- The stored choice, but only while it is still a valid one. A ledger that
  -- has been deactivated or reclassified out of income stops being the
  -- answer immediately, rather than quietly going on being credited.
  select s.ledger_id into v_id
    from public.pos_revenue_ledger s
    join public.ledgers l on l.id = s.ledger_id
    join public.account_groups g on g.id = l.group_id
   where s.company_id = p_company_id
     and s.branch_id = p_branch_id
     and l.company_id = p_company_id
     and l.is_active
     and coalesce(l.ledger_role, g.ledger_role) = 'income';

  if v_id is not null then
    return v_id;
  end if;

  -- Nothing stored. Default ONLY when there is one obvious answer: a single
  -- active revenue-from-operations ledger. Indirect income (scrap, discount
  -- received, exchange gain) is never a counter sale and is never defaulted
  -- to, which is exactly the substitution that produced the bug.
  select array_agg(l.id order by l.name) into v_candidates
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where l.company_id = p_company_id
     and l.is_active
     and coalesce(l.ledger_role, g.ledger_role) = 'income'
     and g.nature = 'direct_income';

  if v_candidates is not null and cardinality(v_candidates) = 1 then
    return v_candidates[1];
  end if;

  return null;
end;
$fn$;

revoke all on function app_private.pos_revenue_ledger(uuid, uuid) from public, anon;
grant execute on function app_private.pos_revenue_ledger(uuid, uuid) to authenticated;

comment on function app_private.pos_revenue_ledger(uuid, uuid) is
  'The income ledger quick billing should credit for this branch: the stored choice while it is still valid, else the single direct-income ledger if there is exactly one, else NULL so the operator is asked. Never matches a ledger by name (1200/1501).';

-- ---------------------------------------------------------------------------
-- 3. What the screen offers, and what it says is selected
-- ---------------------------------------------------------------------------

create or replace function public.get_pos_revenue_ledger_options(
  p_company_id uuid,
  p_branch_id uuid
) returns table (
  ledger_id uuid,
  ledger_name text,
  group_name text,
  is_revenue boolean,
  is_selected boolean
)
language sql
stable
set search_path to ''
as $$
  select l.id,
         l.name,
         g.name,
         g.nature = 'direct_income',
         -- `is not distinct from`, not `=`: the resolver returns NULL when it
         -- refuses to guess, and `l.id = null` is NULL, which would ship a
         -- three-valued flag to a boolean column for exactly the case that
         -- matters most.
         l.id is not distinct from app_private.pos_revenue_ledger(p_company_id, p_branch_id)
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where l.company_id = p_company_id
     and l.is_active
     and coalesce(l.ledger_role, g.ledger_role) = 'income'
   -- Revenue from operations first, so the list reads the way a counter
   -- thinks. Every income ledger is still offered: a company that has put its
   -- sales ledger under Indirect Incomes has a chart-of-accounts problem, not
   -- a reason to be locked out of its own till.
   order by (g.nature = 'direct_income') desc, l.name;
$$;

revoke all on function public.get_pos_revenue_ledger_options(uuid, uuid) from public, anon;
grant execute on function public.get_pos_revenue_ledger_options(uuid, uuid) to authenticated;

comment on function public.get_pos_revenue_ledger_options(uuid, uuid) is
  'Every active ledger carrying the income role for this company, revenue-from-operations first, with is_selected marking what quick billing would credit today. Feeds the POS selector (1501).';

-- ---------------------------------------------------------------------------
-- 4. Recording the operator's choice
-- ---------------------------------------------------------------------------

create or replace function public.set_pos_revenue_ledger(
  p_company_id uuid,
  p_branch_id uuid,
  p_ledger_id uuid
) returns uuid
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_role text;
  v_active boolean;
  v_name text;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to change settings for this company';
  end if;

  if not exists (
    select 1 from public.branches b
     where b.id = p_branch_id and b.company_id = p_company_id
  ) then
    raise exception 'That branch does not belong to this company.';
  end if;

  select coalesce(l.ledger_role, g.ledger_role), l.is_active, l.name
    into v_role, v_active, v_name
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where l.id = p_ledger_id and l.company_id = p_company_id;

  if v_role is null then
    raise exception 'That ledger does not belong to this company.';
  end if;

  -- The whole point of the exercise: bound by ROLE, so a counter sale cannot
  -- be pointed at a bank, a debtor or an expense head however it is named.
  if v_role <> 'income' then
    raise exception
      'Quick billing credits a sale, so it needs an income ledger. "%" sits under a % head. Pick a sales ledger, or move this one under Direct Incomes first.',
      v_name, replace(v_role, '_', ' ');
  end if;

  if not v_active then
    raise exception '"%" is inactive; reactivate it before billing against it.', v_name;
  end if;

  insert into public.pos_revenue_ledger (company_id, branch_id, ledger_id, updated_by, updated_at)
  values (p_company_id, p_branch_id, p_ledger_id, auth.uid(), now())
  on conflict (company_id, branch_id)
  do update set ledger_id = excluded.ledger_id,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at;

  return p_ledger_id;
end;
$fn$;

revoke all on function public.set_pos_revenue_ledger(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_pos_revenue_ledger(uuid, uuid, uuid) to authenticated;

comment on function public.set_pos_revenue_ledger(uuid, uuid, uuid) is
  'Remember which income ledger this branch''s counter credits. Refuses a ledger from another company, an inactive one, or one whose effective ledger_role is not income (1501).';
