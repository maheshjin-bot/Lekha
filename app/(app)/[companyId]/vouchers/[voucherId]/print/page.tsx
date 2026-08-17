import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { amountInWords } from "@/lib/utils/words";
import { PrintButton } from "@/components/invoices/PrintButton";

const TITLE: Record<string, string> = {
  sales: "Invoice",
  purchase: "Purchase Bill",
  credit_note: "Credit Note",
  debit_note: "Debit Note",
};

export default async function PrintInvoicePage({
  params,
}: PageProps<"/[companyId]/vouchers/[voucherId]/print">) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select(
      "id, voucher_number, voucher_type, voucher_date, narration, reference_number, reference_date, total_amount, party_ledger_id, branch_id"
    )
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!voucher) notFound();

  const [{ data: company }, { data: branch }, { data: party }, { data: lines }] =
    await Promise.all([
      supabase
        .from("companies")
        .select("name, legal_name, pan")
        .eq("id", companyId)
        .maybeSingle(),
      supabase
        .from("branches")
        .select("name, address_line1, address_line2, city, pincode, state_code")
        .eq("id", voucher.branch_id)
        .maybeSingle(),
      voucher.party_ledger_id
        ? supabase
            .from("ledgers")
            .select("name, address, city, pincode, gstin, pan")
            .eq("id", voucher.party_ledger_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("voucher_items")
        .select("id, quantity, uom, rate, amount, hsn_sac, description, items(name)")
        .eq("voucher_id", voucherId)
        .order("line_order"),
    ]);

  const items = lines ?? [];
  const total = Number(voucher.total_amount);
  const title = TITLE[voucher.voucher_type] ?? "Voucher";

  // Without item lines this is a plain journal, not a document anyone issues.
  if (items.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This voucher has no item lines, so there is nothing to print as an
          invoice.
        </p>
        <Link
          href={`/${companyId}/vouchers/${voucherId}`}
          className="mt-4 inline-block text-sm text-emerald-800 underline underline-offset-4 dark:text-emerald-400"
        >
          Back to the voucher
        </Link>
      </main>
    );
  }

  const addressLines = [
    branch?.address_line1,
    branch?.address_line2,
    [branch?.city, branch?.pincode].filter(Boolean).join(" "),
  ].filter(Boolean);

  return (
    <>
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 pt-8 print:hidden">
        <Link
          href={`/${companyId}/vouchers/${voucherId}`}
          className="text-sm text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          ← Back
        </Link>
        <PrintButton />
      </div>

      {/* The document. Deliberately white and black regardless of theme — it
          is printed on paper and read as a record, not as part of the app. */}
      <main className="mx-auto my-8 max-w-3xl bg-white p-10 text-zinc-900 shadow-sm ring-1 ring-zinc-200 print:my-0 print:max-w-none print:p-0 print:shadow-none print:ring-0">
        <header className="flex flex-wrap items-start justify-between gap-6 border-b-2 border-zinc-900 pb-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {company?.legal_name || company?.name}
            </h1>
            {addressLines.length > 0 && (
              <p className="mt-1 text-xs leading-relaxed text-zinc-600">
                {addressLines.join(", ")}
              </p>
            )}
            {company?.pan && (
              <p className="mt-1 text-xs text-zinc-600">
                PAN <span className="font-mono">{company.pan}</span>
              </p>
            )}
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
              {title}
            </div>
            <div className="mt-1 font-mono text-sm font-medium">
              {voucher.voucher_number}
            </div>
            <div className="mt-1 text-xs text-zinc-600">{voucher.voucher_date}</div>
          </div>
        </header>

        <section className="grid gap-6 border-b border-zinc-300 py-5 sm:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
              {voucher.voucher_type === "purchase" || voucher.voucher_type === "debit_note"
                ? "Supplier"
                : "Billed to"}
            </div>
            <div className="mt-1 font-medium">{party?.name ?? "—"}</div>
            {party?.address && (
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-600">
                {[party.address, party.city, party.pincode].filter(Boolean).join(", ")}
              </p>
            )}
            {party?.gstin && (
              <p className="mt-1 text-xs text-zinc-600">
                GSTIN <span className="font-mono">{party.gstin}</span>
              </p>
            )}
          </div>
          {voucher.reference_number && (
            <div className="sm:text-right">
              <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                Reference
              </div>
              <div className="mt-1 font-mono text-sm">{voucher.reference_number}</div>
              {voucher.reference_date && (
                <div className="text-xs text-zinc-600">{voucher.reference_date}</div>
              )}
            </div>
          )}
        </section>

        <table className="mt-5 w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-400 text-left text-[10px] uppercase tracking-[0.12em] text-zinc-600">
              <th className="w-8 py-2 font-medium">#</th>
              <th className="py-2 font-medium">Description</th>
              <th className="py-2 font-medium">HSN</th>
              <th className="py-2 text-right font-medium">Qty</th>
              <th className="py-2 text-right font-medium">Rate</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((l, i) => (
              <tr key={l.id} className="border-b border-zinc-200 align-top">
                <td className="py-2 tabular-nums text-zinc-500">{i + 1}</td>
                <td className="py-2">
                  <div className="font-medium">{l.items?.name ?? "—"}</div>
                  {l.description && (
                    <div className="text-xs text-zinc-600">{l.description}</div>
                  )}
                </td>
                <td className="py-2 font-mono text-xs">{l.hsn_sac ?? "—"}</td>
                <td className="py-2 text-right tabular-nums">
                  {Number(l.quantity)} {l.uom}
                </td>
                <td className="py-2 text-right tabular-nums">{formatINR(Number(l.rate))}</td>
                <td className="py-2 text-right tabular-nums">{formatINR(Number(l.amount))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-b-2 border-zinc-900 font-semibold">
              <td className="py-2.5" colSpan={5}>
                Total
              </td>
              <td className="py-2.5 text-right tabular-nums">
                {formatINR(total, { showZero: true })}
              </td>
            </tr>
          </tfoot>
        </table>

        <p className="mt-4 text-sm">
          <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
            Amount in words
          </span>
          <br />
          <span className="font-medium">{amountInWords(total)}</span>
        </p>

        {voucher.narration && (
          <p className="mt-4 text-xs leading-relaxed text-zinc-600">
            {voucher.narration}
          </p>
        )}

        <footer className="mt-14 flex items-end justify-between">
          <p className="max-w-xs text-[10px] leading-relaxed text-zinc-500">
            This document does not carry GST particulars. Once the company is
            registered it becomes a tax invoice under Rule 46.
          </p>
          <div className="text-center">
            <div className="h-12" />
            <div className="w-52 border-t border-zinc-400 pt-1.5 text-xs">
              For {company?.legal_name || company?.name}
              <div className="mt-0.5 text-[10px] text-zinc-500">
                Authorised signatory
              </div>
            </div>
          </div>
        </footer>
      </main>
    </>
  );
}
