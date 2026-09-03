-- ============================================================================
-- 1421 — GSTR-2B: the month GST becomes effective is importable
-- ============================================================================
-- WHY. The pilot company switched GST on with effect from 31 August 2026 and
-- booked two purchases that same day (HO/PUR/2026-27/00001 and 00005, ₹17,080
-- of input tax between them). The August 2026 GSTR-2B match report duly showed
-- both as "booked here, not in 2B — ITC at risk" and offered the only remedy:
-- upload the August 2B. Doing so failed outright with
--
--     GST is not an active module for this company for that period
--
-- and there was no way round it. The month the company's GST life begins is
-- exactly the month it most needs to reconcile, and it was the one month that
-- could not be reconciled at all.
--
-- THE CAUSE. import_gstr2b_lines gated the import on
--
--     app_private.module_active(p_company_id, 'gst', (p_return_period || '-01')::date)
--
-- i.e. "was GST on on the FIRST of the month?". A return period is a whole
-- calendar month, and a module that starts on the 31st is on for that month —
-- just not on its first day. Any mid-month start (this company: 31 Aug;
-- "Indian Onliners" in the same database: 20 Aug) loses its first month.
--
-- IS THE REFUSAL CORRECT? No, and the statutory shape says so. Rule 60(7) of
-- the CGST Rules, 2017 provides that the auto-drafted FORM GSTR-2B is made
-- available to a registered person "for every month"; it is generated for the
-- tax period on the 14th of the following month (GSTN advisory on GSTR-2B,
-- and the FORM's own "[See rule 60(7)]" heading). It is not conditioned on the
-- taxpayer having been registered on the first day of that month — a person
-- registered part-way through August has an August 2B, available from 14
-- September. A second, sceptical pass found nothing in Rule 60, Sec 38 (as
-- substituted by Notification 16/2025-Central Tax) or the GSTN advisory that
-- withholds the 2B for the month of registration; what could NOT be confirmed
-- from an official source is the exact GSTN behaviour for a registration
-- granted on the last day of a month, so this migration deliberately does not
-- assume that month is empty — it just stops refusing to hold it.
--
-- Keeping the gate at all is still right: a 2B for a period entirely before
-- GST existed for this company has nothing here to reconcile against, and
-- accepting it would put ITC lines against months the app has no GST life for.
-- So the test becomes "was GST on for ANY day of this return period?" rather
-- than "on the 1st", evaluated through app_private.module_active itself (the
-- canonical predicate — it carries the core-tier short-circuit and the
-- `licensed` flag) once per day of the month, rather than re-deriving module
-- semantics here. Thirty-one calls to a STABLE, index-backed function, once a
-- month, on a manual import.
--
-- AND THE MESSAGE NOW EXPLAINS ITSELF. When the refusal IS correct, the old
-- text named neither the period nor the date GST actually starts, so there was
-- no way to tell a wrong month from a wrong setting. It now says both. The
-- exception text reaches the user verbatim — components/csv/Gstr2bImport.tsx
-- puts the RPC error straight into a toast — so no client change is needed.
-- ============================================================================

do $mig$
declare
  v_def text;
  v_hits int;
  v_target constant text := $t$  if not app_private.module_active(p_company_id, 'gst', (p_return_period || '-01')::date) then
    raise exception 'GST is not an active module for this company for that period';
  end if;
$t$;
  v_replacement constant text := $r$  -- A return period is a whole calendar month. GST being on for ANY day of it
  -- is enough for that month's GSTR-2B to belong here — a registration that
  -- starts on the 31st still has that month's 2B (Rule 60(7)). See 1421.
  if not exists (
    select 1
      from pg_catalog.generate_series(
             (p_return_period || '-01')::date,
             ((p_return_period || '-01')::date + interval '1 month' - interval '1 day')::date,
             interval '1 day') as g(d)
     where app_private.module_active(p_company_id, 'gst', g.d::date)
  ) then
    raise exception 'GST was not on for this company on any day of %, so a GSTR-2B for that period has nothing here to reconcile against. %',
      to_char((p_return_period || '-01')::date, 'FMMonth YYYY'),
      coalesce(
        (select 'GST runs from ' || to_char(min(m.effective_from), 'DD Mon YYYY')
                || ', so ' || to_char(min(m.effective_from), 'FMMonth YYYY')
                || ' is the earliest period that can be imported. If the registration is genuinely older, correct the GST start date under Modules first.'
           from public.company_modules m
          where m.company_id = p_company_id
            and m.module_code = 'gst'
            and m.licensed),
        'GST has never been switched on for this company — switch it on under Modules first.');
  end if;
$r$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'import_gstr2b_lines' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1421: import_gstr2b_lines is missing.';
  end if;

  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);

  if v_hits <> 1 then
    raise exception
      '1421: expected exactly one first-of-month GST module gate in import_gstr2b_lines, found %. Its body has moved; fix by hand.',
      v_hits;
  end if;

  execute replace(v_def, v_target, v_replacement);
end;
$mig$;

-- CREATE OR REPLACE keeps existing grants, but they are restated so this file
-- is self-contained and anon can never inherit EXECUTE through PUBLIC.
revoke all on function public.import_gstr2b_lines(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.import_gstr2b_lines(uuid, uuid, text, jsonb) to authenticated;

comment on function public.import_gstr2b_lines(uuid, uuid, text, jsonb) is
  'Whole-period replace of one GST registration''s uploaded GSTR-2B lines: deletes any existing rows for (company, registration, return_period) then inserts p_lines. Pass an empty array to clear a period. Accepts any return period for which GST was an active module on at least one day of that calendar month — not merely on the 1st — so the month GST starts mid-month is importable (1421); a period entirely before GST began is still refused, now with a message naming the period and the date GST actually runs from. Client-side validation (lib/csv/gstr2b-import.ts) does GSTIN/date/amount checks before calling this — this function trusts well-formed input and lets a genuinely malformed row raise, aborting the whole import rather than importing a corrupt statement partially.';
