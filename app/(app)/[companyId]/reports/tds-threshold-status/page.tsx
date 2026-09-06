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

type StatusRow = {
  deductee_ledger_id: string;
  deductee_name: string;
  pan: string | null;
  section_code: string;
  section_description: string | null;
  rate_percent: number;
  financial_year_label: string;
  cumulative_credited_this_fy: number;
  largest_single_transaction: number;
  threshold_single_rupees: number | null;
  threshold_aggregate_rupees: number | null;
  single_threshold_crossed: boolean;
  aggregate_threshold_crossed: boolean;
  tds_applicable: boolean;
  taxable_basis_amount: number;
  basis_note: string;
};

function ThresholdCell({ value }: { value: number | null }) {
  return <td className={num}>{value == null ? "—" : formatINR(value, { showZero: true })}</td>;
}

export default async function TdsThresholdStatusPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/tds-threshold-status">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const asOf = typeof sp.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : todayLocal();

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const tdsOn = (modules ?? []).some((m) => m.code === "tds" && m.active);

  if (!tdsOn) {
    return (
      <ReportShell title="TDS threshold status" period={`As of ${asOf}`}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">TDS is not on for this company</p>
          <p className="mt-1">
            TDS activates once a TAN is set —{" "}
            <Link href={`/${companyId}/settings`} className="underline">
              Settings
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const { data: rows, error } = await supabase.rpc("get_tds_threshold_status_summary", {
    p_company_id: companyId,
    p_as_of: asOf,
  });

  const statusRows = (rows ?? []) as StatusRow[];
  const applicable = statusRows.filter((r) => r.tds_applicable);
  const fyLabel = statusRows[0]?.financial_year_label ?? "";

  const base = `/${companyId}/reports/tds-threshold-status`;

  return (
    <ReportShell
      title="TDS threshold status"
      period={`${fyLabel ? `FY ${fyLabel} · ` : ""}as of ${asOf} — advisory, not a filing`}
      status={{
        label:
          applicable.length > 0
            ? `${applicable.length} deductee${applicable.length === 1 ? "" : "s"} over threshold`
            : "nobody over threshold yet",
        tone: applicable.length > 0 ? "warn" : "ok",
      }}
    >
      <form method="get" className="flex flex-wrap items-center gap-2 border-b border-border p-4 text-sm">
        <label htmlFor="asOf" className="text-ink-soft">
          As of
        </label>
        <input
          id="asOf"
          name="asOf"
          type="date"
          defaultValue={asOf}
          className="field w-auto"
        />
        <button type="submit" className="rounded-md border border-border-strong px-3 py-1.5 hover:bg-surface-2">
          Recalculate
        </button>
        {asOf !== todayLocal() && (
          <Link href={base} className="text-xs text-accent underline underline-offset-2">
            Back to today
          </Link>
        )}
      </form>

      <div className="border-b border-border p-4">
        <h2 className="font-semibold">Every deductee with payment history this financial year</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Checked against each deductee ledger&rsquo;s own current TDS section, set under{" "}
          <Link href={`/${companyId}/ledgers`} className="underline">
            Ledgers
          </Link>
          . Cumulative figures are real credit-side voucher postings this FY up to the
          date above — not a computed &ldquo;gross invoice&rdquo; estimate. See the note below
          the table for exactly what is and isn&rsquo;t counted.
        </p>
      </div>

      {error && (
        <div className="m-4 rounded-md bg-error-soft px-4 py-3 text-sm text-error">
          Could not load threshold status: {error.message}
        </div>
      )}

      <table className="w-full min-w-[1180px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Deductee</th>
            <th className={th}>Section</th>
            <th className={th + " text-right"}>Rate</th>
            <th className={th + " text-right"}>Credited this FY</th>
            <th className={th + " text-right"}>Largest single txn</th>
            <th className={th + " text-right"}>Single-payment limit</th>
            <th className={th + " text-right"}>Aggregate limit</th>
            <th className={th + " text-right"}>Basis for TDS</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {statusRows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-4 py-10 text-center text-ink-faint">
                No deductee has any payment history yet this financial year.
              </td>
            </tr>
          )}
          {statusRows.map((r) => (
            <tr key={r.deductee_ledger_id} className="border-b border-border last:border-0 align-top">
              <td className={td}>
                <div className="font-medium">{r.deductee_name}</div>
                {r.pan && <div className="text-xs text-ink-faint">{r.pan}</div>}
              </td>
              <td className={td}>
                <div className="font-mono text-xs">{r.section_code}</div>
                {r.section_description && (
                  <div className="mt-0.5 max-w-xs text-xs text-ink-faint">{r.section_description}</div>
                )}
              </td>
              <td className={num}>{Number(r.rate_percent)}%</td>
              <td className={num + " font-medium"}>{formatINR(Number(r.cumulative_credited_this_fy), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.largest_single_transaction), { showZero: true })}</td>
              <ThresholdCell value={r.threshold_single_rupees != null ? Number(r.threshold_single_rupees) : null} />
              <ThresholdCell value={r.threshold_aggregate_rupees != null ? Number(r.threshold_aggregate_rupees) : null} />
              <td className={num}>
                {r.tds_applicable ? formatINR(Number(r.taxable_basis_amount), { showZero: true }) : "—"}
                {r.section_code === "194Q" && r.tds_applicable && (
                  <div className="text-xs text-ink-faint">excess over limit only</div>
                )}
              </td>
              <td className={td}>
                {r.tds_applicable ? (
                  <Badge tone="warn">TDS applicable</Badge>
                ) : (
                  <Badge tone="ok">Below threshold</Badge>
                )}
                {r.single_threshold_crossed && <div className="mt-1 text-xs text-ink-faint">single-payment limit crossed</div>}
                {r.aggregate_threshold_crossed && <div className="mt-1 text-xs text-ink-faint">aggregate limit crossed</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Advisory only — nothing here changes what a voucher posts. &ldquo;Credited this
        FY&rdquo; sums real credit-side postings to each deductee ledger from the start of its
        financial year up to the date above; a later payment settling that credit is correctly
        excluded (it is not a second amount), but a credit note/return is also excluded rather
        than netted, and a pure advance paid before any invoice exists is not counted at all —
        both stated gaps, not silent ones. Each deductee is checked against its OWN current
        default TDS section, set on the party&rsquo;s own record under{" "}
        <Link href={`/${companyId}/ledgers`} className="underline">
          Ledgers
        </Link>{" "}
        — a deductee genuinely liable under more than one section in the same year needs a
        manual check. &ldquo;Basis for TDS&rdquo; is the
        FULL cumulative amount for every section except 194Q, where the law taxes only the
        amount above the Rs 50 lakh limit — shown separately, not blended into the same column
        as the others. Sec 194Q&rsquo;s own buyer-turnover eligibility (&gt; Rs 10 crore in the
        preceding financial year) is not checked here. Nothing on this page is wired into
        voucher entry — see the sales/purchase voucher form&rsquo;s own TDS hint, which still
        does not check this.
      </p>
    </ReportShell>
  );
}
