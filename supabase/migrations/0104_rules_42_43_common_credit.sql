-- ============================================================================
-- 0104 — CGST Rule 42: common-credit apportionment for exempt-supply use
-- ============================================================================
-- get_gst_input_register (0035) hands back every rupee of posted input tax
-- for a period as though all of it were freely claimable. It is not. Sec
-- 17(2) says a registered person making both taxable and exempt supplies may
-- take credit only to the extent attributable to the taxable ones, and Rule
-- 42 of the CGST Rules (a Rule made under Sec 17(2)/(6) — NOT the same
-- numeral as the now-omitted Sec 42 of the CGST ACT, which governed the old
-- GSTR-2/GSTR-3 invoice-matching mechanism and has nothing to do with this;
-- the coincidence of numbers is confusing enough that one secondary source
-- surfaced during this task's research had conflated the two) is the
-- mechanism that works out how much of a period's input tax on INPUTS and
-- INPUT SERVICES has to be reversed because it cannot be pinned to taxable
-- supply alone. Rule 43 is the parallel mechanic for CAPITAL GOODS, spread
-- over a deemed 60-month (5-year) useful life rather than reversed against
-- one period's turnover. This migration builds Rule 42 only — see
-- "SCOPE CUT: RULE 43" below for why, stated up front rather than discovered
-- by reading to the end.
--
-- THE FORMULA, confirmed live via WebSearch during this task against
-- multiple independent secondary sources (CaptainBiz, TaxGuru, IndiaFilings,
-- CAclubindia — bare-Rule text also located at taxinformation.cbic.gov.in)
-- rather than recalled from training data, because this is exactly the kind
-- of "obvious-looking formula" this codebase has been burned by getting
-- subtly wrong before:
--
--   T   = total input tax on inputs/input services for the tax period
--   T1  = credit used EXCLUSIVELY for non-business purposes
--   T2  = credit used EXCLUSIVELY for exempt supplies
--   T3  = credit blocked under Sec 17(5) (LEKHA already tracks this —
--         items.itc_eligibility, migration 0082)
--   T4  = credit used EXCLUSIVELY for taxable supplies, including zero-rated
--   C1  = T − (T1 + T2 + T3)              -- credited to the electronic ledger
--   C2  = C1 − T4                          -- the COMMON credit pool: this is
--                                              what Rule 42 actually apportions
--   E   = aggregate value of exempt supplies for the period
--   F   = total turnover for the period
--   D1  = (E / F) × C2                     -- reversed: attributable to exempt
--   D2  = 5% × C2                          -- reversed: deemed non-business use
--   C3  = C2 − D1 − D2                     -- common credit that SURVIVES
--
-- D2 IS NOT A BANKING-SPECIFIC FIGURE. It was worth a second, deliberately
-- skeptical search specifically because a flat 5% presumptive figure sounds
-- exactly like the kind of special-case number that turns out to be scoped
-- to one industry — and GST does have a real banking/NBFC special case
-- nearby, Rule 38, which lets a bank or financial institution elect to
-- reverse a flat 50% of ALL input tax monthly instead of running Rule 42/43
-- at all. But Rule 42(1)(j)'s D2 is a GENERAL provision — it applies to
-- EVERY registered person computing common credit under Rule 42, banking or
-- not, and exists because a business often cannot cleanly separate "used for
-- business" from "used partly for the proprietor's own purposes" the way it
-- can separate taxable from exempt. Rule 38 is not built here — it is a
-- taxpayer election that replaces Rule 42/43 entirely for the institutions
-- that opt into it, a different code path this migration does not attempt.
--
-- THE TWO-STAGE MECHANIC, and the deadline that is easy to get wrong. Rule
-- 42 is not a one-shot annual computation — it runs monthly, provisionally,
-- against that month's own E/F ratio and that month's own C2, with the
-- reversal added to output tax liability in that month's return. Then, by
-- Rule 42(2), the WHOLE THING is recomputed once for the full financial year
-- using the year's actual aggregate E and F and C2 (not a sum of the twelve
-- monthly figures — the annual ratio is generally NOT the average of the
-- monthly ratios), and any shortfall against what was reversed monthly must
-- be added to output tax liability, with interest under Sec 50(1), "before
-- the due date for furnishing of the return for the month of September
-- following the end of the financial year to which such credit relates" —
-- confirmed against the CBIC rule text itself, not just secondary
-- paraphrase. THIS DEADLINE IS SEPTEMBER, NOT NOVEMBER, and that distinction
-- is exactly the trap this task's brief warned about: Sec 16(4)'s time limit
-- for AVAILING fresh ITC was extended from September to 30 November by the
-- Finance Act 2022 (effective 1 Oct 2022), and it is tempting to assume
-- Rule 42(2)'s annual TRUE-UP deadline moved with it. It did not — Rule
-- 42(2) still names September in its own text. Sec 16(4) (can I still claim
-- this credit at all) and Rule 42(2) (how much of what I already claimed do
-- I have to give back) are two different clocks that happen to currently
-- point at two different months in the year following the one they govern.
--
-- HOW THIS MIGRATION SUPPORTS BOTH STAGES WITHOUT TWO FUNCTIONS. The
-- function below takes an arbitrary (p_period_start, p_period_end) and
-- computes E, F, C2, D1, D2 fresh for exactly that window — call it with one
-- month's bounds for the provisional monthly figure, or with a financial
-- year's bounds for the Rule 42(2) annual recomputation; the arithmetic is
-- identical, only the window differs, which matches how the Rule itself
-- describes the annual step ("in the manner specified in sub-rule (1)" with
-- year-long E/F substituted in). LEKHA does not store a running "reversed so
-- far this year" figure anywhere, so it cannot compute the September
-- SHORTFALL for you automatically — a preparer calling this function once
-- for the year and comparing the result to the sum of what was reversed
-- month by month is doing that comparison by hand. See scope_deferred.
--
-- THE MODELLING CHOICE THIS SCHEMA FORCES: NO PER-PURCHASE "WHAT WAS THIS
-- FOR" FLAG. Rule 42(1) is meant to be applied at INVOICE level, with the
-- taxpayer itself declaring which invoices are T1/T2/T3/T4 and which are
-- genuinely common. LEKHA records what was bought (a purchase voucher's
-- item lines, each pointing at an items row) but nothing about which output
-- stream that purchase served. The only signal available is items.
-- supply_nature (0081) on the PURCHASED item itself — taxable / nil_rated /
-- exempt / non_gst. This function uses that as the direct-attribution proxy
-- it is instructed to use, and states its limits plainly rather than
-- pretending to invoice-level precision the schema cannot deliver:
--
--   * A purchased item whose OWN supply_nature is nil_rated/exempt/non_gst
--     is treated as T2 (directly attributable to exempt supply, excluded
--     from the common pool entirely) — the trading-resale case: a business
--     buying an exempt/nil-rated good to resell it as-is.
--   * A purchased item whose itc_eligibility is 'blocked' (0082, Sec 17(5))
--     is treated as T3 and excluded the same way blocked credit already is
--     everywhere else in this codebase.
--   * EVERYTHING ELSE — every purchase of a 'taxable' item not otherwise
--     blocked — lands in the common pool C2, deliberately conservative per
--     this task's own instruction: this schema has no way to see that (say)
--     a specific taxable purchase was used EXCLUSIVELY for taxable output
--     (T4), so nothing is pulled out on that basis. The result is a C2 that
--     is a superset of the true common pool, and therefore a D1+D2 reversal
--     that is, if anything, an OVER-reversal relative to a business that
--     could show real T4 attribution — the safer direction for a report
--     that a preparer might otherwise skip Rule 42 arithmetic for entirely.
--
--   A STRUCTURAL CONSEQUENCE WORTH STATING OUTRIGHT: because 0081's own
--   CHECK constraint (items_non_taxable_has_no_rate) forbids a nil_rated,
--   exempt or non_gst item from carrying ANY gst_rate_percent above zero,
--   the T2 bucket computed here will read ₹0 on every purchase of such an
--   item — there was never any input tax posted on it to begin with, which
--   is correct (nothing to reverse on tax that was never claimed), not a
--   bug in this function. The scenario Rule 42 is actually FOR — a TAXABLE
--   input (packing material, freight, professional fees, common raw
--   material) consumed to produce or sell a DIFFERENT, exempt finished
--   good — cannot be caught by matching one item's own supply_nature to
--   itself, because the input item and the exempt output item are two
--   different items in the item master with no linkage this schema records
--   between them (no BOM-to-output wiring, no cost-centre-to-Rule-42
--   wiring). That credit will fall into the common pool C2 instead of being
--   excluded as T2 outright, and will only be PARTIALLY reversed via D1's
--   ratio rather than reversed in full. This is the honest limit of what
--   "cannot be directly attributed" can mean without a schema this app does
--   not have — stated here, not silently assumed away.
--
-- E AND F, AND WHY ZERO-RATED EXPORTS FALL OUT CORRECTLY FOR FREE. E is the
-- period's exempt turnover: sale/credit-note value of item lines whose
-- item.supply_nature is nil_rated, exempt or non_gst — the same three
-- categories 0081's own get_gstr1_table8 groups, and legally correct per
-- Sec 2(47) (exempt supply includes nil-rated and, via Sec 2(78), non-taxable
-- supply). F is total turnover: the same sale/credit-note value across EVERY
-- item, all four supply_nature values. Both are tax-exclusive (voucher_items.
-- amount, the taxable value before GST — matching Sec 2(112)'s own "turnover"
-- definition, which excludes CGST/SGST/IGST/cess). A zero-rated export or SEZ
-- supply of a 'taxable' item never lands in E, because 0081 deliberately did
-- NOT add a zero_rated value to items.supply_nature — that migration's own
-- header explains zero-rating is a property of the TRANSACTION (vouchers.
-- supply_type), not the item, precisely so a taxable item sold as an export
-- still reads as 'taxable' here. That is exactly the legal outcome Rule 42
-- needs: Sec 17(3)'s Explanation excludes zero-rated supplies from "exempt
-- supply" for ITC purposes, so an exporter is not penalised with a bigger
-- exempt ratio for having zero output tax on genuinely taxable exports. This
-- migration did not have to do anything extra to get that right — 0081
-- already made the correct call for an unrelated reason.
--
-- NOT PER-REGISTRATION. The signature this task specifies is (company,
-- period_start, period_end) — no GST registration filter, unlike 0035's
-- get_gst_input_register/get_gst_output_register which both take an
-- optional p_gst_registration_id. Rule 42's own F is technically "total
-- turnover IN THE STATE" — a multi-State registrant should run this per
-- GSTIN, not once across the whole company. This function computes at
-- company level, which is exactly right for a single-registration business
-- and an OVER-broad denominator for a multi-State one (the true value is
-- the company's turnover, but it will now be diluted across every state's
-- 'F' rather than each keeping its own — the E/F ratio for any one State
-- registration could differ, sometimes materially, from the company-wide
-- figure this returns). No company in this database currently holds more
-- than one GST registration, so this could not be verified against a real
-- multi-registration case; documented here and in caveats_for_integration
-- rather than silently built as if registration-level.
--
-- THE F = 0 EDGE CASE. Rule 42(1) itself has a proviso for a tax period with
-- no turnover at all: fall back to the last period for which E/F values are
-- available. This function does not implement that fallback — it is a
-- single-period report, not a stateful monthly tracker, and has no "last
-- period" to look back to without a table this migration does not add. When
-- F is 0 for the requested window, exempt_turnover_ratio is returned as 0
-- rather than null or an error, which understates D1 for that specific
-- window; a preparer hitting this edge case needs the fallback rule applied
-- by hand.
--
-- THIS IS A REPORT, NOT A POSTING RPC. Nothing here writes a reversal
-- journal entry, the same line every ITC-related report in this codebase
-- (itc-04-prep, itc-180day-reversal) has drawn: a Sec 17(5)/Rule 37/Rule 42
-- reversal is a real accounting entry (debit an expense or reversal ledger,
-- credit the relevant input tax ledger) that a preparer should review before
-- it is posted, not something this migration assumes the authority to
-- generate unattended. See scope_deferred for the natural next RPC.
--
-- SCOPE CUT: RULE 43. The task instructions name Rule 42 (inputs/input
-- services) as the priority and say to cut Rule 43 (capital goods, spread
-- over a 60-month useful-life convention) rather than ship a half-verified
-- version of both. Rule 43 needed its own careful verification — a
-- fixed-asset purchase's "life" bucketing, the 5-year taper, and how a
-- capital good's E/F ratio recomputation cascades across SIXTY separate
-- future tax periods are each a real piece of design this session did not
-- have room to hand-verify against live data the way Rule 42 is verified
-- below. Cut rather than shipped half-checked. See scope_deferred.
-- ============================================================================

drop function if exists public.get_common_credit_apportionment(uuid, date, date);

create function public.get_common_credit_apportionment(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  total_input_tax numeric,              -- T: all posted input tax in the window (purchase + debit note)
  blocked_itc numeric,                  -- T3: Sec 17(5) blocked (items.itc_eligibility = 'blocked')
  eligible_itc numeric,                 -- T minus T3
  exempt_linked_itc numeric,            -- T2 (proxy): directly attributable to exempt/nil-rated/non-GST purchases
  common_credit numeric,                -- C2: eligible_itc minus exempt_linked_itc — the apportioned pool
  common_credit_cgst numeric,
  common_credit_sgst numeric,
  common_credit_igst numeric,
  common_credit_cess numeric,
  exempt_turnover numeric,              -- E
  total_turnover numeric,               -- F
  exempt_turnover_ratio numeric,        -- E / F, 0 when F = 0 (see header)
  d1_reversal numeric,                  -- (E/F) x C2
  d2_reversal numeric,                  -- 5% x C2, deemed non-business use (Rule 42(1)(j), all taxpayers)
  total_reversal numeric,               -- D1 + D2
  reversal_cgst numeric,
  reversal_sgst numeric,
  reversal_igst numeric,
  reversal_cess numeric,
  net_common_credit_retained numeric    -- C3: C2 minus total_reversal
)
language sql
stable
security invoker
set search_path = ''
as $$
  with input_vouchers as (
    select v.id, v.voucher_type
      from public.vouchers v
     where v.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_type in ('purchase', 'debit_note')
       and v.voucher_date between p_period_start and p_period_end
  ),
  -- Tax as actually posted, per voucher, per head. debit_amount - credit_amount
  -- already carries the correct sign for a debit_note (a purchase return
  -- CREDITS the input tax ledger, so this comes out negative on its own —
  -- same reasoning 0035's get_gst_input_register relies on, no separate sign
  -- flip needed here).
  input_tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'input_cgst' then e.debit_amount - e.credit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'input_sgst' then e.debit_amount - e.credit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'input_igst' then e.debit_amount - e.credit_amount else 0 end) as igst,
           sum(case when m.purpose = 'input_cess' then e.debit_amount - e.credit_amount else 0 end) as cess
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
      join input_vouchers iv on iv.id = e.voucher_id
     where e.company_id = p_company_id
       and m.purpose in ('input_cgst', 'input_sgst', 'input_igst', 'input_cess')
     group by e.voucher_id
  ),
  -- Each purchase voucher's item lines split into the three mutually
  -- exclusive buckets described in the header: blocked (T3), exempt-linked
  -- (T2 proxy), everything else (feeds C2). itc_eligibility is checked
  -- first, same precedence 0082 uses, so a blocked item is never
  -- double-counted into the exempt bucket even if it also happens to be
  -- non-taxable.
  input_lines as (
    select
      vi.voucher_id,
      coalesce(sum(vi.amount), 0) as line_total,
      coalesce(sum(vi.amount) filter (where i.itc_eligibility = 'blocked'), 0) as blocked_value,
      coalesce(sum(vi.amount) filter (
        where i.itc_eligibility <> 'blocked' and i.supply_nature in ('nil_rated', 'exempt', 'non_gst')
      ), 0) as exempt_linked_value,
      coalesce(sum(vi.amount) filter (
        where i.itc_eligibility <> 'blocked' and i.supply_nature = 'taxable'
      ), 0) as common_value
      from public.voucher_items vi
      join input_vouchers iv on iv.id = vi.voucher_id
      join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
     where vi.company_id = p_company_id
     group by vi.voucher_id
  ),
  -- Apportion each voucher's real posted tax (per head) across the three
  -- buckets by each bucket's share of that voucher's own taxable value —
  -- the same value-share technique 0082 and 0098 already use elsewhere in
  -- this codebase, not a new method invented for this migration.
  split as (
    select
      l.voucher_id,
      case when l.line_total = 0 then 0 else l.blocked_value / l.line_total end as blocked_share,
      case when l.line_total = 0 then 0 else l.exempt_linked_value / l.line_total end as exempt_share,
      case when l.line_total = 0 then 0 else l.common_value / l.line_total end as common_share,
      coalesce(t.cgst, 0) as cgst, coalesce(t.sgst, 0) as sgst,
      coalesce(t.igst, 0) as igst, coalesce(t.cess, 0) as cess
      from input_lines l
      left join input_tax t on t.voucher_id = l.voucher_id
  ),
  -- coalesce to 0 on every column: split can be EMPTY (a period with no
  -- purchase/debit-note activity at all), and sum() over zero rows is NULL,
  -- not 0 — left unguarded, a quiet period would return a row of nulls
  -- instead of the all-zero result a report should show. Caught live during
  -- this migration's own verification (see report), not by inspection.
  bucketed as (
    select
      coalesce(sum(blocked_share * cgst), 0) as blocked_cgst,
      coalesce(sum(blocked_share * sgst), 0) as blocked_sgst,
      coalesce(sum(blocked_share * igst), 0) as blocked_igst,
      coalesce(sum(blocked_share * cess), 0) as blocked_cess,
      coalesce(sum(exempt_share * cgst), 0) as exempt_cgst,
      coalesce(sum(exempt_share * sgst), 0) as exempt_sgst,
      coalesce(sum(exempt_share * igst), 0) as exempt_igst,
      coalesce(sum(exempt_share * cess), 0) as exempt_cess,
      coalesce(sum(common_share * cgst), 0) as common_cgst,
      coalesce(sum(common_share * sgst), 0) as common_sgst,
      coalesce(sum(common_share * igst), 0) as common_igst,
      coalesce(sum(common_share * cess), 0) as common_cess
      from split
  ),
  -- Outward turnover: sales and credit notes in the window, item-level so
  -- each line's own supply_nature drives whether it counts toward E. Credit
  -- notes reduce turnover — same sign convention 0081's Table 8 and 0035's
  -- output register both use.
  sales_lines as (
    select
      v.voucher_type,
      i.supply_nature,
      vi.amount
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
      join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_type in ('sales', 'credit_note')
       and v.voucher_date between p_period_start and p_period_end
  ),
  turnover as (
    select
      coalesce(sum(
        (case when voucher_type = 'credit_note' then -amount else amount end)
      ) filter (where supply_nature in ('nil_rated', 'exempt', 'non_gst')), 0) as exempt_turnover,
      coalesce(sum(
        case when voucher_type = 'credit_note' then -amount else amount end
      ), 0) as total_turnover
      from sales_lines
  ),
  final as (
    select
      b.*,
      t.exempt_turnover,
      t.total_turnover,
      case when t.total_turnover = 0 then 0 else t.exempt_turnover / t.total_turnover end as ratio,
      (b.common_cgst + b.common_sgst + b.common_igst + b.common_cess) as common_credit
      from bucketed b, turnover t
  )
  select
    round(
      (common_cgst + common_sgst + common_igst + common_cess)
      + (blocked_cgst + blocked_sgst + blocked_igst + blocked_cess)
      + (exempt_cgst + exempt_sgst + exempt_igst + exempt_cess), 2
    ) as total_input_tax,
    round(blocked_cgst + blocked_sgst + blocked_igst + blocked_cess, 2) as blocked_itc,
    round(
      (common_cgst + common_sgst + common_igst + common_cess)
      + (exempt_cgst + exempt_sgst + exempt_igst + exempt_cess), 2
    ) as eligible_itc,
    round(exempt_cgst + exempt_sgst + exempt_igst + exempt_cess, 2) as exempt_linked_itc,
    round(common_credit, 2) as common_credit,
    round(common_cgst, 2) as common_credit_cgst,
    round(common_sgst, 2) as common_credit_sgst,
    round(common_igst, 2) as common_credit_igst,
    round(common_cess, 2) as common_credit_cess,
    round(exempt_turnover, 2) as exempt_turnover,
    round(total_turnover, 2) as total_turnover,
    round(ratio, 6) as exempt_turnover_ratio,
    round(ratio * common_credit, 2) as d1_reversal,
    round(0.05 * common_credit, 2) as d2_reversal,
    round((ratio + 0.05) * common_credit, 2) as total_reversal,
    round((ratio + 0.05) * common_cgst, 2) as reversal_cgst,
    round((ratio + 0.05) * common_sgst, 2) as reversal_sgst,
    round((ratio + 0.05) * common_igst, 2) as reversal_igst,
    round((ratio + 0.05) * common_cess, 2) as reversal_cess,
    round(common_credit - (ratio + 0.05) * common_credit, 2) as net_common_credit_retained
    from final;
$$;

revoke all on function public.get_common_credit_apportionment(uuid, date, date) from public, anon;
grant execute on function public.get_common_credit_apportionment(uuid, date, date) to authenticated;

comment on function public.get_common_credit_apportionment is
  'CGST Rule 42 common-credit apportionment for a period: total input tax (purchase + debit note), split into blocked (Sec 17(5), items.itc_eligibility), exempt-linked (items.supply_nature proxy for direct attribution to exempt supply — see migration header for what this can and cannot see), and the common pool C2. Exempt turnover ratio E/F computed from items.supply_nature on sales/credit notes in the same window. Returns D1 (ratio-based) and D2 (5% deemed non-business, Rule 42(1)(j), NOT a banking-specific figure) reversal, head-wise. Call once with a month''s bounds for the provisional monthly figure, once with a financial year''s bounds for the Rule 42(2) annual true-up (due by the September return following the FY — NOT the Sec 16(4) 30-November date, a different deadline). Report only — no posting RPC. Company-level, not per-GST-registration; Rule 42''s own F is technically per-State turnover. See 0104.';

notify pgrst, 'reload schema';
