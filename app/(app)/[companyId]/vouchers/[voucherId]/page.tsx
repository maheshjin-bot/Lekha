import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";

const TYPE_LABEL: Record<string, string> = {
  receipt: "Receipt",
  payment: "Payment",
  contra: "Contra",
  journal: "Journal",
  sales: "Sales",
  purchase: "Purchase",
  credit_note: "Credit note",
  debit_note: "Debit note",
  branch_transfer: "Branch transfer",
  stock_journal: "Stock journal",
};

export default async function VoucherDetailPage({
  params,
}: PageProps<"/[companyId]/vouchers/[voucherId]">) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select(
      "id, voucher_number, voucher_type, voucher_date, narration, reference_number, total_amount, financial_year_label, txn_currency, exchange_rate, branch_id"
    )
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!voucher) notFound();

  const [{ data: entries }, { data: branch }] = await Promise.all([
    supabase
      .from("voucher_entries")
      .select("id, debit_amount, credit_amount, narration, line_order, ledgers(name)")
      .eq("voucher_id", voucherId)
      .order("line_order"),
    supabase
      .from("branches")
      .select("code, name")
      .eq("id", voucher.branch_id)
      .maybeSingle(),
  ]);

  const lines = entries ?? [];
  const dr = lines.reduce((n, l) => n + Number(l.debit_amount), 0);
  const cr = lines.reduce((n, l) => n + Number(l.credit_amount), 0);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href={`/${companyId}/reports/daybook`}
        className="text-sm text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 print:hidden"
      >
        ← Daybook
      </Link>

      <header className="mt-6 mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight">
            {voucher.voucher_number}
          </h1>
          <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            {TYPE_LABEL[voucher.voucher_type] ?? voucher.voucher_type} ·{" "}
            {voucher.voucher_date}
            {branch && ` · ${branch.code} ${branch.name}`}
          </p>
        </div>
        <div className="text-right">
          <div className="text-xl font-semibold tabular-nums">
            {formatINR(Number(voucher.total_amount), { showZero: true })}
          </div>
          {voucher.txn_currency !== "INR" && (
            <div className="text-xs text-zinc-500">
              {voucher.txn_currency} @ {voucher.exchange_rate}
            </div>
          )}
        </div>
      </header>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="px-4 py-2.5 font-medium">Ledger</th>
              <th className="px-4 py-2.5 font-medium">Narration</th>
              <th className="px-4 py-2.5 text-right font-medium">Debit</th>
              <th className="px-4 py-2.5 text-right font-medium">Credit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr
                key={l.id}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
              >
                <td className="px-4 py-2 font-medium">{l.ledgers?.name ?? "—"}</td>
                <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                  {l.narration ?? "—"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatINR(Number(l.debit_amount))}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatINR(Number(l.credit_amount))}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-700 dark:bg-zinc-800/50">
              <td className="px-4 py-2.5" colSpan={2}>
                {lines.length} line{lines.length === 1 ? "" : "s"}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {formatINR(dr, { showZero: true })}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {formatINR(cr, { showZero: true })}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {voucher.narration && (
        <p className="mt-5 text-sm text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">Narration: </span>
          {voucher.narration}
        </p>
      )}

      {voucher.reference_number && (
        <p className="mt-1.5 text-sm text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">Reference: </span>
          {voucher.reference_number}
        </p>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-4 print:hidden">
        <Link
          href={`/${companyId}/vouchers/${voucherId}/edit`}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Edit voucher
        </Link>
        <Link
          href={`/${companyId}/vouchers/${voucherId}/print`}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Print
        </Link>
        <span className="text-xs text-zinc-500">
          The date can move within financial year {voucher.financial_year_label},
          but not out of it.
        </span>
      </div>
    </main>
  );
}
