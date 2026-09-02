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

/** Same month-bounds convention as Payroll register — the ECR is filed for
 * the same calendar wage month payroll already runs on. */
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

export default async function PfEcrPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/pf-ecr">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const { periodMonth, label, ym } = monthBounds(monthParam);

  const [{ data: modules }, { data: company }, { data: rows }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase.from("companies").select("pf_establishment_code").eq("id", companyId).maybeSingle(),
    supabase.rpc("get_pf_ecr_data", { p_company_id: companyId, p_period_month: periodMonth }),
  ]);

  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  if (!payrollOn) {
    return (
      <ReportShell title="PF ECR" period={label}>
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
  const missingUan = records.filter((r) => !r.has_uan);
  const totals = records.reduce(
    (acc, r) => ({
      gross: acc.gross + Number(r.gross_wages),
      epf: acc.epf + Number(r.epf_wages),
      eps: acc.eps + Number(r.eps_wages),
      edli: acc.edli + Number(r.edli_wages),
      empEpf: acc.empEpf + Number(r.epf_contribution_employee),
      epsContrib: acc.epsContrib + Number(r.eps_contribution_employer),
      diff: acc.diff + Number(r.epf_contribution_employer_diff),
    }),
    { gross: 0, epf: 0, eps: 0, edli: 0, empEpf: 0, epsContrib: 0, diff: 0 }
  );

  const base = `/${companyId}/reports/pf-ecr`;

  return (
    <ReportShell
      title="PF ECR"
      period={`${label} · due 15th of the following month`}
      status={
        records.length > 0
          ? { label: `${records.length} member${records.length === 1 ? "" : "s"}`, tone: "ok" }
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
          Establishment code:{" "}
          {company?.pf_establishment_code ?? (
            <span className="text-amber-700">
              not set —{" "}
              <Link href={`/${companyId}/settings/employer-registrations`} className="underline">
                add it under Settings
              </Link>
            </span>
          )}
        </div>
      </div>

      {missingUan.length > 0 && (
        <div className="border-b border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          No UAN on file for: {missingUan.map((r) => r.member_name).join(", ")}. EPFO&rsquo;s ECR
          rejects a row with no UAN — add it under Employees before uploading.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>UAN</th>
              <th className={th}>Member name</th>
              <th className={th + " text-right"}>Gross wages</th>
              <th className={th + " text-right"}>EPF wages</th>
              <th className={th + " text-right"}>EPS wages</th>
              <th className={th + " text-right"}>EDLI wages</th>
              <th className={th + " text-right"}>EPF contri. (employee)</th>
              <th className={th + " text-right"}>EPS contri. (employer)</th>
              <th className={th + " text-right"}>EPF-EPS diff (employer)</th>
              <th className={th + " text-right"}>NCP days</th>
              <th className={th + " text-right"}>Refund of advances</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-10 text-center text-ink-faint">
                  No PF member has an active salary structure this month.
                </td>
              </tr>
            )}
            {records.map((r) => (
              <tr key={r.employee_id} className="border-b border-border last:border-0">
                <td className={td + " font-mono text-xs"}>
                  {r.uan ?? <span className="text-amber-700">missing</span>}
                </td>
                <td className={td}>{r.member_name}</td>
                <td className={num}>{formatINR(Number(r.gross_wages), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.epf_wages), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.eps_wages), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.edli_wages), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.epf_contribution_employee), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.eps_contribution_employer), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.epf_contribution_employer_diff), { showZero: true })}</td>
                <td className={num}>{r.ncp_days}</td>
                <td className={num}>{formatINR(Number(r.refund_of_advances), { showZero: true })}</td>
              </tr>
            ))}
            {records.length > 0 && (
              <tr className="bg-bg font-semibold">
                <td className={td} colSpan={2}>
                  Total
                </td>
                <td className={num}>{formatINR(totals.gross, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.epf, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.eps, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.edli, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.empEpf, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.epsContrib, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.diff, { showZero: true })}</td>
                <td className={num}>—</td>
                <td className={num}>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Columns are in ECR 2.0&rsquo;s own 11-field order (UAN through Refund of advances), the
        order EPFO&rsquo;s <code>#~#</code>-delimited text file uses. This is{" "}
        <strong className="font-medium text-ink">prep data in the file&rsquo;s own shape, not a
        confirmed upload-ready file</strong> — the field order and delimiter are taken from EPFO&rsquo;s
        published format, cross-checked against independent sources describing it identically, but
        not verified byte-for-byte against the employer portal&rsquo;s own upload validator (no
        sandbox exists to test that against). The CSV button above exports this table as a plain
        spreadsheet — it is not the <code>#~#</code>-delimited ECR file itself, which still has to be
        assembled and uploaded on the EPFO portal. Figures are rounded to the nearest rupee, matching
        EPFO&rsquo;s own instruction that ECR contributions carry no paise. EPS contribution is
        8.33% of EPF wages capped at the ₹15,000 pension-wage ceiling (prorated for a part month);
        the EPF-EPS difference column is the balance of the employer&rsquo;s 12% after EPS is taken
        out of it, so that column plus EPS always reconciles to the employer&rsquo;s total PF
        contribution shown in Payroll register. NCP days come from the same days-in-employment
        figure Payroll register uses — this app does not track attendance or loss-of-pay, so a
        continuing member who was on unpaid leave for an entire month cannot be represented; every
        row here assumes payment for the full days between joining/leaving dates.{" "}
        <strong className="font-medium text-ink">Refund of advances is always shown as 0</strong> —
        this app has no PF advance/loan tracking at all, so check for any active advance before
        uploading rather than trusting this column.
      </p>
    </ReportShell>
  );
}
