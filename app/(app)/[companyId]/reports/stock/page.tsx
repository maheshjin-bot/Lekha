import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

type FifoLayer = {
  item_id: string;
  layer_date: string | null;
  layer_source: string;
  original_quantity: number;
  quantity_remaining: number;
  unit_cost: number | null;
  layer_value: number | null;
};

type FifoSummaryRow = {
  item_id: string;
  average_rate: number;
  closing_value: number;
  unpriced_quantity: number;
};

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

  // Godown filter: an id in the query string is only honoured when it
  // actually belongs to this company's own godown list (fetched above) —
  // this keeps a stale/foreign id from silently falling through to
  // get_stock_summary, which would otherwise just treat it as "no matches"
  // rather than "all godowns". Not a tenancy risk either way (the RPC scopes
  // every row by p_company_id first), just a correctness guard.
  const activeGodowns = godowns ?? [];
  const requestedGodownId = typeof sp.godown === "string" ? sp.godown : undefined;
  const selectedGodownId =
    requestedGodownId && activeGodowns.some((g) => g.id === requestedGodownId)
      ? requestedGodownId
      : null;
  const selectedGodown = activeGodowns.find((g) => g.id === selectedGodownId);

  // Two independent valuations of the SAME movements, fetched side by side
  // (0185): get_stock_summary is still the moving-weighted-average figure
  // that Drawing Power / CMA ratios / Form 3CD / the balance sheet actually
  // use; get_stock_summary_fifo / get_stock_fifo_layers are a pure,
  // re-derived-every-call FIFO comparison that feeds nothing else in the
  // app yet — see the 0185 migration header for why that's deliberate.
  // get_stock_summary_fifo / get_stock_fifo_layers are not yet in the
  // generated database.types.ts — same reason and same "as unknown as"
  // shape as reports/stock-ageing and others: that file is owned by the
  // integration pass' regeneration, not this task.
  const [{ data: waRows }, { data: fifoRowsRaw }, { data: fifoLayerRowsRaw }] = await Promise.all([
    supabase.rpc("get_stock_summary", {
      p_company_id: companyId,
      p_as_at: period.to,
      p_godown_id: selectedGodownId ?? undefined,
    }),
    supabase.rpc("get_stock_summary_fifo", {
      p_company_id: companyId,
      p_as_at: period.to,
      p_godown_id: selectedGodownId ?? undefined,
    }),
    supabase.rpc("get_stock_fifo_layers", {
      p_company_id: companyId,
      p_as_at: period.to,
      p_godown_id: selectedGodownId ?? undefined,
    }),
  ]);

  const stock = waRows ?? [];
  const totalValue = stock.reduce((n, r) => n + Number(r.closing_value ?? 0), 0);

  const fifoRows = (fifoRowsRaw ?? []) as unknown as FifoSummaryRow[];
  const fifoLayerRows = (fifoLayerRowsRaw ?? []) as unknown as FifoLayer[];

  const fifoByItem = new Map<string, FifoSummaryRow>();
  for (const r of fifoRows) {
    fifoByItem.set(r.item_id, r);
  }
  const totalFifoValue = fifoRows.reduce((n, r) => n + Number(r.closing_value ?? 0), 0);
  const totalUnpriced = fifoRows.reduce((n, r) => n + Number(r.unpriced_quantity ?? 0), 0);

  const layersByItem = new Map<string, FifoLayer[]>();
  for (const l of fifoLayerRows) {
    const list = layersByItem.get(l.item_id) ?? [];
    list.push(l);
    layersByItem.set(l.item_id, list);
  }

  const method =
    company?.inventory_valuation_method === "fifo" ? "FIFO" : "Weighted average";

  const base = `/${companyId}/reports/stock`;
  const asAtParam = typeof sp.as_at === "string" ? sp.as_at : undefined;
  const asAtQuery = asAtParam ? `&as_at=${asAtParam}` : "";
  const allGodownsHref = asAtParam ? `${base}?as_at=${asAtParam}` : base;

  return (
    <ReportShell
      title="Stock Summary"
      period={
        `As at ${period.label.split(" to ").pop()} · official value at ${method.toLowerCase()}, FIFO shown alongside for comparison` +
        (selectedGodown ? ` · ${selectedGodown.name}` : "")
      }
      status={{ label: formatINR(totalValue, { showZero: true }), tone: "ok" }}
    >
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
      <table className="w-full min-w-[1080px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Item</th>
            <th className={th}>HSN</th>
            <th className={th}>Unit</th>
            <th className={th + " text-right"}>In</th>
            <th className={th + " text-right"}>Out</th>
            <th className={th + " text-right"}>Closing</th>
            <th className={th}>Also in</th>
            <th className={th + " text-right"}>Wtd-avg rate</th>
            <th className={th + " text-right"}>Wtd-avg value</th>
            <th className={th + " text-right"}>FIFO rate</th>
            <th className={th + " text-right"}>FIFO value</th>
            <th className={th + " text-right"}>FIFO − wtd-avg</th>
          </tr>
        </thead>
        <tbody>
          {stock.length === 0 && (
            <tr>
              <td colSpan={12} className="px-4 py-12 text-center text-ink-faint">
                {activeGodowns.length
                  ? selectedGodown
                    ? `No stock movement in ${selectedGodown.name}.`
                    : "No stock movement yet."
                  : "No godown configured, so stock cannot be recorded."}
              </td>
            </tr>
          )}
          {stock.map((r) => {
            const fifo = fifoByItem.get(r.item_id);
            const fifoValue = Number(fifo?.closing_value ?? 0);
            const waValue = Number(r.closing_value ?? 0);
            const diff = fifoValue - waValue;
            const unpriced = Number(fifo?.unpriced_quantity ?? 0);
            return (
              <tr key={r.item_id} className="border-b border-border last:border-0">
                <td className={td + " font-medium"}>
                  {r.item_name}
                  {unpriced > 0.0005 && (
                    <Badge tone="warn" className="ml-2 align-middle">
                      {formatAltQty(unpriced)} unpriced
                    </Badge>
                  )}
                </td>
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
                <td className={num}>{formatINR(waValue)}</td>
                <td className={num}>{fifo ? formatINR(Number(fifo.average_rate)) : "—"}</td>
                <td className={num}>{fifo ? formatINR(fifoValue) : "—"}</td>
                <td className={num + (diff !== 0 ? " font-medium" : "")}>
                  {fifo ? `${diff >= 0 ? "+" : ""}${formatINR(diff, { showZero: true })}` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
        {stock.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5" colSpan={7}>
                Total stock value
              </td>
              <td className="px-4 py-2.5" />
              <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                {formatINR(totalValue, { showZero: true })}
              </td>
              <td className="px-4 py-2.5" />
              <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                {formatINR(totalFifoValue, { showZero: true })}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                {`${totalFifoValue - totalValue >= 0 ? "+" : ""}${formatINR(totalFifoValue - totalValue, { showZero: true })}`}
              </td>
            </tr>
          </tfoot>
        )}
      </table>

      {totalUnpriced > 0.0005 && (
        <div className="border-t border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          {formatAltQty(totalUnpriced)} unit{totalUnpriced === 1 ? "" : "s"} of recorded issues,
          across the items flagged above, exceed everything ever recorded as received for that
          item — a real over-issue / data-entry timing gap, not a FIFO artefact (the same items
          show a negative closing quantity above, in both valuations). FIFO reports this quantity
          separately as unpriced rather than inventing a cost for it; the weighted-average value
          above extrapolates a figure for it regardless, which is worth treating with caution for
          exactly these items.
        </div>
      )}

      {selectedGodown && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          Quantities filtered to {selectedGodown.name} add up across every
          godown to the all-godowns figure above for any item with a recorded
          voucher, or whose opening stock named a godown when it was created
          (2210). The one exception: an item created before that with opening
          stock and no movement since, in a company with more than one
          godown — nothing has ever said where it physically sits, so it
          counts company-wide but appears in no single godown here rather
          than being guessed into one. Rate and Value never sum across
          godowns regardless: each is its own moving-weighted-average (or
          FIFO stack) of only the receipts posted into {selectedGodown.name},
          so a godown&rsquo;s own average cost can differ from the
          item&rsquo;s company-wide average — the two views are both correct,
          just based on different receipts.
        </p>
      )}

      <div className="border-t border-border p-4">
        <h2 className="mb-2 font-display text-sm font-semibold text-ink">FIFO layer detail</h2>
        <p className="mb-3 text-xs text-ink-faint">
          Open cost layers behind the FIFO column above, oldest first. Each purchase, production
          receipt, or opening balance is its own layer at its own real cost; a sale draws down the
          oldest open layer first, splitting it if the sale is smaller than what remains. A sales
          return has no traceable link back to the layer it reverses in this schema, so it re-enters
          stock as a fresh layer costed at the item&rsquo;s own overall average rate — not its sale
          value — exactly the same convention the weighted-average figure already uses for a return.
        </p>
        {stock.filter((r) => (layersByItem.get(r.item_id) ?? []).length > 0).length === 0 && (
          <p className="text-xs text-ink-faint">No open FIFO layers for this view.</p>
        )}
        <div className="space-y-2">
          {stock
            .filter((r) => (layersByItem.get(r.item_id) ?? []).length > 0)
            .map((r) => {
              const layers = layersByItem.get(r.item_id) ?? [];
              return (
                <details key={r.item_id} className="rounded-lg border border-border">
                  <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2">
                    {r.item_name}
                    <span className="ml-2 font-normal text-ink-faint">
                      {layers.length} layer{layers.length === 1 ? "" : "s"}
                    </span>
                  </summary>
                  <div className="overflow-x-auto border-t border-border">
                    <table className="w-full min-w-[640px] text-xs">
                      <thead>
                        <tr className="border-b border-border text-left">
                          <th className={th}>Layer date</th>
                          <th className={th}>Source</th>
                          <th className={th + " text-right"}>Original qty</th>
                          <th className={th + " text-right"}>Remaining qty</th>
                          <th className={th + " text-right"}>Unit cost</th>
                          <th className={th + " text-right"}>Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {layers.map((l, i) => (
                          <tr key={i} className="border-b border-border last:border-0">
                            <td className={td}>
                              {l.layer_date ?? (l.unit_cost == null ? "—" : "Opening balance")}
                            </td>
                            <td className={td}>{l.layer_source}</td>
                            <td className={num}>{Number(l.original_quantity)}</td>
                            <td className={num}>{Number(l.quantity_remaining)}</td>
                            <td className={num}>
                              {l.unit_cost == null ? "—" : formatINR(Number(l.unit_cost))}
                            </td>
                            <td className={num}>
                              {l.layer_value == null ? "—" : formatINR(Number(l.layer_value))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              );
            })}
        </div>
      </div>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        FIFO here is a comparison, not a switch: it is recomputed from the full item history every
        time this page loads (nothing is stored), and does not feed Drawing Power, CMA ratios, Form
        3CD, or the balance sheet — those still read the weighted-average figure, which stays this
        company&rsquo;s official valuation method until a deliberate accounting-policy change is
        made and disclosed (AS 2 / ICDS II permit either FIFO or weighted average, but require
        whichever is chosen to be applied consistently).
      </p>
    </ReportShell>
  );
}
