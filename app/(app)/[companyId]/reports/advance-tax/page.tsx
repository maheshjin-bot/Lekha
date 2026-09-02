import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The calendar April-March tax year containing today's local date. Same
 * convention as /reports/income-tax: the advance tax instalment dates are
 * statutory to the Apr-Mar year regardless of a company's book year.
 */
function taxYearBounds(): { from: string; to: string; label: string } {
  const today = todayLocal();
  const [y, m] = today.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return {
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
  };
}

function formatDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

type Row = {
  row_kind: "summary" | "instalment";
  applicable: boolean;
  entity_type: string | null;
  sec208_applicable: boolean | null;
  advance_tax_liability_estimate: number | null;
  liability_estimate_basis: string | null;
  instalment_no: number | null;
  instalment_label: string | null;
  due_date: string | null;
  is_due: boolean | null;
  cumulative_percent_required: number | null;
  cumulative_amount_required: number | null;
  cumulative_amount_paid: number | null;
  shortfall_amount: number | null;
  safe_harbour_percent: number | null;
  sec234c_interest: number | null;
  sec234c_note: string | null;
  total_advance_tax_paid_for_year: number | null;
  sec234b_shortfall: number | null;
  sec234b_months: number | null;
  sec234b_interest: number | null;
  total_interest: number | null;
  as_of_date: string;
  notes: string | null;
};

export default async function AdvanceTaxPage({
  params,
}: PageProps<"/[companyId]/reports/advance-tax">) {
  const { companyId } = await params;
  const supabase = await createClient();
  const { from, to, label } = taxYearBounds();

  const { data: rows, error } = await supabase.rpc("get_advance_tax_status", {
    p_company_id: companyId,
    p_fy_end: to,
  });

  const period = `FY ${label} · ${from} to ${to} · calendar April–March tax year, not this company's book year`;

  if (error || !rows || rows.length === 0) {
    return (
      <ReportShell title="Advance tax" period={period}>
        <p className="px-4 py-12 text-center text-ink-faint">
          {error ? error.message : "Company not found."}
        </p>
      </ReportShell>
    );
  }

  const typedRows = rows as Row[];
  const summary = typedRows.find((r) => r.row_kind === "summary");
  const instalments = typedRows
    .filter((r) => r.row_kind === "instalment")
    .sort((a, b) => (a.instalment_no ?? 0) - (b.instalment_no ?? 0));

  if (!summary || !summary.applicable) {
    return (
      <ReportShell title="Advance tax" period={period}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">Not applicable</p>
          <p className="mt-1">{summary?.notes ?? "This entity type is not computed."}</p>
        </div>
      </ReportShell>
    );
  }

  if (!summary.sec208_applicable) {
    return (
      <ReportShell title="Advance tax" period={period}>
        <div className="m-4 rounded-md bg-success-soft px-4 py-3 text-sm text-success">
          <p className="font-semibold">No advance tax obligation</p>
          <p className="mt-1">{summary.notes}</p>
        </div>
      </ReportShell>
    );
  }

  const totalInterest = Number(summary.total_interest ?? 0);

  return (
    <ReportShell
      title="Advance tax"
      period={period}
      status={{
        label:
          totalInterest > 0
            ? `${formatINR(totalInterest, { showZero: true })} interest so far`
            : "On track",
        tone: totalInterest > 0 ? "warn" : "ok",
      }}
    >
      <div className="border-b border-border px-4 py-3 text-sm">
        <p>
          Estimated annual liability (net of TDS/TCS credit):{" "}
          <strong className="font-semibold text-ink">
            {formatINR(Number(summary.advance_tax_liability_estimate ?? 0), { showZero: true })}
          </strong>
        </p>
        <p className="mt-1 text-xs text-ink-faint">{summary.liability_estimate_basis}</p>
      </div>

      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Instalment</th>
            <th className={th}>Due date</th>
            <th className={th + " text-right"}>Cumulative %</th>
            <th className={th + " text-right"}>Required</th>
            <th className={th + " text-right"}>Paid by due date</th>
            <th className={th + " text-right"}>Shortfall</th>
            <th className={th + " text-right"}>Sec 234C interest</th>
            <th className={th}>Note</th>
          </tr>
        </thead>
        <tbody>
          {instalments.map((r) => (
            <tr
              key={r.instalment_no}
              className={
                "border-b border-border last:border-0" +
                (r.is_due && Number(r.sec234c_interest ?? 0) > 0 ? " bg-error-soft" : "")
              }
            >
              <td className={td}>
                {r.instalment_label}
                {r.safe_harbour_percent != null && (
                  <div className="text-xs text-ink-faint">
                    Safe harbour: {Number(r.safe_harbour_percent)}%
                  </div>
                )}
              </td>
              <td className={td}>
                {r.due_date && formatDate(r.due_date)}{" "}
                {!r.is_due && (
                  <Badge tone="neutral" className="ml-1">
                    Not yet due
                  </Badge>
                )}
              </td>
              <td className={num}>{Number(r.cumulative_percent_required)}%</td>
              <td className={num}>
                {formatINR(Number(r.cumulative_amount_required), { showZero: true })}
              </td>
              <td className={num}>
                {formatINR(Number(r.cumulative_amount_paid), { showZero: true })}
              </td>
              <td className={num}>
                {r.shortfall_amount == null
                  ? "—"
                  : formatINR(Number(r.shortfall_amount), { showZero: true })}
              </td>
              <td className={num}>
                {formatINR(Number(r.sec234c_interest ?? 0), { showZero: true })}
              </td>
              <td className={td + " text-xs text-ink-faint"}>{r.sec234c_note}</td>
            </tr>
          ))}
          <tr className="border-b border-border bg-bg">
            <td className={td + " font-semibold"} colSpan={6}>
              Sec 234B — shortfall in advance tax paid overall by year end
            </td>
            <td className={num + " font-semibold"}>
              {formatINR(Number(summary.sec234b_interest ?? 0), { showZero: true })}
            </td>
            <td className={td + " text-xs text-ink-faint"}>
              {Number(summary.sec234b_months ?? 0) > 0
                ? `${summary.sec234b_months} month(s) at 1% on ${formatINR(
                    Number(summary.sec234b_shortfall ?? 0),
                    { showZero: true }
                  )}, from 1 April following the year`
                : "Not yet accruing — the year has not ended, or 90% of the estimate is already paid."}
            </td>
          </tr>
          <tr className="bg-warning-soft">
            <td className={td + " text-base font-bold"} colSpan={6}>
              Total interest to date (
              {formatDate(summary.as_of_date)})
            </td>
            <td className={num + " text-base font-bold"}>
              {formatINR(totalInterest, { showZero: true })}
            </td>
            <td className={td}></td>
          </tr>
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Advance tax paid — total for the year:{" "}
        <strong className="font-medium text-ink">
          {formatINR(Number(summary.total_advance_tax_paid_for_year ?? 0), { showZero: true })}
        </strong>
        . Recorded as income tax challans, minor head 100, on{" "}
        <Link href={`/${companyId}/tax-payments`} className="underline">
          Tax payments
        </Link>
        — record a new instalment there, this screen only reads what has already been entered.
        LEKHA does not pay advance tax or talk to the e-filing portal: the instalment itself is paid
        on the income tax portal, and recorded here afterwards.
      </p>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">{summary.notes}</p>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        The required amount at each instalment is 15% / 45% / 75% / 100% of the estimated annual
        liability — the same schedule for every entity type since Finance Act 2016 (there is no
        longer a lighter first instalment for non-company assessees). Sec 234C gives a safe-harbour
        tolerance of 12% and 36% at the first two dates only: falling short of the 15%/45% headline
        figure but at or above the tolerance costs no interest, while falling short of the tolerance
        itself costs interest on the shortfall from the full headline figure, not from the tolerance
        line. See the{" "}
        <Link href={`/${companyId}/reports/income-tax`} className="underline">
          income tax computation
        </Link>{" "}
        for how the estimated liability itself is built up.
      </p>
    </ReportShell>
  );
}
