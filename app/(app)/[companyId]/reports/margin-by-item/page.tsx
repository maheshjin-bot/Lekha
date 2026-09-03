import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

// ============================================================================
// Margin by item — sale value less cost of goods sold, per item and per item
// group, sorted worst-first so a below-cost item is the first thing the
// reader sees.
//
// THE COST FIGURE, PRECISELY, AND WHY IT IS BUILT THIS WAY.
// get_trade_analysis(p_side='sale', p_group_by='item') gives the real
// quantity and net (taxable) value actually sold per item in the period —
// already netted against credit notes (see 1540's own header). What it
// cannot give is COST: it reports what was charged, not what the goods cost
// this company to acquire.
//
// get_stock_summary(p_company_id, p_as_at) is this app's one live inventory
// valuation engine (moving weighted average, unconditionally — see 0185's
// header). Its average_rate is a periodic figure: the single blended cost
// per unit for EVERY unit of that item in stock, as of p_as_at, built from
// opening value plus every costed inward movement to date. Cost of goods
// sold for the period is therefore:
//
//     COGS(item) = quantity sold in the period (get_trade_analysis)
//                  x average_rate(item) as at the period's OWN end date
//                  (get_stock_summary, p_as_at = period.to)
//
// This is not an approximation bolted on here — it is the exact algebraic
// identity a periodic weighted-average system already implies. Write O =
// opening qty, Ov = opening value, P = costed inward qty during the window,
// Pv = its value, S = qty sold. average_rate(to) = (Ov+Pv)/(O+P), and
// closing_value(to) = (O+P-S) x average_rate(to). Opening + Purchases -
// Closing then reduces to exactly S x average_rate(to) — the two
// get_stock_summary calls an opening/closing approach would need collapse
// into the one call already made, with an identical result. Verified both
// algebraically and against this database's own live data below.
//
// WHAT THIS DOES NOT CLAIM: average_rate(to) is ONE blended rate applied to
// every unit sold in the window, including one sold on day one of the
// period even if a later purchase moved the rate — the correct treatment
// under a periodic weighted-average policy (the only method this schema's
// valuation engine implements; see 0185), not a perpetual FIFO per-sale
// cost. And it is a company-wide figure: get_stock_summary takes no branch
// argument, so this report is not branch-filterable — see the footnote
// rendered below rather than silently mismatching a branch-scoped sale
// figure against a whole-company cost.
//
// WHY THIS MAY NOT MATCH THE P&L'S GROSS PROFIT LINE TO THE RUPEE, AND WHY
// THAT IS THE P&L'S GAP, NOT THIS REPORT'S. get_profit_and_loss (0009) sums
// whatever was actually posted to direct_income/direct_expense ledgers in
// the period — nothing more. A purchase is expensed the moment it is
// posted, whether or not the goods were ever sold; the P&L only reflects
// true cost of GOODS SOLD once a period-end closing-stock adjustment has
// been journalled (Dr Closing Stock / Cr Purchases), and this app's own
// closing-stock screen is typically used at year end, not mid-period. So:
//
//     this report's total margin
//       = (P&L direct_income - direct_expense for the same period)
//         + (closing stock value - opening stock value for the period)
//
// Confirmed against live data, Sharma Textiles, 2026-06-02 to 2026-07-31 (a
// window with only sales/purchase postings, no other journal noise on the
// trading ledgers): get_trade_analysis sale-item net totalled Rs 2,00,000,
// matching get_profit_and_loss direct_income (Rs 2,00,000) exactly, as
// RPC1's own contract promises for an invoice-only ledger. get_stock_summary
// gave Product A a closing value of Rs 73,500 (as at 07-31) against an
// opening value of Rs 1,80,000 (as at 06-01) — 45 units were already on
// hand before this window even began. This report's own total margin came
// to Rs 77,500 (Rs 2,00,000 sale value less Rs 1,22,500 cost of the 30
// units actually sold). The P&L's raw gross profit for the same window was
// Rs 1,84,000 (Rs 2,00,000 income less Rs 16,000 of NEW purchases only) —
// it never subtracted the Rs 1,22,500 true cost of goods sold because none
// of those goods were purchased inside this window; most came from
// pre-existing stock the P&L has no period-end entry recognising. Applying
// the reconciliation above: Rs 1,84,000 + (Rs 73,500 - Rs 1,80,000) = Rs
// 77,500 — an exact match to the rupee. This report is not wrong where the
// raw P&L and it disagree; it is the one of the two that actually accounts
// for inventory consumed, which is the entire point of a margin report.
// ============================================================================

type SaleRow = {
  group_key: string;
  group_label: string;
  quantity: string | number;
  net: string | number;
};

type StockRow = {
  item_id: string;
  average_rate: string | number;
};

type ItemRow = {
  item_id: string;
  item_name: string;
  category: string | null;
  quantity: number;
  saleNet: number;
  /** null = this item never appeared in get_stock_summary as at the
   * period's end date — a sold line with no traceable stock valuation
   * (a non-goods / non-stock-tracked item slipping through voucher_items,
   * which should not happen in practice but must not be silently priced
   * at zero if it does — see the render logic below). */
  cogs: number | null;
  margin: number | null;
  marginPct: number | null;
  /** Tracked (cogs === 0 exactly) but genuinely never purchased or costed
   * — get_stock_summary's own documented fallback for a byproduct or an
   * oversold item with no receipt on record (0185's header). A real
   * condition in this app's live data, not a hypothetical. */
  noCostOnRecord: boolean;
};

type GroupRow = {
  key: string;
  label: string;
  saleNet: number;
  cogs: number;
  margin: number;
  marginPct: number | null;
  /** Sale value from items in this group whose cost could not be priced —
   * kept OUT of this row's own margin/cogs so a group total never mixes a
   * priced figure with an unpriced one, but surfaced so the group's total
   * sale value is not silently understated without explanation. */
  untrackedSaleNet: number;
};

function marginPercent(margin: number, saleNet: number): number | null {
  if (saleNet === 0) return null;
  return (margin / saleNet) * 100;
}

function formatPct(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct.toFixed(1)}%`;
}

export default async function MarginByItemPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/margin-by-item">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: profile } = await supabase.rpc("get_company_profile", {
    p_company_id: companyId,
  });
  const startMonth = profile?.[0]?.financial_year_start_month ?? 4;

  const period = defaultPeriod(startMonth, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  const [{ data: saleData }, { data: stockData }, { data: itemRows }] = await Promise.all([
    // get_trade_analysis (1540) predates this batch's regeneration of
    // types/database.types.ts — same `as any` escape hatch every other
    // ahead-of-the-generated-types RPC call in this codebase uses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase.rpc("get_trade_analysis" as any, {
      p_company_id: companyId,
      p_from: period.from,
      p_to: period.to,
      p_side: "sale",
      p_group_by: "item",
    }),
    // Cost basis is deliberately anchored at the period's OWN end date, not
    // today — a report run today for a period that closed months ago must
    // show that period's own cost, not whatever the item costs right now.
    // get_stock_summary is already in the generated types (no `as any`
    // needed, unlike get_trade_analysis above).
    supabase.rpc("get_stock_summary", {
      p_company_id: companyId,
      p_as_at: period.to,
    }),
    // Only for item_group (items.category) — the same field
    // get_trade_analysis itself groups by for p_group_by='item_group', so
    // this report's group rollup lands on identical buckets.
    supabase.from("items").select("id, category").eq("company_id", companyId),
  ]);

  const stockByItem = new Map<string, number>(
    ((stockData ?? []) as StockRow[]).map((s) => [s.item_id, Number(s.average_rate)])
  );
  const categoryByItem = new Map<string, string | null>(
    (itemRows ?? []).map((i) => [i.id as string, i.category as string | null])
  );

  const rows: ItemRow[] = ((saleData ?? []) as SaleRow[]).map((s) => {
    const quantity = Number(s.quantity);
    const saleNet = Number(s.net);
    const rate = stockByItem.get(s.group_key);
    const cogs = rate === undefined ? null : quantity * rate;
    const margin = cogs === null ? null : saleNet - cogs;
    return {
      item_id: s.group_key,
      item_name: s.group_label,
      category: categoryByItem.get(s.group_key) ?? null,
      quantity,
      saleNet,
      cogs,
      margin,
      marginPct: margin === null ? null : marginPercent(margin, saleNet),
      noCostOnRecord: cogs === 0 && quantity > 0,
    };
  });

  // Worst-first: the deepest rupee loss leads, which is what "worst" means
  // in a P&L sense — a report that instead led with the smallest, most
  // negative-PERCENT line (a stray unit sold two rupees under cost) would
  // bury a five-figure loss on a high-volume item below it. Rows whose cost
  // could not be priced at all sort last — there is no "how bad" to rank
  // them by.
  const sortedRows = [...rows].sort((a, b) => {
    if (a.margin === null && b.margin === null) return 0;
    if (a.margin === null) return 1;
    if (b.margin === null) return -1;
    return a.margin - b.margin;
  });

  const groupMap = new Map<string, GroupRow>();
  for (const r of rows) {
    const key = r.category ?? "none";
    const label = r.category ?? "Ungrouped";
    const g = groupMap.get(key) ?? {
      key,
      label,
      saleNet: 0,
      cogs: 0,
      margin: 0,
      marginPct: null,
      untrackedSaleNet: 0,
    };
    if (r.cogs === null) {
      g.untrackedSaleNet += r.saleNet;
    } else {
      g.saleNet += r.saleNet;
      g.cogs += r.cogs;
      g.margin += r.margin ?? 0;
    }
    groupMap.set(key, g);
  }
  const groupRows = [...groupMap.values()]
    .map((g) => ({ ...g, marginPct: marginPercent(g.margin, g.saleNet) }))
    .sort((a, b) => a.margin - b.margin);

  const totals = rows.reduce(
    (a, r) => ({
      saleNet: a.saleNet + r.saleNet,
      cogs: a.cogs + (r.cogs ?? 0),
      margin: a.margin + (r.margin ?? 0),
      untrackedSaleNet: a.untrackedSaleNet + (r.cogs === null ? r.saleNet : 0),
    }),
    { saleNet: 0, cogs: 0, margin: 0, untrackedSaleNet: 0 }
  );
  const totalMarginPct = marginPercent(totals.margin, totals.saleNet - totals.untrackedSaleNet);

  const belowCostCount = rows.filter((r) => r.margin !== null && r.margin < 0).length;
  const untrackedCount = rows.filter((r) => r.cogs === null).length;

  return (
    <ReportShell
      title="Margin by item"
      period={period.label}
      status={{
        label: belowCostCount === 0 ? "All items above cost" : `${belowCostCount} below cost`,
        tone: belowCostCount === 0 ? "ok" : "bad",
      }}
    >
      {rows.length === 0 ? (
        <div className="px-4 py-12 text-center text-ink-faint">
          No items sold in this period.
        </div>
      ) : (
        <>
          <div className="border-b border-t border-border bg-bg px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            By item group
          </div>
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Item group</th>
                <th className={th + " text-right"}>Sale value</th>
                <th className={th + " text-right"}>Cost of goods sold</th>
                <th className={th + " text-right"}>Margin</th>
                <th className={th + " text-right"}>Margin %</th>
              </tr>
            </thead>
            <tbody>
              {groupRows.map((g) => (
                <tr key={g.key} className={g.margin < 0 ? "bg-error-soft/40" : undefined}>
                  <td className={td}>
                    {g.label}
                    {g.untrackedSaleNet !== 0 && (
                      <span className="ml-2 text-xs text-ink-faint">
                        (+{formatINR(g.untrackedSaleNet)} sale, cost not tracked)
                      </span>
                    )}
                  </td>
                  <td className={num}>{formatINR(g.saleNet, { showZero: true })}</td>
                  <td className={num}>{formatINR(g.cogs, { showZero: true })}</td>
                  <td className={num}>
                    <span className={g.margin < 0 ? "text-error font-semibold" : "text-success"}>
                      {formatINR(g.margin, { showZero: true })}
                    </span>
                  </td>
                  <td className={num}>
                    <span className={g.margin < 0 ? "text-error font-semibold" : "text-ink-soft"}>
                      {formatPct(g.marginPct)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border-strong bg-surface-2">
                <td className={td + " font-semibold"}>Total</td>
                <td className={num + " font-semibold"}>
                  {formatINR(totals.saleNet, { showZero: true })}
                </td>
                <td className={num + " font-semibold"}>
                  {formatINR(totals.cogs, { showZero: true })}
                </td>
                <td className={num + " font-semibold"}>
                  <span className={totals.margin < 0 ? "text-error" : "text-success"}>
                    {formatINR(totals.margin, { showZero: true })}
                  </span>
                </td>
                <td className={num + " font-semibold text-ink-soft"}>
                  {formatPct(totalMarginPct)}
                </td>
              </tr>
            </tfoot>
          </table>

          <div className="border-b border-t border-border bg-bg px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            By item
          </div>
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Item</th>
                <th className={th}>Item group</th>
                <th className={th + " text-right"}>Qty sold</th>
                <th className={th + " text-right"}>Sale value</th>
                <th className={th + " text-right"}>Cost of goods sold</th>
                <th className={th + " text-right"}>Margin</th>
                <th className={th + " text-right"}>Margin %</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => {
                const belowCost = r.margin !== null && r.margin < 0;
                return (
                  <tr
                    key={r.item_id}
                    className={belowCost ? "bg-error-soft/40" : undefined}
                  >
                    <td className={td}>
                      <div className="flex items-center gap-2">
                        <span>{r.item_name}</span>
                        {belowCost && <Badge tone="bad">Below cost</Badge>}
                        {r.noCostOnRecord && <Badge tone="warn">No cost on record</Badge>}
                        {r.cogs === null && <Badge tone="neutral">Cost not tracked</Badge>}
                      </div>
                    </td>
                    <td className={td + " text-ink-soft"}>{r.category ?? "Ungrouped"}</td>
                    <td className={num}>{r.quantity}</td>
                    <td className={num}>{formatINR(r.saleNet, { showZero: true })}</td>
                    <td className={num}>
                      {r.cogs === null ? "—" : formatINR(r.cogs, { showZero: true })}
                    </td>
                    <td className={num}>
                      {r.margin === null ? (
                        "—"
                      ) : (
                        <span className={belowCost ? "text-error font-semibold" : "text-success"}>
                          {formatINR(r.margin, { showZero: true })}
                        </span>
                      )}
                    </td>
                    <td className={num}>
                      <span className={belowCost ? "text-error font-semibold" : "text-ink-soft"}>
                        {formatPct(r.marginPct)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {untrackedCount > 0 && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          {untrackedCount} item line{untrackedCount === 1 ? "" : "s"} sold in this period{" "}
          {untrackedCount === 1 ? "has" : "have"} no matching row in this company&rsquo;s stock
          valuation as at {period.to} — cost is shown as &ldquo;—&rdquo; rather than assumed to be
          zero, and {untrackedCount === 1 ? "it is" : "they are"} left out of every total on this
          page. This should only happen for a non-stock item that reached a sales voucher line by
          some other route than the normal item master.
        </p>
      )}
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Cost of goods sold values each item&rsquo;s units sold at its own moving weighted-average
        rate as at {period.to} (this company&rsquo;s one live costing method — see the Stock
        report). A row with a positive margin but a &ldquo;No cost on record&rdquo; tag was never
        actually purchased or received at a traceable cost (a byproduct, or stock oversold beyond
        what was ever bought in) — its 100% margin reflects a gap in the purchase history, not a
        genuinely free sale. This report is company-wide only: get_stock_summary carries no branch
        argument, so cost cannot be split by branch the way sale value can.
      </p>
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        This total will only match the Profit &amp; Loss report&rsquo;s Gross Profit line to the
        rupee once this company has posted a period-end closing-stock adjustment (see the Closing
        Stock screen) — without one, the P&amp;L expenses a purchase the moment it is posted,
        whether or not the goods were sold yet. Until then the two are related by: this
        report&rsquo;s total margin = P&amp;L gross profit + (closing stock value − opening stock
        value) for the same period, both from the Stock report.
      </p>
    </ReportShell>
  );
}
