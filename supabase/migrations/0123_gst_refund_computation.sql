-- ============================================================================
-- 0122 — GST refund computation: Rule 89(4) (zero-rated/LUT export) and
--         Rule 89(5) (inverted duty structure)
-- ============================================================================
-- A refund of unutilised ITC is filed on the GST portal via Form GST RFD-01.
-- Nothing here files anything or talks to the portal — this migration
-- computes the REFUND AMOUNT the rule's own formula produces, as prep data a
-- preparer copies onto RFD-01 by hand. Read-only, reuses get_gst_input_
-- register / get_gst_output_register's join shape (0035) and the zero-rated
-- supply data 0087 already posts correctly (vouchers.supply_type,
-- gst_registrations.lut_valid_from/to) plus items.supply_nature (0081) and
-- items.itc_eligibility (0082) — all four are read-only prerequisites here,
-- none of them touched.
--
-- ----------------------------------------------------------------------------
-- THE LAW, CONFIRMED LIVE (24 Aug 2026) AGAINST THE BARE RULE TEXT AT
-- taxinformation.cbic.gov.in, NOT RECALLED FROM MEMORY — this is exactly the
-- kind of "obvious-looking formula" this codebase has been burned by getting
-- subtly wrong before (0104's own header lists three such traps in Rule 42
-- alone), and Rule 89(5) in particular was rewritten by the 47th GST Council
-- (Notification 14/2022-CT, 5 Jul 2022) in a way several secondary sources
-- still describe using the PRE-amendment formula.
--
--   RULE 89(4) — zero-rated supply made under LUT/bond, without payment of
--   tax (Sec 16(3)(a) IGST Act; this app's 'export_lut' supply_type, and a
--   'sez' supply_type voucher that was actually invoiced at zero tax — see
--   "WHICH VOUCHERS COUNT" below):
--
--     Refund Amount = (Turnover of zero-rated supply of goods
--                       + Turnover of zero-rated supply of services)
--                      x Net ITC / Adjusted Total Turnover
--
--   RULE 89(5) — inverted duty structure (post-5-Jul-2022 text; the formula
--   BEFORE that date used only "inputs", not "inputs and input services", in
--   both the Net ITC definition and the second term — cited here because a
--   second, deliberately skeptical search kept surfacing the pre-amendment
--   version as if it were still current):
--
--     Maximum Refund Amount =
--       { (Turnover of inverted rated supply of goods and services)
--         x Net ITC / Adjusted Total Turnover }
--       - { tax payable on such inverted rated supply of goods and services
--           x (Net ITC / ITC availed on inputs and input services) }
--
--   DEFINITIONS (Explanation to Rule 89; (5)'s own text says Net ITC and
--   Adjusted Total Turnover "shall have the same meaning as assigned to
--   them in sub-rule (4)" — one shared definition, not two):
--
--     Net ITC = ITC availed on INPUTS AND INPUT SERVICES during the
--     relevant period, other than ITC availed for which refund is claimed
--     under sub-rules (4A) or (4B) (deemed-export / EOU-related refund
--     routes this app does not compute — see "WHAT NET ITC EXCLUDES" below).
--     Capital goods are NOT in this list — Net ITC excludes ITC on capital
--     goods entirely, on both rules, always.
--
--     Adjusted Total Turnover = turnover in the State/UT under Sec 2(112)
--     CGST Act (all taxable + exempt + zero-rated + inter-State supplies
--     made from that State, tax-exclusive), EXCLUDING the value of exempt
--     supplies OTHER THAN zero-rated supplies, and excluding turnover
--     already refunded under 4A/4B. Working through the Explanation's own
--     two-clause split (state turnover minus services, plus services back
--     in) collapses to exactly that for this schema's purposes: ATT = F - E,
--     the SAME F (total turnover) and E (exempt/nil-rated/non-GST turnover)
--     0104's Rule 42 report already computes from items.supply_nature — just
--     filtered to one GST registration here, which 0104 deliberately is not
--     (see 0104's own header; this migration's per-registration filter is a
--     strict improvement on that pattern, flagged in caveats_for_integration
--     as something 0104 could adopt too).
--
--     "Relevant period" = the period the refund claim is filed for — the
--     caller's own p_period_start/p_period_end, no extra logic needed.
--
-- WHAT NET ITC EXCLUDES, AND THE ONE GAP THIS SCHEMA CANNOT CLOSE. Net ITC
-- here = eligible input tax on 'taxable' purchases only: Sec 17(5)-blocked
-- credit (items.itc_eligibility = 'blocked') is excluded, and so is credit
-- directly attributable to a nil-rated/exempt/non-GST purchase (items.
-- supply_nature) — that credit was never validly "availed" under Sec 17(2)
-- in the first place, the same T2/T3 exclusion 0104's Rule 42 report already
-- applies, computed here with an identical apportion-by-value-share
-- technique (0082/0104's own method, not reinvented). What is NOT excluded,
-- because the schema has no signal for it at all: ITC on CAPITAL GOODS.
-- items has no is_capital_goods flag — a machine bought on a 'purchase'
-- voucher with an item marked 'goods' is indistinguishable here from trading
-- stock or a raw material. fixed_assets (0025) is a wholly separate register
-- with no link back to vouchers/voucher_items, so it cannot be used to
-- exclude a capital purchase either. A company that bought capital equipment
-- through an ordinary purchase invoice during the claim period will see this
-- report's Net ITC OVERSTATED relative to the strict Explanation text —
-- said here and again in the report's own UI copy, not silently absorbed.
-- Also not netted: any Rule 42/43 common-credit reversal (D1/D2) that may
-- separately apply for the SAME period (0104's get_common_credit_
-- apportionment) — the bare Explanation text does not call for that netting
-- and it is a distinct periodic compliance step, but a preparer with real
-- exempt-supply exposure should run 0104 for the same window and net it in
-- by hand; this report does not do that automatically.
--
-- WHICH VOUCHERS COUNT AS "ZERO-RATED WITHOUT PAYMENT OF TAX" (Rule 89(4)).
-- 'export_lut' is the clean, unambiguous signal — 0087's create_invoice only
-- ever writes it when the party is 'overseas' AND the registration's LUT was
-- active on the voucher date. A 'sez' voucher is LESS clean by itself: 0087
-- deliberately did not split vouchers.supply_type into sez_lut/sez_igst (see
-- 0087's own header — GSTR-1 Table 6 reporting was out of scope there), so
-- 'sez' alone cannot tell route (a) [LUT, zero tax] from route (b) [IGST
-- charged, refunded separately under Rule 96]. But create_invoice's own tax
-- branch is provably deterministic here: for an 'sez' voucher, the posted
-- tax is EXACTLY ZERO if and only if LUT was active at posting time (see
-- 0087's create_invoice: `when v_supply_type='export_lut' or (v_supply_type
-- ='sez' and v_lut_active) then null`) — there is no other way an 'sez'
-- voucher can carry zero CGST+SGST+IGST+cess. So an 'sez' voucher with zero
-- total tax posted is included in the zero-rated turnover here too, derived
-- from the postings rather than guessed, and reported as its own labelled
-- line so a reader can see the two are not the same fact. 'export_igst' and
-- 'sez' with tax charged are Rule 96 refund-of-tax-paid cases, a different
-- mechanism entirely (refund of the tax itself, not this turnover-ratio
-- formula) and are correctly excluded here.
--
-- THE 1.5x-DOMESTIC-VALUE CAP ON GOODS TURNOVER, AND THE SERVICES
-- PAYMENT-BASIS RULE, ARE BOTH NOT APPLIED. The Explanation's own definition
-- of "turnover of zero-rated supply of goods" caps it at 1.5 times the value
-- of like goods domestically supplied by the same or a similarly placed
-- supplier, whichever is LESS — an anti-overvaluation safeguard this schema
-- has no reference data to compute (no "like goods" domestic comparable is
-- recorded anywhere). "Turnover of zero-rated supply of SERVICES" is
-- defined on a PAYMENTS-RECEIVED basis (aggregate advances/payments realised
-- in the period, not invoice value) — this app has no bill-wise receipt
-- allocation (the same admitted gap 0096's Rule 37 report and 0017's
-- get_party_outstanding both carry: no receipt is linked to which specific
-- invoice it settles). Both figures below use INVOICE VALUE as the working
-- proxy for turnover, goods and services alike, and say so in the UI rather
-- than silently presenting an invoice-value figure as if it already applied
-- either statutory refinement. A claim near the 1.5x cap, or with material
-- unrealised export-of-services turnover, needs manual adjustment before
-- RFD-01.
--
-- ----------------------------------------------------------------------------
-- RULE 89(5) — CAN THIS SCHEMA EVEN DETECT AN INVERTED DUTY STRUCTURE?
-- Investigated live before assuming either way, per this task's own brief.
--
-- THE ONLY GENUINE INPUT-TO-OUTPUT LINK IN THIS SCHEMA is bill_of_materials
-- / bom_components (0070/0114) — a manufacturing recipe naming which
-- component items go into which output item. Checked live: it exists, but
-- it does not solve the problem Rule 89(5) actually poses. A BOM records a
-- STANDARD recipe (component item, quantity per batch) at today's item
-- rates — it has no per-transaction genealogy back to which specific
-- purchase invoice (and therefore which specific GST rate actually paid)
-- supplied a given production run's components, most companies in this
-- database are trading businesses with no BOM at all, and even a BOM-using
-- manufacturer's DOMESTIC SALES of the finished item are ordinary sales
-- vouchers with no back-reference to any particular production voucher or
-- BOM. Wiring "this specific sale's item was produced from these specific
-- rated inputs" would need a genealogy this schema does not keep anywhere
-- create_invoice or create_production_voucher currently write.
--
-- SO THIS IS BUILT AS THE HONEST APPROXIMATION THIS TASK'S OWN BRIEF
-- ANTICIPATES: aggregate ITC on inputs at a rate exceeding the rate charged
-- on a given OUTPUT item, not a claim-ready per-transaction linkage.
-- Concretely — an AGGREGATE effective input GST rate for the period is
-- computed from Net ITC's own eligible-taxable-purchase base (total eligible
-- input tax / total eligible input taxable value), then EVERY domestic
-- output item sold in the period has ITS OWN gst_rate_percent compared
-- against that one aggregate figure. An item is flagged "possibly
-- inverted-rated" when its own rate is STRICTLY LESS than the aggregate
-- input rate — the textbook inverted-duty condition ("rate of tax on inputs
-- higher than rate of tax on output"), applied per output item rather than
-- blended into one company-wide yes/no the way a flatter approximation
-- would, while still only ever comparing against the AGGREGATE input rate
-- (not a genuine per-item BOM linkage, which the paragraph above explains
-- this schema cannot give). This is clearly labelled in the report and in
-- both function comments as an approximation, not a claim-ready figure — a
-- real RFD-01 needs the filer's own knowledge of which inputs fed which
-- output, which this software does not have.
--
-- SEC 54(3)'S OWN PROVISO EXCLUDES NIL-RATED/FULLY-EXEMPT OUTPUT, CONFIRMED
-- LIVE rather than assumed from the Rule 89(5) text alone (which does not
-- restate it): the first proviso to Sec 54(3) CGST Act allows the inverted-
-- duty refund only for output supplies "other than nil rated or fully
-- exempt supplies" — an output taxed at 0% cannot itself generate an
-- inverted-duty claim, however high the tax on its inputs, because Sec 54(3)
-- carves that case out at the parent-section level. So the candidate pool
-- here is filtered to items.supply_nature = 'taxable' only; a nil-rated or
-- exempt output item is never flagged, whatever its own zero rate implies
-- about the input-rate comparison.
--
-- ZERO-RATED (EXPORT/SEZ/DEEMED-EXPORT) SUPPLY IS EXCLUDED FROM THE
-- CANDIDATE POOL TOO. Rule 89(4) already refunds the ITC behind a genuinely
-- zero-rated supply via the turnover-ratio formula above; running the SAME
-- turnover through Rule 89(5) as well, just because its effective output
-- rate is 0%, would double-claim the identical credit under two different
-- refund mechanisms. Deemed exports (Sec 147) are excluded too — refunded,
-- if at all, via the tax-paid route this app does not compute (see 0087's
-- own header), a third distinct mechanism this report does not attempt.
-- Only voucher_type IN ('sales','credit_note') with supply_type IN ('intra',
-- 'inter') — ordinary domestic supply — feeds the Rule 89(5) candidate pool.
--
-- SUPPORTING ITEM-LEVEL DETAIL: get_gst_refund_rule89_5_items. Rule 89(5)'s
-- own headline function returns one aggregate row, same shape as 0104's
-- get_common_credit_apportionment; a preparer reviewing WHICH items were
-- actually flagged needs the per-item rows behind that total, so a third,
-- small companion function is added purely to back the report page's detail
-- table — it duplicates no arithmetic, it just exposes the same
-- classification at item grain instead of summed.
--
-- DUPLICATED, NOT SHARED, BETWEEN THE TWO HEADLINE FUNCTIONS — a deliberate
-- choice, matching this codebase's established pattern for GST report
-- functions (0082, 0096, 0098, 0104 are all self-contained; 0087's own
-- header explains the general risk of a shared helper drifting silently).
-- Net ITC and Adjusted Total Turnover are computed by near-identical CTEs in
-- both get_gst_refund_rule89_4 and get_gst_refund_rule89_5 SPECIFICALLY
-- BECAUSE Rule 89(5)'s own text says they "have the same meaning as
-- assigned... in sub-rule (4)" — a future change to one MUST be mirrored in
-- the other, exactly the same discipline 0087 already states for
-- create_invoice/update_invoice.
--
-- NOT A POSTING RPC. Same as itc-04-prep, itc-180day-reversal and 0104:
-- nothing here writes a journal entry or a refund application. It is a
-- number a preparer copies onto RFD-01 after their own review.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_gst_refund_rule89_4 — zero-rated supply under LUT, refund of ITC
-- ----------------------------------------------------------------------------
create or replace function public.get_gst_refund_rule89_4(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  export_lut_turnover numeric,          -- supply_type = 'export_lut'
  sez_zero_tax_turnover numeric,        -- supply_type = 'sez', zero tax actually posted
  zero_rated_turnover_goods numeric,    -- the two lines above, item_type = 'goods'
  zero_rated_turnover_services numeric, -- the two lines above, item_type = 'service'
  zero_rated_turnover_total numeric,    -- the formula's own numerator turnover
  net_itc numeric,
  net_itc_cgst numeric,
  net_itc_sgst numeric,
  net_itc_igst numeric,
  net_itc_cess numeric,
  blocked_or_exempt_linked_itc_excluded numeric, -- T2+T3, informational only
  total_turnover numeric,               -- F, this registration's state turnover
  exempt_turnover numeric,              -- E, nil-rated/exempt/non-GST, this registration
  adjusted_total_turnover numeric,      -- ATT = F - E
  refund_amount numeric                 -- the Rule 89(4) formula's own result
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  with reg_vouchers_out as (
    select v.id, v.voucher_type, v.supply_type
      from public.vouchers v
     where v.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_type in ('sales', 'credit_note')
       and v.voucher_date between p_period_start and p_period_end
       and (p_gst_registration_id is null
            or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
  ),
  -- Tax actually posted per zero-rated-candidate voucher, so an 'sez' row's
  -- "was this genuinely zero-tax" fact can be checked (see header). A plain
  -- 'export_lut' voucher always nets to zero here too — asserting nothing,
  -- just reading back what create_invoice already posted.
  out_tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'output_cgst' then e.credit_amount - e.debit_amount else 0 end)
         + sum(case when m.purpose = 'output_sgst' then e.credit_amount - e.debit_amount else 0 end)
         + sum(case when m.purpose = 'output_igst' then e.credit_amount - e.debit_amount else 0 end)
         + sum(case when m.purpose = 'output_cess' then e.credit_amount - e.debit_amount else 0 end) as total_tax
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
      join reg_vouchers_out rv on rv.id = e.voucher_id
     where e.company_id = p_company_id
       and m.purpose in ('output_cgst', 'output_sgst', 'output_igst', 'output_cess')
     group by e.voucher_id
  ),
  zero_rated_lines as (
    select
      rv.voucher_type,
      rv.supply_type,
      i.item_type,
      vi.amount
      from public.voucher_items vi
      join reg_vouchers_out rv on rv.id = vi.voucher_id
      join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
      left join out_tax t on t.voucher_id = rv.id
     where vi.company_id = p_company_id
       and (rv.supply_type = 'export_lut'
            or (rv.supply_type = 'sez' and coalesce(t.total_tax, 0) = 0))
  ),
  zero_rated as (
    select
      coalesce(sum(case when supply_type = 'export_lut' then
        (case when voucher_type = 'credit_note' then -amount else amount end) else 0 end), 0) as export_lut,
      coalesce(sum(case when supply_type = 'sez' then
        (case when voucher_type = 'credit_note' then -amount else amount end) else 0 end), 0) as sez_zero_tax,
      coalesce(sum(case when item_type = 'goods' then
        (case when voucher_type = 'credit_note' then -amount else amount end) else 0 end), 0) as goods_turnover,
      coalesce(sum(case when item_type = 'service' then
        (case when voucher_type = 'credit_note' then -amount else amount end) else 0 end), 0) as services_turnover
      from zero_rated_lines
  ),
  -- Net ITC: eligible input tax on 'taxable' purchases only (T2+T3 excluded,
  -- same apportion-by-value-share technique 0082/0104 use), for THIS
  -- registration. See header for what this cannot exclude (capital goods).
  reg_vouchers_in as (
    select v.id
      from public.vouchers v
     where v.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_type in ('purchase', 'debit_note')
       and v.voucher_date between p_period_start and p_period_end
       and (p_gst_registration_id is null
            or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
  ),
  input_tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'input_cgst' then e.debit_amount - e.credit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'input_sgst' then e.debit_amount - e.credit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'input_igst' then e.debit_amount - e.credit_amount else 0 end) as igst,
           sum(case when m.purpose = 'input_cess' then e.debit_amount - e.credit_amount else 0 end) as cess
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
      join reg_vouchers_in iv on iv.id = e.voucher_id
     where e.company_id = p_company_id
       and m.purpose in ('input_cgst', 'input_sgst', 'input_igst', 'input_cess')
     group by e.voucher_id
  ),
  input_lines as (
    select
      vi.voucher_id,
      coalesce(sum(vi.amount), 0) as line_total,
      coalesce(sum(vi.amount) filter (
        where i.itc_eligibility = 'eligible' and i.supply_nature = 'taxable'
      ), 0) as net_value
      from public.voucher_items vi
      join reg_vouchers_in iv on iv.id = vi.voucher_id
      join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
     where vi.company_id = p_company_id
     group by vi.voucher_id
  ),
  net_itc_split as (
    select
      case when l.line_total = 0 then 0 else l.net_value / l.line_total end as net_share,
      coalesce(t.cgst, 0) as cgst, coalesce(t.sgst, 0) as sgst,
      coalesce(t.igst, 0) as igst, coalesce(t.cess, 0) as cess
      from input_lines l
      left join input_tax t on t.voucher_id = l.voucher_id
  ),
  net_itc_agg as (
    select
      coalesce(sum(net_share * cgst), 0) as cgst,
      coalesce(sum(net_share * sgst), 0) as sgst,
      coalesce(sum(net_share * igst), 0) as igst,
      coalesce(sum(net_share * cess), 0) as cess,
      coalesce(sum((1 - net_share) * (cgst + sgst + igst + cess)), 0) as excluded
      from net_itc_split
  ),
  -- F and E for THIS registration only — same items.supply_nature split
  -- 0104's Rule 42 report uses company-wide; filtered here per-registration.
  sales_lines as (
    select
      rv.voucher_type,
      i.supply_nature,
      vi.amount
      from public.voucher_items vi
      join reg_vouchers_out rv on rv.id = vi.voucher_id
      join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
     where vi.company_id = p_company_id
  ),
  turnover as (
    select
      coalesce(sum(case when voucher_type = 'credit_note' then -amount else amount end), 0) as total_turnover,
      coalesce(sum(
        case when voucher_type = 'credit_note' then -amount else amount end
      ) filter (where supply_nature in ('nil_rated', 'exempt', 'non_gst')), 0) as exempt_turnover
      from sales_lines
  )
  select
    round(z.export_lut, 2),
    round(z.sez_zero_tax, 2),
    round(z.goods_turnover, 2),
    round(z.services_turnover, 2),
    round(z.export_lut + z.sez_zero_tax, 2),
    round(n.cgst + n.sgst + n.igst + n.cess, 2),
    round(n.cgst, 2),
    round(n.sgst, 2),
    round(n.igst, 2),
    round(n.cess, 2),
    round(n.excluded, 2),
    round(t.total_turnover, 2),
    round(t.exempt_turnover, 2),
    round(t.total_turnover - t.exempt_turnover, 2),
    round(
      case when (t.total_turnover - t.exempt_turnover) = 0 then 0
        else (z.export_lut + z.sez_zero_tax) * (n.cgst + n.sgst + n.igst + n.cess)
             / (t.total_turnover - t.exempt_turnover)
      end, 2)
    from zero_rated z, net_itc_agg n, turnover t;
$fn$;

revoke all on function public.get_gst_refund_rule89_4(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gst_refund_rule89_4(uuid, uuid, date, date) to authenticated;

comment on function public.get_gst_refund_rule89_4(uuid, uuid, date, date) is
  'Rule 89(4) refund of unutilised ITC on zero-rated supply made under LUT (no tax paid): Refund = zero-rated turnover x Net ITC / Adjusted Total Turnover, for one GST registration and period. Zero-rated turnover = export_lut vouchers + sez vouchers that actually posted zero tax (derived from postings, not guessed — see migration header). Net ITC excludes Sec 17(5)-blocked and exempt-linked (T2/T3) credit but CANNOT exclude capital-goods ITC (no schema flag). Uses invoice value as a proxy for both the goods turnover''s 1.5x-domestic-value cap and the services turnover''s payment-realisation basis — neither statutory refinement is applied. Prep data for RFD-01, not a claim-ready or portal-integrated figure. See 0122.';


-- ----------------------------------------------------------------------------
-- get_gst_refund_rule89_5 — inverted duty structure, maximum refund amount
-- ----------------------------------------------------------------------------
create or replace function public.get_gst_refund_rule89_5(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  aggregate_input_rate_percent numeric,      -- Net ITC / eligible-taxable input value, this registration
  eligible_input_taxable_value numeric,      -- the rate's own denominator
  inverted_rated_turnover numeric,           -- APPROXIMATE — see migration header
  tax_payable_on_inverted_turnover numeric,
  tax_payable_cgst numeric,
  tax_payable_sgst numeric,
  tax_payable_igst numeric,
  tax_payable_cess numeric,
  net_itc numeric,
  net_itc_cgst numeric,
  net_itc_sgst numeric,
  net_itc_igst numeric,
  net_itc_cess numeric,
  itc_availed_on_inputs_and_services numeric, -- see header: identical to net_itc in this app (no 4A/4B tracking)
  total_turnover numeric,
  exempt_turnover numeric,
  adjusted_total_turnover numeric,
  refund_amount numeric                       -- the formula's own "Maximum Refund Amount"; negative = nil refund
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  with reg_vouchers_in as (
    select v.id
      from public.vouchers v
     where v.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_type in ('purchase', 'debit_note')
       and v.voucher_date between p_period_start and p_period_end
       and (p_gst_registration_id is null
            or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
  ),
  input_tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'input_cgst' then e.debit_amount - e.credit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'input_sgst' then e.debit_amount - e.credit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'input_igst' then e.debit_amount - e.credit_amount else 0 end) as igst,
           sum(case when m.purpose = 'input_cess' then e.debit_amount - e.credit_amount else 0 end) as cess
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
      join reg_vouchers_in iv on iv.id = e.voucher_id
     where e.company_id = p_company_id
       and m.purpose in ('input_cgst', 'input_sgst', 'input_igst', 'input_cess')
     group by e.voucher_id
  ),
  input_lines as (
    select
      vi.voucher_id,
      coalesce(sum(vi.amount), 0) as line_total,
      coalesce(sum(vi.amount) filter (
        where i.itc_eligibility = 'eligible' and i.supply_nature = 'taxable'
      ), 0) as net_value
      from public.voucher_items vi
      join reg_vouchers_in iv on iv.id = vi.voucher_id
      join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
     where vi.company_id = p_company_id
     group by vi.voucher_id
  ),
  net_itc_split as (
    select
      case when l.line_total = 0 then 0 else l.net_value / l.line_total end as net_share,
      l.net_value,
      coalesce(t.cgst, 0) as cgst, coalesce(t.sgst, 0) as sgst,
      coalesce(t.igst, 0) as igst, coalesce(t.cess, 0) as cess
      from input_lines l
      left join input_tax t on t.voucher_id = l.voucher_id
  ),
  net_itc_agg as (
    select
      coalesce(sum(net_share * cgst), 0) as cgst,
      coalesce(sum(net_share * sgst), 0) as sgst,
      coalesce(sum(net_share * igst), 0) as igst,
      coalesce(sum(net_share * cess), 0) as cess,
      coalesce(sum(net_value), 0) as eligible_taxable_value
      from net_itc_split
  ),
  -- Rule 89(5) candidate pool: ordinary domestic sales/credit notes only
  -- (zero-rated and deemed-export excluded — already refunded, if at all,
  -- via Rule 89(4) or the tax-paid route, see header), taxable output items
  -- only (Sec 54(3)'s own proviso excludes nil-rated/fully-exempt output).
  reg_vouchers_out as (
    select v.id, v.voucher_type
      from public.vouchers v
     where v.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_type in ('sales', 'credit_note')
       and v.supply_type in ('intra', 'inter')
       and v.voucher_date between p_period_start and p_period_end
       and (p_gst_registration_id is null
            or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
  ),
  out_tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'output_cgst' then e.credit_amount - e.debit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'output_sgst' then e.credit_amount - e.debit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'output_igst' then e.credit_amount - e.debit_amount else 0 end) as igst,
           sum(case when m.purpose = 'output_cess' then e.credit_amount - e.debit_amount else 0 end) as cess
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
      join reg_vouchers_out rv on rv.id = e.voucher_id
     where e.company_id = p_company_id
       and m.purpose in ('output_cgst', 'output_sgst', 'output_igst', 'output_cess')
     group by e.voucher_id
  ),
  out_items as (
    select distinct vi.item_id, i.gst_rate_percent
      from public.voucher_items vi
      join reg_vouchers_out rv on rv.id = vi.voucher_id
      join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
     where vi.company_id = p_company_id
       and i.supply_nature = 'taxable'
  ),
  -- Each voucher's own taxable-value total, for apportioning that voucher's
  -- posted tax across its (possibly mixed) item lines by value share — same
  -- technique as 0082/0104, applied at voucher grain since tax is posted
  -- per voucher, not per item.
  voucher_totals as (
    select rv.id as voucher_id, coalesce(sum(vi.amount), 0) as line_total
      from public.voucher_items vi
      join reg_vouchers_out rv on rv.id = vi.voucher_id
     where vi.company_id = p_company_id
     group by rv.id
  ),
  rate as (
    select case when eligible_taxable_value = 0 then 0
                else (cgst + sgst + igst + cess) / eligible_taxable_value * 100 end as pct
      from net_itc_agg
  ),
  flagged_items as (
    select oi.item_id
      from out_items oi, rate r
     where oi.gst_rate_percent < r.pct
  ),
  flagged_lines as (
    select
      vi.voucher_id, rv.voucher_type, vi.amount
      from public.voucher_items vi
      join reg_vouchers_out rv on rv.id = vi.voucher_id
      join flagged_items fi on fi.item_id = vi.item_id
     where vi.company_id = p_company_id
  ),
  flagged_turnover as (
    select coalesce(sum(
      case when voucher_type = 'credit_note' then -amount else amount end
    ), 0) as turnover
      from flagged_lines
  ),
  flagged_tax as (
    select
      coalesce(sum(fl.amount / nullif(vt.line_total, 0) * ot.cgst) filter (where fl.voucher_type = 'sales'), 0)
      - coalesce(sum(fl.amount / nullif(vt.line_total, 0) * ot.cgst) filter (where fl.voucher_type = 'credit_note'), 0) as cgst,
      coalesce(sum(fl.amount / nullif(vt.line_total, 0) * ot.sgst) filter (where fl.voucher_type = 'sales'), 0)
      - coalesce(sum(fl.amount / nullif(vt.line_total, 0) * ot.sgst) filter (where fl.voucher_type = 'credit_note'), 0) as sgst,
      coalesce(sum(fl.amount / nullif(vt.line_total, 0) * ot.igst) filter (where fl.voucher_type = 'sales'), 0)
      - coalesce(sum(fl.amount / nullif(vt.line_total, 0) * ot.igst) filter (where fl.voucher_type = 'credit_note'), 0) as igst,
      coalesce(sum(fl.amount / nullif(vt.line_total, 0) * ot.cess) filter (where fl.voucher_type = 'sales'), 0)
      - coalesce(sum(fl.amount / nullif(vt.line_total, 0) * ot.cess) filter (where fl.voucher_type = 'credit_note'), 0) as cess
      from flagged_lines fl
      join voucher_totals vt on vt.voucher_id = fl.voucher_id
      left join out_tax ot on ot.voucher_id = fl.voucher_id
  ),
  -- F and E, this registration, same as get_gst_refund_rule89_4 (see that
  -- function and this migration's header for why they are computed twice).
  all_out_vouchers as (
    select v.id, v.voucher_type
      from public.vouchers v
     where v.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_type in ('sales', 'credit_note')
       and v.voucher_date between p_period_start and p_period_end
       and (p_gst_registration_id is null
            or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
  ),
  sales_lines as (
    select
      av.voucher_type,
      i.supply_nature,
      vi.amount
      from public.voucher_items vi
      join all_out_vouchers av on av.id = vi.voucher_id
      join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
     where vi.company_id = p_company_id
  ),
  turnover as (
    select
      coalesce(sum(case when voucher_type = 'credit_note' then -amount else amount end), 0) as total_turnover,
      coalesce(sum(
        case when voucher_type = 'credit_note' then -amount else amount end
      ) filter (where supply_nature in ('nil_rated', 'exempt', 'non_gst')), 0) as exempt_turnover
      from sales_lines
  )
  select
    round(r.pct, 4),
    round(n.eligible_taxable_value, 2),
    round(ft.turnover, 2),
    round(fx.cgst + fx.sgst + fx.igst + fx.cess, 2),
    round(fx.cgst, 2),
    round(fx.sgst, 2),
    round(fx.igst, 2),
    round(fx.cess, 2),
    round(n.cgst + n.sgst + n.igst + n.cess, 2),
    round(n.cgst, 2),
    round(n.sgst, 2),
    round(n.igst, 2),
    round(n.cess, 2),
    -- Same value as net_itc — see migration header: this app has no 4A/4B
    -- tracking to make Net ITC any smaller than total eligible ITC availed
    -- on inputs and input services, so the ratio the amended formula applies
    -- is always exactly 1 here. Computed from the same source, not hard-
    -- coded, so a future 4A/4B feature would make the two diverge correctly.
    round(n.cgst + n.sgst + n.igst + n.cess, 2),
    round(t.total_turnover, 2),
    round(t.exempt_turnover, 2),
    round(t.total_turnover - t.exempt_turnover, 2),
    round(
      case when (t.total_turnover - t.exempt_turnover) = 0 then 0
        else ft.turnover * (n.cgst + n.sgst + n.igst + n.cess) / (t.total_turnover - t.exempt_turnover)
      end
      - (fx.cgst + fx.sgst + fx.igst + fx.cess), 2)
    from net_itc_agg n, rate r, flagged_turnover ft, flagged_tax fx, turnover t;
$fn$;

revoke all on function public.get_gst_refund_rule89_5(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gst_refund_rule89_5(uuid, uuid, date, date) to authenticated;

comment on function public.get_gst_refund_rule89_5(uuid, uuid, date, date) is
  'Rule 89(5) maximum refund amount for inverted duty structure, for one GST registration and period. APPROXIMATION, not claim-ready: this schema has no per-transaction link from a specific output sale back to the specific rated inputs that fed it (bill_of_materials is a standard recipe, not a transaction genealogy — see migration header), so an output item is flagged only when its OWN gst_rate_percent is below the period''s AGGREGATE eligible-input effective rate. Excludes zero-rated/deemed-export turnover (refunded, if at all, via Rule 89(4) or the tax-paid route) and nil-rated/fully-exempt output (excluded by Sec 54(3)''s own proviso, not this schema''s choice). Net ITC / Adjusted Total Turnover computed identically to get_gst_refund_rule89_4 per Rule 89(5)''s own cross-reference to sub-rule (4). Prep data for RFD-01 only. See 0122.';


-- ----------------------------------------------------------------------------
-- get_gst_refund_rule89_5_items — supporting per-item detail for the report
-- page's table. Same classification as get_gst_refund_rule89_5, at item
-- grain instead of summed, so a preparer can see WHICH items were flagged
-- and why before trusting the headline total.
-- ----------------------------------------------------------------------------
create or replace function public.get_gst_refund_rule89_5_items(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  item_id uuid,
  item_name text,
  hsn_sac text,
  output_gst_rate_percent numeric,
  taxable_turnover numeric,
  is_flagged_inverted_rated boolean
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  with reg_vouchers_in as (
    select v.id
      from public.vouchers v
     where v.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_type in ('purchase', 'debit_note')
       and v.voucher_date between p_period_start and p_period_end
       and (p_gst_registration_id is null
            or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
  ),
  input_tax as (
    select e.voucher_id,
           sum(case when m.purpose in ('input_cgst','input_sgst','input_igst','input_cess')
                    then e.debit_amount - e.credit_amount else 0 end) as tax
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
      join reg_vouchers_in iv on iv.id = e.voucher_id
     where e.company_id = p_company_id
       and m.purpose in ('input_cgst', 'input_sgst', 'input_igst', 'input_cess')
     group by e.voucher_id
  ),
  input_lines as (
    select
      vi.voucher_id,
      coalesce(sum(vi.amount), 0) as line_total,
      coalesce(sum(vi.amount) filter (
        where i.itc_eligibility = 'eligible' and i.supply_nature = 'taxable'
      ), 0) as net_value
      from public.voucher_items vi
      join reg_vouchers_in iv on iv.id = vi.voucher_id
      join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
     where vi.company_id = p_company_id
     group by vi.voucher_id
  ),
  rate as (
    select case when sum(l.net_value) = 0 then 0
      else sum(case when l.line_total = 0 then 0 else (l.net_value / l.line_total) * coalesce(t.tax, 0) end)
           / sum(l.net_value) * 100
      end as pct
      from input_lines l
      left join input_tax t on t.voucher_id = l.voucher_id
  ),
  reg_vouchers_out as (
    select v.id, v.voucher_type
      from public.vouchers v
     where v.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_type in ('sales', 'credit_note')
       and v.supply_type in ('intra', 'inter')
       and v.voucher_date between p_period_start and p_period_end
       and (p_gst_registration_id is null
            or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
  )
  select
    i.id,
    i.name,
    i.hsn_sac,
    i.gst_rate_percent,
    round(coalesce(sum(
      case when rv.voucher_type = 'credit_note' then -vi.amount else vi.amount end
    ), 0), 2),
    i.gst_rate_percent < (select pct from rate)
    from public.voucher_items vi
    join reg_vouchers_out rv on rv.id = vi.voucher_id
    join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
   where vi.company_id = p_company_id
     and i.supply_nature = 'taxable'
   group by i.id, i.name, i.hsn_sac, i.gst_rate_percent
   order by i.gst_rate_percent asc, i.name;
$fn$;

revoke all on function public.get_gst_refund_rule89_5_items(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_gst_refund_rule89_5_items(uuid, uuid, date, date) to authenticated;

comment on function public.get_gst_refund_rule89_5_items(uuid, uuid, date, date) is
  'Per-item detail behind get_gst_refund_rule89_5: each domestic taxable output item sold in the period, its own GST rate, its net turnover, and whether it was flagged (its rate is below the period''s aggregate eligible-input rate). Report-page support only — same classification, item grain instead of summed. See 0122.';

notify pgrst, 'reload schema';
