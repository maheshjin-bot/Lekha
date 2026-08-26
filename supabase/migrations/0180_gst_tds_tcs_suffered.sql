-- ============================================================================
-- 0180 — GST TDS/TCS SUFFERED: Sec 51 (government/PSU deductor) and Sec 52
-- (e-commerce operator collector) credit this company needs to claim
-- ============================================================================
-- CONFIRMED LIVE THIS DOES NOT EXIST YET, BEFORE WRITING A LINE OF THIS
-- MIGRATION. Every TDS/TCS table and function shipped so far this session —
-- tds_payable/tax_ledger_map purpose 'tds_payable' (0053), tds_receivable
-- (0079/0148), output_tcs/get_tcs_collectee_summary (0146) — is Income-tax
-- Act machinery (Sec 194-series / Sec 206C). Checked live:
--   select table_name from information_schema.tables
--    where table_schema = 'public' and (table_name ilike '%gst_tds%' or
--    table_name ilike '%gst_tcs%');                              -> 0 rows
--   select routine_name from information_schema.routines
--    where routine_schema = 'public' and (routine_name ilike '%gst_tds%'
--    or routine_name ilike '%gst_tcs%');                         -> 0 rows
--   select column_name from information_schema.columns where table_schema
--    = 'public' and (column_name ilike '%sec51%' or column_name ilike
--    '%sec52%');                                                 -> 0 rows
-- The GST-law mechanism (Sec 51/52 CGST Act) is genuinely unbuilt.
--
-- WHY "SUFFERED" ONLY, NOT THE DEDUCTOR/OPERATOR (GSTR-7/GSTR-8 FILING)
-- SIDE — per the audit's own explicit recommendation. Sec 51 deductors are
-- government departments, local authorities, PSUs, and (since 1-Oct-2024,
-- Notification 25/2024-CT) buyers of metal scrap under Chapter 72-81 —
-- almost none of this app's SMB users. Sec 52 collectors are e-commerce
-- operators themselves (Amazon/Flipkart-shaped platforms), not the sellers
-- who use them. What plenty of this app's users ARE: a supplier who gets
-- paid by a government buyer (suffers Sec 51 TDS) or who sells THROUGH a
-- marketplace (suffers Sec 52 TCS). This migration is the claim side only.
--
-- STATUTORY RESEARCH — WebSearch'd today, an "obvious answer" pass and a
-- deliberately skeptical second pass, because the task brief's own stated
-- rates turned out to be half right and half stale:
--
--   Sec 51 GST TDS — RATE UNCHANGED, confirmed by two independent sources
--   (TaxGuru, Masters India, both read today): 2% total on the payment
--   (1% CGST + 1% SGST for an intra-state deduction, or 2% IGST for an
--   inter-state one), deducted when the value of a single contract for
--   taxable supply exceeds Rs 2.5 lakh (the invoice value net of GST).
--   Deductors: government departments/agencies, local authorities, PSUs,
--   and entities with >=51% government equity — widened from 1-Oct-2024 to
--   also cover registered buyers of metal scrap (HSN Chapter 72-81),
--   confirmed by the same search. The 2.5-lakh threshold and 2% rate were
--   NOT touched by Union Budget 2026 — the "obvious" answer here happened
--   to still be right.
--
--   Sec 52 GST TCS — RATE ACTUALLY CHANGED, and this is exactly the trap
--   the task brief warned about: it is NOT 1% any more. CBIC Notification
--   15/2024-Central Tax, 10-Jul-2024 (53rd GST Council meeting) halved the
--   rate from 1% (0.5% CGST + 0.5% SGST, or 1% IGST) to the CURRENT 0.5%
--   (0.25% CGST + 0.25% SGST, or 0.5% IGST) with effect from 10-Jul-2024 —
--   confirmed independently by TaxGuru, TaxScan, ClearTax and CBIC's own
--   notification text (gstindia.biz mirror read today), all agreeing on
--   both the old and new figures and the effective date. Computed on the
--   NET value of taxable supplies made through the platform for the month
--   (gross supplies minus returns), per Sec 52(1) CGST Act — confirmed by
--   the same sources. A pre-Jul-2024 period genuinely carries the old 1%
--   figures on its portal statement; this migration stores whatever amount
--   the user actually enters (what the portal showed for that period) and
--   does NOT enforce a rate via CHECK, for exactly that reason — see the
--   table's own column comments.
--
--   THE RECONCILIATION MECHANISM — CONFIRMED NOT TO BE GSTR-2A/2B. That
--   would have been the "obvious wrong answer": 2A/2B are the PURCHASE-side
--   ITC-matching statements this app already has an importer/matcher for
--   (0120, gstr2b_lines/match_gstr2b_purchases) — a completely different
--   GST mechanism (Sec 16/38, vendor invoices) from Sec 51/52 credit. The
--   GST portal's own tutorial (tutorial.gst.gov.in) confirms Sec 51/52
--   credit runs through a DISTINCT statement, "TDS and TCS Credit
--   Received" — shaped like GSTR-2A (auto-populated from the deductor's
--   GSTR-7 / operator's GSTR-8 for the period) but a separate document with
--   its own accept/reject workflow. Accepted rows are credited to the
--   Electronic Cash Ledger only after the deductee FILES the "TDS/TCS
--   Credit Received" statement; rejected rows flow back to Table 4 of the
--   deductor/operator's NEXT GSTR-7/8 for correction. This confirms the
--   task brief's framing (auto-populated credit landing in the electronic
--   cash ledger from the deductor/operator's own return) while correcting
--   the specific document name — it is not literally GSTR-2A/2B.
--
-- WHY MANUAL ENTRY, NOT AN AUTO-POPULATION FEED. The "TDS and TCS Credit
-- Received" statement above lives on the GST portal; nothing in this
-- schema has a feed for it (unlike 0120's GSTR-2B, which the task treated
-- as CSV-uploadable — the portal does offer a downloadable JSON/CSV for
-- 2B, but no equivalent bulk-export is documented for this specific
-- statement, and the task brief itself scoped auto-population out
-- explicitly). This credit information originates OUTSIDE this company's
-- own books — the deductor/operator reports it, not this company — so a
-- preparer records here what the portal itself shows, the same posture
-- 0148 took for 26AS/AIS before matching existed for it, except here there
-- is nothing on the register side to match against yet either (no ledger
-- posting — see below).
--
-- NO LEDGER POSTING. Unlike tds_receivable (0079), which is a real ledger
-- debited on receipt vouchers, this migration adds no ledger and posts no
-- voucher. The actual cash-ledger credit happens on the GST PORTAL, not in
-- this company's books — GSTR-3B Table 6.2 lets a taxpayer set off output
-- tax liability against the electronic cash ledger balance generally, not
-- against "TDS/TCS credit" as a separate line the books need to track by
-- debit/credit. claimed_in_gstr3b is therefore a plain boolean flag (was
-- this credit actually used to pay a GSTR-3B liability yet, per the
-- preparer's own knowledge), not a computed ledger balance. If a future
-- feature wants to post the cash-ledger effect into the books (e.g. a
-- "GST Cash Ledger" asset ledger debited when a Sec 51/52 credit is
-- confirmed), that is new scope, flagged here rather than silently done.
--
-- gst_registration_id IS REQUIRED, NOT COMPANY-WIDE. Sec 25(4) treats each
-- GSTIN as a distinct person with its own electronic cash ledger — a Sec
-- 51/52 credit lands in the cash ledger of the SPECIFIC GSTIN the deductor/
-- operator reported against (the supplying registration's GSTIN on the
-- underlying invoice), never pooled company-wide. Composite FK to
-- gst_registrations(id, company_id), same tenancy convention as every
-- other GSTIN-scoped table in this schema (e.g. tax_ledger_map).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- gst_tds_tcs_suffered — one row per deductor/operator-period credit entry,
-- as recorded from the GST portal's "TDS and TCS Credit Received" statement
-- (or the deductor's GSTR-7A / operator's own monthly TCS statement, before
-- the portal-side statement is checked) for one GSTIN.
-- ----------------------------------------------------------------------------
create table public.gst_tds_tcs_suffered (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  gst_registration_id uuid not null,

  source_type text not null check (source_type in ('sec51_tds', 'sec52_tcs')),

  deductor_or_operator_gstin char(15) not null
    check (app_private.is_valid_gstin(deductor_or_operator_gstin)),
  deductor_or_operator_name text not null check (length(trim(deductor_or_operator_name)) > 0),

  -- The GSTR-7 (Sec 51) / GSTR-8 (Sec 52) filing period this credit was
  -- reported in — always a calendar month: both returns are monthly-only,
  -- with no QRMP-equivalent quarterly option for a deductor/operator,
  -- confirmed live today (ClearTax/ DMI Finance, both agreeing GSTR-7 and
  -- GSTR-8 are due the 10th of the following month, every month). This is
  -- the DEDUCTOR/OPERATOR's filing period, independent of this company's
  -- own filing frequency (monthly or QRMP) as the deductee.
  period_label text not null check (period_label ~ '^\d{4}-(0[1-9]|1[0-2])$'),

  -- Apr-Mar GST/income-tax financial year containing period_label — the
  -- fixed statutory tax year, NOT this company's own books financial_year_
  -- start_month (govt/e-comm deductors and GST return periods always run
  -- calendar-April-to-March regardless of how any one deductee's books are
  -- configured). Computed by the trigger below from period_label; never
  -- trusted from the client, so the two columns can never disagree.
  financial_year_label text not null check (financial_year_label ~ '^\d{4}-\d{2}$'),

  -- Net taxable value the deduction/collection was computed on (Sec 51: the
  -- payment amount, ex-GST, under the deducting contract; Sec 52: the net
  -- value of taxable supplies through the platform for the month, per Sec
  -- 52(1) — gross less returns). Recorded, not derived: the underlying
  -- vouchers already exist in this company's own books as ordinary sales
  -- (Sec 52) or ordinary receipts (Sec 51) and are not linked row-for-row
  -- here — see SCOPE below.
  taxable_value numeric(14, 2) not null default 0 check (taxable_value >= 0),

  -- Whatever the portal statement actually shows for this period. NOT
  -- CHECK-constrained to a fixed rate against taxable_value: Sec 52's own
  -- rate changed from 1% to 0.5% on 10-Jul-2024 (see migration header), so
  -- a genuine pre-Jul-2024 period_label legitimately carries the OLD rate's
  -- figures, and enforcing "today's" rate here would reject real history.
  cgst_amount numeric(14, 2) not null default 0 check (cgst_amount >= 0),
  sgst_amount numeric(14, 2) not null default 0 check (sgst_amount >= 0),
  igst_amount numeric(14, 2) not null default 0 check (igst_amount >= 0),
  -- A deduction/collection is either intra-state (CGST+SGST) or inter-state
  -- (IGST) under one GSTIN, never both on the same entry — the same
  -- mutual-exclusivity the tax engine already enforces on voucher-level GST
  -- computation, applied here to a manually-entered figure instead of a
  -- computed one.
  check (igst_amount = 0 or (cgst_amount = 0 and sgst_amount = 0)),
  -- A row recording no actual credit is not useful data; catches an
  -- accidental all-zero save rather than silently storing a no-op entry.
  check (cgst_amount + sgst_amount + igst_amount > 0),

  -- Has this credit actually been claimed (used to pay a GSTR-3B output
  -- liability) yet, per the preparer's own knowledge — a plain status flag,
  -- not a computed ledger balance. See migration header: no ledger posts
  -- for this credit in this schema, so nothing here is derivable from the
  -- books.
  claimed_in_gstr3b boolean not null default false,

  notes text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (gst_registration_id, company_id)
    references public.gst_registrations (id, company_id)
);

create index gst_tds_tcs_suffered_company_idx
  on public.gst_tds_tcs_suffered (company_id, financial_year_label);
create index gst_tds_tcs_suffered_registration_idx
  on public.gst_tds_tcs_suffered (gst_registration_id);

comment on table public.gst_tds_tcs_suffered is
  'GST TDS (Sec 51, government/PSU/notified-deductor buyers) and GST TCS (Sec 52, e-commerce operators) suffered/collected on THIS company''s own supplies, as recorded from the GST portal''s "TDS and TCS Credit Received" statement. This is the credit-tracking side only (this company as deductee/supplier) — never the deductor/operator (GSTR-7/GSTR-8 filing) side, which almost no user of this app is. Manually entered: this data originates on the deductor/operator''s own return, outside this company''s books, and no auto-population feed for it exists in this schema. No ledger posting — see 0180 header.';

comment on column public.gst_tds_tcs_suffered.source_type is
  'sec51_tds = GST TDS under Sec 51 CGST Act, deducted by a government department/PSU/notified buyer on payment to this company (2% of the payment, split 1%+1% CGST/SGST or 2% IGST, above Rs 2.5 lakh per contract). sec52_tcs = GST TCS under Sec 52 CGST Act, collected by an e-commerce operator on this company''s sales through their platform (currently 0.5% of net taxable supplies, split 0.25%+0.25% CGST/SGST or 0.5% IGST — reduced from 1% by CBIC Notification 15/2024-CT w.e.f. 10-Jul-2024; a pre-Jul-2024 period_label may legitimately carry the older 1% figures).';

comment on column public.gst_tds_tcs_suffered.period_label is
  'The deductor''s GSTR-7 (Sec 51) or operator''s GSTR-8 (Sec 52) monthly filing period this credit was reported in, "YYYY-MM" — both returns are strictly monthly with no QRMP-equivalent, independent of this company''s own GST filing frequency.';

comment on column public.gst_tds_tcs_suffered.financial_year_label is
  'Apr-Mar statutory tax year containing period_label ("2026-27"-shaped) — computed by the enforce_gst_tds_tcs_suffered trigger from period_label, never client-supplied, so the two can never disagree. Fixed calendar-April convention, independent of this company''s own books financial_year_start_month.';

comment on column public.gst_tds_tcs_suffered.claimed_in_gstr3b is
  'Whether this credit has actually been used to pay a GSTR-3B output-tax liability yet, per the preparer''s own knowledge. A plain status flag, not derived from any ledger — this migration posts no voucher for the credit (see table comment).';

alter table public.gst_tds_tcs_suffered enable row level security;

create policy gst_tds_tcs_suffered_read on public.gst_tds_tcs_suffered
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy gst_tds_tcs_suffered_write on public.gst_tds_tcs_suffered
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));
-- No explicit table-level revoke/grant needed here: 0080 already revoked
-- TRUNCATE/TRIGGER/REFERENCES project-wide and its default-privileges entry
-- covers this new table too; SELECT/INSERT/UPDATE/DELETE stay RLS-filtered
-- via the two policies above, the same bare pattern 0119's addendum table
-- uses.


-- ----------------------------------------------------------------------------
-- enforce_gst_tds_tcs_suffered — normalises the GSTIN, and (re)computes
-- financial_year_label from period_label so the two columns can never drift
-- apart via a direct client write. Plain BEFORE trigger (no cross-table
-- read needed — the gst_registration_id/company_id pairing is already
-- guaranteed by the composite FK), unlike 0119/0070's SECURITY DEFINER
-- voucher-validating triggers.
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_gst_tds_tcs_suffered()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_year int;
  v_month int;
  v_fy_start_year int;
begin
  new.deductor_or_operator_gstin := upper(new.deductor_or_operator_gstin);
  new.deductor_or_operator_name := trim(new.deductor_or_operator_name);

  v_year := split_part(new.period_label, '-', 1)::int;
  v_month := split_part(new.period_label, '-', 2)::int;
  v_fy_start_year := case when v_month >= 4 then v_year else v_year - 1 end;
  new.financial_year_label := v_fy_start_year || '-' || lpad(((v_fy_start_year + 1) % 100)::text, 2, '0');

  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_gst_tds_tcs_suffered
  before insert or update on public.gst_tds_tcs_suffered
  for each row execute function app_private.enforce_gst_tds_tcs_suffered();

comment on function app_private.enforce_gst_tds_tcs_suffered() is
  'Upper-cases deductor_or_operator_gstin, trims deductor_or_operator_name, and (re)computes financial_year_label from period_label on every insert/update — see 0180.';


-- ----------------------------------------------------------------------------
-- get_gst_tds_tcs_suffered_summary — grouped by source_type and deductor/
-- operator, for one company/FY (optionally one GSTIN). The report page's
-- data source.
-- ----------------------------------------------------------------------------
create or replace function public.get_gst_tds_tcs_suffered_summary(
  p_company_id uuid,
  p_gst_registration_id uuid default null,
  p_financial_year_label text default null
) returns table (
  source_type text,
  deductor_or_operator_gstin text,
  deductor_or_operator_name text,
  entry_count integer,
  taxable_value_total numeric,
  cgst_total numeric,
  sgst_total numeric,
  igst_total numeric,
  total_credit numeric,
  claimed_count integer,
  unclaimed_count integer,
  unclaimed_credit numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    s.source_type,
    s.deductor_or_operator_gstin,
    -- A deductor/operator can be reported with slightly different name
    -- spellings across periods (portal free text) — the most recent entry's
    -- name is shown as the representative label, GSTIN is the real key.
    (array_agg(s.deductor_or_operator_name order by s.period_label desc))[1],
    count(*)::int,
    sum(s.taxable_value),
    sum(s.cgst_amount),
    sum(s.sgst_amount),
    sum(s.igst_amount),
    sum(s.cgst_amount + s.sgst_amount + s.igst_amount),
    sum((s.claimed_in_gstr3b)::int)::int,
    sum((not s.claimed_in_gstr3b)::int)::int,
    sum(case when not s.claimed_in_gstr3b then s.cgst_amount + s.sgst_amount + s.igst_amount else 0 end)
  from public.gst_tds_tcs_suffered s
  where s.company_id = p_company_id
    and (p_gst_registration_id is null or s.gst_registration_id = p_gst_registration_id)
    and (p_financial_year_label is null or s.financial_year_label = p_financial_year_label)
  group by s.source_type, s.deductor_or_operator_gstin
  order by s.source_type, sum(s.cgst_amount + s.sgst_amount + s.igst_amount) desc;
$$;

revoke all on function public.get_gst_tds_tcs_suffered_summary(uuid, uuid, text) from public, anon;
grant execute on function public.get_gst_tds_tcs_suffered_summary(uuid, uuid, text) to authenticated;

comment on function public.get_gst_tds_tcs_suffered_summary(uuid, uuid, text) is
  'GST TDS (Sec 51) / TCS (Sec 52) suffered credit, grouped by source_type and deductor/operator GSTIN, for one company and (optionally) one GST registration and one Apr-Mar financial_year_label. unclaimed_credit is the total not yet flagged claimed_in_gstr3b — the amount a preparer should check is still available in the Electronic Cash Ledger before relying on it. See 0180 for full statutory sourcing.';
