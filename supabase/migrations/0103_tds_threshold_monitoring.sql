-- ============================================================================
-- 0103 — TDS threshold monitoring, per deductee per section
-- ============================================================================
-- ref_tds_sections (0043) has carried threshold_single_rupees and
-- threshold_aggregate_rupees since it was created — verified live this
-- session, both columns are populated for every one of the ten sections
-- currently seeded. Also verified live: grep across the whole app finds
-- nothing outside that one seeding migration that ever READS either column.
-- VoucherForm.tsx says so about itself, in its own comment above
-- tdsSuggestion() (line ~72, read fresh this session): "This never checks
-- whether the deductee's annual threshold has been crossed (the app doesn't
-- track running totals per deductee), so it always offers a split; whether
-- to take it is the preparer's call." A preparer who has not personally
-- kept a running total per vendor has no way to know whether Sec 194C's
-- Rs 1,00,000 aggregate, or 194J's Rs 50,000, has actually been crossed —
-- the split gets offered on every taxable-looking line regardless.
--
-- WHAT THIS MIGRATION IS AND ISN'T. It is a READ layer: one function that
-- answers "as of this date, is TDS applicable for this deductee under this
-- section, and why" from real posted history, plus a second function that
-- runs the first across every deductee with activity this year for a report
-- page. It does NOT change create_invoice, update_invoice, or VoucherForm's
-- posting/splitting logic — the task this migration was built from was
-- explicit that automatic enforcement inside voucher entry is a separate,
-- larger piece of UI work, scoped out here on purpose rather than rushed.
-- See caveats_for_integration in the session report for exactly where in
-- VoucherForm.tsx the wiring would go.
--
-- SEC 194Q — CONFIRMED LIVE, NOT ASSUMED, INCLUDING THE ONE DETAIL THAT
-- MAKES IT DIFFERENT FROM EVERY OTHER SECTION HERE. TDS on purchase of
-- goods: the buyer's turnover must have exceeded Rs 10 crore in the
-- PRECEDING financial year (a buyer-eligibility condition ref_tds_sections'
-- own description column already flags as "not modelled here" — this
-- migration does not model it either, see scope_deferred), and once
-- eligible, TDS applies to the amount paid/credited to a SINGLE resident
-- seller THIS FY IN EXCESS of Rs 50 lakh — confirmed current and unchanged
-- for 2026 by live search, including the recodification: the provision
-- moves from Sec 194Q of the 1961 Act to Sec 393(1) of the Income-tax Act
-- 2025, effective 1 Apr 2026, with the rate (0.1%) and threshold (Rs 50
-- lakh) both stated as unchanged by the recodification — matching what
-- ref_tds_sections.threshold_note (0043) already says. Confirmed the exact
-- section-code string this app actually stores rather than guessing:
-- 'section_code = ''194Q''' (select * from ref_tds_sections, read live).
-- This EXCESS-ONLY basis is the one genuinely different rule among the ten
-- seeded sections: every other section here taxes the WHOLE amount once a
-- threshold is crossed (confirmed live too — for 194C specifically, "once
-- the aggregate threshold is exceeded, TDS is deducted on the total
-- amount", not merely the excess); 194Q taxes only what sits above Rs 50
-- lakh. get_tds_threshold_status computes both bases and returns
-- taxable_basis_amount accordingly — see below.
--
-- WHAT "CUMULATIVE PAID/CREDITED THIS FY" MEANS HERE, AND ITS LIMITS.
-- Sec 194 language triggers on whichever comes first, payment or credit.
-- In this schema the ordinary case — a purchase/expense voucher CREDITING
-- the deductee ledger (create_invoice's own Cr-the-party-ledger pattern
-- for a purchase, or an equivalent journal entry) — is exactly a "credited"
-- event, so this migration sums CREDIT-side movement on the deductee
-- ledger, grouped per voucher so a single voucher's own total can be tested
-- against the SINGLE-payment threshold separately from the running
-- aggregate. NOT NETTED: a later payment voucher (which DEBITS the same
-- ledger to settle what was credited) is correctly excluded from the sum —
-- it is not a second, separate amount credited, it is the same one being
-- paid off — but a credit note or purchase return that also debits the
-- ledger is likewise excluded rather than netted against the original
-- credit, so a period with genuine returns will show a cumulative figure
-- slightly higher than the true net exposure. A pure ADVANCE paid before
-- any invoice exists (a payment voucher that DEBITS the deductee ledger
-- with nothing to net against yet) is not counted at all — stated here as
-- a real gap rather than silently missed. Both are the same class of
-- simplification 0053 already accepted for its own deductee attribution:
-- an honest reading of the ledger's own real postings, not a fabricated
-- "gross invoice value" the schema cannot reliably reconstruct for every
-- voucher shape.
--
-- ONE SECTION PER DEDUCTEE, MATCHING THE APP'S EXISTING MODEL. VoucherForm's
-- own tdsSuggestion() already assumes exactly one live section per deductee
-- ledger (ledgers.default_tds_section, singular). This migration's summary
-- function follows the same assumption for the report page — each
-- is_tds_deductee ledger is checked against its OWN current
-- default_tds_section, not cross-joined against all ten sections, for the
-- same reason 0053 attributes TDS to exactly one deductee per voucher
-- rather than guessing across many: a vendor genuinely has one applicable
-- section in the overwhelming case, and cross-joining would manufacture
-- nine irrelevant zero-rows per real deductee. The single-pair function,
-- get_tds_threshold_status, is not restricted this way — it takes the
-- section as an independent argument, so a caller (a future VoucherForm
-- wiring, or a preparer testing a hypothetical section) can check any
-- (deductee, section) combination, not only the ledger's current default.
--
-- SIGNATURE DEVIATION FROM THE TASK BRIEF, STATED PLAINLY. The task asked
-- for p_tds_section_id uuid. Verified live: ref_tds_sections has no uuid
-- id column at all — its primary key is section_code text (confirmed via
-- pg_constraint), the same natural key ledgers.default_tds_section already
-- references by FK. A uuid parameter would have nothing in this schema to
-- hold it. get_tds_threshold_status therefore takes p_tds_section_code
-- text, matching the column that actually exists.
--
-- NO NEW TABLES, NO NEW COLUMNS. Everything this migration needs —
-- threshold_single_rupees, threshold_aggregate_rupees, is_tds_deductee,
-- default_tds_section, and the ordinary voucher_entries/vouchers postings
-- every TDS split already makes — already exists. This is purely two new
-- read-only functions and one report page.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- get_tds_threshold_status — the single-pair check. Whether TDS is
-- currently applicable for one deductee under one section, as of one date,
-- and why: which threshold (single-payment, aggregate, or Sec 194Q's
-- excess-only basis) actually drove the answer.
-- ----------------------------------------------------------------------------
create or replace function public.get_tds_threshold_status(
  p_company_id uuid,
  p_deductee_ledger_id uuid,
  p_tds_section_code text,
  p_as_of date default current_date
) returns table (
  section_code text,
  section_description text,
  rate_percent numeric,
  no_pan_rate_percent numeric,
  financial_year_label text,
  fy_start_date date,
  as_of_date date,
  cumulative_credited_this_fy numeric,
  largest_single_transaction numeric,
  threshold_single_rupees numeric,
  threshold_aggregate_rupees numeric,
  single_threshold_crossed boolean,
  aggregate_threshold_crossed boolean,
  tds_applicable boolean,
  taxable_basis_amount numeric,
  basis_note text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with fy as (
    select app_private.fy_start_date(p_as_of, c.financial_year_start_month) as fy_start,
           app_private.fy_label(p_as_of, c.financial_year_start_month) as fy_label
      from public.companies c
     where c.id = p_company_id
  ),
  -- Credit-side movement only, grouped per voucher — see header for why
  -- debits (payments settling an existing credit, or advances with no
  -- credit to net against) are excluded rather than netted.
  movements as (
    select e.voucher_id, sum(e.credit_amount) as voucher_credit
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id and v.company_id = p_company_id
      cross join fy
     where e.company_id = p_company_id
       and e.ledger_id = p_deductee_ledger_id
       and e.credit_amount > 0
       and not v.is_deleted
       and v.voucher_date between fy.fy_start and p_as_of
     group by e.voucher_id
  ),
  agg as (
    select coalesce(sum(voucher_credit), 0) as cumulative,
           coalesce(max(voucher_credit), 0) as largest
      from movements
  )
  select
    s.section_code,
    s.description,
    s.rate_percent,
    s.no_pan_rate_percent,
    fy.fy_label,
    fy.fy_start,
    p_as_of,
    a.cumulative,
    a.largest,
    s.threshold_single_rupees,
    s.threshold_aggregate_rupees,
    (s.threshold_single_rupees is not null and a.largest > s.threshold_single_rupees) as single_threshold_crossed,
    (s.threshold_aggregate_rupees is not null and a.cumulative > s.threshold_aggregate_rupees) as aggregate_threshold_crossed,
    case when s.section_code is null then null
         else (s.threshold_single_rupees is not null and a.largest > s.threshold_single_rupees)
           or (s.threshold_aggregate_rupees is not null and a.cumulative > s.threshold_aggregate_rupees)
    end as tds_applicable,
    -- Sec 194Q: EXCESS over the aggregate threshold only. Every other
    -- section here: the FULL cumulative amount, once either threshold is
    -- crossed — not the excess. Getting these two confused in either
    -- direction would misstate the amount a preparer should now be
    -- withholding on.
    case
      when s.section_code is null then null
      when s.section_code = '194Q' then greatest(a.cumulative - coalesce(s.threshold_aggregate_rupees, 0), 0)
      when (s.threshold_single_rupees is not null and a.largest > s.threshold_single_rupees)
        or (s.threshold_aggregate_rupees is not null and a.cumulative > s.threshold_aggregate_rupees)
        then a.cumulative
      else 0
    end as taxable_basis_amount,
    case
      when s.section_code is null then 'Unknown or inactive TDS section code — nothing to evaluate against.'
      when s.section_code = '194Q' then 'Sec 194Q: TDS applies only to the amount paid/credited to this seller this FY in EXCESS of the aggregate threshold, not the full cumulative amount. Buyer-turnover eligibility (> Rs 10 crore preceding FY) is not checked by this function — see ref_tds_sections'' own description.'
      else 'TDS applies to the FULL amount once either the single-payment or the cumulative aggregate threshold is crossed, not merely the excess.'
    end as basis_note
    from fy, agg a
    left join public.ref_tds_sections s
      on s.section_code = p_tds_section_code and s.is_active
$$;

revoke all on function public.get_tds_threshold_status(uuid, uuid, text, date) from public, anon;
grant execute on function public.get_tds_threshold_status(uuid, uuid, text, date) to authenticated;

comment on function public.get_tds_threshold_status is
  'Whether TDS is currently applicable for one deductee ledger under one Sec 192-excluded TDS section, as of a given date, from real posted credit-side history this financial year (fy from companies.financial_year_start_month). Checks both threshold_single_rupees (crossed on any one voucher) and threshold_aggregate_rupees (crossed cumulatively) from ref_tds_sections, plus Sec 194Q''s distinct excess-over-threshold basis by name. Advisory/read-only — does not change create_invoice, update_invoice or VoucherForm''s posting logic. See 0103.';

-- ----------------------------------------------------------------------------
-- get_tds_threshold_status_summary — every deductee with activity this FY,
-- checked against its own current default_tds_section, for the report page.
-- ----------------------------------------------------------------------------
create or replace function public.get_tds_threshold_status_summary(
  p_company_id uuid,
  p_as_of date default current_date
) returns table (
  deductee_ledger_id uuid,
  deductee_name text,
  pan text,
  section_code text,
  section_description text,
  rate_percent numeric,
  financial_year_label text,
  cumulative_credited_this_fy numeric,
  largest_single_transaction numeric,
  threshold_single_rupees numeric,
  threshold_aggregate_rupees numeric,
  single_threshold_crossed boolean,
  aggregate_threshold_crossed boolean,
  tds_applicable boolean,
  taxable_basis_amount numeric,
  basis_note text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    d.id,
    d.name,
    d.pan,
    ts.section_code,
    ts.section_description,
    ts.rate_percent,
    ts.financial_year_label,
    ts.cumulative_credited_this_fy,
    ts.largest_single_transaction,
    ts.threshold_single_rupees,
    ts.threshold_aggregate_rupees,
    ts.single_threshold_crossed,
    ts.aggregate_threshold_crossed,
    ts.tds_applicable,
    ts.taxable_basis_amount,
    ts.basis_note
    from public.ledgers d
    cross join lateral public.get_tds_threshold_status(p_company_id, d.id, d.default_tds_section, p_as_of) ts
   where d.company_id = p_company_id
     and d.is_tds_deductee
     and d.default_tds_section is not null
     and ts.cumulative_credited_this_fy > 0
   order by d.name;
$$;

revoke all on function public.get_tds_threshold_status_summary(uuid, date) from public, anon;
grant execute on function public.get_tds_threshold_status_summary(uuid, date) to authenticated;

comment on function public.get_tds_threshold_status_summary is
  'Every is_tds_deductee ledger with real credit-side activity this FY, checked via get_tds_threshold_status against its OWN current default_tds_section (one section per deductee, matching VoucherForm''s existing tdsSuggestion() assumption). Advisory report source for reports/tds-threshold-status — not a filing, and not wired into any posting logic. See 0103.';

notify pgrst, 'reload schema';
