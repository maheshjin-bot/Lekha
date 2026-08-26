import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { formatINR } from "@/lib/utils/currency";

const STATUS_BADGE: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  generated: { label: "Generated", tone: "ok" },
  not_generated: { label: "Capture started", tone: "warn" },
  pending: { label: "Action needed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  not_required: { label: "Not required", tone: "neutral" },
};

type Row = {
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  party_name: string | null;
  consignment_value: number;
  is_ewb_required: boolean;
  ewb_id: string | null;
  transport_mode: string | null;
  vehicle_number: string | null;
  ewb_number: string | null;
  ewb_generated_date: string | null;
  ewb_valid_until: string | null;
  status: string;
};

/**
 * The hub: every sales voucher over the ₹50,000 Rule 138 consignment-value
 * threshold (get_ewb_requirement, 0190), plus any voucher someone already
 * started capturing ship-to/transport details for regardless of value.
 * Never touches InvoiceForm/create_invoice — a row's own "Open" link is the
 * only way in, reached here or from the sales invoice list.
 */
export default async function EwayBillHubPage({
  params,
}: PageProps<"/[companyId]/eway-bill">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: rows, error } = await supabase.rpc("get_ewb_status", {
    p_company_id: companyId,
  });

  const list = (rows ?? []) as Row[];
  const pendingCount = list.filter((r) => r.status === "pending").length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">e-Way Bill</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          Ship-to and transporter/vehicle capture for sales invoices whose consignment value crosses the
          ₹50,000 Rule 138 threshold, an EWB-01-shaped JSON payload you can hand to the NIC portal or your GSP,
          and a place to record the real e-Way Bill number once you have it. This app does not call the NIC
          e-Way Bill API itself — that needs GSP credentials or direct NIC enrolment this app does not have.
        </p>
        {pendingCount > 0 && (
          <p className="mt-3">
            <Badge tone="bad">
              {pendingCount} invoice{pendingCount === 1 ? "" : "s"} over threshold with nothing captured yet
            </Badge>
          </p>
        )}
      </header>

      {error && (
        <p className="mb-4 rounded-lg bg-error-soft px-3 py-2 text-sm text-error">{error.message}</p>
      )}

      {list.length === 0 ? (
        <EmptyState>No sales invoice has crossed the ₹50,000 e-Way Bill threshold yet.</EmptyState>
      ) : (
        <TableContainer>
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr>
                <th className={th}>Invoice</th>
                <th className={th}>Party</th>
                <th className={th}>Consignment value</th>
                <th className={th}>Vehicle</th>
                <th className={th}>EWB number</th>
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
                        href={`/${companyId}/eway-bill/${r.voucher_id}`}
                        className="text-accent underline underline-offset-4"
                      >
                        {r.voucher_number}
                      </Link>
                      <div className="text-xs text-ink-faint">{r.voucher_date}</div>
                    </td>
                    <td className={td}>{r.party_name ?? <span className="text-ink-faint">—</span>}</td>
                    <td className={num}>{formatINR(Number(r.consignment_value))}</td>
                    <td className={td}>
                      {r.vehicle_number ?? <span className="text-ink-faint">—</span>}
                      {r.transport_mode && <div className="text-xs text-ink-faint capitalize">{r.transport_mode}</div>}
                    </td>
                    <td className={td + " font-mono text-xs"}>
                      {r.ewb_number ?? <span className="font-sans text-ink-faint">—</span>}
                    </td>
                    <td className={td}>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableContainer>
      )}

      <p className="mt-6 max-w-2xl text-xs text-ink-faint">
        Flagged against the national ₹50,000 floor only (CGST Rule 138(1), Explanation 2 — consignment value
        includes GST but excludes TCS and, on a mixed invoice, the value of any exempt/nil-rated line). Some
        states set a higher intra-state threshold this list does not model, so a row here may show as required
        slightly earlier than your state strictly demands — deliberately conservative, never the reverse.
      </p>
    </main>
  );
}
