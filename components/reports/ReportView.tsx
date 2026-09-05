import type { ReactNode } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod, periodRangeLabel } from "@/lib/utils/period";
import { readContext, type ContextSearchParams } from "@/lib/nav/context";
import { ReportShell, th, td, num } from "@/components/reports/ReportShell";
import { DrillHeadCell, DrillRow } from "@/components/reports/DrillLink";
import { ReportViewControls } from "@/components/reports/ReportViewControls";
import { cn } from "@/lib/utils/cn";
import type {
  ReportDefinition,
  ReportColumn,
  ReportColumnFormat,
  ReportComparative,
} from "@/lib/reports/defineReport";

/**
 * The renderer half of this wave's report-object contract — see
 * lib/reports/defineReport.ts for the declarative shape this turns into a
 * real page, and that file's own header for why `defineReport` exists at
 * all. Built by reading trial-balance and sales-analysis in full: every
 * default, class name and three-way comparative rule below is what those two
 * pages already do by hand, so a report migrated onto this contract with the
 * "obvious" definition renders byte-identical output to what it showed
 * before migrating.
 *
 * Stays an async Server Component — its data fetching is awaited Supabase
 * calls exactly like every report page today — and composes with
 * ReportShell (chrome: header, period, export, action rail, width) rather
 * than replacing it. The one interactive piece (view cycling, the
 * comparative toggle, saving a named view) lives in the separate
 * <ReportViewControls> client island — see that file's own header for why it
 * cannot be part of this module.
 *
 * ---------------------------------------------------------------------------
 * One documented addition beyond the literal four-field ReportComparative
 * shape: `value`.
 * ---------------------------------------------------------------------------
 * "Current value + comparative Map lookup" (the rule this file's rendering
 * follows) needs to know WHICH field of a row is the figure being compared —
 * sales-analysis compares `net`, a P&L-style report would compare a ledger's
 * `amount`. `label`/`available`/`fetch`/`matchKey` alone have no way to say
 * that, so `value: (row: Row) => number` was added to `ReportComparative` in
 * defineReport.ts as the minimal completion needed to make this section of
 * the contract renderable at all; see this wave's own `contract` output.
 */

// ---------------------------------------------------------------------------
// Screen-config resolution.
//
// "Resolve only the keys definition.config?.keys lists (default all-ON)":
// a key the report never opted into is never read back from screen_config at
// all — it behaves exactly as if that axis did not exist for this report,
// which is what makes adopting this contract on a new report incapable of
// hiding/rounding/gating anything until that report explicitly asks for it.
// ---------------------------------------------------------------------------

type ReportConfigKey = "showZeroBalance" | "showExactFigures" | "showOpeningClosing" | "showComparative";

type ResolvedReportConfig = Record<ReportConfigKey, boolean>;

function resolveConfig(raw: Record<string, unknown>, declaredKeys: ReportConfigKey[] | undefined): ResolvedReportConfig {
  const declared = new Set(declaredKeys ?? []);
  const pick = (key: ReportConfigKey): boolean =>
    declared.has(key) ? ((raw[key] as boolean | undefined) ?? true) : true;
  return {
    showZeroBalance: pick("showZeroBalance"),
    showExactFigures: pick("showExactFigures"),
    showOpeningClosing: pick("showOpeningClosing"),
    showComparative: pick("showComparative"),
  };
}

// ---------------------------------------------------------------------------
// Query-string helpers. ContextSearchParams accepts a Server Component's
// awaited searchParams OR a client's URLSearchParams (see lib/nav/context.ts's
// own header) — both duck-typed the same way that file's readParam() does,
// so this module never needs an instanceof check across a realm boundary.
// ---------------------------------------------------------------------------

function readOneParam(sp: ContextSearchParams, key: string): string | undefined {
  const maybeUsp = sp as URLSearchParams;
  if (typeof maybeUsp.get === "function") {
    const value = maybeUsp.get(key);
    return value !== null && value.trim() !== "" ? value : undefined;
  }
  const raw = (sp as Record<string, string | string[] | undefined>)[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Every key ContextSearchParams carries, as a plain URLSearchParams — used
 * to build the view-switch tabs' hrefs (one key overridden, everything else
 * preserved), the same "ambient state survives, one key changes" shape
 * sales-analysis's own hrefFor() already implements by hand. */
function toURLSearchParams(sp: ContextSearchParams): URLSearchParams {
  const maybeUsp = sp as URLSearchParams;
  if (typeof maybeUsp.get === "function") return new URLSearchParams(maybeUsp);
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(sp as Record<string, string | string[] | undefined>)) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value.trim() !== "") params.set(key, value);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Cell formatting — see ReportColumnFormat's own doc comment in
// defineReport.ts for what each format means and which existing report page
// it was copied from.
// ---------------------------------------------------------------------------

function defaultAlign(format: ReportColumnFormat | undefined): "left" | "right" {
  return format === undefined || format === "text" || format === "date" ? "left" : "right";
}

function formatCurrencyCell(raw: unknown, exact: boolean): string {
  const n = Number(raw) || 0;
  if (n === 0) return "—"; // same zero-dash convention formatINR itself uses
  return exact
    ? formatINR(n)
    : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n));
}

function formatQtyCell(raw: unknown): string {
  // No zero-dash here, unlike currency: a quantity of 0 is real data (a fully
  // returned line), not "nothing to show" — the same distinction
  // sales-analysis's own Qty column already draws by never dashing it.
  return new Intl.NumberFormat("en-IN").format(Number(raw) || 0);
}

/** "+12.3%" / "-4.0%" / "—" for a non-finite value — the exact
 * variancePct/formatVariance convention profit-loss, purchase-analysis and
 * margin-by-item each already implement by hand. */
function formatPercentCell(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function formatTextCell(raw: unknown): string {
  return raw === null || raw === undefined ? "" : String(raw);
}

function renderCell<Row>(row: Row, column: ReportColumn<Row>, exact: boolean): ReactNode {
  if (column.render) return column.render(row);
  const raw = (row as Record<string, unknown>)[column.key];
  switch (column.format) {
    case "currency":
      return formatCurrencyCell(raw, exact);
    case "qty":
      return formatQtyCell(raw);
    case "percent":
      return formatPercentCell(raw);
    case "date":
    case "text":
    default:
      return formatTextCell(raw);
  }
}

/** showOpeningClosing's own per-column semantics (recon's own header calls
 * this "genuinely per-column logic, not something defineReport can pre-
 * encode generically beyond exposing which keys are declared"): with no
 * column-level flag in the contract to mark "this is an opening/closing
 * column", the only generic hook available is the RPC's own naming
 * convention — every opening/closing column in this app today is literally
 * named opening_debit/opening_credit/closing_debit/closing_credit (trial-
 * balance is the confirmed example). A report whose RPC does not follow that
 * naming simply never has a column this toggle touches, which is the safe
 * failure direction (nothing hidden that shouldn't be, at worst a column
 * that should hide does not). */
function isOpeningClosingColumn<Row>(column: ReportColumn<Row>): boolean {
  const key = column.key.toLowerCase();
  return key.includes("opening") || key.includes("closing");
}

/** showZeroBalance's own per-row semantics, generalised the same way: a row
 * is "zero balance" when every one of its plain (non-`render`) currency
 * columns is zero. A report with no currency column at all has no zero-ness
 * concept to apply this to, so nothing is ever hidden for it — again the
 * safe failure direction. */
function isZeroRow<Row>(row: Row, columns: ReportColumn<Row>[]): boolean {
  const currencyColumns = columns.filter((c) => c.format === "currency" && !c.render);
  if (currencyColumns.length === 0) return false;
  return currencyColumns.every((c) => (Number((row as Record<string, unknown>)[c.key]) || 0) === 0);
}

/** The trailing print:hidden spacer a non-drillable row pays for when
 * `definition.drill` is declared but this particular row resolved no target
 * — profit-loss's own DrillSpacer pattern, kept aligned under DrillHeadCell. */
function DrillSpacer() {
  return <td className={cn(td, "w-px px-2 print:hidden")} />;
}

/** Current value + comparative Map lookup, rendered as value / "New" / em-
 * dash — sales-analysis's own existing three-way rule, kept here as
 * ReportView's fixed rendering policy rather than something a report
 * customizes further (every comparative column in this app already agrees
 * on this exact shape). */
function renderComparativeCell<Row>(
  row: Row,
  comparative: ReportComparative<Row>,
  comparativeByKey: Map<string, Row>,
  exact: boolean
): ReactNode {
  const current = comparative.value(row);
  const priorRow = comparativeByKey.get(comparative.matchKey(row));
  const prior = priorRow ? comparative.value(priorRow) : undefined;

  if (prior === undefined || prior === 0) {
    return current !== 0 ? (
      <span className="text-success">New</span>
    ) : (
      <span className="text-ink-faint">—</span>
    );
  }

  const pct = ((current - prior) / Math.abs(prior)) * 100;
  return (
    <span className="whitespace-nowrap">
      {formatCurrencyCell(prior, exact)}{" "}
      <span className={cn("text-xs", current >= prior ? "text-success" : "text-error")}>
        ({current >= prior ? "+" : ""}
        {pct.toFixed(1)}%)
      </span>
    </span>
  );
}

export async function ReportView<Row>({
  definition,
  companyId,
  searchParams,
}: {
  definition: ReportDefinition<Row>;
  companyId: string;
  /** The already-awaited searchParams every report page's own async
   * component already has — this is not a Promise. */
  searchParams: ContextSearchParams;
}): Promise<ReactNode> {
  const sp = searchParams;
  const supabase = await createClient();

  // ---- Step 1: period, byte-identical to what every existing report page
  // already resolves by hand (readContext's own stated contract). ----
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

  const companyInfo = {
    bookBeginningDate: (company?.book_beginning_date as string | null | undefined) ?? null,
  };

  // ---- Step 2: server-side screen_config read. Not useScreenConfig — that
  // hook is client/write-side only (see its own header) — so this calls
  // get_screen_config (1560) directly, the same RPC ReportShell's gear
  // writes through, under the same screen_key (definition.key MUST equal
  // ReportShell's own reportConfigScope() output for this route). ----
  const { data: rawConfig } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_screen_config (1560) predates the generated types, same escape hatch as lib/config/useScreenConfig.ts.
    .rpc("get_screen_config" as any, { p_company_id: companyId, p_screen_key: definition.key });
  const resolvedConfig = resolveConfig((rawConfig as Record<string, unknown> | null) ?? {}, definition.config?.keys);

  // ---- Step 3: active view. ----
  const viewParamName = definition.views?.paramName ?? "view";
  const requestedViewKey = readOneParam(sp, viewParamName);
  const activeViewKey =
    (requestedViewKey && definition.views?.options.some((v) => v.key === requestedViewKey)
      ? requestedViewKey
      : undefined) ?? definition.views?.default;
  const activeView = definition.views?.options.find((v) => v.key === activeViewKey);
  const baseColumns = activeView?.columns ?? definition.columns;

  // ---- Step 4 + 5: current rows and (maybe) comparative rows, fetched
  // together — every existing page with a comparative column already fetches
  // current+comparative via one Promise.all, so this does the same. ----
  const rpcParams = {
    ...definition.source.params(ctx),
    ...(activeView?.params?.(ctx) ?? {}),
  };

  const comparativeAvailable = !!definition.comparative && definition.comparative.available(ctx, companyInfo);
  const wantsComparative = comparativeAvailable && resolvedConfig.showComparative;

  const [{ data: rowsRaw, error }, comparativeRows] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- definition.source.rpc is only known at each report definition's own call site, never a literal this generic renderer can type against.
    supabase.rpc(definition.source.rpc as any, rpcParams),
    wantsComparative ? definition.comparative!.fetch(ctx, companyInfo) : Promise.resolve<Row[]>([]),
  ]);

  const rows = (rowsRaw ?? []) as Row[];
  const comparativeByKey = wantsComparative
    ? new Map<string, Row>(comparativeRows.map((r): [string, Row] => [definition.comparative!.matchKey(r), r]))
    : null;

  // ---- Rendering: honour showOpeningClosing (columns) and showZeroBalance
  // (rows) — see isOpeningClosingColumn/isZeroRow for exactly what each
  // means generically. ----
  const visibleColumns = resolvedConfig.showOpeningClosing
    ? baseColumns
    : baseColumns.filter((c) => !isOpeningClosingColumn(c));
  const visibleRows = resolvedConfig.showZeroBalance ? rows : rows.filter((r) => !isZeroRow(r, visibleColumns));

  const hasDrill = !!definition.drill;
  const columnCount = visibleColumns.length + (comparativeByKey ? 1 : 0) + (hasDrill ? 1 : 0);

  return (
    <ReportShell title={definition.title} period={periodLabel} width={definition.width}>
      {error && (
        <p className="m-4 rounded-lg bg-error-soft px-3 py-2 text-sm text-error">{error.message}</p>
      )}

      {/* ---- Step 7: view-switch tabs — plain <Link>s, ambient query string
          preserved, exactly like sales-analysis's own existing ones. ---- */}
      {definition.views && definition.views.options.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border p-3 print:hidden">
          <div className="flex items-center gap-1 rounded-lg bg-surface-2 p-1 text-sm">
            {definition.views.options.map((v) => {
              const params = toURLSearchParams(sp);
              if (v.key === definition.views!.default) params.delete(viewParamName);
              else params.set(viewParamName, v.key);
              const query = params.toString();
              return (
                <Link
                  key={v.key}
                  href={query ? `?${query}` : "?"}
                  className={cn(
                    "rounded-md px-3 py-1 font-medium transition-colors",
                    v.key === activeViewKey ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink"
                  )}
                >
                  {v.label}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr>
            {visibleColumns.map((c) => (
              <th key={c.key} className={cn(th, (c.align ?? defaultAlign(c.format)) === "right" && "text-right")}>
                {c.label}
              </th>
            ))}
            {comparativeByKey && (
              <th className={cn(th, "text-right")}>{definition.comparative!.label(ctx)}</th>
            )}
            {hasDrill && <DrillHeadCell />}
          </tr>
        </thead>
        <tbody>
          {visibleRows.length === 0 && (
            <tr>
              <td colSpan={Math.max(columnCount, 1)} className="px-4 py-12 text-center text-ink-faint">
                Nothing to show for this period.
              </td>
            </tr>
          )}
          {visibleRows.map((row, index) => {
            const cells = visibleColumns.map((c) => (
              <td key={c.key} className={(c.align ?? defaultAlign(c.format)) === "right" ? num : td}>
                {renderCell(row, c, resolvedConfig.showExactFigures)}
              </td>
            ));

            const comparativeCell = comparativeByKey ? (
              <td key="__comparative" className={num}>
                {renderComparativeCell(row, definition.comparative!, comparativeByKey, resolvedConfig.showExactFigures)}
              </td>
            ) : null;

            if (!hasDrill) {
              return (
                <tr key={index}>
                  {cells}
                  {comparativeCell}
                </tr>
              );
            }

            const target = definition.drill!(row, { companyId, app: ctx, carry: sp });
            if (!target) {
              return (
                <tr key={index}>
                  {cells}
                  {comparativeCell}
                  <DrillSpacer />
                </tr>
              );
            }

            return (
              <DrillRow key={index} href={target.href} params={target.params} carry={sp} label={target.label}>
                {cells}
                {comparativeCell}
              </DrillRow>
            );
          })}
        </tbody>
      </table>

      {definition.comparative && !comparativeAvailable && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          No comparative column: {definition.comparative.label(ctx)} is not available for this period.
        </p>
      )}

      {/* ---- Step 9: quiet "see also" footer — not the action rail. ---- */}
      {definition.related && definition.related.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 border-t border-border px-4 py-3 print:hidden">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">See also</span>
          {definition.related.map((r) => (
            <Link key={r.label} href={r.href(ctx)} className="text-xs text-accent underline underline-offset-4">
              {r.label}
            </Link>
          ))}
        </div>
      )}

      {/* ---- Step 8: the one client island — see its own file header for
          why this cannot live inside this async Server Component. ---- */}
      <ReportViewControls
        companyId={companyId}
        screenKey={definition.key}
        views={
          definition.views && definition.views.options.length > 1
            ? {
                paramName: viewParamName,
                keys: definition.views.options.map((v) => v.key),
                defaultKey: definition.views.default,
                activeKey: activeViewKey ?? definition.views.default,
              }
            : null
        }
        comparativeEnabled={!!definition.comparative && !!definition.config?.keys?.includes("showComparative")}
      />
    </ReportShell>
  );
}
