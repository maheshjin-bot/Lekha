import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { LeaveManager } from "@/components/leave/LeaveManager";

type LeaveBalanceRow = {
  employee_id: string;
  employee_name: string;
  date_of_joining: string;
  accrued: number;
  availed: number;
  encashed: number;
  adjusted: number;
  balance: number;
  carry_forward_cap: number;
  excess_over_cap: number;
};

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default async function LeavePage({
  params,
  searchParams,
}: PageProps<"/[companyId]/leave">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const asOf = typeof sp.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_of) ? sp.as_of : todayLocal();

  const [{ data: modules }, { data: company }, { data: employees }, { data: balances }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase
      .from("companies")
      .select("leave_accrual_days_per_month, leave_carry_forward_cap_days")
      .eq("id", companyId)
      .single(),
    supabase
      .from("employees")
      .select("id, name, is_active")
      .eq("company_id", companyId)
      .order("name"),
    callRpc<{ p_company_id: string; p_as_of: string }, LeaveBalanceRow[]>(supabase, "get_leave_balances", {
      p_company_id: companyId,
      p_as_of: asOf,
    }),
  ]);

  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  if (!payrollOn) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Earned leave</h1>
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

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Earned leave</h1>
      <p className="mt-1.5 max-w-3xl text-sm text-ink-soft">
        Earned/annual leave only (OSH Code 2020 Sec 32) — casual and sick leave carry no statutory
        encashment right and are not tracked here. Accrual is a configurable monthly rate from date
        of joining, prorated for a joining/leaving month, because this app has no day-wise attendance
        capture to accrue against the statute&rsquo;s own 1-day-per-20-worked-days rate directly.
      </p>
      <LeaveManager
        companyId={companyId}
        accrualRate={Number(company?.leave_accrual_days_per_month ?? 1.25)}
        carryForwardCap={Number(company?.leave_carry_forward_cap_days ?? 30)}
        employees={(employees ?? []).filter((e) => e.is_active)}
        balances={(balances ?? []).map((b) => ({
          employee_id: b.employee_id,
          employee_name: b.employee_name,
          date_of_joining: b.date_of_joining,
          accrued: Number(b.accrued),
          availed: Number(b.availed),
          encashed: Number(b.encashed),
          adjusted: Number(b.adjusted),
          balance: Number(b.balance),
          carry_forward_cap: Number(b.carry_forward_cap),
          excess_over_cap: Number(b.excess_over_cap),
        }))}
        asOf={asOf}
      />
    </main>
  );
}
