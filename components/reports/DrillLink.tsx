import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { td, th } from "@/components/ui/Table";

/**
 * Row-level drill-down for report tables.
 *
 * Every report in this app is currently a dead end: rows are plain <td>, so a
 * figure that looks wrong cannot be opened to find out why. This module is the
 * one place that fixes that, so the fourteenth report gets it free — the same
 * reasoning ReportShell already applies to print/CSV/JPG export.
 *
 * ---------------------------------------------------------------------------
 * Decision 1: this file is NOT a "use client" module, and that is load-bearing.
 * ---------------------------------------------------------------------------
 * It exports `drillHref`, a plain function, and every report page in this app is
 * an async Server Component (see app/(app)/[companyId]/reports/trial-balance).
 * A function exported from a "use client" module does not arrive in a Server
 * Component as a function — it arrives as a client-reference *proxy*. That
 * typechecks, it lints, and it throws only when the page is actually requested.
 * This repo has already shipped that exact bug once (lib/invoices/trading-roles.ts
 * exists as a separate plain module for no other reason), so the rule here is:
 * whatever else changes, do not put "use client" at the top of this file.
 *
 * The practical consequence is that DrillRow may not use a React event handler,
 * so there is no onClick and no role="link"/tabIndex/onKeyDown <tr>. All of the
 * behaviour is bought from a real <a> plus CSS instead, which is strictly better
 * anyway: Tab reaches it, Enter opens it, ctrl/cmd-click opens a new tab, and
 * right-click can copy the address — every one of which a synthetic keyboard-
 * handler row would have had to reimplement, badly.
 *
 * ---------------------------------------------------------------------------
 * Decision 2: the drill target is the trailing chevron cell, not the whole row.
 * ---------------------------------------------------------------------------
 * The obvious alternative — a transparent anchor overlay stretched across the
 * <tr> (the "stretched link" trick) — was considered and rejected on three
 * counts, any one of which is disqualifying for an accounting statement:
 *
 *   1. It swallows text selection. Copying a figure out of a statement is the
 *      single most common thing anyone does with these tables; an overlay makes
 *      drag-select return nothing.
 *   2. It swallows every other control in the row. The Daybook already puts up
 *      to five links plus a delete button in one row, and several report pages
 *      are being wired to this component in parallel.
 *   3. It needs `position: relative` on a <tr>, which CSS leaves under-specified
 *      for table parts. When an engine ignores it the overlay does not shrink —
 *      it escapes to the nearest positioned ancestor and covers the page. That
 *      is a failure mode invisible in code review.
 *
 * So the row itself is the *affordance* (full-width hover wash, accent wash
 * while the drill link holds focus, chevron fading in) and the chevron cell's
 * anchor is the *target*. A caller that wants a wider click target should wrap
 * its own first-cell label in a <Link href={drillHref(...)}> — that is exactly
 * why drillHref is exported separately: both routes produce the identical URL.
 */

/**
 * The only query-string keys carried from a report into whatever it drills into.
 *
 * An allowlist, not a blind merge, because most params are meaningful only to
 * the report that set them: a `mode`, `fy`, `month`, `q` or `page` carried into
 * a different report is at best ignored and at worst re-interpreted. These three
 * are the ones that say *which slice of the books is on screen*, and losing them
 * mid-drill is the whole bug this prop exists to prevent — a user narrows to one
 * quarter, clicks a figure, and silently lands on the full year.
 *
 * Read the header of lib/utils/period.ts before touching this list; it documents
 * two real production date bugs and explains why period handling here is fussy.
 */
export const CARRIED_PARAM_KEYS = ["from", "to", "branch"] as const;

/**
 * Destination-specific params. Numbers are allowed because ids and indices
 * routinely arrive as numbers from an RPC; null/undefined/"" mean "not set" and
 * are dropped rather than serialised as the strings "null"/"undefined".
 */
export type DrillParams = Record<string, string | number | null | undefined>;

/**
 * Whatever the calling page already has: the awaited `searchParams` of a Server
 * Component (Record<string, string | string[] | undefined>, per .next/types) or
 * a client component's `useSearchParams()` result.
 */
export type CarrySource =
  | Record<string, string | string[] | undefined>
  | URLSearchParams
  | null
  | undefined;

/**
 * Reads one key out of either carry shape, or null when it should not be carried.
 *
 * Two deliberate rejections, both of which prevent a silently-wrong period:
 *
 *   - A repeated key (?from=a&from=b) is dropped entirely. Every report page in
 *     this app reads its params as `typeof sp.from === "string" ? sp.from :
 *     undefined`, so the *source* report ignored a repeated value too. Carrying
 *     one of the two forward would show the destination a period the user was
 *     never actually looking at.
 *   - An empty value (?from=) is dropped. It is the nastier of the two: it
 *     survives that `typeof === "string"` check, and then survives defaultPeriod's
 *     `override?.from ?? …`, because `??` falls back only on null/undefined. The
 *     empty string reaches the RPC as p_from and Postgres rejects the date. This
 *     is the cheapest place in the stack to stop it.
 */
function carriedValue(carry: NonNullable<CarrySource>, key: string): string | null {
  // Duck-typed on `.getAll` rather than `carry instanceof URLSearchParams` —
  // lib/nav/context.ts's readParam() makes the identical choice, for the
  // identical reason: ReadonlyURLSearchParams (what a client component's
  // useSearchParams() hands back) is a subclass, and an instanceof check
  // across a server-bundle/client-bundle realm split is exactly the kind of
  // thing that works until it doesn't.
  const maybeUsp = carry as URLSearchParams;
  if (typeof maybeUsp.getAll === "function") {
    const all = maybeUsp.getAll(key);
    if (all.length !== 1) return null;
    return all[0].trim() === "" ? null : all[0];
  }
  const raw = (carry as Record<string, string | string[] | undefined>)[key];
  if (typeof raw !== "string") return null; // covers both undefined and string[]
  return raw.trim() === "" ? null : raw;
}

/**
 * Builds a drill URL: `base`, plus the carried period/branch context, plus the
 * caller's own params — which win, so a page can always override what it carries.
 *
 * Exported on its own so a page that cannot use <DrillRow> (a nested table, a
 * summary tile, a cell that needs its own link) still produces exactly the same
 * URL a drill row would.
 *
 * IMPORTANT for callers whose period is not in `from`/`to`. Some reports express
 * their period as `?mode=month&month=2026-07` or `?fy=2026` instead. Carrying
 * does nothing for those, and the destination quietly falls back to its own
 * financial-year-to-date default — a *different* period than the one on screen,
 * showing different numbers, with nothing on the page to say so. Those pages
 * must resolve their period and pass it explicitly:
 *
 *     drillHref(base, { ledger: id, from: period.from, to: period.to }, sp)
 *
 * `params` is applied after `carry`, so that composes correctly.
 */
export function drillHref(base: string, params?: DrillParams, carry?: CarrySource): string {
  // Seed from any query string already on `base` rather than truncating it — a
  // caller passing "/x/reports/foo?tab=b" should keep its tab.
  const [path, existingQuery] = base.split("?");
  const search = new URLSearchParams(existingQuery ?? "");

  if (carry) {
    for (const key of CARRIED_PARAM_KEYS) {
      const value = carriedValue(carry, key);
      if (value !== null) search.set(key, value);
    }
  }

  for (const [key, value] of Object.entries(params ?? {})) {
    // Explicit params win over carried context, including the right to clear it:
    // passing { branch: null } drops a carried branch, which is what a report
    // that deliberately drills company-wide needs.
    if (value === null || value === undefined) {
      search.delete(key);
      continue;
    }
    // Number guard: an id computed from a bad row can be NaN, and String(NaN)
    // would put the literal text "NaN" into a URL the destination then queries on.
    if (typeof value === "number" && !Number.isFinite(value)) {
      search.delete(key);
      continue;
    }
    const asText = typeof value === "number" ? String(value) : value;
    if (asText.trim() === "") {
      search.delete(key);
      continue;
    }
    search.set(key, asText);
  }

  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * The header cell for the chevron column. Every <DrillRow> appends one trailing
 * cell, so the <thead> needs one too, or the column count is off by one and the
 * hairline borders stop lining up.
 *
 * Both this and the row's own chevron cell are print:hidden, so the column
 * disappears cleanly from a printed statement — a drill affordance means nothing
 * on paper, and a statement should leave as a document. A colSpan'd empty-state
 * or total row should count the chevron column on screen (colSpan={n + 1}); in
 * print the browser clamps the excess, so the one value works for both.
 */
export function DrillHeadCell() {
  return (
    <th className={cn(th, "w-px px-2 print:hidden")}>
      {/* Named for screen readers rather than left blank: an unlabelled column
          header reads as nothing at all when navigating the table by column. */}
      <span className="sr-only">Open</span>
    </th>
  );
}

/**
 * A report row that can be opened.
 *
 * Usable from a Server Component (no hooks, no client directive) and equally
 * from a client table such as DaybookTable — it is a plain function component
 * either way.
 *
 *     <DrillRow
 *       href={`/${companyId}/reports/ledger-statement`}
 *       params={{ ledger: r.ledger_id }}
 *       carry={sp}
 *       label={r.ledger_name}
 *     >
 *       <td className={td}>{r.ledger_name}</td>
 *       <td className={num}>{formatINR(Number(r.closing_debit))}</td>
 *     </DrillRow>
 */
export function DrillRow({
  href,
  params,
  carry,
  label,
  children,
  className,
  prefetch = false,
}: {
  /** Destination path — e.g. `/${companyId}/reports/ledger-statement`. Any query
   * string already on it is kept and merged with, not discarded. */
  href: string;
  /** Destination-specific params. Applied after `carry`, so these win. */
  params?: DrillParams;
  /** The current query string, so the drill keeps the period/branch on screen. */
  carry?: CarrySource;
  /**
   * What this row is, in the user's words — "Cash in Hand", "INV/2026-27/0012".
   * Required, not optional: a trial balance renders 200 of these links, and 200
   * anchors all named "Open" are a screen-reader dead end. It becomes the link's
   * accessible name and its hover tooltip.
   */
  label: string;
  /** The row's own <td> cells. The chevron cell is appended after them. */
  children: ReactNode;
  className?: string;
  /**
   * Off by default. Next prefetches every in-viewport <Link> in production, and
   * a report is hundreds of rows pointing at hundreds of RSC payloads — that
   * would turn scrolling a trial balance into a self-inflicted load test. Opt in
   * only for short, high-intent lists.
   */
  prefetch?: boolean;
}) {
  const target = drillHref(href, params, carry);

  return (
    <tr
      className={cn(
        // The wash spans the whole row so hover reads as "this row does
        // something", even though the click target is the chevron. focus-within
        // reuses the accent wash the design system already uses for a selected
        // row (trSelected in components/ui/Table), so a keyboard user and a
        // mouse user are looking at the same visual language.
        "group transition-colors hover:bg-surface-2 focus-within:bg-accent-soft",
        className
      )}
    >
      {children}
      <td className={cn(td, "w-px whitespace-nowrap px-2 text-right print:hidden")}>
        <Link
          href={target}
          prefetch={prefetch}
          aria-label={`Open ${label}`}
          title={`Open ${label}`}
          className={cn(
            "inline-flex items-center justify-center rounded-md p-1 text-ink-faint outline-none transition-opacity",
            "hover:text-ink",
            // House focus ring — the same tokens every input in the app uses.
            "focus-visible:ring-2 focus-visible:ring-accent/30",
            // Quiet until wanted: the row's own hover wash is what advertises
            // that the row is drillable, and a chevron on all 200 rows of a
            // trial balance is visual noise down the right edge.
            "opacity-0 focus:opacity-100 group-hover:opacity-100",
            // …except where hover does not exist. On a touch device the chevron
            // would otherwise never appear and the whole feature would be
            // invisible on the mobile shell.
            "pointer-coarse:opacity-100"
          )}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </td>
    </tr>
  );
}
