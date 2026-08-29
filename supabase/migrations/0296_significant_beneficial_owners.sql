-- ============================================================================
-- 0296 — Significant Beneficial Owners: Sec 90 Companies Act 2013 (Tier 4)
-- ============================================================================
-- A repo-wide search for beneficial, sbo, ben1 and significant returned
-- nothing — no table, column, RPC or screen anywhere in this schema knew
-- that a company can be required to look BEHIND its own Register of Members
-- and identify the real individual who ultimately controls a shareholding
-- held through another entity. company_directors (0088) records who runs
-- the company; share_holdings (0101) records who is registered as a member.
-- Neither can represent an individual who is neither of those things — the
-- exact person Sec 90 exists to surface.
--
-- LEGAL BASIS (WebSearch, Aug 2026, two passes — the second specifically
-- skeptical about the "not a registered member" condition and the LLP
-- question below, both flagged as needing primary-source confirmation
-- rather than a summary blog).
--
-- Sec 90 Companies Act 2013, read with the Companies (Significant
-- Beneficial Owners) Rules, 2018 (as substituted by the 2019 amendment
-- rules, which rewrote Rule 2(1)(h) and added Explanations I-VI — every
-- figure below is taken from the rule as it stands after that amendment,
-- not the original 2018 text). Rule 2(1)(h): a "significant beneficial
-- owner" is an individual referred to in Sec 90(1) — see the four limbs
-- below — "whose name is not entered in the register of members of a
-- company as the holder of such shares". That is the "not a registered
-- member themselves" condition this task asked to have confirmed, not
-- assumed: it is the operative words of the definition, not a paraphrase.
-- An individual whose own name IS on the register is just a member —
-- already representable via share_holdings (0101) — not an SBO.
--
-- THE FOUR QUALIFYING LIMBS, Sec 90(1) / Rule 2(1)(h), each independently
-- sufficient: an individual, acting alone or together with others or
-- through one or more persons/trusts, who (i) holds indirectly, or
-- together with any direct holding, not less than 10% of the shares;
-- (ii) holds indirectly, or together with any direct holding, not less
-- than 10% of the voting rights; (iii) has the right to receive or
-- participate in not less than 10% of total distributable dividend or
-- any other distribution in a financial year, indirectly or together with
-- any direct right; or (iv) exercises significant influence or control
-- (Sec 2(27) — participation in business decisions, or the power to
-- appoint a majority of directors, or to control management/policy
-- decisions) through means OTHER than a direct holding. Limb (iv) is a
-- real case with no clean percentage attached (control by agreement, or
-- by the power to appoint directors, need not track an ownership
-- fraction) — see percentage_held below for how that shaped the column.
--
-- DIRECT vs INDIRECT, Explanation I-II to Rule 2(1)(h). "Direct" holding
-- for SBO purposes is narrower than it sounds: shares registered in the
-- individual's own name (in which case they are simply a member, not an
-- SBO — this table would never hold that row), OR a beneficial interest
-- the individual has DECLARED to the company under Sec 89(2) while a
-- different name sits in the register (a nominee/benami arrangement) —
-- this second case is the one genuine "direct" SBO row this table can
-- hold. "Indirect" holding is through another body corporate (majority
-- stake in the member or its ultimate holding company), an HUF (the
-- individual is karta), a partnership entity (the individual is a partner
-- or holds majority stake in a corporate partner), a trust (trustee,
-- beneficiary with >=10% interest, or author/settlor with control), or a
-- pooled investment vehicle. held_through_entity_name/type below exist for
-- exactly this indirect case, per the task's own column list.
--
-- FORMS — BEN-1 (declaration BY the SBO TO the company, Rule 3, within 90
-- days of the rules' 2019 commencement for an existing SBO and within 30
-- days of becoming one thereafter), BEN-2 (e-form filed BY the company
-- WITH the Registrar, Rule 4/Sec 90(4), within 30 days of receiving BEN-1),
-- BEN-3 (the register the company itself maintains, Rule 5/Sec 90(2) —
-- this table plus its screen IS that register, not a fourth thing bolted
-- on beside it). BEN-4 (a notice the company issues under Sec 90(5) to
-- someone it merely SUSPECTS is an undeclared SBO) is a different act —
-- probing for a declaration that has not arrived — not a record of one
-- that has, and is out of scope here: see scope_deferred.
--
-- WHY pvt_ltd/ltd/opc, MIRRORING share_classes (0101) EXACTLY — not
-- reinvented. ref_entity_types.roc_forms (checked live) lists MGT-7 for
-- pvt_ltd/ltd and MGT-7A for opc and neither for any other entity type;
-- these are the three entity types this app's own reference data already
-- treats as "company limited by shares". Enforced below by a real trigger,
-- not a UI-only suggestion, the same shape as 0101's
-- check_company_has_share_capital.
--
-- LLP IS DELIBERATELY EXCLUDED HERE, AND THAT IS NOT THE SAME AS "SBO
-- DOESN'T APPLY TO AN LLP" — the skeptical second search caught this
-- distinction and it would have been a real factual error to gloss over.
-- An MCA notification dated 11 Feb 2022 extended Sec 90 to LLPs, and the
-- Limited Liability Partnership (Significant Beneficial Owners) Rules,
-- 2023 (effective 9 Nov 2023) implement it with their OWN, differently-
-- numbered form set (LLP BEN-1 through LLP BEN-4) and their own
-- thresholds phrased against contribution/voting rights in an LLP
-- agreement rather than shares. That is a distinct regime this table does
-- not represent, not an oversight — this task scoped the table to
-- pvt_ltd/ltd/opc, matching share_classes' own gate and company_directors'
-- structural precedent, and an LLP declaration would need its own
-- LLP-shaped table (different form numbers, different threshold wording)
-- rather than a row jammed into this one. Recorded here so a future
-- migration doesn't have to re-discover it.
--
-- WHY percentage_held IS NULLABLE. Three of the four qualifying limbs
-- (shares, voting rights, dividend/distribution right) are percentage
-- facts and belong here. The fourth — significant influence or control —
-- genuinely may not be: control by the power to appoint a majority of
-- directors, or by a contractual right over management decisions, does
-- not always reduce to a single ownership fraction. Forcing a NOT NULL
-- percentage would make a real control-only SBO row either unrepresentable
-- or represented with a fabricated number, and this app's own house rule
-- is against manufacturing false precision. When present, the value is
-- still bounded (0, 100].
--
-- WHY qualifying_basis IS AN ARRAY, NOT A SINGLE VALUE. The four limbs are
-- independently sufficient but routinely co-occur (an indirect 15% share
-- stake ordinarily carries the matching 15% voting right too) and Form
-- BEN-1 itself asks the declarant to tick every limb that applies, not
-- pick one. A single-value column would force an arbitrary choice between
-- two simultaneously-true facts; the array records what was actually
-- declared.
--
-- WHY NO RPC — same reasoning as company_directors (0088): "currently an
-- SBO" is nothing more than date_ceased_sbo is null, no date arithmetic,
-- no "as of today" logic that could drift between two callers. A plain
-- RLS-gated table is the honest amount of machinery, and since there is no
-- SECURITY DEFINER function here, there is nothing to revoke from
-- public/anon — the standing revoke/grant rule in this project has nothing
-- to attach to in this migration (verified live below anyway, for the one
-- trigger function this migration does add, in app_private, unreachable by
-- anon regardless because anon has no USAGE on the app_private schema —
-- confirmed live before relying on that: has_schema_privilege('anon',
-- 'app_private', 'USAGE') = false, and 0101's own check_company_has_
-- share_capital was left ungranted-from on that same basis, not an
-- oversight in that migration either).
--
-- RLS MIRRORS company_directors (0088) EXACTLY — member read via
-- is_company_member, member-with-write-role write via can_write_company —
-- verified live at `select policyname, cmd, qual, with_check from
-- pg_policies where tablename = 'company_directors'` before writing the
-- policies below. Beneficial-ownership data is sensitive but this app's
-- own precedent (company_directors, itself information a filed BEN-2
-- makes visible to the Registrar) puts it at the can_write_company tier,
-- not the stricter is_company_admin tier reserved for salary data.
--
-- WHAT THIS DOES NOT DO: generate Form BEN-1/BEN-2/BEN-3/BEN-4 itself,
-- e-file BEN-2 with the Registrar (no MCA API access, same limitation
-- every other MCA-form-adjacent feature in this app already states),
-- determine automatically whether a given shareholding crosses the 10%
-- threshold (that arithmetic depends on facts — indirect chains through
-- other bodies corporate, HUFs, trusts — this schema does not model at
-- all, since doing so would mean modelling the cap tables of entities
-- this app never onboards), or send a BEN-4 notice. See scope_deferred in
-- the structured report for the full list.
-- ============================================================================

create table public.significant_beneficial_owners (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  individual_name text not null check (length(trim(individual_name)) > 0),
  pan text check (app_private.is_valid_pan(pan)),

  -- Rule 2(1)(h) Explanation I-II — see migration header. 'direct' is the
  -- narrow Sec 89(2)-declared-beneficial-interest case; a plain registered
  -- member never gets a row here at all.
  interest_nature text not null check (interest_nature in ('direct', 'indirect')),

  -- Populated only when interest_nature = 'indirect' — "through which
  -- entity", per the task's own column description.
  held_through_entity_name text,
  held_through_entity_type text check (held_through_entity_type is null or held_through_entity_type in (
    'body_corporate', 'huf', 'partnership_entity', 'trust', 'pooled_investment_vehicle', 'other'
  )),

  -- The Sec 90(1) limb(s) actually declared — see migration header for why
  -- this is an array, not a single value.
  qualifying_basis text[] not null default '{}',

  -- Nullable — see migration header (the significant-influence/control
  -- limb need not carry a clean percentage). Bounded when present.
  percentage_held numeric(5,2) check (percentage_held is null or (percentage_held > 0 and percentage_held <= 100)),

  date_became_sbo date not null,
  -- Nullable — still an SBO as of today. Mirrors company_directors.date_of_cessation (0088).
  date_ceased_sbo date,

  -- Tracked, never auto-filed — see migration header and 0088's own
  -- precedent for the same non-automation stance on MCA forms.
  ben1_received_date date,
  ben2_filed_date date,

  notes text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (date_ceased_sbo is null or date_ceased_sbo >= date_became_sbo),
  -- Can't have filed BEN-2 (the company's return to the Registrar) about a
  -- BEN-1 declaration the company never records as received.
  check (ben2_filed_date is null or ben1_received_date is not null),
  -- Indirect holding needs to say through which entity; direct doesn't.
  check (interest_nature = 'direct' or held_through_entity_name is not null),
  check (interest_nature = 'indirect' or held_through_entity_type is null),
  check (qualifying_basis <@ array['shares', 'voting_rights', 'dividend_right', 'significant_influence', 'control']::text[])
);

create index significant_beneficial_owners_company_idx
  on public.significant_beneficial_owners (company_id, date_ceased_sbo);

create trigger set_updated_at before update on public.significant_beneficial_owners
  for each row execute function app_private.set_updated_at();

-- ----------------------------------------------------------------------------
-- app_private.check_company_can_have_sbo — enforces the pvt_ltd/ltd/opc
-- gate as a real invariant, mirroring 0101's check_company_has_share_capital
-- in shape and message style. See migration header.
-- ----------------------------------------------------------------------------
create or replace function app_private.check_company_can_have_sbo()
returns trigger
language plpgsql
set search_path to ''
as $fn$
declare
  v_entity_type text;
begin
  select entity_type into v_entity_type from public.companies where id = new.company_id;
  if v_entity_type is null or v_entity_type not in ('pvt_ltd', 'ltd', 'opc') then
    raise exception
      'Significant beneficial ownership declarations do not apply to this company''s entity type (%). Sec 90 Companies Act 2013 and the SBO Rules, 2018 reach a company limited by shares — pvt_ltd, ltd or opc in this app''s own entity types, the same MGT-7/MGT-7A-filing set share capital (0101) uses. An LLP has its own separate Limited Liability Partnership (Significant Beneficial Owners) Rules, 2023 with its own LLP BEN-1 to BEN-4 forms, not represented by this table; a proprietorship/partnership/HUF/AOP/trust/society has no share capital and no SBO regime at all.',
      coalesce(v_entity_type, 'unknown');
  end if;
  return new;
end;
$fn$;

create trigger significant_beneficial_owners_entity_type_check
  before insert on public.significant_beneficial_owners
  for each row execute function app_private.check_company_can_have_sbo();

-- ----------------------------------------------------------------------------
-- RLS — mirrors company_directors (0088) exactly. See migration header.
-- ----------------------------------------------------------------------------
alter table public.significant_beneficial_owners enable row level security;

create policy significant_beneficial_owners_read on public.significant_beneficial_owners
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy significant_beneficial_owners_write on public.significant_beneficial_owners
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.significant_beneficial_owners is
  'Sec 90 Companies Act 2013 / Companies (Significant Beneficial Owners) Rules, 2018 (as amended 2019) — the Form BEN-3 register a company limited by shares must keep of individuals who cross a 10% shares/voting-rights/dividend-right threshold, or exercise significant influence/control, WITHOUT their own name being on the Register of Members (share_holdings, 0101) — i.e. holding indirectly, through another body corporate/HUF/partnership/trust, or under an undisclosed Sec 89(2) nominee arrangement. Only insertable for a company whose entity_type is pvt_ltd/ltd/opc (enforced by check_company_can_have_sbo) — mirrors share_classes (0101) exactly; an LLP has its own separate LLP SBO Rules, 2023 regime, not this table. Tracks BEN-1 receipt and BEN-2 filing dates; does not e-file either — no MCA API access. See 0296.';

comment on column public.significant_beneficial_owners.interest_nature is
  'Rule 2(1)(h) Explanation I: ''direct'' is the narrow case of an undisclosed Sec 89(2) beneficial interest (a different name sits in the Register of Members); ''indirect'' is a holding routed through another body corporate/HUF/partnership/trust — see held_through_entity_name/type. A person whose own name IS on the register is simply a member (share_holdings, 0101), never a row here.';

comment on column public.significant_beneficial_owners.qualifying_basis is
  'Which Sec 90(1) limb(s) were actually declared: shares, voting_rights, dividend_right (each a >=10% threshold), significant_influence or control (Sec 2(27), no fixed percentage). An array because Form BEN-1 lets more than one apply at once — see 0296 header.';

comment on column public.significant_beneficial_owners.percentage_held is
  'Nullable: the significant_influence/control limb need not carry a clean ownership percentage (e.g. control via the power to appoint a majority of directors). Bounded (0, 100] when present. See 0296 header.';

comment on column public.significant_beneficial_owners.ben1_received_date is
  'Date the company received Form BEN-1 from this individual (Rule 3). Tracked, not auto-generated — this app does not send or receive statutory forms.';

comment on column public.significant_beneficial_owners.ben2_filed_date is
  'Date the company filed Form BEN-2 with the Registrar about this declaration (Rule 4 / Sec 90(4), due within 30 days of BEN-1 receipt — this app does not compute or enforce that deadline, only records the fact once filed). Nullable, and cannot be set without ben1_received_date first (see CHECK constraint) — a company cannot file a return about a declaration it has not recorded receiving.';
