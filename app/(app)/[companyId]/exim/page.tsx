import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { TableContainer, th, td } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";

const STATUS_BADGE: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  realised: { label: "Realised", tone: "ok" },
  pending: { label: "Pending", tone: "neutral" },
  overdue_unrealised: { label: "Overdue — no BRC", tone: "bad" },
  not_applicable: { label: "Not applicable", tone: "neutral" },
};

type Row = {
  shipment_id: string;
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  party_name: string | null;
  document_type: "shipping_bill" | "bill_of_entry";
  document_number: string;
  document_date: string;
  port_code: string;
  export_realisation_due_date: string | null;
  brc_number: string | null;
  realised_date: string | null;
  is_overdue: boolean;
  days_overdue: number;
  status: string;
};

/**
 * The hub: every voucher that has EXIM shipment details recorded, with the
 * FEMA realisation-risk status get_exim_realisation_status (0119) computes.
 * New entries are NOT added here — they're added from the sales/purchase
 * invoice list pages' own "EXIM" link per row (see DaybookTable), the same
 * addendum-from-an-existing-record pattern documents (0060) uses.
 */
export default async function EximHubPage({
  params,
}: PageProps<"/[companyId]/exim">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: rows, error } = await supabase.rpc("get_exim_realisation_status", {
    p_company_id: companyId,
  });

  const list = (rows ?? []) as Row[];
  const overdueCount = list.filter((r) => r.is_overdue).length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">EXIM shipments</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          Shipping bill, Bill of Entry and BRC facts attached to export/import vouchers, plus the FEMA
          Regulation 9(1) export-realisation clock — an export past its due date with no Bank Realisation
          Certificate recorded yet is a real compliance risk, flagged below.
        </p>
        <p className="mt-1.5 text-sm text-ink-soft">
          To add a new one, open the voucher from{" "}
          <Link href={`/${companyId}/reports/sales-invoices`} className="text-accent underline underline-offset-4">
            Sales Invoices
          </Link>{" "}
          or{" "}
          <Link href={`/${companyId}/reports/purchase-invoices`} className="text-accent underline underline-offset-4">
            Purchase Invoices
          </Link>{" "}
          and use its &ldquo;EXIM&rdquo; link.
        </p>
        {overdueCount > 0 && (
          <p className="mt-3">
            <Badge tone="bad">
              {overdueCount} export{overdueCount === 1 ? "" : "s"} overdue with no BRC
            </Badge>
          </p>
        )}
      </header>

      {error && (
        <p className="mb-4 rounded-lg bg-error-soft px-3 py-2 text-sm text-error">{error.message}</p>
      )}

      {list.length === 0 ? (
        <EmptyState>No EXIM shipment details recorded yet.</EmptyState>
      ) : (
        <TableContainer>
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr>
                <th className={th}>Voucher</th>
                <th className={th}>Party</th>
                <th className={th}>Document</th>
                <th className={th}>Port</th>
                <th className={th}>Realisation due</th>
                <th className={th}>BRC</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const badge = STATUS_BADGE[r.status] ?? { label: r.status, tone: "neutral" as const };
                return (
                  <tr key={r.shipment_id}>
                    <td className={td}>
                      <Link
                        href={`/${companyId}/exim/${r.voucher_id}`}
                        className="text-accent underline underline-offset-4"
                      >
                        {r.voucher_number}
                      </Link>
                      <div className="text-xs text-ink-faint">{r.voucher_date}</div>
                    </td>
                    <td className={td}>{r.party_name ?? <span className="text-ink-faint">—</span>}</td>
                    <td className={td}>
                      <div>{r.document_number}</div>
                      <div className="text-xs text-ink-faint">
                        {r.document_type === "shipping_bill" ? "Shipping bill" : "Bill of Entry"} · {r.document_date}
                      </div>
                    </td>
                    <td className={td + " font-mono text-xs"}>{r.port_code}</td>
                    <td className={td}>
                      {r.export_realisation_due_date ? (
                        <span className={r.is_overdue ? "font-medium text-error" : "text-ink"}>
                          {r.export_realisation_due_date}
                          {r.is_overdue && ` · ${r.days_overdue}d overdue`}
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className={td}>
                      {r.brc_number ?? <span className="text-ink-faint">—</span>}
                      {r.realised_date && <div className="text-xs text-ink-faint">Realised {r.realised_date}</div>}
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
        One shipment record per voucher (v1 scope) — a single invoice shipped as several partial consignments
        needs several vouchers, not several rows here. Landed-cost apportionment and GSTR-1 Table 6A/6B/6C
        reporting are separate, deliberately unbuilt gaps.
      </p>
    </main>
  );
}
