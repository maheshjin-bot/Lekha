import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

type GratuityEstimateRow = {
  employee_id: string;
  employee_name: string;
  date_of_joining: string;
  tenure_years: number;
  tenure_months: number;
  tenure_days: number;
  eligible: boolean;
  ineligibility_reason: string | null;
  completed_years_for_formula: number;
  statutory_monthly_wage: number;
  gratuity_uncapped: number;
  ceiling_applied: boolean;
  gratuity_payable: number;
};

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default async function GratuityReportPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/gratuity">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const asOf = typeof sp.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_of) ? sp.as_of : todayLocal();

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  if (!payrollOn) {
    return (
      <ReportShell title="Gratuity" period="—">
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

  const { data: rows } = await callRpc<
    { p_company_id: string; p_as_of: string },
    GratuityEstimateRow[]
  >(supabase, "get_gratuity_estimates", {
    p_company_id: companyId,
    p_as_of: asOf,
  });

  const estimates = rows ?? [];
  const eligibleCount = estimates.filter((r) => r.eligible).length;
  const totalIfAllExitedToday = estimates.reduce((n, r) => n + Number(r.gratuity_payable), 0);

  return (
    <ReportShell
      title="Gratuity"
      period={`As of ${asOf} · if each employee resigned today`}
      status={{
        label: `${eligibleCount} of ${estimates.length} eligible`,
        tone: eligibleCount > 0 ? "warn" : "ok",
      }}
    >
      <div className="border-b border-border p-4 text-sm">
        <form className="flex items-end gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">As of</span>
            <input
              type="date"
              name="as_of"
              defaultValue={asOf}
              className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:bg-surface-2"
          >
            Go
          </button>
        </form>
        <p className="mt-3 max-w-3xl text-xs text-ink-faint">
          Code on Social Security 2020, Sec 53 (supersedes the Payment of Gratuity Act 1972, in force
          nationally since 21 Nov 2025): 15 days&rsquo; wages, at the rate last drawn, for every
          completed year of service — a part-year rounds up only if it exceeds six months — after 5
          years of continuous service (waived on death/disablement), capped at ₹20,00,000. This is an
          ESTIMATE for a resignation exit TODAY, not a prediction of anyone&rsquo;s actual exit — the
          real figure at a real exit depends on the wage then drawn. See{" "}
          <Link href={`/${companyId}/fnf-settlement`} className="underline">
            full-and-final settlement
          </Link>{" "}
          to record a real one.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Employee</th>
              <th className={th}>Joined</th>
              <th className={th}>Tenure</th>
              <th className={th}>Eligible</th>
              <th className={th + " text-right"}>Completed years</th>
              <th className={th + " text-right"}>Statutory wage</th>
              <th className={th + " text-right"}>Gratuity (uncapped)</th>
              <th className={th + " text-right"}>Payable</th>
            </tr>
          </thead>
          <tbody>
            {estimates.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-ink-faint">
                  No active employees.
                </td>
              </tr>
            )}
            {estimates.map((r) => (
              <tr key={r.employee_id} className="border-b border-border last:border-0">
                <td className={td}>{r.employee_name}</td>
                <td className={td + " text-ink-soft"}>{r.date_of_joining}</td>
                <td className={td + " text-ink-soft"}>
                  {r.tenure_years}y {r.tenure_months}m {r.tenure_days}d
                </td>
                <td className={td}>
                  {r.eligible ? (
                    <Badge tone="ok">Eligible</Badge>
                  ) : (
                    <Badge tone="neutral">Not yet</Badge>
                  )}
                </td>
                <td className={num}>{r.completed_years_for_formula}</td>
                <td className={num}>{formatINR(Number(r.statutory_monthly_wage), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.gratuity_uncapped), { showZero: true })}</td>
                <td className={num + " font-medium"}>
                  {formatINR(Number(r.gratuity_payable), { showZero: true })}
                  {r.ceiling_applied && (
                    <div className="text-xs font-normal text-warning">₹20L ceiling applied</div>
                  )}
                </td>
              </tr>
            ))}
            {estimates.length > 0 && (
              <tr className="bg-bg font-semibold">
                <td className={td} colSpan={7}>
                  Total, if every eligible employee resigned today
                </td>
                <td className={num}>{formatINR(totalIfAllExitedToday, { showZero: true })}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t border-border p-4 text-xs text-ink-faint">
        <p>
          <strong className="font-medium text-ink">Wage base:</strong> basic + DA, floored at 50% of
          total remuneration (basic+DA+HRA+special+other) per the Sec 2(88)/Sec 2(y) harmonised
          &ldquo;wages&rdquo; definition&rsquo;s add-back rule — an employer can no longer structure pay
          to keep gratuity liability down by keeping basic below half of what is actually paid. This
          app does not carry a separate &ldquo;retaining allowance&rdquo; component; it is treated as
          zero.
        </p>
        <p className="mt-2">
          <strong className="font-medium text-ink">Not modelled, stated plainly:</strong> Sec 53&rsquo;s
          own carve-out reducing the threshold to 1 year, pro-rata, for FIXED-TERM employees — this
          schema has no employment-type field to distinguish a fixed-term hire from a permanent one, so
          every employee is evaluated on the standard 5-year test. The &ldquo;4 years + 240 days is a
          deemed 5th year&rdquo; doctrine some High Courts have applied to the old Act is also not
          applied — it is contested across jurisdictions, not settled national law. Seasonal
          establishments&rsquo; own 7-days-per-season rate is not modelled either. This is computation
          only — nothing here posts to the ledger.
        </p>
      </div>
    </ReportShell>
  );
}
