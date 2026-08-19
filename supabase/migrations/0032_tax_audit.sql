-- ============================================================================
-- 0032 — Tax audit (P11): Sec 44AB applicability + scoped Form 3CD particulars
-- ============================================================================
-- The `tax_audit` module has had a due-date presence since 0024 (compliance
-- calendar's "Tax audit report (Form 3CA/3CB-3CD)" row) but that row is
-- gated only on the module being *active* — and tax_audit shares the same
-- broad activation predicate ({"compliance_mode":"compliance"}) as
-- compliance_calendar and income_tax, so it has always shown up for every
-- compliance-mode company regardless of whether that company's turnover
-- actually crosses the Sec 44AB threshold. This migration adds the real
-- threshold check, plus a scoped slice of Form 3CD, without touching 0024's
-- calendar row — a company well under the threshold still sees the due date
-- as a heads-up (correct: better an unneeded reminder than a missed one),
-- and can now also see get_tax_audit_applicability say clearly that no
-- audit is actually required.
--
-- WHICH LAW GOVERNS THIS FEATURE — same framing as 0026 (income tax
-- computation), repeated here so this migration isn't "corrected" backwards
-- later. For AY 2026-27 (FY 2025-26 income, the year this app's "today" of
-- 19 Aug 2026 sits inside), the OPERATIVE citations are the Income-tax Act
-- 1961's — Sec 44AB, Sec 40(b)/40(ba), Sec 43B, Form 3CA/3CB/3CD (Rule 6G)
-- — not the Income-tax Act 2025's renumbered ones, which only govern income
-- earned from 1 April 2026 (Tax Year 2026-27, first filed 2027).
--
-- 44AB THRESHOLDS MODELLED (researched fresh, not carried from memory):
--   Business (Sec 44AB(a)): turnover > Rs 1,00,00,000, enhanced to
--     Rs 10,00,00,000 when cash receipts AND cash payments are each within
--     5% of their respective totals (both conditions, not either).
--   Profession (Sec 44AB(b)): gross receipts > Rs 50,00,000, flat — no
--     cash-mode enhancement applies to professions.
-- These are the current, Finance Act-amended thresholds for AY 2026-27, not
-- the original 1961-Act figures.
--
-- TURNOVER, DELIBERATELY NARROWER THAN get_income_tax_computation's income
-- base: only account_groups.nature = 'direct_income' (operating/trading
-- revenue) counts as "turnover" for the 44AB threshold — 0026's book_profit
-- correctly includes indirect_income too (other income belongs in taxable
-- income) but Sec 44AB's own turnover test does not. Two different
-- questions sharing ledger data, not a discrepancy to reconcile.
--
-- CASH-TRANSACTION TEST: identifies the "Cash-in-Hand" sub-ledger group by
-- its seeded NAME, not by ledger_role — Cash-in-Hand and Bank Accounts both
-- carry ledger_role='cash_bank' (0006/0030's own shared convention), and
-- there is no finer-grained role to distinguish them. seed_chart_of_accounts
-- documents that sub-group as "deletable and renameable" — a company that
-- has renamed its seeded Cash-in-Hand group gets a silently understated
-- cash percentage here (reading as 0% cash, pushing toward the enhanced
-- Rs 10 crore threshold even if the renamed ledger is doing heavy cash
-- traffic). Flagged in the `reason` text whenever turnover is nonzero but
-- both cash percentages read exactly 0 — the one shape this specific
-- failure mode produces that a genuinely all-digital company is unlikely to
-- hit by chance.
--
-- NOT MODELLED — deliberate v1 cuts, each because the schema does not track
-- the underlying fact, same discipline as 0026:
--   * Sec 44AB(e) — the presumptive-opt-out trap (declaring profit below
--     the 44AD/44ADA presumptive rate while total income exceeds the basic
--     exemption limit forces an audit regardless of turnover, and bars
--     re-entry to the presumptive scheme for 5 assessment years). LEKHA
--     does not track whether a company has ever elected 44AD/44ADA.
--   * Form 3CA vs 3CB for LLPs specifically: ref_entity_types already
--     encodes this as '3ca_or_3cb' rather than picking one — it genuinely
--     depends on whether the LLP was ALSO audited under the LLP Act 2008
--     (turnover > Rs 40 lakh or contribution > Rs 25 lakh, a DIFFERENT
--     threshold from 44AB's), which this schema does not track. Surfaced
--     as-is, not guessed.
--   * Form 3CD: 44 clauses exist; six are auto-filled below (13(a), 14(a),
--     18, 21(c), 26, 34(a)) because LEKHA already computes or stores the
--     underlying figure for another feature this session. The remaining
--     ~38 — related-party register, loans/deposits under 269SS/269T, Sec
--     40A(3) cash-payment disallowance, general (non-MSME) Sec 43B items,
--     quantitative stock reconciliation, GST-turnover reconciliation under
--     clause 44, and more — need data this schema does not hold at the
--     right grain. The report page lists them as "prepare manually", not
--     silently omits them.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- companies.is_professional
-- ----------------------------------------------------------------------------
alter table public.companies
  add column is_professional boolean not null default false;

comment on column public.companies.is_professional is
  'Whether this company''s income is a Sec 44AA "specified profession" (legal, medical, engineering, architectural, accountancy, technical consultancy, interior decoration, company secretary, IT, etc.) rather than a business, for Sec 44AB threshold purposes. Only meaningful for proprietorship/partnership/llp/huf — get_tax_audit_applicability ignores this flag for company entity types (opc/pvt_ltd/ltd), which are always business turnover-based. true selects the flat Rs 50 lakh threshold; false selects the turnover-based Rs 1 crore/10 crore business threshold.';


-- ----------------------------------------------------------------------------
-- get_tax_audit_applicability(company, fy_start, fy_end)
-- ----------------------------------------------------------------------------
create or replace function public.get_tax_audit_applicability(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  entity_type text,
  is_professional boolean,
  turnover numeric,
  cash_receipts numeric,
  cash_payments numeric,
  total_receipts numeric,
  total_payments numeric,
  cash_receipt_percent numeric,
  cash_payment_percent numeric,
  threshold_used numeric,
  audit_required boolean,
  report_form text,
  due_date date,
  reason text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_entity_type text;
  v_is_professional boolean;
  v_turnover numeric := 0;
  v_cash_recv numeric := 0;
  v_cash_pay numeric := 0;
  v_total_recv numeric := 0;
  v_total_pay numeric := 0;
  v_cash_recv_pct numeric := 0;
  v_cash_pay_pct numeric := 0;
  v_threshold numeric;
  v_reason text;
begin
  select c.entity_type, c.is_professional into v_entity_type, v_is_professional
    from public.companies c
   where c.id = p_company_id;

  if v_entity_type is null then
    return;
  end if;

  -- Turnover: net credit movement on direct-income ledgers only — see the
  -- migration header for why this is narrower than get_income_tax_
  -- computation's book-profit income base.
  select coalesce(sum(e.credit_amount - e.debit_amount), 0) into v_turnover
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    join public.voucher_entries e on e.ledger_id = l.id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where l.company_id = p_company_id
     and g.nature = 'direct_income'
     and v.voucher_date between p_fy_start and p_fy_end;

  -- Cash vs total receipts/payments — gross debit and gross credit summed
  -- separately (NOT netted), since the 5% test compares gross cash flow to
  -- gross total flow, not a net movement.
  select
      coalesce(sum(case when g.name = 'Cash-in-Hand' then e.debit_amount else 0 end), 0),
      coalesce(sum(case when g.name = 'Cash-in-Hand' then e.credit_amount else 0 end), 0),
      coalesce(sum(e.debit_amount), 0),
      coalesce(sum(e.credit_amount), 0)
    into v_cash_recv, v_cash_pay, v_total_recv, v_total_pay
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    join public.voucher_entries e on e.ledger_id = l.id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where l.company_id = p_company_id
     and g.ledger_role = 'cash_bank'
     and v.voucher_date between p_fy_start and p_fy_end;

  if v_total_recv > 0 then
    v_cash_recv_pct := round(v_cash_recv / v_total_recv * 100, 2);
  end if;
  if v_total_pay > 0 then
    v_cash_pay_pct := round(v_cash_pay / v_total_pay * 100, 2);
  end if;

  if v_is_professional then
    v_threshold := 5000000;
    v_reason := 'Professional gross receipts threshold (Sec 44AB(b)): Rs 50,00,000 flat — no cash-transaction enhancement applies to professions.';
  elsif v_cash_recv_pct <= 5 and v_cash_pay_pct <= 5 then
    v_threshold := 100000000;
    v_reason := 'Business turnover threshold enhanced to Rs 10,00,00,000 (Sec 44AB(a) proviso): cash receipts and cash payments are each within 5% of their totals.';
  else
    v_threshold := 10000000;
    v_reason := 'Standard business turnover threshold: Rs 1,00,00,000 (Sec 44AB(a)) — cash receipts or cash payments exceed 5% of the total, so the enhanced Rs 10 crore threshold does not apply.';
  end if;

  if v_turnover != 0 and v_cash_recv_pct = 0 and v_cash_pay_pct = 0 then
    v_reason := v_reason || ' Both cash percentages read exactly 0% — confirm the seeded "Cash-in-Hand" ledger group has not been renamed; this check identifies it by name and silently reads 0% cash for a renamed group.';
  end if;

  v_reason := v_reason || ' Sec 44AB(e) presumptive-scheme opt-out (declaring profit below the 44AD/44ADA rate while total income exceeds the basic exemption limit) is not evaluated — LEKHA does not track presumptive-scheme election. If this company has ever used 44AD/44ADA, confirm that trigger separately.';

  entity_type := v_entity_type;
  is_professional := v_is_professional;
  turnover := round(v_turnover, 2);
  cash_receipts := round(v_cash_recv, 2);
  cash_payments := round(v_cash_pay, 2);
  total_receipts := round(v_total_recv, 2);
  total_payments := round(v_total_pay, 2);
  cash_receipt_percent := v_cash_recv_pct;
  cash_payment_percent := v_cash_pay_pct;
  threshold_used := v_threshold;
  audit_required := v_turnover > v_threshold;
  select ret.tax_audit_report_form into report_form from public.ref_entity_types ret where ret.code = v_entity_type;
  due_date := make_date(extract(year from p_fy_end)::int, 9, 30);
  reason := v_reason;
  return next;
end;
$$;

comment on function public.get_tax_audit_applicability is
  'Sec 44AB tax audit applicability for one company/period: turnover, the cash-receipt/cash-payment percentages that decide which threshold applies, whether audit is required, which report form (Form 3CA vs 3CB, from ref_entity_types) and the 30 September due date. See the migration header for the deliberately uncomputed Sec 44AB(e) presumptive-opt-out trigger.';


-- ----------------------------------------------------------------------------
-- get_form_3cd_particulars(company, fy_start, fy_end)
-- One row per auto-fillable clause. plpgsql with a sequence of `return next`
-- calls rather than a UNION ALL — each clause pulls from a different
-- existing function/column and mixes numeric and text values, which reads
-- more clearly as named variables than as six differently-shaped subqueries
-- unioned together.
-- ----------------------------------------------------------------------------
create or replace function public.get_form_3cd_particulars(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  clause text,
  title text,
  value_type text,
  value_numeric numeric,
  value_text text,
  source_note text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_valuation text;
  v_tax_dep numeric := 0;
  v_remun_disallowed numeric := 0;
  v_msme_addback numeric := 0;
  v_tds_deducted numeric := 0;
  v_tcs_collected numeric := 0;
begin
  select c.inventory_valuation_method into v_valuation
    from public.companies c where c.id = p_company_id;

  select coalesce(sum(b.depreciation_for_year), 0) into v_tax_dep
    from public.get_tax_depreciation_blocks(p_company_id, p_fy_start, p_fy_end) b;

  select coalesce(t.partner_remuneration_disallowed, 0), coalesce(t.msme_disallowance_addback, 0)
    into v_remun_disallowed, v_msme_addback
    from public.get_income_tax_computation(p_company_id, p_fy_start, p_fy_end) t;

  select coalesce(sum(e.credit_amount - e.debit_amount), 0) into v_tds_deducted
    from public.tax_ledger_map m
    join public.voucher_entries e on e.ledger_id = m.ledger_id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where m.company_id = p_company_id
     and m.gst_registration_id is null
     and m.purpose = 'tds_payable'
     and v.voucher_date between p_fy_start and p_fy_end;

  select coalesce(sum(e.credit_amount - e.debit_amount), 0) into v_tcs_collected
    from public.tax_ledger_map m
    join public.voucher_entries e on e.ledger_id = m.ledger_id
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
   where m.company_id = p_company_id
     and m.gst_registration_id is null
     and m.purpose = 'output_tcs'
     and v.voucher_date between p_fy_start and p_fy_end;

  clause := '13(a)'; title := 'Method of accounting employed';
  value_type := 'text'; value_numeric := null;
  value_text := 'Mercantile (accrual)';
  source_note := 'Every voucher in this system posts on accrual — there is no cash-basis posting mode to report instead.';
  return next;

  clause := '14(a)'; title := 'Method of valuation of closing stock';
  value_type := 'text'; value_numeric := null;
  value_text := case v_valuation when 'fifo' then 'FIFO' else 'Weighted average' end;
  source_note := 'From Settings' || chr(39) || 's inventory valuation method. Only meaningful if the inventory module is active for this company.';
  return next;

  clause := '18'; title := 'Depreciation admissible under the Income-tax Act';
  value_type := 'amount'; value_numeric := round(v_tax_dep, 2); value_text := null;
  source_note := 'Sum of depreciation_for_year across every block for the period — see the Tax depreciation report for the block-wise break-up this total is built from.';
  return next;

  clause := '21(c)'; title := 'Amounts inadmissible under Sec 40(b)/40(ba) — partner/LLP remuneration';
  value_type := 'amount'; value_numeric := round(v_remun_disallowed, 2); value_text := null;
  source_note := 'Excess remuneration over the Sec 40(b) slab ceiling on ledgers flagged "Partner remuneration". Zero for entity types other than partnership/LLP, or if no ledger is so flagged.';
  return next;

  clause := '26'; title := 'Sec 43B — sums not paid before the due date (MSME dues only)';
  value_type := 'amount'; value_numeric := round(v_msme_addback, 2); value_text := null;
  source_note := 'Micro/small-supplier dues unpaid past their Sec 43B(h) deadline as at year end. General Sec 43B items — bonus, PF/ESI, GST, loan interest — are not tracked here and must be added manually.';
  return next;

  clause := '34(a)'; title := 'TDS deducted during the year, all sections combined';
  value_type := 'amount'; value_numeric := round(v_tds_deducted, 2); value_text := null;
  source_note := 'Net movement on the company' || chr(39) || 's TDS Payable ledger. Per-section, per-deductee, per-return (24Q/26Q/27Q) detail required for the actual clause is not broken out here — this is a total, not the filing-ready table.';
  return next;

  clause := '34(a)'; title := 'TCS collected during the year (Sec 206C specified goods)';
  value_type := 'amount'; value_numeric := round(v_tcs_collected, 2); value_text := null;
  source_note := 'Net movement on the company' || chr(39) || 's Output TCS ledger. Sec 206C(1H) (sale of goods generally) was repealed effective 1 April 2025 and is correctly excluded from this figure.';
  return next;

  return;
end;
$$;

comment on function public.get_form_3cd_particulars is
  'Six auto-fillable Form 3CD clauses (13(a), 14(a), 18, 21(c), 26, 34(a)) drawn from figures LEKHA already computes elsewhere. The remaining ~38 clauses are not covered — see the migration header for why each needs data this schema does not hold at the right grain.';
