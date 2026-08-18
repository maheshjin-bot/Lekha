-- ============================================================================
-- 0022 — TDS: section rates, and closing the write-only-via-SQL gap
-- ============================================================================
-- TDS is a CONDITIONAL module (0004: activates on companies.tan is not
-- null) with more schema groundwork already in place than most unbuilt
-- modules get: ledgers.is_tds_deductee, default_tds_section, and a full
-- Sec 197 lower/nil-deduction-certificate sub-schema (0006). None of it was
-- reachable from the app — default_tds_section was unconstrained free text
-- with no list of valid sections to check against, and there was no UI path
-- to set a company's TAN at all, so the module could never even self-activate
-- through normal use.
--
-- This migration adds the missing reference data. The rate/threshold figures
-- were independently researched via two parallel passes cross-checked
-- against incometaxindia.gov.in and reconciled with a third pass before
-- being written here — not pulled from memory, since these are real
-- compliance figures.
--
-- A significant fact surfaced by that research: effective 1 April 2026 the
-- Income-tax Act, 2025 replaced the 1961 Act, and TDS provisions were
-- recodified under Section 393 of the new Act. Every source checked agrees
-- this is a renumbering/consolidation, not a rate change — the figures below
-- are unchanged in substance. section_code below deliberately keeps the
-- familiar 1961-Act labels ("194C", "194J", …) rather than the new Section
-- 393 table references, because that is still how practitioners, deductee
-- correspondence, and every third-party source refer to them during this
-- transition, and even the sources themselves disagree on the exact new
-- sub-item numbering. The recodification is recorded in each row's
-- description instead, so the fact is not lost, without breaking the label
-- everyone actually uses.
--
-- Deliberately excluded from this seed (see confidence notes in the research
-- above and the description column below where relevant):
--   * Section 192 (salary) — slab-based on the employee's total income, not
--     a flat rate; a different computation shape entirely.
--   * The lower 1% individual/HUF payee rate under 194C, and the lower
--     individual/HUF-payer condition under 194IB — 194IB is modelled as its
--     rate outright since individual/HUF-payer status is what makes the
--     section apply at all, not a rate variable within it; 194C's
--     individual/HUF-payee rate is a genuine second rate this seed omits,
--     noted in its description.
--   * 194H's threshold and rate here are already the post-1-Oct-2024 figures
--     (cut from 5% to 2%) and post-1-Apr-2025 threshold (₹15,000 → ₹20,000)
--     — both already reflected below, not separately called out per row.
-- ============================================================================

create table public.ref_tds_sections (
  section_code text primary key,
  description text not null,
  rate_percent numeric(5,2) not null check (rate_percent >= 0 and rate_percent <= 100),
  -- Section 206AA's default no-PAN rate is 20%; a few sections (194Q here)
  -- carry a specific lower statutory cap instead — stored per-row rather
  -- than assumed, since guessing 20% everywhere would be wrong for those.
  no_pan_rate_percent numeric(5,2) not null check (no_pan_rate_percent >= 0 and no_pan_rate_percent <= 100),
  -- Both nullable and independent: some sections test a single payment, some
  -- an annual aggregate, some (194IB) a monthly figure stored here as the
  -- "single" threshold, and 194Q's is an excess-over-threshold mechanic that
  -- neither field alone captures — threshold_note carries what the two
  -- numbers can't.
  threshold_single_rupees numeric(18,2),
  threshold_aggregate_rupees numeric(18,2),
  threshold_note text,
  sort_order smallint not null,
  is_active boolean not null default true
);

comment on table public.ref_tds_sections is
  'Reference data, not tenant data — world-readable to signed-in users, writable only by a migration, same pattern as ref_states/ref_entity_types (0002). Threshold fields are informational for the person entering a voucher, not enforced: this app does not track a deductee''s running aggregate payments across the year, so it cannot safely auto-decide whether a threshold has been crossed. See app_private.round_rupee (0001) for the rounding rule TDS actually uses once a rate here is applied to an amount.';

insert into public.ref_tds_sections
  (section_code, description, rate_percent, no_pan_rate_percent, threshold_single_rupees, threshold_aggregate_rupees, threshold_note, sort_order)
values
  ('194A', 'Interest other than on securities (non-bank payer) — recodified under Sec 393, Income-tax Act 2025, w.e.f. 1 Apr 2026; rate/threshold unchanged.',
    10, 20, null, 10000, null, 10),
  ('194C', 'Payments to resident contractors/sub-contractors — rate shown is for payees other than individual/HUF (1% applies to individual/HUF payees, not modelled here). Recodified under Sec 393.',
    2, 20, 30000, 100000, 'No deduction if a single payment is ≤ the single-payment threshold AND the aggregate to this contractor this FY is ≤ the aggregate threshold.',
    20),
  ('194H', 'Commission or brokerage. Recodified under Sec 393.',
    2, 20, null, 20000, null, 30),
  ('194I-PM', 'Rent — plant, machinery or equipment. Recodified under Sec 393.',
    2, 20, null, 600000, 'Statutory test is ₹50,000 or more for a month or part of a month, not a simple annual sum — the aggregate figure here is the annual equivalent.',
    40),
  ('194I-LB', 'Rent — land, building, furniture or fittings. Recodified under Sec 393.',
    10, 20, null, 600000, 'Statutory test is ₹50,000 or more for a month or part of a month, not a simple annual sum — the aggregate figure here is the annual equivalent.',
    41),
  ('194J-PROF', 'Fees for professional services, royalty (film sale/distribution/exhibition), or non-compete fees u/s 28(va). Recodified under Sec 393.',
    10, 20, null, 50000, 'Director''s fees/sitting fees under this section have no threshold at all (TDS from ₹1) — not represented by the aggregate figure here.',
    50),
  ('194J-TECH', 'Fees for technical services, or royalty for sale/distribution/exhibition of cinematographic films (technical nature). Recodified under Sec 393.',
    2, 20, null, 50000, null, 51),
  ('194Q', 'Purchase of goods, where the buyer''s turnover exceeded ₹10 crore in the preceding FY (a buyer-eligibility condition this table does not model). Recodified under Sec 393.',
    0.1, 5, null, 5000000, 'Applies only to the amount paid/credited to a single resident seller THIS FY in EXCESS of the aggregate threshold, not the full amount — unlike every other section here, where crossing the threshold taxes the whole payment.',
    60),
  ('194IA', 'Transfer of immovable property (other than agricultural land), on the higher of consideration or stamp-duty value. With multiple buyers/sellers, the threshold is tested on the aggregate across all of them, not per co-owner share. Recodified under Sec 393.',
    1, 20, 5000000, null, null, 70),
  ('194IB', 'Rent paid by an individual or HUF not subject to tax audit u/s 44AB (audit-bound individual/HUF payers use 194I-LB/194I-PM instead). Recodified under Sec 393.',
    2, 20, 50000, null, 'Threshold is monthly rent, not an annual test. Deducted once, for the tenancy''s last month, capped so total TDS never exceeds that month''s rent — including when the no-PAN rate would otherwise imply more.',
    80)
;

alter table public.ref_tds_sections enable row level security;

create policy ref_tds_sections_read on public.ref_tds_sections
  for select to authenticated using (true);


-- ----------------------------------------------------------------------------
-- Tighten the previously-unconstrained ledgers.default_tds_section
-- ----------------------------------------------------------------------------
-- Was free text with no list to check against. Zero rows have it set live
-- today (confirmed before writing this), so adding the FK now is safe.
alter table public.ledgers
  add constraint ledgers_default_tds_section_fkey
  foreign key (default_tds_section) references public.ref_tds_sections (section_code);
