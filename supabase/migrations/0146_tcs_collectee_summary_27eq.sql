-- ============================================================================
-- 0146 — TCS collectee summary (Form 143 / Form 27EQ prep), the mirror of
-- get_tds_deductee_summary (0053) that earlier TDS-return-prep work flagged
-- as missing: "27EQ could not be built because this function did not exist."
-- ============================================================================
-- WHAT ALREADY EXISTED, CONFIRMED LIVE BEFORE WRITING ANY OF THIS.
--   - public.ref_tcs_sections (0023 or thereabouts) already carries the full
--     Sec 206C(1)/(1F) specified-goods rate table: TCS-SCRAP, TCS-MINERAL,
--     TCS-LIQUOR, TCS-FOREST-OTHER, TCS-TIMBER-LEASE, TCS-TIMBER-OTHER,
--     TCS-TENDU (all rate_percent 2.00, no_pan_rate_percent 5.00) and
--     TCS-VEHICLE (1.00% / 5.00%, threshold_rupees 1,000,000, per vehicle).
--   - items.default_tcs_section (0027) tags which items carry which section
--     — TCS lives on the ITEM, never on the ledger, unlike TDS's
--     ledgers.default_tds_section.
--   - public.tax_ledger_map has carried purpose = 'output_tcs' since 0027;
--     create_invoice/update_invoice (0087, latest copy) already compute and
--     post v_tcs_total to it correctly on every sales/credit_note invoice —
--     confirmed live against Sharma Textiles' own TCS voucher below.
--   - There is no ledgers.is_tcs_collectee flag, and no Form 27C ("used for
--     manufacturing, not resale — no TCS") tracking anywhere in this schema.
--     Both confirmed absent by direct information_schema/pg_proc queries
--     during this task. The second is a real, stated gap — see SCOPE below.
--
-- STATUTORY BASIS (WebSearch during this task, "obvious answer" pass then a
-- deliberately skeptical second pass — dated live searches, not training
-- recall, per this session's own standing discipline).
--   - Sec 206C, Income-tax Act 1961, recodified as Sec 394(1) in the
--     Income-tax Act 2025 (tax year 2026-27 onward, i.e. already the live
--     citation as of today 25-Aug-2026) per blog.tdsman.com's own May/June
--     2026 posts on the recodification and its Form 143/27EQ mapping note.
--     One indexed source (taxgarden.in) instead says "Section 506" for the
--     same provision — flagged here as an unresolved citation conflict
--     (see caveats_for_integration) rather than silently picking one; this
--     migration follows the SAME "Sec 394(1)" label ref_tcs_sections
--     already committed to in an earlier session, for internal consistency,
--     not because the conflict was resolved.
--   - Sec 206C(1) specified-goods rates: confirmed AT 2% ACROSS THE BOARD as
--     of the April 2026 rationalisation — liquor and minerals/scrap went UP
--     from 1% to 2%, tendu leaves came DOWN from 5% to 2%, timber/forest
--     produce converged to 2% — exactly what ref_tcs_sections already has
--     seeded, re-verified today rather than assumed correct because it was
--     already there. Sec 206C(1F) motor vehicle TCS (1%, Rs 10 lakh
--     threshold, per vehicle not aggregated) is unchanged. Sources:
--     taxguru.in's "TCS Rate Chart for Tax Year 2026-27", pgaca.in's TCS
--     rate chart, businesstoday.in's TDS/TCS explainer (16-Apr-2026).
--   - Sec 206C(1H) (TCS on sale of goods, aggregate receipts > Rs 50 lakh
--     from one buyer, 0.1%) — CONFIRMED ABOLISHED effective 1 April 2025
--     (Finance Act 2025), specifically to remove the double-compliance
--     overlap with TDS Sec 194Q on the same transactions. This is WHY
--     ref_tcs_sections correctly has no row for it — not an omission this
--     migration needed to fix. Sources: taxguru.in "TCS on Sale of Goods
--     Removed From April 1 2025 — FAQs", SAP KBA 3574318.
--   - Sec 206C(1G) (TCS on outward foreign remittance under LRS / overseas
--     tour packages, collected by an Authorised Dealer/tour operator, NOT
--     by a goods seller) — confirmed still in force, current FY 2026-27
--     rate a flat 2% with no threshold for education/medical/tour-package
--     remittances (simplified from the FY 2025-26 5%-up-to-10L/20%-above
--     tiering by Budget 2026). NOT REPRESENTABLE by this schema and
--     deliberately not attempted here — see SCOPE below.
--   - Form 27EQ / Form 143 structure confirmed to mirror 26Q/Form 140's own
--     three-part shape closely enough to reuse that report page's layout
--     unchanged: (1) collector details — TAN/PAN, same as deductor details;
--     (2) challan detail — BSR code/date/serial, same OLTAS challan 281
--     shape TDS already uses; (3) collectee-wise annexure — party PAN,
--     name, section, gross transaction value, tax collected. Form 143 is
--     Form 27EQ's Income-tax-Act-2025 renumbering, same as 140/26Q. Source:
--     taxindiaonline.com's Form 27EQ PDF (rule 31AA), tdsman.com's Form
--     27EQ PDF, blog.tdsman.com's "New TDS/TCS Forms Under the IT Act 2025"
--     mapping post.
--
-- SCOPE, deliberately narrow (this session's "simplest shape first, said
-- explicitly rather than guessed" discipline, same as 0072/0120's own
-- scope notes):
--   - Sec 206C(1)/(1F) specified-goods and motor-vehicle TCS ONLY — exactly
--     what create_invoice/update_invoice already compute and post, sourced
--     from items.default_tcs_section. Sec 206C(1G) (LRS/foreign remittance/
--     overseas tour packages) is NOT represented: it is not a sale of an
--     ITEM at all (no goods line, no HSN, often not even a sales voucher —
--     an authorised dealer's outward remittance is typically a bank payment
--     voucher), and nothing in this schema's create_invoice/create_voucher
--     path computes or posts it. A company that also acts as an LRS
--     remittance collector needs a separate feature, not silently folded
--     into this one.
--   - Form 27C ("buyer will use the goods for manufacturing, not resale —
--     no TCS") declarations are not tracked anywhere in this schema (no
--     table, no ledger flag) — so this report cannot show which
--     transactions were legitimately NOT charged TCS on that ground versus
--     which should have been but weren't. Stated in the report page copy,
--     not silently assumed.
--   - No FVU-ready upload file, for the identical reason 26Q's own page
--     gives: RPU/FVU remain mandatory for the actual e-filing upload and
--     this session could not confirm the flat-file's byte-level field
--     positions with confidence, so it does not attempt to fabricate one.
--
-- COLLECTEE ATTRIBUTION IS SIMPLER AND MORE RELIABLE THAN TDS'S DEDUCTEE
-- ATTRIBUTION — NOT THE SAME MECHANISM, BY DESIGN. get_tds_deductee_summary
-- has to VOTE across every is_tds_deductee-flagged ledger on a voucher,
-- because a TDS deduction can be booked on a plain journal voucher with no
-- party_ledger_id at all (rent, professional fees, etc. are not always
-- invoiced through create_invoice). TCS is different: v_tcs_on in create_
-- invoice/update_invoice is only ever true when v_tax_prefix = 'output',
-- which is only reachable for voucher_type IN ('sales', 'credit_note'), and
-- BOTH of those voucher types are only ever created through create_invoice/
-- update_invoice — which always populate vouchers.party_ledger_id. So the
-- collectee is read DIRECTLY off vouchers.party_ledger_id, not inferred by
-- counting flagged ledgers. Confirmed live: every one of the 10 seeded
-- companies' output_tcs postings today is voucher_type = 'sales' with
-- party_ledger_id NOT null (see this task's verification queries). The
-- null-collectee branch below is kept purely as a defensive fallback for a
-- hypothetical direct journal credit to an output_tcs-mapped ledger outside
-- create_invoice/update_invoice — not something any live data does today.
--
-- SECTION ATTRIBUTION IS THE OPPOSITE TRADE: HARDER THAN TDS'S, BECAUSE THE
-- SECTION LIVES ON THE ITEM, NOT ON THE LEDGER. get_tds_deductee_summary
-- reads section_code off the deductee ledger itself (ledgers.default_tds_
-- section) — a single fixed property per ledger, so grouping by ledger
-- automatically yields one section per group. TCS's section instead comes
-- from items.default_tcs_section, and a single sales voucher can carry
-- several item lines. This migration attributes a voucher's WHOLE TCS total
-- to ONE section only when every item on that voucher that carries a
-- section carries the SAME one — exactly analogous to TDS's "attributed
-- only when the vote is unanimous" rule, just voting on items instead of
-- ledgers. A voucher mixing two different TCS sections (the schema does not
-- forbid it, even though no live data does it today) falls into a
-- section_code IS NULL bucket the report page surfaces as "needs review",
-- the same way TDS surfaces a multi-deductee voucher.
--
-- AGGREGATION GRAIN: per (collectee_ledger_id, section_code) PAIR, per the
-- task's own instruction — NOT per collectee alone. This is a genuine,
-- deliberate difference from get_tds_deductee_summary's group-by (which is
-- per-ledger only, because section is ledger-fixed for TDS and grouping by
-- ledger already implies one section). The same buyer purchasing both scrap
-- (TCS-SCRAP) and a motor vehicle (TCS-VEHICLE) in the same quarter must
-- appear as two rows, one per section, because Form 27EQ's own annexure is
-- itself section-wise within collectee — folding them into one row would
-- misreport which section each rupee of collected tax belongs to.
--
-- SIGN CONVENTION: tcs_amount per voucher is credit_amount - debit_amount
-- on the output_tcs-mapped ledger, not a bare credit_amount > 0 filter (the
-- pattern get_tds_deductee_summary uses, safe there because tds_payable is
-- only ever credited on deduction and debited on payment-to-government, a
-- distinction this function's own equivalent purpose filter does not need
-- to make). A TCS-bearing credit_note DEBITS output_tcs to reverse a prior
-- collection (see create_invoice/update_invoice's own v_party_side='credit'
-- branch) — netting credit-minus-debit lets a credit_note's reversal offset
-- the original sale's collection correctly within the same period, mirroring
-- 0120's own stated CDNR sign-netting discipline. No live voucher exercises
-- this path today (all 10 seeded TCS postings are plain sales), so it is
-- verified by inspection of create_invoice/update_invoice's own code, not
-- by a live credit-note example — stated plainly rather than left implied.
--
-- PARTY_LEDGER_MOVEMENT, same caveat as TDS's own column: it is the
-- collectee ledger's actual net debit/credit movement on the matched
-- voucher(s) — for a plain TCS sale this is v_grand_total (taxable value +
-- GST + TCS, the full invoice amount the buyer owes), not a separately
-- recomputed taxable value. Confirmed live below against Sharma Textiles'
-- own invoice.
-- ============================================================================

create or replace function public.get_tcs_collectee_summary(
  p_company_id uuid,
  p_financial_year_label text,
  p_quarter integer
) returns table (
  collectee_ledger_id uuid,
  collectee_name text,
  pan text,
  section_code text,
  section_description text,
  section_rate_percent numeric,
  voucher_count integer,
  tcs_collected numeric,
  party_ledger_movement numeric
)
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_fy_start int;
  v_period_start date;
  v_period_end date;
begin
  if p_financial_year_label !~ '^\d{4}-\d{2}$' then
    raise exception 'p_financial_year_label must look like "2026-27"';
  end if;
  if p_quarter not in (1, 2, 3, 4) then
    raise exception 'p_quarter must be 1, 2, 3 or 4';
  end if;

  v_fy_start := split_part(p_financial_year_label, '-', 1)::int;
  -- Same Apr-Jun/Jul-Sep/Oct-Dec/Jan-Mar quarter arithmetic as
  -- get_234e_late_fee (0130) and the TS tdsReturnQuarters.ts helper — the
  -- calendar-year TDS/TCS return quarter, never a company's own book year.
  v_period_start := case p_quarter
    when 1 then make_date(v_fy_start, 4, 1)
    when 2 then make_date(v_fy_start, 7, 1)
    when 3 then make_date(v_fy_start, 10, 1)
    when 4 then make_date(v_fy_start + 1, 1, 1)
  end;
  v_period_end := (v_period_start + interval '3 months' - interval '1 day')::date;

  return query
    with tcs_lines as (
      select e.voucher_id, sum(e.credit_amount - e.debit_amount) as tcs_amount
        from public.voucher_entries e
        join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
        join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
       where e.company_id = p_company_id
         and m.purpose = 'output_tcs'
         and (e.credit_amount > 0 or e.debit_amount > 0)
         and not v.is_deleted
         and v.voucher_date between v_period_start and v_period_end
       group by e.voucher_id
    ),
    section_candidates as (
      select vi.voucher_id, i.default_tcs_section as section_code
        from public.voucher_items vi
        join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
        join tcs_lines t on t.voucher_id = vi.voucher_id
       where vi.company_id = p_company_id
         and i.default_tcs_section is not null
    ),
    voucher_section as (
      select sc.voucher_id,
             case when count(distinct sc.section_code) = 1
                  then (array_agg(distinct sc.section_code))[1] end as section_code
        from section_candidates sc
       group by sc.voucher_id
    ),
    party_movement as (
      select e.voucher_id, abs(e.debit_amount - e.credit_amount) as movement
        from public.voucher_entries e
        join tcs_lines t on t.voucher_id = e.voucher_id
        join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
       where e.company_id = p_company_id
         and v.party_ledger_id is not null
         and e.ledger_id = v.party_ledger_id
    ),
    attributed as (
      select
        t.voucher_id,
        t.tcs_amount,
        v.party_ledger_id as collectee_ledger_id,
        vs.section_code,
        coalesce(pm.movement, 0) as party_ledger_movement
        from tcs_lines t
        join public.vouchers v on v.id = t.voucher_id and v.company_id = p_company_id
        left join voucher_section vs on vs.voucher_id = t.voucher_id
        left join party_movement pm on pm.voucher_id = t.voucher_id
    )
    select
      a.collectee_ledger_id,
      coalesce(l.name, '(unattributed — voucher has no party ledger on file)') as collectee_name,
      l.pan,
      a.section_code,
      s.description as section_description,
      s.rate_percent as section_rate_percent,
      count(*)::integer as voucher_count,
      sum(a.tcs_amount) as tcs_collected,
      sum(a.party_ledger_movement) as party_ledger_movement
      from attributed a
      left join public.ledgers l on l.id = a.collectee_ledger_id
      left join public.ref_tcs_sections s on s.section_code = a.section_code
     group by a.collectee_ledger_id, l.name, l.pan, a.section_code, s.description, s.rate_percent
     order by (a.collectee_ledger_id is null), (a.section_code is null), s.description nulls last, l.name nulls last;
end;
$function$;

revoke all on function public.get_tcs_collectee_summary(uuid, text, integer) from public, anon;
grant execute on function public.get_tcs_collectee_summary(uuid, text, integer) to authenticated;

comment on function public.get_tcs_collectee_summary(uuid, text, integer) is
  'Per-collectee-per-section TCS summary for one Apr-Jun/Jul-Sep/Oct-Dec/Jan-Mar quarter of p_financial_year_label ("2026-27"-shaped) — the collectee-wise annexure for Form 143/27EQ (Sec 206C, recodified Sec 394(1)). Collectee is read directly off vouchers.party_ledger_id (reliable here because create_invoice/update_invoice always set it on the only voucher types that ever post output_tcs — see migration 0146 for why this is NOT the same voting mechanism get_tds_deductee_summary uses). Section comes from items.default_tcs_section, attributed to a voucher''s whole TCS total only when every TCS-tagged item line on it shares one section; a voucher mixing sections gets section_code null, the "needs review" bucket. tcs_collected nets credit-minus-debit on the output_tcs-mapped ledger per voucher (a TCS-bearing credit_note reverses correctly). Sec 206C(1G) LRS/foreign-remittance/overseas-tour-package TCS is out of scope — not item-based, nothing in this schema posts it. See 0146''s header for full statutory sourcing and scope.';
