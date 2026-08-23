-- ============================================================================
-- 0096 — Rule 37 (180-day) ITC reversal report
-- ============================================================================
-- THE RULE, CONFIRMED LIVE (22-23 Aug 2026) RATHER THAN RECALLED. The second
-- proviso to Sec 16(2) of the CGST Act says a registered person who has
-- availed ITC on an inward supply but fails to pay the supplier the invoice
-- value — including tax — within 180 days of the invoice date must pay an
-- amount equal to the ITC availed, plus interest under Sec 50, "in such
-- manner as may be prescribed". Rule 37 is that manner. Four points were
-- checked against live sources rather than assumed, because this rule has
-- been amended before and this codebase has been burnt by the "obvious"
-- answer once already (see 0087's deemed-export note):
--
--   1. PROPORTIONATE, NOT WHOLE-INVOICE. Sub-rules (1)-(2) of Rule 37 were
--      substituted w.e.f. 1 Oct 2022 (Notification 19/2022-CT), and
--      Notification 26/2022-CT (26 Dec 2022, same effective date) inserted
--      "proportionate to the amount not paid to the supplier". A partial
--      payment within 180 days means only the UNPAID FRACTION of that
--      invoice's ITC is reversed, not the whole thing. Confirmed against the
--      CBIC rule text itself (taxinformation.cbic.gov.in) and cross-checked
--      against ClearTax/Vakilsearch/Refrens, all agreeing. This report
--      applies that fraction: reversal_itc = itc_total * (outstanding /
--      invoice_value).
--
--   2. INTEREST RATE IS 18% p.a. UNDER SEC 50(1) — not the 24% rate under
--      Sec 50(3), which is reserved for ITC that was wrongly availed AND
--      utilised (a fraud/error fact pattern), not for a legitimate ITC claim
--      that later falls foul of the payment deadline. Every source checked
--      (mybillbook, TaxGuru, CAclubindia) agrees on 18%.
--
--   3. INTEREST START DATE IS GENUINELY CONTESTED, AND SAID SO HERE RATHER
--      THAN PICKED SILENTLY. The old Rule 37(3) — before it was OMITTED by
--      the same 1 Oct 2022 amendment — said explicitly: interest runs "from
--      the date of availing credit on such supplies till the date when the
--      amount added to the output tax liability... is paid". Sub-rule (3)
--      no longer exists; the amended rule just points at Sec 50 generally,
--      and practitioners are split on whether that silently reverts interest
--      to running only from the 181st day (treating Rule 37 as ordinary
--      belated-payment-of-tax interest) or whether the pre-2022 logic still
--      governs in substance (ITC was conditional from day one, so the
--      credit was irregular from the date it was taken, not from day 181).
--      TaxGuru's practitioner guidance and CAclubindia's own analysis both
--      land on the SAME practical answer: "the safer and legally stronger
--      approach is to compute interest from the date of availment" — because
--      that is what the only sub-rule that ever spelled out a mechanism
--      actually said, and no replacement mechanism has been notified. This
--      report follows that majority position: interest runs from the
--      invoice's own voucher_date (the date this app posts input tax, i.e.
--      the date ITC was recorded as availed — LEKHA has no separate
--      "claimed in GSTR-3B on this date" field) to p_as_at. The day-181
--      alternative is a real, held position among practitioners and is
--      recorded here rather than hidden, in case a future filing needs to
--      switch — this is an interpretive choice, not a certainty.
--
--   4. RE-AVAILMENT, ONCE PAID, IS NOT TIME-BARRED under Sec 16(4) — not
--      built here since this is a report, but worth knowing the reversal is
--      not a permanent loss once the supplier is actually paid.
--
-- WHAT THE RULE EXCLUDES, AND WHY THIS REPORT CANNOT HONOUR ALL OF IT.
-- Rule 37(1) itself carves out reverse-charge supplies (the recipient pays
-- RCM tax straight to the government, never "to the supplier", so the
-- non-payment fact pattern cannot arise) and deems Schedule I
-- without-consideration supplies, and amounts added under Sec 15(2)(b), as
-- already paid. LEKHA has NO per-voucher flag for "this purchase is on
-- reverse charge" — confirmed by grep: tax_ledger_map's rcm_payable purpose
-- exists as a seeded ledger (0006) but no posting function (create_invoice
-- included) ever writes to it, so there is no data point this report could
-- read to exclude an RCM purchase. Said here rather than silently
-- overreported: a company with genuine RCM purchases will see them included
-- in this report's reversal figures, which overstates the true Rule 37
-- exposure. Schedule I / Sec 15(2)(b) deemed-paid cases have no
-- representation in the schema either (every purchase voucher here carries
-- a real party-ledger value) and are not expected to matter for typical
-- inward supplies, so they are not separately called out per row.
--
-- PER-INVOICE, NOT PER-PARTY — REUSING get_party_outstanding's (0017) FIFO
-- LOGIC, ADAPTED TO A FINER GRAIN. 0017 already answers "how much does this
-- app believe remains unpaid", the same question Rule 37 needs, applied
-- against the same absence of bill-wise allocation (LEKHA has no receipt
-- pointing at the specific invoice(s) it settles — see 0017's own header).
-- Rather than re-deriving a competing outstanding calculation and risking a
-- second, disagreeing answer to the same question, this migration runs the
-- IDENTICAL assumption — payments (and debit notes, and any other reduction
-- to what is owed) are applied to the OLDEST charge first — except at
-- INVOICE grain instead of per-ledger-entry-row grain. 0017 ages each
-- voucher_entries row independently, which is immaterial when only a
-- per-party total and per-party ageing bucket is wanted; it is NOT
-- immaterial here, where the report needs to say WHICH invoice is unpaid.
-- So this migration groups a voucher's own postings to the party ledger
-- into one charge PER VOUCHER before ranking and applying payments — one
-- invoice, one clock, exactly as Rule 37 itself frames it ("from the date
-- of issue of invoice"). Every OTHER kind of charge to the same creditor
-- ledger (journal entries booking a liability, debit notes reducing one)
-- still participates in the same FIFO ordering as 0017 does — a payment
-- made against an older journal-booked liability is still money the
-- supplier actually received, and correctly reduces what is left for a
-- later purchase invoice to still be owed on.
--
-- ONLY 'purchase' vouchers are reported, even though other charge types
-- share the FIFO pool: a journal entry booking a liability is not an
-- invoice with a GST-input-tax line and does not start a Rule 37 clock, so
-- it is aged (it affects ordering) but never itself shown as a row.
--
-- ITC PER INVOICE — REUSING get_gst_input_register's (0035) JOIN PATTERN,
-- READ-ONLY. The exact same tax_ledger_map join by purpose
-- (input_cgst/sgst/igst/cess) that 0035 already uses to attribute posted
-- tax to a purchase voucher is repeated here rather than modified in place
-- — 0035 is untouched, this migration only reads the same shape.
--
-- ROWS WITH ZERO ITC ARE EXCLUDED. If a purchase voucher never posted any
-- input tax (GST was not active for the company at that date, or the item
-- was nil-rated/exempt), there is nothing for Rule 37 to reverse on that
-- invoice — it may still be a genuinely old unpaid bill, but that fact is
-- already reported by /reports/outstanding, and listing it here with a
-- permanent reversal_itc of zero would just be noise in a report whose
-- entire purpose is ITC exposure.
--
-- REPORT ONLY, NO POSTING RPC — THE SAME SHAPE AS ITC-04 PREP (0072).
-- Actually posting the reversal as a real journal entry (Dr Input
-- CGST/SGST/IGST/Cess reversal, Cr Output tax or a dedicated reversal
-- ledger, per company's chart) is a natural next step, structurally similar
-- to what post_gst_setoff (0090) already does for the set-off journal — but
-- it is deliberately out of scope for this migration, exactly as ITC-04
-- shipped as a report before job work had any posting logic behind it.
-- ============================================================================

create or replace function public.get_itc_180day_reversal(
  p_company_id uuid,
  p_as_at date default current_date
)
returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  party_name text,
  invoice_value numeric,
  outstanding_amount numeric,
  itc_cgst numeric,
  itc_sgst numeric,
  itc_igst numeric,
  itc_cess numeric,
  itc_total numeric,
  days_overdue integer,
  reversal_itc numeric,
  interest_amount numeric,
  total_reversal_due numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with party as (
    select l.id as ledger_id
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id and g.ledger_role = 'creditor'
  ),
  -- Same signed convention as get_party_outstanding for role='creditor': a
  -- credit entry increases what is owed.
  moves as (
    select e.voucher_id, e.ledger_id, (e.credit_amount - e.debit_amount) as delta
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
      join party p on p.ledger_id = e.ledger_id
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
  ),
  -- Collapse every posting a single voucher made to the party ledger into
  -- one charge — the adaptation from 0017's per-entry-row grain to
  -- per-invoice grain that this report needs. See migration header.
  charges as (
    select voucher_id, ledger_id, sum(delta) as delta
      from moves
     group by voucher_id, ledger_id
  ),
  dated_charges as (
    select c.voucher_id, c.ledger_id, c.delta, v.voucher_date, v.voucher_number
      from charges c
      join public.vouchers v on v.id = c.voucher_id
  ),
  payments as (
    select ledger_id, sum(-delta) as paid
      from dated_charges
     where delta < 0
     group by ledger_id
  ),
  ranked as (
    select voucher_id, ledger_id, voucher_date, delta,
           sum(delta) over (partition by ledger_id order by voucher_date, voucher_number
                             rows between unbounded preceding and current row) as running
      from dated_charges
     where delta > 0
  ),
  -- What remains of each invoice-level charge once the running total of
  -- every reduction (payments, debit notes, anything else) has been applied
  -- to everything older than it — identical arithmetic to 0017's `aged`.
  aged as (
    select r.voucher_id, r.ledger_id, r.voucher_date, r.delta as invoice_value,
           greatest(0, least(r.delta, r.running - coalesce(p.paid, 0))) as outstanding_amount
      from ranked r
      left join payments p on p.ledger_id = r.ledger_id
  ),
  -- Same join pattern get_gst_input_register (0035) uses to attribute
  -- posted input tax to a purchase voucher, read-only reuse.
  tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'input_cgst' then e.debit_amount - e.credit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'input_sgst' then e.debit_amount - e.credit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'input_igst' then e.debit_amount - e.credit_amount else 0 end) as igst,
           sum(case when m.purpose = 'input_cess' then e.debit_amount - e.credit_amount else 0 end) as cess
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
     where e.company_id = p_company_id
       and m.purpose in ('input_cgst', 'input_sgst', 'input_igst', 'input_cess')
     group by e.voucher_id
  ),
  computed as (
    select
      a.voucher_id, v.voucher_number, v.voucher_date, l.name as party_name,
      a.invoice_value, a.outstanding_amount,
      coalesce(t.cgst, 0) as itc_cgst, coalesce(t.sgst, 0) as itc_sgst,
      coalesce(t.igst, 0) as itc_igst, coalesce(t.cess, 0) as itc_cess,
      (coalesce(t.cgst, 0) + coalesce(t.sgst, 0) + coalesce(t.igst, 0) + coalesce(t.cess, 0)) as itc_total_raw,
      (p_as_at - v.voucher_date) as days_overdue
    from aged a
    join public.vouchers v on v.id = a.voucher_id
    join public.ledgers l on l.id = a.ledger_id
    left join tax t on t.voucher_id = a.voucher_id
   where a.outstanding_amount > 0
     and v.voucher_type = 'purchase'
     -- strictly more than 180 days, per "within 180 days" being the safe harbour
     and (p_as_at - v.voucher_date) > 180
  ),
  final as (
    select *,
           itc_total_raw * (outstanding_amount / nullif(invoice_value, 0)) as reversal_itc_raw
      from computed
     where itc_total_raw > 0
  )
  select
    voucher_id, voucher_number, voucher_date, party_name,
    round(invoice_value, 2), round(outstanding_amount, 2),
    round(itc_cgst, 2), round(itc_sgst, 2), round(itc_igst, 2), round(itc_cess, 2),
    round(itc_total_raw, 2),
    days_overdue::integer,
    round(reversal_itc_raw, 2) as reversal_itc,
    round(reversal_itc_raw * 0.18 * days_overdue / 365.0, 2) as interest_amount,
    -- Both addends already rounded, then summed — not the other way round —
    -- so a reader adding the two displayed columns gets exactly this figure.
    round(reversal_itc_raw, 2) + round(reversal_itc_raw * 0.18 * days_overdue / 365.0, 2) as total_reversal_due
  from final
  order by voucher_date, voucher_number;
$$;

revoke all on function public.get_itc_180day_reversal(uuid, date) from public, anon;
grant execute on function public.get_itc_180day_reversal(uuid, date) to authenticated;

comment on function public.get_itc_180day_reversal is
  'Rule 37 / second proviso to Sec 16(2): purchase invoices more than 180 days old as at p_as_at with an outstanding balance (per-invoice FIFO ageing, adapted from get_party_outstanding/0017), the ITC availed on that invoice (read back from postings via the same join get_gst_input_register/0035 uses), the proportionate reversal on the unpaid share, and interest at 18% p.a. under Sec 50(1) from the invoice date (this app''s own ITC-availment date) to p_as_at. Cannot exclude reverse-charge purchases — LEKHA has no per-voucher RCM flag. Report only; no posting RPC. See 0096.';
