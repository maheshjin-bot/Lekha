import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { PostPayrollButton } from "@/components/employees/PostPayrollButton";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Payroll runs on the calendar month, same principle as every other
 * statutory-adjacent report in this app. `month` is "YYYY-MM"; defaults to
 * the current calendar month. */
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

export default async function PayrollRegisterPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/payroll-register">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const { periodMonth, label, ym } = monthBounds(monthParam);

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  if (!payrollOn) {
    return (
      <ReportShell title="Payroll register" period={label}>
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

  const [{ data: rows }, { data: posting }, { data: branch }] = await Promise.all([
    supabase.rpc("get_payroll_run", {
      p_company_id: companyId,
      p_period_month: periodMonth,
    }),
    supabase
      .from("payroll_postings")
      .select("voucher_id, posted_at")
      .eq("company_id", companyId)
      .eq("period_month", periodMonth)
      .maybeSingle(),
    supabase
      .from("branches")
      .select("id")
      .eq("company_id", companyId)
      .order("is_head_office", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const runs = rows ?? [];
  const totals = runs.reduce(
    (acc, r) => ({
      gross: acc.gross + Number(r.gross_pay),
      pfEmployee: acc.pfEmployee + Number(r.pf_employee),
      pfEmployer: acc.pfEmployer + Number(r.pf_employer),
      esiEmployee: acc.esiEmployee + Number(r.esi_employee),
      esiEmployer: acc.esiEmployer + Number(r.esi_employer),
      pt: acc.pt + Number(r.professional_tax),
      net: acc.net + Number(r.net_pay),
    }),
    { gross: 0, pfEmployee: 0, pfEmployer: 0, esiEmployee: 0, esiEmployer: 0, pt: 0, net: 0 }
  );

  const base = `/${companyId}/reports/payroll-register`;

  return (
    <ReportShell
      title="Payroll register"
      period={posting ? `${label} · posted to the books` : `${label} · computed, not posted to the books`}
      status={{
        label: `${formatINR(totals.net, { showZero: true })} net pay`,
        tone: "ok",
      }}
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
        {posting ? (
          <div className="text-right text-xs text-ink-faint">
            Posted {posting.posted_at?.slice(0, 10)} —{" "}
            <Link href={`/${companyId}/vouchers/${posting.voucher_id}`} className="underline">
              view voucher
            </Link>
          </div>
        ) : (
          runs.length > 0 &&
          branch?.id && (
            <PostPayrollButton
              companyId={companyId}
              branchId={branch.id}
              periodMonth={periodMonth}
              monthLabel={label}
            />
          )
        )}
      </div>

      <table className="w-full min-w-[880px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Employee</th>
            <th className={th + " text-right"}>Gross</th>
            <th className={th + " text-right"}>PF (Emp.)</th>
            <th className={th + " text-right"}>PF (Empr.)</th>
            <th className={th + " text-right"}>ESI (Emp.)</th>
            <th className={th + " text-right"}>ESI (Empr.)</th>
            <th className={th + " text-right"}>PT</th>
            <th className={th + " text-right"}>Net pay</th>
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
              <td className={num}>{formatINR(Number(r.gross_pay), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.pf_employee), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.pf_employer), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.esi_employee), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.esi_employer), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.professional_tax), { showZero: true })}</td>
              <td className={num + " font-medium"}>{formatINR(Number(r.net_pay), { showZero: true })}</td>
            </tr>
          ))}
          {runs.length > 0 && (
            <tr className="bg-bg font-semibold">
              <td className={td}>Total</td>
              <td className={num}>{formatINR(totals.gross, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.pfEmployee, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.pfEmployer, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.esiEmployee, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.esiEmployer, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.pt, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.net, { showZero: true })}</td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        PF: 12%/12% of PF wage (basic, capped at ₹15,000 unless an employee&rsquo;s
        structure says otherwise). ESI: 0.75%/3.25% of gross, only while gross
        is at or under ₹21,000/month. Professional tax is whatever was entered
        on the employee&rsquo;s own salary structure — not computed from a
        state slab table, since PT varies by state and several states don&rsquo;t
        levy it at all. Net pay does not deduct TDS on salary (Sec 192), which
        this app does not compute yet. A full month&rsquo;s structure is used
        regardless of actual days worked — mid-month joiners and leavers are
        not prorated.{" "}
        {posting ? (
          <>
            Posted as a single journal voucher (Dr Salary Expense + Employer
            PF/ESI Contribution, Cr PF/ESI/Professional Tax Payable + Salaries
            Payable) — one aggregate liability ledger, not one per employee.
            A correction needs a manual reversing entry; there is no unpost
            action.
          </>
        ) : (
          <>
            Not yet posted — nothing here has touched a ledger. Posting
            creates one journal voucher for the whole month&rsquo;s totals,
            not a line per employee.
          </>
        )}
      </p>
    </ReportShell>
  );
}
