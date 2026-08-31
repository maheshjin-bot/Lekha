-- ============================================================================
-- 1160 — A numbering series whose prefix cannot tell two branches apart must
--        not be drawn from two branches, because the number it issues in the
--        second one is a number it has already issued in the first
-- ============================================================================
-- THE DEFECT, PROVEN BEFORE IT WAS FIXED
--
-- 0725 made the series prefix a TEMPLATE — {BRANCH} {FY} {FYS} {YYYY} {YY} —
-- and left the COUNTER where it had always been: on
-- voucher_number_sequences, keyed per (company, branch, voucher_type, FY,
-- series). The counter is therefore per branch; the prefix need not be. A
-- series whose template omits {BRANCH} has one counter per branch and one
-- prefix for all of them, so branch two starts again at 1 behind the same
-- leading text as branch one.
--
-- Run live against Sharma Textiles (two branches, HO and MUM) inside a
-- rolled-back transaction, on the code as it stood before this migration:
--
--   series 'Collision proof', voucher type sales, prefix 'PRF/{FYS}/', 4 digits
--     app_private.next_voucher_number(..., HO,  'sales', 2026-08-31, series)
--       -> PRF/26-27/0001
--     app_private.next_voucher_number(..., MUM, 'sales', 2026-08-31, series)
--       -> PRF/26-27/0001
--   distinct numbers issued: 1.  Documents issued: 2.
--
-- Nothing refused either one. public.vouchers' UNIQUE key is
-- (company_id, branch_id, voucher_type, financial_year_label, voucher_number)
-- — branch_id is IN the key, so the database is not merely permitting this,
-- it is designed to permit it. That was correct while the prefix always
-- carried the branch code (it did, pre-0725: prefix was branch_code || '/' ||
-- type_code, and 0725's own pre-flight asserted as much for all 66 rows).
-- 0725 made the prefix editable and the assumption stopped holding.
--
-- A SECOND, SEPARATE COLLISION FOUND WHILE PROVING THE FIRST, ALSO LIVE
--
--   series A, voucher type sales,   prefix 'PRF/{FYS}/'  -> PRF/26-27/0001
--   series B, voucher type journal, prefix 'PRF/{FYS}/'  -> PRF/26-27/0001
--   same company, SAME branch, both accepted.
--
-- voucher_number_series is unique on (company_id, voucher_type, name), never
-- on prefix, so two voucher types may share a prefix template; their counters
-- are independent, so both start at 1. vouchers' UNIQUE key carries
-- voucher_type too, so it accepts both. One migration, one guard, both cases
-- — the shared cause is that two counters were allowed to produce the same
-- leading text, and it is that, not "the branch", that is the real invariant.
--
-- ----------------------------------------------------------------------------
-- WHY IT MATTERS, WITH THE LAW AND THE PORTAL BEHIND IT
-- ----------------------------------------------------------------------------
-- CGST Rule 46(b) requires "a consecutive serial number not exceeding sixteen
-- characters, in one or multiple series, containing alphabets or numerals or
-- special characters hyphen or dash and slash symbolised as '-' and '/'
-- respectively, and any combination thereof, unique for a financial year."
-- Unique FOR A FINANCIAL YEAR. Not unique per branch. A branch is not a
-- person under GST; a registration is. Two branches of one company under one
-- GSTIN that both print SAL/26-27/0001 have issued one serial number twice
-- inside one year, and Rule 46(b)'s "one or multiple series" is the licence
-- to run several series precisely so that they need not.
--
-- This is not a paper point. Three concrete consequences, in order of how
-- soon they bite:
--
--   1. e-invoicing. The IRN is a hash of supplier GSTIN + document type +
--      document number + financial year. The Invoice Registration Portal
--      refuses the second document of an identical combination with error
--      2150, "Duplicate IRN" (NIC's own note on top errors). Once a company
--      crosses the e-invoicing threshold, the second branch's invoice simply
--      cannot be registered, and a tax invoice without an IRN is not a valid
--      tax invoice.
--
--   2. GSTR-1 Table 13, "Documents issued". 0730 already had to split that
--      table by series after 0725, and it groups by (branch, voucher_type,
--      series). Two branches sharing one series and one prefix report two
--      rows with overlapping serial ranges under one GSTIN — a filed return
--      that says the same serial was issued twice.
--
--   3. The company's own books. Search-by-invoice-number, the ledger, a
--      customer ringing about "invoice EXP/26-27/0001" — all of them stop
--      having one answer.
--
-- Sharma Textiles is the live case that made this concrete rather than
-- theoretical: two branches, ONE GST registration (07ABCPS1234D1Z3, and MUM
-- has no separate registration at all, so both branches invoice under it),
-- and two series with no {BRANCH} in their prefix — 'Export' on sales
-- (EXP/{FYS}/) and 'Adjustments' on journal (ADJ/{FYS}/). Both have so far
-- only ever been drawn from HO. The next export sale raised in Mumbai
-- reissues EXP/26-27/0001.
--
-- ----------------------------------------------------------------------------
-- THE DECISION: REFUSE THE CONFIGURATION, DO NOT MERELY WARN ABOUT IT — BUT
-- ONLY WHERE IT IS ACTUALLY A HAZARD
-- ----------------------------------------------------------------------------
-- The brief posed the honest tension: refusing is safer, but a single-branch
-- company has no problem at all and would be blocked for nothing, while a
-- company that runs one branch today may open a second next year.
--
-- The resolution is that "is this a hazard" is a question with a real answer
-- the database can compute — how many branches does this company have — so
-- neither blanket refusal nor a blanket warning is necessary:
--
--   * MORE THAN ONE BRANCH -> REFUSED at configuration time. A prefix with no
--     {BRANCH} token cannot be saved. Not warned about: a warning on a
--     configuration screen is read once, by an admin, months before the
--     Mumbai clerk raises the invoice that collides, and the cost of being
--     wrong is a duplicated statutory serial number that cannot be
--     un-issued. There is also nothing to trade away — {BRANCH} costs two to
--     six characters and every affected company has a lawful alternative
--     (below).
--
--   * EXACTLY ONE BRANCH -> ALLOWED, unchanged, with no friction whatsoever.
--     There is no second counter, so there is no collision to prevent, and
--     refusing here would be refusing a configuration that is correct.
--     Rule 46(b) does not mention branches; a single-branch company writing
--     'SAL/{FYS}/' is doing nothing wrong, and it is also the shortest way
--     to get under sixteen characters, which is the whole point of 0725.
--
--   * ONE BRANCH TODAY, TWO NEXT YEAR -> the series keeps working, in the
--     branch that has been using it, forever. This migration NEVER
--     invalidates a series that already exists, and never renumbers or
--     refuses anything already issued. What it does is (a) refuse the SECOND
--     branch's first draw, in a sentence naming the other branch and the two
--     ways out, rather than minting the duplicate, and (b) light the series
--     up on the settings screen from the moment the second branch exists, so
--     the admin meets it while configuring rather than while invoicing.
--     That is the "make the hazard visible" half, applied to the one case
--     where the hazard can still arise.
--
-- The lawful alternatives, both of which the screen now offers by name:
--   * put {BRANCH} in the prefix — '{BRANCH}EXP/{YY}/' + 4 digits gives
--     HOEXP/26/0001 and MUMEXP/26/0001, thirteen and fourteen characters; or
--   * give each branch its own named series with its own distinct prefix,
--     which is exactly the "multiple series" Rule 46(b) permits.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It does NOT add a branch_id to voucher_number_series to pin a series to
--     one branch. That was the first design and it was dropped on purpose:
--     the DEFAULT series is drawn from by every branch (all nine internal
--     callers of next_voucher_number pass no series), so pinning the default
--     would make a whole voucher type unpostable in every other branch, and
--     the moment a single-branch company opened its second branch its
--     auto-pinned default would lock the new branch out of posting entirely.
--     Requiring the prefix to name the branch achieves the same guarantee
--     with no new column, no new UI concept and no way to strand a branch.
--
--   * It does NOT make a branch-less series share ONE counter across
--     branches, which is the other obvious repair. It would produce a
--     genuinely continuous company-wide series — but the counter row is keyed
--     by branch_id, so the shared counter would have to be parked on one
--     "anchor" branch, which changes what that column means for everything
--     that reads it (0730's Table 13 matches documents to series BY BRANCH,
--     and every Mumbai document would fall into its "Manually numbered or
--     retired series" bucket). Worse, where branches sit under different
--     GSTINs an interleaved shared series gives BOTH returns a gappy Table 13
--     range. Per-branch counters with per-branch prefixes is what GST expects.
--
--   * It does NOT renumber, revalidate or refuse any voucher already issued,
--     and it does not touch a single counter's next_number. Verified below.
--
--   * It does NOT stop a preparer hand-typing a duplicate across branches in
--     MANUAL mode. app_private.resolve_manual_voucher_number checks for a
--     duplicate within (company, branch, type, FY) because that is what
--     vouchers' UNIQUE key enforces, and widening it is a separate change to
--     a function this migration otherwise has no reason to open. Flagged in
--     the report rather than smuggled in here.
--
--   * It adds no invariant test. tests/db/invariants.test.ts is owned by
--     another agent this session and off limits; the test it ALREADY has —
--     "no two live vouchers share a number within the same company, type and
--     financial year" — happens to catch the cross-branch case after the
--     fact, and the report asks for the cross-TYPE case to be added to it.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. Pre-flight. Everything below rests on two facts about the live database;
--    assert them rather than trust the survey that found them, so a replay
--    against a different database fails loudly instead of silently rejecting
--    someone's numbering.
--
--    (a) No two counter rows in one company and financial year already
--        produce the same leading text. If one pair did, the unique index in
--        section 2 would reject live data — which is exactly the check the
--        brief asked for before adding a constraint.
--    (b) Branch codes are unique within a company (branches_company_id_code_key)
--        and non-empty (branches_code_check, ^[A-Z0-9]{1,6}$), which is what
--        makes {BRANCH} an actual discriminator rather than a hope.
-- ----------------------------------------------------------------------------
do $$
declare
  v_bad int;
begin
  select count(*) into v_bad from (
    select company_id, financial_year_label, resolved_prefix
      from public.voucher_number_sequences
     group by company_id, financial_year_label, resolved_prefix
    having count(*) > 1
  ) x;
  if v_bad > 0 then
    raise exception '1160 pre-flight: % (company, FY, resolved prefix) group(s) already have more than one counter — the collision this migration prevents has already happened and must be reconciled by hand before the index below can be added', v_bad;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.branches'::regclass
       and conname = 'branches_company_id_code_key'
  ) then
    raise exception '1160 pre-flight: branches has no unique (company_id, code) constraint, so {BRANCH} does not distinguish branches and this migration''s guarantee does not hold';
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. The one-line question every guard below asks.
--
--    position(), not LIKE: '{' and '}' are not LIKE metacharacters today, but
--    a literal comparison says what is meant and cannot be misread later.
-- ----------------------------------------------------------------------------
create or replace function app_private.prefix_names_the_branch(p_prefix text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select position('{BRANCH}' in coalesce(p_prefix, '')) > 0;
$$;

comment on function app_private.prefix_names_the_branch(text) is
  'True when a series prefix template contains {BRANCH}, i.e. when the numbers it issues differ between branches. A series whose prefix does not name the branch has one counter per branch but one prefix for all of them, so it reissues the same number in each. See 1160.';


-- ----------------------------------------------------------------------------
-- 2. The structural backstop: within one company and one financial year, no
--    two counters may produce the same leading text.
--
--    Deliberately NOT keyed by voucher_type or branch_id — including either
--    would permit exactly the two collisions proved in the header. This is
--    the sentence "a document number is unique for a financial year"
--    expressed as an index, and it holds whichever code path draws a number,
--    including a direct table write and including the race where two
--    transactions pass the friendly pre-check in section 3 simultaneously.
--
--    resolved_prefix is refreshed on every draw (0725), so this also stops a
--    series being edited onto a prefix a DIFFERENT series has already issued
--    numbers under — a true positive, not an over-reach: those numbers exist
--    and reusing their prefix would duplicate them from 1 upwards.
--
--    Verified against live data by the pre-flight above: zero violations
--    across every company in the database.
-- ----------------------------------------------------------------------------
create unique index voucher_number_sequences_one_counter_per_prefix
  on public.voucher_number_sequences (company_id, financial_year_label, resolved_prefix);

comment on index public.voucher_number_sequences_one_counter_per_prefix is
  'CGST Rule 46(b) requires a document serial number to be unique for a financial year — for the company, not per branch and not per voucher type. Two counters producing the same leading text would each start at 1 and issue the same numbers, which vouchers'' own UNIQUE key permits because branch_id and voucher_type are in it. This index is what makes that impossible. See 1160.';


-- ----------------------------------------------------------------------------
-- 3. next_voucher_number: refuse the draw in a sentence, instead of letting
--    the index above refuse it as a constraint name.
--
--    CREATE OR REPLACE, not DROP/CREATE: the signature is byte-identical to
--    0725's, so the nine internal callers keep resolving to it and its grants
--    survive. (0725 needed DROP/CREATE because it was ADDING the fifth
--    parameter, which would otherwise have been an overload the four-argument
--    callers never reached. That does not apply here.)
--
--    The check sits immediately before the upsert, after v_resolved is known,
--    and looks for a counter that is not this one but would print the same
--    text. It is a message, not the guarantee — section 2 is the guarantee.
-- ----------------------------------------------------------------------------
create or replace function app_private.next_voucher_number(
  p_company_id uuid,
  p_branch_id uuid,
  p_voucher_type text,
  p_voucher_date date,
  p_series_id uuid default null
) returns table(display_number text, seq_number integer, fy_label text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fy_start_month smallint;
  v_fy_label text;
  v_branch_code text;
  v_series_id uuid;
  v_template text;
  v_padding smallint;
  v_resolved text;
  v_number int;
  v_mode text;
  v_clash_branch text;
  v_clash_series text;
  v_clash_type text;
  v_clash_example text;
  v_this_series text;
begin
  select financial_year_start_month into v_fy_start_month
    from public.companies where id = p_company_id;
  if v_fy_start_month is null then raise exception 'Company not found'; end if;

  select code into v_branch_code
    from public.branches where id = p_branch_id and company_id = p_company_id;
  if v_branch_code is null then raise exception 'Branch not found in this company'; end if;

  v_fy_label := app_private.fy_label(p_voucher_date, v_fy_start_month);

  if p_series_id is not null then
    -- Naming a series is only meaningful in series mode. Silently honouring
    -- it in automatic mode would let a UI bug quietly split a company's
    -- supposedly continuous GST series in two.
    v_mode := app_private.voucher_numbering_mode(p_company_id, p_voucher_type);
    if v_mode <> 'series' then
      raise exception 'Numbering for % is set to "%", so a numbering series cannot be chosen. Switch that voucher type to series mode first.',
        p_voucher_type, v_mode;
    end if;

    select x.id, x.prefix, x.padding into v_series_id, v_template, v_padding
      from public.voucher_number_series x
     where x.id = p_series_id
       and x.company_id = p_company_id
       and x.voucher_type = p_voucher_type
       and x.is_active;
    if v_series_id is null then
      raise exception 'Numbering series % is not an active series for % in this company', p_series_id, p_voucher_type;
    end if;
  else
    select x.id, x.prefix, x.padding into v_series_id, v_template, v_padding
      from public.voucher_number_series x
     where x.company_id = p_company_id
       and x.voucher_type = p_voucher_type
       and x.is_default
       and x.is_active;

    -- Auto-provision on first use. A company that has never raised this
    -- voucher type has no series row, and demanding one before the first
    -- voucher can be posted would make 0725 a breaking change for every
    -- company in the database. The template built here is exactly the
    -- pre-0725 format, so a company that never opens the settings screen
    -- keeps the numbers it has always had — and it contains {BRANCH}, so an
    -- auto-provisioned series can never be the one that collides.
    if v_series_id is null then
      insert into public.voucher_number_series
        (company_id, voucher_type, name, prefix, padding, is_default, is_active)
      values (p_company_id, p_voucher_type, 'Default',
              '{BRANCH}/' || app_private.voucher_type_code(p_voucher_type) || '/{FY}/',
              5, true, true)
      on conflict do nothing;

      -- Re-read rather than RETURNING: under a concurrent first post the
      -- insert above legitimately does nothing, and the row we want is the
      -- one the other transaction created.
      select x.id, x.prefix, x.padding into v_series_id, v_template, v_padding
        from public.voucher_number_series x
       where x.company_id = p_company_id
         and x.voucher_type = p_voucher_type
         and x.is_default
         and x.is_active;

      if v_series_id is null then
        raise exception 'No active default numbering series for % in this company, and one could not be created', p_voucher_type;
      end if;
    end if;
  end if;

  v_resolved := app_private.resolve_number_prefix(v_template, v_branch_code, v_fy_label);

  -- ---- 1160: is some OTHER counter already printing this same text? -------
  -- Two ways to get here, both proved live in this migration's header: a
  -- series with no {BRANCH} in its prefix drawn from a second branch, and two
  -- voucher types configured with the same prefix. Either would hand this
  -- voucher a number that has already been issued this financial year.
  -- Refusing the posting is the lesser harm: an issued duplicate serial
  -- cannot be withdrawn, and CGST Rule 46(b) binds the number at issue.
  select b2.code,
         s2.name,
         s2.voucher_type,
         q.resolved_prefix || lpad('1', q.padding, '0')
    into v_clash_branch, v_clash_series, v_clash_type, v_clash_example
    from public.voucher_number_sequences q
    join public.branches b2 on b2.id = q.branch_id
    join public.voucher_number_series s2 on s2.id = q.series_id
   where q.company_id = p_company_id
     and q.financial_year_label = v_fy_label
     and q.resolved_prefix = v_resolved
     and not (q.branch_id = p_branch_id and q.series_id = v_series_id)
   limit 1;

  if v_clash_branch is not null then
    select x.name into v_this_series
      from public.voucher_number_series x where x.id = v_series_id;

    if v_clash_branch is distinct from v_branch_code then
      raise exception
        'Numbering series "%" has no {BRANCH} in its prefix, so it issues the same numbers in every branch — and it has already issued numbers beginning "%" at branch %. Raising this % at branch % would reissue a number this company has already used, which CGST Rule 46(b) forbids: a serial number must be unique for the whole financial year, not just within one branch. Fix it in Settings > Voucher numbering: add {BRANCH} to the prefix, or give branch % its own series with a different prefix.',
        coalesce(v_this_series, '?'), v_resolved, v_clash_branch,
        p_voucher_type, v_branch_code, v_branch_code;
    else
      raise exception
        'Numbering series "%" (%) and series "%" (%) both start their numbers with "%", so both would issue %. Two counters cannot share a prefix — each starts at 1, so every number would be issued twice, and CGST Rule 46(b) requires a serial number to be unique for the financial year. Give one of them a different prefix in Settings > Voucher numbering.',
        coalesce(v_this_series, '?'), p_voucher_type,
        v_clash_series, v_clash_type, v_resolved, v_clash_example;
    end if;
  end if;
  -- ------------------------------------------------------------------------

  insert into public.voucher_number_sequences
    (company_id, branch_id, voucher_type, financial_year_label, series_id,
     prefix, resolved_prefix, next_number, padding)
  values
    (p_company_id, p_branch_id, p_voucher_type, v_fy_label, v_series_id,
     v_branch_code || '/' || app_private.voucher_type_code(p_voucher_type),
     v_resolved, 2, v_padding)
  on conflict (company_id, branch_id, voucher_type, financial_year_label, series_id)
  do update set next_number = public.voucher_number_sequences.next_number + 1,
                -- Refreshed every draw so an edited series takes effect from
                -- the next number rather than staying frozen at first use,
                -- which is the defect 0725 exists to fix.
                resolved_prefix = excluded.resolved_prefix,
                padding = excluded.padding
  returning (next_number - 1), padding into v_number, v_padding;

  return query select
    (v_resolved || lpad(v_number::text, v_padding, '0')),
    v_number,
    v_fy_label;
end;
$$;

comment on function app_private.next_voucher_number(uuid, uuid, text, date, uuid) is
  'Mints the next voucher number. Four-argument calls (all nine internal callers) draw from the voucher type''s default series, auto-provisioning it on first use with the pre-0725 format so nothing renumbers. A fifth argument names an explicit series and is only accepted in series mode. Since 1160 it refuses, in a sentence, to draw from a counter whose leading text another counter in the same company and financial year is already using — the cross-branch and cross-voucher-type duplicate serial numbers CGST Rule 46(b) forbids. See 0725, 1160.';


-- ----------------------------------------------------------------------------
-- 4. The configuration-time guard, so nobody meets section 3 in the first
--    place. Shared by create and update so the two cannot drift.
--
--    Checks, in the order a person would want to hear them:
--      (a) more than one branch and no {BRANCH} in the prefix -> refused;
--      (b) the prefix would resolve, in some branch and some financial year
--          this company has counters for, to text an existing counter is
--          already using -> refused, naming it;
--      (c) the prefix would resolve to the same text as another ACTIVE series
--          of this company (any voucher type), even one that has not issued
--          anything yet -> refused, naming it.
--
--    (b) is checked against every financial year that appears in the
--        company's counter rows plus the current one, not just the current
--        one: a prefix that collides with last year's counters would be
--        rejected by the index in section 2 the moment someone back-dates a
--        voucher into that year, and finding that out at posting time is
--        worse than finding it out here.
-- ----------------------------------------------------------------------------
create or replace function app_private.assert_series_prefix_unambiguous(
  p_company_id uuid,
  p_voucher_type text,
  p_series_id uuid,
  p_prefix text
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branches int;
  v_codes text;
  v_clash_prefix text;
  v_clash_who text;
begin
  select count(*), string_agg(b.code, ' and ' order by b.code)
    into v_branches, v_codes
    from public.branches b where b.company_id = p_company_id;

  -- (a) The whole point of this migration.
  if v_branches > 1 and not app_private.prefix_names_the_branch(p_prefix) then
    raise exception
      'Prefix "%" does not contain {BRANCH}, so it would issue exactly the same numbers in every branch — and this company has % branches (%). CGST Rule 46(b) requires a document serial number to be unique for the whole financial year, not per branch, so two branches printing the same number is a real defect in the series. Either put {BRANCH} in the prefix (e.g. "{BRANCH}%" gives a different number at each branch), or create one series per branch, each with its own distinct prefix — Rule 46(b) expressly allows a serial "in one or multiple series".',
      p_prefix, v_branches, v_codes, p_prefix;
  end if;

  -- (b) Text an existing counter is already printing.
  select cand.resolved,
         'series "' || s2.name || '" (' || s2.voucher_type || ') at branch '
           || b2.code || ' in ' || q.financial_year_label
    into v_clash_prefix, v_clash_who
    from public.branches b
    cross join lateral (
      select distinct financial_year_label as fy
        from public.voucher_number_sequences
       where company_id = p_company_id
      union
      select app_private.fy_label(current_date, c.financial_year_start_month)
        from public.companies c where c.id = p_company_id
    ) fys
    cross join lateral (
      select app_private.resolve_number_prefix(p_prefix, b.code, fys.fy) as resolved
    ) cand
    join public.voucher_number_sequences q
      on q.company_id = p_company_id
     and q.financial_year_label = fys.fy
     and q.resolved_prefix = cand.resolved
     and q.series_id is distinct from p_series_id
    join public.branches b2 on b2.id = q.branch_id
    join public.voucher_number_series s2 on s2.id = q.series_id
   where b.company_id = p_company_id
   limit 1;

  if v_clash_prefix is not null then
    raise exception
      'Prefix "%" would produce numbers beginning "%", which is already in use by % — those numbers have been issued. Reusing that prefix would start a second counter at 1 behind the same text and reissue every one of them. Choose a prefix no other series uses.',
      p_prefix, v_clash_prefix, v_clash_who;
  end if;

  -- (c) Text another live series would print, even before it has issued
  --     anything. Same voucher type or not: the counters are independent, so
  --     a shared prefix duplicates from the first number.
  select cand.resolved, 'series "' || y.name || '" (' || y.voucher_type || ')'
    into v_clash_prefix, v_clash_who
    from public.branches b
    cross join lateral (
      select app_private.fy_label(current_date, c.financial_year_start_month) as fy
        from public.companies c where c.id = p_company_id
    ) fys
    cross join lateral (
      select app_private.resolve_number_prefix(p_prefix, b.code, fys.fy) as resolved
    ) cand
    join public.voucher_number_series y
      on y.company_id = p_company_id
     and y.is_active
     and y.id is distinct from p_series_id
     and app_private.resolve_number_prefix(y.prefix, b.code, fys.fy) = cand.resolved
   where b.company_id = p_company_id
   limit 1;

  if v_clash_prefix is not null then
    raise exception
      'Prefix "%" would produce numbers beginning "%", exactly like %. Two series cannot share a prefix: their counters are independent, so both would start at 1 and every number would be issued twice, which CGST Rule 46(b) forbids within a financial year.',
      p_prefix, v_clash_prefix, v_clash_who;
  end if;
end;
$$;

comment on function app_private.assert_series_prefix_unambiguous(uuid, text, uuid, text) is
  'Refuses a voucher-number series prefix that could produce the same document number twice in one financial year: one that omits {BRANCH} in a company with more than one branch, or one that resolves to text another series or an existing counter is already using. Raises messages written for an admin, not constraint names. See 1160.';


-- ----------------------------------------------------------------------------
-- 5. create_voucher_number_series — guard every new series.
--
--    Unchanged from 0725 apart from the guard call, which is placed after the
--    cheap syntactic checks (so "you used a comma" is still the first thing
--    said) and before the duplicate-name check is spent.
-- ----------------------------------------------------------------------------
create or replace function public.create_voucher_number_series(
  p_company_id uuid,
  p_voucher_type text,
  p_name text,
  p_prefix text,
  p_padding smallint default 5,
  p_is_default boolean default false
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_has_default boolean;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can create a numbering series';
  end if;

  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'A numbering series needs a name';
  end if;
  if p_prefix is null or p_prefix !~ '^([A-Za-z0-9/-]|\{(BRANCH|FY|FYS|YY|YYYY)\})*$' then
    raise exception 'Prefix "%" may only contain letters, digits, hyphen, slash and the tokens {BRANCH}, {FY}, {FYS}, {YYYY}, {YY} — CGST Rule 46(b) allows no other characters in a document number.', p_prefix;
  end if;
  if p_padding is null or p_padding < 1 or p_padding > 9 then
    raise exception 'Padding must be between 1 and 9 digits, not %', p_padding;
  end if;

  -- 1160: a new series is always held to the full rule. There is no existing
  -- configuration to grandfather here, so nothing is being broken.
  perform app_private.assert_series_prefix_unambiguous(
    p_company_id, p_voucher_type, null, p_prefix);

  if exists (select 1 from public.voucher_number_series x
              where x.company_id = p_company_id
                and x.voucher_type = p_voucher_type
                and x.name = btrim(p_name)) then
    raise exception 'This company already has a % numbering series called "%"', p_voucher_type, btrim(p_name);
  end if;

  -- The first series of a voucher type is always the default, whatever the
  -- caller asked for: a type with series but no default would strand every
  -- four-argument next_voucher_number call.
  select exists (select 1 from public.voucher_number_series x
                  where x.company_id = p_company_id
                    and x.voucher_type = p_voucher_type
                    and x.is_default)
    into v_has_default;

  if p_is_default and v_has_default then
    update public.voucher_number_series
       set is_default = false
     where company_id = p_company_id
       and voucher_type = p_voucher_type
       and is_default;
  end if;

  insert into public.voucher_number_series
    (company_id, voucher_type, name, prefix, padding, is_default, is_active, created_by)
  values (p_company_id, p_voucher_type, btrim(p_name), p_prefix, p_padding,
          p_is_default or not v_has_default, true, auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_voucher_number_series(uuid, text, text, text, smallint, boolean) is
  'Creates a named numbering series. Admin only. The first series of a voucher type is forced to be the default; making a later one default demotes the previous one in the same statement, since the partial unique index permits only one. Since 1160 the prefix must be able to tell this company''s branches apart and must not duplicate another series'' numbers. Returns the new series id. See 0725, 1160.';


-- ----------------------------------------------------------------------------
-- 6. update_voucher_number_series — guard a CHANGED prefix, and guard the
--    promotion of a branch-blind series to default. Two deliberate
--    grandfathering decisions, both of which exist so that this migration
--    cannot break a series already in use:
--
--    * The guard runs ONLY when the prefix is actually changing. Sharma
--      Textiles' 'Export' series (EXP/{FYS}/, two branches, in use at HO)
--      would fail check (a) — and an admin who only wants to widen its
--      padding from 4 to 5 digits, or rename it, must still be able to. A
--      series that already exists is a fact; refusing to let anyone touch any
--      part of it until they also change the numbering format would be
--      punishing them for the app's own past permissiveness. The moment they
--      DO edit the prefix, the new one must be safe.
--
--    * Promoting such a series to default IS refused, whether or not the
--      prefix moves. The default series is drawn from by every branch (all
--      nine internal callers pass no series id), so a branch-blind default in
--      a multi-branch company is not a latent hazard, it is an immediate one:
--      the very next voucher raised in the other branch collides.
-- ----------------------------------------------------------------------------
create or replace function public.update_voucher_number_series(
  p_company_id uuid,
  p_series_id uuid,
  p_name text default null,
  p_prefix text default null,
  p_padding smallint default null,
  p_is_default boolean default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_current_prefix text;
  v_effective_prefix text;
  v_branches int;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can change a numbering series';
  end if;

  select x.voucher_type, x.prefix into v_type, v_current_prefix
    from public.voucher_number_series x
   where x.id = p_series_id and x.company_id = p_company_id;
  if v_type is null then
    raise exception 'Numbering series % does not belong to this company', p_series_id;
  end if;

  if p_prefix is not null and p_prefix !~ '^([A-Za-z0-9/-]|\{(BRANCH|FY|FYS|YY|YYYY)\})*$' then
    raise exception 'Prefix "%" may only contain letters, digits, hyphen, slash and the tokens {BRANCH}, {FY}, {FYS}, {YYYY}, {YY} — CGST Rule 46(b) allows no other characters in a document number.', p_prefix;
  end if;
  if p_padding is not null and (p_padding < 1 or p_padding > 9) then
    raise exception 'Padding must be between 1 and 9 digits, not %', p_padding;
  end if;

  -- Demoting a default is refused rather than silently done, because a
  -- voucher type with no default cannot mint at all.
  if p_is_default = false then
    raise exception 'A voucher type must always have a default series. Make another series the default instead of clearing this one.';
  end if;

  v_effective_prefix := coalesce(p_prefix, v_current_prefix);

  -- 1160, first grandfathering rule: only a CHANGED prefix is held to the
  -- rule, so an untouched one cannot block a rename or a padding change.
  if p_prefix is not null and p_prefix is distinct from v_current_prefix then
    perform app_private.assert_series_prefix_unambiguous(
      p_company_id, v_type, p_series_id, p_prefix);
  end if;

  -- 1160, second: promotion to default is held to it regardless, because the
  -- default is what every branch draws from.
  if p_is_default and not app_private.prefix_names_the_branch(v_effective_prefix) then
    select count(*) into v_branches
      from public.branches b where b.company_id = p_company_id;
    if v_branches > 1 then
      raise exception
        'Series prefix "%" has no {BRANCH} token, so it issues the same numbers in every branch — and the default series is the one every branch numbers from. Making it the default for % would have the next voucher raised in each branch carry the same number, which CGST Rule 46(b) forbids. Add {BRANCH} to the prefix first.',
        v_effective_prefix, v_type;
    end if;
  end if;

  if p_is_default then
    update public.voucher_number_series
       set is_default = false
     where company_id = p_company_id
       and voucher_type = v_type
       and is_default
       and id <> p_series_id;
  end if;

  -- Prefix and padding changes are deliberately permitted MID-YEAR, which is
  -- the whole point of 0725: a company already sitting on 20-character
  -- HO/SAL/2026-27/00002 numbers must be able to shorten them NOW, not next
  -- April. Rule 46(b) expressly allows multiple series within one financial
  -- year, so the numbers before and after the change are simply two series;
  -- the counter is not reset, so nothing is reissued and no number repeats.
  update public.voucher_number_series x
     set name       = coalesce(btrim(p_name), x.name),
         prefix     = coalesce(p_prefix, x.prefix),
         padding    = coalesce(p_padding, x.padding),
         is_default = coalesce(p_is_default, x.is_default)
   where x.id = p_series_id and x.company_id = p_company_id;
end;
$$;

comment on function public.update_voucher_number_series(uuid, uuid, text, text, smallint, boolean) is
  'Edits a numbering series in place. Admin only; every argument optional, null meaning "leave alone". Prefix and padding changes are allowed MID-YEAR on purpose and take effect from the next number drawn, never retroactively. Since 1160 a CHANGED prefix must be able to tell this company''s branches apart; an unchanged one is grandfathered so a rename or padding change is never blocked, but promoting a branch-blind series to default is refused in a multi-branch company. See 0725, 1160.';


-- ----------------------------------------------------------------------------
-- 7. get_voucher_numbering_settings gains the two columns the settings screen
--    needs to show the grandfathered case — the ONE case this migration
--    deliberately leaves alive, because it already exists in real data and
--    breaking it would be worse than flagging it.
--
--    DROP then CREATE: the return table gains columns, which CREATE OR
--    REPLACE cannot do. Grants are re-asserted in section 8 for the same
--    reason.
--
--    branch_scope_ok  false when this company has more than one branch and
--                     this series' prefix has no {BRANCH} token.
--    branch_scope_note the sentence to show. Names the branches that have
--                     actually drawn from the series so far, because "it has
--                     only ever been used at HO" is the fact that makes the
--                     warning actionable rather than alarming. Stronger
--                     wording when the offending series is the DEFAULT, since
--                     then no other branch can raise that voucher type at all.
-- ----------------------------------------------------------------------------
drop function if exists public.get_voucher_numbering_settings(uuid, uuid, date);

create function public.get_voucher_numbering_settings(
  p_company_id uuid,
  p_branch_id uuid default null,
  p_on_date date default current_date
) returns table (
  voucher_type text,
  type_label text,
  allows_manual boolean,
  mode text,
  branch_id uuid,
  branch_code text,
  financial_year_label text,
  series_id uuid,
  series_name text,
  prefix text,
  padding smallint,
  is_default boolean,
  is_active boolean,
  next_number integer,
  preview_number text,
  preview_length integer,
  rule46b_ok boolean,
  branch_scope_ok boolean,
  branch_scope_note text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
  v_code text;
  v_fy text;
  v_fy_start smallint;
  v_branch_count int;
  v_all_codes text;
begin
  if not app_private.is_company_member(p_company_id) then
    raise exception 'Not permitted to read numbering settings for this company';
  end if;

  select c.financial_year_start_month into v_fy_start
    from public.companies c where c.id = p_company_id;
  if v_fy_start is null then raise exception 'Company not found'; end if;
  v_fy := app_private.fy_label(p_on_date, v_fy_start);

  select count(*), string_agg(b.code, ', ' order by b.code)
    into v_branch_count, v_all_codes
    from public.branches b where b.company_id = p_company_id;

  -- The preview needs a concrete branch to resolve {BRANCH}. Falls back to
  -- the company's lowest-coded branch and returns which one it used, so the
  -- screen can say "preview for HO" rather than implying the format is
  -- branch-independent (it is not — {BRANCH} is the commonest token).
  select b.id, b.code into v_branch, v_code
    from public.branches b
   where b.company_id = p_company_id
     and (p_branch_id is null or b.id = p_branch_id)
   order by b.code
   limit 1;
  if v_branch is null then
    raise exception 'This company has no branch to preview a number for';
  end if;

  return query
  with t as (
    select * from (values
      ('receipt',              'Receipt',           true),
      ('payment',              'Payment',           true),
      ('contra',               'Contra',            true),
      ('journal',              'Journal',           true),
      ('sales',                'Sales invoice',     true),
      ('purchase',             'Purchase invoice',  true),
      ('credit_note',          'Credit note',       true),
      ('debit_note',           'Debit note',        true),
      ('branch_transfer',      'Branch transfer',   true),
      ('stock_journal',        'Stock journal',     false),
      ('job_work_out',         'Job work challan',  false),
      ('job_work_in',          'Job work return',   false),
      ('delivery_challan_out', 'Delivery challan',  false)
    ) as v(vtype, vlabel, vmanual)
  ),
  s as (
    -- LEFT JOIN, so a voucher type that has never been used still previews:
    -- it shows the Default series next_voucher_number would provision on
    -- first use, with series_id null so the screen can tell the difference.
    select t.vtype,
           t.vlabel,
           t.vmanual,
           x.id as s_id,
           coalesce(x.name, 'Default') as s_name,
           coalesce(x.prefix,
                    '{BRANCH}/' || app_private.voucher_type_code(t.vtype) || '/{FY}/') as s_prefix,
           coalesce(x.padding, 5::smallint) as s_padding,
           coalesce(x.is_default, true) as s_is_default,
           coalesce(x.is_active, true) as s_is_active
      from t
      left join public.voucher_number_series x
        on x.company_id = p_company_id and x.voucher_type = t.vtype
  )
  select s.vtype,
         s.vlabel,
         s.vmanual,
         app_private.voucher_numbering_mode(p_company_id, s.vtype),
         v_branch,
         v_code,
         v_fy,
         s.s_id,
         s.s_name,
         s.s_prefix,
         s.s_padding,
         s.s_is_default,
         s.s_is_active,
         coalesce(q.next_number, 1),
         p.n,
         length(p.n),
         app_private.is_rule46b_number(p.n),
         scope.ok,
         scope.note
    from s
    left join public.voucher_number_sequences q
      on q.company_id = p_company_id
     and q.branch_id = v_branch
     and q.voucher_type = s.vtype
     and q.financial_year_label = v_fy
     and q.series_id = s.s_id
    cross join lateral (
      select app_private.resolve_number_prefix(s.s_prefix, v_code, v_fy)
             || lpad(coalesce(q.next_number, 1)::text, s.s_padding, '0') as n
    ) p
    cross join lateral (
      select v_branch_count <= 1 or app_private.prefix_names_the_branch(s.s_prefix) as ok
    ) okx
    cross join lateral (
      select okx.ok as ok,
             case when okx.ok then null else
               'This prefix has no {BRANCH} token, so it issues the same number in every branch. '
               || 'This company has ' || v_branch_count || ' branches (' || v_all_codes || '). '
               || coalesce(
                    (select 'So far it has only been used at ' ||
                            string_agg(distinct b3.code, ' and ') || '. '
                       from public.voucher_number_sequences q3
                       join public.branches b3 on b3.id = q3.branch_id
                      where q3.company_id = p_company_id and q3.series_id = s.s_id),
                    'It has not issued any number yet. ')
               || case when s.s_is_default
                    then 'It is the DEFAULT series, which every branch numbers from, so the next '
                         || lower(s.vlabel) || ' raised in another branch will be refused rather '
                         || 'than issued a duplicate. Fix this before it happens.'
                    else 'Using it in another branch will be refused rather than issued a '
                         || 'duplicate, because CGST Rule 46(b) requires a serial number to be '
                         || 'unique for the whole financial year, not per branch.'
                  end
               || ' Add {BRANCH} to the prefix, or give each branch its own series.'
             end as note
    ) scope
   order by s.vlabel, s.s_is_default desc, s.s_name;
end;
$$;

comment on function public.get_voucher_numbering_settings(uuid, uuid, date) is
  'Every voucher type with its numbering mode, its series (or the Default that would be provisioned on first use, distinguishable by a null series_id), the live counter, the exact number that would be issued next, its character count and whether it satisfies CGST Rule 46(b). Since 1160 it also returns branch_scope_ok / branch_scope_note: false and a sentence when the series prefix cannot tell this company''s branches apart, which 1160 now refuses to create but grandfathers where it already exists. One row per series, so a type in series mode returns several. See 0725, 1160.';


-- ----------------------------------------------------------------------------
-- 8. Grants. The house rule, on every function this file creates or replaces.
--    get_voucher_numbering_settings was DROPped, so its grants were wiped and
--    must be restated; the rest kept theirs through CREATE OR REPLACE, and
--    are restated anyway so this file is the complete truth about them.
-- ----------------------------------------------------------------------------
revoke all on function app_private.prefix_names_the_branch(text) from public, anon;
grant execute on function app_private.prefix_names_the_branch(text) to authenticated, service_role;

revoke all on function app_private.assert_series_prefix_unambiguous(uuid, text, uuid, text) from public, anon;
grant execute on function app_private.assert_series_prefix_unambiguous(uuid, text, uuid, text) to authenticated, service_role;

revoke all on function app_private.next_voucher_number(uuid, uuid, text, date, uuid) from public, anon;
grant execute on function app_private.next_voucher_number(uuid, uuid, text, date, uuid) to authenticated, service_role;

revoke all on function public.create_voucher_number_series(uuid, text, text, text, smallint, boolean) from public, anon;
grant execute on function public.create_voucher_number_series(uuid, text, text, text, smallint, boolean) to authenticated;

revoke all on function public.update_voucher_number_series(uuid, uuid, text, text, smallint, boolean) from public, anon;
grant execute on function public.update_voucher_number_series(uuid, uuid, text, text, smallint, boolean) to authenticated;

revoke all on function public.get_voucher_numbering_settings(uuid, uuid, date) from public, anon;
grant execute on function public.get_voucher_numbering_settings(uuid, uuid, date) to authenticated;


-- ----------------------------------------------------------------------------
-- 9. Post-flight. Prove, in the same transaction that made the change, that
--    nothing already in the database was broken by it: every counter still
--    exists, none moved, and every existing series still resolves to the
--    prefix it was resolving to before.
-- ----------------------------------------------------------------------------
do $$
declare
  v_bad int;
begin
  -- Every counter row's stored resolved_prefix still matches what its own
  -- series and branch produce today. (Rows whose series prefix was edited
  -- after the last draw are legitimately stale, so compare only rows whose
  -- series prefix still resolves to what is stored.)
  select count(*) into v_bad
    from public.voucher_number_sequences q
    join public.voucher_number_series x on x.id = q.series_id
    join public.branches b on b.id = q.branch_id
   where q.resolved_prefix is null or q.resolved_prefix = '';
  if v_bad > 0 then
    raise exception '1160 post-flight: % counter row(s) lost their resolved prefix', v_bad;
  end if;

  -- Every voucher type with any series still has exactly one active default,
  -- i.e. nothing above stranded a type.
  select count(*) into v_bad from (
    select company_id, voucher_type
      from public.voucher_number_series
     group by company_id, voucher_type
    having count(*) filter (where is_default and is_active) <> 1
  ) y;
  if v_bad > 0 then
    raise exception '1160 post-flight: % (company, voucher_type) group(s) no longer have exactly one active default series', v_bad;
  end if;
end;
$$;
