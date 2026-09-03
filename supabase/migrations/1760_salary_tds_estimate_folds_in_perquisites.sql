-- ============================================================================
-- 1760 — Sec 192(1)/Sec 392(1) salary TDS: fold Sec 17(2) perquisites into
--        the estimated income before applying slabs, not never
-- ============================================================================
-- WHAT WAS OBSERVED, live, in the pilot company (TEST Vantage Consulting
-- Services Private Limited, 9e4071b8-dfec-4d4c-86f6-bb9fab84e600). TEST
-- Ananya Rao has a Rule 15(3) company-car perquisite on file for FY 2026-27
-- (mixed use, above-1600cc, employer-borne running cost, no driver, 12
-- months applicable), which the app's OWN valuation function values
-- correctly:
--
--   get_employee_perquisites_valued(company, ananya, '2026-27')
--     perquisite_type   car
--     taxable_value     84,000.00   -- Rs 7,000/month x 12 (Rule 15(3),
--                                      new_rule_applies for FY 2026-27+)
--
-- But get_salary_tds_estimate, which is what actually sets the amount
-- withheld from her pay and posted to TDS Payable (Salary) every month,
-- never referenced employee_perquisites at all:
--
--   get_salary_tds_estimate(company, '2026-09-01') BEFORE this migration,
--   for Ananya Rao (monthly salary-structure gross Rs 1,50,000, employed the
--   whole FY so projection_months = 12):
--     annual_projected_gross     18,00,000.00   <-- no perquisite
--     taxable_salary_income      17,25,000.00   <-- less Rs 75,000 std ded
--     annual_tax                  1,50,800.00
--     monthly_tds                    12,566.67
--
-- Hand-derived correct figures, folding the 84,000 perquisite into the
-- annualised gross before the same slab/rebate/cess chain (new regime, FY
-- 2026-27, ref_income_tax_slabs): taxable income rises by exactly 84,000,
-- entirely inside the 15,00,001-20,00,000 slab (20%), so tax_before_rebate
-- rises by 84,000 x 20% = 16,800; Sec 87A marginal relief does not reach
-- (taxable income is far past Rs 12,00,000 and tax owed is nowhere near the
-- marginal-relief cap); surcharge nil (taxable income under Rs 50 lakh); +4%
-- cess brings the delta to 16,800 x 1.04 = 17,472/year, i.e. exactly
-- Rs 1,456.00/month under-withheld and under-remitted to the government
-- every month this perquisite is on file — matching the correct
--   annual_projected_gross     18,84,000.00
--   taxable_salary_income      18,09,000.00
--   annual_tax                  1,68,272.00
--   monthly_tds                    14,022.67
--
-- This is not a preview number: get_salary_tds_estimate's output is what
-- get_payroll_run posts as the TDS line on every payroll voucher (1430's own
-- header traces that chain). The ANNUAL certificate (get_form16_partb,
-- 0205/0650) already DISCLOSES this exact shortfall in words — 0650 states
-- outright that perquisites_value is a disclosed line, deliberately not
-- folded into gross_salary or any tax-base CTE there, and names that as a
-- real, stated limitation. get_salary_tds_estimate carried no such
-- disclosure or limitation forward: its own comment (0430/1430) lists what
-- it does NOT account for (HRA exemption, Chapter VI-A, previous-employer
-- salary) and never once mentions perquisites, despite Sec 17(2) perquisites
-- being salary income under Sec 192(1)/Sec 392(1) by the plain text of the
-- Act (see below) and the correct value being one function call away.
--
-- THE RULE RELIED ON. Section 392(1) of the Income-tax Act, 2025 (the
-- section 192(1)/192A successor for FY 2026-27 onward, as already
-- established live in this codebase by 1430) requires the employer to
-- deduct tax "at the average rate of income-tax ... on the estimated income
-- of the assessee under the head 'Salaries'". "Salaries" for this purpose is
-- defined by Sec 15/Sec 17 of the 1961 Act (Sec 392 read with the
-- corresponding 2025-Act definitions) to explicitly INCLUDE "the value of
-- any perquisite" under Sec 17(1)(iv)/17(2) — a company car under Rule
-- 3(2)/Rule 15(3) is exactly such a perquisite. So the estimated income
-- section 392(1) asks the employer to tax-deduct on is not complete without
-- it; omitting it is not a simplification, it is estimating a different,
-- smaller number than the Act names.
--
-- THE FIX. Fold public.get_employee_perquisites_total(company, employee,
-- fy_label) — the SAME function get_form16_partb already calls, which sums
-- public.get_employee_perquisites_valued's per-row taxable_value, covering
-- BOTH the accommodation and car branches (Sec 17(2)(i)/(ii) and (iii)) —
-- into annual_projected_gross, before the existing slab/rebate/surcharge/
-- cess chain runs unchanged. This is a single-line, single-CTE change (the
-- `projected` CTE, which already has p_company_id, e.id and fl.label — the
-- financial-year label get_form16_partb and get_employee_perquisites_valued
-- both key on — in scope) reusing the existing annualisation rather than
-- reinventing it, exactly as instructed: get_employee_perquisites_total
-- already annualises each perquisite row using ITS OWN months_applicable
-- (stored per record, independent of the salary-structure day-factor 1430
-- introduced), so no additional prorating is applied or needed here.
-- monthly_gross (the cash salary-structure figure) is deliberately left
-- untouched — a perquisite is a non-cash valuation, not part of monthly
-- take-home pay, and nothing in the reproduction above calls for it to
-- move; only the ANNUAL projection that feeds the tax base changes.
--
-- CONTROL CASE. An employee with no employee_perquisites row for the
-- relevant FY gets coalesce(..., 0) added, i.e. nothing — verified live for
-- TEST Vantage Divya Iyer and TEST Vantage Rohan Deshmukh below, both
-- unchanged to the paisa.
--
-- METHOD. Read the live definition, apply one targeted replacement, assert
-- it matched exactly once, then execute — the pattern 1200, 1230, 1240 and
-- 1430 already use. Nothing else in the function is retyped, so the
-- joining-date projection (1430), the regime split and the Sec 87A marginal
-- relief (0430) are carried across untouched.
-- ============================================================================

do $mig$
declare
  v_def text;
  v_new text;
  v_hits int;

  -- The only line touched: what feeds annual_projected_gross inside the
  -- `projected` CTE. p_company_id, e.id and fl.label are already in scope
  -- there (e is public.employees, fl is fy_label — both joined earlier in
  -- the same CTE).
  c_t1 constant text := $t1$      proj.annual_gross as annual_projected_gross,$t1$;
  c_r1 constant text := $r1$      proj.annual_gross + coalesce(public.get_employee_perquisites_total(p_company_id, e.id, fl.label), 0) as annual_projected_gross,$r1$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_salary_tds_estimate'
     and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1760: public.get_salary_tds_estimate is missing.';
  end if;

  -- Two things the rest of this migration assumes are still true of the
  -- body: 1430's joining-date projection is present (proj.annual_gross
  -- exists), and nobody has already folded perquisites in.
  if v_def !~ 'proj\.annual_gross as annual_projected_gross' then
    raise exception
      '1760: get_salary_tds_estimate no longer carries 1430''s proj.annual_gross projection; its body has moved. Fix by hand.';
  end if;
  if position('get_employee_perquisites_total' in v_def) > 0 then
    raise exception
      '1760: get_salary_tds_estimate already folds in perquisites. Nothing to do; review before re-running.';
  end if;

  v_new := v_def;

  v_hits := (length(v_new) - length(replace(v_new, c_t1, ''))) / length(c_t1);
  if v_hits <> 1 then
    raise exception '1760: expected exactly 1 annual_projected_gross assignment, found %. Fix by hand.', v_hits;
  end if;
  v_new := replace(v_new, c_t1, c_r1);

  execute v_new;
end;
$mig$;

-- Grants restated rather than assumed. CREATE OR REPLACE preserves the ACL,
-- but revoking from anon alone is a no-op (anon inherits PUBLIC's default
-- EXECUTE), which has shipped as a real hole here before — so the revoke
-- names both.
revoke all on function public.get_salary_tds_estimate(uuid, date) from public, anon;
grant execute on function public.get_salary_tds_estimate(uuid, date) to authenticated;
grant execute on function public.get_salary_tds_estimate(uuid, date) to service_role;

comment on function public.get_salary_tds_estimate is
  'Sec 192(1) / Sec 392(1) TDS-on-salary ESTIMATE per employee, on the employee''s own declared regime (0430): the salary this employer will actually pay between date_of_joining and 31 March at the current structure — pro-rated by get_payroll_run''s own day factor, so a mid-month joiner contributes a part month (1430) — PLUS the annualised Sec 17(2) perquisite value from get_employee_perquisites_total for the same employee/FY (accommodation and car both covered, since that function already sums both — 1760) — less the regime''s standard deduction, taxed at that regime''s slabs/Sec 87A rebate/surcharge/cess, then divided by the months projected rather than a flat 12, which is Sec 392(1)''s average rate restated and is exactly 12 for a whole-year employee. monthly_gross is the cash salary-structure figure only and does NOT include perquisites (a non-cash valuation); only annual_projected_gross (and everything derived from it) does. Reproduces get_form16_partb''s gross_salary to the paisa where the structure is unchanged across the year, though NOT its perquisites_value line, which 0650 deliberately leaves undisclosed-only there. Still does NOT account for HRA exemption, Chapter VI-A declarations, or previous-employer salary/TDS (Sec 192(2)/Form 12B — stored and reported by get_form16_partb but folded into neither function''s tax base; see the 1430 header). A starting number for a human to adjust, not an authoritative computation.';
