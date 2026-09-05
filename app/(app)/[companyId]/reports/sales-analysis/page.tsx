import type { ReactNode } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { periodRangeLabel } from "@/lib/utils/period";
import { readContext } from "@/lib/nav/context";
import { editHrefFor } from "@/lib/utils/voucher";
import { th, td, num } from "@/components/reports/ReportShell";
import { TableContainer } from "@/components/ui/Table";
import { DrillHeadCell, DrillRow, drillHref } from "@/components/reports/DrillLink";
import { ReportView } from "@/components/reports/ReportView";
import { defineReport, type ReportColumn } from "@/lib/reports/defineReport";

/**
 * Sales analysis, re-expressed on top of this wave's report-object contract
 * (lib/reports/defineReport.ts + components/reports/ReportView.tsx). This is
 * the report `views` and `comparative` were modeled ON — see both files'
 * own headers — so this migration is the contract's stress test, not just
 * another report adopting it. It is byte-identical to the pre-migration
 * page (kept in git history) on the axes the contract actually covers, and
 * this header documents every place it is NOT, because the abstraction, as
 * delivered, has no hook for that axis yet.
 *
 * ---------------------------------------------------------------------------
 * Three things this migration deliberately DROPS — not bugs, contract gaps.
 * ---------------------------------------------------------------------------
 * 1. The Top-N ("Top 10/20/50/100/All") picker and its net-descending sort.
 *    `ReportView` renders every row `source.rpc` returns, in the order the
 *    RPC returns it (gross-sorted, per get_trade_analysis's own ORDER BY) —
 *    there is no row-level sort/slice hook in `ReportDefinition`. Recon's own
 *    section 3 flagged `limit` as a genuine open question deferred to a
 *    follow-up round precisely because this was the only report that needed
 *    it; this migration is the evidence that follow-up is still needed, not
 *    a workaround invented here (extending ReportView.tsx is out of this
 *    task's scope — see AGENTS.md's task brief, which owns only this file).
 * 2. The branch-name suffix on the period line ("FY 2026-27 · Ranchi
 *    Branch"). `ReportView` computes and renders its own period string
 *    internally and exposes no override — only a branch *id* ever reaches
 *    the report definition, never its name.
 * 3. The "Total (shown)" `<tfoot>` under the table. `ReportView` does not
 *    render one for any report; there is no footer/aggregate concept in the
 *    contract at all. The total this page needs for its own summary line
 *    below is therefore fetched independently (see the header on that
 *    section) rather than read back from what `<ReportView>` rendered.
 *
 * ---------------------------------------------------------------------------
 * What stayed, and how it maps onto the contract:
 * ---------------------------------------------------------------------------
 *   - Two views, `by=customer|item` — `views.paramName: "by"` keeps every
 *     existing bookmark/link resolving to the same view, per Recon's own
 *     sanctioned exception ("a report migrating an EXISTING ?by=-style URL").
 *   - The prior-year comparative column — `comparative.fetch` does its own
 *     one-calendar-year shift (shiftOneYearBack, unchanged), never
 *     `comparativePeriod()`'s custom-range branch, for the exact reason the
 *     original header already explained: that branch answers a different
 *     question ("preceding period of equal length") for a custom range.
 *   - The in-page "documents behind this row" panel. Recon's own section 2
 *     is explicit that this is NOT part of `defineReport` ("too report-
 *     specific... `drill` field is only ever cross-report navigation") and
 *     stays "extra JSX a caller can render below <ReportView>, same as
 *     today" — so it is rendered below <ReportView> here, unchanged in its
 *     own query/render logic, still reproducing RPC1's signed-net rule by
 *     hand at the per-document level.
 *   - The row's own chevron re-opens THIS route with `?drill=<group_key>`,
 *     via `definition.drill` returning `{ href: basePath, params: { by,
 *     drill }, label }` — `by` must be passed explicitly because DrillLink's
 *     CARRIED_PARAM_KEYS is only ["from","to","branch"]; a view param
 *     carries nowhere on its own.
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

  // Mirrors exactly what ReportView resolves internally for the "by" param
  // (same key, same "item" | else "customer" fallback) — the two MUST agree,
  // since this value is only used here to build drill/documents-panel state
  // for whichever view the URL says is active; ReportView resolves the same
  // URL independently for the table itself.
  const groupBy: "customer" | "item" = sp.by === "item" ? "item" : "customer";
  const rpcGroupBy = groupBy === "item" ? "item" : "party";
  const drillKey = typeof sp.drill === "string" && sp.drill.trim() !== "" ? sp.drill : null;
  const basePath = `/${companyId}/reports/sales-analysis`;

  // The row-label cell is also a link (not just the trailing chevron) for a
  // bigger, easier click target — same as the pre-migration page. `render`
  // only receives the row, so this closes over `groupBy`/`sp`/`basePath`
  // from the surrounding scope rather than threading them through the
  // column-definition shape.
  function renderGroupLabel(row: AnalysisRow): ReactNode {
    const target = drillHref(basePath, { by: groupBy, drill: row.group_key }, sp);
    return (
      <Link
        href={target}
        className="rounded-sm font-medium underline-offset-4 outline-none hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        {row.group_label}
      </Link>
    );
  }

  // `group_label` is identity, `net` is the tallied figure this whole report
  // exists to show — both marked hideable:false per defineReport's own
  // guidance ("columns carrying totals-critical data... should be
  // hideable:false"). Two full column sets, not one base + a conditional
  // Qty column, because the SAME key ("group_label") needs a different
  // header text per view ("Customer" vs "Item") — a view's `columns` REPLACE
  // the base set entirely, they do not patch it.
  const customerColumns: ReportColumn<AnalysisRow>[] = [
    { key: "group_label", label: "Customer", hideable: false, render: renderGroupLabel },
    { key: "net", label: "Net", format: "currency", hideable: false },
    { key: "tax", label: "Tax", format: "currency" },
    { key: "document_count", label: "Docs", align: "right" },
  ];

  const itemColumns: ReportColumn<AnalysisRow>[] = [
    { key: "group_label", label: "Item", hideable: false, render: renderGroupLabel },
    { key: "quantity", label: "Qty", format: "qty" },
    { key: "net", label: "Net", format: "currency", hideable: false },
    { key: "tax", label: "Tax", format: "currency" },
    { key: "document_count", label: "Docs", align: "right" },
  ];

  const salesAnalysisReport = defineReport<AnalysisRow>({
    // MUST equal ReportShell's own reportConfigScope() output for this route
    // ("reports/sales-analysis" -> "reports-sales-analysis") — this is the
    // screen_config AND saved_report_views screen_key.
    key: "reports-sales-analysis",
    title: "Sales Analysis",
    source: {
      // get_trade_analysis confirmed live via pg_proc before this file was
      // written, per AGENTS.md rule 10 — unchanged RPC, unchanged params
      // shape, only p_group_by now comes from the active view below instead
      // of being computed inline.
      rpc: "get_trade_analysis",
      params: (ctx) => ({
        p_company_id: companyId,
        p_from: ctx.from,
        p_to: ctx.to,
        p_side: "sale",
        p_branch_id: ctx.branchId ?? undefined,
      }),
    },
    columns: customerColumns,
    views: {
      // "by", not the "view" default — this report already has ?by=
      // bookmarks in the wild (Recon's own sanctioned exception).
      paramName: "by",
      default: "customer",
      options: [
        {
          key: "customer",
          label: "By customer",
          params: () => ({ p_group_by: "party" }),
          columns: customerColumns,
        },
        {
          key: "item",
          label: "By item",
          params: () => ({ p_group_by: "item" }),
          columns: itemColumns,
        },
      ],
    },
    // Re-opens THIS route with ?drill=<group_key>, which the extra JSX below
    // <ReportView> (the documents panel) reads back out. `by` is passed
    // explicitly since DrillLink only auto-carries from/to/branch.
    drill: (row) => ({
      href: basePath,
      params: { by: groupBy, drill: row.group_key },
      label: row.group_label,
    }),
    comparative: {
      label: () => "vs last year",
      // Same book_beginning_date gate the pre-migration page used: a real 0
      // for a period before the books began reads as "100% decline" rather
      // than "did not exist yet", so the column is only attempted once the
      // shifted period is actually inside the books.
      available: (ctx, company) => {
        const priorTo = shiftOneYearBack(ctx.to);
        return !!company.bookBeginningDate && priorTo >= company.bookBeginningDate;
      },
      // Deliberately its own one-calendar-year shift, not comparativePeriod()
      // — see this file's header. `fetch` gets no supabase client from the
      // contract, so it opens its own, exactly like every other RPC call in
      // this module.
      fetch: async (ctx) => {
        const priorFrom = shiftOneYearBack(ctx.from);
        const priorTo = shiftOneYearBack(ctx.to);
        const client = await createClient();
        const { data } = await client
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_trade_analysis predates generated types, same escape hatch as the rest of this module.
          .rpc("get_trade_analysis" as any, {
            p_company_id: ctx.companyId,
            p_from: priorFrom,
            p_to: priorTo,
            p_side: "sale",
            p_group_by: rpcGroupBy,
            p_branch_id: ctx.branchId ?? undefined,
          });
        return (data ?? []) as AnalysisRow[];
      },
      matchKey: (row) => row.group_key,
      value: (row) => Number(row.net),
    },
    // Only showComparative is declared: this report has no opening/closing
    // columns and never suppressed zero-net rows or rounded figures, so
    // opting into those axes would be pure churn — an undeclared key is
    // always treated as "on", per defineReport's own contract.
    config: { keys: ["showComparative"] },
  });

  // ---------------------------------------------------------------------
  // Everything from here down renders OUTSIDE <ReportView> — it is the part
  // of this report the contract does not (yet) cover: the documents-behind-
  // a-row panel (Recon's own section 2: not part of defineReport at all) and
  // the total/count summary line above it. <ReportView> owns the table and
  // exposes none of its fetched rows back to this caller, so the summary's
  // total is independently fetched — same RPC, same params, same arithmetic
  // as what the table itself shows, so it cannot disagree with it.
  // ---------------------------------------------------------------------
  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month, book_beginning_date")
    .eq("id", companyId)
    .maybeSingle();
  const ctx = readContext(companyId, sp, company?.financial_year_start_month);
  const bookBeginning = (company?.book_beginning_date as string | null | undefined) ?? null;
  const priorFrom = shiftOneYearBack(ctx.from);
  const priorTo = shiftOneYearBack(ctx.to);
  const hasComparative = !!bookBeginning && priorTo >= bookBeginning;

  const { data: currentRowsRaw } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    .rpc("get_trade_analysis" as any, {
      p_company_id: companyId,
      p_from: ctx.from,
      p_to: ctx.to,
      p_side: "sale",
      p_group_by: rpcGroupBy,
      p_branch_id: ctx.branchId ?? undefined,
    });
  const allRows = (currentRowsRaw ?? []) as AnalysisRow[];
  const grandTotal = allRows.reduce(
    (acc, r) => ({ net: acc.net + Number(r.net), tax: acc.tax + Number(r.tax), docs: acc.docs + Number(r.document_count) }),
    { net: 0, tax: 0, docs: 0 }
  );

  // ---------------------------------------------------------------------
  // Drill panel: real documents behind one row, fetched only when a row's
  // chevron was actually clicked. Unchanged from the pre-migration page —
  // see this file's header for why it reproduces RPC1's netting by hand
  // instead of calling back into it.
  // ---------------------------------------------------------------------
  let documents: DocumentRow[] = [];
  let drillLabel = "";
  if (drillKey) {
    const matchedRow = allRows.find((r) => r.group_key === drillKey);
    drillLabel = matchedRow?.group_label ?? "";

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
    <>
      <ReportView definition={salesAnalysisReport} companyId={companyId} searchParams={sp} />

      {/* Summary strip + documents panel: both outside <ReportView>'s own
          <ReportShell> frame (see this file's header, point 3) — matching
          padding by hand so the two blocks read as one page rather than a
          card followed by unstyled content. */}
      <div className="mx-auto w-full px-6 pb-10">
        <p className="px-1 py-2 text-xs text-ink-faint print:hidden">
          {groupBy === "customer" ? "Customers" : "Items"}: {allRows.length} · total net{" "}
          {formatINR(grandTotal.net, { showZero: true })} across {grandTotal.docs} documents
          {hasComparative
            ? ` · vs ${periodRangeLabel(priorFrom, priorTo)}`
            : " · no prior-year comparison (books did not go back that far)"}
        </p>

        {drillKey && (
          <TableContainer className="mt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
              <h2 className="text-sm font-semibold text-ink">
                Documents — {drillLabel || (drillKey === "none" ? "Cash / No Party" : drillKey)}
              </h2>
              <Link
                href={drillHref(basePath, { by: groupBy, drill: null }, sp)}
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
          </TableContainer>
        )}
      </div>
    </>
  );
}
