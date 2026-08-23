-- ============================================================================
-- 0088 — The director / KMP master this app never had (audit item T2-16)
-- ============================================================================
-- There was no table, RPC or screen anywhere holding a company's directors,
-- designated partners or key managerial personnel. A repo-wide search for
-- "DIN" returned exactly two lines, both SQL comments in 0062 (the
-- get_compliance_calendar migration that reads ROC due dates). That function
-- already emits an annual "DIR-3 KYC (director/partner KYC)" reminder for
-- every ROC-applicable company — see 0062's own header and the roc_dir3_kyc
-- CTE it added — with absolutely no knowledge of how many directors exist,
-- who they are, or whether any of them have ceased. This migration is the
-- people layer that reminder has been missing since the day it was written.
-- The company IDENTITY layer already existed (companies.cin,
-- companies.incorporation_date, and since 0085 the employer's own
-- registration numbers); only the PEOPLE who run the company were absent.
--
-- NOT WIRED INTO get_compliance_calendar HERE — deliberately. Making the
-- DIR-3 KYC reminder director-count-aware (e.g. one line per still-serving
-- DIN holder instead of one generic line per company) is valuable follow-on
-- work, but this migration's job is the master record, not that function's
-- rewrite. See the structured report's scope_deferred for why it stayed out.
--
-- TABLE NAME: company_directors, not "directors" — this schema's own
-- convention names a tenant-scoped master by the plural of what it holds
-- (notices, employees, branches), and "directors" bare would read as if it
-- belonged to some other directors table shared across tenants, which it
-- is not.
--
-- DESIGNATION LIST — researched (WebSearch, Aug 2026) against what DIR-12
-- (particulars of appointment of directors/KMP) actually files, not
-- assumed. DIR-12 covers a director/KMP appointment or cessation and,
-- per Sec 2(51) Companies Act 2013, "key managerial personnel" is CEO-or-
-- MD-or-Manager, company secretary, whole-time director and CFO. The list
-- below is the union of the board-level roles DIR-12 recognises and the
-- KMP roles Sec 2(51) defines, plus 'designated_partner' for an LLP (which
-- files its own equivalent, Form 4, not DIR-12) and one OPC-only value
-- explained below:
--   director                — ordinary/additional-once-regularised director
--   managing_director
--   whole_time_director
--   independent_director    — Sec 149(6): specifically NOT a nominee or
--                              whole-time/managing director; the two check
--                              constraints below don't need to re-enforce
--                              that exclusion because this is a flat
--                              designation column, not an "independent" flag
--                              layered on top of another designation
--   nominee_director         — Sec 149/161(3): a director an investor or
--                              lender puts on the BOARD. Genuinely a
--                              different fact from an OPC's Sec 3(1)
--                              nominee below — see is_opc_nominee.
--   additional_director
--   alternate_director
--   designated_partner       — LLP. Per 0084's own already-established
--                              finding, DPIN was merged into the DIN system
--                              in 2018, so a designated partner's number
--                              today IS a DIN, not a separate DPIN series —
--                              treated as settled here, not re-litigated.
--   company_secretary        — KMP, Sec 203
--   chief_financial_officer  — KMP, Sec 2(51)
--   manager                  — KMP, Sec 2(53)/2(51); an alternative to MD/CEO,
--                              not usually held alongside one
--   ceo                      — KMP, Sec 2(51); an alternative to MD/manager
--   opc_nominee               — see below; NOT a director or KMP role at all
--
-- THE OPC NOMINEE IS A DIFFERENT FACT FROM A "NOMINEE DIRECTOR", AND
-- CONFLATING THEM WOULD HAVE BEEN A REAL BUG. A second, skeptical search
-- pass on this specific point (the first pass's summary was ambiguous
-- enough to invite the mistake) confirmed: under Sec 3(1)(c) Companies Act
-- 2013 and Rule 4 of the Incorporation Rules, an OPC's sole member must
-- name, in the memorandum (Form INC-3), an individual who becomes the
-- MEMBER of the company if the subscriber dies or is incapacitated. That
-- person is a successor-in-membership, not a board appointee — ref_
-- entity_types.special_provisions already flags this for 'opc' as "Nominee
-- required", which is this exact fact, already known to this app's seed
-- data and now finally representable. is_opc_nominee is therefore its own
-- boolean, ORTHOGONAL to designation: the same natural person commonly
-- holds both roles in a one-director OPC (nominee AND a director), so the
-- flag can be true on a 'director' row. 'opc_nominee' exists as its own
-- designation value only for the case where the nominee holds no board
-- role at all — nothing in company law requires them to be a director, and
-- an OPC with only its sole director-member would otherwise have no row at
-- all for a person this schema needs to remember. The one check constraint
-- tying the two together says only "opc_nominee designation implies the
-- flag", never the reverse.
--
-- DIN: AN 8-DIGIT NUMBER, LIFETIME, CHECKED ON DIGIT COUNT — verified
-- (WebSearch, Aug 2026): allotted under Sec 154 Companies Act 2013 / Rule
-- 10 of the Companies (Appointment and Qualification of Directors) Rules
-- 2014, unique to the individual for life once allotted, always written as
-- a bare 8-digit run (unlike PAN/GSTIN there is no separator convention to
-- accommodate, so the check is a plain regex rather than 0085's
-- strip-then-count approach). Nullable: a company_secretary, manager or
-- chief_financial_officer who is not also a director commonly has no DIN
-- at all — PAN is their identifier instead — and an opc_nominee with no
-- board role may have neither.
--
-- din_allotment_date is nullable independently, but can't be set without a
-- din — an allotment date describes a DIN, not a person who doesn't have
-- one yet.
--
-- WHY NO RPC. Unlike get_notices (0059), which computes is_overdue and
-- days_remaining against current_date and so earns a function to compute
-- that once server-side, "currently serving" here is nothing more than
-- date_of_cessation is null — no date arithmetic, no "as of today" logic
-- that could drift between two callers. A plain RLS-gated table, read the
-- same way app/(app)/[companyId]/employees/page.tsx already reads
-- `employees` directly, is the honest amount of machinery. Per this
-- schema's own convention, that also means no SECURITY DEFINER function
-- exists here to carry the revoke/grant pair from public/anon — there is
-- nothing to revoke it from.
--
-- RLS mirrors notices (0059) exactly: is_company_member for read,
-- can_write_company for write, verified live at
-- `select policyname, cmd, qual, with_check from pg_policies where
-- tablename = 'notices'` before writing the policies below.
-- ============================================================================

create table public.company_directors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  din text,
  din_allotment_date date,
  designation text not null check (designation in (
    'director', 'managing_director', 'whole_time_director', 'independent_director',
    'nominee_director', 'additional_director', 'alternate_director',
    'designated_partner', 'company_secretary', 'chief_financial_officer',
    'manager', 'ceo', 'opc_nominee'
  )),
  pan text check (app_private.is_valid_pan(pan)),
  date_of_appointment date not null,
  -- Nullable — a still-serving director/KMP has none. This, together with
  -- date_of_appointment, is the fact the compliance calendar's DIR-3 KYC
  -- reminder currently has no way to see (see migration header).
  date_of_cessation date,
  -- Sec 3(1) OPC successor-member nominee — see migration header for why
  -- this is deliberately not folded into `designation` as "nominee_director".
  is_opc_nominee boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (date_of_cessation is null or date_of_cessation >= date_of_appointment),
  -- Bare 8-digit run, no separator convention to strip — see header.
  check (din is null or din ~ '^[0-9]{8}$'),
  check (din_allotment_date is null or din is not null),
  -- opc_nominee designation implies the flag; the flag may independently be
  -- true on any other designation (the same person is commonly both a
  -- director and the OPC's memorandum nominee).
  check (designation <> 'opc_nominee' or is_opc_nominee)
);

create index company_directors_company_idx on public.company_directors (company_id, date_of_cessation);

create trigger set_updated_at before update on public.company_directors
  for each row execute function app_private.set_updated_at();

alter table public.company_directors enable row level security;

create policy company_directors_read on public.company_directors
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy company_directors_write on public.company_directors
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.company_directors is
  'Director / designated-partner / KMP master (audit T2-16). Currently serving = date_of_cessation is null. is_opc_nominee is the Sec 3(1) OPC successor-member nominee, a DIFFERENT fact from designation = nominee_director (a Sec 149/161(3) board nominee) — see 0088 header. Not yet wired into get_compliance_calendar''s DIR-3 KYC reminder (0062/0084) — that reminder still fires per-company, not per-DIN-holder; see 0088''s structured report for why that was scoped out.';

comment on column public.company_directors.din is
  'Director Identification Number — 8 digits, lifetime once allotted (Sec 154, Rule 10). Nullable: a KMP who is not also a director (company_secretary, manager, chief_financial_officer) commonly has none, and neither does an opc_nominee with no board role. A designated_partner''s number is also a DIN, not a separate DPIN — DPIN was merged into the DIN system in 2018 (established in 0084, not re-verified here).';

comment on column public.company_directors.is_opc_nominee is
  'The Sec 3(1)(c)/Form INC-3 nominee named in an OPC''s memorandum to succeed the sole member on death or incapacity — a MEMBERSHIP succession fact, not a directorship. Orthogonal to designation: true is normal on a director row (the same person is often both) and is the only sensible value when designation = opc_nominee (a person with no board role at all). See 0088 header for the point this corrects — do not read "nominee_director" as the same fact.';
