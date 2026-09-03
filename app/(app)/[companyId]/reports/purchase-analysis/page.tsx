import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod, comparativePeriod, periodRangeLabel } from "@/lib/utils/period";
import { readContext } from "@/lib/nav/context";
import { ReportShell, th, td, num } from "@/components/reports/ReportShell";
import { DrillHeadCell, DrillRow, drillHref } from "@/components/reports/DrillLink";

/**
 * Purchase analysis — who/what a company actually buys from, over a period,
 * with a prior-period column so a spend swing is visible without a second
 * screen. Built on get_trade_analysis (1540) with p_side='purchase', the
 * same RPC the sibling Sales analysis report reads with p_side='sale' — see
 * that migration's own header for the full accounting of what "net" and
 * "tax" mean here (credit/debit notes netted off, tax read back from what
 * was actually posted via tax_ledger_map, not re-derived).
 */

type Row = {
  group_key: string;
  group_label: string;
  quantity: number;
  gross: number;
  discount: number;
  net: number;
  tax: number;
  document_count: number;
};

type GroupBy = "party" | "item";

const TOP_OPTIONS: { value: string | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "10", label: "Top 10" },
  { value: "25", label: "Top 25" },
  { value: "50", label: "Top 50" },
];

/**
 * Same-page view/filter links (By supplier | By item, and the top-N chips).
 * Unlike DrillLink's drillHref — which deliberately carries only from/to/
 * branch into a DIFFERENT report — this keeps every query param already on
 * THIS page (including `fy`, which readContext also honours) and only
 * overrides the key the control itself owns. A `null` override clears that
 * key rather than writing a blank one, matching withContext's own rule.
 */
function viewHref(
  sp: Record<string, string | string[] | undefined>,
  overrides: Record<string, string | null>
): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string" && value.trim() !== "") usp.set(key, value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) usp.delete(key);
    else usp.set(key, value);
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : "?";
}

/** Same convention profit-loss/page.tsx already uses for its Schedule III
 * comparative column: undefined/zero prior-period figures read as "no
 * comparable base" rather than a divide-by-zero, and stay "—" instead of a
 * misleading "New"/∞ — a supplier with no prior spend and a genuine 0 prior
 * spend are indistinguishable from this RPC's own output, so this report
 * does not invent a distinction it cannot actually see. */
function variancePct(curr: number, comp: number): number | null {
  if (comp === 0) return null;
  return ((curr - comp) / Math.abs(comp)) * 100;
}

function formatVariance(pct: number | null): string {
  if (pct === null) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function formatQty(n: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);
}

export default async function PurchaseAnalysisPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/purchase-analysis">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month, book_beginning_date")
    .eq("id", companyId)
    .maybeSingle();

  const ctx = readContext(companyId, sp, company?.financial_year_start_month);
  const startMonth = Number(ctx.fyStart.slice(5, 7));

  const bare = defaultPeriod(startMonth);
  const periodLabel =
    ctx.from === bare.from && ctx.to === bare.to ? bare.label : periodRangeLabel(ctx.from, ctx.to);

  const by: GroupBy = sp.by === "item" ? "item" : "party";
  const topParam = typeof sp.top === "string" ? sp.top : undefined;
  const topN = topParam === "10" || topParam === "25" || topParam === "50" ? Number(topParam) : null;

  // Same "does a prior period even exist" guard profit-loss/page.tsx applies
  // to its own comparative column, and for the identical reason: a company
  // whose books began after the comparative window would otherwise show a
  // flat 0 prior spend for every supplier — which reads as "no purchases
  // last year", not as "this company didn't have books yet".
  const comparative = comparativePeriod(ctx.from, ctx.to, startMonth);
  const bookBeginning = company?.book_beginning_date as string | undefined;
  const hasComparative = !!bookBeginning && comparative.to >= bookBeginning;
  const partialComparative = hasComparative && comparative.from < (bookBeginning as string);

  const { data: branch } = ctx.branchId
    ? await supabase
        .from("branches")
        .select("name")
        .eq("id", ctx.branchId)
        .eq("company_id", companyId)
        .maybeSingle()
    : { data: null };
  const branchLabel = ctx.branchId ? ` · ${branch?.name ?? "Unknown branch"}` : "";

  const [{ data: rowsData, error }, { data: compRowsData }] = await Promise.all([
    supabase
      // get_trade_analysis (1540) is not yet in types/database.types.ts,
      // regenerated only by the integration pass. Same `as any` escape
      // hatch every other brand-new-RPC screen in this codebase uses (see
      // reports/outstanding and reports/party-bills' own
      // get_bill_wise_outstanding calls) — the runtime shape is the Row
      // type above, confirmed against the migration's own RETURNS TABLE.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .rpc("get_trade_analysis" as any, {
        p_company_id: companyId,
        p_from: ctx.from,
        p_to: ctx.to,
        p_side: "purchase",
        p_group_by: by,
        p_branch_id: ctx.branchId ?? undefined,
      }),
    hasComparative
      ? supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .rpc("get_trade_analysis" as any, {
            p_company_id: companyId,
            p_from: comparative.from,
            p_to: comparative.to,
            p_side: "purchase",
            p_group_by: by,
            p_branch_id: ctx.branchId ?? undefined,
          })
      : Promise.resolve({ data: [] as Row[] }),
  ]);

  const rows: Row[] = (rowsData ?? []) as unknown as Row[];
  const compRows: Row[] = (compRowsData ?? []) as unknown as Row[];
  const compByKey = new Map<string, number>(compRows.map((r) => [r.group_key, Number(r.net)]));

  // Ranked by net purchase value (the taxable value actually posted, not
  // gross-before-discount) — the RPC's own ORDER BY is gross-descending,
  // which this page deliberately overrides so "top supplier" means the same
  // thing here as it does on the P&L this figure reconciles to.
  const sorted = [...rows].sort((a, b) => Number(b.net) - Number(a.net));

  const totalGross = sorted.reduce((n, r) => n + Number(r.gross), 0);
  const totalDiscount = sorted.reduce((n, r) => n + Number(r.discount), 0);
  const totalNet = sorted.reduce((n, r) => n + Number(r.net), 0);
  const totalTax = sorted.reduce((n, r) => n + Number(r.tax), 0);
  const totalDocs = sorted.reduce((n, r) => n + Number(r.document_count), 0);
  const totalQty = sorted.reduce((n, r) => n + Number(r.quantity), 0);
  // Summed over the SAME rows the "Prior period" column sums, not over every
  // prior-period group that ever existed — so this footer figure always ties
  // to the column above it, the same "ties to X" discipline cost-centre-pnl's
  // own total row already documents for itself.
  const compTotalNet = sorted.reduce((n, r) => n + (compByKey.get(r.group_key) ?? 0), 0);

  const displayRows = topN ? sorted.slice(0, topN) : sorted;
  const shownNet = displayRows.reduce((n, r) => n + Number(r.net), 0);
  const shownSharePct = totalNet !== 0 ? (shownNet / totalNet) * 100 : 0;

  const noun = by === "party" ? "suppliers" : "items";
  const statementHref = `/${companyId}/reports/ledger-statement`;

  return (
    <ReportShell
      title="Purchase analysis"
      period={periodLabel + branchLabel}
      status={{
        label: `${formatINR(totalNet, { showZero: true })} net purchases`,
        tone: totalNet >= 0 ? "ok" : "warn",
      }}
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-sm print:hidden">
        <a
          href={viewHref(sp, { by: "party" })}
          className={by === "party" ? "font-semibold" : "text-ink-soft underline underline-offset-4"}
        >
          By supplier
        </a>
        <span className="text-ink-faint">|</span>
        <a
          href={viewHref(sp, { by: "item" })}
          className={by === "item" ? "font-semibold" : "text-ink-soft underline underline-offset-4"}
        >
          By item
        </a>
        <div className="ml-auto flex items-center gap-1.5 text-xs">
          <span className="text-ink-faint">Show</span>
          {TOP_OPTIONS.map((opt) => {
            const active = opt.value === topParam || (opt.value === null && !topN);
            return (
              <a
                key={opt.label}
                href={viewHref(sp, { top: opt.value })}
                className={
                  "rounded-full border px-2.5 py-1 " +
                  (active
                    ? "border-accent bg-accent-soft font-medium text-accent"
                    : "border-border-strong text-ink-soft hover:bg-surface-2")
                }
              >
                {opt.label}
              </a>
            );
          })}
        </div>
      </div>

      {error && (
        <p className="m-4 rounded-lg bg-error-soft px-3 py-2 text-sm text-error">{error.message}</p>
      )}

      {topN && sorted.length > topN && (
        <p className="border-b border-border bg-surface-2 px-4 py-2 text-xs text-ink-faint print:hidden">
          Showing top {topN} of {sorted.length} {noun} by net purchase value —{" "}
          {formatINR(shownNet, { showZero: true })} ({shownSharePct.toFixed(1)}%) of{" "}
          {formatINR(totalNet, { showZero: true })} total net purchases in this period.
        </p>
      )}

      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>{by === "party" ? "Supplier" : "Item"}</th>
            {by === "item" && <th className={th + " text-right"}>Quantity</th>}
            <th className={th + " text-right"}>Bills</th>
            <th className={th + " text-right"}>Gross</th>
            <th className={th + " text-right"}>Discount</th>
            <th className={th + " text-right"}>Net purchase</th>
            <th className={th + " text-right"}>Input GST</th>
            <th
              className={th + " text-right"}
              title={
                hasComparative
                  ? `${periodRangeLabel(comparative.from, comparative.to)} — same window, one year back`
                  : "No comparable prior period (before the books began)"
              }
            >
              Prior period
            </th>
            <th className={th + " text-right"}>Change</th>
            {by === "party" && <DrillHeadCell />}
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-4 py-12 text-center text-ink-faint">
                No purchase activity in this period.
              </td>
            </tr>
          )}
          {displayRows.map((r) => {
            const compNet = compByKey.get(r.group_key) ?? 0;
            const changeCell = (
              <td className={num}>{hasComparative ? formatVariance(variancePct(Number(r.net), compNet)) : "—"}</td>
            );
            const priorCell = (
              <td className={num + " text-ink-soft"}>
                {hasComparative ? formatINR(compNet, { showZero: true }) : "—"}
              </td>
            );

            const cells = (
              <>
                {by === "item" && <td className={num}>{formatQty(Number(r.quantity))}</td>}
                <td className={num + " text-ink-faint"}>{r.document_count}</td>
                <td className={num}>{formatINR(Number(r.gross))}</td>
                <td className={num}>{formatINR(Number(r.discount))}</td>
                <td className={num + " font-medium"}>{formatINR(Number(r.net))}</td>
                <td className={num}>{formatINR(Number(r.tax))}</td>
                {priorCell}
                {changeCell}
              </>
            );

            // The party ('supplier') view is drillable into the ledger
            // statement — a real document list a figure can be checked
            // against. There is no per-item document list anywhere in this
            // app to drill the item view into (get_daybook and
            // VoucherTypeList both filter by date only, never by item), so
            // that view renders plain rows rather than a chevron that opens
            // nothing useful. 'none' (cash purchases, no party ledger) is
            // the same case within the supplier view for the same reason —
            // there is no ledger to open.
            if (by === "party" && r.group_key !== "none") {
              return (
                <DrillRow
                  key={r.group_key}
                  href={statementHref}
                  params={{ ledger: r.group_key, from: ctx.from, to: ctx.to, branch: ctx.branchId }}
                  carry={sp}
                  label={r.group_label}
                >
                  <td className={td + " font-medium"}>
                    <Link
                      href={drillHref(
                        statementHref,
                        { ledger: r.group_key, from: ctx.from, to: ctx.to, branch: ctx.branchId },
                        sp
                      )}
                      className="rounded-sm underline-offset-4 outline-none hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/30"
                    >
                      {r.group_label}
                    </Link>
                  </td>
                  {cells}
                </DrillRow>
              );
            }

            return (
              <tr key={r.group_key} className="border-b border-border last:border-0">
                <td className={td + " font-medium"}>{r.group_label}</td>
                {cells}
                {by === "party" && <td className="print:hidden" />}
              </tr>
            );
          })}
        </tbody>
        {sorted.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5">
                Total ({sorted.length} {noun})
              </td>
              {by === "item" && <td className={num}>{formatQty(totalQty)}</td>}
              <td className={num}>{totalDocs}</td>
              <td className={num}>{formatINR(totalGross, { showZero: true })}</td>
              <td className={num}>{formatINR(totalDiscount, { showZero: true })}</td>
              <td className={num}>{formatINR(totalNet, { showZero: true })}</td>
              <td className={num}>{formatINR(totalTax, { showZero: true })}</td>
              <td className={num}>{hasComparative ? formatINR(compTotalNet, { showZero: true }) : "—"}</td>
              <td className={num}>
                {hasComparative ? formatVariance(variancePct(totalNet, compTotalNet)) : "—"}
              </td>
              {by === "party" && <td className="px-4 py-2.5 print:hidden" />}
            </tr>
          </tfoot>
        )}
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Net purchase value is the taxable value actually posted to the trading account — the same
        figure the Profit &amp; Loss purchases line reconciles to for an invoice-only ledger. A
        debit note nets off against the purchase it returns (same party/item, opposite sign) rather
        than counting as separate trade. Input GST is read back from what was actually posted, not
        re-derived — RCM and TCS are excluded, since neither is tax charged on the trade itself.
        Scope is limited to bills with item lines: a service-only purchase entered without stock
        items contributes nothing here.
        {hasComparative ? (
          <>
            {" "}
            Prior period is {periodRangeLabel(comparative.from, comparative.to)}
            {partialComparative ? ", shortened to start when this company's books began" : ""} — the
            same window one year back for a custom range, or the prior financial year for a period
            that runs a full year.
          </>
        ) : (
          " No prior-period column is shown: the comparable window falls before this company's books began, so a flat zero there would misread as “no purchases last year” rather than “no books yet.”"
        )}
      </p>
    </ReportShell>
  );
}
