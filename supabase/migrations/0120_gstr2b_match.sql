-- ============================================================================
-- 0120 — GSTR-2B upload + match against the purchase register
-- ============================================================================
-- WHY THIS IS THE HIGHEST-VALUE GST GAP: Sec 16(2)(aa) of the CGST Act makes
-- input tax credit conditional on the invoice actually appearing in the
-- recipient's GSTR-2B. As of 1 October 2025 this is enforced even more
-- literally — Notification 16/2025-Central Tax (17 Sep 2025) substituted
-- Sec 38, and the CGST (Fourth Amendment) Rules, 2025 (Notification
-- 18/2025-Central Tax, 31 Oct 2025) codified the Invoice Management System
-- (IMS): a supplier's invoice only lands in the recipient's GSTR-2B once it
-- is accepted (or deemed-accepted by inaction) on the IMS dashboard.
-- Practically: 2B is no longer "whatever 2A summed up" — it is the
-- taxpayer's own accepted/deemed-accepted record, generated on the 14th of
-- the following month, and it is now the single legal gate on every input
-- tax credit LEKHA's own get_gst_input_register (0035) reports as claimable.
-- This app has never compared the two. This migration does.
--
-- SOURCES (WebSearch during this task, both an "obvious answer" pass and a
-- deliberately skeptical second pass):
--   - Sec 16(2)(aa) itself: inserted by the Finance Act 2021 (Notification
--     39/2021-Central Tax), effective 1 Jan 2022 — ITC available only if
--     "the details of the invoice or debit note... have been furnished by
--     the supplier... and such details have been communicated to the
--     recipient" (i.e. appear in 2B).
--   - Sec 38 substitution / IMS: Notification 16/2025-Central Tax (17 Sep
--     2025) + CGST (Fourth Amendment) Rules 2025, Notification 18/2025-
--     Central Tax (31 Oct 2025, new Rule 67B). First IMS-based draft 2B was
--     for the Oct 2024 period (generated 14 Nov 2024); IMS itself started
--     rolling recipient accept/reject/pending actions before the Sec 38
--     substitution made deemed-acceptance the explicit statutory basis.
--   - GSTR-2B structure: a static, auto-drafted monthly statement (Rule
--     60(7)), generated on the 14th, covering documents filed by suppliers
--     between the previous month's 2nd and this month's 1st. Its Summary
--     tab has four parts — ITC Available, ITC Not Available, ITC Reversal
--     (Rule 37A — supplier filed GSTR-1 but not GSTR-3B), and ITC Rejected
--     (an IMS action the recipient took themselves). "ITC Not Available"
--     reasons are Sec 16(4) time-bar and supplier-state/POS mismatch
--     (CGST+SGST charged by a supplier whose state differs from the
--     recipient's place of supply), plus a catch-all the advisory itself
--     admits is non-exhaustive ("there may be other scenarios").
--   - Its "All Tables" tab is sectioned B2B/B2BA, B2B-CDNR/CDNRA, ISD/ISDA,
--     IMPG, IMPGSEZ, ECO/ECOA (Sec 9(5)) — this migration's v1 scope is
--     B2B/B2BA and CDNR/CDNRA only (see SCOPE below).
--   - Excel/JSON schema: GSTN does not publish a byte-level field spec for
--     the downloadable Excel outside its own offline tool, and this
--     session could not confirm one with confidence (the official
--     tutorial.gst.gov.in pages describe the UI's filters and tabs, not an
--     exhaustive column list). What multiple independent sources DO agree
--     on for the B2B sheet: Supplier GSTIN, Trade/Legal Name, Invoice
--     Number, Invoice Date, Taxable Value, CGST, SGST, IGST, Invoice
--     Value, and an ITC-Available flag — exactly the columns this
--     migration's importer asks for (plus Cess, which every GST return
--     schema in this app already carries as a fifth tax head, and a Reason
--     column for the "not available" sub-classification). Per the task's
--     own instruction, this is built as a NORMALIZED CSV shape the
--     taxpayer (or their CA) fills from the downloaded 2B — the same
--     pattern this app already uses for bank statement import
--     (lib/csv/bank-import.ts's five-column CSV, not a raw bank-file
--     parser) — not a raw GSTN JSON/Excel parser, which this session could
--     not build against a confirmed field-by-field spec. Said explicitly
--     in the import screen's own copy, not silently assumed.
--
-- SCOPE, deliberately narrow (this session's "simplest shape first"
-- discipline): B2B and CDNR lines only — the two sections that map onto
-- this app's own purchase register (get_gst_input_register already
-- combines 'purchase' and 'debit_note' vouchers the same way). ISD credit,
-- import of goods (IMPG/IMPGSEZ) and e-commerce Sec 9(5) (ECO) lines are
-- not represented — LEKHA has no ISD-inward, import-of-goods or Sec 9(5)
-- inward posting to reconcile them against, so a made-up bucket for them
-- would be worse than omitting them. Said explicitly in the report page.
--
-- SIGN CONVENTION, mirroring 0035's own documented choice exactly: a
-- credit-note (CDNR) line is stored with taxable_value/cgst/sgst/igst/
-- cess/invoice_value NEGATIVE, regardless of how the source file encoded
-- it — the importer normalises this at parse time (see
-- lib/csv/gstr2b-import.ts) — so summing this table's columns nets
-- correctly, exactly like get_gst_input_register's own debit_note rows.
--
-- MATCH KEY: (normalised supplier GSTIN, normalised invoice number). The
-- purchase-register side reads the SUPPLIER's own invoice number from
-- vouchers.reference_number (the field create_invoice/create_voucher's
-- own duplicate-bill check already keys on — see 0016) via a join on
-- get_gst_input_register's voucher_id, NOT from vouchers.voucher_number
-- (LEKHA's own internally-generated sequence, which has nothing to do
-- with the supplier's document). A purchase entered without its
-- reference_number filled in can never match by definition — reported as
-- its own explicit count on the report page, not silently folded into
-- "missing from 2B".
--
-- MATCHING WINDOW: the register side looks back p_lookback_months (default
-- 2) before the requested return_period's own calendar month, to catch a
-- supplier who filed late — a real, common case IMS does not eliminate.
-- Only register rows dated WITHIN the return_period's own month are ever
-- flagged "missing from 2B" (an entry from the lookback window is there
-- only to help find a match, not to be judged against a period it was
-- never meant to appear in). This is a real, stated limitation, not a
-- guess: a purchase booked in month M whose supplier files late enough
-- that neither month M's nor M+1's/M+2's 2B carries it will keep
-- surfacing as "missing from 2B" every month it is checked — which is the
-- economically correct signal (ITC is still at risk) even though it can
-- look repetitive across reports.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- gstr2b_lines — one row per document (B2B invoice or CDNR credit note) in
-- one company's uploaded GSTR-2B for one return period.
-- ----------------------------------------------------------------------------
create table public.gstr2b_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  gst_registration_id uuid not null,

  -- 'YYYY-MM', matching this app's own month-picker convention elsewhere
  -- (e.g. reports/gst-registers) rather than GSTN's own MMYYYY portal code.
  return_period text not null check (return_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),

  -- Raw section label from the file (B2B, B2BA, CDNR, CDNRA, ...) — kept
  -- for audit/display only, never branched on; document_type is what the
  -- match logic actually uses.
  gstr2b_table text,
  document_type text not null check (document_type in ('invoice', 'credit_note')),

  supplier_gstin text not null check (app_private.is_valid_gstin(supplier_gstin)),
  supplier_name text,

  invoice_number text not null check (length(trim(invoice_number)) > 0),
  -- Normalised match key: uppercased, punctuation/whitespace stripped, so
  -- "INV-001", "inv001" and "INV 001" are treated as the same document —
  -- the same tolerance level.csv importers elsewhere already apply to names.
  invoice_number_normalized text generated always as
    (upper(regexp_replace(invoice_number, '[^a-zA-Z0-9]', '', 'g'))) stored,
  invoice_date date not null,

  -- NEGATIVE for document_type = 'credit_note', see migration header.
  taxable_value numeric(14, 2) not null default 0,
  cgst numeric(14, 2) not null default 0,
  sgst numeric(14, 2) not null default 0,
  igst numeric(14, 2) not null default 0,
  cess numeric(14, 2) not null default 0,
  invoice_value numeric(14, 2) not null default 0,

  -- The 4 categories GSTR-2B's own Summary tab actually uses (see header).
  itc_availability text not null
    check (itc_availability in ('available', 'not_available', 'reversal', 'rejected')),
  -- Free text, not an enum: GSTN's own advisory states its "not available"
  -- reasons are non-exhaustive ("there may be other scenarios") — an enum
  -- here would force a wrong pick rather than record what the file said.
  itc_reason text,

  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (gst_registration_id, company_id) references public.gst_registrations (id, company_id)
);

create index gstr2b_lines_period_idx on public.gstr2b_lines (company_id, return_period, gst_registration_id);
create index gstr2b_lines_match_idx on public.gstr2b_lines (company_id, supplier_gstin, invoice_number_normalized);

comment on table public.gstr2b_lines is
  'Uploaded GSTR-2B lines (B2B + CDNR only, v1 scope — see migration header), one row per document per return period. Written only through import_gstr2b_lines (whole-period replace) — no direct client write policy, same convention as job_work_challans.';

alter table public.gstr2b_lines enable row level security;

create policy gstr2b_lines_read on public.gstr2b_lines for select
  using (app_private.is_company_member(company_id));

-- ----------------------------------------------------------------------------
-- import_gstr2b_lines — whole-period replace. A GSTR-2B download is a
-- complete snapshot for its period, not an appendable log, so re-uploading
-- (e.g. after fixing a column mapping) replaces this registration's lines
-- for the period rather than duplicating them. Calling with an empty
-- p_lines array is how the UI clears an uploaded period.
-- ----------------------------------------------------------------------------
create or replace function public.import_gstr2b_lines(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_return_period text,
  -- [{"gstr2b_table":"B2B","document_type":"invoice","supplier_gstin":"...",
  --   "supplier_name":"...","invoice_number":"...","invoice_date":"2026-05-01",
  --   "taxable_value":1000,"cgst":90,"sgst":90,"igst":0,"cess":0,
  --   "invoice_value":1180,"itc_availability":"available","itc_reason":null}]
  p_lines jsonb
) returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_count integer := 0;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to import GSTR-2B data for this company';
  end if;
  if p_return_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Return period must be in YYYY-MM format, got %', p_return_period;
  end if;
  if not app_private.module_active(p_company_id, 'gst', (p_return_period || '-01')::date) then
    raise exception 'GST is not an active module for this company for that period';
  end if;
  if not exists (
    select 1 from public.gst_registrations
     where id = p_gst_registration_id and company_id = p_company_id
  ) then
    raise exception 'That GST registration does not belong to this company';
  end if;

  delete from public.gstr2b_lines
   where company_id = p_company_id
     and gst_registration_id = p_gst_registration_id
     and return_period = p_return_period;

  insert into public.gstr2b_lines (
    company_id, gst_registration_id, return_period, gstr2b_table, document_type,
    supplier_gstin, supplier_name, invoice_number, invoice_date,
    taxable_value, cgst, sgst, igst, cess, invoice_value,
    itc_availability, itc_reason, uploaded_by
  )
  select
    p_company_id, p_gst_registration_id, p_return_period,
    nullif(l ->> 'gstr2b_table', ''),
    l ->> 'document_type',
    upper(trim(l ->> 'supplier_gstin')),
    nullif(l ->> 'supplier_name', ''),
    trim(l ->> 'invoice_number'),
    (l ->> 'invoice_date')::date,
    coalesce((l ->> 'taxable_value')::numeric, 0),
    coalesce((l ->> 'cgst')::numeric, 0),
    coalesce((l ->> 'sgst')::numeric, 0),
    coalesce((l ->> 'igst')::numeric, 0),
    coalesce((l ->> 'cess')::numeric, 0),
    coalesce((l ->> 'invoice_value')::numeric, 0),
    l ->> 'itc_availability',
    nullif(l ->> 'itc_reason', ''),
    auth.uid()
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.import_gstr2b_lines(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.import_gstr2b_lines(uuid, uuid, text, jsonb) to authenticated;

comment on function public.import_gstr2b_lines(uuid, uuid, text, jsonb) is
  'Whole-period replace of one GST registration''s uploaded GSTR-2B lines: deletes any existing rows for (company, registration, return_period) then inserts p_lines. Pass an empty array to clear a period. Client-side validation (lib/csv/gstr2b-import.ts) does GSTIN/date/amount checks before calling this — this function trusts well-formed input and lets a genuinely malformed row raise, aborting the whole import rather than importing a corrupt statement partially.';

-- ----------------------------------------------------------------------------
-- list_gstr2b_periods — which periods/registrations already have an upload,
-- for the import screen to show what exists and for the match report to
-- warn when nothing has been uploaded yet for the period being viewed.
-- ----------------------------------------------------------------------------
create or replace function public.list_gstr2b_periods(p_company_id uuid)
returns table (
  return_period text,
  gst_registration_id uuid,
  gstin text,
  line_count integer,
  uploaded_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select g.return_period, g.gst_registration_id, r.gstin, count(*)::int, max(g.created_at)
    from public.gstr2b_lines g
    join public.gst_registrations r on r.id = g.gst_registration_id
   where g.company_id = p_company_id
   group by g.return_period, g.gst_registration_id, r.gstin
   order by g.return_period desc, r.gstin;
$$;

revoke all on function public.list_gstr2b_periods(uuid) from public, anon;
grant execute on function public.list_gstr2b_periods(uuid) to authenticated;

comment on function public.list_gstr2b_periods(uuid) is
  'Uploaded GSTR-2B periods with a row count each, newest first — powers the import screen''s "already uploaded" list and the match report''s "nothing uploaded yet" prompt.';

-- ----------------------------------------------------------------------------
-- match_gstr2b_purchase_register — the three-bucket reconciliation.
-- ----------------------------------------------------------------------------
create or replace function public.match_gstr2b_purchase_register(
  p_company_id uuid,
  p_return_period text,
  p_gst_registration_id uuid default null,
  p_lookback_months integer default 2
) returns table (
  bucket text,                    -- 'matched' | 'missing_from_register' | 'missing_from_2b'
  supplier_gstin text,
  supplier_name text,
  invoice_number text,
  invoice_date date,
  taxable_value_2b numeric,
  tax_2b numeric,
  taxable_value_register numeric,
  tax_register numeric,
  amount_difference numeric,      -- register total - 2B total, matched rows only
  itc_availability text,
  itc_reason text,
  voucher_id uuid,
  voucher_number text,
  voucher_date date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with period as (
    select
      to_date(p_return_period || '-01', 'YYYY-MM-DD') as period_start,
      (to_date(p_return_period || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date as period_end,
      (to_date(p_return_period || '-01', 'YYYY-MM-DD') - make_interval(months => greatest(coalesce(p_lookback_months, 0), 0)))::date as lookback_start
  ),
  b as (
    select
      g.supplier_gstin, g.supplier_name, g.invoice_number, g.invoice_date,
      g.taxable_value, (g.cgst + g.sgst + g.igst + g.cess) as tax, g.invoice_value,
      g.itc_availability, g.itc_reason,
      upper(trim(g.supplier_gstin)) as gstin_key,
      g.invoice_number_normalized as inv_key
    from public.gstr2b_lines g
    where g.company_id = p_company_id
      and g.return_period = p_return_period
      and (p_gst_registration_id is null or g.gst_registration_id = p_gst_registration_id)
  ),
  reg as (
    select
      ir.voucher_id, ir.voucher_number, ir.voucher_date, ir.party_name, ir.party_gstin,
      ir.taxable_value, (ir.cgst + ir.sgst + ir.igst + ir.cess) as tax, ir.invoice_value,
      v.reference_number,
      upper(trim(ir.party_gstin)) as gstin_key,
      upper(regexp_replace(coalesce(v.reference_number, ''), '[^a-zA-Z0-9]', '', 'g')) as inv_key
    from period p,
         public.get_gst_input_register(p_company_id, p.lookback_start, p.period_end, p_gst_registration_id) ir
    join public.vouchers v on v.id = ir.voucher_id
    where ir.party_gstin is not null
  ),
  matched as (
    select
      'matched'::text,
      b.supplier_gstin, coalesce(b.supplier_name, reg.party_name), b.invoice_number, b.invoice_date,
      b.taxable_value, b.tax, reg.taxable_value, reg.tax,
      (reg.invoice_value - b.invoice_value),
      b.itc_availability, b.itc_reason,
      reg.voucher_id, reg.voucher_number, reg.voucher_date
    from b
    join reg on reg.gstin_key = b.gstin_key and reg.inv_key = b.inv_key and reg.inv_key <> ''
  ),
  missing_from_register as (
    select
      'missing_from_register'::text,
      b.supplier_gstin, b.supplier_name, b.invoice_number, b.invoice_date,
      b.taxable_value, b.tax, null::numeric, null::numeric, null::numeric,
      b.itc_availability, b.itc_reason,
      null::uuid, null::text, null::date
    from b
    where not exists (
      select 1 from reg where reg.gstin_key = b.gstin_key and reg.inv_key = b.inv_key and reg.inv_key <> ''
    )
  ),
  missing_from_2b as (
    select
      'missing_from_2b'::text,
      reg.party_gstin, reg.party_name, coalesce(reg.reference_number, '(no reference number entered)'), reg.voucher_date,
      null::numeric, null::numeric, reg.taxable_value, reg.tax, null::numeric,
      null::text, null::text,
      reg.voucher_id, reg.voucher_number, reg.voucher_date
    from reg, period p
    where reg.voucher_date between p.period_start and p.period_end
      and not exists (
        select 1 from b where b.gstin_key = reg.gstin_key and b.inv_key = reg.inv_key and reg.inv_key <> ''
      )
  )
  select * from matched
  union all select * from missing_from_register
  union all select * from missing_from_2b
  order by 1, 5;
$$;

revoke all on function public.match_gstr2b_purchase_register(uuid, text, uuid, integer) from public, anon;
grant execute on function public.match_gstr2b_purchase_register(uuid, text, uuid, integer) to authenticated;

comment on function public.match_gstr2b_purchase_register(uuid, text, uuid, integer) is
  'Three-bucket GSTR-2B reconciliation for one return period: matched (found both sides, by supplier GSTIN + normalised supplier invoice number), missing_from_register (in 2B, not booked here — a missed purchase entry), missing_from_2b (booked here, not in 2B — Sec 16(2)(aa) ITC at risk). Register side reads vouchers.reference_number (the supplier''s own bill number) via get_gst_input_register''s voucher_id, looking back p_lookback_months for late-filed matches, but only flags register rows dated inside the return period''s own month as missing_from_2b. Register rows with no reference_number, or no GSTIN on the party ledger, can never match by construction — report this count separately, do not fold it into missing_from_2b silently.';
