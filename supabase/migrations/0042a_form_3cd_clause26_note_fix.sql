-- ============================================================================
-- 0042a — get_form_3cd_particulars: clause 26 note no longer accurate
-- ============================================================================
-- 0042 added get_general_sec43b_dues() for the general (non-MSME) Sec 43B
-- categories this note claimed weren't tracked. Text-only fix, same
-- function otherwise.
-- ============================================================================

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
  source_note := 'Micro/small-supplier dues unpaid past their Sec 43B(h) deadline as at year end. General (non-MSME) Sec 43B items — statutory dues, PF/gratuity, bonus, specified-lender interest, leave encashment — are covered separately below, on ledgers flagged with a Sec 43B category.';
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
  'Auto-fillable Form 3CD clauses (13(a), 14(a), 18, 21(c), 26, 34(a) x2) drawn from figures LEKHA already computes elsewhere. Clause 26 here is MSME dues only; general Sec 43B categories are in get_general_sec43b_dues (0042). Clauses 21(d), 23, 31 are separate functions, not this one — see the tax audit report page.';
