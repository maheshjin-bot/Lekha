-- ============================================================================
-- 1700 — TDS Receivable was invisible to income tax and advance tax
-- ============================================================================
-- get_income_tax_computation reports tds_tcs_credit by reading the DEBIT
-- MOVEMENT of the ledger mapped to tax_ledger_map's purpose = 'tds_receivable'
-- (see 0079). That function is correct. The bug is upstream: nothing wires
-- that map row up for a company created through the app's real path.
--
-- app_private.seed_tds_receivable_ledger (0079) creates the row, but its
-- ONLY caller was a one-time backfill loop inside 0079 itself, run once, over
-- every company that existed at that moment. seed_chart_of_accounts — the
-- single function public.create_company (0014) calls to provision a new
-- company, and the one that DOES seed TDS Payable unconditionally via
-- app_private.seed_tds_ledgers — never calls seed_tds_receivable_ledger. So
-- every company created via create_company since 0079 shipped has a
-- 'tds_payable' row and no 'tds_receivable' row, no matter what its TDS
-- Receivable ledger actually carries.
--
-- CONFIRMED LIVE, before this migration: every one of the ten-plus companies
-- from the 19-20 Aug test-data batch already carries the tds_receivable map
-- (that seeding script called both functions directly, bypassing
-- create_company) — but BOTH real pilot companies created through the actual
-- app flow do not:
--
--   TEST Vantage Consulting Services Pvt Ltd (9e4071b8-...), created
--   2026-09-03: has a ledger literally named "TDS Receivable" carrying a
--   60,750.00 debit movement for the year, and NO tax_ledger_map row for it.
--   get_income_tax_computation reports tds_tcs_credit: 0.00 for that company
--   today, and get_advance_tax_status' shortfall schedule is built on the
--   un-credited liability as a result.
--
--   TEST Rangoli Spice Works Pvt Ltd (8e161d8e-...), created 2026-08-31: has
--   NO ledger named "TDS Receivable" at all (it has never had TDS deducted
--   from anything it was paid), and correspondingly no map row. This is the
--   CONTROL CASE this migration must leave exactly alone.
--
-- FIX, three parts:
--
--   (1) seed_chart_of_accounts now calls seed_tds_receivable_ledger right
--       after seed_tds_ledgers — same call site, same reasoning ("harmless
--       for a company that never has TDS deducted from it, same as the
--       unused sub-groups already seeded alongside it"), applied via the
--       house assert-then-replace pattern (1200/1420/1451) rather than a
--       retype, and its grants restated per house rule.
--
--   (2) A one-time, NARROWLY SCOPED backfill for existing companies. Unlike
--       0079's original backfill (which called seed_tds_receivable_ledger
--       for every company unconditionally, fabricating a ledger for any
--       company that didn't already have one), this backfill loop is
--       restricted to companies that ALREADY have a ledger named "TDS
--       Receivable" and no map row yet. seed_tds_receivable_ledger is only
--       invoked for exactly that pre-filtered set, so its create-a-ledger
--       branch can never fire here — a company with no such ledger (Rangoli,
--       and any other company that has never had TDS deducted from it) is
--       untouched: no ledger fabricated, no map row created. This is
--       deliberately more conservative than seed_tds_ledgers' own 0030
--       backfill, because TDS Payable is created unconditionally for every
--       company going forward (a company may deduct TDS from a vendor at any
--       time) while a company that has genuinely never had TDS deducted from
--       ITS OWN receipts, ever, gets nothing invented for it here.
--
--   (3) Explicit designation, considered and NOT built: could a company pick
--       which ledger plays the tds_receivable role, rather than this being
--       name-match-at-creation-time forever? It already can, with no new
--       code. tax_ledger_map's own write RLS policy (0006/0079,
--       tax_ledger_map_write) grants a company admin ALL privileges —
--       insert/update/delete — on this table, checked via
--       app_private.is_company_admin, with no narrower per-purpose
--       restriction anywhere. An admin can already re-point
--       tax_ledger_map(company_id, purpose='tds_receivable') at any ledger
--       of that company's own by writing the row directly. Adding a new RPC
--       to do the same insert/update under the same admin check would
--       duplicate a permission that already exists at the table level, not
--       add one. What is actually missing is a SCREEN — Settings > Taxes (or
--       similar) letting an admin see the current tds_receivable/tds_payable
--       mapping and repoint it, with the delete-then-insert (or update)
--       wrapped so a stray duplicate can't be created against
--       tax_ledger_map_company_idx. That is a frontend change, outside this
--       migration's file scope (app/, components/ are not owned here), so it
--       is described rather than built.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) Wire the call into seed_chart_of_accounts, targeted replace + assert.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_from constant text :=
'  -- TDS Payable, same as Duties & Taxes above: unconditional and harmless
  -- for a company that never deducts TDS from anyone, seeded here so it is
  -- available the moment a TDS-deductee vendor first shows up, with no
  -- separate "configure TDS first" step.
  perform app_private.seed_tds_ledgers(p_company_id);
end;';
  v_to constant text :=
'  -- TDS Payable, same as Duties & Taxes above: unconditional and harmless
  -- for a company that never deducts TDS from anyone, seeded here so it is
  -- available the moment a TDS-deductee vendor first shows up, with no
  -- separate "configure TDS first" step.
  perform app_private.seed_tds_ledgers(p_company_id);

  -- TDS Receivable (1700): the company as DEDUCTEE rather than deductor.
  -- Same unconditional-and-harmless reasoning as TDS Payable immediately
  -- above, and until now this was never called from here at all -- so no
  -- company created via create_company since 0079 shipped ever got a
  -- tax_ledger_map row for tds_receivable, and get_income_tax_computation''s
  -- tds_tcs_credit read as 0.00 regardless of what the company''s own TDS
  -- Receivable ledger actually carried.
  perform app_private.seed_tds_receivable_ledger(p_company_id);
end;';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'seed_chart_of_accounts' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1700: app_private.seed_chart_of_accounts is missing.';
  end if;

  if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
    raise exception '1700: seed_chart_of_accounts''s TDS Payable call site has moved or already changed; fix by hand.';
  end if;

  execute replace(v_def, v_from, v_to);
end;
$mig$;

revoke all on function app_private.seed_chart_of_accounts(uuid) from public, anon;
grant execute on function app_private.seed_chart_of_accounts(uuid) to authenticated;

-- app_private.seed_tds_receivable_ledger's body is untouched (0079's version
-- is already correct — the bug was entirely that nothing called it), but it
-- is explicitly in this migration's file scope and was still PUBLIC-granted
-- (anon inherits PUBLIC's default EXECUTE grant, per the house lesson —
-- revoking from anon alone is a no-op). Restated for hygiene now that it is
-- a live part of every company's provisioning path rather than a one-off
-- backfill helper. app_private functions are not exposed as PostgREST RPC
-- routes (only public.* is), so this was not directly callable over the API
-- either way, but it should not have been PUBLIC-granted regardless.
revoke all on function app_private.seed_tds_receivable_ledger(uuid) from public, anon;
grant execute on function app_private.seed_tds_receivable_ledger(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- (2) Backfill: existing companies that already have a "TDS Receivable"
--     ledger and no map row. Nothing is fabricated for a company that has
--     no such ledger — see the control-case reasoning above.
-- ----------------------------------------------------------------------------
do $backfill$
declare
  r record;
  v_count int := 0;
  v_names text := '';
begin
  for r in
    select l.company_id, c.name
      from public.ledgers l
      join public.companies c on c.id = l.company_id
     where lower(l.name) = 'tds receivable'
       and not exists (
         select 1 from public.tax_ledger_map m
          where m.company_id = l.company_id
            and m.gst_registration_id is null
            and m.purpose = 'tds_receivable'
       )
  loop
    perform app_private.seed_tds_receivable_ledger(r.company_id);
    v_count := v_count + 1;
    v_names := v_names || r.name || ' (' || r.company_id || '); ';
  end loop;

  raise notice '1700: backfilled tax_ledger_map (purpose=tds_receivable) for % existing compan(y/ies): %', v_count, v_names;
end;
$backfill$;
