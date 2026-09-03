-- ============================================================================
-- 1460 — A backdated invoice carried NO GST, silently, because the GST module
--        started on the day somebody created the company record
-- ============================================================================
-- REPRODUCED LIVE against the pilot company TEST Rangoli Spice Works Pvt Ltd
-- (8e161d8e-cd2e-4c60-96a4-bad69c42b573) before writing a line of this file.
-- Two calls to create_invoice, identical in every argument except the date —
-- same customer (TEST Kanha Retail Stores, Maharashtra, regular), same item
-- (Turmeric Powder 500g, 5% GST), 100 x 200 = 20,000 taxable:
--
--   voucher_date 2026-05-15  ->  Debtor Dr 20,000.00  Sales Cr 20,000.00
--                                supply_type NULL, no tax lines at all
--   voucher_date 2026-09-15  ->  Debtor Dr 21,000.00  Sales Cr 20,000.00
--                                Output CGST Cr 500.00  Output SGST Cr 500.00
--                                supply_type 'intra'
--
-- 1,000 rupees of output tax disappears from a document that is in every
-- other respect the same invoice, and NOTHING is said about it. The invoice
-- prints without tax, GSTR-1 picks it up as a nil-rated supply, and the
-- return is filed short. That silence is the defect.
--
-- ROOT CAUSE. create_invoice (and update_invoice) gate the whole GST block on
--   v_gst_on := app_private.module_active(company, 'gst', p_voucher_date)
-- which is right — a voucher must be judged against the module state that
-- applied WHEN IT HAPPENED, not today. The bug is one step further back, in
-- app_private.resolve_conditional_modules, which is what actually creates the
-- company_modules row for a conditional module such as GST:
--
--   insert into public.company_modules (... effective_from ...)
--   values (p_company_id, v_module.code, current_date, ...)
--
-- current_date is the day the resolver happened to run — i.e. the day the
-- company was created, or the day a GSTIN was added. It has nothing to do
-- with when the company was actually liable to charge GST. The pilot company
-- shows the mismatch plainly:
--
--   companies.book_beginning_date            2026-04-01
--   gst_registrations.registered_from        2026-04-01   (27AABCR1234K1ZH)
--   company_modules.effective_from ('gst')   2026-08-31   <-- the signup day
--
-- The app already KNEW, from the user's own GST registration record, that
-- this company was registered from 1 April. It charged nothing on anything
-- dated before 31 August anyway. Eight companies in this database carry the
-- same gap across 38 conditional-module rows between them (gst, tds, tcs,
-- income_tax, schedule_iii, roc, msme, fixed_assets ...), every one of them
-- dated at its signup day rather than at its books.
--
-- The UI cannot rescue this either: set_module refuses conditional modules
-- outright ('governed by this company''s registrations and entity type, not
-- by a setting'), so there is no screen anywhere that can move the date back.
--
-- STATUTORY BASIS for what the date should be. Sec 31(1) CGST Act 2017: a
-- registered person supplying taxable goods shall issue a tax invoice showing
-- the tax charged thereon; Rule 46(m)-(o) CGST Rules require the rate and the
-- amount of tax on the face of it. Sec 32(1) is the mirror: a person who is
-- NOT registered shall not collect any tax. So the one fact that decides
-- whether an invoice carries GST is whether a registration was in force ON
-- THE DATE OF SUPPLY — gst_registrations.registered_from/registered_to —
-- never when the software record was typed in. This migration makes the
-- module window follow that fact.
--
-- WHAT THIS MIGRATION DOES — three parts, in order of how much they matter:
--
-- 1. app_private.module_activation_date(company, module_code): the date a
--    conditional module should START, computed from the company's own data
--    instead of from the clock:
--      base     = coalesce(companies.book_beginning_date, current_date)
--      evidence = for a rule keyed on has_gstin, the earliest registered_from
--                 among the company's own active non-ISD registrations;
--                 for gstin_count_min N, the N-th earliest of them (the date
--                 from which N registrations existed) — mirroring exactly
--                 what app_private.company_gstin_count already counts;
--                 for every other conditional rule (has_tan, has_iec,
--                 compliance_mode, entity_type, statement_format,
--                 roc_applicable, remuneration_section) there is no dated
--                 evidence anywhere in the schema, so none is invented
--      result   = least(greatest(base, evidence), current_date)
--    greatest() so a module never claims to predate the company's own books
--    or its registration; least(current_date) only bites for a company whose
--    books begin in the future, where starting the module today rather than
--    at a future date keeps resolve_conditional_modules' own undated
--    dependency checks converging.
--
-- 2. resolve_conditional_modules uses it in place of current_date on INSERT.
--    A targeted replace of that one literal on the live definition, asserted,
--    NOT a retype — the UPDATE branch's own `greatest(effective_from,
--    current_date - 1)` deliberately keeps current_date, because standing a
--    module DOWN is a decision taken today, not retroactively.
--
-- 3. A one-off backfill of existing conditional rows to the same rule, for
--    the companies already carrying signup-dated modules. It only ever moves
--    a start date EARLIER (final predicate), and never earlier than the end
--    of a preceding closed period for the same module, so it cannot trip
--    company_modules_no_overlap. (No closed conditional row exists anywhere
--    today — checked — but the guard costs nothing and the rule has to hold
--    against whatever exists when this is actually applied.)
--
-- AND THE SILENT PART, which is the real complaint. Parts 1-3 stop the
-- pilot's case happening at all, but they cannot make it impossible: a
-- company_modules row can still be closed, or created by some future path
-- that does not go through the resolver. So create_invoice and update_invoice
-- each get one guard, placed immediately after v_gst_on is computed:
--
--   if not v_gst_on and a GST registration WAS in force for this branch on
--   this voucher's own date -> raise, naming both dates.
--
-- Refuse rather than warn, and refuse narrowly. Narrowly, because the test is
-- not "GST is off" (a genuinely unregistered business must keep being able to
-- invoice with no tax, and does — branch_registration returns null for it, so
-- the guard never fires) but "the registration says registered, the module
-- says not" — a contradiction inside the company's own data, for which there
-- is no correct number to post. Refuse rather than warn, because there is no
-- warning channel: create_invoice returns a uuid, the caller navigates to the
-- new voucher, and a NOTICE would reach nobody. A silently nil-rated tax
-- invoice is worse than a save that failed with a sentence saying what to fix.
--
-- DELIBERATELY NOT DONE, both reported rather than fixed:
--  * TCS has the identical silent shape (v_tcs_on is module-gated the same
--    way) and parts 1-3 fix its substance, but it gets no guard: the only
--    evidence available is companies.tan, and a company may legitimately hold
--    a TAN with TCS stood down, so the same test would produce false
--    refusals.
--  * A voucher dated before the company's own book_beginning_date is still
--    accepted (the separately-tracked gap 1250's header names). Where such a
--    document falls inside a live GST registration, this migration's guard
--    now catches it and says so instead of zero-rating it — an improvement,
--    not a fix for the underlying gap.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. When should a conditional module have started?
-- ----------------------------------------------------------------------------
create or replace function app_private.module_activation_date(
  p_company_id uuid,
  p_module_code text
) returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base date;
  v_rule jsonb;
  v_evidence date;
  v_dependency date;
  v_n integer;
begin
  select coalesce(c.book_beginning_date, current_date)
    into v_base
    from public.companies c
   where c.id = p_company_id;

  -- No company row (deleted mid-flight): behave exactly as the code this
  -- replaces did, rather than returning null into a not-null column.
  if v_base is null then
    return current_date;
  end if;

  -- Never start before something this module depends on: a window in which a
  -- module was live while its own dependency was not could never have
  -- happened. Only an OPEN dependency row constrains anything; a core
  -- dependency has no row at all and is always on, so it never does.
  select max(d.dep_from) into v_dependency
    from (
      select (select min(m.effective_from)
                from public.company_modules m
               where m.company_id = p_company_id
                 and m.module_code = dep
                 and m.effective_to is null) as dep_from
        from unnest(
               coalesce((select r.depends_on from public.ref_modules r
                          where r.code = p_module_code), '{}'::text[])
             ) as dep
    ) d;

  v_base := greatest(v_base, coalesce(v_dependency, v_base));

  select r.activates_when into v_rule
    from public.ref_modules r
   where r.code = p_module_code;

  -- The only conditional rules with a date attached to them anywhere in this
  -- schema are the GSTIN ones. Everything else is a standing attribute of the
  -- company with no "from when" recorded, so the books are the honest answer.
  if v_rule ? 'has_gstin' then
    select min(g.registered_from)
      into v_evidence
      from public.gst_registrations g
     where g.company_id = p_company_id
       and g.is_active
       and g.registration_type <> 'isd';

  elsif v_rule ? 'gstin_count_min' then
    v_n := greatest(coalesce((v_rule->>'gstin_count_min')::integer, 1), 1);
    select g.registered_from
      into v_evidence
      from public.gst_registrations g
     where g.company_id = p_company_id
       and g.is_active
       and g.registration_type <> 'isd'
     order by g.registered_from
     offset v_n - 1
     limit 1;
  end if;

  return least(greatest(v_base, coalesce(v_evidence, v_base)), current_date);
end;
$$;

revoke all on function app_private.module_activation_date(uuid, text) from public, anon;
grant execute on function app_private.module_activation_date(uuid, text) to authenticated;

comment on function app_private.module_activation_date is
  'The date a conditional module should be treated as having started for this company: its books-beginning date, moved forward to the registration date where the activating rule is a GSTIN one (Sec 31(1)/Sec 32(1) CGST — whether tax is chargeable turns on registration on the date of supply), never later than today. Replaces the current_date the resolver used to stamp, which was simply the day somebody created the record. See 1460.';


-- ----------------------------------------------------------------------------
-- 2. Make the resolver use it, by rewriting the live definition in place.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_hits int;
  v_target constant text := E'          v_module.code,\n          current_date,';
  v_replacement constant text :=
    E'          v_module.code,\n          app_private.module_activation_date(p_company_id, v_module.code),';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'resolve_conditional_modules'
     and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1460: app_private.resolve_conditional_modules is missing.';
  end if;

  -- Already applied: leave it alone rather than failing the whole file. This
  -- migration rewrites live definitions, so re-running it must be a no-op,
  -- not a second edit on top of the first.
  if position('app_private.module_activation_date(p_company_id, v_module.code)' in v_def) > 0 then
    raise notice '1460: resolve_conditional_modules already patched, skipping.';
    return;
  end if;

  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);

  if v_hits <> 1 then
    raise exception
      '1460: expected exactly one current_date activation stamp in resolve_conditional_modules, found %. Its body has moved; fix by hand.',
      v_hits;
  end if;

  -- The stand-down branch must still be there and must still use
  -- current_date: switching a module OFF is a thing that happens today, and
  -- this migration must not have caught that literal by accident.
  if v_def !~ 'greatest\(effective_from, current_date - 1\)' then
    raise exception
      '1460: resolve_conditional_modules no longer stands a module down at current_date - 1; the replace above may have hit the wrong literal. Fix by hand.';
  end if;

  execute replace(v_def, v_target, v_replacement);
end;
$mig$;

revoke all on function app_private.resolve_conditional_modules(uuid) from public, anon;
grant execute on function app_private.resolve_conditional_modules(uuid) to authenticated;

comment on function app_private.resolve_conditional_modules is
  'Brings a company''s conditional modules into line with its profile. Activation is dated by app_private.module_activation_date — the books-beginning date, or the GST registration date where that is later — not the day the resolver happened to run, which used to leave a company unable to charge GST on anything dated before its own signup (1460). Standing a module DOWN still happens at current_date - 1: that is a decision taken today, not retroactively.';


-- ----------------------------------------------------------------------------
-- 3. Backfill the companies already carrying a signup-dated conditional module
-- ----------------------------------------------------------------------------
-- Looped to convergence for the same reason resolve_conditional_modules
-- loops: module_activation_date clamps a module to its dependencies' own
-- start dates, and in a single UPDATE a dependency that is itself moving back
-- in the same statement would still be read at its old, later date — leaving
-- the dependent stuck. income_tax -> fixed_assets and tax_audit ->
-- income_tax are exactly that shape in the seeded data. Each pass can only
-- move dates earlier, so this terminates.
do $mig$
declare
  v_rows integer;
  v_pass integer := 0;
begin
  loop
    v_pass := v_pass + 1;

    with want as (
      select
        cm.id,
        cm.effective_from,
        greatest(
          app_private.module_activation_date(cm.company_id, cm.module_code),
          coalesce(
            (select max(prev.effective_to) + 1
               from public.company_modules prev
              where prev.company_id = cm.company_id
                and prev.module_code = cm.module_code
                and prev.effective_to is not null
                and prev.effective_to < cm.effective_from),
            app_private.module_activation_date(cm.company_id, cm.module_code)
          )
        ) as new_from
      from public.company_modules cm
      join public.ref_modules r on r.code = cm.module_code
     where r.tier = 'conditional'
       and cm.effective_to is null
    )
    update public.company_modules cm
       set effective_from = w.new_from
      from want w
     where cm.id = w.id
       and w.new_from < w.effective_from;

    get diagnostics v_rows = row_count;
    exit when v_rows = 0 or v_pass >= 10;
  end loop;

  if v_rows > 0 then
    raise exception '1460: conditional-module backfill did not converge in 10 passes.';
  end if;
end;
$mig$;


-- ----------------------------------------------------------------------------
-- 4. The silent part: never zero-rate a document that a live registration
--    covers. One guard, mirrored into both invoice writers.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_fn text;
  v_company_var text;
  v_branch_var text;
  v_def text;
  v_target text;
  v_hits int;
begin
  foreach v_fn in array array['create_invoice', 'update_invoice'] loop
    -- create_invoice takes the company/branch as parameters; update_invoice
    -- reads them off the existing voucher into locals.
    if v_fn = 'create_invoice' then
      v_company_var := 'p_company_id';
      v_branch_var  := 'p_branch_id';
    else
      v_company_var := 'v_company_id';
      v_branch_var  := 'v_branch_id';
    end if;

    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn and p.prokind = 'f'
     limit 1;

    if v_def is null then
      raise exception '1460: public.% is missing.', v_fn;
    end if;

    -- Already carries the guard: skip. Without this a re-run would append a
    -- SECOND copy of the block (the anchor line it appends after survives the
    -- first edit), which is the one way this file could do real damage.
    if position('1460. GST off for this DATE' in v_def) > 0 then
      raise notice '1460: % already carries the guard, skipping.', v_fn;
      continue;
    end if;

    v_target := E'\n  v_gst_on := app_private.module_active('
                || v_company_var || E', ''gst'', p_voucher_date);\n';

    v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);

    if v_hits <> 1 then
      raise exception
        '1460: expected exactly one v_gst_on assignment in %, found %. Its body has moved; fix by hand.',
        v_fn, v_hits;
    end if;

    -- The guard only means anything if this function still asks
    -- branch_registration the same question further down.
    if v_def !~ 'app_private\.branch_registration\(' then
      raise exception
        '1460: % no longer resolves a branch registration; the guard below would be meaningless. Fix by hand.',
        v_fn;
    end if;

    execute replace(v_def, v_target, v_target ||
E'
  -- 1460. GST off for this DATE, while the company''s own registration says
  -- it was registered on that date, is a contradiction with no correct
  -- posting: charging tax would contradict every module-gated register, and
  -- posting zero files the return short (Sec 31(1) r/w Rule 46 — a
  -- registered person''s tax invoice must show the tax charged). This used
  -- to pass silently and zero-rate the document. A genuinely unregistered
  -- business is untouched: branch_registration returns null for it, so it
  -- keeps invoicing with no tax exactly as before.
  if not v_gst_on
     and app_private.branch_registration(' || v_branch_var || E', p_voucher_date) is not null then
    raise exception
      ''This document is dated %, and a GST registration for this branch was already in force on that date, but GST is only switched on for this company from %. Saving it would post it at NIL tax and carry that nil into the return. Fix the module''''s start date before entering documents dated earlier.'',
      to_char(p_voucher_date, ''DD Mon YYYY''),
      coalesce(
        (select to_char(min(m.effective_from), ''DD Mon YYYY'')
           from public.company_modules m
          where m.company_id = ' || v_company_var || E'
            and m.module_code = ''gst''),
        ''never - it is not switched on for this company at all'');
  end if;
');
  end loop;
end;
$mig$;

revoke all on function public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  character, character, numeric, text, text, uuid, text, date) from public, anon;
grant execute on function public.create_invoice(
  uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date,
  character, character, numeric, text, text, uuid, text, date) to authenticated, service_role;

revoke all on function public.update_invoice(
  uuid, date, uuid, uuid, uuid, jsonb, text, text, date, character, text, date)
  from public, anon;
grant execute on function public.update_invoice(
  uuid, date, uuid, uuid, uuid, jsonb, text, text, date, character, text, date)
  to authenticated, service_role;

comment on function public.create_invoice is
  'Item-level invoice writer (sales/purchase/credit note/debit note). GST, TCS and RCM are judged against the module state that applied on the VOUCHER''s own date, not today. Since 1460 it refuses, rather than silently zero-rating, a document dated inside a live GST registration but outside the GST module window — the two disagreeing is a data contradiction, not a business case.';

comment on function public.update_invoice is
  'Re-posts an existing item-level invoice in place, keeping voucher_items and voucher_entries in step (0055). Carries create_invoice''s 1460 guard too: an edit that moves an invoice''s date back before the GST module window, while a registration covered that date, is refused rather than silently stripped of its tax.';

notify pgrst, 'reload schema';
