import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthBounds(month?: string): { periodMonth: string; label: string; ym: string } {
  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  let y = ty;
  let m = tm;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    [y, m] = month.split("-").map(Number);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const periodMonth = `${y}-${pad(m)}-01`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { periodMonth, label, ym: `${y}-${pad(m)}` };
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function PayrollRegistersPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/payroll-registers">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const { periodMonth, label, ym } = monthBounds(monthParam);

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  if (!payrollOn) {
    return (
      <ReportShell title="Payroll registers" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">Not turned on for this company</p>
          <p className="mt-1">
            Turn on Payroll first —{" "}
            <Link href={`/${companyId}/settings/modules`} className="underline">
              Settings → Modules
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const { data: rows } = await supabase.rpc("get_payroll_run", {
    p_company_id: companyId,
    p_period_month: periodMonth,
  });

  const runs = rows ?? [];
  const base = `/${companyId}/reports/payroll-registers`;

  return (
    <ReportShell
      title="Payroll registers"
      period={`${label} · Wage Register + attendance summary`}
      status={{ label: `${runs.length} employee(s)`, tone: "ok" }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border p-4 text-sm">
        <div className="flex items-center gap-2">
          <Link
            href={`${base}?month=${shiftMonth(ym, -1)}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link
            href={`${base}?month=${shiftMonth(ym, 1)}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            Next →
          </Link>
        </div>
        <Link href={`/${companyId}/reports/payroll-register?month=${ym}`} className="text-xs underline">
          Full payroll register (with TDS workings) →
        </Link>
      </div>

      {/* ---------------- Wage Register ---------------- */}
      <div className="border-b border-border p-4">
        <h2 className="font-semibold">Wage Register</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Rate, units (days paid), gross wages and each statutory deduction itemised — the register
          content Payment of Wages/Code on Wages Central Rules require, derived directly from this
          month&rsquo;s payroll run rather than kept as a separate record.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Employee</th>
              <th className={th + " text-right"}>Days paid</th>
              <th className={th + " text-right"}>Gross wages</th>
              <th className={th + " text-right"}>PF</th>
              <th className={th + " text-right"}>ESI</th>
              <th className={th + " text-right"}>PT</th>
              <th className={th + " text-right"}>TDS</th>
              <th className={th + " text-right"}>Net wages</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-ink-faint">
                  No employee had an active salary structure this month.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr key={r.employee_id} className="border-b border-border last:border-0">
                <td className={td}>{r.employee_name}</td>
                <td className={num}>
                  {r.days_paid}/{r.days_in_month}
                </td>
                <td className={num}>{formatINR(Number(r.gross_pay), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.pf_employee), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.esi_employee), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.professional_tax), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.tds), { showZero: true })}</td>
                <td className={num + " font-medium"}>{formatINR(Number(r.net_pay), { showZero: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------------- Muster Roll ---------------- */}
      <div className="border-b border-t border-border p-4">
        <h2 className="font-semibold">Muster roll — attendance summary</h2>
        <p className="mt-0.5 max-w-3xl text-xs text-ink-faint">
          <strong className="font-medium text-ink">Not a day-wise muster roll.</strong> This app has no
          daily attendance capture, so it cannot show which specific days were worked — only the days-
          paid count already used to prorate pay, derived from date of joining/leaving. A statutory
          inspection asking for a genuine day-by-day register needs an attendance system this app does
          not have; said here explicitly rather than fabricated.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Employee</th>
              <th className={th + " text-right"}>Days in month</th>
              <th className={th + " text-right"}>Days paid</th>
              <th className={th}>Note</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-ink-faint">
                  No data for this month.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr key={r.employee_id} className="border-b border-border last:border-0">
                <td className={td}>{r.employee_name}</td>
                <td className={num}>{r.days_in_month}</td>
                <td className={num}>{r.days_paid}</td>
                <td className={td + " text-ink-soft"}>
                  {Number(r.days_paid) < Number(r.days_in_month) ? "Part month — joined/left mid-month" : "Full month"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="p-4 text-xs text-ink-faint">
        <p>
          <strong className="font-medium text-ink">Fines &amp; deductions register, Loans &amp;
          advances register — not built.</strong> Neither has any capture mechanism in this app: there
          is no ledger for employer-imposed fines (a narrow, specific power distinct from the PF/ESI/PT/
          TDS deductions already modelled above) and no loan/advance ledger against which recoveries
          could be tracked over time. Inventing either would be a new feature with its own statutory
          rules (fines require prior notice and a register of purpose under the Payment of Wages regime;
          loan recovery has its own deduction-ceiling rules), not a free by-product of payroll data the
          way the two registers above are — said explicitly rather than shipped as an empty shell.
        </p>
      </div>
    </ReportShell>
  );
}
