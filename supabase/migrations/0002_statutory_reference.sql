-- ============================================================================
-- 0002 — Statutory reference data
-- ============================================================================
-- Global, not tenant-scoped: every company reads the same state codes, entity
-- rules and rates. Readable by any authenticated user, writable by nobody
-- through the API — these change by amendment, which means a migration.
--
-- The organising principle for this whole file: statutory parameters are
-- DATA, never constants in code. Rates, thresholds and due dates change every
-- Budget. Holding them here with effective dates means an amendment is a data
-- migration and not a release, and — more importantly — that last year's
-- computation can still be reproduced next year after the rates have moved.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- GST state codes
-- ----------------------------------------------------------------------------
-- The tax determination engine reads this to decide CGST+SGST versus IGST,
-- and `intra_state_component` to decide whether the state half is SGST or
-- UTGST. That distinction is real and routinely got wrong: union territories
-- *without* a legislature levy UTGST, while Delhi, Puducherry and
-- Jammu & Kashmir have legislatures and levy SGST like any state.
create table public.ref_states (
  code char(2) primary key,
  name text not null,
  -- 'state'         → SGST
  -- 'ut_with_legis' → SGST (Delhi, Puducherry, J&K)
  -- 'ut'            → UTGST
  -- 'other'         → neither; used for exports and unmapped territory
  jurisdiction text not null check (jurisdiction in ('state','ut_with_legis','ut','other')),
  intra_state_component text not null check (intra_state_component in ('sgst','utgst','none')),
  -- Codes 25 and 28 still appear on historical documents but cannot be used on
  -- new registrations, so they are retained and flagged rather than deleted.
  is_active boolean not null default true,
  obsolete_note text
);

comment on table public.ref_states is
  'GST state/UT codes. intra_state_component drives SGST vs UTGST on an intra-state supply.';

insert into public.ref_states (code, name, jurisdiction, intra_state_component, is_active, obsolete_note) values
  ('01','Jammu and Kashmir','ut_with_legis','sgst',true,null),
  ('02','Himachal Pradesh','state','sgst',true,null),
  ('03','Punjab','state','sgst',true,null),
  ('04','Chandigarh','ut','utgst',true,null),
  ('05','Uttarakhand','state','sgst',true,null),
  ('06','Haryana','state','sgst',true,null),
  ('07','Delhi','ut_with_legis','sgst',true,null),
  ('08','Rajasthan','state','sgst',true,null),
  ('09','Uttar Pradesh','state','sgst',true,null),
  ('10','Bihar','state','sgst',true,null),
  ('11','Sikkim','state','sgst',true,null),
  ('12','Arunachal Pradesh','state','sgst',true,null),
  ('13','Nagaland','state','sgst',true,null),
  ('14','Manipur','state','sgst',true,null),
  ('15','Mizoram','state','sgst',true,null),
  ('16','Tripura','state','sgst',true,null),
  ('17','Meghalaya','state','sgst',true,null),
  ('18','Assam','state','sgst',true,null),
  ('19','West Bengal','state','sgst',true,null),
  ('20','Jharkhand','state','sgst',true,null),
  ('21','Odisha','state','sgst',true,null),
  ('22','Chhattisgarh','state','sgst',true,null),
  ('23','Madhya Pradesh','state','sgst',true,null),
  ('24','Gujarat','state','sgst',true,null),
  ('25','Daman and Diu','ut','utgst',false,'Merged into code 26 with effect from 26 Jan 2020'),
  ('26','Dadra and Nagar Haveli and Daman and Diu','ut','utgst',true,null),
  ('27','Maharashtra','state','sgst',true,null),
  ('28','Andhra Pradesh (before bifurcation)','state','sgst',false,'Obsolete after bifurcation; current Andhra Pradesh is code 37'),
  ('29','Karnataka','state','sgst',true,null),
  ('30','Goa','state','sgst',true,null),
  ('31','Lakshadweep','ut','utgst',true,null),
  ('32','Kerala','state','sgst',true,null),
  ('33','Tamil Nadu','state','sgst',true,null),
  ('34','Puducherry','ut_with_legis','sgst',true,null),
  ('35','Andaman and Nicobar Islands','ut','utgst',true,null),
  ('36','Telangana','state','sgst',true,null),
  ('37','Andhra Pradesh','state','sgst',true,null),
  ('38','Ladakh','ut','utgst',true,null),
  ('96','Other Country','other','none',true,'Used as place of supply for exports'),
  ('97','Other Territory','other','none',true,'Territorial waters and continental shelf');


-- ----------------------------------------------------------------------------
-- Entity types
-- ----------------------------------------------------------------------------
-- This table IS the entity rule engine. The company's entity_type selects a
-- row, and that row decides which statements, which audit forms, which ROC
-- obligations and which disallowance sections apply. Encoding it as data
-- rather than as branches across the codebase is what makes "all types of
-- companies, all government rules" tractable — and amendable.
create table public.ref_entity_types (
  code text primary key,
  name text not null,
  governing_act text,
  -- Presentation
  statement_format text not null check (statement_format in ('simple','schedule_iii')),
  -- Audit
  statutory_audit_rule text not null check (statutory_audit_rule in ('never','always','threshold')),
  statutory_audit_note text,
  tax_audit_report_form text not null check (tax_audit_report_form in ('3ca','3cb','3ca_or_3cb')),
  -- Income tax
  itr_form text not null,
  presumptive_allowed boolean not null default false,
  -- Remuneration to owners
  remuneration_section text,
  interest_on_capital_cap_percent numeric(5,2),
  -- Registrar
  roc_applicable boolean not null default false,
  roc_forms text[],
  -- Entity-specific traps worth surfacing in the UI
  special_provisions text[],
  sort_order smallint not null default 0
);

comment on table public.ref_entity_types is
  'Entity-type rule matrix. Selects statement format, audit forms, ITR form and applicable disallowance sections.';

insert into public.ref_entity_types (
  code, name, governing_act, statement_format,
  statutory_audit_rule, statutory_audit_note, tax_audit_report_form,
  itr_form, presumptive_allowed, remuneration_section, interest_on_capital_cap_percent,
  roc_applicable, roc_forms, special_provisions, sort_order
) values
  ('proprietorship','Proprietorship',null,'simple',
   'never',null,'3cb',
   'ITR-3',true,null,null,
   false,null,
   array['Drawings are not an expense'],1),

  ('partnership','Partnership Firm','Indian Partnership Act, 1932','simple',
   'never',null,'3cb',
   'ITR-5',true,'40(b)',12.00,
   false,null,
   array['Sec 40(b) remuneration cap requires book profit before remuneration','Interest on capital capped at 12% p.a.'],2),

  ('llp','Limited Liability Partnership','Limited Liability Partnership Act, 2008','simple',
   'threshold','Audit required if turnover exceeds the notified limit or partner contribution exceeds the notified limit','3ca_or_3cb',
   'ITR-5',false,'40(b)',12.00,
   true,array['Form 8','Form 11','DIR-3 KYC'],
   array['Sec 40(b) remuneration cap','Form 8 carries a solvency declaration'],3),

  ('opc','One Person Company','Companies Act, 2013','schedule_iii',
   'always',null,'3ca',
   'ITR-6',false,'197',null,
   true,array['AOC-4','MGT-7A','DIR-3 KYC'],
   array['Schedule III presentation','Nominee required'],4),

  ('pvt_ltd','Private Limited Company','Companies Act, 2013','schedule_iii',
   'always',null,'3ca',
   'ITR-6',false,'197',null,
   true,array['AOC-4','MGT-7','DIR-3 KYC','DPT-3'],
   array['Schedule III presentation','Sec 2(22)(e) deemed dividend on loans to substantial shareholders','CARO reporting unless a small company','Related party approval under Sec 188'],5),

  ('ltd','Public Limited Company','Companies Act, 2013','schedule_iii',
   'always',null,'3ca',
   'ITR-6',false,'197',null,
   true,array['AOC-4','MGT-7','DIR-3 KYC','DPT-3'],
   array['Schedule III presentation','CARO reporting','Related party approval under Sec 188','Additional obligations if listed'],6),

  ('huf','Hindu Undivided Family',null,'simple',
   'never',null,'3cb',
   'ITR-3',true,null,null,
   false,null,
   array['Karta signs on behalf of the family'],7),

  ('aop_boi','Association of Persons / Body of Individuals',null,'simple',
   'never',null,'3cb',
   'ITR-5',false,null,null,
   false,null,null,8),

  ('trust','Trust',null,'simple',
   'threshold','Audit required where receipts exceed the notified limit','3cb',
   'ITR-7',false,null,null,
   false,null,
   array['Registration under Sec 12A/12AB affects exemption','Form 10B/10BB audit report'],9),

  ('society','Co-operative Society / Society',null,'simple',
   'threshold','Audit required under the governing state Act','3cb',
   'ITR-5',false,null,null,
   false,null,
   array['Deduction under Sec 80P may apply'],10);


-- ----------------------------------------------------------------------------
-- Effective-dated statutory rules
-- ----------------------------------------------------------------------------
-- One table for every rate, threshold and limit that a Finance Act can move.
-- Deliberately generic: a typed column per tax would mean a schema migration
-- every Budget, which is exactly the coupling this design exists to avoid.
--
-- `scope` narrows a rule that varies by entity type, state or turnover band —
-- for example the company income-tax rate under 115BAA versus the ordinary
-- rate. `value` is numeric because almost every rule is a rate or an amount;
-- anything structural goes in `attrs`.
create table public.statutory_rules (
  id uuid primary key default gen_random_uuid(),
  -- Grouping, e.g. 'income_tax.rate', 'gst.registration_threshold',
  -- 'tds.section', 'tax_audit.44ab_limit', 'forex.as11'
  domain text not null,
  rule_key text not null,
  scope jsonb not null default '{}'::jsonb,
  value numeric(18,4),
  attrs jsonb not null default '{}'::jsonb,
  effective_from date not null,
  effective_to date,
  -- Where this came from, so a reviewer can check it without guessing.
  authority text,
  notes text,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create index statutory_rules_lookup_idx
  on public.statutory_rules (domain, rule_key, effective_from desc);

comment on table public.statutory_rules is
  'Effective-dated statutory parameters. Every computation resolves rules as at a date so historical results stay reproducible after an amendment.';

-- Resolver. Every computation in the system asks for rules AS AT a date —
-- never "the current rate" — so that re-running last year''s return after this
-- year''s Budget produces last year''s answer.
create or replace function public.resolve_statutory_rule(
  p_domain text,
  p_rule_key text,
  p_as_at date,
  p_scope jsonb default '{}'::jsonb
) returns table (value numeric, attrs jsonb, authority text)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.value, r.attrs, r.authority
    from public.statutory_rules r
   where r.domain = p_domain
     and r.rule_key = p_rule_key
     and r.effective_from <= p_as_at
     and (r.effective_to is null or r.effective_to >= p_as_at)
     -- Every key/value in the rule's scope must be present in the query scope.
     -- A rule with an empty scope therefore matches any query, which is what
     -- makes the general case the fallback rather than a special case.
     and r.scope <@ p_scope
   order by (select count(*) from jsonb_object_keys(r.scope)) desc,  -- most specific rule wins
            r.effective_from desc                                    -- then the latest in force
   limit 1;
$$;

comment on function public.resolve_statutory_rule is
  'Resolves the most specific rule in force on a date. Narrower scope wins over broader; later effective_from breaks ties.';


-- ----------------------------------------------------------------------------
-- Row level security
-- ----------------------------------------------------------------------------
-- Reference data is world-readable to signed-in users and writable only by a
-- migration. There is no tenant dimension here, so there is nothing to leak
-- between companies — but leaving it unlocked would let any client rewrite
-- the tax rates the whole application computes from.
alter table public.ref_states enable row level security;
alter table public.ref_entity_types enable row level security;
alter table public.statutory_rules enable row level security;

create policy ref_states_read on public.ref_states
  for select to authenticated using (true);

create policy ref_entity_types_read on public.ref_entity_types
  for select to authenticated using (true);

create policy statutory_rules_read on public.statutory_rules
  for select to authenticated using (true);

-- No insert/update/delete policies are defined, so with RLS enabled these are
-- denied to every non-superuser role. That is intentional and not an omission.
