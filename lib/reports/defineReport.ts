/**
 * The report-object contract: a declarative shape that <ReportView> (see
 * components/reports/ReportView.tsx) turns into a real report page. Built
 * against Recon's own verbatim spec for this wave — see AGENTS.md's task
 * brief for the full contract this file and ReportView.tsx implement.
 *
 * Two existing reports were read in full before this file was written
 * (trial-balance, sales-analysis) — every default and naming choice below
 * mirrors what those pages already do by hand, so a report migrated onto
 * this contract with the "obvious" definition renders byte-identical output.
 *
 * `defineReport` itself is the identity function drizzle's own defineConfig
 * uses for the same reason: `Row` has nowhere else to be inferred from in an
 * object literal, so a bare object literal assigned to `ReportDefinition<Row>`
 * would need every call site to spell out `<Row>` by hand. Wrapping the
 * literal in a call lets TypeScript infer `Row` from the object shape itself.
 */

import type { ReactNode } from "react";
import type { AppContext } from "@/lib/nav/context";
import type { DrillParams, CarrySource } from "@/components/reports/DrillLink";
import type { ReportWidth } from "@/components/reports/ReportShell";

/**
 * How a column's raw RPC value becomes what the reader sees.
 *
 *   - "currency"  formatINR-style (see ReportView's own formatter): en-IN
 *                 grouping, forced 2 decimals when showExactFigures is on,
 *                 whole rupees when it is off, "—" for a zero value.
 *   - "qty"       en-IN grouped number, no forced decimals, no zero-dash
 *                 (a quantity of 0 is real data, unlike a zero ledger balance).
 *   - "date"      rendered as-is — every RPC in this app already returns
 *                 dates as plain ISO (YYYY-MM-DD) text, so there is nothing
 *                 to reparse or reformat.
 *   - "percent"   variancePct/formatVariance's own convention (profit-loss,
 *                 purchase-analysis, margin-by-item all already do this by
 *                 hand): a leading "+" on a positive value, one decimal, "—"
 *                 for a non-finite value. The column's own RPC value IS the
 *                 percentage already — this format only ever formats a number
 *                 that is already a percent, it never computes one.
 *   - "text"      String(value), or "" for null/undefined. The default.
 */
export type ReportColumnFormat = "currency" | "qty" | "date" | "text" | "percent";

export type ReportColumn<Row> = {
  /** Must be a real key on Row as the source RPC returns it (e.g. "ledger_name",
   *  "closing_debit") — never a derived/computed field name; derive those in
   *  a `render` override instead so the column list stays a faithful map of
   *  what the RPC actually returns (mirrors how every report page today reads
   *  r.field_name directly off the RPC row with no intermediate reshaping). */
  key: Extract<keyof Row, string>;
  label: string;
  /** Default: "text"/"date" -> left, everything else -> right. */
  align?: "left" | "right";
  /** Default "text". */
  format?: ReportColumnFormat;
  /** Whether the gear's "hidden columns" affordance (new, alongside the three
   *  existing toggles) may hide this column. Columns carrying totals-critical
   *  data (a report's own tallied/balanced check) should be hideable:false. */
  hideable?: boolean;
  /** Escape hatch for the handful of columns that are not a straight
   *  format-the-field job (trial-balance's Group column showing text-ink-soft,
   *  sales-analysis's "vs last year" cell showing "New"/em-dash/percent).
   *  Receives the row and returns a ReactNode; when present it wins over
   *  `format` entirely for that column. */
  render?: (row: Row) => ReactNode;
};

export type ReportView<Row> = {
  /** The value this view's link/tab sets on the view param (see
   *  ReportDefinition.views.paramName). sales-analysis's two views are
   *  key: "customer" and key: "item". */
  key: string;
  label: string;
  /** Extra/overriding RPC params this view adds on top of source.params —
   *  sales-analysis's rpcGroupBy mapping ("customer"->"party", "item"->"item")
   *  lives here, not hard-coded in ReportView. */
  params?: (ctx: AppContext) => Record<string, unknown>;
  /** Columns this view shows INSTEAD of the definition's base `columns` —
   *  sales-analysis's Qty column only exists in the "item" view. Omit to
   *  reuse the base columns unchanged. */
  columns?: ReportColumn<Row>[];
};

export type ReportDrillTarget = { href: string; params?: DrillParams; label: string } | null;

/** A function from one row (plus the ambient nav context so the drill can
 *  resolve ITS OWN period explicitly per DrillLink's own header rule — see
 *  balance-sheet/profit-loss both pinning `from`/`to` rather than trusting
 *  `carry` alone) to a DrillRow target. Return null for a row that resolved
 *  no real id to drill into (trial-balance's own "row didn't match" fallback
 *  pattern) — ReportView renders that row as a plain <tr> with a blank
 *  trailing cell instead of a DrillRow, exactly like profit-loss's DrillSpacer. */
export type ReportDrill<Row> = (
  row: Row,
  ctx: { companyId: string; app: AppContext; carry: CarrySource }
) => ReportDrillTarget;

export type ReportComparative<Row> = {
  /** Header label for the extra column, e.g. "vs last year" / the comparative
   *  period's own label. */
  label: (ctx: AppContext) => string;
  /** Whether a comparative is even meaningable for this ctx — the
   *  book_beginning_date gate every existing comparative column already
   *  applies (hasComparative in profit-loss/balance-sheet/sales-analysis).
   *  Must be checked BEFORE calling fetch — fetch is not expected to no-op
   *  gracefully on its own. */
  available: (ctx: AppContext, company: { bookBeginningDate: string | null }) => boolean;
  /** The ENTIRE date-shift + RPC-call policy is per-report, deliberately not
   *  generalized — sales-analysis shifts exactly one calendar year back,
   *  profit-loss uses comparativePeriod()'s mode-dependent rule. Do not
   *  factor out a shared "shift by N" helper; that would silently change one
   *  report's comparative dates to match another's rule. */
  fetch: (ctx: AppContext, company: { bookBeginningDate: string | null }) => Promise<Row[]>;
  /** Joins a comparative row back to a current-period row. sales-analysis
   *  joins on group_key; profit-loss joins on ledger_name (lowercased is NOT
   *  needed here — the RPC's own ledger_name is already the join key it uses). */
  matchKey: (row: Row) => string;
  /** The single figure being compared — sales-analysis compares `net`, a
   *  P&L-style report would compare a ledger's `amount`. Not part of Recon's
   *  original four-field list above (label/available/fetch/matchKey): ADDED
   *  here as the minimal completion needed to make "current value +
   *  comparative Map lookup" (ReportView's own rendering rule) actually
   *  renderable — without it nothing says WHICH field of Row is the number
   *  being diffed. See ReportView.tsx's own header for the full note. */
  value: (row: Row) => number;
};

export type ReportDefinition<Row> = {
  /** MUST equal ReportShell's own reportConfigScope() output for this route
   *  (path segments after companyId, "-"-joined). This is the screen_config
   *  screen_key AND the saved_report_views screen_key. */
  key: string;
  title: string;
  /** Passed straight through to ReportShell; default "data". */
  width?: ReportWidth;
  source: {
    /** Exact RPC name — confirm it is real (pg_proc) before use. */
    rpc: string;
    /** Base params from the resolved AppContext alone — a view's own params
     *  (below) are shallow-merged OVER this, view wins on key collision. */
    params: (ctx: AppContext) => Record<string, unknown>;
  };
  columns: ReportColumn<Row>[];
  views?: {
    /** Query param name this report's views switch on. Defaults to "view".
     *  Override to "by" for a report migrating off an existing ?by= URL
     *  convention (sales-analysis) so old bookmarks/links keep working. */
    paramName?: string;
    options: ReportView<Row>[];
    /** options[].key of the view shown with no param present at all. */
    default: string;
  };
  drill?: ReportDrill<Row>;
  comparative?: ReportComparative<Row>;
  /** Which of the screen_config keys this report actually reads and applies
   *  when rendering (not just persists) — omitted keys are always treated
   *  as "on" (i.e. that axis never hides/rounds/gates anything for this
   *  report), exactly the "byte-identical until a report opts in" contract
   *  ReportShell's own three toggles already promise. "showComparative" is
   *  new, alongside the three ReportShell already defines; a report that
   *  declares it here gets Alt+C wired automatically. */
  config?: { keys: Array<"showZeroBalance" | "showExactFigures" | "showOpeningClosing" | "showComparative"> };
  /** Optional "see also" links rendered as a quiet footer row (not the action
   *  rail — those are Print/CSV/report-specific buttons, not related-report
   *  navigation). e.g. Profit & Loss -> Income Tax report. */
  related?: Array<{ label: string; href: (ctx: AppContext) => string }>;
};

/**
 * Identity function purely for inference — `Row` is otherwise unpositioned in
 * the object literal, same trick as e.g. drizzle's defineConfig.
 */
export function defineReport<Row>(def: ReportDefinition<Row>): ReportDefinition<Row> {
  return def;
}
