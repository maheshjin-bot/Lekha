-- ============================================================================
-- 1360 — CIN, IEC and PAN: guarding the three identifiers no screen could write
-- ============================================================================
-- public.companies has carried cin, iec and pan since 0003. Until today no
-- code path anywhere could write any of the three:
--
--   * create_company (0014) takes no p_cin and no p_iec.
--   * `grep "update public.companies"` across every migration returns exactly
--     two columns — lock_date (0020) and password_hash (0044). There is no
--     update_company RPC.
--   * components/companies/CompanySettingsForm.tsx had six .update() calls,
--     covering tan, the udyam pair, company_tax_regime, is_professional, the
--     CMA margins and upi_vpa — and rendered PAN as static text under a
--     subtitle that said editing it "isn't supported here yet".
--
-- Each of the three hard-blocks something real:
--
--   cin  Aoc4XbrlPanel.tsx refuses both instance documents outright without
--        it ('No CIN on file for this company — set it under Company Settings
--        first'), because the CIN *is* the XBRL entity identifier
--        (lib/xbrl/aoc4.ts contextXml). AOC-4 XBRL was therefore unreachable
--        for every company. The two seeded companies that do have a CIN got it
--        by hand-written SQL on 26 Aug 2026, not through the app.
--   iec  Both the 'exim' and 'foreign_currency' modules are tier='conditional'
--        with activates_when '{"has_iec":true}' (0004). set_module refuses a
--        conditional module and tells the user to 'change the underlying
--        detail instead' — a detail no screen could change. The resolver
--        trigger already listens for `update of ... iec`, so a UI was always
--        the intended way in.
--   pan  A typo'd PAN blocks the ITR and every TDS return, and
--        settings/employer-registrations tells users 'PAN, TAN and the tax
--        regime are under Settings'.
--
-- The form itself is the fix; this migration is only what the form needs the
-- database to guarantee.
--
-- GRANTS — DELIBERATELY NOT TOUCHED. Verified live before writing this:
-- has_column_privilege('authenticated','public.companies',<col>,'SELECT'/
-- 'UPDATE') is already true for all three, from 0044's explicit re-grant, and
-- companies_update RLS (0003) already restricts writes to
-- app_private.is_company_admin. tests/db/invariants.test.ts' companies
-- column-grant allowlist test covers every column generically and needs no
-- change either — this is the one time the recurring "add column, forget the
-- allowlist" bug (0085 -> 0111/0112 -> 0140/0141) does not apply, because
-- these columns are older than the allowlist.
--
-- ----------------------------------------------------------------------------
-- 1. CIN gets the format validator every other identifier already had
-- ----------------------------------------------------------------------------
-- pan, tan, iec, udyam_number and print_bank_ifsc all sit behind an
-- app_private validator in a CHECK constraint. cin was the lone exception:
-- `cin text`, no constraint at all. A mistyped CIN is not a harmless typo —
-- it becomes the xbrli:identifier of the instance document, which MCA's
-- Validation Tool rejects, after the user has already paid for a licensed
-- XBRL tool to re-tag it.
--
-- The 21-character MCA structure, and exactly how much of it is safe to
-- enforce:
--   1      L or U        — listing status. Firm: MCA issues no other value.
--   2-6    5 digits      — NIC industry/activity code. Always numeric.
--   7-8    2 letters     — the ROC's state (MH, DL, KA…). NOT ref_states,
--                           whose `code` is the 2-DIGIT GST state code, so
--                           these are deliberately not foreign-keyed.
--   9-12   4 digits      — year of incorporation. Any year; not range-checked,
--                           because a legitimately old company predates any
--                           bound worth guessing.
--   13-15  3 letters     — company class (PLC, PTC, OPC, FTC, GOI, NPL, SGC,
--                           ULL, ULT, GAP, GAT…). Deliberately NOT enumerated:
--                           the list is long, MCA extends it, and a stale
--                           allowlist here would reject a real CIN.
--   16-21  6 digits      — registration number.
--
-- Nothing beyond shape is enforced. In particular the class code is not
-- cross-checked against entity_type (an OPC's CIN carries OPC, but so does a
-- pvt_ltd that converted from one) and the first character is not
-- cross-checked against anything, because this app does not track listing
-- status. If a legitimate CIN ever turns up outside this shape, THIS
-- CONSTRAINT is what must change — and the user will know, because the form
-- spells the whole structure out rather than surfacing a constraint name.
--
-- Both live CIN values pass: L74999MH2010PLC205678, U72900MH2019PTC330045.
--
-- The constraint is format-only and table-wide, while the form shows the CIN
-- field only for opc/pvt_ltd/ltd. That is not a contradiction: an LLP has an
-- LLPIN (format AAB-1234), not a CIN, and this column is the wrong home for
-- one. No llpin column exists anywhere in the schema — a named, deliberate
-- gap, not something to launder into `cin` by loosening this regex.
-- ----------------------------------------------------------------------------

create or replace function app_private.is_valid_cin(p_cin text)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_cin is null or p_cin ~ '^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$';
$$;

comment on function app_private.is_valid_cin(text) is
  'Corporate Identity Number shape: L/U, 5-digit NIC code, 2-letter ROC state, 4-digit incorporation year, 3-letter company class, 6-digit registration number. Null-tolerant like every other validator in 0001, so it can sit in a CHECK constraint without forcing NOT NULL. Shape only — see migration 1360 for what is deliberately not enforced.';

alter table public.companies
  add constraint companies_cin_check check (app_private.is_valid_cin(cin));

-- ----------------------------------------------------------------------------
-- 2. A PAN change can no longer contradict a GST registration
-- ----------------------------------------------------------------------------
-- app_private.enforce_gstin_state (0005) already refuses a gst_registrations
-- row whose GSTIN embeds a PAN other than the company's — 'GSTIN % embeds PAN
-- %, which is not this company's PAN'. But that trigger is on
-- gst_registrations, `before insert or update of gstin, company_id`. It has
-- never had anything to say about the other direction, because until today
-- nothing could move companies.pan. Making PAN editable opens exactly that
-- hole: set the PAN, add the matching GSTIN, then change the PAN, and the
-- company now claims a registration belonging to a different legal entity —
-- with every GSTR-1/3B, e-invoice and e-way-bill payload built from it.
--
-- Guard the second direction with the same rule, in the same words. Fires
-- only when pan actually changes to a non-null value:
--   * new.pan null              — clearing cannot contradict anything, since
--                                 enforce_gstin_state only compares when the
--                                 company's PAN is not null. (Clearing is
--                                 still refused in compliance mode by
--                                 companies_compliance_requires_pan, 0003.)
--   * null -> value             — DOES need checking. A company with a null
--                                 PAN could accept any GSTIN, so filling the
--                                 PAN in afterwards can contradict one.
--   * unchanged                 — nothing to check; every unrelated UPDATE on
--                                 companies (upi_vpa, lock_date, the CMA
--                                 margins…) passes straight through.
--
-- ON DELETE CASCADE is unaffected: this is a BEFORE UPDATE trigger on
-- companies itself, so `new` is by definition a live company row, and
-- delete_company (0014) issues no UPDATE on companies at all — it deletes
-- vouchers, items, godowns, ledgers, then the company. Nothing here can block
-- a cascade.
-- ----------------------------------------------------------------------------

create or replace function app_private.enforce_company_pan_matches_registrations()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_conflicts text;
begin
  if new.pan is null or new.pan is not distinct from old.pan then
    return new;
  end if;

  select string_agg(g.gstin, ', ' order by g.gstin)
    into v_conflicts
    from public.gst_registrations g
   where g.company_id = new.id
     and app_private.gstin_pan(g.gstin) is distinct from new.pan;

  if v_conflicts is not null then
    raise exception
      'GST registration % is already on file for this company, and a GSTIN carries its holder''s PAN inside it. Changing the company PAN to % would leave the two contradicting each other — correct or remove that registration first.',
      v_conflicts, new.pan;
  end if;

  return new;
end;
$$;

comment on function app_private.enforce_company_pan_matches_registrations() is
  'The companies-side half of app_private.enforce_gstin_state (0005): refuses a companies.pan change that would contradict a GSTIN already registered to the company. Added with 1360, when PAN first became editable from the UI.';

create trigger enforce_company_pan_matches_registrations
  before update of pan on public.companies
  for each row execute function app_private.enforce_company_pan_matches_registrations();

-- ----------------------------------------------------------------------------
-- 3. Say what each column is for, where a reader will actually look
-- ----------------------------------------------------------------------------

comment on column public.companies.cin is
  'MCA Corporate Identity Number, 21 characters. Shape-checked by companies_cin_check (1360). Consumed as the xbrli:identifier of both AOC-4 XBRL instance documents (lib/xbrl/aoc4.ts) — no CIN means no AOC-4 XBRL at all. Only opc/pvt_ltd/ltd have one; an LLP''s LLPIN does not belong here.';

comment on column public.companies.iec is
  'DGFT Importer-Exporter Code. Identical to the holder''s PAN since the 2017 harmonisation, hence the PAN shape in app_private.is_valid_iec. This is the fact that activates the ''exim'' and ''foreign_currency'' conditional modules (0004) — the resolver trigger fires on update of iec.';

comment on column public.companies.pan is
  'The company''s own PAN. Required in compliance mode (companies_compliance_requires_pan). Editable from Company Settings since 1360, but a change that would contradict an existing GST registration is refused by app_private.enforce_company_pan_matches_registrations — a GSTIN embeds its holder''s PAN.';
