-- ============================================================================
-- 0085 — The employer's own statutory registration numbers
-- ============================================================================
-- `companies` held pan, tan, iec and cin and nothing else. There was nowhere to
-- record the PF establishment code, the ESI employer code, a professional tax
-- registration or a labour welfare fund number — every one of which appears in
-- the HEADER of the return it belongs to. Payroll could compute a PF liability
-- to the rupee and still not produce an ECR, because an ECR has to say which
-- establishment it is for.
--
-- WHERE EACH ONE LIVES, AND WHY IT IS SPLIT.
--
--   companies   PF establishment code, ESI employer code, LIN, Shops &
--               Establishment registration. These identify the EMPLOYER.
--   branches    professional tax RC and EC, labour welfare fund code. These
--               are STATE levies, and `branches.state_code` already exists —
--               an employer operating in three states holds three PT
--               registrations and there is no single company-level value to
--               put in a column.
--
-- employees gains branch_id for the same reason: without knowing which
-- establishment an employee sits in, a PT liability cannot be attributed to a
-- state, and the per-state split that PT filing requires is not computable.
-- Left NULLABLE deliberately — a single-location business should not have to
-- answer a question that has only one possible answer, and payroll can read a
-- null as the head office.
--
-- ON FORMAT CHECKING — deliberately uneven, because the formats are.
--
-- The ESI employer code is a 17-digit number. That is firm enough to enforce,
-- and a mistyped or truncated one is worth catching, so it is checked on the
-- DIGIT COUNT AFTER STRIPPING SEPARATORS. It is commonly written
-- XX-XX-XXXXXX-XXX-XXXX and just as commonly as a bare 17-digit run; a regex
-- demanding one punctuation style would reject a correctly transcribed number,
-- which is worse than not checking at all.
--
-- The PF establishment code is NOT checked. It is region code + office code +
-- a 7-digit establishment number + a 3-digit extension, written variously as
-- MH/BAN/0000064/000 or MHBAN0000064000, and office codes are not a uniform
-- length across regions. Any pattern tight enough to be useful would reject
-- somebody's real code. Same for PT, LWF and Shops & Establishment, whose
-- formats are set by each State separately — the same reason 0043 refused to
-- hardcode a PT slab table and 0084 refused to put a PT due date in the
-- compliance calendar.
--
-- Nothing here is mandatory. A business that has not registered for PF has no
-- code to enter, and demanding one would make the form unusable for exactly
-- the small employers this app is aimed at.
-- ============================================================================

alter table public.companies
  add column if not exists pf_establishment_code text,
  add column if not exists esi_employer_code text,
  add column if not exists lin text,
  add column if not exists shops_establishment_reg text;

alter table public.companies
  drop constraint if exists companies_esi_employer_code_check;

-- 17 digits once separators are removed; any punctuation style accepted.
alter table public.companies
  add constraint companies_esi_employer_code_check
  check (
    esi_employer_code is null
    or length(regexp_replace(esi_employer_code, '[^0-9]', '', 'g')) = 17
  );

comment on column public.companies.pf_establishment_code is
  'EPFO establishment code — region + office + 7-digit establishment + 3-digit extension (e.g. MH/BAN/0000064/000). Deliberately unvalidated: office code lengths differ by region and the separators are written inconsistently. See 0085.';

comment on column public.companies.esi_employer_code is
  'ESIC 17-digit employer code from the C-11 registration letter. Checked on digit count after stripping separators, so both XX-XX-XXXXXX-XXX-XXXX and a bare run are accepted.';

alter table public.branches
  add column if not exists pt_registration_number text,
  add column if not exists pt_enrolment_number text,
  add column if not exists lwf_establishment_code text;

comment on column public.branches.pt_registration_number is
  'Professional tax REGISTRATION certificate (PTRC) — the employer''s, for tax deducted from employees'' salaries. On branches rather than companies because PT is a State levy and a multi-state employer holds one per State. See 0085.';

comment on column public.branches.pt_enrolment_number is
  'Professional tax ENROLMENT certificate (PTEC) — the entity''s own professional tax, distinct from what it deducts for employees. The two are separate registrations and separate payments.';

alter table public.employees
  add column if not exists branch_id uuid;

-- COMPOSITE, not a plain reference to branches(id). This schema's own
-- convention (voucher_items has four of these) is to carry company_id into the
-- foreign key so a row cannot point at another tenant's record — RLS filters
-- what you can SELECT, it does not stop you writing a branch_id belonging to
-- someone else's company. branches already carries the UNIQUE (id, company_id)
-- this needs.
alter table public.employees
  drop constraint if exists employees_branch_id_fkey;

alter table public.employees
  drop constraint if exists employees_branch_id_company_id_fkey;

alter table public.employees
  add constraint employees_branch_id_company_id_fkey
  foreign key (branch_id, company_id) references public.branches(id, company_id)
  on delete set null;

create index if not exists employees_branch_idx on public.employees (branch_id);

comment on column public.employees.branch_id is
  'Which establishment this employee belongs to. Nullable — a single-location business has only one answer and should not be made to give it; payroll reads a null as the head office. Needed to attribute professional tax to a State. See 0085.';
