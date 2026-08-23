-- ============================================================================
-- 0097 — LLP partner capital-contribution register
-- ============================================================================
-- company_directors (0088) already lets an LLP record its designated
-- partners under designation = 'designated_partner' (confirmed live before
-- writing a line of this migration —
--   select pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.company_directors'::regclass
--   and conname = 'company_directors_designation_check'
-- — the literal is exactly 'designated_partner', not 'designated partner' or
-- any other spelling). What it cannot do is answer the next question every
-- LLP eventually has to answer: how much has each partner actually put in.
--
-- WHY THIS EXISTS — LLP Act 2008 read with the LLP Rules 2009, verified by
-- WebSearch (Aug 2026), not recalled from training data:
--
--   * Sec 7(1): every LLP must have a minimum of TWO designated partners,
--     at least one resident in India. This migration does not enforce that
--     count — company_directors already lets a user save exactly one, or
--     zero — because that is a point-in-time incorporation fact this app
--     has no incorporation workflow to gate, the same reason 0088 did not
--     enforce it either. It is simply the reason "at least two" rows is
--     what this migration's own live verification seeds for Kapoor
--     Consulting LLP, not a constraint written into the schema.
--   * Sec 32: a partner's contribution "may consist of tangible, movable or
--     immovable or intangible property or other benefit... including money,
--     promissory notes, other agreements to contribute cash or property,
--     and contracts for services" — i.e. cash is not the only lawful form,
--     which is why contribution_type below is an enum, not an implicit
--     "amount = cash".
--   * The LLP AGREEMENT — not this app — is what fixes each partner's
--     committed capital and the ratio between them (Sec 23). There is no
--     per-partner statutory FILING of a contribution the moment it is
--     made; Form 3 files the agreement itself (or a change to it) within
--     30 days, and that is a document-filing fact, not a running ledger.
--     This table is the ledger the agreement's own commitment doesn't
--     give you: what has actually come in, and when.
--   * Form 11 (LLP annual return, filed within 60 days of FY end) asks for
--     TWO distinct aggregate figures per the MCA form itself: "total
--     obligation of contribution" (what the LLP agreement commits each
--     partner to) and "total contribution received" (what has actually
--     been paid in, matched against Form 8's Statement of Account and
--     Solvency). This migration deliberately builds only the SECOND one.
--     There is no table anywhere in this schema for an LLP agreement's
--     capital clause, so "total obligation of contribution" is not a fact
--     this app can compute — get_llp_contribution_summary's own comment,
--     the UI copy in app/(app)/[companyId]/directors, and this migration's
--     structured report all say so explicitly rather than quietly
--     returning the received figure under an "obligation" label.
--
-- VALUATION OF AN IN-KIND CONTRIBUTION — CORRECTING AN ASSUMPTION IN THIS
-- TASK'S OWN BRIEF. The task description named "a practising CA/CS/cost
-- accountant" as the valuer. A first WebSearch on Rule 23 of the LLP Rules
-- 2009 already looked settled, but per this codebase's own standing
-- practice (0090's cess lane, 0088's OPC-nominee point) an "obvious"
-- answer gets a second, skeptical search before it is trusted — and that
-- second search confirms Rule 23(2) names exactly THREE valuers: a
-- practising Chartered Accountant, a practising Cost Accountant, or an
-- approved valuer from the panel maintained by the Central Government.
-- A Company Secretary is NOT on that list. valuation_certificate_reference
-- below is a free-text reference (this schema does not model a valuer
-- register), and its label in the UI names the three Rule 23(2) categories
-- correctly rather than repeating the CS assumption.
--
-- contribution_type CHECK (cash / kind), not a free-text nature column —
-- Rule 23(1) requires the nature of each contribution to be disclosed
-- alongside its amount, and a fixed enum is what lets
-- get_llp_contribution_summary split the Form 11 total into the two
-- figures a preparer actually needs to sanity-check against Form 8.
--
-- valuation_certificate_reference IS NOT REQUIRED, EVEN FOR AN IN-KIND
-- ROW — the task is explicit that cash contributions must not be forced to
-- carry one, and this migration does not go further and force kind rows to
-- carry one either: a CHECK constraint below stops the reference being
-- entered on a CASH row (it would not describe anything), but does not
-- make it mandatory on a KIND row, because a partner's in-kind
-- contribution can be recorded here before the practising valuer's
-- certificate is in hand — the same "don't demand a fact before it
-- exists" reasoning 0085 used for the PF/ESI codes.
--
-- NO CAPITAL WITHDRAWAL / REDUCTION HERE. This is additive-only, a
-- register of what has been PUT IN — the same shape as
-- llp_partner_contributions' own name promises and nothing more. A
-- partner's capital being reduced or returned (Sec 24 cessation, or a
-- negotiated drawdown) is a different fact this migration does not model;
-- amount is CHECK'd strictly positive so a "withdrawal" cannot be faked as
-- a negative contribution row, which would silently corrupt the running
-- total instead of visibly failing.
--
-- TENANCY: director_id is a COMPOSITE FK — (director_id, company_id)
-- references company_directors(id, company_id), per this schema's standing
-- convention that a bare id-to-id FK across two tenant-scoped tables lets a
-- write attach itself to another tenant's parent row (RLS filters SELECT,
-- not INSERT/UPDATE). company_directors (0088) was only ever given a bare
-- PRIMARY KEY (id) — no prior feature needed a composite FK to point at
-- it — so this migration adds the UNIQUE (id, company_id) that a composite
-- FK requires as its target, exactly as branches already carries
-- (branches_id_company_id_key) for employees.branch_id (0085). Trivially
-- satisfiable since id alone is already unique; this does not change
-- company_directors' existing behaviour for anyone.
--
-- RLS mirrors company_directors (0088) exactly, per this task's own
-- instruction: read = is_company_member, write = can_write_company. This
-- is a capital-contribution record, not a salary or admin-sensitive one —
-- the same class of sensitivity as the directors themselves, not the
-- higher is_company_admin bar this schema reserves for payroll.
-- ============================================================================

alter table public.company_directors
  add constraint company_directors_id_company_id_key unique (id, company_id);

create table public.llp_partner_contributions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  director_id uuid not null,
  contribution_type text not null check (contribution_type in ('cash', 'kind')),
  amount numeric(14, 2) not null check (amount > 0),
  contribution_date date not null,
  -- Free-text reference to the practising CA / practising Cost Accountant /
  -- Central Government approved-valuer certificate (Rule 23(2), LLP Rules
  -- 2009). Relevant only to an in-kind row — see check below and the
  -- migration header for why a Company Secretary is deliberately not named
  -- as an eligible valuer here.
  valuation_certificate_reference text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- A valuation reference describes an in-kind contribution's valuer, not
  -- a cash one — cannot be entered on a cash row.
  check (contribution_type = 'kind' or valuation_certificate_reference is null),
  constraint llp_partner_contributions_director_company_fkey
    foreign key (director_id, company_id)
    references public.company_directors (id, company_id)
);

create index llp_partner_contributions_director_idx
  on public.llp_partner_contributions (director_id, company_id);
create index llp_partner_contributions_company_idx
  on public.llp_partner_contributions (company_id, contribution_date);

alter table public.llp_partner_contributions enable row level security;

create policy llp_partner_contributions_read on public.llp_partner_contributions
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy llp_partner_contributions_write on public.llp_partner_contributions
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.llp_partner_contributions is
  'LLP partner capital-contribution register (Sec 32/Rule 23, LLP Rules 2009) — what each partner/designated partner named in company_directors has actually put into the LLP, in cash or in kind. Additive only: no withdrawal/reduction is modelled. Feeds get_llp_contribution_summary, which is Form 11''s "total contribution received" figure, NOT its separate "total obligation of contribution" figure (that is fixed by the LLP agreement, which this schema does not hold). See 0097.';

comment on column public.llp_partner_contributions.contribution_type is
  'cash or kind (Sec 32 — a contribution may be tangible/intangible property, a services contract, or money). Drives whether valuation_certificate_reference is meaningful.';

comment on column public.llp_partner_contributions.valuation_certificate_reference is
  'Free-text reference to the Rule 23(2) valuer''s certificate for an in-kind contribution: a practising Chartered Accountant, a practising Cost Accountant, or a Central-Government-panel approved valuer — a Company Secretary is NOT one of the three (verified by WebSearch, Aug 2026, correcting an assumption in this feature''s own brief). Not required even on a kind row — the contribution can be recorded before the certificate is in hand. Cannot be set on a cash row (see the table check constraint).';

-- ----------------------------------------------------------------------------
-- public.get_llp_contribution_summary — Form 11's "total contribution
-- received" aggregate, one row per currently-serving director/partner.
-- ----------------------------------------------------------------------------
-- "Currently serving" = date_of_cessation is null on company_directors,
-- same definition 0088 already established. Deliberately NOT filtered to
-- designation = 'designated_partner' only: company_directors has no
-- separate enum value for an ordinary (non-designated) LLP partner — 0088's
-- 13-value list covers board/KMP roles plus 'designated_partner' and
-- nothing named just "partner" — so a non-designated partner recorded here
-- under whatever designation a preparer chose would otherwise be silently
-- dropped from the Form 11 aggregate. is_designated_partner is exposed as
-- its own column precisely so a caller CAN split "total number of
-- designated partners" from "total number of partners" the way the Form 11
-- e-form itself does, without this function guessing which rows to count.
create or replace function public.get_llp_contribution_summary(p_company_id uuid)
returns table (
  director_id uuid,
  name text,
  designation text,
  is_designated_partner boolean,
  is_current boolean,
  total_cash numeric,
  total_kind numeric,
  total_contribution numeric,
  contribution_count integer,
  last_contribution_date date
)
language sql
stable
set search_path to ''
as $fn$
  select
    d.id as director_id,
    d.name,
    d.designation,
    d.designation = 'designated_partner' as is_designated_partner,
    d.date_of_cessation is null as is_current,
    coalesce(sum(c.amount) filter (where c.contribution_type = 'cash'), 0) as total_cash,
    coalesce(sum(c.amount) filter (where c.contribution_type = 'kind'), 0) as total_kind,
    coalesce(sum(c.amount), 0) as total_contribution,
    count(c.id)::integer as contribution_count,
    max(c.contribution_date) as last_contribution_date
  from public.company_directors d
  left join public.llp_partner_contributions c
    on c.director_id = d.id and c.company_id = d.company_id
  where d.company_id = p_company_id
    and d.date_of_cessation is null
  group by d.id, d.name, d.designation, d.date_of_cessation
  order by is_designated_partner desc, d.name;
$fn$;

revoke all on function public.get_llp_contribution_summary(uuid) from public, anon;
grant execute on function public.get_llp_contribution_summary(uuid) to authenticated;

comment on function public.get_llp_contribution_summary(uuid) is
  'One row per currently-serving director/partner (company_directors, all designations — see function body comment), with their cumulative cash/kind/total contribution from llp_partner_contributions. This is Form 11''s "total contribution received" aggregate ONLY, not "total obligation of contribution" (LLP-agreement-fixed, not held by this schema — see 0097). Plain SQL, security invoker: relies on the caller''s own RLS the same as company_directors and llp_partner_contributions, no SECURITY DEFINER needed.';
