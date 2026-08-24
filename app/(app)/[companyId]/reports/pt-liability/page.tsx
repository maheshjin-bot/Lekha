import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

/** Today as a local wall-clock date — not toISOString(), which is UTC. Same
 * reasoning as every other report page in this app (see lib/utils/period.ts). */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const SPAN_OPTIONS = [
  { months: 1, label: "1 month" },
  { months: 3, label: "Quarter" },
  { months: 6, label: "Half-year" },
  { months: 12, label: "Year" },
] as const;

/**
 * PT filing periodicity genuinely differs by State — confirmed live while
 * building this report (see the 0108 migration header): monthly in
 * Maharashtra/Karnataka/West Bengal, HALF-YEARLY in Tamil Nadu (30 September
 * / 31 March). So unlike most reports in this app, the period here is not
 * pinned to one calendar month — `span` (in whole months) is user-chosen,
 * anchored at the first day of `month`.
 */
function resolvePeriod(monthParam: string | undefined, spanParam: string | undefined) {
  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  let y = ty;
  let m = tm;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    [y, m] = monthParam.split("-").map(Number);
  }
  const span = SPAN_OPTIONS.some((s) => String(s.months) === spanParam) ? Number(spanParam) : 1;

  const pad = (n: number) => String(n).padStart(2, "0");
  const periodStart = `${y}-${pad(m)}-01`;
  const endMonthDate = new Date(Date.UTC(y, m - 1 + span, 0)); // day 0 of next-after-span month = last day of the span
  const periodEnd = `${endMonthDate.getUTCFullYear()}-${pad(endMonthDate.getUTCMonth() + 1)}-${pad(endMonthDate.getUTCDate())}`;

  const startLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
  const endLabel = new Date(
    Date.UTC(endMonthDate.getUTCFullYear(), endMonthDate.getUTCMonth(), 1)
  ).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  const label = span === 1 ? startLabel : `${startLabel} to ${endLabel}`;

  const ym = `${y}-${pad(m)}`;
  return { periodStart, periodEnd, label, ym, span };
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type LiabilityRow = {
  state_code: string;
  state_name: string;
  branch_id: string | null;
  branch_name: string;
  employee_count: number;
  pt_liability: number;
};

export default async function PtLiabilityPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/pt-liability">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const spanParam = typeof sp.span === "string" ? sp.span : undefined;
  const { periodStart, periodEnd, label, ym, span } = resolvePeriod(monthParam, spanParam);

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  if (!payrollOn) {
    return (
      <ReportShell title="Professional tax — liability by State" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">Not turned on for this company</p>
          <p className="mt-1">
            Turn on Payroll first —{" "}
            <Link href={`/${companyId}/settings/modules`} className="underline">
              Settings → Modules
            </Link>
            . Professional tax is entered on each employee&rsquo;s salary structure, so there is
            nothing to split by State until Payroll is on.
          </p>
        </div>
      </ReportShell>
    );
  }

  const [{ data: rows, error }, { data: branches }] = await Promise.all([
    supabase.rpc("get_pt_liability_by_state", {
      p_company_id: companyId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
    }),
    supabase
      .from("branches")
      .select("id, pt_registration_number, pt_enrolment_number")
      .eq("company_id", companyId),
  ]);

  // `as unknown as` — same reason as reports/notes-to-accounts and
  // reports/gstr1-summary after their own new RPCs: the generated
  // database.types.ts (owned by the integration pass, not touched here)
  // still has no entry for get_pt_liability_by_state until it is
  // regenerated.
  const liability = (rows ?? []) as unknown as LiabilityRow[];
  const regByBranch = new Map((branches ?? []).map((b) => [b.id, b]));
  const total = liability.reduce((n, r) => n + Number(r.pt_liability), 0);
  const totalEmployees = liability.reduce((n, r) => n + Number(r.employee_count), 0);

  const base = `/${companyId}/reports/pt-liability`;
  const spanQuery = `&span=${span}`;

  return (
    <ReportShell
      title="Professional tax — liability by State"
      period={`${label} · split by State and branch, not computed from a slab table`}
      status={{
        label: `${formatINR(total, { showZero: true })} across ${liability.length} state${liability.length === 1 ? "" : "s"}`,
        tone: "ok",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 text-sm">
        <div className="flex items-center gap-2">
          <Link
            href={`${base}?month=${shiftMonth(ym, -span)}${spanQuery}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link
            href={`${base}?month=${shiftMonth(ym, span)}${spanQuery}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            Next →
          </Link>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="mr-1 text-ink-faint">Filing period:</span>
          {SPAN_OPTIONS.map((s) => (
            <Link
              key={s.months}
              href={`${base}?month=${ym}&span=${s.months}`}
              className={
                "rounded-md border px-2 py-1 " +
                (span === s.months
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-strong hover:bg-surface-2")
              }
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {error && (
        <div className="m-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-900">
          Could not load this report: {error.message}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>State</th>
              <th className={th}>Branch</th>
              <th className={th}>PTRC on file</th>
              <th className={th + " text-right"}>Employees</th>
              <th className={th + " text-right"}>PT liability</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {liability.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-faint">
                  No Professional Tax recorded for any employee this period. PT is entered per
                  employee on their salary structure — Employees → salary structure — not computed
                  here from any slab table.
                </td>
              </tr>
            )}
            {liability.map((r) => {
              const reg = r.branch_id ? regByBranch.get(r.branch_id) : undefined;
              return (
                <tr key={`${r.state_code}-${r.branch_id ?? "unassigned"}`} className="border-b border-border last:border-0">
                  <td className={td}>
                    {r.state_name}
                    {r.state_code === "ZZ" && <Badge tone="warn" className="ml-2">unattributed</Badge>}
                  </td>
                  <td className={td}>{r.branch_name}</td>
                  <td className={td + " font-mono text-xs"}>
                    {reg?.pt_registration_number || (
                      <span className="font-sans text-ink-faint">
                        {r.branch_id ? "not on file" : "—"}
                      </span>
                    )}
                  </td>
                  <td className={num}>{r.employee_count}</td>
                  <td className={num + " font-medium"}>
                    {formatINR(Number(r.pt_liability), { showZero: true })}
                  </td>
                  <td className={td + " text-right"}>
                    <Link href={`/${companyId}/tax-payments`} className="text-xs text-accent underline">
                      Record a payment
                    </Link>
                  </td>
                </tr>
              );
            })}
            {liability.length > 0 && (
              <tr className="bg-bg font-semibold">
                <td className={td} colSpan={3}>
                  Total
                </td>
                <td className={num}>{totalEmployees}</td>
                <td className={num}>{formatINR(total, { showZero: true })}</td>
                <td className={td} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t border-border p-4 text-xs text-ink-faint space-y-3">
        <p>
          <strong className="font-medium text-ink">Where this comes from.</strong> LEKHA does not
          hold a Professional Tax slab table for any State — PT is levied independently by roughly
          20 States/UTs, revised unpredictably, capped only by Article 276 of the Constitution at
          ₹2,500 per person per year. Instead, the monthly PT figure is entered directly on each
          employee&rsquo;s salary structure (the same field payroll already uses), and this report
          only totals what has been entered, grouped by the employee&rsquo;s branch and that
          branch&rsquo;s State. An employee with no branch set is counted against the company&rsquo;s
          head office. It is a fixed monthly amount and is not pro-rated for a part month, matching
          how the payroll register itself treats it — only zeroed in a month the employee was not
          paid at all.
        </p>
        <p>
          <strong className="font-medium text-ink">Filing periods differ by State</strong> — that is
          why this report lets you pick 1/3/6/12 months rather than assuming a calendar month.
          Maharashtra, Karnataka and West Bengal file monthly; Tamil Nadu files half-yearly (Apr-Sep
          due 30 September, Oct-Mar due 31 March). Several States — Delhi, Uttar Pradesh, Rajasthan,
          Haryana and Himachal Pradesh among them — do not levy Professional Tax at all; confirm
          your own branch&rsquo;s registration status before assuming a State on this list should
          show a liability. Punjab is <em>not</em> on that list even though it is commonly
          mis-summarised as PT-free elsewhere: it levies an equivalent tax under the Punjab State
          Development Tax Act, 2018 (same Rs&nbsp;2,500/year Article&nbsp;276 cap, same
          employer-deduction mechanic, a different name), so a liability against a Punjab branch is
          expected, not a data-entry mistake.
        </p>
        <p>
          <strong className="font-medium text-ink">Challan tracking — a real gap, not hidden.</strong>{" "}
          <Link href={`/${companyId}/tax-payments`} className="underline">
            Tax payments
          </Link>{" "}
          — the app&rsquo;s one challan register — currently classifies a deposit as Income tax, TDS,
          TCS or GST only; it has no Professional Tax category yet, so a PT challan recorded there
          today cannot be tagged or reported as PT specifically. &ldquo;Record a payment&rdquo; above
          still opens it, in case you want to keep a note there in the meantime, but this is a known
          limitation, not an oversight — adding a Professional Tax category to that shared table is
          a small change intentionally left for its own, single-owner migration.
        </p>
      </div>
    </ReportShell>
  );
}
