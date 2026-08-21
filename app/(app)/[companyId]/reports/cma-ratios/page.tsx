import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

type Row = {
  section: string;
  metric_code: string;
  metric_label: string;
  value: number | null;
  unit: string;
  benchmark: number | null;
  benchmark_note: string | null;
  is_healthy: boolean | null;
};

/**
 * A CMA line item is money, a ratio, a percentage, a day count or a multiple —
 * formatting it wrong is how a 5.45 current ratio reads as five and a half
 * rupees. The unit comes from the function itself rather than being inferred
 * from the metric name here, so a metric added later formats correctly with no
 * change on this side.
 */
function formatValue(v: number | null, unit: string): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  switch (unit) {
    case "inr":
      return formatINR(n, { showZero: true });
    case "percent":
      return `${n.toFixed(2)}%`;
    case "days":
      return `${Math.round(n)} days`;
    case "times":
      return `${n.toFixed(2)}×`;
    case "ratio":
    default:
      return n.toFixed(2);
  }
}

// Declared at module scope, not inside the page — four sections render through
// this, and a component re-created per render (react-hooks/static-components)
// would multiply with every call site. Same reasoning as the P&L report.
function Section({
  title,
  blurb,
  rows,
  showBenchmark,
}: {
  title: string;
  blurb: string;
  rows: Row[];
  showBenchmark?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="border-b border-t border-border p-4 first:border-t-0">
        <h2 className="font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-ink-faint">{blurb}</p>
      </div>
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Particulars</th>
            <th className={th + " text-right"}>Value</th>
            {showBenchmark && <th className={th + " text-right"}>Bank norm</th>}
            {showBenchmark && <th className={th}>Status</th>}
            <th className={th}>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.metric_code} className="border-b border-border last:border-0">
              <td className={td}>{r.metric_label}</td>
              <td className={num + " font-medium"}>{formatValue(r.value, r.unit)}</td>
              {showBenchmark && (
                <td className={num + " text-ink-faint"}>
                  {r.benchmark === null ? "—" : formatValue(r.benchmark, r.unit)}
                </td>
              )}
              {showBenchmark && (
                <td className={td}>
                  {r.is_healthy === null ? (
                    <span className="text-xs text-ink-faint">—</span>
                  ) : r.is_healthy ? (
                    <Badge tone="ok">Meets</Badge>
                  ) : (
                    <Badge tone="warn">Below</Badge>
                  )}
                </td>
              )}
              <td className={td + " text-xs text-ink-faint"}>{r.benchmark_note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export default async function CmaRatiosPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/cma-ratios">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: profile } = await supabase.rpc("get_company_profile", {
    p_company_id: companyId,
  });
  const company = profile?.[0];

  // CMA follows the company's OWN financial year — a bank reads it against the
  // audited financials, not against the Income-tax Act's tax year (which is
  // why this differs from the Tax audit report's deliberate override).
  const period = defaultPeriod(company?.financial_year_start_month ?? 4, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  const { data } = await supabase.rpc("get_cma_ratios", {
    p_company_id: companyId,
    p_fy_start: period.from,
    p_fy_end: period.to,
  });

  const rows = (data ?? []) as Row[];
  const bySection = (s: string) => rows.filter((r) => r.section === s);

  const sanctioned = rows.find((r) => r.metric_code === "sanctioned")?.value ?? 0;

  // Only ratios carry a benchmark, so only they can fail one. Counting the
  // explicit false (not just "not true") keeps a not-computable ratio — DSCR
  // with no interest ledger — out of the failure count entirely.
  const breaches = rows.filter((r) => r.is_healthy === false).length;

  return (
    <ReportShell
      title="CMA data & ratios"
      period={`${period.label} · lender pack, not a filing`}
      status={{
        label:
          breaches === 0
            ? "All bank norms met"
            : `${breaches} ${breaches === 1 ? "norm" : "norms"} below benchmark`,
        tone: breaches === 0 ? "ok" : "warn",
      }}
    >
      <Section
        title="Balance sheet — as at period end"
        blurb="The aggregates a CMA pack is built from. Bank borrowing is separated out of current liabilities because MPBF is computed against the rest."
        rows={bySection("balance_sheet")}
      />

      <Section
        title="Operating statement — for the period"
        blurb="CMA Form I. Interest and depreciation are matched on ledger name; if your chart of accounts names them differently, the coverage ratios below will not compute."
        rows={bySection("operating")}
      />

      <Section
        title="Ratios"
        blurb="Measured against the benchmarks Indian banks commonly apply for working-capital limits."
        rows={bySection("ratio")}
        showBenchmark
      />

      <Section
        title="Working capital assessment — MPBF"
        blurb="Tandon Committee methods. Method II is the stricter test and the one banks sanction against."
        rows={bySection("mpbf")}
        showBenchmark
      />

      {sanctioned === 0 && (
        <div className="border-t border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          No banking facility is on record, so the sanctioned limit reads zero and
          the headroom figure is just Method II itself. Add your CC/OD sanction
          under{" "}
          <Link href={`/${companyId}/settings`} className="underline">
            Settings → Bank facility
          </Link>{" "}
          to compare properly.
        </div>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        CMA (Credit Monitoring Analysis) data is what a bank asks for at sanction
        and at renewal, typically for limits above ₹10 lakh. Everything here is
        computed from your own posted ledger — nothing is estimated or filled in.
        <strong className="font-medium"> This is the audited column only.</strong> A
        full CMA pack also carries two prior years and three projected years;
        projections are your own forecast, not a fact derivable from the books, so
        they are left to you and your CA. The fund flow statement (Form V) and the
        cash-budget method are not produced. Net worth absorbs the current
        period&rsquo;s profit or loss, which year-end closing has not yet moved to
        reserves — so it matches the Balance Sheet, not the capital ledgers alone.
        DSCR here is interest-only: scheduled principal repayment is not tracked
        anywhere in this app, so your true DSCR will be <em>lower</em> than shown.
        Not submitted anywhere — hand this to your bank, do not treat it as filed.
      </p>
    </ReportShell>
  );
}
