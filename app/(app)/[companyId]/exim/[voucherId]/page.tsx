import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { EximShipmentForm } from "@/components/exim/EximShipmentForm";

/**
 * The addendum entry point: attach shipping-bill / BOE / BRC facts to ONE
 * already-posted sales or purchase voucher. Deliberately its own route,
 * reached from the sales/purchase invoice lists — never a change to how
 * the voucher itself gets created (InvoiceForm/create_invoice are a
 * concurrent session's locked files this run; see 0119 migration header).
 */
export default async function EximShipmentPage({
  params,
}: PageProps<"/[companyId]/exim/[voucherId]">) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select("id, voucher_number, voucher_date, voucher_type, total_amount, txn_currency, party_ledger_id, is_deleted")
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
    .from("exim_shipment_details")
    .select(
      "id, document_type, document_number, document_date, port_code, brc_number, brc_date, export_realisation_due_date, realised_date"
    )
    .eq("voucher_id", voucherId)
    .maybeSingle();

  const eligible = voucher.voucher_type === "sales" || voucher.voucher_type === "purchase";

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
          <Link href={`/${companyId}/exim`} className="text-accent underline underline-offset-4">
            EXIM shipments
          </Link>
          {" / "}
          {voucher.voucher_number}
        </p>
        <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">
          {voucher.voucher_number}
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          {voucher.voucher_date} · {partyName ?? "—"} · {formatINR(Number(voucher.total_amount))}
          {voucher.txn_currency !== "INR" && ` (${voucher.txn_currency})`}
          {voucher.is_deleted && <span className="ml-2 font-medium text-error">This voucher is deleted.</span>}
        </p>
      </header>

      {!eligible ? (
        <p className="rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          EXIM shipment details only attach to a sales (export) or purchase (import) voucher. {voucher.voucher_number} is
          a {voucher.voucher_type.replace("_", " ")} voucher.
        </p>
      ) : (
        <EximShipmentForm
          companyId={companyId}
          voucherId={voucherId}
          voucherType={voucher.voucher_type as "sales" | "purchase"}
          existing={existing as never}
        />
      )}
    </main>
  );
}
