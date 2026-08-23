-- ============================================================================
-- 0094 — GSTR-1 Table 9B (CDNR) and Table 13 (Documents Issued) (T2-5)
-- ============================================================================
-- 0035 (GST registers) and 0051/0081 (HSN summary, Table 8) already cover the
-- register and the item/rate-driven parts of GSTR-1 prep. Left over: Table 9B,
-- the invoice-wise credit/debit note list for REGISTERED recipients (CDNR),
-- and Table 13, the mandatory per-series count of every document number the
-- filer issued in the period. Both verified against the actual GSTR-1 form
-- (CGST Rules 2017, Form GSTR-1, rule 59(1)) rather than assumed from memory:
-- the form PDF was fetched and read live while building this migration.
--
-- TABLE 9B FIELDS, per the form and its own instruction 13(iii): "the details
-- of invoice shall be mentioned in the first three columns" of the note row —
-- i.e. a CDNR row is GSTIN, ORIGINAL invoice no., ORIGINAL invoice date, then
-- the note's OWN number, date, type (debit/credit), rate, taxable value and
-- tax. Value is reported POSITIVE (GSTN nets it in the return's own summary
-- math) — this deliberately does NOT reuse get_gst_output_register's sign
-- convention, which shows a credit note NEGATIVE precisely so a reader can
-- sum that register directly; 0035's own header already flags this as the
-- one place its convention differs from GSTN's.
--
-- THE GAP THIS SESSION FOUND, AND WHY get_gstr1_table9b CAN NEVER RETURN A
-- DEBIT NOTE ROW. CDNR needs BOTH note types, but this app's 'debit_note'
-- voucher_type is not what GSTN's Table 9B means by one. create_invoice
-- (0016/0018) hard-codes voucher_type routing:
--     credit_note -> v_direction 'in',  v_tax_prefix 'output'  (reduces a SALE)
--     debit_note  -> v_direction 'out', v_tax_prefix 'input'   (reduces a PURCHASE)
-- and get_gst_output_register/get_gst_input_register (0035) confirm this
-- split live: the output register's WHERE clause is
-- voucher_type in ('sales','credit_note') and the input register's is
-- voucher_type in ('purchase','debit_note'). So 'debit_note' in LEKHA is
-- always the INPUT-side document (a purchase return we issue to OUR
-- supplier) — the exact same convention Tally uses. GSTR-1 Table 9B's debit
-- note is the OPPOSITE direction: one the SUPPLIER issues against their OWN
-- outward invoice to increase its value (a price escalation, a
-- short-billing correction). LEKHA has no voucher_type for that at all.
-- Verified live: `select count(*) from vouchers where voucher_type in
-- ('credit_note','debit_note')` returned 0 for the WHOLE database before
-- this session added its own test data (see below) — so this was not yet a
-- visible gap in practice, but it is a real, structural one. Rather than
-- mislabel an input-side debit note as a CDNR row (which would put a
-- purchase-return's tax into an outward-supply table — wrong on its face),
-- get_gstr1_table9b filters to voucher_type = 'credit_note' only, and its
-- own comment says so. An outward price-increase debit note, if a real
-- LEKHA user ever needs to issue one, currently has nowhere to be recorded
-- and must be reported to GSTR-1 by some means outside this app until a
-- genuine output-side debit note type is added — a separate, real piece of
-- work, not attempted here.
--
-- THE "ORIGINAL INVOICE" LINK IS FREE TEXT, NOT A REAL REFERENCE. vouchers
-- already carries reference_number/reference_date, but 0007's own header
-- describes that pair generically as "the counterparty's document: a
-- supplier's bill number, a customer's PO" — it is optional free text on
-- EVERY voucher type, entered by whoever raises the credit note, with no
-- format check and no foreign key to the sales voucher it is meant to
-- describe. create_invoice (claimed by a concurrent session this run, so
-- not touched here) has no dedicated "against invoice" parameter — a credit
-- note's reference_number/reference_date are exactly the same optional
-- "Reference" field InvoiceForm.tsx renders for a purchase bill number.
-- get_gstr1_table9b surfaces them as the original-invoice number/date
-- because that is the only place in the schema such a value could live, but
-- it is NOT validated against an actual sales voucher, can be left blank,
-- and could describe something else entirely if a preparer used the field
-- differently. A real fix — a proper original_voucher_id FK from a
-- credit/debit note to the sales voucher it relates to, resolved at
-- create_invoice time — needs to touch create_invoice, which this session
-- cannot do; flagged for whoever picks that file up next (the same lesson
-- 0071's forex revaluation header already drew about a "fragile
-- narration-based link" — this is the same shape of gap, not yet fixed).
--
-- TABLE 13 — the 12 GSTN document categories (Form GSTR-1 Table 13, "Nature
-- of document"), and which 3 LEKHA can actually populate:
--   1  Invoices for outward supply                        -> 'sales'
--   2  Invoices for inward supply from unregistered person -> not tracked
--   3  Revised Invoice                                     -> not tracked
--   4  Debit Note                                          -> not tracked (see above: LEKHA's debit_note is input-side only)
--   5  Credit Note                                         -> 'credit_note'
--   6  Receipt voucher                                     -> not tracked (LEKHA's 'receipt' is generic, not a GST Rule 50 advance-receipt voucher)
--   7  Payment Voucher                                     -> not tracked (RCM self-invoicing payment voucher; 'payment' is generic)
--   8  Refund voucher                                      -> not tracked
--   9  Delivery Challan for job work                       -> 'job_work_out'
--   10 Delivery Challan for supply on approval              -> not tracked
--   11 Delivery Challan in case of liquid gas                -> not tracked
--   12 Delivery Challan, other (excl. 9-11)                  -> not tracked (branch_transfer deliberately excluded: whether an inter-branch
--                                                               movement needs a tax invoice (Schedule I, different GSTIN) or a plain
--                                                               challan (same GSTIN) depends on the two branches' registrations, which
--                                                               this migration does not attempt to classify)
-- get_gstr1_table13 therefore returns rows for only the 3 populatable
-- categories; the report page is responsible for showing the other 9 by
-- name so the preparer sees the full mandatory list and knows to fill them
-- from outside LEKHA (or mark NIL) rather than the table silently looking
-- complete. Table 13 became MANDATORY (not just optional) from the May 2025
-- return period per GSTN's advisory — verified live via web search, not
-- assumed — so a genuine NIL period must still be shown as NIL, never
-- omitted.
--
-- SERIAL-NUMBER RANGE vs. VOUCHER DATE — the real design problem, verified
-- against 0007's own numbering function rather than assumed. sequence_number
-- is handed out by app_private.next_voucher_number at INSERT time, keyed
-- only by (company, branch, voucher_type, financial-year-of-voucher_date).
-- It is a plain incrementing counter over insertion order — nothing ties it
-- to voucher_date order within that year. A back-dated correction entered
-- today for a June date gets TODAY's next number, not a number that sits
-- between June's other invoices. So "documents issued in a period" (a
-- SERIAL NUMBER question — which numbers 1..N did the filer's books use up
-- this period) and "vouchers dated in a period" (LEKHA's only queryable
-- axis) are different questions that agree only when nothing was ever
-- back-dated. This migration answers the date-scoped question honestly and
-- flags disagreement rather than pretend they are the same thing:
-- serial_from/serial_to are the min/max sequence_number among vouchers
-- DATED in the period; total_issued is a plain count of those same rows;
-- serial_span is (serial_to - serial_from + 1). Whenever serial_span <>
-- total_issued, range_has_gap is true — meaning some number inside that
-- min-max span belongs to a voucher dated OUTSIDE this period (most likely
-- a back-dated entry), so the printed range should not be filed without
-- the preparer checking it by hand. Verified live below with a real,
-- gap-free case (this session's own test vouchers plus Sharma Textiles'
-- existing job-work challans) — a genuine gap scenario was not constructed
-- (it would need a deliberately back-dated voucher and this session judged
-- that not worth the extra live data mutation for a flag whose formula is
-- simple arithmetic), so range_has_gap is verified NOT to false-positive on
-- clean data, not verified to true-positive on dirty data.
--
-- CANCELLED COUNT — checked live per the audit's own instruction rather
-- than assumed:
--   select column_name from information_schema.columns where table_name =
--   'vouchers' and (column_name ilike '%cancel%' or column_name ilike '%void%')
-- returns NOTHING. vouchers has no cancelled-but-numbered concept. The
-- closest thing is is_deleted (0052's soft-delete flag): a deleted voucher
-- keeps its row, its sequence_number and its slot in the numbering series
-- (0052's own header: "no separate cleanup... they stay in place as
-- history"), which is structurally close to "the number was issued and the
-- transaction was voided." But is_deleted is a general correction flag, not
-- a customer-facing cancellation event — a duplicate entry deleted the same
-- day is indistinguishable, in this column, from a genuinely cancelled
-- invoice. get_gstr1_table13's `cancelled` column reports is_deleted counts
-- WITHIN the same date-and-type scope as everything else here, and its own
-- comment says plainly that this is the best available proxy, not a
-- verified cancellation count — never a fabricated zero.
--
-- OUT OF SCOPE: CDNUR (credit/debit notes to UNREGISTERED recipients — a
-- different GSTR-1 table, summary-only by note type + place of supply, not
-- invoice-wise); amendments to a prior period's 9B/13 rows (Table 9C, a
-- distinct table); and, as with every GSTR-1 prep function in this app so
-- far (0035, 0051, 0081), no GSTN offline-utility upload file — this is
-- prep data in the return's own shape, not a validated upload-ready export
-- (same framing as 0072's ITC-04 header).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- A real gap this migration's own live testing caught, not code review:
-- voucher_number_sequences had RLS enabled since 0007 but NO policy at all
-- (verified live: `select * from pg_policy where polrelid =
-- 'voucher_number_sequences'::regclass` returns zero rows) and NO table
-- grant to `authenticated` either. RLS-enabled-with-no-policy is deny-all,
-- so nothing broke before now: the table's only reader was
-- app_private.next_voucher_number, a SECURITY DEFINER function owned by
-- postgres, which bypasses RLS entirely regardless of policy — no report
-- had ever read this table directly under a real user's own role. Running
-- get_gstr1_table13 as the actual RLS-gated authenticated user (not this
-- session's RLS-bypassing sbq connection) surfaced the gap immediately:
-- "permission denied for table voucher_number_sequences". A SECURITY
-- INVOKER report function needs the table itself readable, so this adds
-- exactly the same read policy shape vouchers_read/branches_read already
-- use — company membership plus branch access, SELECT only. No write
-- policy is added: numbering stays writable only through
-- next_voucher_number, unchanged.
alter table public.voucher_number_sequences enable row level security;

drop policy if exists voucher_number_sequences_read on public.voucher_number_sequences;
create policy voucher_number_sequences_read on public.voucher_number_sequences
  for select
  using (
    app_private.is_company_member(company_id)
    and app_private.can_access_branch(branch_id)
  );

grant select on public.voucher_number_sequences to authenticated;


-- ----------------------------------------------------------------------------
-- get_gstr1_table9b(company, period_start, period_end, registration)
-- ----------------------------------------------------------------------------
create or replace function public.get_gstr1_table9b(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
) returns table (
  voucher_id uuid,
  note_type text,
  note_number text,
  note_date date,
  party_name text,
  party_gstin text,
  place_of_supply char(2),
  against_invoice_number text,
  against_invoice_date date,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric,
  note_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'output_cgst' then e.debit_amount - e.credit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'output_sgst' then e.debit_amount - e.credit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'output_igst' then e.debit_amount - e.credit_amount else 0 end) as igst,
           sum(case when m.purpose = 'output_cess' then e.debit_amount - e.credit_amount else 0 end) as cess
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
    v.id,
    'credit'::text,                              -- see migration header: debit_note can never appear here
    v.voucher_number,
    v.voucher_date,
    l.name,
    l.gstin,
    v.place_of_supply,
    v.reference_number,                          -- best-effort "against invoice" — free text, unverified, see header
    v.reference_date,
    coalesce(t.amt, 0),
    coalesce(tx.cgst, 0), coalesce(tx.sgst, 0), coalesce(tx.igst, 0), coalesce(tx.cess, 0),
    coalesce(t.amt, 0) + coalesce(tx.cgst, 0) + coalesce(tx.sgst, 0) + coalesce(tx.igst, 0) + coalesce(tx.cess, 0)
  from public.vouchers v
  join public.ledgers l on l.id = v.party_ledger_id
  left join tax tx on tx.voucher_id = v.id
  left join taxable t on t.voucher_id = v.id
 where v.company_id = p_company_id
   and not v.is_deleted
   and v.voucher_type = 'credit_note'
   and l.gstin is not null                       -- CDNR = registered recipients only; unregistered is CDNUR, out of scope (see header)
   and v.voucher_date between p_period_start and p_period_end
   and (p_gst_registration_id is null
        or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
 order by v.voucher_date, v.voucher_number;
$$;

comment on function public.get_gstr1_table9b is
  'GSTR-1 Table 9B (CDNR) prep: credit notes issued in the period against a registered (GSTIN-bearing) party, note value and tax shown POSITIVE per GSTN''s own convention (unlike get_gst_output_register, which nets a credit note negative). Never returns a debit-note row: LEKHA''s debit_note voucher_type is structurally input-side (a purchase return), not the output-side price-increase note Table 9B means — see migration header. against_invoice_number/date are the voucher''s free-text reference_number/reference_date, entered by whoever raised the note and NOT validated against an actual sales voucher — not a real FK. Excludes unregistered-party notes (CDNUR, a different table) and amendments (Table 9C).';

revoke all on function public.get_gstr1_table9b(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_gstr1_table9b(uuid, date, date, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- get_gstr1_table13(company, period_start, period_end, registration)
-- ----------------------------------------------------------------------------
create or replace function public.get_gstr1_table13(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
) returns table (
  voucher_type text,
  nature_of_document text,
  branch_id uuid,
  branch_code text,
  series_prefix text,
  financial_year_label text,
  serial_from integer,
  serial_to integer,
  total_issued integer,
  cancelled integer,
  net_issued integer,
  serial_span integer,
  range_has_gap boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with company_fy as (
    -- Table 13's period does not cross a financial-year boundary in normal
    -- use (GST periods are calendar months or quarters, all of which sit
    -- inside one FY); the FY is resolved from p_period_start only. A
    -- deliberately custom range spanning 31 Mar/1 Apr would only see the
    -- starting FY's series — a documented limitation, not silently wrong.
    select app_private.fy_label(p_period_start, c.financial_year_start_month) as fy_label
      from public.companies c
     where c.id = p_company_id
  ),
  category as (
    select * from (values
      ('sales', 'Invoices for outward supply'),
      ('credit_note', 'Credit Note'),
      ('job_work_out', 'Delivery Challan for job work')
    ) as t(voucher_type, nature_of_document)
  ),
  series as (
    -- Every series LEKHA has ever allocated a number from, for one of the 3
    -- populatable categories, in the period's FY. Registration filter is
    -- resolved at p_period_end (a branch's gst_registration_id is a fixed
    -- FK; only its own registered_from/registered_to window is date
    -- sensitive) — a mid-FY deregistration right at period end is the only
    -- case this could misjudge, and is left as a known simplification.
    select vns.branch_id, b.code as branch_code, vns.voucher_type, vns.prefix, vns.financial_year_label
      from public.voucher_number_sequences vns
      join public.branches b on b.id = vns.branch_id and b.company_id = vns.company_id
      join company_fy cf on cf.fy_label = vns.financial_year_label
     where vns.company_id = p_company_id
       and vns.voucher_type in (select voucher_type from category)
       and (p_gst_registration_id is null
            or app_private.branch_registration(vns.branch_id, p_period_end) = p_gst_registration_id)
  ),
  docs as (
    select v.branch_id, v.voucher_type,
           count(*)::int as total_n,
           min(v.sequence_number) as serial_from,
           max(v.sequence_number) as serial_to,
           count(*) filter (where v.is_deleted)::int as cancelled_n
      from public.vouchers v
     where v.company_id = p_company_id
       and v.voucher_type in (select voucher_type from category)
       and v.voucher_date between p_period_start and p_period_end
     group by v.branch_id, v.voucher_type
  )
  select
    s.voucher_type,
    c.nature_of_document,
    s.branch_id,
    s.branch_code,
    s.prefix,
    s.financial_year_label,
    d.serial_from,
    d.serial_to,
    coalesce(d.total_n, 0),
    coalesce(d.cancelled_n, 0),
    coalesce(d.total_n, 0) - coalesce(d.cancelled_n, 0),
    case when d.serial_from is not null then d.serial_to - d.serial_from + 1 else 0 end,
    case when d.serial_from is not null
              and (d.serial_to - d.serial_from + 1) <> d.total_n
         then true else false end
    from series s
    join category c on c.voucher_type = s.voucher_type
    left join docs d on d.branch_id = s.branch_id and d.voucher_type = s.voucher_type
   order by c.nature_of_document, s.branch_code;
$$;

comment on function public.get_gstr1_table13 is
  'GSTR-1 Table 13 (Documents Issued) prep: per-series serial-range summary for the 3 of GSTN''s 12 mandatory document categories LEKHA can populate (Invoices for outward supply = sales, Credit Note, Delivery Challan for job work = job_work_out) — the other 9 (inward-from-unregistered invoices, revised invoices, output-side debit notes, receipt/payment/refund vouchers, and 3 more delivery-challan kinds) have no representation in this schema; see migration header for why, category by category. One row per (document category, branch) series that has ever allocated a number in the period''s financial year, including a zero-row (NIL) when the series exists but nothing was dated in this specific period — Table 13 is mandatory even when NIL. serial_from/serial_to/total_issued are computed from vouchers DATED in the period, not from the raw serial-number sequence, because LEKHA numbers vouchers at insertion time, not at date-assignment time (see header); range_has_gap is true when the serial span implied by serial_from..serial_to does not match total_issued, meaning a back-dated or out-of-period voucher sits inside that number range and the printed range should be hand-checked before filing. cancelled is a count of is_deleted rows in the same scope — the closest concept LEKHA has to a cancelled-but-numbered document (vouchers has no cancel/void flag, verified live), not a certified cancellation count.';

revoke all on function public.get_gstr1_table13(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_gstr1_table13(uuid, date, date, uuid) to authenticated;

notify pgrst, 'reload schema';
