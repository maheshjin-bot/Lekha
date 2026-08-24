-- ============================================================================
-- 0115 — Register of Charges, Sec 77-87 Companies Act 2013 (Forms CHG-1/CHG-4)
-- ============================================================================
-- Nothing in this schema previously represented a charge (mortgage/pledge/
-- hypothecation etc. securing a loan) at all — a repo-wide search for "chg-1"
-- / "chg-4" / "charge_holder" against migrations 0001-0114 returns nothing.
-- Sec 85(1) requires every company to keep a Register of Charges (Form
-- CHG-7) at its registered office; this migration is that register.
--
-- LEGAL BASIS (WebSearch, Aug 2026, two passes).
--
-- CHG-1 TIMELINE — Sec 77(1) proviso, as amended by the Companies
-- (Amendment) Ordinance/Act 2019 (in force for charges created on/after
-- 2 Nov 2019, and this is now the only live regime six years on): a charge
-- must be registered within 30 days of creation. Missing that, the Registrar
-- may allow filing within a FURTHER 30 days (30+30 = 60 days total) on
-- payment of additional fee. Missing THAT, the Registrar may allow a further
-- 60 days (60+60 = 120 days total) on payment of ad valorem fee. Beyond 120
-- days there is no more administrative extension — only condonation of delay
-- by the Central Government under Sec 87 (Form CHG-8). Confirmed by a second,
-- skeptical pass specifically checking this wasn't the pre-2019 "up to 300
-- days" regime some older articles still describe — that older regime is
-- dead law for any charge created after 2 Nov 2019, which every charge a real
-- user records here necessarily is.
--
-- CHG-4 TIMELINE — Sec 82(1)/Rule 8(1) Companies (Registration of Charges)
-- Rules 2014: satisfaction must be intimated within 30 days of the payment
-- or satisfaction in full, with the SAME 30+30+60 extension structure as
-- Sec 77 (Sec 82(2), added by the same 2019 amendment).
--
-- CHARGE_TYPE VALUES — confirmed against what CHG-1 itself actually asks a
-- filer to categorise a charge as: mortgage (registered or equitable, over
-- immovable property, Transfer of Property Act 1882), hypothecation (movable
-- assets, possession stays with the borrower — the common case for
-- inventory/receivables/vehicle financing), pledge (movable goods, possession
-- transfers to the lender — one source notes a pledge is arguably not a
-- "charge" under the Sec 2(16) definition at all, but CHG-1 files it as one
-- in practice and this app follows that practice, not the definitional
-- nicety), assignment (rights in a specific asset, e.g. an insurance policy
-- or receivables, assigned as security), floating_charge (over a class of
-- assets that changes in the ordinary course of business, e.g. all present
-- and future stock), lien (arising by operation of law, e.g. an unpaid
-- seller's lien) — plus 'other' as an honest escape hatch, the same pattern
-- share_holdings.consideration (0101) and company_directors.designation
-- (0088) both already use for a checked-but-not-exhaustive list.
--
-- APPLIES TO WHICH ENTITY TYPES — gated to pvt_ltd/ltd/opc, NOT llp, and this
-- was the specific question the skeptical second search pass was aimed at.
-- An LLP does have a parallel charge-registration duty — Sec 34(2)/(3) LLP
-- Act 2008 read with Rule 24 LLP Rules 2009 — but it is filed on LLP Form 8
-- (the same form used for its Statement of Account & Solvency, with "Charge"
-- selectable as a standalone purpose needing no delay fee), a wholly
-- different form under a wholly different Act with its own timeline, not
-- CHG-1/CHG-4 under the Companies Act. This migration's scope, as named in
-- its own task, is specifically the CHG-1/CHG-4 register — building it for
-- llp would mean silently inventing a Form-8 charge tracker with none of
-- this table's CHG-specific columns (chg1_srn, chg4_srn) actually meaning
-- anything, which is worse than leaving it out and saying so. An LLP's Form
-- 8 charge obligation is therefore explicitly OUT OF SCOPE here, not
-- overlooked — see scope_deferred. Within the Companies Act, this app's own
-- ref_entity_types.roc_forms — already the precedent 0101 established for
-- "which entity types are actually a company here" — lists pvt_ltd/ltd/opc
-- as the three with an MGT-7/MGT-7A filing obligation; there is no separate
-- "company limited by guarantee" value in this app's entity_type enum
-- (re-confirmed live: same ten values 0101 found), so that Sec 77-applicable
-- but share-capital-inapplicable case has nothing to attach to here either,
-- exactly the gap 0101 already documented and left alone.
--
-- WHY chg1_filing_date/chg1_srn/date_of_satisfaction/chg4_filing_date/
-- chg4_srn ARE ALL NULLABLE. A charge is created, and belongs in this
-- register, the moment it exists — Sec 77 gives 30 (or up to 120) days to
-- FILE, it does not say the charge doesn't exist until filed. So a user
-- must be able to record a charge the same day it's created, before CHG-1
-- has actually been filed, which means chg1_filing_date/chg1_srn cannot be
-- required at insert time. Symmetrically, date_of_satisfaction is null for
-- the ordinary case of a live, unsatisfied charge (a loan mid-tenure), and
-- chg4_filing_date/chg4_srn only start to make sense once a satisfaction
-- date exists at all. The CHECK constraints below encode that dependency
-- ordering as a real invariant (an SRN cannot exist without its filing date,
-- a filing date cannot precede the event it reports), not just a UI
-- suggestion — same discipline 0088 used for din/din_allotment_date.
--
-- NO HARD 30/60/120-DAY ENFORCEMENT AS A CONSTRAINT. Unlike 0101's
-- authorized-share-capital ceiling (a real legal impossibility, correctly
-- enforced by a trigger), a company that has gone past 120 days without
-- filing CHG-1 has not done anything that makes the ROW impossible — it has
-- simply broken a filing deadline, which is exactly the kind of past fact
-- (a notice already overdue, a return already late) this app records rather
-- than refuses to store. get_charges_summary below surfaces overdue counts
-- as information, not as a write-blocking rule — the same choice notices
-- (0059) and job work challans (0069) both already made for their own due
-- dates.
--
-- RLS MIRRORS company_directors (0088) EXACTLY — member read via
-- is_company_member, member-with-write-role write via can_write_company.
-- Charge/lender information is, once filed, public MCA record (anyone can
-- pull a company's charge index from the MCA portal) — same reasoning 0101
-- gave for putting ownership data at the can_write_company tier rather than
-- the stricter is_company_admin tier reserved for salary data.
--
-- WHAT THIS DOES NOT DO: generate Form CHG-1/CHG-4/CHG-7/CHG-8 itself,
-- compute or enforce the 30/60/120-day filing windows as anything more than
-- an informational overdue flag, verify an SRN against the MCA portal, or
-- track an LLP's Form 8 charge obligation (a different form under a
-- different Act — see above). All said here and repeated in scope_deferred.
-- ============================================================================

create table public.charges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  charge_holder_name text not null check (length(trim(charge_holder_name)) > 0),
  charge_type text not null check (charge_type = any (array[
    'mortgage', 'hypothecation', 'pledge', 'assignment', 'floating_charge', 'lien', 'other'
  ])),
  amount_secured numeric(18,2) not null check (amount_secured > 0),
  assets_charged text not null check (length(trim(assets_charged)) > 0),

  date_of_creation date not null,

  -- CHG-1 side — see migration header for why every one of these is nullable.
  chg1_filing_date date,
  chg1_srn text,

  -- Satisfaction / CHG-4 side.
  date_of_satisfaction date,
  chg4_filing_date date,
  chg4_srn text,

  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (chg1_filing_date is null or chg1_filing_date >= date_of_creation),
  check (chg1_srn is null or chg1_filing_date is not null),
  check (date_of_satisfaction is null or date_of_satisfaction >= date_of_creation),
  check (chg4_filing_date is null or date_of_satisfaction is not null),
  check (chg4_filing_date is null or chg4_filing_date >= date_of_satisfaction),
  check (chg4_srn is null or chg4_filing_date is not null)
);

-- "live" (unsatisfied) charges are the ones a lender search or a due-diligence
-- check actually cares about day to day — index the filter get_charges_summary
-- and the list screen both use.
create index charges_company_status_idx on public.charges (company_id, date_of_satisfaction);

create trigger set_updated_at before update on public.charges
  for each row execute function app_private.set_updated_at();

-- ----------------------------------------------------------------------------
-- app_private.check_company_can_register_charges — the pvt_ltd/ltd/opc gate,
-- a real invariant not a UI suggestion. See migration header.
-- ----------------------------------------------------------------------------
create or replace function app_private.check_company_can_register_charges()
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
      'Sec 77-87 charge registration (CHG-1/CHG-4) does not apply to this company''s entity type (%). Only a company limited by shares — pvt_ltd, ltd or opc in this app''s own entity types — files on this form; an LLP has a parallel but separate charge-filing duty on Form 8 under the LLP Act (not built here — see 0115''s scope note), and a proprietorship/partnership/HUF/AOP/trust/society has no Companies Act charge obligation at all.',
      coalesce(v_entity_type, 'unknown');
  end if;
  return new;
end;
$fn$;

create trigger charges_entity_type_check
  before insert on public.charges
  for each row execute function app_private.check_company_can_register_charges();

-- ----------------------------------------------------------------------------
-- RLS — mirrors company_directors (0088) exactly.
-- ----------------------------------------------------------------------------
alter table public.charges enable row level security;

create policy charges_read on public.charges
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy charges_write on public.charges
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.charges is
  'Register of Charges, Sec 85 Companies Act 2013 (Form CHG-7) — one row per charge created over the company''s property (Sec 77, Form CHG-1) with its eventual satisfaction (Sec 82, Form CHG-4) recorded on the same row when it happens. Only insertable for pvt_ltd/ltd/opc (enforced by check_company_can_register_charges) — an LLP''s parallel Form-8 charge duty under the LLP Act is a different form under a different Act, deliberately not represented by this table. "Live" = date_of_satisfaction is null. See 0115.';

comment on column public.charges.charge_type is
  'CHG-1''s own categories: mortgage, hypothecation, pledge, assignment, floating_charge, lien, or other. See 0115 header for the source of this list — pledge is filed on CHG-1 in practice even though one reading of Sec 2(16) argues it is not technically a "charge".';

comment on column public.charges.chg1_filing_date is
  'Nullable — a charge belongs in this register the moment it is created (Sec 77 gives 30, extendable to 120, days to FILE; the charge exists before that). Left null, this charge is on record here but not yet filed with the ROC.';

comment on column public.charges.date_of_satisfaction is
  'Nullable — null means this charge is still live/unsatisfied. Set this, then optionally chg4_filing_date/chg4_srn once CHG-4 is actually filed (Sec 82, within 30/60/120 days of THIS date, not date_of_creation).';

-- ----------------------------------------------------------------------------
-- public.get_charges_summary — live vs satisfied, outstanding amount secured,
-- and the same informational overdue flag notices/job-work challans already
-- use for their own statutory clocks. Not a write-blocking rule — see header.
-- ----------------------------------------------------------------------------
create or replace function public.get_charges_summary(p_company_id uuid)
returns table (
  live_charge_count bigint,
  satisfied_charge_count bigint,
  total_amount_secured_live numeric,
  total_amount_secured_satisfied numeric,
  chg1_not_yet_filed_count bigint,
  chg1_overdue_count bigint,
  chg4_not_yet_filed_count bigint,
  chg4_overdue_count bigint
)
language plpgsql
stable
set search_path to ''
as $fn$
begin
  if not app_private.is_company_member(p_company_id) then
    raise exception 'Not permitted to view this company''s register of charges.';
  end if;

  return query
    select
      count(*) filter (where date_of_satisfaction is null),
      count(*) filter (where date_of_satisfaction is not null),
      coalesce(sum(amount_secured) filter (where date_of_satisfaction is null), 0),
      coalesce(sum(amount_secured) filter (where date_of_satisfaction is not null), 0),
      count(*) filter (where chg1_filing_date is null),
      -- Past the outer 120-day extension window (30+30+60) from creation,
      -- with no filing date on record at all. See header — this is a real
      -- statutory deadline, but the flag is informational, not a block.
      count(*) filter (where chg1_filing_date is null and date_of_creation < current_date - 120),
      count(*) filter (where date_of_satisfaction is not null and chg4_filing_date is null),
      count(*) filter (where date_of_satisfaction is not null and chg4_filing_date is null
                          and date_of_satisfaction < current_date - 120)
    from public.charges
    where company_id = p_company_id;
end;
$fn$;

revoke all on function public.get_charges_summary(uuid) from public, anon;
grant execute on function public.get_charges_summary(uuid) to authenticated;

comment on function public.get_charges_summary(uuid) is
  'Live vs satisfied charge counts and amount secured, plus CHG-1/CHG-4 filing-pending and overdue (past the 30+30+60 = 120-day outer extension window, Sec 77/82) counts. Informational only — see 0115 header for why this app does not hard-block a write past the deadline.';
