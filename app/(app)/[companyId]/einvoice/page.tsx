import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { formatINR } from "@/lib/utils/currency";
import { TableContainer, th, td } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";

const STATUS_BADGE: Record<string, { label: string; tone: "ok" | "warn" | "neutral" }> = {
  irn_obtained: { label: "IRN obtained", tone: "ok" },
  json_ready: { label: "JSON ready", tone: "warn" },
  not_generated: { label: "Not generated", tone: "neutral" },
};

const SUPPLY_LABEL: Record<string, string> = {
  intra: "B2B (intra-state)",
  inter: "B2B (inter-state)",
  export_lut: "Export (LUT, no tax)",
  export_igst: "Export (IGST paid)",
  sez: "SEZ",
  deemed_export: "Deemed export",
};

type Applicability = {
  is_applicable: boolean;
  threshold_amount: number;
  triggering_fy_label: string | null;
  triggering_fy_turnover: number | null;
  highest_completed_fy_label: string | null;
  highest_completed_fy_turnover: number | null;
  current_fy_label: string | null;
  current_fy_turnover_to_date: number | null;
  note: string;
};

type StatusRow = {
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  voucher_type: string;
  party_name: string | null;
  party_gstin: string | null;
  supply_type: string;
  total_amount: number;
  status: string;
  irn: string | null;
};

/**
 * The hub: e-invoice (IRN) applicability for this company (0230's AATO
 * check), and every sales invoice / credit note e-invoicing actually
 * covers, with its current build/IRN status. New entries are not added
 * here — they're reached from the Sales Invoices / Sales Returns lists'
 * own "e-Invoice" link per row (see DaybookTable), the same
 * addendum-from-an-existing-record pattern the EXIM hub (0119) already
 * established.
 */
export default async function EinvoiceHubPage({
  params,
}: PageProps<"/[companyId]/einvoice">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: applicabilityRows, error: applicabilityError }, { data: statusRows, error: statusError }] =
    await Promise.all([
      callRpc<{ p_company_id: string }, Applicability[]>(supabase, "get_einvoice_applicability", {
        p_company_id: companyId,
      }),
      callRpc<{ p_company_id: string }, StatusRow[]>(supabase, "get_einvoice_status", {
        p_company_id: companyId,
      }),
    ]);

  const applicability = applicabilityRows?.[0] ?? null;
  const list = statusRows ?? [];

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">e-Invoice (IRN)</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          Whether e-invoicing applies to this company, and — for every sales invoice or credit note it actually
          covers — a NIC-schema JSON payload this app can assemble for you to submit through a GSP or the NIC
          offline utility. This app never calls an Invoice Registration Portal itself.
        </p>
        <p className="mt-1.5 text-sm text-ink-soft">
          To add or edit one, open the invoice from{" "}
          <Link href={`/${companyId}/reports/sales-invoices`} className="text-accent underline underline-offset-4">
            Sales Invoices
          </Link>{" "}
          or{" "}
          <Link href={`/${companyId}/reports/sales-returns`} className="text-accent underline underline-offset-4">
            Sales Returns
          </Link>{" "}
          and use its &ldquo;e-Invoice&rdquo; link.
        </p>
      </header>

      {applicabilityError && (
        <p className="mb-4 rounded-lg bg-error-soft px-3 py-2 text-sm text-error">{applicabilityError.message}</p>
      )}
      {applicability && (
        <div className="mb-8 rounded-[14px] border border-border bg-surface p-5 shadow-card">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={applicability.is_applicable ? "ok" : "neutral"}>
              {applicability.is_applicable ? "Mandatory" : "Not yet mandatory"}
            </Badge>
            <p className="text-sm text-ink">
              {applicability.is_applicable ? (
                <>
                  Aggregate turnover crossed {formatINR(applicability.threshold_amount, { showZero: true })} in FY{" "}
                  {applicability.triggering_fy_label} ({formatINR(applicability.triggering_fy_turnover ?? 0, { showZero: true })}) —
                  e-invoicing has applied to every GSTIN under this PAN since, and stays mandatory permanently even if
                  turnover later dips below the threshold.
                </>
              ) : (
                <>
                  Highest completed-year turnover so far is{" "}
                  {formatINR(applicability.highest_completed_fy_turnover ?? 0, { showZero: true })}
                  {applicability.highest_completed_fy_label ? ` (FY ${applicability.highest_completed_fy_label})` : ""}, below the{" "}
                  {formatINR(applicability.threshold_amount, { showZero: true })} threshold — not yet mandatory.
                  {applicability.current_fy_label &&
                    ` Current FY ${applicability.current_fy_label} stands at ${formatINR(applicability.current_fy_turnover_to_date ?? 0, { showZero: true })} so far.`}
                </>
              )}
            </p>
          </div>
          <p className="mt-2 text-xs text-ink-faint">{applicability.note}</p>
        </div>
      )}

      {statusError && (
        <p className="mb-4 rounded-lg bg-error-soft px-3 py-2 text-sm text-error">{statusError.message}</p>
      )}

      {list.length === 0 ? (
        <EmptyState>
          No sales invoice or credit note that e-invoicing covers yet (B2B, SEZ, deemed-export or export — a plain
          B2C sale is never eligible).
        </EmptyState>
      ) : (
        <TableContainer>
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr>
                <th className={th}>Voucher</th>
                <th className={th}>Party</th>
                <th className={th}>Supply type</th>
                <th className={th + " text-right"}>Amount</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const badge = STATUS_BADGE[r.status] ?? { label: r.status, tone: "neutral" as const };
                return (
                  <tr key={r.voucher_id}>
                    <td className={td}>
                      <Link
                        href={`/${companyId}/einvoice/${r.voucher_id}`}
                        className="text-accent underline underline-offset-4"
                      >
                        {r.voucher_number}
                      </Link>
                      <div className="text-xs text-ink-faint">
                        {r.voucher_date} · {r.voucher_type === "credit_note" ? "Credit note" : "Sales invoice"}
                      </div>
                    </td>
                    <td className={td}>
                      {r.party_name ?? <span className="text-ink-faint">—</span>}
                      {r.party_gstin && <div className="font-mono text-xs text-ink-faint">{r.party_gstin}</div>}
                    </td>
                    <td className={td}>{SUPPLY_LABEL[r.supply_type] ?? r.supply_type}</td>
                    <td className={td + " text-right font-mono tabular-nums"}>{formatINR(Number(r.total_amount))}</td>
                    <td className={td}>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                      {r.irn && <div className="mt-1 font-mono text-[10px] text-ink-faint">{r.irn.slice(0, 16)}…</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableContainer>
      )}

      <p className="mt-6 max-w-2xl text-xs text-ink-faint">
        This app assembles the NIC e-invoice JSON from a voucher it already posted and lets you record an
        IRN/QR once obtained elsewhere — it never submits anything to an IRP itself (that needs a paid GSP
        contract or NIC whitelisting this app does not have).
      </p>
    </main>
  );
}
