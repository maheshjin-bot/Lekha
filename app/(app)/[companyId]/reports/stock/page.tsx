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

  const [{ data: company }, { data: godowns }, { data: uomConversions }] = await Promise.all([
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
    // Alternate-unit conversions (0121) — used below to show closing stock
    // also in whatever secondary unit an item has defined, alongside its
    // base-unit figure. conversion_factor is base-units-per-alternate-unit
    // (see 0121's migration header), so the base -> alternate figure shown
    // here is closing_quantity / conversion_factor, computed client-side
    // from the same stored factor public.convert_quantity uses server-side.
    supabase
      .from("item_uom_conversions")
      .select("item_id, alternate_uom, conversion_factor")
      .eq("company_id", companyId),
  ]);

  const conversionsByItem = new Map<string, { alternate_uom: string; conversion_factor: number }[]>();
  for (const c of uomConversions ?? []) {
    const list = conversionsByItem.get(c.item_id) ?? [];
    list.push({ alternate_uom: c.alternate_uom, conversion_factor: Number(c.conversion_factor) });
    conversionsByItem.set(c.item_id, list);
  }

  function formatAltQty(n: number) {
    return Number(n.toFixed(3)).toString();
  }

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
          <tr className="border-b border-border text-left">
            <th className={th}>Item</th>
            <th className={th}>HSN</th>
            <th className={th}>Unit</th>
            <th className={th + " text-right"}>In</th>
            <th className={th + " text-right"}>Out</th>
            <th className={th + " text-right"}>Closing</th>
            <th className={th}>Also in</th>
            <th className={th + " text-right"}>Rate</th>
            <th className={th + " text-right"}>Value</th>
          </tr>
        </thead>
        <tbody>
          {stock.length === 0 && (
            <tr>
              <td colSpan={9} className="px-4 py-12 text-center text-ink-faint">
                {godowns?.length
                  ? "No stock movement yet."
                  : "No godown configured, so stock cannot be recorded."}
              </td>
            </tr>
          )}
          {stock.map((r) => (
            <tr
              key={r.item_id}
              className="border-b border-border last:border-0"
            >
              <td className={td + " font-medium"}>{r.item_name}</td>
              <td className={td + " font-mono text-xs"}>{r.hsn_sac ?? "—"}</td>
              <td className={td}>{r.uom}</td>
              <td className={num}>{Number(r.quantity_in)}</td>
              <td className={num}>{Number(r.quantity_out)}</td>
              <td className={num + " font-medium"}>{Number(r.closing_quantity)}</td>
              <td className={td + " text-xs text-ink-soft"}>
                {(conversionsByItem.get(r.item_id) ?? []).length > 0 ? (
                  (conversionsByItem.get(r.item_id) ?? [])
                    .map(
                      (c) =>
                        `${formatAltQty(Number(r.closing_quantity) / c.conversion_factor)} ${c.alternate_uom}`
                    )
                    .join(", ")
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </td>
              <td className={num}>{formatINR(Number(r.average_rate))}</td>
              <td className={num}>{formatINR(Number(r.closing_value))}</td>
            </tr>
          ))}
        </tbody>
        {stock.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5" colSpan={8}>
                Total stock value
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                {formatINR(totalValue, { showZero: true })}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </ReportShell>
  );
}
