import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { formatINR } from "@/lib/utils/currency";
import { financialYearLabel } from "@/lib/utils/period";
import { EmployeePerquisitesManager } from "@/components/employees/EmployeePerquisitesManager";

/**
 * Sec 17(2) perquisites (accommodation, company car, other) — the data
 * capture and Rule 15 (Income-tax Rules 2026, FY 2026-27 onward) / old
 * Rule 3 (Income-tax Rules 1962, up to FY 2025-26) valuation that 0093 and
 * 0205 both flagged as missing. Migration 0650. A sibling screen to
 * /employees, not a tab inside EmployeeManager.tsx (kept as a separate
 * additive component/route per this batch's off-limits-file rule) — linked
 * from the Employees page instead.
 *
 * The computed total here is the SAME figure get_form16_partb's
 * perquisites_value line now shows (0650) — this screen is where that
 * figure gets its facts.
 */

type EmployeeOption = { id: string; name: string; pan: string | null };

type ValuedRow = {
  perquisite_id: string;
  perquisite_type: "accommodation" | "car" | "other";
  months_applicable: number;
  accommodation_ownership: "employer_owned" | "employer_leased" | null;
  city_population_tier: "above_40_lakh" | "15_to_40_lakh" | "below_15_lakh" | null;
  car_cc_class: "up_to_1600cc_or_ev" | "above_1600cc" | null;
  car_usage: "official" | "personal" | "mixed" | null;
  running_cost_borne_by: "employer" | "employee" | null;
  driver_provided: boolean;
  other_perquisite_description: string | null;
  amount_recovered_from_employee: number;
  rule_salary_base: number;
  taxable_value: number;
  computation_note: string | null;
};

function currentFinancialYearLabelFallback(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const fyStart = m >= 4 ? y : y - 1;
  return `${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`;
}

export default async function EmployeePerquisitesPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/employees/perquisites">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: modules }, { data: employeeRows }, { data: company }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase.from("employees").select("id, name, pan").eq("company_id", companyId).order("name"),
    supabase.from("companies").select("financial_year_start_month").eq("id", companyId).maybeSingle(),
  ]);

  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);
  const employees = (employeeRows ?? []) as EmployeeOption[];
  const currentFy = company
    ? financialYearLabel(company.financial_year_start_month ?? 4)
    : currentFinancialYearLabelFallback();

  if (!payrollOn) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Employee perquisites</h1>
        <div className="mt-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">Payroll is not turned on for this company</p>
          <p className="mt-1">
            Turn it on first —{" "}
            <Link href={`/${companyId}/settings/modules`} className="underline">
              Settings → Modules
            </Link>
            .
          </p>
        </div>
      </main>
    );
  }

  if (employees.length === 0) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Employee perquisites</h1>
        <div className="mt-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">No employees on file</p>
          <p className="mt-1">
            Add one on the{" "}
            <Link href={`/${companyId}/employees`} className="underline">
              Employees
            </Link>{" "}
            page first.
          </p>
        </div>
      </main>
    );
  }

  const selectedEmployeeId =
    typeof sp.emp === "string" && employees.some((e) => e.id === sp.emp) ? sp.emp : employees[0].id;
  const fy = typeof sp.fy === "string" && /^\d{4}-\d{2}$/.test(sp.fy) ? sp.fy : currentFy;

  const { data: valuedRows } = await callRpc<
    { p_company_id: string; p_employee_id: string; p_financial_year_label: string },
    ValuedRow[]
  >(supabase, "get_employee_perquisites_valued", {
    p_company_id: companyId,
    p_employee_id: selectedEmployeeId,
    p_financial_year_label: fy,
  });

  const rows = valuedRows ?? [];
  const total = rows.reduce((sum, r) => sum + Number(r.taxable_value), 0);
  const selectedEmployee = employees.find((e) => e.id === selectedEmployeeId) ?? null;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Employee perquisites</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Sec 17(2) benefits — employer-provided accommodation, a company car, or any other benefit — valued per
        Rule 15 (Income-tax Rules 2026, FY 2026-27 onward) or old Rule 3 (Income-tax Rules 1962, up to FY 2025-26).
        The total below is exactly what{" "}
        <Link href={`/${companyId}/reports/form16-partb?emp=${selectedEmployeeId}&fy=${fy}`} className="underline">
          Form 16 Part B
        </Link>{" "}
        now shows on its perquisites line for this employee and financial year — it does not, by itself, change
        gross salary or the tax computed on that certificate. See the note at the bottom of this page for why.
      </p>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4 text-sm">
        <div>
          <label htmlFor="emp" className="block text-[11px] uppercase tracking-wide text-ink-faint">
            Employee
          </label>
          <select
            id="emp"
            name="emp"
            defaultValue={selectedEmployeeId}
            className="field rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent"
          >
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.pan ? ` (${e.pan})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="fy" className="block text-[11px] uppercase tracking-wide text-ink-faint">
            Financial year
          </label>
          <input
            id="fy"
            name="fy"
            type="text"
            defaultValue={fy}
            placeholder="2026-27"
            className="field w-28 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent"
          />
        </div>
        <button type="submit" className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:bg-surface-2">
          Go
        </button>
      </form>

      <EmployeePerquisitesManager
        companyId={companyId}
        employeeId={selectedEmployeeId}
        employeeName={selectedEmployee?.name ?? ""}
        financialYearLabel={fy}
        rows={rows}
      />

      <div className="mt-4 flex items-center justify-between rounded-lg bg-accent-soft px-4 py-3 text-sm">
        <span className="font-medium">Total perquisite value — {selectedEmployee?.name ?? "—"}, FY {fy}</span>
        <span className="font-display text-lg font-semibold text-accent">{formatINR(total, { showZero: true })}</span>
      </div>

      <p className="mt-4 rounded-md bg-warning-soft px-4 py-3 text-xs text-warning">
        This total is wired into Form 16 Part B&rsquo;s perquisites line (migration 0650) but is <strong>not</strong>{" "}
        added into gross salary or the tax computed there — Form 16 Part B&rsquo;s regime/slab/surcharge chain is
        owned by a different migration (0430) landed the same day, and folding perquisites into that chain would mean
        editing the same lines it edits. Treat the certificate&rsquo;s net tax payable as understated by roughly the
        tax on this total until that follow-up work is done. Furniture attached to employer accommodation, hotel
        accommodation, an employee-owned car reimbursed by the employer, and the inflation-linked cap on accommodation
        continued beyond its first year are not modelled — see migration 0650&rsquo;s own header for why.
      </p>
    </main>
  );
}
