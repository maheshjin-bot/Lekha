import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { amountInWords } from "@/lib/utils/words";
import { PrintButton } from "@/components/invoices/PrintButton";

const TITLE: Record<string, string> = {
  sales: "Tax Invoice",
  purchase: "Purchase Bill",
  credit_note: "Credit Note",
  debit_note: "Debit Note",
};

const TAX_LABEL: Record<string, string> = {
  cgst: "CGST",
  sgst: "SGST",
  igst: "IGST",
  cess: "Cess",
  tcs: "TCS",
};

export default async function PrintInvoicePage({
  params,
}: PageProps<"/[companyId]/vouchers/[voucherId]/print">) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select(
      "id, voucher_number, voucher_type, voucher_date, narration, reference_number, reference_date, total_amount, party_ledger_id, branch_id, place_of_supply, supply_type"
    )
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!voucher) notFound();

  const [{ data: company }, { data: items }, { data: party }, { data: branch }, { data: taxMap }, { data: states }] =
    await Promise.all([
      supabase
        .from("companies")
        .select("name, legal_name, pan")
        .eq("id", companyId)
        .maybeSingle(),
      supabase
        .from("voucher_items")
        .select("id, quantity, uom, rate, amount, hsn_sac, description, items(name)")
        .eq("voucher_id", voucherId)
        .order("line_order"),
      voucher.party_ledger_id
        ? supabase
            .from("ledgers")
            .select("name, address, city, pincode, gstin, state_code, phone, email")
            .eq("id", voucher.party_ledger_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("branches")
        .select("name, address_line1, address_line2, city, pincode, state_code, gst_registration_id, gst_registrations(gstin)")
        .eq("id", voucher.branch_id)
        .maybeSingle(),
      // Reads what was actually posted rather than recomputing it, so the
      // printed document can never disagree with the ledger it came from.
      supabase
        .from("tax_ledger_map")
        .select("purpose, ledger_id")
        .eq("company_id", companyId),
      supabase.from("ref_states").select("code, name"),
    ]);

  const lines = items ?? [];
  const total = Number(voucher.total_amount);
  const taxable = lines.reduce((n, l) => n + Number(l.amount), 0);

  // Tax entries are whichever voucher_entries used a ledger that
  // tax_ledger_map has on file for this company, keyed by purpose.
  const { data: entries } = await supabase
    .from("voucher_entries")
    .select("ledger_id, debit_amount, credit_amount")
    .eq("voucher_id", voucherId);

  const purposeByLedger = new Map((taxMap ?? []).map((t) => [t.ledger_id, t.purpose]));
  const taxByKind = new Map<string, number>();
  for (const e of entries ?? []) {
    const purpose = purposeByLedger.get(e.ledger_id);
    if (!purpose) continue;
    const kind = purpose.split("_")[1]; // output_cgst -> cgst
    const amount = Number(e.debit_amount) || Number(e.credit_amount) || 0;
    taxByKind.set(kind, (taxByKind.get(kind) ?? 0) + amount);
  }

  const stateName = (code: string | null) => states?.find((s) => s.code === code)?.name ?? code;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 print:max-w-none print:px-0 print:py-0">
      <div className="mb-6 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <article className="border border-border-strong bg-surface p-8 text-sm text-ink print:border-0 print:p-0">
        <header className="border-b-2 border-ink pb-4">
          <h1 className="text-center text-lg font-semibold uppercase tracking-wide">
            {TITLE[voucher.voucher_type] ?? "Voucher"}
          </h1>
        </header>

        <section className="grid gap-6 border-b border-border-strong py-4 sm:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">From</div>
            <div className="mt-1 font-semibold">{company?.legal_name || company?.name}</div>
            {branch && (
              <div className="mt-0.5 text-xs leading-relaxed text-ink-soft">
                {[branch.address_line1, branch.address_line2, branch.city, branch.pincode]
                  .filter(Boolean)
                  .join(", ") || branch.name}
              </div>
            )}
            {branch?.gst_registrations?.gstin ? (
              <div className="mt-1 text-xs">
                GSTIN <span className="font-mono">{branch.gst_registrations.gstin}</span>
              </div>
            ) : (
              company?.pan && (
                <div className="mt-1 text-xs">
                  PAN <span className="font-mono">{company.pan}</span>
                </div>
              )
            )}
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">
              {voucher.voucher_type === "purchase" ? "Supplier" : "Billed to"}
            </div>
            <div className="mt-1 font-semibold">{party?.name ?? "—"}</div>
            {party && (
              <div className="mt-0.5 text-xs leading-relaxed text-ink-soft">
                {[party.address, party.city, party.pincode].filter(Boolean).join(", ")}
              </div>
            )}
            {party?.gstin && (
              <div className="mt-1 text-xs">
                GSTIN <span className="font-mono">{party.gstin}</span>
              </div>
            )}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-4 border-b border-border-strong py-3 text-xs sm:grid-cols-4">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">Number</div>
            <div className="font-mono">{voucher.voucher_number}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">Date</div>
            <div className="tabular-nums font-mono">{voucher.voucher_date}</div>
          </div>
          {voucher.place_of_supply && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-faint">Place of supply</div>
              <div>{stateName(voucher.place_of_supply)}</div>
            </div>
          )}
          {voucher.reference_number && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-faint">Reference</div>
              <div>{voucher.reference_number}</div>
            </div>
          )}
        </section>

        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-ink text-left text-[10px] uppercase tracking-wide">
              <th className="py-2 pr-2 font-medium">#</th>
              <th className="py-2 pr-2 font-medium">Description</th>
              <th className="py-2 pr-2 font-medium">HSN</th>
              <th className="py-2 pr-2 text-right font-medium">Qty</th>
              <th className="py-2 pr-2 font-medium">Unit</th>
              <th className="py-2 pr-2 text-right font-medium">Rate</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-ink-faint">
                  This voucher has no item lines.
                </td>
              </tr>
            )}
            {lines.map((l, i) => (
              <tr key={l.id} className="border-b border-border">
                <td className="py-2 pr-2 tabular-nums font-mono">{i + 1}</td>
                <td className="py-2 pr-2">
                  {l.items?.name}
                  {l.description && (
                    <span className="block text-xs text-ink-soft">{l.description}</span>
                  )}
                </td>
                <td className="py-2 pr-2 font-mono text-xs">{l.hsn_sac ?? "—"}</td>
                <td className="py-2 pr-2 text-right tabular-nums font-mono">{Number(l.quantity)}</td>
                <td className="py-2 pr-2">{l.uom}</td>
                <td className="py-2 pr-2 text-right tabular-nums font-mono">{formatINR(Number(l.rate))}</td>
                <td className="py-2 text-right tabular-nums font-mono">{formatINR(Number(l.amount))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {taxByKind.size > 0 && (
              <>
                <tr>
                  <td className="pt-2" colSpan={6}>
                    Taxable value
                  </td>
                  <td className="pt-2 text-right tabular-nums font-mono">{formatINR(taxable)}</td>
                </tr>
                {[...taxByKind.entries()].map(([kind, amount]) => (
                  <tr key={kind} className="text-ink-soft">
                    <td className="py-0.5" colSpan={6}>
                      {TAX_LABEL[kind] ?? kind.toUpperCase()}
                    </td>
                    <td className="py-0.5 text-right tabular-nums font-mono">{formatINR(amount)}</td>
                  </tr>
                ))}
              </>
            )}
            <tr className="border-t-2 border-ink font-semibold">
              <td className="py-2.5" colSpan={6}>
                Total
              </td>
              <td className="py-2.5 text-right tabular-nums font-mono">
                {formatINR(total, { showZero: true })}
              </td>
            </tr>
          </tfoot>
        </table>

        <section className="mt-4 border-t border-border-strong pt-3">
          <div className="text-[10px] uppercase tracking-wide text-ink-faint">Amount in words</div>
          <div className="mt-0.5 font-medium">{amountInWords(total)}</div>
        </section>

        {voucher.narration && (
          <p className="mt-4 text-xs text-ink-soft">{voucher.narration}</p>
        )}

        <footer className="mt-12 flex justify-between text-xs">
          <div className="text-ink-faint">
            This is a computer-generated document.
          </div>
          <div className="text-right">
            <div className="mb-10">For {company?.legal_name || company?.name}</div>
            <div className="border-t border-border-strong pt-1">Authorised Signatory</div>
          </div>
        </footer>
      </article>
    </main>
  );
}
