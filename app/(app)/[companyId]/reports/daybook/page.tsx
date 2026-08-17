import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";

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

export default async function DaybookPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/daybook">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month")
    .eq("id", companyId)
    .maybeSingle();

  const period = defaultPeriod(company?.financial_year_start_month ?? 4, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  const { data: rows, error } = await supabase.rpc("get_daybook", {
    p_company_id: companyId,
    p_from: period.from,
    p_to: period.to,
  });

  const total = (rows ?? []).reduce((n, r) => n + Number(r.total_amount ?? 0), 0);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Daybook</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{period.label}</p>
      </header>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error.message}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="px-4 py-2.5 text-left font-medium">Date</th>
              <th className="px-4 py-2.5 text-left font-medium">Number</th>
              <th className="px-4 py-2.5 text-left font-medium">Type</th>
              <th className="px-4 py-2.5 text-left font-medium">Narration</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-zinc-500">
                  No vouchers in this period.
                </td>
              </tr>
            )}
            {(rows ?? []).map((r) => (
              <tr
                key={r.voucher_id}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
              >
                <td className="whitespace-nowrap px-4 py-2 tabular-nums">
                  {r.voucher_date}
                </td>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
                  {r.voucher_number}
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  {TYPE_LABEL[r.voucher_type] ?? r.voucher_type}
                </td>
                <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                  {r.narration ?? <span className="text-zinc-400">—</span>}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatINR(Number(r.total_amount))}
                </td>
              </tr>
            ))}
          </tbody>
          {(rows ?? []).length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-700 dark:bg-zinc-800/50">
                <td className="px-4 py-2.5" colSpan={4}>
                  {(rows ?? []).length} voucher{(rows ?? []).length === 1 ? "" : "s"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {formatINR(total, { showZero: true })}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </main>
  );
}
