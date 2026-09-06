-- ============================================================================
-- 0148 — 26AS / AIS / TIS upload + match against TDS Receivable
-- ============================================================================
-- Same reconciliation SHAPE as 0120 (GSTR-2B upload + purchase-register
-- match), applied to income-tax data: a normalized-CSV upload table plus a
-- three-bucket match function, replacing 0120's supplier-GSTIN/invoice-number
-- key with a deductor-TAN key against public.tax_ledger_map's own
-- 'tds_receivable' ledger (added by 0079, the "company as deductee" side —
-- TDS other people's businesses deducted from THIS company's own receipts,
-- creditable under Sec 199). 0079's own header said exactly this: "Nor is
-- this reconciled against 26AS/AIS: those are download-only from the portal,
-- and matching them is a separate feature that this table is the
-- prerequisite for." This migration is that feature.
--
-- INVESTIGATED FIRST, PER THE TASK'S OWN INSTRUCTION, NOT ASSUMED:
--   - get_tds_deductee_summary (0053) is the WRONG match target. It reports
--     TDS this company deducted FROM ITS OWN vendors (tax_ledger_map purpose
--     'tds_payable', credit-side) — that is the vendor's 26AS, not this
--     company's. Confirmed by reading 0053 in full before writing a line of
--     this migration.
--   - tax_ledger_map purpose 'tds_receivable' (0079) IS the right target: an
--     asset ledger, seeded for every company, whose DEBIT movement for a
--     financial year is exactly "TDS suffered on our own receipts, already
--     paid to the government on our behalf" — precisely what 26AS Part A /
--     AIS's TDS-TCS Information part report from the deductor's side.
--     Confirmed live before building:
--       select m.company_id, l.name from tax_ledger_map m join ledgers l
--         on l.id = m.ledger_id where m.purpose = 'tds_receivable';
--       -> 15 rows, one per company (every company has this ledger).
--       select count(*) from tax_ledger_map m join voucher_entries e
--         on e.ledger_id = m.ledger_id where m.purpose = 'tds_receivable';
--       -> 0. Genuinely never posted to, anywhere, by any company, ever.
--     This is the "thin area" the task warned might exist. It does. Real
--     test data is constructed below rather than assumed (see VERIFICATION).
--
-- STATUTORY RESEARCH (WebSearch during this task, an "obvious answer" pass
-- and a deliberately skeptical second pass):
--   - Form 26AS Part A structure: deductor Name + TAN, Section (the TDS
--     section code, e.g. 194C/194J/192), Transaction Date (date of credit or
--     payment, whichever is earlier), Amount Paid/Credited, Tax Deducted,
--     Date of Booking, and Status of Booking — F (Final, matched against the
--     deductor's own TDS statement), U (Unmatched — deductor has not
--     deposited or filed correctly), P (Provisional, before the deductor's
--     quarterly return is processed) or O (Overbooked, a departmental
--     correction state). Multiple independent sources (TRACES' own FAQ,
--     ClearTax, TaxBuddy) agree on this field set. Credit itself is governed
--     by Sec 199 Income-tax Act read with Rule 37BA — the deductee gets
--     credit for tax actually deposited by the deductor, in the year the
--     corresponding income is assessable, which is exactly why this
--     migration matches on TAX DEPOSITED, not tax deducted, wherever the
--     two differ in an uploaded row (see column comment below).
--   - AIS (Annual Information Statement) is downloaded from the e-filing
--     portal (Services > AIS) as PDF, JSON or CSV — confirmed still the
--     three formats offered today. The JSON/PDF download is password
--     protected: PAN (upper-case) + date of birth/incorporation in
--     DDMMYYYY, no space — e.g. AAAAA1234A21011991. AIS's own TDS/TCS
--     Information part carries the same deductor-TAN/amount/tax shape as
--     26AS (it is sourced from the same statements); its other parts (SFT,
--     dividend/interest "other information", etc.) are NOT TDS/TCS events
--     and have nothing in this schema to reconcile against — out of scope
--     here exactly the way 0120 left ISD/IMPG/ECO out of its own scope.
--   - TIS (Taxpayer Information Summary) is a DIFFERENT SHAPE, confirmed by
--     a second, skeptical search specifically because "AIS/TIS are the same
--     thing at different detail levels" is the obvious-sounding wrong
--     answer: TIS is CATEGORY-AGGREGATED (e.g. one row for the whole
--     financial year's "Salary" or "TDS on sale of property" category, with
--     reported/processed/derived VALUE columns), not deductor-wise. It
--     generally carries NO per-deductor TAN at all. TIS rows are still
--     accepted and stored by this importer (the task named it as a source),
--     but — stated explicitly, not silently — a TIS row with no TAN can
--     never enter the deductor-keyed match below; it is visible only via
--     list_income_tax_statement_periods and the raw uploaded table.
--   - A LIVE, IN-PROGRESS RENAME, caught by the deliberately skeptical
--     second pass and worth recording so nobody "fixes" the '26as' source
--     label later thinking it is stale: the Income-tax Act, 2025 (in force
--     1 April 2026) renames this statement "Form 168" from FY 2026-27
--     (AY 2027-28) onward — i.e. from the very financial year this
--     migration's own live test data falls in. Multiple sources (including
--     the Income Tax Department's own incometaxindia.gov.in page for it)
--     confirm Form 168 is STRUCTURALLY the same TAN-keyed TDS/TCS credit
--     statement as Form 26AS, auto-generated, not something the taxpayer
--     files — the rename does not change what this migration matches
--     against. The source enum keeps 'ais'/'tis'/'26as' exactly as the task
--     specified (and as accountants will keep calling it colloquially for
--     years), with this paragraph as the record of why '26as' was kept
--     rather than swapped for 'form168'.
--
-- WHY A NEW ledgers.tan COLUMN. Matching by TAN needs the CUSTOMER's TAN
-- recorded somewhere on this side of the books, and nothing already carries
-- it: ledgers.is_tds_deductee/default_tds_section (0022) are the OPPOSITE
-- direction — flags for a party THIS company deducts TDS FROM, used by
-- get_tds_deductee_summary. A customer who deducts TDS from THIS company's
-- own receipts needs its own TAN recorded, symmetric to how a vendor already
-- carries a `pan` column. One column, same shape as `pan`, same
-- app_private.is_valid_tan format guard already used on companies.tan (0003).
-- No column-grant-allowlist implication: confirmed live before adding it —
-- public.ledgers carries only whole-TABLE grants for `authenticated`
-- (select/insert/update/delete), no per-column grant list the way 0044
-- locked down public.companies, so a plain ADD COLUMN needs no matching
-- grant statement. (The recurring bug class this session's CLAUDE.md warns
-- about is specific to public.companies; checked, and it does not apply
-- here.)
--
-- MATCH KEY: deductor TAN only — normalised the same way 0120 normalises
-- invoice numbers (uppercase, non-alphanumerics stripped) — NOT TAN plus a
-- per-transaction key. Two reasons, both deliberate:
--   1. Sec 199/Rule 37BA credit itself is claimed on the AGGREGATE tax a
--      deductor deposited against this PAN for the year, not per invoice —
--      26AS routinely shows several quarterly rows per deductor for one
--      running relationship, with no invoice-number equivalent at all to
--      key against.
--   2. The register side has no natural per-transaction key either: a
--      receipt voucher posts one lump TDS Receivable debit for whatever the
--      customer withheld on that payment, not a per-invoice breakdown.
--   So both sides are SUMMED per (company, financial year, deductor TAN)
--   before comparing — the annual analogue of 0120's per-document match.
--
-- REGISTER-SIDE ATTRIBUTION mirrors get_tds_deductee_summary (0053) as
-- closely as the reversed direction allows: for each voucher with a DEBIT
-- line on the 'tds_receivable' ledger (a deduction credited to us — a
-- CREDIT-side line on that same ledger would be a refund/write-off, a
-- different event, correctly excluded), look at the OTHER lines on that
-- SAME voucher for ledgers whose account_groups.ledger_role = 'debtor'.
-- Exactly one -> attribute the TDS to that customer's TAN. Zero or more than
-- one -> genuinely ambiguous, bucketed as "(unattributed)" rather than
-- guessed, same discipline 0053 already established. A debtor ledger found
-- but with no `tan` recorded is a THIRD, separately-labelled carve-out — it
-- can never match by construction, and is reported as its own count rather
-- than folded into "missing_from_statement" silently, the same care 0120's
-- report page takes with "no reference number entered".
--
-- SCOPE, stated rather than implied.
--   - TCS (the company as COLLECTEE, e.g. TCS suffered on purchase of goods
--     under 206C(1H) counterparty scenarios) is representable by this same
--     table (transaction_type = 'tcs') but is NOT matched against anything
--     — LEKHA has no "TCS Receivable" ledger/tax_ledger_map purpose the way
--     it has 'tds_receivable', so there is nothing on the register side to
--     reconcile a TCS row against yet. Stored for the record, excluded from
--     the match function's own WHERE clause, said explicitly here and in
--     the report page rather than silently mixed into the TDS totals.
--   - AIS's non-TDS/TCS information categories (SFT high-value transactions,
--     interest/dividend "other information", GST turnover cross-checks,
--     etc.) and all of TIS's category-aggregated rows are stored
--     (transaction_type = 'other') for audit/reference but never enter the
--     match — this schema has no per-category ledger to check them against.
--   - No auto-fetch from the income-tax portal. Exactly the framing 0120
--     already established for GSTN: the portal has no public API for this,
--     26AS/AIS/TIS are download-only, and AIS's own JSON/PDF download is
--     PAN+DOB password protected on top of that — this migration builds the
--     upload+match, not a fetch integration.
--   - No module_active() gate on the import function, DELIBERATELY
--     inconsistent with 0120's gst-module check: 0079's own
--     seed_tds_receivable_ledger backfilled the TDS Receivable ledger for
--     EVERY company regardless of module licensing, and neither
--     get_income_tax_computation nor tax_payments' own RLS policy checks
--     module_active('income_tax', ...) — this migration mirrors that
--     existing precedent (the direct one for this statutory area) rather
--     than 0120's (a genuinely licensed, activation-dated GST module).
--     Flagged explicitly for the integration pass in case that precedent
--     should change app-wide.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ledgers.tan — the customer's own TAN, for matching a debtor ledger against
-- a 26AS/AIS deductor row. Same shape/guard as the existing `pan` column.
-- ----------------------------------------------------------------------------
alter table public.ledgers
  add column tan text check (tan is null or app_private.is_valid_tan(tan));

comment on column public.ledgers.tan is
  'TAN of this ledger (when it is a customer who deducts TDS on payments to us) — the deductor identity 26AS/AIS report against. Opposite direction from is_tds_deductee/default_tds_section, which are for a party WE deduct TDS from. See 0148.';

-- ----------------------------------------------------------------------------
-- income_tax_statement_lines — one row per deductor/category transaction in
-- one company's uploaded 26AS, AIS or TIS for one financial year.
-- ----------------------------------------------------------------------------
create table public.income_tax_statement_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  source text not null check (source in ('26as', 'ais', 'tis')),

  -- 'YYYY-YY', this app's own income-tax financial-year label convention
  -- (app_private.fy_label, tax_payments.financial_year_label, 0130) — the
  -- calendar April-March tax year, not this company's own book year.
  financial_year_label text not null check (financial_year_label ~ '^\d{4}-\d{2}$'),

  deductor_tan text check (deductor_tan is null or app_private.is_valid_tan(deductor_tan)),
  -- Normalised match key, same tolerance 0120 applies to invoice numbers.
  -- Null when the source row genuinely carries no TAN (TIS category rows,
  -- and AIS's own non-TDS/TCS "other information" rows) — such a row can
  -- never enter the match, by construction, not by a guessed default.
  deductor_tan_normalized text generated always as
    (case when deductor_tan is null then null
          else upper(regexp_replace(deductor_tan, '[^A-Za-z0-9]', '', 'g')) end) stored,
  deductor_name text,

  -- Free text, not an FK to ref_tds_sections: AIS/TIS category descriptions
  -- ("Interest from savings bank", "Sale of securities") do not map 1:1 onto
  -- a TDS section code the way 26AS's own "Section" column does, and forcing
  -- one would misrepresent what the source file actually said — the same
  -- non-exhaustive-reason choice 0120 made for itc_reason.
  section_code text,
  information_category text,

  -- 'tcs' and 'other' are accepted and stored but excluded from the match
  -- function's own WHERE clause — see migration header SCOPE.
  transaction_type text not null default 'tds' check (transaction_type in ('tds', 'tcs', 'other')),

  transaction_date date,
  amount_paid_credited numeric(14, 2) not null default 0,
  tax_deducted numeric(14, 2) not null default 0,
  -- What was actually deposited against this PAN — the Sec 199/Rule 37BA
  -- creditable figure when it differs from tax_deducted (a deductor who
  -- withheld but has not yet deposited). Falls back to tax_deducted at
  -- import time when the source file has no separate deposited column
  -- (some AIS exports do not split the two) — see lib/csv/income-tax-
  -- statement-import.ts, not guessed at here.
  tax_deposited numeric(14, 2) not null default 0,

  -- Free text, not an enum: 26AS's own F/U/P/O codes are well-documented
  -- (Final/Unmatched/Provisional/Overbooked) but AIS/TIS use a differently-
  -- shaped reported/processed/derived-value model, not a single status code
  -- — an enum here would force a wrong pick on those rows.
  status_of_booking text,

  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  unique (id, company_id)
);

create index income_tax_statement_lines_period_idx
  on public.income_tax_statement_lines (company_id, financial_year_label, source);
create index income_tax_statement_lines_match_idx
  on public.income_tax_statement_lines (company_id, deductor_tan_normalized);

comment on table public.income_tax_statement_lines is
  'Uploaded 26AS/AIS/TIS lines, one row per deductor transaction (26AS/AIS) or category (TIS), one financial year at a time. Written only through import_income_tax_statement_lines (whole source+year replace) — no direct client write policy, same convention as gstr2b_lines (0120).';

alter table public.income_tax_statement_lines enable row level security;

-- `to authenticated` was missing here until 1844. Without it a policy defaults
-- to PUBLIC, which includes anon — and anon does hold SELECT on this table, so
-- only the USING clause was standing between an unauthenticated caller and
-- real rows. Corrected in place so a fresh database never reproduces it.
create policy income_tax_statement_lines_read on public.income_tax_statement_lines for select
  to authenticated
  using (app_private.is_company_member(company_id));

-- ----------------------------------------------------------------------------
-- import_income_tax_statement_lines — whole (source, financial_year) replace.
-- A 26AS/AIS/TIS download is a complete snapshot for its year, not an
-- appendable log — same reasoning as 0120's import_gstr2b_lines. Re-uploading
-- one source for a year replaces only that source's rows for that year;
-- uploading a second source for the same year is additive (both are kept,
-- distinguishable by `source`, since the match function requires the caller
-- to pick exactly one — see its own header note on why sources are never
-- summed together).
-- ----------------------------------------------------------------------------
create or replace function public.import_income_tax_statement_lines(
  p_company_id uuid,
  p_source text,
  p_financial_year_label text,
  -- [{"deductor_tan":"MUMA12345B","deductor_name":"Ashoka Traders",
  --   "section_code":"194C","information_category":null,
  --   "transaction_type":"tds","transaction_date":"2026-06-15",
  --   "amount_paid_credited":100000,"tax_deducted":10000,
  --   "tax_deposited":10000,"status_of_booking":"F"}]
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
    raise exception 'Not permitted to import tax statement data for this company';
  end if;
  if p_source not in ('26as', 'ais', 'tis') then
    raise exception 'Source must be one of 26as, ais, tis, got %', p_source;
  end if;
  if p_financial_year_label !~ '^\d{4}-\d{2}$' then
    raise exception 'Financial year label must look like "2026-27", got %', p_financial_year_label;
  end if;

  delete from public.income_tax_statement_lines
   where company_id = p_company_id
     and source = p_source
     and financial_year_label = p_financial_year_label;

  insert into public.income_tax_statement_lines (
    company_id, source, financial_year_label,
    deductor_tan, deductor_name, section_code, information_category,
    transaction_type, transaction_date,
    amount_paid_credited, tax_deducted, tax_deposited, status_of_booking,
    uploaded_by
  )
  select
    p_company_id, p_source, p_financial_year_label,
    nullif(upper(trim(l ->> 'deductor_tan')), ''),
    nullif(l ->> 'deductor_name', ''),
    nullif(l ->> 'section_code', ''),
    nullif(l ->> 'information_category', ''),
    coalesce(l ->> 'transaction_type', 'tds'),
    nullif(l ->> 'transaction_date', '')::date,
    coalesce((l ->> 'amount_paid_credited')::numeric, 0),
    coalesce((l ->> 'tax_deducted')::numeric, 0),
    coalesce((l ->> 'tax_deposited')::numeric, (l ->> 'tax_deducted')::numeric, 0),
    nullif(l ->> 'status_of_booking', ''),
    auth.uid()
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.import_income_tax_statement_lines(uuid, text, text, jsonb) from public, anon;
grant execute on function public.import_income_tax_statement_lines(uuid, text, text, jsonb) to authenticated;

comment on function public.import_income_tax_statement_lines(uuid, text, text, jsonb) is
  'Whole (source, financial_year_label) replace of one company''s uploaded 26AS/AIS/TIS lines: deletes any existing rows for that exact (company, source, year) then inserts p_lines. Pass an empty array to clear one. Client-side validation (lib/csv/income-tax-statement-import.ts) checks TAN format and amounts before calling this.';

-- ----------------------------------------------------------------------------
-- list_income_tax_statement_periods — which (source, year) uploads already
-- exist, for the import screen and the match report's "nothing uploaded"
-- prompt. Same shape as 0120's list_gstr2b_periods.
-- ----------------------------------------------------------------------------
create or replace function public.list_income_tax_statement_periods(p_company_id uuid)
returns table (
  source text,
  financial_year_label text,
  line_count integer,
  tan_count integer,
  uploaded_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    l.source, l.financial_year_label, count(*)::int,
    count(distinct l.deductor_tan_normalized)::int,
    max(l.created_at)
    from public.income_tax_statement_lines l
   where l.company_id = p_company_id
   group by l.source, l.financial_year_label
   order by l.financial_year_label desc, l.source;
$$;

revoke all on function public.list_income_tax_statement_periods(uuid) from public, anon;
grant execute on function public.list_income_tax_statement_periods(uuid) to authenticated;

comment on function public.list_income_tax_statement_periods(uuid) is
  'Uploaded 26AS/AIS/TIS (source, financial_year) combinations with a row count and distinct-deductor-TAN count each, newest year first — powers the import screen''s "already uploaded" list and the match report''s "nothing uploaded yet" prompt.';

-- ----------------------------------------------------------------------------
-- match_income_tax_statement_tds_receivable — the three-bucket
-- reconciliation, annual and TAN-keyed (see migration header for why).
-- p_source is REQUIRED, not defaulted to "all sources" the way 0120 defaults
-- p_gst_registration_id to null-meaning-every-registration: unlike separate
-- GST registrations (genuinely additive), 26AS and AIS's own TDS/TCS
-- Information part substantially OVERLAP (AIS is sourced from the same
-- underlying TDS statements as 26AS) — summing both would double-count the
-- same real-world deduction. The caller picks exactly one uploaded source to
-- match against at a time.
-- ----------------------------------------------------------------------------
create or replace function public.match_income_tax_statement_tds_receivable(
  p_company_id uuid,
  p_financial_year_label text,
  p_source text
) returns table (
  bucket text,                    -- 'matched' | 'missing_from_books' | 'missing_from_statement'
  deductor_tan text,
  deductor_name text,
  amount_paid_credited_statement numeric,
  tax_deducted_statement numeric,
  tax_deposited_statement numeric,
  tds_receivable_register numeric,
  amount_difference numeric,      -- register total - statement deposited total, matched rows only
  ledger_id uuid,
  ledger_name text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_fy_start date;
  v_fy_end date;
begin
  if p_financial_year_label !~ '^\d{4}-\d{2}$' then
    raise exception 'Financial year label must look like "2026-27", got %', p_financial_year_label;
  end if;
  if p_source not in ('26as', 'ais', 'tis') then
    raise exception 'Source must be one of 26as, ais, tis, got %', p_source;
  end if;

  v_fy_start := make_date(split_part(p_financial_year_label, '-', 1)::int, 4, 1);
  v_fy_end := make_date(split_part(p_financial_year_label, '-', 1)::int + 1, 3, 31);

  return query
  with stmt as (
    select
      s.deductor_tan, s.deductor_name,
      sum(s.amount_paid_credited) as amount_paid_credited,
      sum(s.tax_deducted) as tax_deducted,
      sum(s.tax_deposited) as tax_deposited,
      s.deductor_tan_normalized as tan_key
      from public.income_tax_statement_lines s
     where s.company_id = p_company_id
       and s.source = p_source
       and s.financial_year_label = p_financial_year_label
       and s.transaction_type = 'tds'
     group by s.deductor_tan, s.deductor_name, s.deductor_tan_normalized
  ),
  -- Deduction events: one row per voucher, DEBIT-side movement on the
  -- 'tds_receivable' ledger only (a credit-side line there is a refund or
  -- write-off, not a new TDS credit) — the mirror image of
  -- get_tds_deductee_summary's (0053) credit-side-only read of 'tds_payable'.
  tds_lines as (
    select e.voucher_id, sum(e.debit_amount) as tds_amount
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
      join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
     where e.company_id = p_company_id
       and m.purpose = 'tds_receivable'
       and e.debit_amount > 0
       and not v.is_deleted
       and v.voucher_date between v_fy_start and v_fy_end
     group by e.voucher_id
  ),
  debtor_candidates as (
    select e.voucher_id, e.ledger_id
      from public.voucher_entries e
      join public.ledgers l on l.id = e.ledger_id and l.company_id = e.company_id
      join public.account_groups g on g.id = l.group_id and g.company_id = e.company_id
      join tds_lines t on t.voucher_id = e.voucher_id
     where e.company_id = p_company_id
       and g.ledger_role = 'debtor'
  ),
  -- Exactly one distinct debtor-role ledger on the voucher -> that's the
  -- deductor. Zero or more than one -> genuinely ambiguous, not guessed —
  -- same discipline 0053 already established for the reverse direction.
  voucher_deductor as (
    select dc.voucher_id,
           case when count(distinct dc.ledger_id) = 1
                then (array_agg(distinct dc.ledger_id))[1] end as deductor_ledger_id
      from debtor_candidates dc
     group by dc.voucher_id
  ),
  attributed as (
    select t.voucher_id, t.tds_amount, vd.deductor_ledger_id
      from tds_lines t
      left join voucher_deductor vd on vd.voucher_id = t.voucher_id
  ),
  reg as (
    select
      l.id as ledger_id, l.name as ledger_name, l.tan,
      upper(regexp_replace(coalesce(l.tan, ''), '[^A-Za-z0-9]', '', 'g')) as tan_key,
      sum(a.tds_amount) as register_amount
      from attributed a
      left join public.ledgers l on l.id = a.deductor_ledger_id
     group by l.id, l.name, l.tan
  ),
  matched as (
    select
      'matched'::text,
      stmt.deductor_tan, stmt.deductor_name,
      stmt.amount_paid_credited, stmt.tax_deducted, stmt.tax_deposited,
      reg.register_amount,
      (reg.register_amount - stmt.tax_deposited),
      reg.ledger_id, reg.ledger_name
    from stmt
    join reg on reg.tan_key = stmt.tan_key and reg.tan_key <> ''
  ),
  missing_from_books as (
    select
      'missing_from_books'::text,
      stmt.deductor_tan, stmt.deductor_name,
      stmt.amount_paid_credited, stmt.tax_deducted, stmt.tax_deposited,
      null::numeric, null::numeric,
      null::uuid, null::text
    from stmt
    where not exists (select 1 from reg where reg.tan_key = stmt.tan_key and reg.tan_key <> '')
  ),
  missing_from_statement as (
    select
      'missing_from_statement'::text,
      case when reg.ledger_id is null then null
           when reg.tan is null then null
           else reg.tan end,
      case when reg.ledger_id is null then '(unattributed — voucher had zero or multiple debtor-role ledgers)'
           when reg.tan is null then reg.ledger_name || ' (no TAN set on this ledger)'
           else reg.ledger_name end,
      null::numeric, null::numeric, null::numeric,
      reg.register_amount, null::numeric,
      reg.ledger_id, reg.ledger_name
    from reg
    where not exists (select 1 from stmt where stmt.tan_key = reg.tan_key and reg.tan_key <> '')
  )
  select * from matched
  union all select * from missing_from_books
  union all select * from missing_from_statement
  order by 1, 3;
end;
$$;

revoke all on function public.match_income_tax_statement_tds_receivable(uuid, text, text) from public, anon;
grant execute on function public.match_income_tax_statement_tds_receivable(uuid, text, text) to authenticated;

comment on function public.match_income_tax_statement_tds_receivable(uuid, text, text) is
  'Three-bucket 26AS/AIS/TIS reconciliation for one financial year, against one uploaded source at a time (never summed across sources — 26AS and AIS substantially overlap): matched (found both sides, by normalised deductor TAN, amounts SUMMED per TAN for the year since neither side carries a shared per-transaction key), missing_from_books (in the statement, no TDS Receivable voucher attributes to that TAN — not yet booked, or booked under a debtor ledger with no TAN recorded), missing_from_statement (booked here, TAN not in this upload — Sec 199/Rule 37BA credit at risk until the deductor''s own filing catches up). transaction_type=tcs and =other rows are stored but never enter this match — no TCS-receivable or per-AIS-category ledger exists yet to reconcile them against.';
