-- ============================================================================
-- 1740 — Sec 51/52 GST TDS/TCS suffered had no ledger to land in
-- ============================================================================
-- CONFIRMED INDEPENDENTLY, reproduced live before writing a line of this
-- migration, on the real pilot company TEST Vantage Consulting Services Pvt
-- Ltd (9e4071b8-dfec-4d4c-86f6-bb9fab84e600), GST registration 361b8658-...
-- (GSTIN 29AABCV1234C1ZQ, Karnataka):
--
--   Sale HOSAL26/0004, 28-Apr-2026, to Rashtriya Digital Infrastructure
--   Corporation Limited (party_type 'government', GSTIN 27... Maharashtra —
--   an inter-state supply): Dr RDIC 3,54,000.
--
--   Receipt HOREC26/0003, 18-May-2026, against that invoice: Dr Bank
--   3,18,000, Dr TDS Receivable 30,000 (Sec 194J income-tax TDS — that ledger
--   already existed, see 1700), Cr RDIC 3,48,000. Narration, verbatim:
--   "net of 194J income-tax TDS (30,000) and Sec 51 GST TDS (6,000, no
--   ledger available - see narration)".
--
--   RDIC's ledger balance today: Dr 3,54,000 − Cr 3,48,000 = a permanent
--   Dr 6,000 that will age into the 90+ bucket and sit there forever,
--   indistinguishable in every ageing/outstanding report from a genuinely
--   unpaid balance. RDIC has fully discharged its legal obligation (Sec
--   51(1) CGST Act, 2% of the ex-GST contract value: 2% of Rs 3,00,000 =
--   Rs 6,000 — the sale's own tax breakdown confirms 3,54,000 = 3,00,000 +
--   18% GST, and 27.../29... crossing a state line makes the deduction IGST,
--   matching the IGST-only gst_tds_tcs_suffered row created for exactly this
--   event: company 9e4071b8-..., registration 361b8658-..., period 2026-05,
--   igst_amount 6,000, claimed_in_gstr3b false). This money is never coming
--   from RDIC a second time; the books just have nowhere to put the credit.
--
-- WHY THIS EXISTS: get_gstr3b_table6_1 already documents the gap in its own
-- v_note ("Sec 51/52 GST TDS/TCS credit is not modelled and reads 0") and
-- 0180 (gst_tds_tcs_suffered) is explicit that it is a compliance TRACKER
-- only — "NO LEDGER POSTING... The actual cash-ledger credit happens on the
-- GST PORTAL, not in this company's books" — and flags a receivable ledger
-- as new scope, not built there. This migration is that scope.
--
-- THE SIBLING TASK, READ FIRST: 1700 (already live in this tree, same wave)
-- fixed the exact same shape of bug for INCOME-TAX TDS Receivable —
-- seed_tds_receivable_ledger (0079) existed but nothing but a one-time
-- backfill ever called it, so every company created since 0079 shipped had
-- no tds_receivable map row no matter what its TDS Receivable ledger
-- carried. 1700's fix has three parts: (1) wire the seed call into the
-- unconditional per-company provisioning path, harmless because it mirrors
-- every other always-seeded control ledger; (2) a narrowly evidence-gated
-- backfill for companies that ALREADY exist, so a live company's chart of
-- accounts is not silently handed a new ledger it never asked for; (3) note,
-- not build, that an admin can already repoint tax_ledger_map by hand via
-- its existing RLS (all privileges to a company admin, no per-purpose
-- carve-out) — a nicer screen for that is a frontend change, out of file
-- scope here exactly as it was there.
--
-- THIS MIGRATION MIRRORS ALL THREE, with one deliberate difference in (1)
-- and (2)'s boundary, driven by a real structural difference between the two
-- ledgers:
--
--   TDS RECEIVABLE (income tax) is COMPANY-WIDE — Sec 199 credit sits
--   against one PAN, tax_ledger_map.gst_registration_id is null for it, and
--   1700 wires it into seed_chart_of_accounts (fires once, at company
--   creation).
--
--   GST TDS/TCS RECEIVABLE must be GSTIN-SCOPED, not company-wide. Sec 25(4)
--   CGST Act treats each GSTIN as a distinct registered person with its own
--   Electronic Cash Ledger — 0180's own header already reasoned through this
--   exact point for gst_tds_tcs_suffered's gst_registration_id column ("a
--   Sec 51/52 credit lands in the cash ledger of the SPECIFIC GSTIN the
--   deductor/operator reported against... never pooled company-wide"). A
--   multi-GSTIN company must not net a Karnataka GSTIN's Sec 51 deduction
--   against a Maharashtra GSTIN's books. So this ledger belongs beside the
--   rest of the per-registration GST control accounts app_private.
--   seed_gst_ledgers already creates (Output/Input CGST/SGST/IGST/Cess, RCM
--   Payable, GST Payable, GST Refund Receivable — all under the same Duties
--   & Taxes group, all seeded unconditionally per registration, all sit at
--   zero and cost nothing for a registration that never needs them), and its
--   provisioning hook is add_gst_registration (fires once per GSTIN), not
--   seed_chart_of_accounts (fires once per company).
--
--   That reclassifies the (1)/(2) boundary too: for a NEW GST registration
--   added from this point on, seeding this ledger is exactly as unconditional
--   and harmless as gst_refund_receivable/rcm_payable already are — it is
--   chart-of-accounts skeleton, not a fabricated balance. For an EXISTING
--   registration, this migration does NOT hand every live company a new
--   empty ledger the way an unconditional per-registration backfill would —
--   it backfills ONLY where a gst_tds_tcs_suffered row (0180) already proves
--   real Sec 51/52 activity happened. That is a materially better signal
--   than 1700's own name-match backfill (which relied on a preparer having
--   already invented a same-named ledger by hand — impossible here, since no
--   ledger for this purpose has ever existed anywhere in this schema before
--   today): a gst_tds_tcs_suffered row is a preparer's own compliance-tracker
--   record that a deductor/operator actually withheld something, which is
--   precisely the "something withholds Sec 51/52" test the control case
--   below is stated in terms of.
--
-- CONTROL CASE, checked live before writing a line of this migration: TEST
-- Rangoli Spice Works Pvt Ltd (8e161d8e-cd2e-4c60-96a4-bad69c42b573) has
-- ZERO gst_tds_tcs_suffered rows of any source_type — no government/PSU
-- buyer and no e-commerce operator has ever withheld anything from it. The
-- backfill below is written so this company falls out of its own WHERE
-- clause entirely: no ledger created, no tax_ledger_map row created, chart
-- of accounts and every report byte-identical before and after. Proven
-- below, not just asserted.
--
-- gst_tds_tcs_suffered ITSELF (0180) is NOT changed by this migration and
-- gets no new column pointing at the ledger. The task brief allowed for one
-- "if it needs a pointer to the ledger"; it does not. The two things track
-- genuinely different events at genuinely different times (see the Table
-- 6.1 decision below) and forcing an FK between a portal-reported
-- compliance record and a specific book-side voucher/ledger movement would
-- assert a 1:1 relationship that does not actually exist — a company may
-- record one gst_tds_tcs_suffered row per GSTR-7/8 period covering several
-- receipts, or post several receipts before ever getting round to recording
-- the compliance entry. tax_ledger_map is the join the rest of this schema
-- already uses for "which ledger plays this GST role for this GSTIN"
-- (output_cgst, input_cgst, gst_refund_receivable, ...) and this purpose
-- fits that exact shape with no schema change needed on 0180's table.
--
-- GET_GSTR3B_TABLE6_1's hard-coded tds_tcs_credit = 0 — DELIBERATELY LEFT
-- AS 0, not wired to the new ledger's period movement. Researched, not
-- guessed: GSTR-3B Table 6.1's own prescribed CBIC format DOES carry a
-- periodic "Tax/Cess paid TDS/TCS" column on every single month's/quarter's
-- return (confirmed against the GSTN return format and the GST portal's own
-- filing walkthrough, tutorial.gst.gov.in, read today) — so the task brief's
-- suggested alternative ("this figure genuinely does not belong in a
-- periodic GSTR-3B line, only in an annual computation") turns out NOT to be
-- the right read of the law: the figure is genuinely periodic, not annual.
-- But this schema still cannot safely compute it for a given return period,
-- for a reason specific to how this credit actually reaches a taxpayer:
--
--   * The BOOK ledger this migration adds is credited when a preparer
--     RECORDS a receipt net of the deduction — dated to the receipt/invoice.
--   * The PORTAL credit is usable only after the deductor/operator files
--     GSTR-7/8 for THEIR OWN period AND this company accepts the "TDS and
--     TCS Credit Received" statement (0180's own header, researched
--     Sec 51/52 mechanism) — an entirely separate event, routinely weeks or
--     months later, with no fixed relationship to the receipt's own date.
--   * 0180 deliberately stores no "which of MY OWN GSTR-3B periods was this
--     applied against" column — period_label is the DEDUCTOR'S filing
--     period, explicitly independent of this company's own filing
--     frequency (0180's own column comment).
--
-- So there is no reliable way, from data this schema actually has, to say
-- "this much GST TDS/TCS credit was usable in THIS RETURN PERIOD's cash
-- ledger" — reading the book ledger's period movement would silently
-- substitute a plausible, wrong number for an honest 0, exactly the kind of
-- report-grading-its-own-homework error this codebase has fixed before
-- (1410's whole point, for the output side). Left at 0, with the comment and
-- v_note both rewritten below to explain why in the function itself, and to
-- point a preparer at the correct manual figure — get_gst_tds_tcs_suffered_
-- summary's unclaimed_credit, checked against the portal, exactly the same
-- posture this app already takes toward advance-tax challans (tax_payments)
-- and every other manually-filed cash-ledger credit.
--
-- WIRING INTO THE VOUCHER/RECEIPT PATH: confirmed live, not assumed —
-- VoucherForm.tsx's ledger picker (components/vouchers/VoucherForm.tsx) is
-- `allLedgers.map(l => ({id: l.id, label: l.name, ...}))`, every company
-- ledger on every line, no branch/registration/purpose filter of any kind.
-- The moment this migration's ledger exists for a GSTIN, a preparer can
-- already credit it on an ordinary receipt line (Dr Bank net-received, Dr
-- TDS Receivable, Dr GST TDS/TCS Receivable, Cr the party for the full
-- invoice) with zero new frontend code — exactly what the task asked to be
-- confirmed rather than built.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- (1) app_private.seed_gst_tds_receivable_ledger — get-or-create, ONE per
--     GST registration, same idempotency/name-reuse discipline as every
--     seed_* helper in this schema (seed_tds_ledgers/seed_tds_receivable_
--     ledger/seed_gst_ledgers).
-- ----------------------------------------------------------------------------
create or replace function app_private.seed_gst_tds_receivable_ledger(
  p_company_id uuid,
  p_registration_id uuid
) returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_group uuid;
  v_state char(2);
  v_label text;
  v_ledger uuid;
begin
  if exists (
    select 1 from public.tax_ledger_map
     where company_id = p_company_id and gst_registration_id = p_registration_id
       and purpose = 'gst_tds_receivable'
  ) then
    return;
  end if;

  select state_code into v_state
    from public.gst_registrations
   where id = p_registration_id and company_id = p_company_id;
  if v_state is null then
    raise exception 'Registration not found in this company';
  end if;

  -- Same home as every other per-GSTIN GST control ledger (Output/Input
  -- CGST/SGST/IGST/Cess, RCM Payable, GST Payable, GST Refund Receivable) --
  -- a company's GST reconciliation already expects every GST control
  -- account together under this one group.
  select id into v_group
    from public.account_groups
   where company_id = p_company_id and ledger_role = 'duty_tax'
   order by sort_order limit 1;
  if v_group is null then
    raise exception 'No Duties & Taxes group found; seed the chart of accounts first';
  end if;

  v_label := 'GST TDS/TCS Receivable (' || v_state || ')';

  -- ledgers_company_name_idx is case-insensitively unique, so adopt an
  -- existing same-named ledger rather than colliding with it -- same care
  -- seed_tds_ledgers/seed_tds_receivable_ledger/seed_gst_ledgers all take.
  select id into v_ledger
    from public.ledgers
   where company_id = p_company_id and lower(name) = lower(v_label)
   limit 1;

  if v_ledger is null then
    -- An ASSET: Sec 51/52 tax withheld by a government/PSU buyer or an
    -- e-commerce operator on this company's OWN supplies, recoverable via
    -- the GST portal's "TDS and TCS Credit Received" statement -- never a
    -- duty this company owes, unlike every other ledger seed_gst_ledgers
    -- creates in this same group.
    insert into public.ledgers (company_id, group_id, name, opening_balance_type)
    values (p_company_id, v_group, v_label, 'debit')
    returning id into v_ledger;
  end if;

  insert into public.tax_ledger_map (company_id, gst_registration_id, purpose, ledger_id)
  values (p_company_id, p_registration_id, 'gst_tds_receivable', v_ledger);
end;
$fn$;

comment on function app_private.seed_gst_tds_receivable_ledger(uuid, uuid) is
  'Get-or-create the "GST TDS/TCS Receivable (<state>)" ledger for one GST registration and wire it into tax_ledger_map under purpose ''gst_tds_receivable''. GSTIN-scoped, not company-wide -- Sec 25(4) CGST Act, same reasoning as 0180''s gst_tds_tcs_suffered.gst_registration_id. Idempotent (checks tax_ledger_map first) and name-reuse safe (adopts an existing same-named ledger). Called unconditionally from add_gst_registration for every NEW registration, and by this migration''s own evidence-gated backfill for existing ones -- see 1740.';

-- app_private has no USAGE grant to public/anon (schema-level lockout, so
-- this was never reachable over PostgREST regardless), but 1700 established
-- the house discipline of restating function-level grants anyway now that
-- this is a live part of provisioning rather than a one-off helper --
-- revoking from anon alone is a no-op, PUBLIC's default EXECUTE grant is
-- what actually matters.
revoke all on function app_private.seed_gst_tds_receivable_ledger(uuid, uuid) from public, anon;
grant execute on function app_private.seed_gst_tds_receivable_ledger(uuid, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- (2) Wire into add_gst_registration for every FUTURE registration --
--     unconditional, same "harmless, part of initial provisioning" posture
--     gst_refund_receivable and rcm_payable already have in seed_gst_ledgers,
--     applied via the house assert-then-replace pattern (1200/1420/1451/
--     1700), not a retype.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_from constant text :=
'  perform app_private.seed_gst_ledgers(p_company_id, v_registration_id);';
  v_to constant text :=
'  perform app_private.seed_gst_ledgers(p_company_id, v_registration_id);

  -- GST TDS/TCS Receivable (1740): unconditional and harmless for a
  -- registration that never has a government/PSU customer or marketplace
  -- withhold anything from it -- same posture as gst_refund_receivable and
  -- rcm_payable, both seeded unconditionally two lines up inside
  -- seed_gst_ledgers itself. Existing registrations are handled by this
  -- migration''s own evidence-gated backfill instead (see 1740 header) --
  -- this call only ever fires for a registration added from this point on.
  perform app_private.seed_gst_tds_receivable_ledger(p_company_id, v_registration_id);';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'add_gst_registration' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1740: public.add_gst_registration is missing.';
  end if;

  if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
    raise exception '1740: add_gst_registration''s seed_gst_ledgers call site has moved or already changed; fix by hand.';
  end if;

  execute replace(v_def, v_from, v_to);
end;
$mig$;

revoke all on function public.add_gst_registration(uuid, char, date, uuid, text, text, text, text) from public, anon;
grant execute on function public.add_gst_registration(uuid, char, date, uuid, text, text, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- (3) Backfill EXISTING registrations -- evidence-gated, not unconditional.
--     Only a (company, registration) pair that already has at least one
--     gst_tds_tcs_suffered row (0180) -- i.e. a preparer has already
--     recorded that a deductor/operator actually withheld something under
--     Sec 51/52 -- gets a ledger created here. A registration with zero such
--     rows (the control case) is untouched: not in this query's result set
--     at all, so seed_gst_tds_receivable_ledger is never even called for it.
-- ----------------------------------------------------------------------------
do $backfill$
declare
  r record;
  v_count int := 0;
  v_names text := '';
begin
  for r in
    select distinct s.company_id, s.gst_registration_id, c.name
      from public.gst_tds_tcs_suffered s
      join public.companies c on c.id = s.company_id
     where not exists (
       select 1 from public.tax_ledger_map m
        where m.company_id = s.company_id
          and m.gst_registration_id = s.gst_registration_id
          and m.purpose = 'gst_tds_receivable'
     )
  loop
    perform app_private.seed_gst_tds_receivable_ledger(r.company_id, r.gst_registration_id);
    v_count := v_count + 1;
    v_names := v_names || r.name || ' (' || r.company_id || '); ';
  end loop;

  raise notice '1740: backfilled tax_ledger_map (purpose=gst_tds_receivable) for % existing registration(s): %', v_count, v_names;
end;
$backfill$;


-- ----------------------------------------------------------------------------
-- (4) get_gstr3b_table6_1 -- tds_tcs_credit stays 0, deliberately. Comments
--     rewritten in place (targeted, asserted replace, house pattern) to say
--     why now that a ledger exists, rather than leave the old "not modelled"
--     text stale and misleading. No behavioural change: the returned figure
--     is byte-identical before and after this migration.
-- ----------------------------------------------------------------------------
do $mig2$
declare
  v_def text;
  v_from1 constant text :=
'    -- Sec 51/52 GST TDS/TCS — a different mechanism from income-tax TDS/TCS
    -- and not modelled anywhere in this schema. Always 0, as in 0129.
    0::numeric,';
  v_to1 constant text :=
'    -- Sec 51/52 GST TDS/TCS (1740): this company''s OWN BOOKS now have a
    -- real ledger for it -- tax_ledger_map purpose ''gst_tds_receivable'',
    -- one per GST registration -- so a preparer can net a Sec 51/52
    -- deduction against the party through an ordinary voucher. That
    -- ledger''s period movement is deliberately NOT read into this column.
    -- GSTN''s own Table 6.1 "Tax/Cess paid TDS/TCS" is how much of THIS
    -- RETURN PERIOD''s cash liability was actually discharged from the
    -- Electronic Cash Ledger using ACCEPTED Sec 51/52 credit -- an event on
    -- the GST portal (filing/accepting the "TDS and TCS Credit Received"
    -- statement) that routinely lands weeks or months after the book entry
    -- recording the receipt net of the deduction, because the deductor''s
    -- own GSTR-7/8 has its own separate due date. gst_tds_tcs_suffered
    -- (0180) tracks the portal side but stores no claimed-period column, so
    -- nothing in this schema yet says which return period a given credit
    -- was actually applied against. Reading the book ledger''s movement
    -- here would substitute a plausible-looking but frequently WRONG figure
    -- for an honest 0 -- worse than the gap it would appear to close. Still
    -- 0, deliberately: see get_gst_tds_tcs_suffered_summary''s
    -- unclaimed_credit for the figure a preparer should check by hand
    -- against the portal before filing.
    0::numeric,';
  v_from2 constant text :=
'    || ''an earlier period''''s unposted reversal still sits in the brought-forward credit. Sec 51/52 GST ''
    || ''TDS/TCS credit is not modelled and reads 0; interest and late fee live in Table 5.1. A negative tax ''';
  v_to2 constant text :=
'    || ''an earlier period''''s unposted reversal still sits in the brought-forward credit. Sec 51/52 GST ''
    || ''TDS/TCS credit has a real ledger now for this company''''s own books (gst_tds_receivable, see 1740) ''
    || ''but this return-period column still deliberately reads 0 -- the book ledger''''s movement is not ''
    || ''the same event as the portal''''s own accepted TDS/TCS Credit Received statement, and nothing in ''
    || ''this schema records which return period a credit was actually applied against (see 1740); check ''
    || ''get_gst_tds_tcs_suffered_summary''''s unclaimed_credit and apply it by hand. Interest and late fee ''
    || ''live in Table 5.1. A negative tax ''';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_gstr3b_table6_1' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1740: public.get_gstr3b_table6_1 is missing.';
  end if;

  if (length(v_def) - length(replace(v_def, v_from1, ''))) / length(v_from1) <> 1 then
    raise exception '1740: get_gstr3b_table6_1''s tds_tcs_credit comment/literal has moved or already changed; fix by hand.';
  end if;
  if (length(v_def) - length(replace(v_def, v_from2, ''))) / length(v_from2) <> 1 then
    raise exception '1740: get_gstr3b_table6_1''s v_note Sec 51/52 fragment has moved or already changed; fix by hand.';
  end if;

  v_def := replace(v_def, v_from1, v_to1);
  v_def := replace(v_def, v_from2, v_to2);
  execute v_def;
end;
$mig2$;

revoke all on function public.get_gstr3b_table6_1(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gstr3b_table6_1(uuid, uuid, date, date) to authenticated;

comment on function public.get_gstr3b_table6_1(uuid, uuid, date, date) is
  'GSTR-3B Table 6.1 (payment of tax) for ONE return period. tax_payable is that period''s own output tax — movement on the output control ledgers between the period dates, net of the period''s credit notes, excluding post_gst_setoff clearing journals — NOT a cumulative balance (the 0129 behaviour, which re-reported every earlier month''s uncleared liability in every later return). ITC available = electronic-credit-ledger balance brought forward + this period''s NET ITC (Table 4(A) less the whole of Table 4(B)), per CBIC Circular 170/02/2022-GST; the 0129 version utilised gross ITC and so contradicted Table 4 on the same screen. Set-off order is Sec 49A / Rule 88A via app_private.gstr3b_period_setoff. Reverse-charge liability and interest/late fee are still out of scope here. Sec 51/52 TDS/TCS credit has a real book-side ledger now (tax_ledger_map purpose gst_tds_receivable, one per GST registration — see 1740) but this periodic column deliberately still reads 0: the book ledger''s movement is not the same event as the portal''s own accepted TDS/TCS Credit Received statement, and this schema records no claimed-period attribution to read instead — see the note column and 1740.';


-- ----------------------------------------------------------------------------
-- 0180's own table comment said "no ledger" as a statement of fact at the
-- time; it no longer is. Restated, not rewritten from scratch, so the
-- boundary between the two mechanisms (compliance tracker vs book ledger) is
-- explicit rather than left for a reader to infer from two migrations.
-- ----------------------------------------------------------------------------
comment on table public.gst_tds_tcs_suffered is
  'GST TDS (Sec 51, government/PSU/notified-deductor buyers) and GST TCS (Sec 52, e-commerce operators) suffered/collected on THIS company''s own supplies, as recorded from the GST portal''s "TDS and TCS Credit Received" statement. This is the credit-tracking side only (this company as deductee/supplier) — never the deductor/operator (GSTR-7/GSTR-8 filing) side, which almost no user of this app is. Manually entered: this data originates on the deductor/operator''s own return, outside this company''s books, and no auto-population feed for it exists in this schema. As of 1740, a real BOOK-SIDE ledger exists too (tax_ledger_map purpose gst_tds_receivable, one per GST registration) so a preparer can net the deduction against the party on an ordinary receipt — but this table is NOT linked to that ledger by any FK, deliberately: a book-side receipt and a portal-side accepted credit statement are different events, commonly on different dates and even in different return periods (0180''s own period_label is the DEDUCTOR''s filing period, independent of this company''s own), and forcing a 1:1 link here would assert a relationship that does not actually hold. See 1740 for the full reasoning, including why GSTR-3B Table 6.1 still does not read this table or the new ledger automatically.';
