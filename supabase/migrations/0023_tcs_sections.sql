-- ============================================================================
-- 0023 — TCS: what's actually left of it, and why less than expected
-- ============================================================================
-- TCS (Tax Collected at Source, Sec 206C) is a CONDITIONAL module (0004:
-- activates on companies.tan is not null — the same predicate as TDS) that,
-- unlike TDS, had essentially no dedicated schema at all: nothing beyond the
-- module registration itself and a registration_type enum value.
--
-- Before seeding rates, two things were independently researched via two
-- parallel passes cross-checked against incometaxindia.gov.in and reconciled
-- with a third pass — not pulled from memory. Both surfaced a fact important
-- enough to record here rather than only in a commit message:
--
--   Section 206C(1H) — "TCS on sale of goods", the mirror image of 194Q and
--   by far the most broadly-applicable TCS provision (any seller with
--   turnover over ₹10 crore, on receipts over ₹50 lakh from any one buyer) —
--   was OMITTED from the Act effective 1 April 2025 (Finance Act 2025). It is
--   not recodified anywhere in the Income-tax Act, 2025 either. For any
--   transaction dated on or after 1 April 2025, there is no 206C(1H)
--   obligation at all — full stop, no precedence question against 194Q to
--   resolve, because there is no competing collection to precede. This is
--   NOT seeded below, deliberately: seeding a "rate 0 / inactive" row would
--   invite exactly the confusion this comment is trying to prevent.
--
-- What survives is a set of specified-goods provisions (206C(1) and
-- 206C(1F)) that are commodity-specific, not general-purpose the way TDS is:
-- scrap, certain minerals, liquor, motor vehicles, timber, tendu leaves.
-- Every one of these is a property of WHAT is being sold, not of WHO the
-- buyer is — the opposite of TDS's shape (194C/194J/etc. depend on who
-- you're paying, not what for). That is why this section belongs on
-- items.default_tcs_section, mirroring items.gst_rate_percent (0018), rather
-- than on ledgers the way TDS's default_tds_section does.
--
-- Scope of this migration: reference data and the items column only — no
-- invoice-time TCS computation yet. Wiring TCS collection into
-- create_invoice (mirroring the GST tax engine) is real future work, but a
-- deliberately separate, larger change to the app's most complex function;
-- this migration closes the "the rates don't even exist anywhere" gap first,
-- same as 0022 did for TDS's write-only-via-SQL problem, without taking on
-- that larger change in the same pass.
-- ============================================================================

create table public.ref_tcs_sections (
  section_code text primary key,
  description text not null,
  rate_percent numeric(5,2) not null check (rate_percent >= 0 and rate_percent <= 100),
  -- Section 206CC's no-PAN rate is generally twice the normal rate or 5%,
  -- whichever is higher (capped at 20%) — for every rate seeded below, 5% is
  -- the higher of the two, so that is what's stored; not assumed uniformly,
  -- same reasoning as ref_tds_sections' no_pan_rate_percent.
  no_pan_rate_percent numeric(5,2) not null check (no_pan_rate_percent >= 0 and no_pan_rate_percent <= 100),
  threshold_rupees numeric(18,2),
  threshold_note text,
  sort_order smallint not null,
  is_active boolean not null default true
);

comment on table public.ref_tcs_sections is
  'Reference data, not tenant data — same world-readable, migration-only-write pattern as ref_tds_sections (0022) and ref_states (0002). Deliberately excludes 206C(1H), omitted from the Act effective 1 April 2025 — see this migration''s header comment.';

insert into public.ref_tcs_sections
  (section_code, description, rate_percent, no_pan_rate_percent, threshold_rupees, threshold_note, sort_order)
values
  ('TCS-SCRAP', 'Scrap — waste/scrap from manufacture or mechanical working of materials, usable only for recovery of metal. Sec 206C(1), recodified as Sec 394(1) of the Income-tax Act, 2025.',
    2, 5, null, null, 10),
  ('TCS-MINERAL', 'Coal, lignite, or iron ore — sale as goods to a trader; excludes a buyer who consumes it directly in manufacturing or power generation. Sec 206C(1), recodified as Sec 394(1).',
    2, 5, null, null, 20),
  ('TCS-VEHICLE', 'Motor vehicle, per vehicle, once the sale consideration crosses the threshold — collected on the whole consideration, not just the excess. Sec 206C(1F), recodified as Sec 394(1).',
    1, 5, 1000000, 'Per vehicle, not aggregated across vehicles or buyers.', 30),
  ('TCS-LIQUOR', 'Alcoholic liquor for human consumption. Sec 206C(1), recodified as Sec 394(1).',
    2, 5, null, null, 40),
  ('TCS-TIMBER-LEASE', 'Timber obtained under a forest lease. Sec 206C(1), recodified as Sec 394(1).',
    2, 5, null, null, 50),
  ('TCS-TIMBER-OTHER', 'Timber obtained by any mode other than a forest lease. Sec 206C(1), recodified as Sec 394(1).',
    2, 5, null, null, 51),
  ('TCS-FOREST-OTHER', 'Forest produce other than timber or tendu leaves. Sec 206C(1), recodified as Sec 394(1).',
    2, 5, null, null, 52),
  ('TCS-TENDU', 'Tendu leaves — cut from 5% to 2% effective 1 April 2026, the largest single change in that rate rationalisation. Sec 206C(1), recodified as Sec 394(1).',
    2, 5, null, null, 60)
;

alter table public.ref_tcs_sections enable row level security;

create policy ref_tcs_sections_read on public.ref_tcs_sections
  for select to authenticated using (true);


-- ----------------------------------------------------------------------------
-- items.default_tcs_section — mirrors items.gst_rate_percent (0018)
-- ----------------------------------------------------------------------------
alter table public.items
  add column default_tcs_section text
    references public.ref_tcs_sections (section_code);
