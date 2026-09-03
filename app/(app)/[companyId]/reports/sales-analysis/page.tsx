import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod, periodRangeLabel } from "@/lib/utils/period";
import { readContext } from "@/lib/nav/context";
import { editHrefFor } from "@/lib/utils/voucher";
import { cn } from "@/lib/utils/cn";
import { ReportShell, th, td, num } from "@/components/reports/ReportShell";
import {
  DrillHeadCell,
  DrillRow,
  drillHref,
  type DrillParams,
} from "@/components/reports/DrillLink";

/**
 * Sales analysis — who/what is actually driving revenue, not just what the
 * ledgers tally to. Built on RPC1 (public.get_trade_analysis, p_side fixed
 * to 'sale' — this page never shows purchases), grouped by 'party' or
 * 'item' per the contract in AGENTS.md. One route, two views, switched by
 * `?by=customer|item` rather than a second page, because the two are the
 * same query with a different p_group_by and would otherwise duplicate
 * every bit of period/branch/limit/comparison plumbing below.
 *
 * ---------------------------------------------------------------------------
 * Drill target: why both views drill into THIS SAME page, not a separate
 * screen.
 * ---------------------------------------------------------------------------
 * The obvious drill destination for a customer row is the existing
 * ledger-statement report (trial-balance's own drill goes there for exactly
 * this reason). It was rejected here because ledger-statement shows Dr/Cr
 * movement on the party's ledger — tax-INCLUSIVE, and mixed with receipts,
 * opening balances and anything else posted to that ledger — which does not
 * sum back to this report's "net" figure (the taxable value actually posted
 * to the trading ledger, per RPC1's contract). For the item view there is no
 * equivalent screen at all: nothing in this app lists "every document this
 * item appeared on".
 *
 * So a row's chevron instead re-opens THIS route with `?drill=<group_key>`
 * added, and when that param is present the page runs one more query —
 * plain voucher_items/vouchers reads, not a new RPC — that reproduces
 * RPC1's own signed-net rule (sales +1, credit_note -1, netted per line) at
 * the per-DOCUMENT level instead of aggregated. That is deliberately the
 * exact same arithmetic the RPC does internally (confirmed by hand against
 * a real company via sbq before this page shipped — see the PR/commit
 * description for the numbers), so the documents panel's own total always
 * reconciles to the summary row's net. Each document then drills one level
 * further, via the same DrillRow component, straight to the real voucher
 * through editHrefFor — so a figure that looks wrong is never more than two
 * clicks from the actual invoice that produced it.
 *
 * ---------------------------------------------------------------------------
 * Comparison column: "same period one year prior" is a straight calendar
 * shift, not lib/utils/period.ts's comparativePeriod().
 * ---------------------------------------------------------------------------
 * comparativePeriod() is right for Schedule III statements, but it does two
 * DIFFERENT things depending on the shape of the current period: for a full
 * financial year it shifts back one year, but for any custom range (which a
 * `?from=&to=` on this report very often is) it instead returns the
 * immediately-PRECEDING period of the same length — not the same calendar
 * dates a year ago. This report was asked for "the SAME period one year
 * prior" unconditionally, so it does its own one-year calendar shift
 * (shiftOneYearBack below) rather than importing a helper whose custom-range
 * branch would silently answer a different question.
 *
 * The comparison is gated on the company's own book_beginning_date, the same
 * guard the Profit & Loss comparative column already uses and for the same
 * reason: a company whose books started after the prior-year window would
 * otherwise show a real 0 next to this year's figure, which reads as "100%
 * decline" rather than "did not exist yet".
 */

type AnalysisRow = {
  group_key: string;
  group_label: string;
  quantity: number;
  net: number;
  tax: number;
  document_count: number;
};

type DocumentRow = {
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  voucher_type: string;
  quantity: number;
  net: number;
};

const LIMIT_OPTIONS = [10, 20, 50, 100] as const;
const DEFAULT_LIMIT = 20;

/** A date string as an instant at noon UTC — the same anchor period.ts uses
 * throughout, far enough from both midnights that no interpretation of the
 * value can slip it a day. */
function atNoonUTC(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function isoUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The same calendar day and month, one year earlier — a straight UTC
 * year-shift, never a millisecond subtraction (that drifts across leap
 * years, the exact bug class period.ts's header warns about). 29 Feb rolls
 * over to 1 Mar in a non-leap prior year, the same well-defined behaviour
 * comparativePeriod() itself accepts rather than special-cases. */
function shiftOneYearBack(date: string): string {
  const d = atNoonUTC(date);
  return isoUTC(new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate())));
}

export default async function SalesAnalysisPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/sales-analysis">) {
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

  const { data: branch } = ctx.branchId
    ? await supabase.from("branches").select("name").eq("id", ctx.branchId).eq("company_id", companyId).maybeSingle()
    : { data: null };
  const branchLabel = ctx.branchId ? ` · ${branch?.name ?? "Unknown branch"}` : "";

  const groupBy: "customer" | "item" = sp.by === "item" ? "item" : "customer";
  const rpcGroupBy = groupBy === "item" ? "item" : "party";

  const limitRaw = typeof sp.limit === "string" ? sp.limit : undefined;
  const limitNumber = limitRaw !== undefined ? Number(limitRaw) : NaN;
  const limit =
    limitRaw === "all"
      ? null
      : Number.isFinite(limitNumber) && limitNumber > 0
        ? Math.floor(limitNumber)
        : DEFAULT_LIMIT;

  const drillKey = typeof sp.drill === "string" && sp.drill.trim() !== "" ? sp.drill : null;

  const priorFrom = shiftOneYearBack(ctx.from);
  const priorTo = shiftOneYearBack(ctx.to);
  const bookBeginning = company?.book_beginning_date as string | null | undefined;
  // See the header comment: a real 0 for a period before the books began is
  // not a genuine decline, so the comparison is only attempted — and only
  // rendered as figures rather than "—" — once the books actually reach it.
  const hasComparative = !!bookBeginning && priorTo >= bookBeginning;

  const basePath = `/${companyId}/reports/sales-analysis`;

  // Every link this page renders shares the same ambient state (view, limit,
  // drill, period, branch) unless it deliberately overrides one key — this
  // is that one build function instead of five near-duplicate drillHref
  // calls that could drift out of sync with each other.
  function hrefFor(extra: DrillParams): string {
    return drillHref(
      basePath,
      {
        by: groupBy,
        limit: limitRaw,
        drill: drillKey,
        from: ctx.from,
        to: ctx.to,
        branch: ctx.branchId,
        ...extra,
      },
      sp
    );
  }

  const [{ data: currentRowsRaw, error }, { data: priorRowsRaw }] = await Promise.all([
    supabase
      // get_trade_analysis is real and live (confirmed via sbq before this
      // page was written) but predates this task's batch —
      // types/database.types.ts has not been regenerated against it yet —
      // the same escape hatch every other ahead-of-the-generated-types RPC
      // call in this codebase uses.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .rpc("get_trade_analysis" as any, {
        p_company_id: companyId,
        p_from: ctx.from,
        p_to: ctx.to,
        p_side: "sale",
        p_group_by: rpcGroupBy,
        p_branch_id: ctx.branchId ?? undefined,
      }),
    hasComparative
      ? supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .rpc("get_trade_analysis" as any, {
            p_company_id: companyId,
            p_from: priorFrom,
            p_to: priorTo,
            p_side: "sale",
            p_group_by: rpcGroupBy,
            p_branch_id: ctx.branchId ?? undefined,
          })
      : Promise.resolve({ data: [] as AnalysisRow[] }),
  ]);

  const allRows = (currentRowsRaw ?? []) as AnalysisRow[];
  const priorByKey = new Map<string, number>(
    ((priorRowsRaw ?? []) as AnalysisRow[]).map((r) => [r.group_key, Number(r.net)])
  );

  // RPC1's own ORDER BY sorts by gross, not net — this report's whole point
  // is "who/what makes the most money", so it re-sorts by net before slicing
  // to the Top-N rather than trusting the RPC's column order.
  const sorted = [...allRows].sort((a, b) => Number(b.net) - Number(a.net));
  const visible = limit !== null ? sorted.slice(0, limit) : sorted;

  const grandTotal = allRows.reduce(
    (acc, r) => ({ net: acc.net + Number(r.net), tax: acc.tax + Number(r.tax), docs: acc.docs + Number(r.document_count) }),
    { net: 0, tax: 0, docs: 0 }
  );
  const shownTotal = visible.reduce(
    (acc, r) => ({ net: acc.net + Number(r.net), tax: acc.tax + Number(r.tax), docs: acc.docs + Number(r.document_count) }),
    { net: 0, tax: 0, docs: 0 }
  );

  // ---------------------------------------------------------------------
  // Drill panel: real documents behind one row, fetched only when a row's
  // chevron was actually clicked. See the header comment for why this
  // reproduces RPC1's netting by hand instead of calling back into it.
  // ---------------------------------------------------------------------
  let documents: DocumentRow[] = [];
  let drillLabel = "";
  if (drillKey) {
    const matchedRow = allRows.find((r) => r.group_key === drillKey);
    drillLabel = matchedRow?.group_label ?? "";

    // `voucher_items!inner(...)` in BOTH branches, matching RPC1's own inner
    // join from voucher_items to vouchers — a voucher with zero item lines
    // (a service-only sale entered via the generic voucher form) contributes
    // nothing to get_trade_analysis per its contract, and a plain left join
    // here would otherwise surface it as a stray zero-line, zero-net row in
    // the documents panel. The item branch additionally filters on item_id,
    // or a voucher with nine unrelated lines and one matching line would
    // come back with all nine still attached.
    //
    // Reassigning `query` across .eq/.in/.gte/.lte/.is below is safe despite
    // the two branches' different `.select()` shapes: every one of those
    // filter methods is typed against the TABLE row (vouchers), which is
    // identical in both branches — only the embedded `Result` shape differs,
    // and none of these methods touch that.
    let query =
      groupBy === "item"
        ? supabase
            .from("vouchers")
            .select("id, voucher_number, voucher_date, voucher_type, voucher_items!inner(item_id, quantity, amount)")
            .eq("voucher_items.item_id", drillKey)
        : supabase
            .from("vouchers")
            .select("id, voucher_number, voucher_date, voucher_type, voucher_items!inner(quantity, amount)");

    query = query
      .eq("company_id", companyId)
      .eq("is_deleted", false)
      .in("voucher_type", ["sales", "credit_note"])
      .gte("voucher_date", ctx.from)
      .lte("voucher_date", ctx.to);

    if (ctx.branchId) query = query.eq("branch_id", ctx.branchId);

    // party_ledger_id is nullable (cash sales carry no party at all), so the
    // "none" group needs IS NULL — an .eq() against a literal null would not
    // match it the way PostgREST/SQL null semantics work.
    if (groupBy === "customer") {
      query = drillKey === "none" ? query.is("party_ledger_id", null) : query.eq("party_ledger_id", drillKey);
    }

    const { data: docRows } = await query;

    documents = ((docRows ?? []) as unknown as Array<{
      id: string;
      voucher_number: string;
      voucher_date: string;
      voucher_type: string;
      voucher_items: { quantity: number; amount: number }[] | null;
    }>)
      .map((v) => {
        // Same sign rule as RPC1's doc_sign: +1 for the primary type
        // ('sales' on the sale side), -1 for its return ('credit_note').
        const sign = v.voucher_type === "credit_note" ? -1 : 1;
        const lines = v.voucher_items ?? [];
        return {
          voucher_id: v.id,
          voucher_number: v.voucher_number,
          voucher_date: v.voucher_date,
          voucher_type: v.voucher_type,
          quantity: sign * lines.reduce((s, l) => s + Number(l.quantity), 0),
          net: sign * lines.reduce((s, l) => s + Number(l.amount), 0),
        };
      })
      .sort((a, b) => a.voucher_date.localeCompare(b.voucher_date) || a.voucher_number.localeCompare(b.voucher_number));
  }
  const documentsTotal = documents.reduce((n, d) => n + d.net, 0);

  return (
    <ReportShell title="Sales Analysis" period={periodLabel + branchLabel}>
      {error && (
        <p className="m-4 rounded-lg bg-error-soft px-3 py-2 text-sm text-error">{error.message}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 print:hidden">
        <div className="flex items-center gap-1 rounded-lg bg-surface-2 p-1 text-sm">
          {(["customer", "item"] as const).map((v) => (
            <Link
              key={v}
              href={hrefFor({ by: v, drill: null })}
              className={cn(
                "rounded-md px-3 py-1 font-medium transition-colors",
                groupBy === v ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink"
              )}
            >
              By {v === "customer" ? "customer" : "item"}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-ink-soft">Top</span>
          {LIMIT_OPTIONS.map((n) => (
            <Link
              key={n}
              href={hrefFor({ limit: n })}
              className={cn(
                "rounded-md border px-2.5 py-1",
                limit === n ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2"
              )}
            >
              {n}
            </Link>
          ))}
          <Link
            href={hrefFor({ limit: "all" })}
            className={cn(
              "rounded-md border px-2.5 py-1",
              limit === null ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2"
            )}
          >
            All
          </Link>
        </div>
      </div>

      <p className="px-4 py-2 text-xs text-ink-faint print:hidden">
        {groupBy === "customer" ? "Customers" : "Items"}: showing {visible.length} of {allRows.length} · total net{" "}
        {formatINR(grandTotal.net, { showZero: true })} across {grandTotal.docs} documents
        {hasComparative
          ? ` · vs ${periodRangeLabel(priorFrom, priorTo)}`
          : " · no prior-year comparison (books did not go back that far)"}
      </p>

      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr>
            <th className={th}>{groupBy === "customer" ? "Customer" : "Item"}</th>
            {groupBy === "item" && <th className={th + " text-right"}>Qty</th>}
            <th className={th + " text-right"}>Net</th>
            <th className={th + " text-right"}>Tax</th>
            <th className={th + " text-right"}>Docs</th>
            <th className={th + " text-right"}>vs last year</th>
            <DrillHeadCell />
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={groupBy === "item" ? 7 : 6} className="px-4 py-12 text-center text-ink-faint">
                Nothing sold in this period.
              </td>
            </tr>
          )}
          {visible.map((r) => {
            const net = Number(r.net);
            const prior = priorByKey.get(r.group_key);
            const drillParams: DrillParams = {
              by: groupBy,
              limit: limitRaw,
              drill: r.group_key,
              from: ctx.from,
              to: ctx.to,
              branch: ctx.branchId,
            };

            return (
              <DrillRow key={r.group_key} href={basePath} params={drillParams} carry={sp} label={r.group_label}>
                <td className={td + " font-medium"}>
                  <Link
                    href={drillHref(basePath, drillParams, sp)}
                    className="rounded-sm underline-offset-4 outline-none hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/30"
                  >
                    {r.group_label}
                  </Link>
                </td>
                {groupBy === "item" && <td className={num}>{Number(r.quantity)}</td>}
                <td className={num}>{formatINR(net)}</td>
                <td className={num}>{formatINR(Number(r.tax))}</td>
                <td className={num}>{r.document_count}</td>
                <td className={num}>
                  {!hasComparative ? (
                    <span className="text-ink-faint">—</span>
                  ) : prior === undefined || prior === 0 ? (
                    net !== 0 ? (
                      <span className="text-success">New</span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )
                  ) : (
                    <span className="whitespace-nowrap">
                      {formatINR(prior)}{" "}
                      <span className={cn("text-xs", net >= prior ? "text-success" : "text-error")}>
                        ({net >= prior ? "+" : ""}
                        {(((net - prior) / Math.abs(prior)) * 100).toFixed(1)}%)
                      </span>
                    </span>
                  )}
                </td>
              </DrillRow>
            );
          })}
        </tbody>
        {visible.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5" colSpan={groupBy === "item" ? 2 : 1}>
                Total (shown)
              </td>
              <td className={num}>{formatINR(shownTotal.net, { showZero: true })}</td>
              <td className={num}>{formatINR(shownTotal.tax, { showZero: true })}</td>
              <td className={num}>{shownTotal.docs}</td>
              <td className={num} />
              <td className="px-4 py-2.5 print:hidden" />
            </tr>
          </tfoot>
        )}
      </table>

      {drillKey && (
        <div className="mt-6 border-t border-border">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">
              Documents — {drillLabel || (drillKey === "none" ? "Cash / No Party" : drillKey)}
            </h2>
            <Link
              href={hrefFor({ drill: null })}
              className="text-xs text-accent underline underline-offset-4 print:hidden"
            >
              Close
            </Link>
          </div>
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr>
                <th className={th}>Date</th>
                <th className={th}>Voucher</th>
                {groupBy === "item" && <th className={th + " text-right"}>Qty</th>}
                <th className={th + " text-right"}>Net</th>
                <DrillHeadCell />
              </tr>
            </thead>
            <tbody>
              {documents.length === 0 && (
                <tr>
                  <td colSpan={groupBy === "item" ? 5 : 4} className="px-4 py-8 text-center text-ink-faint">
                    No documents found for this selection.
                  </td>
                </tr>
              )}
              {documents.map((d) => (
                <DrillRow
                  key={d.voucher_id}
                  href={editHrefFor(companyId, d.voucher_id, d.voucher_type)}
                  label={d.voucher_number}
                >
                  <td className={td}>{d.voucher_date}</td>
                  <td className={td}>
                    {d.voucher_number}
                    <span className="ml-2 text-xs text-ink-faint">
                      {d.voucher_type === "credit_note" ? "Credit note" : "Sales"}
                    </span>
                  </td>
                  {groupBy === "item" && <td className={num}>{d.quantity}</td>}
                  <td className={num}>{formatINR(d.net)}</td>
                </DrillRow>
              ))}
            </tbody>
            {documents.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-border-strong bg-bg font-semibold">
                  <td className="px-4 py-2.5" colSpan={groupBy === "item" ? 3 : 2}>
                    Total (documents)
                  </td>
                  <td className={num}>{formatINR(documentsTotal, { showZero: true })}</td>
                  <td className="px-4 py-2.5 print:hidden" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </ReportShell>
  );
}
