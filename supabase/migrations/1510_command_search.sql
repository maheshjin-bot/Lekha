-- ============================================================================
-- 1510 — One search box that knows what a ledger, an item and a voucher are
-- ============================================================================
-- WHY. There are 130 page.tsx routes under app/(app)/[companyId] — 55 module
-- screens and 58 report screens — and not one of them answers the question a
-- preparer actually asks twenty times a day: "where is Ashoka Traders". To
-- reach a party's statement today you must already know that ledger balances
-- live under /reports/ledger-statement (not under /ledgers, which is the
-- master, and not under /reports/outstanding, which is the ageing), then pick
-- the ledger out of a select whose options are every ledger in the company.
-- To reach a purchase bill by the supplier's own bill number there is no path
-- at all: reference_number is indexed (vouchers_party_reference_idx) and is
-- what find_duplicate_bills matches on, but nothing in the UI lets a human
-- type it.
--
-- This function is the one read the command bar (⌘K) needs. It is deliberately
-- a SINGLE round trip returning already-ranked, already-navigable rows: the
-- client sends what was typed and renders what comes back, because four
-- parallel PostgREST queries per keystroke — each needing its own ranking,
-- its own href-building and its own merge — is where a search box turns into
-- four subtly different search boxes.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS CHECKED BEFORE WRITING IT
-- ---------------------------------------------------------------------------
--   * public schema has no search function of any kind (pg_proc: zero names
--     matching '%search%'). Nothing to extend, so this is the first one.
--   * pg_trgm is NOT installed (pg_extension holds plpgsql, pg_stat_statements,
--     uuid-ossp, pgcrypto, supabase_vault, btree_gist, pg_cron). So there is no
--     trigram index to lean on and no similarity() to rank with. At the current
--     size — 414 ledgers, 298 vouchers, 68 items, 18 employees ACROSS ALL 16
--     COMPANIES — a company-scoped scan behind the existing company_id indexes
--     is far cheaper than the round trip that carries it. If a single company
--     ever reaches six figures of vouchers, the fix is `create extension
--     pg_trgm` plus a gin_trgm_ops index on the four label columns and swapping
--     the position() tests below for `%`; the signature does not change.
--   * employees EXISTS (public.employees: id, company_id, name, pan, uan,
--     esi_number, date_of_joining, date_of_leaving, is_active, branch_id), so
--     the employee arm is real and not a placeholder.
--
-- ---------------------------------------------------------------------------
-- WHY security invoker, AND WHY THAT IS THE WHOLE ACCESS-CONTROL STORY
-- ---------------------------------------------------------------------------
-- Same rule every read function in this codebase follows (0007, 0009): the
-- function runs as the caller, so ledgers_read / items_read / vouchers_read /
-- employees_read decide what is visible, and a member of company A typing a
-- supplier name gets nothing from company B even though the union below has no
-- idea which companies exist. A search box is exactly the wrong place to start
-- being clever with security definer: it reads four tables at once and returns
-- names, so a definer version would be a company-wide data leak with a text
-- input attached. p_company_id on top of RLS is scoping, not security — a user
-- is usually a member of several companies and the command bar is per-company.
--
-- ---------------------------------------------------------------------------
-- RANKING
-- ---------------------------------------------------------------------------
-- rank = match tier + a short-label bonus, as ONE number, so a client that
-- sorts by rank alone gets the same order this function already returned:
--
--   4  the label IS what was typed          ("SAL/26-27/0001")
--   3  the label STARTS WITH what was typed ("Ashok" -> "Ashoka Traders")
--   2  the label CONTAINS what was typed    ("trad" -> "Ashoka Traders")
--   1  the label does not match at all, so the hit came from a secondary
--      field — a voucher's reference_number or an item's code
--
-- plus 1/(1 + length of label), which is in (0, 0.5] and therefore can never
-- lift a row across a tier gap of 1.0, but does put "Cash" above "Cash at Bank
-- — Current Account" when both merely contain "cash". Shorter is ranked first
-- because a short label containing the query is usually the thing itself,
-- while a long one containing it is usually a sibling.
--
-- Matching uses lower() + position()/left() rather than ILIKE deliberately:
-- the query string is raw user input, and under ILIKE a stray % or _ (both of
-- which occur in real item codes and narrations) would silently become a
-- wildcard. position() has no metacharacters, so there is nothing to escape
-- and nothing to get wrong.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE
-- ---------------------------------------------------------------------------
--   * Deleted vouchers. is_deleted rows are excluded because /vouchers/<id>
--     for one is a dead end — a result you cannot open is worse than no result.
--   * Inactive ledgers/items/employees are NOT excluded. A retired ledger
--     still has a statement worth reading, and a search box that cannot find
--     something the user knows exists is the failure people remember. They are
--     labelled "inactive" in the sublabel instead, so the row is never
--     misleading.
--   * Deep links for items and employees. Neither /[companyId]/items nor
--     /[companyId]/employees reads a search param today (both are single-fetch
--     master screens), so the href is the list route. Inventing ?id= here would
--     be a link to behaviour that does not exist.
-- ============================================================================

create or replace function public.search_company_entities(
  p_company_id uuid,
  p_query text,
  p_limit int default 20
) returns table (
  kind text,
  id uuid,
  label text,
  sublabel text,
  href text,
  rank real
)
language sql
stable
security invoker
set search_path = ''
as $$
  -- q is empty for a blank query, and CROSS JOIN q therefore makes every arm
  -- below return zero rows without scanning anything. That is the "blank query
  -- returns nothing" rule enforced structurally rather than by an if — the
  -- client shows recents in that case, and must never be handed the first 20
  -- ledgers alphabetically and told they are matches.
  with q as (
    select lower(btrim(p_query)) as needle
     where btrim(coalesce(p_query, '')) <> ''
  ),
  hits as (
    -- ----- ledgers -------------------------------------------------------
    -- The group name is the sublabel because "Ashoka Traders" alone does not
    -- say whether it is a customer or a supplier, and in this chart of
    -- accounts the same trading name can legitimately be both.
    -- LEFT JOIN, not JOIN: account_groups carries its own RLS policy, and a
    -- ledger must never vanish from search because its group row was the one
    -- thing a policy edge case hid. A missing group costs the sublabel, not
    -- the result.
    select 'ledger'::text as kind,
           l.id as id,
           l.name as label,
           nullif(concat_ws(' · ',
             g.name,
             case when not l.is_active then 'inactive' end), '') as sublabel,
           '/' || p_company_id::text
             || '/reports/ledger-statement?ledger=' || l.id::text as href
      from public.ledgers l
      left join public.account_groups g on g.id = l.group_id
      cross join q
     where l.company_id = p_company_id
       and position(q.needle in lower(l.name)) > 0

    union all

    -- ----- items ---------------------------------------------------------
    -- Matched on code as well as name: an item code is the short string a
    -- storekeeper actually remembers, and it is already indexed
    -- (items_company_code_idx). The code is carried into the sublabel next to
    -- the HSN/SAC for the same reason the voucher arm carries the reference —
    -- a row that matched on a field the user cannot see is a row they cannot
    -- explain.
    select 'item'::text,
           i.id,
           i.name,
           nullif(concat_ws(' · ',
             nullif(btrim(i.hsn_sac), ''),
             nullif(btrim(i.code), ''),
             case when not i.is_active then 'inactive' end), ''),
           '/' || p_company_id::text || '/items'
      from public.items i
      cross join q
     where i.company_id = p_company_id
       and (position(q.needle in lower(i.name)) > 0
            or position(q.needle in lower(coalesce(i.code, ''))) > 0)

    union all

    -- ----- vouchers ------------------------------------------------------
    -- Two searchable numbers, and they are not interchangeable:
    -- voucher_number is OUR document number (SAL/26-27/0001), while
    -- reference_number is the COUNTERPARTY's — the supplier's own bill number
    -- typed off the paper bill. A preparer holding a supplier invoice knows
    -- only the second one, which is why this arm exists at all.
    -- The party comes from party_ledger_id via LEFT JOIN: vouchers posted
    -- before that column was reliably set (fixed in 6aa8718) still have it
    -- null, and concat_ws simply drops the missing piece rather than producing
    -- a sublabel with a hole in it.
    select 'voucher'::text,
           v.id,
           v.voucher_number,
           nullif(concat_ws(' · ',
             initcap(replace(v.voucher_type, '_', ' ')),
             to_char(v.voucher_date, 'DD Mon YYYY'),
             pl.name,
             -- Shown only when the reference is what matched, so a hit on a
             -- supplier bill number carries its own evidence and every other
             -- voucher keeps a clean three-part sublabel.
             case when position(q.needle in lower(coalesce(v.reference_number, ''))) > 0
                  then 'ref ' || btrim(v.reference_number) end), ''),
           '/' || p_company_id::text || '/vouchers/' || v.id::text
      from public.vouchers v
      left join public.ledgers pl on pl.id = v.party_ledger_id
      cross join q
     where v.company_id = p_company_id
       and not v.is_deleted
       and (position(q.needle in lower(v.voucher_number)) > 0
            or position(q.needle in lower(coalesce(v.reference_number, ''))) > 0)

    union all

    -- ----- employees -----------------------------------------------------
    -- Name only. PAN and UAN are deliberately not searchable: they identify a
    -- person rather than help you find one you already have in mind, and a
    -- box that echoes a PAN back on a partial match is a disclosure surface
    -- nobody asked for.
    select 'employee'::text,
           e.id,
           e.name,
           nullif(concat_ws(' · ',
             case when e.date_of_joining is not null
                  then 'joined ' || to_char(e.date_of_joining, 'DD Mon YYYY') end,
             case when e.date_of_leaving is not null
                  then 'left ' || to_char(e.date_of_leaving, 'DD Mon YYYY')
                  when not e.is_active then 'inactive' end), ''),
           '/' || p_company_id::text || '/employees'
      from public.employees e
      cross join q
     where e.company_id = p_company_id
       and position(q.needle in lower(e.name)) > 0
  )
  select r.kind, r.id, r.label, r.sublabel, r.href, r.rank
    from (
      -- Rank is computed once, here, over the union — not four times inside
      -- four arms that would drift apart the first time one of them changed.
      -- Reaching this point at all means SOMETHING matched, so a label that
      -- does not match is by elimination a secondary-field hit (tier 1).
      select h.kind, h.id, h.label, h.sublabel, h.href,
             (case
                when lower(h.label) = q.needle then 4
                when left(lower(h.label), char_length(q.needle)) = q.needle then 3
                when position(q.needle in lower(h.label)) > 0 then 2
                else 1
              end
              + 1.0 / (1 + char_length(h.label)))::real as rank
        from hits h
        cross join q
    ) r
   order by r.rank desc, char_length(r.label), r.label
   -- Hard cap at 50 whatever the caller asks for: this is a keystroke-rate
   -- endpoint, and a command bar nobody scrolls has no use for row 51.
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- Revoking from anon ALONE is a no-op in this database and has bitten this
-- codebase repeatedly (0064, 0231): anon inherits the default EXECUTE grant
-- that PostgreSQL hands to PUBLIC on every new function, so the grant survives
-- the revoke it appears to undo. PUBLIC must be named. The schema-wide
-- allowlist invariant test exists precisely to catch the version of this line
-- that forgets it.
revoke all on function public.search_company_entities(uuid, text, int) from public, anon;
grant execute on function public.search_company_entities(uuid, text, int) to authenticated;

comment on function public.search_company_entities(uuid, text, int) is
  'Command-bar search across one company: ledgers, items, vouchers (by our voucher_number AND the counterparty reference_number) and employees, returned pre-ranked and pre-linked in one round trip. security invoker, so RLS is what scopes it. rank = match tier (4 exact / 3 prefix / 2 substring / 1 secondary field) + a <0.5 short-label bonus, so ordering by rank alone reproduces this order. Blank query returns zero rows; hard-capped at 50.';
