-- ============================================================================
-- 1410 — GSTR-3B Table 6.1 is a RETURN-PERIOD table, not a running balance
-- ============================================================================
-- WHAT WAS WRONG
--
-- get_gstr3b_table6_1 (0129) delegated wholesale to
-- get_gst_setoff_computation(company, registration, p_period_end) and threw
-- p_period_start away. That function is a "clear the control ledgers AS AT a
-- date" computation (0090) — by design it reads the CLOSING BALANCE of the
-- eight GST control ledgers since inception. 0129 relabelled
-- row_kind='output_opening' as "Table 6.1 tax payable", which makes 6.1
-- cumulative: every rupee of output tax that has not yet been cleared by a
-- posted set-off journal is reported again, in every subsequent month's
-- return, until someone posts one.
--
-- Reproduced live on TEST Rangoli Spice Works Pvt Ltd (8e161d8e-…),
-- registration 27AABCR1234K1ZH, hand-derived from voucher_entries:
--
--   Output CGST movement, Aug 2026 .......................... 33.90
--   Output CGST movement, Sep 2026 (net of the credit note) 2,382.57
--   6.1 "tax payable" for Aug 2026 .......................... 33.90
--   6.1 "tax payable" for Sep 2026, as at 29 Sep .......... 2,416.47   <-- wrong
--
-- 2,416.47 = 2,382.57 + 33.90. August's liability, already reported and set
-- off in the August return, is reported a second time in September. Same for
-- SGST. (In this company the error is invisible at 30 Sep only because a
-- clearing journal happens to be dated that day; a preparer working on the
-- return before posting it — which is the normal order — sees the inflated
-- figure. The interest and late-fee figures in Table 5.1, which are computed
-- straight off 6.1's cash_tax_payable, inherit the same overstatement.)
--
-- AND: 6.1 drew its ITC from the RAW input-ledger balance, so it ignored the
-- reversal that Table 4 on the very same screen demands. Worst live case,
-- Sharma Textiles (395e9f55-…), Aug 2026:
--
--   Table 4: A total 231,450.00, B total 224,652.39 (of which Sec 17(5)
--            blocked 224,000.00), C Net ITC available ......... 6,797.61
--   Table 6.1, same screen, ITC utilised ..................... 63,622.32
--   Table 6.1, same screen, cash payable .......................... 0.00
--
-- Nine times more credit spent than the screen's own Table 4 said existed,
-- and the filer told they owed nothing in cash. Table 4(C) is not
-- decorative: "Net ITC as per Table 4(C) i.e. [4(A) − 4(B)] shall only be
-- credited to the electronic credit ledger" (CBIC Circular 170/02/2022-GST),
-- and Table 6.1 pays out of that ledger.
--
-- WHAT 6.1 SHOULD CONTAIN FOR ONE TAX PERIOD
--
--   Tax payable (per head)  = THIS period's own output tax, net of THIS
--                             period's credit notes. Not a balance.
--   Credit available        = electronic-credit-ledger balance brought
--                             forward + this period's 4(C) net ITC
--                             (= 4(A) gross − 4(B) reversal).
--   Paid through ITC        = Sec 49A / Rule 88A cascade over those two.
--   Paid in cash            = whatever liability no credit could meet.
--
-- The asymmetry is deliberate and is how GST actually works: the LIABILITY
-- is period-scoped (an unpaid earlier month is that month's return's
-- problem, and its interest runs there), while the CREDIT ledger genuinely
-- carries a balance forward.
--
-- HOW "THIS PERIOD'S OWN OUTPUT TAX" IS MEASURED
--
-- Movement on the four output control ledgers between p_period_start and
-- p_period_end (credit − debit), which nets this period's credit notes for
-- free because a credit note DEBITS the output ledger. Clearing journals are
-- excluded: post_gst_setoff (0090) writes a plain 'journal' whose every line
-- is a tax control ledger and whose net effect on the output ledgers is a
-- debit. That shape — all lines in tax_ledger_map AND output net negative —
-- is the exclusion test, rather than the narration, which is free text and
-- overridable. A real supply voucher can never match it: it must credit a
-- revenue or party ledger, which is not in the map. The "output net
-- negative" half of the test means a hypothetical all-tax voucher that
-- INCREASES output liability is still counted.
--
-- A month whose credit notes outrun its sales produces a NEGATIVE tax
-- payable. That is reported as it stands rather than clamped away, because
-- it is real and the preparer has to deal with it (GSTN will not accept a
-- negative liability; the excess is carried into the next period's GSTR-1,
-- which LEKHA does not model). The set-off cascade itself runs on
-- greatest(0, payable), so a negative head simply consumes no credit.
--
-- PER-HEAD SPLIT OF THE 4(B) REVERSAL
--
-- Rule 42 already comes per head from get_gstr3b_table4. Rule 37's per-head
-- split is recovered from get_itc_180day_reversal's own itc_cgst/sgst/igst/
-- cess columns, pro-rated by reversal_itc/itc_total exactly as that function
-- pro-rates the total. Sec 17(5) blocked credit has NO per-head split
-- anywhere in this schema (get_common_credit_apportionment exposes only a
-- blocked_itc total), so it is apportioned across heads by this period's own
-- gross ITC mix — an approximation, stated here and on the report page. The
-- four head figures are then forced to sum to get_gstr3b_table4's own
-- b_total to the paisa, so the two halves of the screen can never disagree
-- on the total again, whatever the rounding.
--
-- WHAT THIS DOES NOT DO
--
--   • Reverse-charge liability is still absent from "tax payable". Real 6.1
--     carries it (Sec 49(4) forbids paying it from ITC, so it is a cash-only
--     row); LEKHA's rcm_payable movement is reported in Table 4 as a memo
--     only, exactly as 0129 left it. Out of this migration's scope —
--     changing it would change the return's row shape.
--   • Reversals are computed, never POSTED to the input ledgers. So the
--     brought-forward credit balance still carries any earlier period's
--     unposted reversal. Same class of gap as an unposted set-off.
--   • A set-off journal dated OUTSIDE the period whose liability it clears
--     leaves the credit brought forward overstated: the earlier return
--     claimed to spend that credit, but the ledger does not record the
--     spend until the journal lands. Seen live on Sharma Textiles, whose
--     23 Aug 2026 clearing journal settles a liability outstanding since
--     July. The liability side is unaffected (it is excluded either way).
--     post_gst_setoff's p_as_at makes dating the journal inside the period
--     it belongs to the natural choice; do that, and the two sides line up.
--   • TDS/TCS credit (Sec 51/52), interest and late fee stay 0 here — Table
--     5.1 (0225) owns interest and late fee, and Sec 51/52 is not modelled.
--
-- Return type gains six reconciliation columns plus a note, so DROP + CREATE
-- rather than CREATE OR REPLACE. Nothing holds a hard dependency on it:
-- get_gstr3b_table5_1 (0225) is plpgsql and resolves it by name at runtime,
-- and the two report pages read columns by name.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- app_private.gstr3b_period_setoff — the Sec 49/49A/49B + Rule 88A cascade
-- over EXPLICIT amounts.
-- ----------------------------------------------------------------------------
-- Same order of utilisation as app_private.gst_setoff_legs (0090), which is
-- deliberately NOT reused here: that function reads ledger balances itself
-- and cannot be given a period's own figures without changing what
-- /gst-setoff and post_gst_setoff do. This one takes the eight numbers and
-- nothing else. 0090's own verification of the order stands:
--   • Sec 49A — IGST credit must be exhausted before CGST or SGST credit is
--     touched at all; Rule 88A allows any order within that, and IGST-output
--     → CGST-output → SGST-output is this app's chosen sequence, not a
--     statutory one.
--   • Sec 49(5)(c)/(d) — CGST credit can never pay SGST output, or vice
--     versa.
--   • Compensation cess is its own lane in both directions (proviso to Sec
--     11 of the GST (Compensation to States) Act).
create or replace function app_private.gstr3b_period_setoff(
  p_out_cgst numeric, p_out_sgst numeric, p_out_igst numeric, p_out_cess numeric,
  p_in_cgst numeric,  p_in_sgst numeric,  p_in_igst numeric,  p_in_cess numeric
) returns table (
  tax_head text,
  util_igst numeric,
  util_cgst numeric,
  util_sgst numeric,
  util_cess numeric,
  net_payable numeric,
  credit_left numeric
)
language plpgsql
immutable
set search_path to ''
as $fn$
declare
  o_cgst numeric := greatest(0, coalesce(p_out_cgst, 0));
  o_sgst numeric := greatest(0, coalesce(p_out_sgst, 0));
  o_igst numeric := greatest(0, coalesce(p_out_igst, 0));
  o_cess numeric := greatest(0, coalesce(p_out_cess, 0));
  i_cgst numeric := greatest(0, coalesce(p_in_cgst, 0));
  i_sgst numeric := greatest(0, coalesce(p_in_sgst, 0));
  i_igst numeric := greatest(0, coalesce(p_in_igst, 0));
  i_cess numeric := greatest(0, coalesce(p_in_cess, 0));

  u_igst_by_igst numeric := 0;
  u_cgst_by_igst numeric := 0;
  u_sgst_by_igst numeric := 0;
  u_cgst_by_cgst numeric := 0;
  u_igst_by_cgst numeric := 0;
  u_sgst_by_sgst numeric := 0;
  u_igst_by_sgst numeric := 0;
  u_cess_by_cess numeric := 0;

  v_leg numeric;
begin
  -- IGST credit first, in full, before CGST/SGST credit is touched (Sec 49A).
  v_leg := least(i_igst, o_igst);
  u_igst_by_igst := v_leg; i_igst := i_igst - v_leg; o_igst := o_igst - v_leg;

  v_leg := least(i_igst, o_cgst);
  u_cgst_by_igst := v_leg; i_igst := i_igst - v_leg; o_cgst := o_cgst - v_leg;

  v_leg := least(i_igst, o_sgst);
  u_sgst_by_igst := v_leg; i_igst := i_igst - v_leg; o_sgst := o_sgst - v_leg;

  -- CGST credit: CGST output first (mandatory), remainder to IGST output.
  v_leg := least(i_cgst, o_cgst);
  u_cgst_by_cgst := v_leg; i_cgst := i_cgst - v_leg; o_cgst := o_cgst - v_leg;

  v_leg := least(i_cgst, o_igst);
  u_igst_by_cgst := v_leg; i_cgst := i_cgst - v_leg; o_igst := o_igst - v_leg;

  -- SGST credit: SGST output first (mandatory), remainder to IGST output.
  v_leg := least(i_sgst, o_sgst);
  u_sgst_by_sgst := v_leg; i_sgst := i_sgst - v_leg; o_sgst := o_sgst - v_leg;

  v_leg := least(i_sgst, o_igst);
  u_igst_by_sgst := v_leg; i_sgst := i_sgst - v_leg; o_igst := o_igst - v_leg;

  -- Cess: its own lane, never mixed with CGST/SGST/IGST in either direction.
  v_leg := least(i_cess, o_cess);
  u_cess_by_cess := v_leg; i_cess := i_cess - v_leg; o_cess := o_cess - v_leg;

  return query
  select t.tax_head, t.util_igst, t.util_cgst, t.util_sgst, t.util_cess, t.net_payable, t.credit_left
  from (
    values
      ('igst'::text, u_igst_by_igst, u_igst_by_cgst, u_igst_by_sgst, 0::numeric, o_igst, i_igst, 1),
      ('cgst'::text, u_cgst_by_igst, u_cgst_by_cgst, 0::numeric,     0::numeric, o_cgst, i_cgst, 2),
      ('sgst'::text, u_sgst_by_igst, 0::numeric,     u_sgst_by_sgst, 0::numeric, o_sgst, i_sgst, 3),
      ('cess'::text, 0::numeric,     0::numeric,     0::numeric,     u_cess_by_cess, o_cess, i_cess, 4)
  ) as t(tax_head, util_igst, util_cgst, util_sgst, util_cess, net_payable, credit_left, ord)
  order by t.ord;
end;
$fn$;

revoke all on function app_private.gstr3b_period_setoff(
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) from public, anon;
grant execute on function app_private.gstr3b_period_setoff(
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) to authenticated;

comment on function app_private.gstr3b_period_setoff(
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) is
  'Sec 49/49A/49B + Rule 88A ITC set-off cascade over explicit output and credit amounts, one row per tax head. Same utilisation order as app_private.gst_setoff_legs (0090) but reads nothing — used by get_gstr3b_table6_1 so a RETURN PERIOD can be set off without disturbing what /gst-setoff and post_gst_setoff do to the live control ledgers. Negative inputs are clamped to zero. See 1410.';

-- ----------------------------------------------------------------------------
-- public.get_gstr3b_table6_1 — Table 6.1 for ONE return period
-- ----------------------------------------------------------------------------
drop function if exists public.get_gstr3b_table6_1(uuid, uuid, date, date);

create function public.get_gstr3b_table6_1(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  tax_head text,
  tax_payable numeric,
  itc_igst_utilised numeric,
  itc_cgst_utilised numeric,
  itc_sgst_utilised numeric,
  itc_cess_utilised numeric,
  itc_total_utilised numeric,
  tds_tcs_credit numeric,
  cash_tax_payable numeric,
  interest_payable numeric,
  late_fee_payable numeric,
  output_brought_forward numeric,
  itc_opening numeric,
  itc_period_gross numeric,
  itc_period_reversal numeric,
  itc_available numeric,
  itc_balance_carried_forward numeric,
  note text
)
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_l_out_cgst uuid; v_l_out_sgst uuid; v_l_out_igst uuid; v_l_out_cess uuid;
  v_l_in_cgst uuid;  v_l_in_sgst uuid;  v_l_in_igst uuid;  v_l_in_cess uuid;

  v_bf_cgst numeric; v_bf_sgst numeric; v_bf_igst numeric; v_bf_cess numeric;
  v_out_cgst numeric; v_out_sgst numeric; v_out_igst numeric; v_out_cess numeric;
  v_open_cgst numeric; v_open_sgst numeric; v_open_igst numeric; v_open_cess numeric;
  v_gross_cgst numeric; v_gross_sgst numeric; v_gross_igst numeric; v_gross_cess numeric;
  v_r37_cgst numeric; v_r37_sgst numeric; v_r37_igst numeric; v_r37_cess numeric;
  v_rev_cgst numeric; v_rev_sgst numeric; v_rev_igst numeric; v_rev_cess numeric;
  v_avail_cgst numeric; v_avail_sgst numeric; v_avail_igst numeric; v_avail_cess numeric;

  v_gross_total numeric;
  v_residue numeric;
  v_t4 record;
  v_note text;
begin
  select ledger_id into v_l_out_cgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_cgst';
  select ledger_id into v_l_out_sgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_sgst';
  select ledger_id into v_l_out_igst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_igst';
  select ledger_id into v_l_out_cess from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_cess';
  select ledger_id into v_l_in_cgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_cgst';
  select ledger_id into v_l_in_sgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_sgst';
  select ledger_id into v_l_in_igst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_igst';
  select ledger_id into v_l_in_cess from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_cess';

  if v_l_out_cgst is null or v_l_in_cgst is null then
    raise exception
      'No GST control ledgers found for this registration. They are seeded automatically when a GST registration is added — check the registration exists for this company.';
  end if;

  -- (1) Liability left over from BEFORE this period. Informational only: it
  -- belongs to an earlier return, and folding it into this one is the very
  -- bug this migration fixes. Shown so it is visible, not silently netted.
  v_bf_cgst := greatest(0, -app_private.ledger_opening_signed(p_company_id, v_l_out_cgst, p_period_start, null));
  v_bf_sgst := greatest(0, -app_private.ledger_opening_signed(p_company_id, v_l_out_sgst, p_period_start, null));
  v_bf_igst := greatest(0, -app_private.ledger_opening_signed(p_company_id, v_l_out_igst, p_period_start, null));
  v_bf_cess := greatest(0, -app_private.ledger_opening_signed(p_company_id, v_l_out_cess, p_period_start, null));

  -- (2) THIS period's own output tax, net of this period's credit notes,
  -- excluding set-off clearing journals (see migration header for the test).
  with cand as (
    select distinct e.voucher_id
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date between p_period_start and p_period_end
       and e.ledger_id in (v_l_out_cgst, v_l_out_sgst, v_l_out_igst, v_l_out_cess)
  ),
  entries as (
    -- One row per voucher line, flagged for whether that line sits on a tax
    -- control ledger. A subquery, not a join to tax_ledger_map, so a ledger
    -- mapped under more than one purpose cannot duplicate the line and skew
    -- the out_net sign test below.
    select e.voucher_id, e.ledger_id, e.credit_amount, e.debit_amount,
           (e.ledger_id in (select m.ledger_id from public.tax_ledger_map m
                             where m.company_id = p_company_id)) as is_tax
      from public.voucher_entries e
      join cand c on c.voucher_id = e.voucher_id
     where e.company_id = p_company_id
  ),
  flags as (
    select voucher_id,
           bool_and(is_tax) as tax_only,
           sum(case when ledger_id in (v_l_out_cgst, v_l_out_sgst, v_l_out_igst, v_l_out_cess)
                    then credit_amount - debit_amount else 0 end) as out_net
      from entries
     group by voucher_id
  ),
  kept as (
    select voucher_id from flags where not (tax_only and out_net < 0)
  )
  select
    coalesce(sum(case when e.ledger_id = v_l_out_cgst then e.credit_amount - e.debit_amount else 0 end), 0),
    coalesce(sum(case when e.ledger_id = v_l_out_sgst then e.credit_amount - e.debit_amount else 0 end), 0),
    coalesce(sum(case when e.ledger_id = v_l_out_igst then e.credit_amount - e.debit_amount else 0 end), 0),
    coalesce(sum(case when e.ledger_id = v_l_out_cess then e.credit_amount - e.debit_amount else 0 end), 0)
    into v_out_cgst, v_out_sgst, v_out_igst, v_out_cess
    from public.voucher_entries e
    join kept k on k.voucher_id = e.voucher_id
   where e.company_id = p_company_id
     and e.ledger_id in (v_l_out_cgst, v_l_out_sgst, v_l_out_igst, v_l_out_cess);

  -- (3) This period's GROSS ITC per head — the same source get_gstr3b_table4
  -- builds its A(5) row from, so the two tables cannot disagree.
  select coalesce(sum(r.cgst), 0), coalesce(sum(r.sgst), 0),
         coalesce(sum(r.igst), 0), coalesce(sum(r.cess), 0)
    into v_gross_cgst, v_gross_sgst, v_gross_igst, v_gross_cess
    from public.get_gst_input_register(p_company_id, p_period_start, p_period_end, p_gst_registration_id) r;

  -- (4) Table 4 itself, for the authoritative 4(B) reversal totals.
  select * into v_t4
    from public.get_gstr3b_table4(p_company_id, p_gst_registration_id, p_period_start, p_period_end);

  -- (5) Rule 37 per head, over exactly the window Table 4's B(2) uses.
  select
    coalesce(sum(r.itc_cgst * r.reversal_itc / nullif(r.itc_total, 0)), 0),
    coalesce(sum(r.itc_sgst * r.reversal_itc / nullif(r.itc_total, 0)), 0),
    coalesce(sum(r.itc_igst * r.reversal_itc / nullif(r.itc_total, 0)), 0),
    coalesce(sum(r.itc_cess * r.reversal_itc / nullif(r.itc_total, 0)), 0)
    into v_r37_cgst, v_r37_sgst, v_r37_igst, v_r37_cess
    from public.get_itc_180day_reversal(p_company_id, p_period_end) r
   where r.voucher_date between (p_period_start - 181) and (p_period_end - 181);

  -- (6) 4(B) split per head: Rule 42 exact, Rule 37 exact, Sec 17(5) blocked
  -- pro-rated by this period's own ITC mix (no per-head split exists).
  v_gross_total := v_gross_cgst + v_gross_sgst + v_gross_igst + v_gross_cess;
  v_rev_cgst := round(coalesce(v_t4.b1_rule42_reversal_cgst, 0) + v_r37_cgst
    + coalesce(v_t4.b1_sec17_5_blocked, 0) * (case when v_gross_total = 0 then 0 else v_gross_cgst / v_gross_total end), 2);
  v_rev_sgst := round(coalesce(v_t4.b1_rule42_reversal_sgst, 0) + v_r37_sgst
    + coalesce(v_t4.b1_sec17_5_blocked, 0) * (case when v_gross_total = 0 then 0 else v_gross_sgst / v_gross_total end), 2);
  v_rev_igst := round(coalesce(v_t4.b1_rule42_reversal_igst, 0) + v_r37_igst
    + coalesce(v_t4.b1_sec17_5_blocked, 0) * (case when v_gross_total = 0 then 0 else v_gross_igst / v_gross_total end), 2);
  v_rev_cess := round(coalesce(v_t4.b1_rule42_reversal_cess, 0) + v_r37_cess
    + coalesce(v_t4.b1_sec17_5_blocked, 0) * (case when v_gross_total = 0 then 0 else v_gross_cess / v_gross_total end), 2);

  -- Force the four heads to sum to Table 4's own B total, to the paisa. The
  -- residue is rounding, and it lands on the head carrying the most ITC.
  v_residue := round(coalesce(v_t4.b_total, 0), 2) - (v_rev_cgst + v_rev_sgst + v_rev_igst + v_rev_cess);
  if v_residue <> 0 then
    if v_gross_igst >= greatest(v_gross_cgst, v_gross_sgst, v_gross_cess) then
      v_rev_igst := v_rev_igst + v_residue;
    elsif v_gross_cgst >= greatest(v_gross_sgst, v_gross_cess) then
      v_rev_cgst := v_rev_cgst + v_residue;
    elsif v_gross_sgst >= v_gross_cess then
      v_rev_sgst := v_rev_sgst + v_residue;
    else
      v_rev_cess := v_rev_cess + v_residue;
    end if;
  end if;

  -- (7) Electronic credit ledger: balance brought forward + this period's
  -- net ITC (4(A) gross − 4(B) reversal), per CBIC Circular 170/02/2022-GST.
  v_open_cgst := greatest(0, app_private.ledger_opening_signed(p_company_id, v_l_in_cgst, p_period_start, null));
  v_open_sgst := greatest(0, app_private.ledger_opening_signed(p_company_id, v_l_in_sgst, p_period_start, null));
  v_open_igst := greatest(0, app_private.ledger_opening_signed(p_company_id, v_l_in_igst, p_period_start, null));
  v_open_cess := greatest(0, app_private.ledger_opening_signed(p_company_id, v_l_in_cess, p_period_start, null));

  v_avail_cgst := greatest(0, v_open_cgst + v_gross_cgst - v_rev_cgst);
  v_avail_sgst := greatest(0, v_open_sgst + v_gross_sgst - v_rev_sgst);
  v_avail_igst := greatest(0, v_open_igst + v_gross_igst - v_rev_igst);
  v_avail_cess := greatest(0, v_open_cess + v_gross_cess - v_rev_cess);

  v_note :=
    'Tax payable is THIS return period''s own output tax (movement on the output control ledgers between the '
    || 'period dates, net of the period''s credit notes), not a running balance — an earlier period''s '
    || 'uncleared liability is shown separately as "brought forward" and is that return''s problem, never '
    || 'reported again here. Set-off clearing journals posted by post_gst_setoff are excluded from the '
    || 'movement (every line a tax control ledger, output net a debit), so preparing the return before '
    || 'posting the set-off gives the same figures as after — but date each period''s set-off journal INSIDE '
    || 'that period, or the credit brought forward here still contains credit an earlier return already spent. '
    || 'Credit available = electronic-credit-ledger '
    || 'balance brought forward + this period''s NET ITC, i.e. Table 4(A) gross less the whole of Table 4(B) '
    || '— per CBIC Circular 170/02/2022-GST only 4(C) is credited to that ledger. Rule 42 and Rule 37 '
    || 'reversals are split per head from their own source figures; Sec 17(5) blocked credit has no per-head '
    || 'split anywhere in this schema and is apportioned by this period''s gross ITC mix, with rounding '
    || 'residue forced onto the largest head so the four heads always sum to Table 4''s own B total. '
    || 'Reverse-charge liability is NOT included in tax payable (Sec 49(4) makes it cash-only and LEKHA '
    || 'reports it as a Table 4 memo instead). Reversals are computed, never posted to the input ledgers, so '
    || 'an earlier period''s unposted reversal still sits in the brought-forward credit. Sec 51/52 GST '
    || 'TDS/TCS credit is not modelled and reads 0; interest and late fee live in Table 5.1. A negative tax '
    || 'payable (credit notes outrunning sales) is reported as it stands and consumes no credit — GSTN will '
    || 'not accept a negative liability, and carrying the excess forward is not modelled here.';

  return query
  with heads(tax_head, ord, payable, bf, itc_open, gross, rev, avail) as (
    values
      ('igst'::text, 1, round(v_out_igst, 2), round(v_bf_igst, 2), round(v_open_igst, 2), round(v_gross_igst, 2), v_rev_igst, round(v_avail_igst, 2)),
      ('cgst'::text, 2, round(v_out_cgst, 2), round(v_bf_cgst, 2), round(v_open_cgst, 2), round(v_gross_cgst, 2), v_rev_cgst, round(v_avail_cgst, 2)),
      ('sgst'::text, 3, round(v_out_sgst, 2), round(v_bf_sgst, 2), round(v_open_sgst, 2), round(v_gross_sgst, 2), v_rev_sgst, round(v_avail_sgst, 2)),
      ('cess'::text, 4, round(v_out_cess, 2), round(v_bf_cess, 2), round(v_open_cess, 2), round(v_gross_cess, 2), v_rev_cess, round(v_avail_cess, 2))
  )
  select
    h.tax_head,
    h.payable,
    round(s.util_igst, 2),
    round(s.util_cgst, 2),
    round(s.util_sgst, 2),
    round(s.util_cess, 2),
    round(s.util_igst + s.util_cgst + s.util_sgst + s.util_cess, 2),
    -- Sec 51/52 GST TDS/TCS — a different mechanism from income-tax TDS/TCS
    -- and not modelled anywhere in this schema. Always 0, as in 0129.
    0::numeric,
    round(s.net_payable, 2),
    -- Table 5.1 (0225) owns interest and late fee. Always 0 here, as in 0129.
    0::numeric,
    0::numeric,
    h.bf,
    h.itc_open,
    h.gross,
    h.rev,
    h.avail,
    round(s.credit_left, 2),
    v_note
  from heads h
  join app_private.gstr3b_period_setoff(
         greatest(0, v_out_cgst), greatest(0, v_out_sgst),
         greatest(0, v_out_igst), greatest(0, v_out_cess),
         v_avail_cgst, v_avail_sgst, v_avail_igst, v_avail_cess
       ) s on s.tax_head = h.tax_head
  order by h.ord;
end;
$fn$;

revoke all on function public.get_gstr3b_table6_1(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gstr3b_table6_1(uuid, uuid, date, date) to authenticated;

comment on function public.get_gstr3b_table6_1(uuid, uuid, date, date) is
  'GSTR-3B Table 6.1 (payment of tax) for ONE return period. tax_payable is that period''s own output tax — movement on the output control ledgers between the period dates, net of the period''s credit notes, excluding post_gst_setoff clearing journals — NOT a cumulative balance (the 0129 behaviour, which re-reported every earlier month''s uncleared liability in every later return). ITC available = electronic-credit-ledger balance brought forward + this period''s NET ITC (Table 4(A) less the whole of Table 4(B)), per CBIC Circular 170/02/2022-GST; the 0129 version utilised gross ITC and so contradicted Table 4 on the same screen. Set-off order is Sec 49A / Rule 88A via app_private.gstr3b_period_setoff. Reverse-charge liability, Sec 51/52 TDS/TCS credit, interest and late fee are all still out of scope here — see the note column and 1410.';
