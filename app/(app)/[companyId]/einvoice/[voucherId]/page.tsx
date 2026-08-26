import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { EinvoiceDetailForm } from "@/components/einvoice/EinvoiceDetailForm";

/**
 * The addendum entry point: build/record e-invoice (IRN) details for ONE
 * already-posted sales invoice or credit note. Its own route, reached from
 * the Sales Invoices / Sales Returns lists — never a change to how the
 * voucher itself gets created (create_invoice/InvoiceForm untouched; see
 * migration 0230's header). Same shape as app/.../exim/[voucherId] (0119).
 */
export default async function EinvoiceDetailPage({
  params,
}: PageProps<"/[companyId]/einvoice/[voucherId]">) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select("id, voucher_number, voucher_date, voucher_type, total_amount, supply_type, party_ledger_id, is_deleted")
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!voucher) notFound();

  const partyName = voucher.party_ledger_id
    ? (
        await supabase.from("ledgers").select("name").eq("id", voucher.party_ledger_id).maybeSingle()
      ).data?.name ?? null
    : null;

  const { data: existing } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- einvoice_details is brand new (0230), not yet in generated types
    .from("einvoice_details" as any)
    .select("id, status, generated_json, generated_at, irn, ack_number, ack_date, signed_qr_payload")
    .eq("voucher_id", voucherId)
    .maybeSingle();

  const eligible = voucher.voucher_type === "sales" || voucher.voucher_type === "credit_note";

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
          <Link href={`/${companyId}/einvoice`} className="text-accent underline underline-offset-4">
            e-Invoice
          </Link>
          {" / "}
          {voucher.voucher_number}
        </p>
        <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">{voucher.voucher_number}</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {voucher.voucher_date} · {partyName ?? "—"} · {formatINR(Number(voucher.total_amount))}
          {voucher.is_deleted && <span className="ml-2 font-medium text-error">This voucher is deleted.</span>}
        </p>
      </header>

      {!eligible ? (
        <p className="rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          e-Invoice details only attach to a sales invoice or a credit note you issued. {voucher.voucher_number} is a{" "}
          {voucher.voucher_type.replace("_", " ")} voucher.
        </p>
      ) : !voucher.supply_type ? (
        <p className="rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          GST was not active when {voucher.voucher_number} was posted, so no supply type was ever determined for it
          — an e-invoice payload cannot be built.
        </p>
      ) : (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see fetch above
        <EinvoiceDetailForm companyId={companyId} voucherId={voucherId} existing={existing as any} />
      )}
    </main>
  );
}
