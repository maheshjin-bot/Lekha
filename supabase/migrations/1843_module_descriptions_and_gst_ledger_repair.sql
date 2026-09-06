-- ============================================================================
-- 1843 — Two module descriptions announced a statutory test the app never
--        runs, and ~20 error messages told users to "seed the GST ledgers"
--        through a door that has never existed
-- ============================================================================
-- RECONCILIATION NOTE. This file was originally authored as migration 1550
-- in a different, unmerged worktree and applied directly to the shared live
-- database from there. 1550 is taken on main by an unrelated migration
-- (1550_saved_report_views.sql), so it is committed here under a fresh
-- number purely so git stops disagreeing with what the database already
-- has. Re-verified live immediately before this commit: ref_modules.description
-- for tax_audit and payroll_statutory already carries the corrected text
-- below, company_modules.locked_reason has zero rows still quoting the old
-- wording, and public.repair_gst_ledger_map already exists with the exact
-- signature and body this file defines. Every RAISE message inside this file
-- that names "1550" is quoted verbatim from the original run and is
-- otherwise idempotent by the file's own design (each DO block checks live
-- state and skips with a NOTICE rather than re-applying) — but this copy is
-- being added for the historical record, not executed again.
-- ============================================================================
--
-- Follows 1290 (the TCS description that still advertised the abolished Sec
-- 206C(1H)) exactly: Settings -> Modules prints ref_modules.description
-- verbatim, and app_private.resolve_conditional_modules stamps a COPY of it
-- into company_modules.locked_reason as 'Activated automatically: ' ||
-- description. So a wrong description is printed twice — once live from
-- ref_modules, once frozen in every row that was created while it was wrong.
-- 1290 corrected the ref_modules row and left the frozen copies behind; this
-- file corrects both, and cleans up 1290's own 11 leftovers while it is here.
--
-- ---------------------------------------------------------------------------
-- PART A. tax_audit — "Activates on crossing the 44AB threshold"
-- ---------------------------------------------------------------------------
-- VERIFIED LIVE, three ways, before writing this:
--
--  1. ref_modules.activates_when for 'tax_audit' is {"compliance_mode":
--     "compliance"}. Nothing else. Turnover is not in the rule.
--  2. app_private.module_condition_met's predicate vocabulary — the live
--     body, not the repo copy — is exactly: compliance_mode, has_tan,
--     has_iec, has_pan, entity_type, statement_format, roc_applicable,
--     remuneration_section, has_gstin, gstin_count_min. Its CASE has no
--     turnover branch, and its ELSE returns false, so a turnover key could
--     not even be expressed today.
--  3. public.companies has no turnover column, and neither does any other
--     table in the public schema (information_schema scan for
--     turnover/revenue/headcount: zero rows).
--
-- 15 companies currently carry this module, every one of them told a
-- threshold was crossed that was never measured, because measuring it is not
-- something this schema can do from a company row.
--
-- WHY THIS IS COPY-ONLY, DELIBERATELY. Implementing the description as
-- written would mean adding turnover to public.companies plus a turnover key
-- to module_condition_met. Rejected, for three reasons:
--
--  * A turnover COLUMN would be a self-declared number, and a module
--    switching itself on from a figure the user typed is the same false
--    determination this migration exists to remove — just relocated. Sec
--    44AB turns on turnover as computed, not as asserted.
--  * The real figure is already computed, properly, from posted books:
--    public.get_tax_audit_applicability derives turnover from direct-income
--    ledger movement over an explicit FY window, applies the correct one of
--    the three thresholds (Rs 50L professional / Rs 1cr / Rs 10cr where the
--    5% cash-receipts AND cash-payments tests both hold), returns the report
--    form and due date, and names in its own `reason` what it does NOT
--    evaluate (Sec 44AB(e) presumptive opt-out). That calculation is real
--    and is not touched here. It is period-scoped, which a
--    module_condition_met predicate is not: the resolver asks one undated
--    question per company.
--  * Activation is effective-dated and, since 1460, dated from the
--    company's own book_beginning_date. A threshold crossed in year three
--    would have to close and reopen a window mid-year and retro-date it.
--    That is a real feature; it is not a description fix.
--
-- So the honest split, which is also the split the code already implements:
-- the MODULE opens the 3CA/3CB and 3CD working papers for anyone in
-- compliance mode, and the REPORT decides whether Sec 44AB binds. The
-- description now says that instead of claiming the module decided it.
--
-- ---------------------------------------------------------------------------
-- PART B. payroll_statutory — "Activates past the headcount thresholds"
-- ---------------------------------------------------------------------------
-- VERIFIED LIVE the same way. activates_when is {"compliance_mode":
-- "compliance"}; no headcount key exists in module_condition_met either. And
-- the resolver could not react to hiring even if one did: the only triggers
-- that call it are resolve_modules_on_company_change on public.companies and
-- resolve_modules_on_registration_change on public.gst_registrations.
-- There is no trigger on public.employees anywhere, so taking on a 20th
-- employee re-resolves nothing.
--
-- Live proof of the gap, all 5 companies holding the module today:
--   Nexgen Softwares Private Limited      0 employees
--   Test PVT LTD                          0 employees
--   Bharat Industries Limited             1 employee
--   TEST Rangoli Spice Works Pvt Ltd      6 employees
--   Sharma Textiles                      11 employees
-- Not one of them is past PF's threshold, and two have no employees at all.
--
-- The description was also wrong on the law, not just on the mechanism:
-- there is no single "headcount threshold". EPF & MP Act 1952 Sec 1(3)(b)
-- binds a scheduled establishment at 20 persons; ESI Act 1948 Sec 1(5) binds
-- at 10 in a State that has notified the area (some notify at 20); and
-- professional tax is levied by each State on the individual earner, with no
-- headcount test at all. One sentence could not have been right about all
-- three. Same reasoning as Part A applies to implementing it — a headcount
-- predicate would need an employees trigger AND a per-levy split AND a date
-- to activate from, which is a feature, not a caption.
--
-- Both replacements point at a screen confirmed to exist and to be
-- reachable: Reports -> Tax audit (/reports/tax-audit, NavRail.tsx:162) and
-- Employer registrations (/settings/employer-registrations,
-- NavRail.tsx:189). Naming an unreachable screen is the other half of this
-- same defect — see Part D.
--
-- ---------------------------------------------------------------------------
-- PART C. A tax-ledger map repair that a user can actually reach
-- ---------------------------------------------------------------------------
-- 'No % ledger configured for this registration. Seed the GST ledgers for it
-- first.' appears at 21 sites across the migrations directory and once in
-- components/capture/previewModel.ts. It names app_private.seed_gst_ledgers,
-- which is in app_private, is granted to no client role, and only ever runs
-- from add_gst_registration when a registration is created. A company whose
-- tax_ledger_map is short a purpose therefore cannot post a GST invoice at
-- all, and the message tells it to press a button that does not exist.
--
-- THE BRIEF FOR THIS FIX ASSUMED seed_gst_ledgers WAS IDEMPOTENT AND SAFE TO
-- EXPOSE. IT IS NOT. Read live before trusting it:
--
--   insert into public.ledgers (company_id, group_id, name, ...)
--   values (p_company_id, v_group, v_label || v_suffix, 'credit')
--   returning id into v_ledger;
--
-- No ON CONFLICT, no guard, no existence check — and
-- ledgers_company_name_idx is UNIQUE on (company_id, lower(name)). A second
-- call dies on a duplicate key at the first purpose ('Output CGST (27)') and
-- seeds nothing. Contrast app_private.seed_tcs_ledger, which opens with an
-- explicit `if exists (...) then return; end if;` precisely because "a TAN
-- can be edited more than once" — the GST seeder never got that guard
-- because, until now, nothing could call it twice.
--
-- So exposing it directly would have shipped a Repair button that throws a
-- duplicate-key error on every company whose map is merely incomplete rather
-- than empty — the exact population it is for. This migration adds a new
-- idempotent function instead and leaves seed_gst_ledgers untouched on its
-- one existing create-a-registration path.
--
-- public.repair_gst_ledger_map(company, registration):
--   * Admin-gated. SECURITY INVOKER, so RLS decides the write as well:
--     tax_ledger_map_write is already is_company_admin and ledgers_write is
--     can_write_company, so an admin passes both. Explicit check first for a
--     plain-English refusal rather than a row-level-security violation —
--     same discipline as update_branch (1320).
--   * Walks seed_gst_ledgers' own 11 purposes, with its own labels, its own
--     ' (SS)' state suffix, its own UTGST substitution off
--     ref_states.intra_state_component, and its own opening_balance_type
--     'credit' (yes, including the input/receivable purposes — copied
--     deliberately so a repaired ledger is indistinguishable from a seeded
--     one; changing that convention is not this migration's business).
--   * NEVER re-points a purpose that already resolves. Moving a mapped
--     purpose to a different ledger would strand posted output tax on the
--     old one. An already-mapped purpose is reported and skipped, which is
--     what makes this safe to press twice.
--   * Where the map row is missing but a ledger of the name seeding would
--     have used is already there, it adopts that ledger rather than trying
--     to create a second one — that is the case seed_gst_ledgers chokes on.
--   * Registration-scoped rows only, because app_private.tax_ledger resolves
--     with `gst_registration_id is not distinct from p_registration_id` —
--     a company-scoped row would not satisfy a registration-scoped lookup.
--     The company-scoped purposes (output_tcs, tds_payable, tds_receivable)
--     have their own seeders and are out of scope here.
--   * Returns a row per purpose saying what it did, so the screen can show
--     "already mapped" for 11 of 11 on a healthy registration instead of
--     claiming to have fixed something.
--
-- ---------------------------------------------------------------------------
-- PART D. Point the two live messages at it
-- ---------------------------------------------------------------------------
-- Of the 21 SQL sites, only TWO are live: public.create_invoice and
-- public.update_invoice carry the string twice each (the per-component GST
-- raise and the RCM Payable raise). Every other site is a superseded
-- create-or-replace in an older migration file — historical text that no
-- longer defines anything and that a user can never reach. Confirmed by
-- scanning pg_get_functiondef across public and app_private for the string:
-- exactly those two functions, four occurrences.
--
-- Patched the way 1460 patched these same two functions: a targeted
-- replace() on the live definition with an asserted hit count and a
-- re-run guard, NOT a retype. Retyping create_invoice from a migration file
-- would silently revert 1460's own in-place GST-window guard, which lives
-- only in the live body.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- A + B. The two descriptions
-- ----------------------------------------------------------------------------
update public.ref_modules
   set description = 'Form 3CA/3CB and 3CD working papers. On for every company in compliance mode — this switch opens the papers, it is not a finding that Sec 44AB applies to you. LEKHA holds no turnover figure on the company record; the threshold test runs on your posted books under Reports → Tax audit.'
 where code = 'tax_audit';

update public.ref_modules
   set description = 'On for every company in compliance mode — no headcount is checked anywhere, and taking on employees never switches this on or off. PF binds at 20 persons, ESI at 10 where the State has notified the area, and professional tax has no headcount test at all; enter the codes you actually hold under Employer registrations.'
 where code = 'payroll_statutory';

do $mig$
begin
  if not exists (
    select 1 from public.ref_modules
     where code = 'tax_audit'
       and description like 'Form 3CA/3CB and 3CD working papers.%'
       and description not like '%44AB threshold%'
  ) then
    raise exception '1550: ref_modules.description for tax_audit was not updated. The row is missing or its code has changed.';
  end if;

  if not exists (
    select 1 from public.ref_modules
     where code = 'payroll_statutory'
       and description like 'On for every company in compliance mode%'
       and description not like '%headcount thresholds%'
  ) then
    raise exception '1550: ref_modules.description for payroll_statutory was not updated. The row is missing or its code has changed.';
  end if;
end;
$mig$;


-- ----------------------------------------------------------------------------
-- A + B (continued). The frozen copies in company_modules.locked_reason
-- ----------------------------------------------------------------------------
-- Settings → Modules prints locked_reason under the description for every
-- conditional module (ModuleManager.tsx), so leaving these behind would keep
-- showing the old sentence next to the new one. Matched on the exact old
-- text so a manually-set reason, or one already corrected, is left alone.
-- 'tcs' is included because 1290 corrected its description and left 11 rows
-- still advertising 1H in locked_reason.
update public.company_modules cm
   set locked_reason = 'Activated automatically: ' || r.description
  from public.ref_modules r
 where r.code = cm.module_code
   and cm.locked_reason in (
     'Activated automatically: Activates on crossing the 44AB threshold',
     'Activated automatically: Activates past the headcount thresholds',
     'Activated automatically: 206C, including 1H and the 194Q precedence rule'
   );

do $mig$
declare
  v_stale integer;
begin
  select count(*) into v_stale
    from public.company_modules
   where locked_reason in (
     'Activated automatically: Activates on crossing the 44AB threshold',
     'Activated automatically: Activates past the headcount thresholds',
     'Activated automatically: 206C, including 1H and the 194Q precedence rule'
   );

  if v_stale > 0 then
    raise exception '1550: % company_modules rows still carry a corrected description''s old text.', v_stale;
  end if;
end;
$mig$;


-- ----------------------------------------------------------------------------
-- C. The idempotent repair
-- ----------------------------------------------------------------------------
create or replace function public.repair_gst_ledger_map(
  p_company_id uuid,
  p_registration_id uuid
) returns table (tax_purpose text, ledger_name text, action text)
language plpgsql
security invoker   -- RLS decides the write too; only an admin may map a purpose
set search_path = ''
as $$
declare
  v_state char(2);
  v_intra text;
  v_group uuid;
  v_suffix text;
  v_p text;
  v_label text;
  v_mapped uuid;
  v_existing uuid;
  v_ledger uuid;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can repair this company''s tax-ledger map';
  end if;

  select g.state_code into v_state
    from public.gst_registrations g
   where g.id = p_registration_id
     and g.company_id = p_company_id;

  if v_state is null then
    raise exception 'That GST registration does not belong to this company';
  end if;

  select s.intra_state_component into v_intra
    from public.ref_states s
   where s.code = v_state;

  select ag.id into v_group
    from public.account_groups ag
   where ag.company_id = p_company_id
     and ag.ledger_role = 'duty_tax'
   order by ag.sort_order
   limit 1;

  if v_group is null then
    raise exception
      'This company has no Duties & Taxes group, so a tax ledger cannot be created under one. Its chart of accounts was never seeded, which is a different and larger repair than this.';
  end if;

  v_suffix := ' (' || v_state || ')';

  foreach v_p in array array[
    'output_cgst','output_sgst','output_igst','output_cess',
    'input_cgst','input_sgst','input_igst','input_cess',
    'rcm_payable','gst_payable','gst_refund_receivable'
  ] loop
    -- Labels, UTGST substitution and suffix identical to
    -- app_private.seed_gst_ledgers, so a repaired ledger is
    -- indistinguishable from a seeded one.
    v_label := case v_p
      when 'output_cgst' then 'Output CGST'
      when 'output_sgst' then case when v_intra = 'utgst' then 'Output UTGST' else 'Output SGST' end
      when 'output_igst' then 'Output IGST'
      when 'output_cess' then 'Output Cess'
      when 'input_cgst'  then 'Input CGST'
      when 'input_sgst'  then case when v_intra = 'utgst' then 'Input UTGST' else 'Input SGST' end
      when 'input_igst'  then 'Input IGST'
      when 'input_cess'  then 'Input Cess'
      when 'rcm_payable' then 'RCM Payable'
      when 'gst_payable' then 'GST Payable'
      else 'GST Refund Receivable'
    end;

    v_mapped := null;
    v_existing := null;

    select t.ledger_id into v_mapped
      from public.tax_ledger_map t
     where t.company_id = p_company_id
       and t.gst_registration_id = p_registration_id
       and t.purpose = v_p;

    -- Already resolves. Leave it exactly where it is: re-pointing a mapped
    -- purpose would strand tax already posted to the old ledger.
    if v_mapped is not null then
      return query
        select v_p,
               (select l.name from public.ledgers l where l.id = v_mapped),
               'already mapped'::text;
      continue;
    end if;

    -- Unmapped. Adopt the ledger seeding would have used if it is already
    -- there — this is the exact case seed_gst_ledgers dies on.
    select l.id into v_existing
      from public.ledgers l
     where l.company_id = p_company_id
       and lower(l.name) = lower(v_label || v_suffix);

    if v_existing is not null then
      v_ledger := v_existing;
    else
      insert into public.ledgers (company_id, group_id, name, opening_balance_type)
      values (p_company_id, v_group, v_label || v_suffix, 'credit')
      returning id into v_ledger;
    end if;

    insert into public.tax_ledger_map (company_id, gst_registration_id, purpose, ledger_id)
    values (p_company_id, p_registration_id, v_p, v_ledger);

    return query
      select v_p,
             v_label || v_suffix,
             case when v_existing is not null
                  then 'existing ledger mapped'
                  else 'ledger created and mapped'
             end::text;
  end loop;
end;
$$;

revoke all on function public.repair_gst_ledger_map(uuid, uuid) from public, anon;
grant execute on function public.repair_gst_ledger_map(uuid, uuid) to authenticated;

comment on function public.repair_gst_ledger_map(uuid, uuid) is
  'Fills in whichever of app_private.seed_gst_ledgers'' 11 registration-scoped tax purposes are missing from tax_ledger_map, creating a ledger under Duties & Taxes only where one of the expected name is not already there. Idempotent by construction — an already-mapped purpose is reported and skipped, never re-pointed — which app_private.seed_gst_ledgers itself is NOT (its unguarded insert dies on ledgers_company_name_idx on a second call). Admin-gated; SECURITY INVOKER, so tax_ledger_map_write decides the write as well. This is the action the ''Seed the GST ledgers for it first'' errors used to name without providing. See 1550.';


-- ----------------------------------------------------------------------------
-- D. Point create_invoice and update_invoice at it
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_fn text;
  v_def text;
  v_new text;
  v_hits int;
  v_gst_old constant text :=
    'raise exception ''No % ledger configured for this registration. Seed the GST ledgers for it first.'', v_tax_prefix;';
  v_gst_new constant text :=
    'raise exception ''No % GST ledger is mapped for this registration, so there is nowhere to post the tax to. Open Registrations → Tax ledgers and press Repair for this GSTIN.'', v_tax_prefix;';
  v_rcm_old constant text :=
    'raise exception ''No RCM Payable ledger configured for this registration. Seed the GST ledgers for it first.'';';
  v_rcm_new constant text :=
    'raise exception ''No RCM Payable ledger is mapped for this registration, so the reverse-charge liability has nowhere to post. Open Registrations → Tax ledgers and press Repair for this GSTIN.'';';
begin
  foreach v_fn in array array['create_invoice', 'update_invoice'] loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_fn
       and p.prokind = 'f'
     limit 1;

    if v_def is null then
      raise exception '1550: public.% is missing.', v_fn;
    end if;

    -- Already patched: a re-run must be a no-op, not a second edit. This file
    -- rewrites live definitions, so it has to be safe to apply twice.
    if position('Open Registrations → Tax ledgers' in v_def) > 0 then
      raise notice '1550: % already points at the repair screen, skipping.', v_fn;
      continue;
    end if;

    v_hits := (length(v_def) - length(replace(v_def, v_gst_old, ''))) / length(v_gst_old);
    if v_hits <> 1 then
      raise exception
        '1550: expected exactly one GST tax-ledger raise in %, found %. Its body has moved; fix by hand.',
        v_fn, v_hits;
    end if;

    v_hits := (length(v_def) - length(replace(v_def, v_rcm_old, ''))) / length(v_rcm_old);
    if v_hits <> 1 then
      raise exception
        '1550: expected exactly one RCM Payable raise in %, found %. Its body has moved; fix by hand.',
        v_fn, v_hits;
    end if;

    -- 1460's in-place GST-window guard lives only in the live body. If it is
    -- not here, this definition is not the one that is actually deployed and
    -- replacing it would revert that fix.
    if position('1460. GST off for this DATE' in v_def) = 0 then
      raise exception
        '1550: %''s live body is missing 1460''s GST-window guard — refusing to rewrite a definition that is not the deployed one. Fix by hand.',
        v_fn;
    end if;

    v_new := replace(v_def, v_gst_old, v_gst_new);
    v_new := replace(v_new, v_rcm_old, v_rcm_new);
    execute v_new;
  end loop;
end;
$mig$;

do $mig$
declare
  v_left integer;
begin
  select count(*) into v_left
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.prokind = 'f'
     and n.nspname in ('public', 'app_private')
     and pg_get_functiondef(p.oid) like '%Seed the GST ledgers for it first%';

  if v_left > 0 then
    raise exception
      '1550: % live function(s) still tell the user to seed the GST ledgers.', v_left;
  end if;
end;
$mig$;

notify pgrst, 'reload schema';
