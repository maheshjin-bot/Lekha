import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { EmployeeManager } from "@/components/employees/EmployeeManager";
import { financialYearLabel } from "@/lib/utils/period";

export default async function EmployeesPage({
  params,
}: PageProps<"/[companyId]/employees">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [
    { data: employees },
    { data: structures },
    { data: modules },
    { data: branches },
    { data: company },
    { data: taxDeclarations },
  ] = await Promise.all([
    supabase
      .from("employees")
      .select("id, name, pan, uan, esi_number, date_of_joining, date_of_leaving, is_active, branch_id")
      .eq("company_id", companyId)
      .order("name"),
    supabase
      .from("employee_salary_structures")
      .select("employee_id, effective_from, basic, dearness_allowance, hra, special_allowance, other_allowance")
      .eq("company_id", companyId)
      .order("effective_from", { ascending: false }),
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    // Professional tax is a State levy, so an employee has to be attributable
    // to an establishment before a PT liability can be split by State.
    supabase
      .from("branches")
      .select("id, code, name, state_code")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false }),
    supabase.from("companies").select("financial_year_start_month").eq("id", companyId).single(),
    // Sec 115BAC(1A): the regime each employee declared, per financial year.
    // Read here only for the "declared for the current FY?" badge/prefill —
    // the declaration form itself writes through employee_tax_declarations
    // directly from EmployeeManager.
    supabase
      .from("employee_tax_declarations")
      .select("employee_id, financial_year_label, regime")
      .eq("company_id", companyId)
      .order("financial_year_label", { ascending: false }),
  ]);

  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  // First row per employee, since structures are ordered newest-first —
  // that is this employee's CURRENT structure as of today.
  const latestByEmployee = new Map<string, { basic: number; gross: number }>();
  for (const s of structures ?? []) {
    if (latestByEmployee.has(s.employee_id)) continue;
    latestByEmployee.set(s.employee_id, {
      basic: Number(s.basic),
      gross:
        Number(s.basic) +
        Number(s.dearness_allowance) +
        Number(s.hra) +
        Number(s.special_allowance) +
        Number(s.other_allowance),
    });
  }

  const rows = (employees ?? []).map((e) => ({
    ...e,
    current_basic: latestByEmployee.get(e.id)?.basic ?? null,
    current_gross: latestByEmployee.get(e.id)?.gross ?? null,
  }));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Employees</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Employee master and salary structure — the input to the payroll
        register. This page only computes and reports; it doesn&rsquo;t post
        vouchers itself — book posting (salary expense, PF/ESI/PT payable)
        happens from the payroll register report, one month and branch at a
        time, once you&rsquo;ve reviewed the numbers here.{" "}
        <Link href={`/${companyId}/employees/perquisites`} className="underline">
          Record accommodation, company car or other Sec 17(2) perquisites →
        </Link>
      </p>
      {!payrollOn && (
        <div className="mt-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">Payroll is not turned on for this company</p>
          <p className="mt-1">
            You can still add employees, but the payroll register won&rsquo;t
            compute anything until you turn it on.{" "}
            <Link href={`/${companyId}/settings/modules`} className="underline">
              Turn it on in Settings → Modules
            </Link>
            .
          </p>
        </div>
      )}
      <EmployeeManager
        companyId={companyId}
        employees={rows}
        branches={branches ?? []}
        // regime is a checked text column ('old' | 'new'), not a generated
        // enum, so Supabase's typegen widens it to `string` — the CHECK
        // constraint is what actually guarantees the narrower shape.
        taxDeclarations={(taxDeclarations ?? []) as { employee_id: string; financial_year_label: string; regime: "old" | "new" }[]}
        currentFinancialYearLabel={financialYearLabel(company?.financial_year_start_month ?? 4)}
      />
    </main>
  );
}
