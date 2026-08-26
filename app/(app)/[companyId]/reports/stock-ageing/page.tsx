import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

type AgeingRow = {
  item_id: string;
  item_name: string;
  uom: string;
  average_rate: number;
  closing_quantity: number;
  qty_0_30: number;
  qty_31_60: number;
  qty_61_90: number;
  qty_91_180: number;
  qty_181_365: number;
  qty_over_365: number;
  val_0_30: number;
  val_31_60: number;
  val_61_90: number;
  val_91_180: number;
  val_181_365: number;
  val_over_365: number;
};

const BUCKETS: { qty: keyof AgeingRow; val: keyof AgeingRow; label: string }[] = [
  { qty: "qty_0_30", val: "val_0_30", label: "0–30d" },
  { qty: "qty_31_60", val: "val_31_60", label: "31–60d" },
  { qty: "qty_61_90", val: "val_61_90", label: "61–90d" },
  { qty: "qty_91_180", val: "val_91_180", label: "91–180d" },
  { qty: "qty_181_365", val: "val_181_365", label: "181–365d" },
  { qty: "qty_over_365", val: "val_over_365", label: "365d+" },
];

export default async function StockAgeingPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/stock-ageing">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: company }, { data: godowns }] = await Promise.all([
    supabase
      .from("companies")
      .select("financial_year_start_month")
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
  const asAt = period.to;

  const activeGodowns = godowns ?? [];
  const requestedGodownId = typeof sp.godown === "string" ? sp.godown : undefined;
  const selectedGodownId =
    requestedGodownId && activeGodowns.some((g) => g.id === requestedGodownId)
      ? requestedGodownId
      : null;
  const selectedGodown = activeGodowns.find((g) => g.id === selectedGodownId);

  // get_stock_ageing (0165) is not yet in the generated database.types.ts —
  // same reason and same "as unknown as" shape as reports/gst-refunds,
  // reports/balance-sheet and others: that file is owned by the integration
  // pass' regeneration, not this task.
  const { data: ageingRows } = await supabase.rpc("get_stock_ageing", {
    p_company_id: companyId,
    p_as_at: asAt,
    p_godown_id: selectedGodownId ?? undefined,
  });
  const rows = (ageingRows ?? []) as unknown as AgeingRow[];

  const totalQty = rows.reduce((n, r) => n + Number(r.closing_quantity), 0);
  const totalValue = rows.reduce(
    (n, r) => n + BUCKETS.reduce((m, b) => m + Number(r[b.val]), 0),
    0
  );
  const bucketTotals = BUCKETS.map((b) => ({
    ...b,
    qtyTotal: rows.reduce((n, r) => n + Number(r[b.qty]), 0),
    valTotal: rows.reduce((n, r) => n + Number(r[b.val]), 0),
  }));

  const base = `/${companyId}/reports/stock-ageing`;
  const asAtParam = typeof sp.as_at === "string" ? sp.as_at : undefined;
  const asAtQuery = asAtParam ? `&as_at=${asAtParam}` : "";
  const allGodownsHref = asAtParam ? `${base}?as_at=${asAtParam}` : base;

  return (
    <ReportShell
      title="Stock Ageing"
      period={
        `As at ${period.label.split(" to ").pop()} · FIFO-style, oldest layers age longest` +
        (selectedGodown ? ` · ${selectedGodown.name}` : "")
      }
      status={{ label: formatINR(totalValue, { showZero: true }), tone: "ok" }}
    >
      <div className="border-b border-border p-4 text-xs text-ink-faint">
        Quantity is a FIFO-style replay of every inward/outward stock line up
        to this date — no separate cost-layer ledger exists yet, so this is
        derived fresh each time, not stored. Value is each bucket&rsquo;s
        quantity at the item&rsquo;s own weighted-average rate (Stock
        Summary), not a fabricated per-layer FIFO cost — this app values
        stock only one way (see Settings → Inventory). An item whose
        recorded sales exceed its recorded receipts (a data problem, not an
        ageing one) may show a smaller total here than Stock Summary for the
        same item; that gap is never invented an age for.
      </div>

      {activeGodowns.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
          <Link
            href={allGodownsHref}
            className={
              "rounded-md border px-2.5 py-1 text-sm " +
              (!selectedGodownId
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            All godowns
          </Link>
          {activeGodowns.map((g) => (
            <Link
              key={g.id}
              href={`${base}?godown=${g.id}${asAtQuery}`}
              className={
                "rounded-md border px-2.5 py-1 text-sm " +
                (selectedGodownId === g.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-strong hover:bg-surface-2")
              }
            >
              {g.code} — {g.name}
            </Link>
          ))}
        </div>
      )}

      <table className="w-full min-w-[1100px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Item</th>
            <th className={th}>Unit</th>
            {BUCKETS.map((b) => (
              <th key={b.qty} className={th + " text-right"}>
                {b.label}
              </th>
            ))}
            <th className={th + " text-right"}>Total qty</th>
            <th className={th + " text-right"}>Rate</th>
            <th className={th + " text-right"}>Total value</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={11} className="px-4 py-12 text-center text-ink-faint">
                {activeGodowns.length
                  ? selectedGodown
                    ? `No stock on hand in ${selectedGodown.name} as at this date.`
                    : "No stock on hand as at this date."
                  : "No godown configured, so stock cannot be recorded."}
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const rowValue = BUCKETS.reduce((n, b) => n + Number(r[b.val]), 0);
            return (
              <tr key={r.item_id} className="border-b border-border last:border-0">
                <td className={td + " font-medium"}>{r.item_name}</td>
                <td className={td + " text-ink-soft"}>{r.uom}</td>
                {BUCKETS.map((b) => {
                  const qty = Number(r[b.qty]);
                  return (
                    <td
                      key={b.qty}
                      className={num + (b.qty === "qty_over_365" && qty > 0 ? " text-warning" : "")}
                    >
                      {qty > 0 ? qty.toLocaleString("en-IN") : <span className="text-ink-faint">—</span>}
                    </td>
                  );
                })}
                <td className={num + " font-medium"}>
                  {Number(r.closing_quantity).toLocaleString("en-IN")}
                </td>
                <td className={num}>{formatINR(Number(r.average_rate))}</td>
                <td className={num + " font-medium"}>{formatINR(rowValue)}</td>
              </tr>
            );
          })}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5" colSpan={2}>
                Total
              </td>
              {bucketTotals.map((b) => (
                <td key={b.qty} className="px-4 py-2.5 text-right tabular-nums font-mono">
                  {b.qtyTotal > 0 ? b.qtyTotal.toLocaleString("en-IN") : "—"}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                {totalQty.toLocaleString("en-IN")}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums font-mono">—</td>
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
