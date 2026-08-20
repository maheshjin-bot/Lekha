-- ============================================================================
-- 0053 — TDS deductee-wise summary, the Form 140 (was 26Q) Annexure I
--         precursor GST already has an equivalent for (0051 GSTR-1 HSN/B2B)
-- ============================================================================
-- Unlike GST, there is no clean per-line structure to build this from. GST's
-- create_invoice posts output_cgst/sgst/igst/cess to their own PURPOSE-tagged
-- ledgers per line, joinable back to voucher_items with no ambiguity. TDS has
-- no equivalent: voucher_entries carries no tds_section or deductee-PAN
-- column, and the app's own splitLineForTds() UI (VoucherForm.tsx) records
-- which section was applied only as free-text narration on the auto-inserted
-- TDS line ("TDS 194C") — not a structured, queryable fact.
--
-- WHAT THIS FUNCTION DOES, PRECISELY: for every voucher with a line crediting
-- the company's TDS Payable ledger (tax_ledger_map purpose = 'tds_payable',
-- credit side only — debit-side lines on that ledger are the LATER payment
-- to the government, a different event, correctly excluded), it looks at the
-- OTHER lines in that SAME voucher for exactly one ledger flagged
-- ledgers.is_tds_deductee. If there is exactly one, the TDS is attributed to
-- that deductee, using THAT LEDGER'S CURRENT default_tds_section/pan — not
-- necessarily what was true on the historical voucher date, same caveat
-- already accepted for 0051's HSN summary rate. If a voucher has zero or
-- more than one deductee-flagged ledger on it, attribution is genuinely
-- ambiguous and the amount is bucketed under a explicit "(unattributed)"
-- row rather than guessed — a business's own review is needed for those,
-- exactly the same "candidate, not authoritative" framing already used for
-- Sec 40A(3)/40A(2)(b)/269SS/269T and the Sec 192 salary TDS estimate.
--
-- NOT ATTEMPTED, documented rather than silently guessed:
--  * The "amount paid or credited" Annexure I column is NOT computed as a
--    gross invoice value — that would require assuming every TDS voucher is
--    structured as exactly Dr Expense / Cr Party (net) / Cr TDS Payable,
--    which this schema does not enforce. Instead this returns the deductee
--    ledger's own actual line movement in the same voucher(s) — labelled as
--    exactly that, not as "gross" — so it can never overclaim a figure the
--    data doesn't actually support.
--  * Section-wise validation against ref_tds_sections' threshold columns
--    (has this deductee crossed the threshold that makes TDS applicable at
--    all) is not attempted — that needs cumulative-deductee-level tracking
--    across the whole year, a separate, larger piece.
--  * No challan/remittance-wise detail (BSR code, challan number, deposit
--    date) — LEKHA does not track TDS payment challans as distinct records.
-- ============================================================================


create or replace function public.get_tds_deductee_summary(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  deductee_ledger_id uuid,
  deductee_name text,
  pan text,
  section_code text,
  section_description text,
  section_rate_percent numeric,
  voucher_count integer,
  tds_deducted numeric,
  party_ledger_movement numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tds_lines as (
    -- Deduction events only (credit side) — a debit-side line on the same
    -- ledger is a later payment to the government, not a new deduction.
    select e.voucher_id, sum(e.credit_amount) as tds_amount
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
      join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
     where e.company_id = p_company_id
       and m.purpose = 'tds_payable'
       and e.credit_amount > 0
       and not v.is_deleted
       and v.voucher_date between p_period_start and p_period_end
     group by e.voucher_id
  ),
  deductee_candidates as (
    select e.voucher_id, e.ledger_id,
           abs(e.credit_amount - e.debit_amount) as movement
      from public.voucher_entries e
      join public.ledgers l on l.id = e.ledger_id and l.company_id = e.company_id
      join tds_lines t on t.voucher_id = e.voucher_id
     where e.company_id = p_company_id
       and l.is_tds_deductee
  ),
  -- Exactly one distinct deductee-flagged ledger on the voucher -> that's
  -- the deductee. Zero or more than one -> genuinely ambiguous, not guessed.
  voucher_deductee as (
    select dc.voucher_id,
           -- uuid has no min()/max() aggregate; array_agg(distinct ...)[1]
           -- is only reached when the distinct count is exactly 1, so which
           -- element is picked never matters — there's only ever one.
           case when count(distinct dc.ledger_id) = 1
                then (array_agg(distinct dc.ledger_id))[1] end as deductee_ledger_id,
           sum(dc.movement) as party_ledger_movement
      from deductee_candidates dc
     group by dc.voucher_id
  ),
  attributed as (
    select
      t.voucher_id,
      t.tds_amount,
      vd.deductee_ledger_id,
      coalesce(vd.party_ledger_movement, 0) as party_ledger_movement
      from tds_lines t
      left join voucher_deductee vd on vd.voucher_id = t.voucher_id
  )
  select
    l.id as deductee_ledger_id,
    coalesce(l.name, '(unattributed — voucher had zero or multiple TDS-deductee-flagged ledgers)') as deductee_name,
    l.pan,
    l.default_tds_section as section_code,
    s.description as section_description,
    s.rate_percent as section_rate_percent,
    count(*)::integer as voucher_count,
    sum(a.tds_amount) as tds_deducted,
    sum(a.party_ledger_movement) as party_ledger_movement
    from attributed a
    left join public.ledgers l on l.id = a.deductee_ledger_id
    left join public.ref_tds_sections s on s.section_code = l.default_tds_section
   group by l.id, l.name, l.pan, l.default_tds_section, s.description, s.rate_percent
   order by (l.id is null), s.description nulls last, l.name nulls last;
$$;

comment on function public.get_tds_deductee_summary is
  'Form 140 (was 26Q) Annexure I precursor: TDS deducted (credit-side movement on the TDS Payable ledger only, not payment/remittance debits) attributed to a deductee when exactly one ledgers.is_tds_deductee ledger appears on the same voucher. Section/PAN reflect that ledger''s CURRENT master data, not necessarily what applied historically. Vouchers with zero or multiple candidate deductee ledgers are grouped under a null/"(unattributed)" row rather than guessed. party_ledger_movement is the deductee ledger''s own actual line movement in the same voucher(s) — not a computed gross invoice value. Not a filing-ready return, and nothing here is submitted anywhere — LEKHA has no TRACES API access.';
