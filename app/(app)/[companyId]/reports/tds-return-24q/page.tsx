import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";
import { num, td, th } from "@/components/ui/Table";
import { TdsChallanTable, type TdsChallanRow } from "@/components/reports/TdsChallanTable";
import {
  quarterBounds,
  shiftQuarter,
  challanWindow,
  monthsInQuarter,
  monthsInFinancialYear,
  financialYearLabel,
} from "@/components/reports/tdsReturnQuarters";

/**
 * Form 138 (was Form 24Q) prep — TDS on SALARY payments (Sec 192,
 * recodified under Sec 393 like every other TDS section here; 24Q -> 138
 * confirmed by WebSearch this session alongside 26Q -> 140, 27Q -> 144,
 * 27EQ -> 143, all under the Income-tax Act, 2025 effective 1 Apr 2026).
 *
 * 24Q is the one return this app cannot source from get_tds_deductee_summary
 * (0053) at all — that function is explicitly the Form 140/26Q precursor,
 * built from voucher-level postings against ledgers.is_tds_deductee, which
 * an EMPLOYEE ledger is not normally flagged as (0006's is_tds_deductee/
 * default_tds_section pair models a vendor/contractor deductee, not an
 * employee — ref_tds_sections seeds no '192' code at all). Salary TDS
 * already has its own, separate, purpose-built source: get_payroll_run
 * (0075), the same function /reports/payroll-register reports from, which
 * itself reads get_salary_tds_estimate's (0049) monthly Sec 192 projection.
 * Both are read-only here, unmodified.
 *
 * TWO ANNEXURES, MATCHING THE RETURN'S OWN SHAPE:
 *   Annexure I  — every quarter: employee-wise TDS for the quarter's 3
 *                 months, from get_payroll_run.
 *   Annexure II — Q4 (Jan-Mar) ONLY, by law: full-year salary/TDS detail
 *                 plus the Sec 115BAC(1A) regime each employee declared.
 *                 The regime/deduction facts come from
 *                 employee_tax_declarations (0093) — added specifically as
 *                 "the data-capture prerequisite" for a computation that
 *                 does not exist yet (0093's own words). ANNUAL GROSS/TDS
 *                 SHOWN HERE IS STILL get_payroll_run's NEW-REGIME-ONLY
 *                 PROJECTION for every employee, old-regime declarants
 *                 included — 0093 confirmed (and this session re-confirmed
 *                 by reading get_salary_tds_estimate's SQL directly) that
 *                 LEKHA has no old-regime slab/deduction engine at all. An
 *                 employee who declared 'old' therefore gets a visible
 *                 warning next to a figure that is NOT their real Sec 192
 *                 liability, rather than a silently wrong number.
 */

type PayrollRunRow = {
  employee_id: string;
  employee_name: string;
  gross_pay: number;
  tds: number;
};

type EmployeeAgg = {
  employee_name: string;
  monthsWithData: number;
  grossTotal: number;
  tdsTotal: number;
};

function aggregateByEmployee(monthRows: PayrollRunRow[][]): Map<string, EmployeeAgg> {
  const byEmployee = new Map<string, EmployeeAgg>();
  for (const rows of monthRows) {
    for (const r of rows) {
      const existing = byEmployee.get(r.employee_id);
      if (existing) {
        existing.monthsWithData += 1;
        existing.grossTotal += Number(r.gross_pay);
        existing.tdsTotal += Number(r.tds);
      } else {
        byEmployee.set(r.employee_id, {
          employee_name: r.employee_name,
          monthsWithData: 1,
          grossTotal: Number(r.gross_pay),
          tdsTotal: Number(r.tds),
        });
      }
    }
  }
  return byEmployee;
}

type DeclarationRow = {
  employee_id: string;
  regime: "old" | "new";
  declaration_date: string;
  deduction_80c: number;
  deduction_80d: number;
  hra_exemption_claimed: number;
  home_loan_interest_24b: number;
  previous_employer_income: number;
  previous_employer_tds_deducted: number;
  employees: { name: string; pan: string | null } | null;
};

export default async function TdsReturn24qPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/tds-return-24q">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const qParam = typeof sp.q === "string" ? sp.q : undefined;
  const { from, to, label, qkey, qNum, fyStart } = quarterBounds(qParam);
  const depositTo = challanWindow(to);
  const isQ4 = qNum === 4;

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const tdsOn = (modules ?? []).some((m) => m.code === "tds" && m.active);
  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  if (!tdsOn) {
    return (
      <ReportShell title="TDS return prep — Form 138 (24Q)" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">TDS is not on for this company</p>
          <p className="mt-1">
            TDS activates once a TAN is set —{" "}
            <Link href={`/${companyId}/settings`} className="underline">
              Settings
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const [{ data: company }, { data: challanRows }] = await Promise.all([
    supabase.from("companies").select("name, legal_name, pan, tan").eq("id", companyId).maybeSingle(),
    supabase
      .from("tax_payments")
      .select("id, payment_date, amount, bsr_code, challan_serial, tds_section, notes")
      .eq("company_id", companyId)
      .eq("tax_type", "tds")
      .gte("payment_date", from)
      .lte("payment_date", depositTo)
      .order("payment_date"),
  ]);

  const challans = (challanRows ?? []) as TdsChallanRow[];
  const totalChallan = challans.reduce((n, r) => n + Number(r.amount), 0);

  // Q4: fetch all 12 FY months once; Q1-Q3: fetch just that quarter's 3.
  // Q4's Annexure I is derived from the last 3 of the 12 rather than
  // re-fetching, since Jan/Feb/Mar are already in that set.
  const fyMonths = isQ4 ? monthsInFinancialYear(fyStart) : null;
  const quarterMonths = isQ4 ? fyMonths!.slice(9, 12) : monthsInQuarter(fyStart, qNum);

  const fetchMonth = (m: string) =>
    supabase
      .rpc("get_payroll_run", { p_company_id: companyId, p_period_month: m })
      .then((r) => (r.data ?? []) as PayrollRunRow[]);

  const [quarterMonthRows, fyMonthRows] = await Promise.all([
    payrollOn ? Promise.all(quarterMonths.map(fetchMonth)) : Promise.resolve([]),
    payrollOn && isQ4 ? Promise.all(fyMonths!.map(fetchMonth)) : Promise.resolve(null),
  ]);

  const annexureI = aggregateByEmployee(quarterMonthRows);
  const annexureITotalTds = [...annexureI.values()].reduce((n, e) => n + e.tdsTotal, 0);
  const annualAgg = fyMonthRows ? aggregateByEmployee(fyMonthRows) : new Map<string, EmployeeAgg>();

  let declarations: DeclarationRow[] = [];
  if (isQ4) {
    const fy = financialYearLabel(fyStart);
    const { data: declRows } = await supabase
      .from("employee_tax_declarations")
      .select(
        "employee_id, regime, declaration_date, deduction_80c, deduction_80d, hra_exemption_claimed, home_loan_interest_24b, previous_employer_income, previous_employer_tds_deducted, employees(name, pan)"
      )
      .eq("company_id", companyId)
      .eq("financial_year_label", fy);
    declarations = (declRows ?? []) as unknown as DeclarationRow[];
  }

  // Annexure II row set: every employee with EITHER a declaration OR
  // full-year payroll data this FY — a union, not an inner join, so an
  // employee who never declared (silently defaulting to new-regime under
  // Circular 4/2023, per 0093) still shows up with their payroll figures.
  const annexureIIIds = new Set<string>([...annualAgg.keys(), ...declarations.map((d) => d.employee_id)]);

  const base = `/${companyId}/reports/tds-return-24q`;

  return (
    <ReportShell
      title="TDS return prep — Form 138 (24Q)"
      period={`${label} · prep data, not an FVU-ready file`}
      status={{
        label: `${formatINR(annexureITotalTds, { showZero: true })} deducted (Sec 192, new-regime projection) · ${formatINR(totalChallan, { showZero: true })} deposited`,
        tone: "warn",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`${base}?q=${shiftQuarter(qkey, -1)}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link href={`${base}?q=${shiftQuarter(qkey, 1)}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            Next →
          </Link>
        </div>
        {isQ4 && <Badge tone="accent">Q4 — Annexure II applies</Badge>}
      </div>

      <div className="grid grid-cols-1 gap-3 border-b border-border p-4 text-sm sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Deductor</div>
          <div className="font-medium">{company?.legal_name || company?.name || "—"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">PAN</div>
          <div className="font-mono">{company?.pan || <span className="text-error">not set</span>}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">TAN</div>
          <div className="font-mono">{company?.tan || <span className="text-error">not set</span>}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Form</div>
          <div className="font-medium">138 (Form 24Q under the 1961 Act)</div>
        </div>
      </div>

      {!payrollOn && (
        <div className="border-b border-border bg-warning-soft p-4 text-sm text-warning">
          Payroll is not on for this company — there is no Sec 192 salary data to show. TDS challans below still show
          if any were recorded.
        </div>
      )}

      <div className="border-b border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Challan summary <Badge tone="neutral">tax_payments</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every TDS challan payment recorded for this company, dated {from} to {depositTo}. This same list also
          appears on the 26Q and 27Q pages — OLTAS challan 281 does not itself record which return it funds.
        </p>
      </div>
      <TdsChallanTable rows={challans} />

      <div className="border-b border-t border-border p-4">
        <h2 className="font-semibold">Annexure I — employee-wise, this quarter</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Sec 192 TDS per employee for {label}, from get_payroll_run (0075) — the same figure /reports/payroll-register
          shows per month, summed across the quarter&rsquo;s 3 months. New-regime projection only; see the note under
          Annexure II for what that means for an employee who declared the old regime.
        </p>
      </div>
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Employee</th>
            <th className={th + " text-right"}>Months with payroll data</th>
            <th className={th + " text-right"}>Gross salary, this quarter</th>
            <th className={th + " text-right"}>TDS deducted, this quarter</th>
          </tr>
        </thead>
        <tbody>
          {annexureI.size === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-10 text-center text-ink-faint">
                {payrollOn
                  ? "No employee had an effective salary structure in this quarter."
                  : "Payroll is not on for this company."}
              </td>
            </tr>
          )}
          {[...annexureI.entries()].map(([employeeId, e]) => (
            <tr key={employeeId} className="border-b border-border last:border-0">
              <td className={td}>
                {e.employee_name}
                {e.monthsWithData < 3 && (
                  <span className="ml-2 text-xs text-ink-faint">(only {e.monthsWithData} of 3 months)</span>
                )}
              </td>
              <td className={num}>{e.monthsWithData}</td>
              <td className={num}>{formatINR(e.grossTotal, { showZero: true })}</td>
              <td className={num + " font-medium"}>{formatINR(e.tdsTotal, { showZero: true })}</td>
            </tr>
          ))}
          {annexureI.size > 0 && (
            <tr className="bg-bg font-semibold">
              <td className={td} colSpan={3}>
                Total
              </td>
              <td className={num}>{formatINR(annexureITotalTds, { showZero: true })}</td>
            </tr>
          )}
        </tbody>
      </table>

      {isQ4 ? (
        <>
          <div className="border-b border-t border-border p-4">
            <h2 className="font-semibold">Annexure II — annual detail, Q4 only</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Full FY {financialYearLabel(fyStart)} salary/TDS (Apr–Mar, summed the same way as Annexure I above) next
              to each employee&rsquo;s Sec 115BAC(1A) regime declaration (employee_tax_declarations, 0093). A blank
              declaration means the employee never furnished one — under CBDT Circular 4/2023 that is not a neutral
              state, it is itself the fact that defaults them to the new regime for TDS.
            </p>
          </div>
          <div className="border-b border-border bg-warning-soft p-4 text-xs text-warning">
            The Annual gross/TDS columns are STILL get_payroll_run&rsquo;s new-regime-only projection, for every
            employee — including one who declared the OLD regime below. LEKHA has no old-regime slab/deduction
            computation engine (confirmed in 0093 and re-confirmed this session by reading
            get_salary_tds_estimate&rsquo;s own SQL): it never reads deduction_80c/80d/HRA/24(b) at all. An old-regime
            employee&rsquo;s real Sec 192 liability is NOT what is shown here — this table cannot compute it, and does
            not pretend to.
          </div>
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Employee</th>
                <th className={th}>PAN</th>
                <th className={th}>Regime declared</th>
                <th className={th + " text-right"}>80C claimed</th>
                <th className={th + " text-right"}>80D claimed</th>
                <th className={th + " text-right"}>HRA exemption claimed</th>
                <th className={th + " text-right"}>24(b) interest claimed</th>
                <th className={th + " text-right"}>Prev. employer income / TDS (Sec 192(2))</th>
                <th className={th + " text-right"}>Annual gross (new-regime run)</th>
                <th className={th + " text-right"}>Annual TDS (new-regime run)</th>
              </tr>
            </thead>
            <tbody>
              {annexureIIIds.size === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-ink-faint">
                    No employee has a FY {financialYearLabel(fyStart)} declaration or payroll data.
                  </td>
                </tr>
              )}
              {[...annexureIIIds].map((employeeId) => {
                const decl = declarations.find((d) => d.employee_id === employeeId);
                const agg = annualAgg.get(employeeId);
                const name = agg?.employee_name ?? decl?.employees?.name ?? "—";
                const pan = decl?.employees?.pan ?? null;
                return (
                  <tr key={employeeId} className="border-b border-border last:border-0">
                    <td className={td}>{name}</td>
                    <td className={td + " font-mono text-xs text-ink-faint"}>{pan ?? "—"}</td>
                    <td className={td}>
                      {decl ? (
                        <Badge tone={decl.regime === "old" ? "warn" : "neutral"}>{decl.regime}</Badge>
                      ) : (
                        <span className="text-xs text-ink-faint">not declared → new (default)</span>
                      )}
                    </td>
                    <td className={num}>
                      {decl && decl.regime === "old" ? formatINR(decl.deduction_80c, { showZero: true }) : "—"}
                    </td>
                    <td className={num}>
                      {decl && decl.regime === "old" ? formatINR(decl.deduction_80d, { showZero: true }) : "—"}
                    </td>
                    <td className={num}>
                      {decl && decl.regime === "old" ? formatINR(decl.hra_exemption_claimed, { showZero: true }) : "—"}
                    </td>
                    <td className={num}>
                      {decl && decl.regime === "old" ? formatINR(decl.home_loan_interest_24b, { showZero: true }) : "—"}
                    </td>
                    <td className={num}>
                      {decl && (decl.previous_employer_income > 0 || decl.previous_employer_tds_deducted > 0)
                        ? `${formatINR(decl.previous_employer_income, { showZero: true })} / ${formatINR(decl.previous_employer_tds_deducted, { showZero: true })}`
                        : "—"}
                    </td>
                    <td className={num}>
                      {agg ? formatINR(agg.grossTotal, { showZero: true }) : <span className="text-ink-faint">no salary structure on file</span>}
                    </td>
                    <td className={num + " font-medium"}>
                      {agg ? formatINR(agg.tdsTotal, { showZero: true }) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : (
        <div className="border-b border-t border-border p-4 text-sm text-ink-faint">
          Annexure II (annual salary/regime detail) applies only to the Jan–Mar (Q4) return —{" "}
          <Link href={`${base}?q=${fyStart}-Q4`} className="underline">
            switch to Q4
          </Link>
          .
        </div>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        This is filing PREP DATA laid out in Form 138&rsquo;s (24Q&rsquo;s) own section shape — deductor details,
        challan summary, Annexure I, and (Q4) Annexure II — not an FVU-ready upload file. Manual filing is not
        accepted: the actual return still has to be prepared in Protean/NSDL&rsquo;s Return Preparation Utility and
        validated through the File Validation Utility before upload. This report was not able to confirm the FVU
        flat-file&rsquo;s exact byte-level field positions with confidence, so it does not attempt to produce one.
        Sec 192 figures are a projection (get_salary_tds_estimate, 0049), not a record of TDS actually withheld
        voucher-by-voucher — LEKHA has no per-payroll-run TDS ledger posting distinct from this estimate. Sec 234E
        late-fee/Sec 271H penalty exposure is not computed. Nothing here is submitted anywhere — LEKHA has no TRACES
        or e-filing portal access.
      </p>
    </ReportShell>
  );
}
