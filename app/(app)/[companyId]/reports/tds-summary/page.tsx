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
 * TDS returns run on the Indian FY quarter (Apr-Jun, Jul-Sep, Oct-Dec,
 * Jan-Mar) — not the calendar month GST uses. `q` is "YYYY-Q1".."YYYY-Q4"
 * where YYYY is the FY-starting calendar year (e.g. Jan-Mar 2027 is
 * "2026-Q4", the fourth quarter of FY 2026-27) — defaults to the quarter
 * containing today.
 */
function quarterBounds(q?: string): { from: string; to: string; label: string; qkey: string } {
  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  // FY-starting year: Jan-Mar belongs to the FY that started the PRIOR
  // calendar year.
  let fyStart = tm >= 4 ? ty : ty - 1;
  let qNum = tm >= 4 ? Math.floor((tm - 4) / 3) + 1 : 4;

  if (q && /^\d{4}-Q[1-4]$/.test(q)) {
    fyStart = Number(q.slice(0, 4));
    qNum = Number(q.slice(6, 7));
  }

  // Q1 = Apr-Jun of fyStart, Q2 = Jul-Sep, Q3 = Oct-Dec, Q4 = Jan-Mar of fyStart+1.
  const startMonth = 4 + (qNum - 1) * 3; // 4, 7, 10, 13
  const startYear = fyStart + Math.floor((startMonth - 1) / 12);
  const startMonthNorm = ((startMonth - 1) % 12) + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const from = `${startYear}-${pad(startMonthNorm)}-01`;
  const endMonthNorm0 = startMonthNorm + 2; // last month of the quarter, 1-based, possibly >12
  const endYear = startYear + Math.floor((endMonthNorm0 - 1) / 12);
  const endMonthNorm = ((endMonthNorm0 - 1) % 12) + 1;
  const lastDay = new Date(Date.UTC(endYear, endMonthNorm, 0)).getUTCDate();
  const to = `${endYear}-${pad(endMonthNorm)}-${pad(lastDay)}`;
  const label = `Q${qNum} FY ${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")} (${from} to ${to})`;
  return { from, to, label, qkey: `${fyStart}-Q${qNum}` };
}

function shiftQuarter(qkey: string, delta: number): string {
  const fyStart = Number(qkey.slice(0, 4));
  const qNum = Number(qkey.slice(6, 7));
  const total = fyStart * 4 + (qNum - 1) + delta;
  const newFyStart = Math.floor(total / 4);
  const newQNum = (total % 4) + 1;
  return `${newFyStart}-Q${newQNum}`;
}

type SummaryRow = {
  deductee_ledger_id: string | null;
  deductee_name: string;
  pan: string | null;
  section_code: string | null;
  section_description: string | null;
  section_rate_percent: number | null;
  voucher_count: number;
  tds_deducted: number;
  party_ledger_movement: number;
};

function SummaryTable({ rows }: { rows: SummaryRow[] }) {
  const total = rows.reduce((n, r) => n + Number(r.tds_deducted), 0);
  return (
    <table className="w-full min-w-[920px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Deductee</th>
          <th className={th}>PAN</th>
          <th className={th}>Section</th>
          <th className={th + " text-right"}>Rate</th>
          <th className={th + " text-right"}>Vouchers</th>
          <th className={th + " text-right"}>Party ledger movement</th>
          <th className={th + " text-right"}>TDS deducted</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
              No TDS deductions this quarter.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr key={r.deductee_ledger_id ?? "unattributed"} className="border-b border-border last:border-0">
            <td className={td}>
              {r.deductee_ledger_id ? (
                r.deductee_name
              ) : (
                <span className="text-warning">{r.deductee_name}</span>
              )}
            </td>
            <td className={td + " font-mono text-xs text-ink-faint"}>{r.pan ?? "—"}</td>
            <td className={td + " font-mono text-xs"}>{r.section_code ?? "—"}</td>
            <td className={num}>{r.section_rate_percent != null ? `${Number(r.section_rate_percent)}%` : "—"}</td>
            <td className={num}>{r.voucher_count}</td>
            <td className={num}>{formatINR(Number(r.party_ledger_movement), { showZero: true })}</td>
            <td className={num + " font-medium"}>{formatINR(Number(r.tds_deducted), { showZero: true })}</td>
          </tr>
        ))}
        {rows.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={6}>
              Total
            </td>
            <td className={num}>{formatINR(total, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default async function TdsSummaryPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/tds-summary">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const qParam = typeof sp.q === "string" ? sp.q : undefined;
  const { from, to, label, qkey } = quarterBounds(qParam);

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const tdsOn = (modules ?? []).some((m) => m.code === "tds" && m.active);

  if (!tdsOn) {
    return (
      <ReportShell title="TDS summary" period={label}>
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

  const { data: rows } = await supabase.rpc("get_tds_deductee_summary", {
    p_company_id: companyId,
    p_period_start: from,
    p_period_end: to,
  });

  const summary = (rows ?? []) as SummaryRow[];
  const attributed = summary.filter((r) => r.deductee_ledger_id);
  const unattributed = summary.filter((r) => !r.deductee_ledger_id);
  const totalTds = summary.reduce((n, r) => n + Number(r.tds_deducted), 0);
  const unattributedTds = unattributed.reduce((n, r) => n + Number(r.tds_deducted), 0);

  const base = `/${companyId}/reports/tds-summary`;

  return (
    <ReportShell
      title="TDS summary"
      period={`${label} · Form 140 (was 26Q) Annexure I precursor, not a filing`}
      status={{
        label: `${formatINR(totalTds, { showZero: true })} TDS deducted`,
        tone: unattributedTds > 0 ? "warn" : "ok",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`${base}?q=${shiftQuarter(qkey, -1)}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link
            href={`${base}?q=${shiftQuarter(qkey, 1)}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            Next →
          </Link>
        </div>
      </div>

      <div className="border-b border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Deductee-wise TDS <Badge tone="neutral">quarterly</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every TDS deduction this quarter, attributed to a deductee when exactly one
          TDS-deductee-flagged ledger appears on the same voucher.
        </p>
      </div>
      <SummaryTable rows={attributed} />

      {unattributed.length > 0 && (
        <>
          <div className="border-b border-t border-border bg-warning-soft p-4">
            <h2 className="flex items-center gap-2 font-semibold text-warning">
              Needs review — could not attribute a single deductee
            </h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              These vouchers had a TDS Payable line but zero or more than one ledger flagged
              as a TDS deductee on the same voucher, so LEKHA cannot tell who the deduction
              was against without guessing. Open each voucher directly to confirm.
            </p>
          </div>
          <SummaryTable rows={unattributed} />
        </>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Form 140 (was Form 26Q under the 1961 Act) Annexure I precursor — deductee-wise
        breakup of TDS on payments other than salary. TDS deducted is read back from actual
        credit-side postings on the TDS Payable ledger (a later payment to the government is
        a debit on the same ledger and is correctly excluded, not double-counted). Section and
        PAN reflect the deductee ledger&rsquo;s CURRENT master data — not necessarily what was
        true on the historical voucher date, since neither is stored per-voucher in this
        schema. &ldquo;Party ledger movement&rdquo; is the deductee&rsquo;s own actual line
        amount in the same voucher(s) — not a computed gross invoice value, which this schema
        cannot reliably derive for every voucher shape. Threshold applicability (has this
        deductee crossed the limit that makes TDS deductible at all) and challan/remittance
        detail (BSR code, deposit date) are not tracked. Sec 192 salary TDS has its own
        estimate — see Reports → Payroll register. Not a filing-ready return, and nothing
        here is submitted anywhere — LEKHA has no TRACES API access.
      </p>
    </ReportShell>
  );
}
