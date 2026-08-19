-- ============================================================================
-- 0035 — GST registers: the output and input tax registers, source data for
--         GSTR-1/3B filing prep
-- ============================================================================
-- The single highest-leverage gap left in P5 GST (per the roadmap's own
-- framing: GST is the most frequent obligation of anything in the register)
-- is filing — but filing itself needs real GSTN API credentials this app
-- does not have. What IS buildable without that: the two registers a
-- business or its CA actually reads FROM to prepare a return by hand today,
-- reconstructed from data create_invoice (0018) already posts correctly.
--
-- Output register = outward supplies (sales + credit notes), the GSTR-1
-- source data. Input register = inward supplies (purchases + debit notes),
-- the GSTR-3B ITC source data. Both are per-voucher rows, not a filing-ready
-- JSON — that translation step (B2B/B2C bifurcation into GSTN's exact table
-- structure, HSN summary, nil-rated/exempt bifurcation) is real, separate
-- work this does not attempt. See the report page for the full list of cuts.
--
-- SIGN CONVENTION: a credit note (output side) or debit note (input side) is
-- shown with its OWN row, taxable value and tax NEGATIVE — not netted away
-- silently, and not shown as a positive figure that would double-count when
-- a reader sums the column for a period total. This differs from GSTN's own
-- GSTR-1 Table 9B, which reports a credit note's value as positive with the
-- bifurcation done in the return's own summary math — a deliberate choice
-- here, so summing this register's columns directly gives the correct net
-- figure without the reader needing to know GSTN's own netting rules.
--
-- TAX FIGURES READ BACK FROM ACTUAL POSTINGS, not recomputed from rates —
-- summed per voucher from voucher_entries joined through tax_ledger_map by
-- purpose, the same source of truth get_dashboard_kpis' gst_liability
-- already reads (0031). A voucher with a genuinely zero-rated or exempt line
-- (no tax posted at all) still appears via the LEFT JOIN, with zero tax —
-- dropping it would misrepresent a real nil-rated supply as never having
-- happened.
--
-- REGISTRATION FILTER reuses app_private.branch_registration (0005) — the
-- exact function create_invoice itself calls to resolve which GSTIN a
-- voucher belongs to — rather than re-deriving that logic here and risking
-- drift from the posting side.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_gst_output_register(company, period_start, period_end, registration)
-- ----------------------------------------------------------------------------
create or replace function public.get_gst_output_register(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
) returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  voucher_type text,
  party_name text,
  party_gstin text,
  place_of_supply char(2),
  supply_type text,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric,
  invoice_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'output_cgst' then e.credit_amount - e.debit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'output_sgst' then e.credit_amount - e.debit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'output_igst' then e.credit_amount - e.debit_amount else 0 end) as igst,
           sum(case when m.purpose = 'output_cess' then e.credit_amount - e.debit_amount else 0 end) as cess
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
     where e.company_id = p_company_id
       and m.purpose in ('output_cgst', 'output_sgst', 'output_igst', 'output_cess')
     group by e.voucher_id
  ),
  taxable as (
    select vi.voucher_id, sum(vi.amount) as amt
      from public.voucher_items vi
     where vi.company_id = p_company_id
     group by vi.voucher_id
  )
  select
    v.id, v.voucher_number, v.voucher_date, v.voucher_type,
    l.name, l.gstin, v.place_of_supply, v.supply_type,
    case when v.voucher_type = 'credit_note' then -coalesce(t.amt, 0) else coalesce(t.amt, 0) end,
    coalesce(tx.cgst, 0), coalesce(tx.sgst, 0), coalesce(tx.igst, 0), coalesce(tx.cess, 0),
    (case when v.voucher_type = 'credit_note' then -coalesce(t.amt, 0) else coalesce(t.amt, 0) end)
      + coalesce(tx.cgst, 0) + coalesce(tx.sgst, 0) + coalesce(tx.igst, 0) + coalesce(tx.cess, 0)
  from public.vouchers v
  left join tax tx on tx.voucher_id = v.id
  left join taxable t on t.voucher_id = v.id
  left join public.ledgers l on l.id = v.party_ledger_id
 where v.company_id = p_company_id
   and not v.is_deleted
   and v.voucher_type in ('sales', 'credit_note')
   and v.voucher_date between p_period_start and p_period_end
   and (p_gst_registration_id is null
        or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
 order by v.voucher_date, v.voucher_number;
$$;

comment on function public.get_gst_output_register is
  'GSTR-1 source data: every sales invoice and credit note in the period, taxable value and tax read back from actual postings (not recomputed from rates). Credit notes show negative taxable value and tax so the column sums net correctly. Not a filing-ready B2B/B2C/HSN bifurcation — see the migration header.';


-- ----------------------------------------------------------------------------
-- get_gst_input_register(company, period_start, period_end, registration)
-- ----------------------------------------------------------------------------
create or replace function public.get_gst_input_register(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
) returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  voucher_type text,
  party_name text,
  party_gstin text,
  place_of_supply char(2),
  supply_type text,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric,
  invoice_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tax as (
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
  taxable as (
    select vi.voucher_id, sum(vi.amount) as amt
      from public.voucher_items vi
     where vi.company_id = p_company_id
     group by vi.voucher_id
  )
  select
    v.id, v.voucher_number, v.voucher_date, v.voucher_type,
    l.name, l.gstin, v.place_of_supply, v.supply_type,
    case when v.voucher_type = 'debit_note' then -coalesce(t.amt, 0) else coalesce(t.amt, 0) end,
    coalesce(tx.cgst, 0), coalesce(tx.sgst, 0), coalesce(tx.igst, 0), coalesce(tx.cess, 0),
    (case when v.voucher_type = 'debit_note' then -coalesce(t.amt, 0) else coalesce(t.amt, 0) end)
      + coalesce(tx.cgst, 0) + coalesce(tx.sgst, 0) + coalesce(tx.igst, 0) + coalesce(tx.cess, 0)
  from public.vouchers v
  left join tax tx on tx.voucher_id = v.id
  left join taxable t on t.voucher_id = v.id
  left join public.ledgers l on l.id = v.party_ledger_id
 where v.company_id = p_company_id
   and not v.is_deleted
   and v.voucher_type in ('purchase', 'debit_note')
   and v.voucher_date between p_period_start and p_period_end
   and (p_gst_registration_id is null
        or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
 order by v.voucher_date, v.voucher_number;
$$;

comment on function public.get_gst_input_register is
  'GSTR-3B ITC source data: every purchase invoice and debit note (purchase return) in the period, taxable value and tax read back from actual postings. Debit notes show negative taxable value and tax so the column sums net correctly. Does not distinguish eligible from blocked ITC (Sec 17(5)) — LEKHA does not track that per line.';
