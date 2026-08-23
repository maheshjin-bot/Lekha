-- ============================================================================
-- 0093 — Employee tax declarations and the Sec 115BAC(1A) regime election
-- ============================================================================
-- employees carries id, company_id, name, pan, uan, esi_number, date_of_
-- joining, date_of_leaving, is_active, branch_id and nothing about how an
-- individual employee's own salary income tax is worked out. That gap has
-- been visible and documented, not hidden, since 0043 and again in 0049:
-- get_salary_tds_estimate projects Sec 192 TDS on a pure new-regime basis
-- for every employee unconditionally, and its own UI text (payroll-register
-- page, "Sec 192 — how the TDS above was worked out") says outright that it
-- "ignores ... Chapter VI-A declarations ... other income the employee has
-- declared, and tax already withheld by a previous employer this year"
-- because there was nowhere to record any of that. This migration is the
-- data-capture prerequisite that section describes as missing. It does NOT
-- change what get_salary_tds_estimate computes — see the scope note at the
-- bottom.
--
-- WHY companies.company_tax_regime IS NOT REUSED. That column is a
-- completely different election: the COMPANY's own Sec 115BAA/115BAB
-- corporate-tax regime, decided once by the entity itself. What this
-- migration records is an INDIVIDUAL EMPLOYEE's personal Sec 115BAC(1A)
-- income-tax regime choice for their own salary — a different taxpayer,
-- a different section, re-decided every financial year. Conflating the two
-- would silently apply an employee's declaration to the company's own
-- return or vice versa.
--
-- THE MECHANICS, verified fresh (this area has moved through several CBDT
-- circulars since 2020 and training data is not to be trusted on it):
--   * Sec 115BAC(1A), inserted by Finance Act 2023, makes the NEW regime
--     the DEFAULT for every individual/HUF from AY 2024-25 (FY 2023-24)
--     onward — still the default through AY 2026-27, unchanged.
--   * CBDT Circular No. 4/2023 (5 Apr 2023) directs that an employer must
--     seek, from EACH employee, EACH financial year, an intimation of the
--     regime the employee intends to be taxed under FOR TDS PURPOSES.
--     Silence is not neutral: no intimation received means the employer
--     deducts TDS on the DEFAULT (new-regime) basis for that employee —
--     there is no "undeclared" middle state at the withholding stage, only
--     a declared-old, a declared-new, and a not-declared-so-defaulted-to-
--     new. This schema still models the third state honestly by allowing a
--     financial year to have NO ROW at all (see below), because the ABSENCE
--     of a declaration is itself the fact that drives the default, and a
--     future consumer needs to be able to tell "declared new" apart from
--     "never asked."
--   * The regime named to the employer is for TDS ONLY and does not bind
--     the employee's own return: at ITR-filing time the employee may file
--     under the other regime and settle the difference as a refund or
--     additional tax due, entirely outside what the employer computed.
--     Nothing here needs to model that reconciliation — it happens on the
--     employee's own return, not in this employer-side ledger.
--   * Once declared to the employer for a year, the regime is not switched
--     again mid-year for TDS purposes — which is exactly why "one
--     declaration row per employee per financial year" (enforced below by
--     a UNIQUE constraint) is the right grain, not one row per employee
--     that gets overwritten, and not multiple rows per year.
--
-- WHY A SEPARATE TABLE, NOT COLUMNS ON employees. A declaration is
-- intrinsically PER FINANCIAL YEAR — the employee stays on the books for
-- many years and re-declares (or doesn't) every one of them under Circular
-- 4/2023. Columns on employees could hold only the current year's answer
-- and would destroy every prior year's the moment a new one is entered,
-- which breaks history needed for a Form 16 / Sec 192 audit trail across
-- years. A child table keyed by financial year keeps every year's
-- declaration addressable, including years with no declaration at all —
-- which is simply the absence of a row, not a null-filled placeholder row
-- someone has to remember to leave "empty."
--
-- WHAT'S CAPTURED, AND DELIBERATELY AS RAW FACTS, NOT A COMPUTATION.
--   regime               'old' or 'new' — the fact under Circular 4/2023.
--   declaration_date     when the employee actually gave it. Not defaulted
--                         to today's date by the database, because the form
--                         may be used to record a declaration made earlier
--                         and back-entered — the app should ask, not assume.
--   Old-regime deduction placeholders — only meaningful, and only ever
--   read by a future computation, when regime = 'old': deduction_80c,
--   deduction_80d, hra_exemption_claimed, home_loan_interest_24b. These are
--   the amount the employee is CLAIMING, not the underlying receipts or
--   rent/city facts a real computation would need to verify or derive it
--   (e.g. HRA exemption is itself normally computed from rent paid, actual
--   HRA drawn and metro/non-metro city — none of that is captured here).
--   That is a real simplification, made deliberately: this task builds the
--   data model a future computation reads, not the computation itself, and
--   the shape that a future engine will actually need is "how much is this
--   employee claiming under each head" at minimum, with the finer
--   underlying facts (rent receipts, loan sanction letters, city) staying
--   an employer-side paper record exactly as Form 12BB already treats them
--   — LEKHA has no Form 12BB workflow to attach evidence to and is not
--   building one here.
--   Chapter VI-A categories NOT captured (80CCD employee NPS beyond 80C,
--   80E education loan interest, 80TTA/TTB, 80G) and other-income heads
--   (Sec 192(2B) income from house property/other sources the employee has
--   declared) are OUT OF SCOPE for this pass — 80C and 80D are the two
--   categories that in practice carry the overwhelming majority of salaried
--   old-regime claims, and a home-loan-interest field covers the other
--   large one (Sec 24(b)); a fuller Chapter VI-A schedule is future work
--   once an old-regime tax ENGINE exists to consume it, not before.
--   previous_employer_income / previous_employer_tds_deducted — Sec
--   192(2): a mid-year joiner may furnish their income and TDS already
--   deducted by a previous employer this financial year, so the current
--   employer can account for it. Independent of the regime question
--   entirely (a joiner reports this whichever regime they land in), so it
--   lives on the same per-financial-year row rather than being gated by
--   regime.
--
-- NO CAPS ENFORCED. Sec 80C is capped at Rs 1,50,000, Sec 80D varies by age
-- and whether parents are senior citizens, Sec 24(b) at Rs 2,00,000 for a
-- self-occupied property. None of those caps are enforced by a CHECK here,
-- on purpose: a CHECK cannot tell a self-occupied home loan from a let-out
-- one (where Sec 24(b) has no cap at all), or a taxpayer's own age band for
-- 80D, and enforcing the self-occupied number as a blanket ceiling would
-- silently reject a legitimate let-out-property claim. Same reasoning
-- 0086 already used for not enforcing the LDC rate ceiling by CHECK — the
-- future computation that actually applies these caps correctly is the
-- right place to enforce them, with the facts (self-occupied vs let-out,
-- age) in hand that a CHECK constraint never will be.
--
-- SCOPE, STATED EXPLICITLY: this migration makes the declaration a
-- recordable FACT. It does NOT wire this data into get_salary_tds_estimate
-- (0049/0075) or post_payroll_run, and it does NOT compute old-regime tax
-- liability at all — that needs a full old-regime slab/deduction engine,
-- a genuinely separate and large piece of work this app does not have in
-- any form yet. get_salary_tds_estimate keeps projecting pure new-regime
-- TDS for every employee, exactly as it already documents itself doing,
-- until a later pass reads this table.
-- ============================================================================

create table public.employee_tax_declarations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null,
  company_id uuid not null,
  financial_year_label text not null
    check (financial_year_label ~ '^\d{4}-\d{2}$'),
  regime text not null check (regime in ('old', 'new')),
  declaration_date date not null,

  -- Old-regime claims. Meaningful only when regime = 'old'; enforced below
  -- rather than left to convention, so a 'new' row cannot silently carry
  -- stale or meaningless deduction figures.
  deduction_80c numeric not null default 0 check (deduction_80c >= 0),
  deduction_80d numeric not null default 0 check (deduction_80d >= 0),
  hra_exemption_claimed numeric not null default 0 check (hra_exemption_claimed >= 0),
  home_loan_interest_24b numeric not null default 0 check (home_loan_interest_24b >= 0),

  -- Sec 192(2): a mid-year joiner's income and TDS from a previous employer
  -- this financial year. Independent of the regime column — applies either
  -- way.
  previous_employer_income numeric not null default 0 check (previous_employer_income >= 0),
  previous_employer_tds_deducted numeric not null default 0 check (previous_employer_tds_deducted >= 0),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (employee_id, company_id)
    references public.employees (id, company_id) on delete cascade,

  -- One declaration per employee per financial year — matches Circular
  -- 4/2023's own grain (an intimation is sought, and given, once a year)
  -- and is exactly what stops a second declaration from silently
  -- shadowing the first rather than correcting it.
  unique (employee_id, financial_year_label),

  -- A 'new' regime row carrying non-zero old-regime deduction figures is
  -- meaningless input, not a legitimate edge case: the new regime does not
  -- recognise these deductions at all (barring the standard deduction,
  -- which is not employee-declared and lives in get_salary_tds_estimate's
  -- own computation, not here).
  check (
    regime = 'old'
    or (
      deduction_80c = 0
      and deduction_80d = 0
      and hra_exemption_claimed = 0
      and home_loan_interest_24b = 0
    )
  )
);

create index employee_tax_declarations_lookup_idx
  on public.employee_tax_declarations (employee_id, financial_year_label);

create index employee_tax_declarations_company_idx
  on public.employee_tax_declarations (company_id);

create trigger set_updated_at before update on public.employee_tax_declarations
  for each row execute function app_private.set_updated_at();

comment on table public.employee_tax_declarations is
  'One row per employee per financial year: the Sec 115BAC(1A) regime the employee declared to the employer under CBDT Circular 4/2023 (or its absence — a financial year with no row means no declaration was filed, which is itself the fact that makes new-regime the TDS default), plus old-regime deduction claims and Sec 192(2) previous-employer figures. Data capture only — see 0093 for why get_salary_tds_estimate does not yet read this table.';

comment on column public.employee_tax_declarations.regime is
  '''old'' or ''new'' — the regime named to the employer for TDS purposes this financial year under CBDT Circular 4/2023. Does not bind the employee''s own ITR, which may be filed under the other regime with the difference settled as refund/additional tax outside this app.';

comment on column public.employee_tax_declarations.deduction_80c is
  'Claimed Sec 80C deduction for this financial year, old regime only. The amount claimed, not the underlying investment receipts (LIC premium, PPF, ELSS, etc.) — those stay an employer-side Form 12BB paper record, same as this app already leaves rent receipts and loan sanction letters undigitised elsewhere.';

comment on column public.employee_tax_declarations.hra_exemption_claimed is
  'Claimed HRA exemption amount, old regime only. Recorded as the claimed figure directly — NOT computed here from rent paid, actual HRA drawn and metro/non-metro city, which a real Sec 10(13A) computation needs and this table does not capture. A future computation engine would need those three facts added, not just this total.';

comment on column public.employee_tax_declarations.home_loan_interest_24b is
  'Claimed Sec 24(b) home loan interest deduction, old regime only. No cap enforced by CHECK: the Rs 2,00,000 ceiling applies only to a self-occupied property and a let-out property has no cap at all, a distinction this table does not capture and a blanket CHECK would get wrong for half the cases.';

comment on column public.employee_tax_declarations.previous_employer_income is
  'Sec 192(2): income reported by a mid-year joiner from a previous employer this financial year, so the current employer can account for it. Independent of the regime column — a fact reported whichever regime the employee is under.';

comment on column public.employee_tax_declarations.previous_employer_tds_deducted is
  'Sec 192(2): TDS already deducted by a previous employer this financial year, as reported by a mid-year joiner.';

-- ----------------------------------------------------------------------------
-- Row level security — same bar as employees itself (0043): this carries
-- income and deduction detail, so write is admin-only, read is any member.
-- ----------------------------------------------------------------------------
alter table public.employee_tax_declarations enable row level security;

create policy employee_tax_declarations_read on public.employee_tax_declarations
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy employee_tax_declarations_write on public.employee_tax_declarations
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));
