import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Same month-bounds convention as Payroll register / PF ECR — the MC is
 * filed for the same calendar wage month payroll already runs on. */
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

export default async function EsiMcPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/esi-mc">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const { periodMonth, label, ym } = monthBounds(monthParam);

  const [{ data: modules }, { data: company }, { data: rows }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase.from("companies").select("esi_employer_code").eq("id", companyId).maybeSingle(),
    supabase.rpc("get_esi_mc_data", { p_company_id: companyId, p_period_month: periodMonth }),
  ]);

  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  if (!payrollOn) {
    return (
      <ReportShell title="ESI monthly contribution" period={label}>
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

  const records = rows ?? [];
  const missingIp = records.filter((r) => !r.has_ip_number);
  const needsReview = records.filter((r) => r.reason_code === 0);
  const totalWages = records.reduce((n, r) => n + Number(r.total_monthly_wages), 0);

  const base = `/${companyId}/reports/esi-mc`;

  return (
    <ReportShell
      title="ESI monthly contribution"
      period={`${label} · due 15th of the following month`}
      status={
        records.length > 0
          ? { label: `${records.length} IP${records.length === 1 ? "" : "s"}`, tone: "ok" }
          : undefined
      }
    >
      <div className="flex items-center justify-between gap-3 border-b border-border p-4 text-sm">
        <div className="flex items-center gap-2">
          <Link href={`${base}?month=${shiftMonth(ym, -1)}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link href={`${base}?month=${shiftMonth(ym, 1)}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            Next →
          </Link>
        </div>
        <div className="text-right text-xs text-ink-faint">
          Employer code:{" "}
          {company?.esi_employer_code ?? (
            <span className="text-amber-700">
              not set —{" "}
              <Link href={`/${companyId}/settings/employer-registrations`} className="underline">
                add it under Settings
              </Link>
            </span>
          )}
        </div>
      </div>

      {missingIp.length > 0 && (
        <div className="border-b border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          No IP number on file for: {missingIp.map((r) => r.ip_name).join(", ")}. ESIC&rsquo;s MC
          upload requires the 10-digit IP number for every row — add it under Employees before
          uploading.
        </div>
      )}

      {needsReview.length > 0 && (
        <div className="border-b border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          {needsReview.length} row{needsReview.length === 1 ? "" : "s"} show zero wages with no
          determinable reason — this app does not track attendance or loss-of-pay, so it cannot
          tell ESIC&rsquo;s twelve reason codes apart beyond &ldquo;left service&rdquo;. Pick the
          correct code by hand before uploading.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>IP number</th>
              <th className={th}>IP name</th>
              <th className={th + " text-right"}>No. of days</th>
              <th className={th + " text-right"}>Total monthly wages</th>
              <th className={th}>Reason (0 wages)</th>
              <th className={th}>Last working day</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-faint">
                  No ESI-eligible employee has an active salary structure this month.
                </td>
              </tr>
            )}
            {records.map((r) => (
              <tr key={r.employee_id} className="border-b border-border last:border-0">
                <td className={td + " font-mono text-xs"}>
                  {r.ip_number ?? <span className="text-amber-700">missing</span>}
                </td>
                <td className={td}>{r.ip_name}</td>
                <td className={num}>{r.no_of_days}</td>
                <td className={num}>{formatINR(Number(r.total_monthly_wages), { showZero: true })}</td>
                <td className={td}>
                  {r.reason_code === null ? (
                    "—"
                  ) : r.reason_code === 0 ? (
                    <span className="text-amber-700">{r.reason_label}</span>
                  ) : (
                    `${r.reason_code} — ${r.reason_label}`
                  )}
                </td>
                <td className={td}>{r.last_working_day ?? "—"}</td>
              </tr>
            ))}
            {records.length > 0 && (
              <tr className="bg-bg font-semibold">
                <td className={td} colSpan={3}>
                  Total
                </td>
                <td className={num}>{formatINR(totalWages, { showZero: true })}</td>
                <td className={td}></td>
                <td className={td}></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Columns are in the ESIC MC bulk-upload template&rsquo;s own field order (IP number through
        Last working day). This is{" "}
        <strong className="font-medium text-ink">prep data in the template&rsquo;s own shape, not a
        confirmed upload-ready file</strong> — the field list is taken from ESIC&rsquo;s published
        template description, but the exact .xls layout, cell formatting and reason-code list have
        not been verified byte-for-byte against the employer portal&rsquo;s own upload validator (no
        sandbox exists to test that against). Rows are the same employees Payroll register marks
        ESI-applicable — the flag on the salary structure <em>and</em> a full month&rsquo;s gross at
        or under ₹21,000, tested the same way Payroll register tests it, so someone who becomes
        ineligible partway through the year by crossing that ceiling drops off this list the month
        their gross wage rate crosses it. &ldquo;No. of days&rdquo; is the same days-in-employment
        figure Payroll register uses, not a separate attendance count — this app does not track
        attendance or loss-of-pay. The reason code for zero wages can only be positively determined
        for &ldquo;left service&rdquo; (from the recorded date of leaving); every other ESIC reason
        needs data this app doesn&rsquo;t capture and is flagged for manual review instead of
        guessed.
      </p>
    </ReportShell>
  );
}
