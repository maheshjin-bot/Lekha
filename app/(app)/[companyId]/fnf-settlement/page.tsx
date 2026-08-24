import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { FnfSettlementManager } from "@/components/fnf/FnfSettlementManager";

export default async function FnfSettlementPage({
  params,
}: PageProps<"/[companyId]/fnf-settlement">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: modules }, { data: employees }, { data: settlements }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase
      .from("employees")
      .select("id, name, date_of_joining, date_of_leaving, is_active")
      .eq("company_id", companyId)
      .order("name"),
    supabase
      .from("employee_exit_settlements")
      .select(
        "id, employee_id, exit_date, exit_reason, unpaid_salary_amount, leave_encashment_days, leave_encashment_amount, gratuity_eligible, gratuity_amount, bonus_amount, recoveries_amount, net_payable, finalized_at"
      )
      .eq("company_id", companyId)
      .order("finalized_at", { ascending: false }),
  ]);

  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  if (!payrollOn) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Full &amp; final settlement
        </h1>
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

  const employeeNameById = new Map((employees ?? []).map((e) => [e.id, e.name]));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Full &amp; final settlement
      </h1>
      <p className="mt-1.5 max-w-3xl text-sm text-ink-soft">
        Aggregates leave encashment and gratuity (both computed here) with unpaid salary, bonus and
        recoveries (entered by you) into one exit settlement. Code on Wages 2019 Sec 17(2) requires
        ALL WAGES — unpaid salary, leave encashment, pro-rata bonus, recoveries netted off — to be paid
        within <strong className="font-medium text-ink">2 working days</strong> of the last working
        day, regardless of exit reason (in force nationally since 21 Nov 2025). Gratuity is{" "}
        <strong className="font-medium text-ink">not</strong> &ldquo;wages&rdquo; for this test and
        keeps its own separate 30-day clock under Sec 53(7)/(8), with mandatory interest on a delay not
        caused by the employee. Finalizing does not post anything to the general ledger — record the
        actual payment as an ordinary voucher once made.
      </p>

      <FnfSettlementManager
        companyId={companyId}
        employees={(employees ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          date_of_joining: e.date_of_joining,
          date_of_leaving: e.date_of_leaving,
          is_active: e.is_active,
        }))}
        settlements={(settlements ?? []).map((s) => ({
          ...s,
          employee_name: employeeNameById.get(s.employee_id) ?? "—",
          unpaid_salary_amount: Number(s.unpaid_salary_amount),
          leave_encashment_days: Number(s.leave_encashment_days),
          leave_encashment_amount: Number(s.leave_encashment_amount),
          gratuity_amount: Number(s.gratuity_amount),
          bonus_amount: Number(s.bonus_amount),
          recoveries_amount: Number(s.recoveries_amount),
          net_payable: Number(s.net_payable),
        }))}
      />
    </main>
  );
}
