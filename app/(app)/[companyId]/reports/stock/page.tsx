import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

export default async function StockSummaryPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/stock">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: company }, { data: godowns }] = await Promise.all([
    supabase
      .from("companies")
      .select("financial_year_start_month, inventory_valuation_method")
      .eq("id", companyId)
      .maybeSingle(),
    supabase
      .from("godowns")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code"),
  ]);

  const period = defaultPeriod(company?.financial_year_start_month ?? 4, {
    to: typeof sp.as_at === "string" ? sp.as_at : undefined,
  });

  const { data: rows } = await supabase.rpc("get_stock_summary", {
    p_company_id: companyId,
    p_as_at: period.to,
  });

  const stock = rows ?? [];
  const totalValue = stock.reduce((n, r) => n + Number(r.closing_value ?? 0), 0);

  const method =
    company?.inventory_valuation_method === "fifo" ? "FIFO" : "Weighted average";

  return (
    <ReportShell
      title="Stock Summary"
      period={`As at ${period.label.split(" to ").pop()} · valued at ${method.toLowerCase()}`}
      status={{ label: formatINR(totalValue, { showZero: true }), tone: "ok" }}
    >
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left dark:border-zinc-800">
            <th className={th}>Item</th>
            <th className={th}>HSN</th>
            <th className={th}>Unit</th>
            <th className={th + " text-right"}>In</th>
            <th className={th + " text-right"}>Out</th>
            <th className={th + " text-right"}>Closing</th>
            <th className={th + " text-right"}>Rate</th>
            <th className={th + " text-right"}>Value</th>
          </tr>
        </thead>
        <tbody>
          {stock.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-12 text-center text-zinc-500">
                {godowns?.length
                  ? "No stock movement yet."
                  : "No godown configured, so stock cannot be recorded."}
              </td>
            </tr>
          )}
          {stock.map((r) => (
            <tr
              key={r.item_id}
              className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
            >
              <td className={td + " font-medium"}>{r.item_name}</td>
              <td className={td + " font-mono text-xs"}>{r.hsn_sac ?? "—"}</td>
              <td className={td}>{r.uom}</td>
              <td className={num}>{Number(r.quantity_in)}</td>
              <td className={num}>{Number(r.quantity_out)}</td>
              <td className={num + " font-medium"}>{Number(r.closing_quantity)}</td>
              <td className={num}>{formatINR(Number(r.average_rate))}</td>
              <td className={num}>{formatINR(Number(r.closing_value))}</td>
            </tr>
          ))}
        </tbody>
        {stock.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-700 dark:bg-zinc-800/50">
              <td className="px-4 py-2.5" colSpan={7}>
                Total stock value
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {formatINR(totalValue, { showZero: true })}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </ReportShell>
  );
}
