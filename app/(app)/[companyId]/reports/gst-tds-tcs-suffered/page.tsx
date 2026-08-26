import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { GstTdsTcsSufferedManager, type SufferedEntry } from "@/components/gst/GstTdsTcsSufferedManager";

/** The Apr-Mar GST/income-tax financial year label containing today's local
 * date — same convention as reports/tds-credit-match/page.tsx, deliberately
 * independent of this company's own book year (financial_year_start_month). */
function currentFyLabel(): string {
  const today = new Date();
  const y = today.getFullYear();
  const startYear = today.getMonth() + 1 >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function shiftFyLabel(label: string, delta: number): string {
  const startYear = Number(label.slice(0, 4)) + delta;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

type SummaryRow = {
  source_type: "sec51_tds" | "sec52_tcs";
  deductor_or_operator_gstin: string;
  deductor_or_operator_name: string;
  entry_count: number;
  taxable_value_total: number;
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  total_credit: number;
  claimed_count: number;
  unclaimed_count: number;
  unclaimed_credit: number;
};

const SOURCE_LABEL: Record<string, string> = {
  sec51_tds: "Sec 51 TDS (govt/PSU deductor)",
  sec52_tcs: "Sec 52 TCS (e-commerce operator)",
};

export default async function GstTdsTcsSufferedPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/gst-tds-tcs-suffered">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const fyParam = typeof sp.fy === "string" && /^\d{4}-\d{2}$/.test(sp.fy) ? sp.fy : currentFyLabel();
  const regParam = typeof sp.reg === "string" ? sp.reg : undefined;

  const { data: registrations } = await supabase
    .from("gst_registrations")
    .select("id, gstin, state_code")
    .eq("company_id", companyId)
    .order("gstin");
  const regs = registrations ?? [];
  const regId = regParam || regs[0]?.id;

  const { data: entries, error: entriesError } = regId
    ? await supabase
        .from("gst_tds_tcs_suffered")
        .select(
          "id, source_type, deductor_or_operator_gstin, deductor_or_operator_name, period_label, financial_year_label, taxable_value, cgst_amount, sgst_amount, igst_amount, claimed_in_gstr3b, notes"
        )
        .eq("company_id", companyId)
        .eq("gst_registration_id", regId)
        .eq("financial_year_label", fyParam)
        .order("period_label", { ascending: false })
    : { data: [] as SufferedEntry[], error: null };

  const { data: summaryRows, error: summaryError } = regId
    ? await supabase.rpc("get_gst_tds_tcs_suffered_summary", {
        p_company_id: companyId,
        p_gst_registration_id: regId,
        p_financial_year_label: fyParam,
      })
    : { data: [] as SummaryRow[], error: null };

  const summary = (summaryRows ?? []) as SummaryRow[];
  const sec51 = summary.filter((r) => r.source_type === "sec51_tds");
  const sec52 = summary.filter((r) => r.source_type === "sec52_tcs");
  const totalCredit = summary.reduce((n, r) => n + Number(r.total_credit ?? 0), 0);
  const totalUnclaimed = summary.reduce((n, r) => n + Number(r.unclaimed_credit ?? 0), 0);

  const base = `/${companyId}/reports/gst-tds-tcs-suffered`;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">GST TDS/TCS suffered</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Sec 51 GST TDS deducted by a government/PSU buyer, and Sec 52 GST TCS collected by an e-commerce
          operator, on this company&rsquo;s own supplies — tracked here as this company&rsquo;s claim, not the
          deductor/operator&rsquo;s own GSTR-7/GSTR-8 filing (this app has almost no users who are themselves a
          Sec 51 deductor or Sec 52 operator).
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-border bg-surface p-3">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`${base}?fy=${shiftFyLabel(fyParam, -1)}&reg=${regId ?? ""}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            ← Prev year
          </Link>
          <span className="px-2 font-medium">FY {fyParam}</span>
          <Link href={`${base}?fy=${shiftFyLabel(fyParam, 1)}&reg=${regId ?? ""}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            Next year →
          </Link>
        </div>
        {regs.length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            {regs.map((r) => (
              <Link
                key={r.id}
                href={`${base}?fy=${fyParam}&reg=${r.id}`}
                className={
                  "rounded-md border px-2.5 py-1 font-mono text-xs " +
                  (regId === r.id ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
                }
              >
                {r.gstin}
              </Link>
            ))}
          </div>
        )}
      </div>

      {!regId && (
        <div className="mb-6 rounded-[14px] border border-border bg-warning-soft px-4 py-3 text-sm text-ink">
          This company has no GST registration yet — a Sec 51/52 credit belongs to a specific GSTIN&rsquo;s
          electronic cash ledger, so nothing can be recorded until one exists.
        </div>
      )}

      {entriesError && <p className="mb-4 text-sm text-error">{entriesError.message}</p>}

      {regId && (
        <div className="mb-10">
          <GstTdsTcsSufferedManager companyId={companyId} gstRegistrationId={regId} entries={(entries ?? []) as SufferedEntry[]} />
        </div>
      )}

      <ReportShell
        title="Suffered credit summary"
        period={`FY ${fyParam}${regs.find((r) => r.id === regId) ? " · " + regs.find((r) => r.id === regId)!.gstin : ""} · grouped by source and deductor/operator`}
        status={
          summary.length > 0
            ? {
                label:
                  totalUnclaimed > 0
                    ? `${formatINR(totalUnclaimed, { showZero: true })} not yet claimed`
                    : `${formatINR(totalCredit, { showZero: true })} total credit`,
                tone: totalUnclaimed > 0 ? "warn" : "ok",
              }
            : { label: "Nothing recorded", tone: "warn" }
        }
      >
        {summaryError && <p className="p-4 text-sm text-error">{summaryError.message}</p>}

        {[
          { key: "sec51_tds", rows: sec51 },
          { key: "sec52_tcs", rows: sec52 },
        ].map(({ key, rows }) => (
          <div key={key}>
            <div className="border-b border-t border-border bg-surface-2 px-4 py-2">
              <h2 className="text-sm font-semibold">{SOURCE_LABEL[key]}</h2>
            </div>
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className={th}>{key === "sec51_tds" ? "Deductor" : "Operator"}</th>
                  <th className={th}>GSTIN</th>
                  <th className={th + " text-right"}>Entries</th>
                  <th className={th + " text-right"}>Taxable value</th>
                  <th className={th + " text-right"}>CGST</th>
                  <th className={th + " text-right"}>SGST</th>
                  <th className={th + " text-right"}>IGST</th>
                  <th className={th + " text-right"}>Total credit</th>
                  <th className={th + " text-right"}>Not yet claimed</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-6 text-center text-ink-faint">
                      Nothing recorded.
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => (
                  <tr key={`${key}-${i}`} className="border-b border-border last:border-0">
                    <td className={td}>{r.deductor_or_operator_name}</td>
                    <td className={td + " font-mono text-xs"}>{r.deductor_or_operator_gstin}</td>
                    <td className={num}>{r.entry_count}</td>
                    <td className={num}>{formatINR(Number(r.taxable_value_total), { showZero: true })}</td>
                    <td className={num}>{formatINR(Number(r.cgst_total), { showZero: true })}</td>
                    <td className={num}>{formatINR(Number(r.sgst_total), { showZero: true })}</td>
                    <td className={num}>{formatINR(Number(r.igst_total), { showZero: true })}</td>
                    <td className={num}>{formatINR(Number(r.total_credit), { showZero: true })}</td>
                    <td className={num + (Number(r.unclaimed_credit) > 0 ? " text-warning" : "")}>
                      {formatINR(Number(r.unclaimed_credit), { showZero: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          Sec 51 GST TDS: 2% of the payment (1% CGST + 1% SGST, or 2% IGST) deducted by a government
          department/PSU/notified buyer on a single contract exceeding Rs 2.5 lakh. Sec 52 GST TCS: currently
          0.5% of net taxable supplies (0.25% CGST + 0.25% SGST, or 0.5% IGST) collected by an e-commerce
          operator — reduced from 1% w.e.f. 10-Jul-2024 (CBIC Notification 15/2024-CT), so a pre-Jul-2024
          period legitimately carries the older figures. Both are manually recorded from the GST portal&rsquo;s
          own &ldquo;TDS and TCS Credit Received&rdquo; statement (auto-populated there from the deductor&rsquo;s
          GSTR-7 / operator&rsquo;s GSTR-8) — not GSTR-2A/2B, and not fetched automatically here. No ledger
          posting: claimed_in_gstr3b is a status flag the preparer sets, not a computed balance.
        </p>
      </ReportShell>
    </main>
  );
}
