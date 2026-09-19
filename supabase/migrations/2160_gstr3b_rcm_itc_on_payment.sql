-- ============================================================================
-- 2160 — GSTR-3B Table 4(A)(3): RCM tax that was actually PAID never became
--        ITC. get_gstr3b_table4 hard-coded a3_inward_rcm = 0 forever, with
--        its own note admitting "A3's true ITC component cannot be
--        identified from this schema and read as zero for that reason, not
--        because none occurred". Every Sec 9(3)/9(4) RCM transaction a
--        company ever pays permanently vanishes from its claimable ITC.
-- ============================================================================
-- REPRODUCED LIVE, TEST Precision Engineering Pvt Ltd
-- (f2557c28-73ec-43a1-9769-d346e21548f6), GST registration
-- f37c138f-fb10-4dae-8f28-63dcae4768d6 (27AAFCT1234K1ZB): purchase
-- HOPUR26/0004, 10-Sep-2026, a Sec 9(3) GTA freight purchase, correctly
-- self-assessed by 0102 as Cr RCM Payable (27) 400.00. Before this
-- migration, get_gstr3b_table4 for Sep-2026 read a3_rcm_memo_liability_
-- accrued = 400.00 (correct memo) and a3_inward_rcm = 0.00 (permanently, by
-- construction) — with no code path anywhere in this schema that could ever
-- change that second figure, however long the ₹400 sat paid in the
-- government's hands.
--
-- ----------------------------------------------------------------------------
-- STATUTORY RESEARCH — WHEN DOES RCM TAX BECOME ELIGIBLE ITC: ON ACCRUAL, OR
-- ON PAYMENT? Two fresh web searches plus a skeptical re-check, because the
-- task this migration answers explicitly warned against assuming either way.
-- ----------------------------------------------------------------------------
-- Sec 2(62)(d) CGST Act: "input tax" in relation to a registered person
-- expressly INCLUDES "the tax payable under sub-section (3) and (4) of
-- section 9" — RCM tax is input tax by definition, not a separate credit
-- regime. Sec 16(1) then grants entitlement to input tax credit generally,
-- "subject to such conditions and restrictions as may be prescribed".
--
-- Sec 16(2)(c) is one such condition, and the one that actually resolves the
-- timing question: a registered person is entitled to credit only if "the
-- tax charged in respect of such supply has been actually paid to the
-- Government". For an RCM transaction the recipient itself is the one who
-- self-assesses and remits that tax — there is no supplier-side payment to
-- wait on — so this condition collapses to "once the recipient has actually
-- deposited the self-assessed tax".
--
-- Rule 36(1) CGST Rules lists the documents ITC may be availed on. Clause
-- (a) covers an ordinary supplier tax invoice with no payment condition of
-- its own (Sec 16(2)(c) still applies generally, but is usually satisfied
-- structurally once the supplier has charged and reported the tax). Clause
-- (b), the one that actually governs RCM, is different IN ITS OWN TEXT: "an
-- invoice issued in accordance with the provisions of clause (f) of
-- sub-section (3) of section 31, SUBJECT TO THE PAYMENT OF TAX" — Sec
-- 31(3)(f) being exactly the self-invoice a recipient issues on an RCM
-- inward supply. The payment condition is written into the RULE ITSELF for
-- this one document type, not left to Sec 16(2)(c) alone. Confirmed against
-- the CBIC rule text directly (taxinformation.cbic.gov.in/.../rule36_v1.00.
-- html) and cross-checked against tallysolutions.com's own plain-English
-- restatement of the same clause.
--
-- Practitioner commentary (taxguru.in, "Availment of Input tax credit paid
-- under RCM") reasons through this identically and explicitly contrasts it
-- with the pre-GST CENVAT regime, where Rule 4(7)'s second proviso said the
-- same thing in so many words: "credit of service tax payable by the service
-- recipient shall be allowed after such service tax is paid" — i.e. this is
-- a deliberate, continued legislative choice, not an ambiguity. A second,
-- skeptical search surfaced one dissenting practitioner thread (TaxTMI,
-- "IMBROGLIO OF 'SAME MONTH' UNDER RCM") arguing Sec 16 permits credit on
-- tax merely "charged", with payment only a later-cured condition — but even
-- that thread's own author concludes ITC becomes AVAILABLE only once both
-- the self-invoice is issued AND the tax is actually deposited via challan,
-- which is the same payment-gated answer; the disagreement in that thread is
-- narrower (whether payment in month M+1 can retroactively cure month M's
-- liability), not whether payment is the trigger at all.
--
-- CONCLUSION, and why this migration does not need to re-litigate 0102:
-- ITC on self-assessed RCM tax becomes available on ACTUAL PAYMENT, not on
-- mere accrual of the rcm_payable liability. This is exactly the position
-- 0102 already researched and built around ("only once actually paid does
-- it become available as ordinary input credit") — 0102 posted the
-- liability leg only and explicitly left the payment-triggered
-- reclassification as a manual step for a preparer to make later. This
-- migration does not change that legal conclusion; it changes WHO performs
-- the reclassification — the report, automatically, once payment is
-- observed in the books — instead of leaving it to a manual journal entry
-- that this app has never actually prompted or required anyone to pass (the
-- entire reason this bug recurs on every RCM transaction, forever).
--
-- ----------------------------------------------------------------------------
-- DESIGN: REUSE THE EXISTING LEDGER MOVEMENT, ADD NO NEW TRACKING TABLE
-- ----------------------------------------------------------------------------
-- The task suggested looking at the TDS Receivable / GST TDS Receivable
-- wiring (1700/1740) as a precedent for "this liability, once paid, becomes
-- claimable". Read both in full before designing this. Their shape does NOT
-- transfer directly — 1700/1740 solve "provision a ledger that did not
-- exist yet", not "detect a clearing event on a ledger that already
-- exists". rcm_payable has existed and been posted to since 0102; the only
-- missing piece is a query that notices when it is DEBITED.
--
-- That debit is fully observable with schema that already exists, exactly
-- as 0102's own header already anticipated: "once a business actually pays
-- its RCM liability in cash (a separate payment voucher, Dr rcm_payable /
-- Cr bank — already fully representable with existing functionality, not
-- new here)". tax_ledger_map (purpose = 'rcm_payable') already identifies
-- the correct ledger per GST registration; voucher_entries already carries
-- every debit and credit ever posted to it; vouchers.voucher_type already
-- distinguishes a 'payment' voucher from the 'purchase' voucher that
-- accrued the liability in the first place. No new column, table, or
-- linking mechanism is added — matching 1740's own reasoning for NOT adding
-- an FK between gst_tds_tcs_suffered and its ledger where the existing
-- tax_ledger_map join already answered the question.
--
-- SCOPED TO voucher_type = 'payment' DELIBERATELY, not any debit whatsoever.
-- The task's own framing is specific: "a payment voucher debiting it". A
-- company can, in principle, debit any ledger from a 'journal' voucher too
-- (VoucherForm's ledger picker is unfiltered — confirmed by 1740's own
-- reading of components/vouchers/VoucherForm.tsx, still true, not re-read
-- as unchanged since 1740 already established it and this migration does
-- not touch that file), but a bare journal debit to a duty/tax control
-- ledger is exactly as likely to be a RECLASSIFICATION or CORRECTION
-- (someone fixing a wrongly-flagged is_rcm_applicable item after the fact)
-- as it is a genuine cash remittance. Restricting the trigger to
-- voucher_type = 'payment' — the voucher type whose entire purpose is
-- recording money actually leaving the company — is the narrower, safer
-- reading, at the cost of not recognising a company that unconventionally
-- pays its RCM liability through a plain journal entry instead. Said here,
-- not silently: a company doing that will still see a3_rcm_memo_liability_
-- accrued move but a3_inward_rcm stay 0 until it posts (or reclasses to) an
-- actual payment voucher.
--
-- A SECOND SAFEGUARD, NOT ASKED FOR BUT NEEDED FOR THE SAME REASON 0102's
-- OWN GUARDRAILS EXIST: rcm_payable is trusted, unfiltered, preparer-picked
-- ledger, so a payment voucher COULD (by mistake or by a stray manual entry)
-- debit it for more than was ever actually self-assessed. Reporting that
-- whole debit as ITC would fabricate credit for tax that was never really
-- owed — precisely the failure mode this task is written to avoid in the
-- other direction. So the amount recognised in ANY period is capped at the
-- ledger's own cumulative net accrual (credits, net of any non-payment
-- debit — i.e. a correction) through that period's end, less whatever a
-- 'payment' voucher has already cleared in an earlier period. A company that
-- never overpays never notices this cap; one that does cannot use it to
-- manufacture ITC beyond its real self-assessed liability.
--
-- WHAT THIS DOES NOT FIX, AND WHY — Table 6.1's cash set-off cascade
-- (get_gstr3b_table6_1, built by 1410, a function this migration does not
-- own or touch) computes its electronic-credit-ledger utilisation STRICTLY
-- per tax head (IGST/CGST/SGST/Cess), sourced from get_gst_input_register's
-- own head-wise columns — never from get_gstr3b_table4's a_total or
-- c_net_itc_available. rcm_payable is, by 0102's own deliberate design, "A
-- SINGLE, UNSPLIT LEDGER PER REGISTRATION" with no rcm_payable_cgst/sgst/
-- igst equivalent — there is no head-wise figure this migration or any
-- other could hand to that cascade without fabricating a split the ledger
-- itself does not carry. So a3_inward_rcm now correctly appears in Table
-- 4(A) and 4(C) (informational, "how much ITC is available"), but Table
-- 6.1's actual cash-payable computation still cannot consume it. This is a
-- real, separate gap — flagged in the note column and in the session report
-- — not silently left implied by a Table 4 fix that looks complete.
-- ============================================================================

do $mig$
declare
  v_def text;

  v_from_cte constant text :=
'  rcm_accrued as (
    select coalesce(sum(e.credit_amount - e.debit_amount), 0) as amt
    from public.voucher_entries e
    join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
    join public.vouchers v on v.id = e.voucher_id
   where e.company_id = p_company_id
     and m.purpose = ''rcm_payable''
     and (p_gst_registration_id is null or m.gst_registration_id = p_gst_registration_id)
     and not v.is_deleted
     and v.voucher_date between p_period_start and p_period_end
  ),
  common as (';
  v_to_cte constant text :=
'  rcm_accrued as (
    select coalesce(sum(e.credit_amount - e.debit_amount), 0) as amt
    from public.voucher_entries e
    join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
    join public.vouchers v on v.id = e.voucher_id
   where e.company_id = p_company_id
     and m.purpose = ''rcm_payable''
     and (p_gst_registration_id is null or m.gst_registration_id = p_gst_registration_id)
     and not v.is_deleted
     and v.voucher_date between p_period_start and p_period_end
  ),
  -- 2160: Sec 16(1) read with Rule 36(1)(b)''s own "subject to payment of
  -- tax" condition on a Sec 31(3)(f) self-invoice makes RCM tax eligible
  -- ITC only once actually PAID, never on mere accrual (see migration
  -- header). this_period/before_period are split in one pass because the
  -- cap below needs both: how much this specific return period cleared, and
  -- how much an earlier period already claimed.
  rcm_paid_activity as (
    select
      coalesce(sum(e.debit_amount - e.credit_amount) filter (
        where v.voucher_date >= p_period_start), 0) as this_period,
      coalesce(sum(e.debit_amount - e.credit_amount) filter (
        where v.voucher_date < p_period_start), 0) as before_period
    from public.voucher_entries e
    join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
    join public.vouchers v on v.id = e.voucher_id
   where e.company_id = p_company_id
     and m.purpose = ''rcm_payable''
     and (p_gst_registration_id is null or m.gst_registration_id = p_gst_registration_id)
     and not v.is_deleted
     and v.voucher_type = ''payment''
     and v.voucher_date <= p_period_end
  ),
  -- The ledger''s own net accrual (credits, net of any NON-payment debit —
  -- i.e. a correction/reclassification, never a cash clearing) through this
  -- period''s end. The ceiling a cumulative ITC claim can never exceed, so a
  -- stray overpayment cannot fabricate credit for tax that was never really
  -- self-assessed.
  rcm_accrued_to_date as (
    select coalesce(sum(
      case when v.voucher_type <> ''payment''
           then e.credit_amount - e.debit_amount else 0 end), 0) as amt
    from public.voucher_entries e
    join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
    join public.vouchers v on v.id = e.voucher_id
   where e.company_id = p_company_id
     and m.purpose = ''rcm_payable''
     and (p_gst_registration_id is null or m.gst_registration_id = p_gst_registration_id)
     and not v.is_deleted
     and v.voucher_date <= p_period_end
  ),
  rcm_paid as (
    select greatest(0, least(
      rcm_paid_activity.this_period,
      rcm_accrued_to_date.amt - rcm_paid_activity.before_period
    )) as amt
    from rcm_paid_activity, rcm_accrued_to_date
  ),
  common as (';

  v_from_a3 constant text :=
'    0::numeric as a3_inward_rcm,';
  v_to_a3 constant text :=
'    round(rcm_paid.amt, 2) as a3_inward_rcm,';

  v_from_atotal constant text :=
'    round(input_totals.cgst + input_totals.sgst + input_totals.igst + input_totals.cess, 2) as a_total,';
  v_to_atotal constant text :=
'    round(input_totals.cgst + input_totals.sgst + input_totals.igst + input_totals.cess + rcm_paid.amt, 2) as a_total,';

  v_from_cnet constant text :=
'    round(
      (input_totals.cgst + input_totals.sgst + input_totals.igst + input_totals.cess)
      - (common.blocked_itc + common.total_reversal + rule37.amt),
      2
    ) as c_net_itc_available,';
  v_to_cnet constant text :=
'    round(
      (input_totals.cgst + input_totals.sgst + input_totals.igst + input_totals.cess + rcm_paid.amt)
      - (common.blocked_itc + common.total_reversal + rule37.amt),
      2
    ) as c_net_itc_available,';

  v_from_note constant text :=
'    ''A1 (import of goods), A2 (import of services), A4 (ISD) and A3''''s true ITC component cannot be ''
    || ''identified from this schema and read as zero for that reason, not because none occurred — see ''
    || ''the report page. B reversals (Sec 17(5) blocked, Rule 42, Rule 37) are computed company-wide, ''
    || ''not strictly per GSTIN; exact for a single-registration company (every company in this database ''
    || ''today). Rule 43 (capital goods) is not included in B(1). D(1)/D(2) are not tracked (no ''
    || ''cross-period reclaim linkage, no Sec 16(4) time-bar check, no place-of-supply restriction check) ''
    || ''and are always 0 — informational only, never netted into C.'' as note';
  v_to_note constant text :=
'    ''A1 (import of goods), A2 (import of services) and A4 (ISD) cannot be identified from this schema ''
    || ''and read as zero for that reason, not because none occurred — see the report page. A3 (2160): RCM ''
    || ''tax becomes eligible ITC only on actual cash payment (Sec 16(1) read with Rule 36(1)(b)''''s ''
    || ''"subject to payment of tax" condition on the Sec 31(3)(f) self-invoice — not on mere accrual of the ''
    || ''rcm_payable liability), so this is the amount of rcm_payable actually cleared by a payment voucher ''
    || ''within this period, capped at the ledger''''s own cumulative net-accrued-but-unclaimed balance as ''
    || ''at period end so a stray overpayment cannot fabricate credit; a3_rcm_memo_liability_accrued remains ''
    || ''the separate, still-unpaid accrual. This figure is NOT split by tax head (rcm_payable is one ''
    || ''unsplit ledger per registration, per 0102) and so cannot feed Table 6.1''''s per-head electronic-''
    || ''credit-ledger cascade (get_gstr3b_table6_1, 1410) — that set-off engine still does not utilise ''
    || ''RCM-derived credit; see 2160. B reversals (Sec 17(5) blocked, Rule 42, Rule 37) are computed ''
    || ''company-wide, not strictly per GSTIN; exact for a single-registration company (every company in ''
    || ''this database today). Rule 43 (capital goods) is not included in B(1). D(1)/D(2) are not tracked ''
    || ''(no cross-period reclaim linkage, no Sec 16(4) time-bar check, no place-of-supply restriction ''
    || ''check) and are always 0 — informational only, never netted into C.'' as note';

  v_from_fromclause constant text :=
'  from input_totals, rcm_accrued, common, rule37;';
  v_to_fromclause constant text :=
'  from input_totals, rcm_accrued, rcm_paid, common, rule37;';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_gstr3b_table4' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '2160: public.get_gstr3b_table4 is missing.';
  end if;

  if (length(v_def) - length(replace(v_def, v_from_cte, ''))) / length(v_from_cte) <> 1 then
    raise exception '2160: get_gstr3b_table4''s rcm_accrued/common CTE boundary has moved or already changed; fix by hand.';
  end if;
  if (length(v_def) - length(replace(v_def, v_from_a3, ''))) / length(v_from_a3) <> 1 then
    raise exception '2160: get_gstr3b_table4''s a3_inward_rcm literal has moved or already changed; fix by hand.';
  end if;
  if (length(v_def) - length(replace(v_def, v_from_atotal, ''))) / length(v_from_atotal) <> 1 then
    raise exception '2160: get_gstr3b_table4''s a_total expression has moved or already changed; fix by hand.';
  end if;
  if (length(v_def) - length(replace(v_def, v_from_cnet, ''))) / length(v_from_cnet) <> 1 then
    raise exception '2160: get_gstr3b_table4''s c_net_itc_available expression has moved or already changed; fix by hand.';
  end if;
  if (length(v_def) - length(replace(v_def, v_from_note, ''))) / length(v_from_note) <> 1 then
    raise exception '2160: get_gstr3b_table4''s note literal has moved or already changed; fix by hand.';
  end if;
  if (length(v_def) - length(replace(v_def, v_from_fromclause, ''))) / length(v_from_fromclause) <> 1 then
    raise exception '2160: get_gstr3b_table4''s final FROM clause has moved or already changed; fix by hand.';
  end if;

  v_def := replace(v_def, v_from_cte, v_to_cte);
  v_def := replace(v_def, v_from_a3, v_to_a3);
  v_def := replace(v_def, v_from_atotal, v_to_atotal);
  v_def := replace(v_def, v_from_cnet, v_to_cnet);
  v_def := replace(v_def, v_from_note, v_to_note);
  v_def := replace(v_def, v_from_fromclause, v_to_fromclause);

  execute v_def;
end;
$mig$;

revoke all on function public.get_gstr3b_table4(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gstr3b_table4(uuid, uuid, date, date) to authenticated;

comment on function public.get_gstr3b_table4(uuid, uuid, date, date) is
  'GSTR-3B Table 4 prep, POST-JULY-2022 format (CBIC Circular 170/02/2022). 4(A) ITC available: A1/A2/A4 always 0 (imports/ISD not identifiable in this schema); A3 (2160) is the amount of rcm_payable actually cleared by a payment voucher within the period — Sec 16(1) read with Rule 36(1)(b)''s "subject to payment of tax" condition on the Sec 31(3)(f) self-invoice makes RCM tax eligible ITC only on actual payment, never on mere accrual — capped at the ledger''s own cumulative net-accrued-but-unclaimed balance so an overpayment cannot fabricate credit; a3_rcm_memo_liability_accrued is the separate, still-unpaid self-assessed liability. A5 is the full get_gst_input_register total. 4(B) reversed (Sec 17(5) + Rule 42 from get_common_credit_apportionment, Rule 37 from get_itc_180day_reversal). 4(C) = A − B. 4(D) always 0 (no Sec 16(4)/reclaim tracking). B-side figures are company-wide, not per-GSTIN. A3''s new figure is a single combined amount (rcm_payable has no per-head split, per 0102) and is NOT consumed by get_gstr3b_table6_1''s per-head cash set-off cascade (1410) — that remains a known gap, see 2160. See 0129, 0102, 2160.';

notify pgrst, 'reload schema';
