/**
 * The shared report context: which company, which financial year, which
 * branch, which dates.
 *
 * Before this module those four lived in four different places — the company
 * in the URL path, the period in each report's own `?from=&to=` handling
 * (copy-pasted into ~18 pages), the branch inside individual forms, and the
 * financial year nowhere at all, only implied by whatever `from` happened to
 * be. Nothing carried them from one screen to the next, so drilling from the
 * Balance Sheet into the Daybook silently reset the period to "FY to date".
 *
 * This file is the single definition of all four. Rules it holds to:
 *
 *   - Pure functions only. No React, no "use client", no data fetching, so it
 *     imports cleanly into BOTH server and client components. That is
 *     deliberate and load-bearing: a "use client" module's exports become
 *     client *references* when a server component imports them, which this
 *     codebase has been bitten by before — a function turns into an opaque
 *     proxy and calling it fails at render time, not at typecheck.
 *
 *   - No date arithmetic of its own beyond assembling a financial year's two
 *     boundaries. Everything that has to know what "today" means goes through
 *     lib/utils/period.ts, whose header documents two real bugs this file
 *     must not reintroduce: a period that ended yesterday between midnight
 *     and 05:30 IST, and a period that ran BACKWARDS on 1 April. Both came
 *     from reading `new Date()` through UTC fields. So: `defaultPeriod` for
 *     anything involving today, `financialYearStart`/`financialYearLabel` for
 *     the year, and never a bare `new Date()` read through getUTC*.
 *
 * The invariant every AppContext satisfies:
 *
 *     fyStart <= from <= to      and      fyStart <= fyEnd
 *
 * and `fyLabel`/`fyStart`/`fyEnd` always describe the financial year that
 * `from` falls in. `to` may run past `fyEnd` — a user is allowed to ask for a
 * range that straddles two years — but the labelled year is the one the
 * period *starts* in, which is the same choice comparativePeriod() already
 * makes when it decides what a "previous year" column means.
 */

import {
  defaultPeriod,
  financialYearLabel,
  financialYearStart,
} from "@/lib/utils/period";

/**
 * The query-string keys, named once so no other file ever hard-codes them
 * again. `fy`, `branch`, `from` and `to` are the names already in the wild —
 * see the Profit & Loss / Balance Sheet pages (`sp.branch`, `sp.from`,
 * `sp.to`) and the GSTR-9 / Form 16 / TDS-credit pages (`sp.fy`) — so
 * adopting anything else would break every link and bookmark that exists.
 */
export const FY_PARAM = "fy";
export const BRANCH_PARAM = "branch";
export const FROM_PARAM = "from";
export const TO_PARAM = "to";

/**
 * Everything a screen needs to know about "where the user is" apart from the
 * route itself. All dates are plain YYYY-MM-DD, the form every RPC in this
 * app takes and the form Postgres casts to `date` without a timezone in
 * sight.
 */
export type AppContext = {
  /** From the route path, not the query string — the company is the route. */
  companyId: string;
  /** e.g. "2026-27", exactly as financialYearLabel() renders it. */
  fyLabel: string;
  /** First day of that financial year, per the company's own start month. */
  fyStart: string;
  /** Last day of it — the day before the next year begins. */
  fyEnd: string;
  /** null means "all branches", which is what every report defaults to. */
  branchId: string | null;
  /** Period start. Always inside [fyStart, fyEnd]. */
  from: string;
  /** Period end. >= from, and may run past fyEnd on a custom range. */
  to: string;
};

/**
 * Both shapes a caller can hand us:
 *
 *   - a server component's awaited `searchParams` — a plain object whose
 *     values are string | string[] | undefined;
 *   - a client component's `useSearchParams()` result (ReadonlyURLSearchParams
 *     extends URLSearchParams), or a URLSearchParams we built ourselves.
 *
 * Accepting both is the whole point of being framework-free: the same context
 * must be readable on either side of the server/client line.
 */
export type ContextSearchParams =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

/** April, the statutory default for an Indian company under Sec 2(41). */
const DEFAULT_FY_START_MONTH = 4;

/**
 * `financial_year_start_month` is nullable in the schema, and every call site
 * today writes `company?.financial_year_start_month ?? 4`. A TypeScript
 * default parameter only fires on `undefined`, so a genuine SQL NULL would
 * slip through it and poison every Date.UTC below into NaN. Normalising here
 * means callers can pass the column straight in and stop repeating the `?? 4`.
 */
function normaliseStartMonth(month: number | null | undefined): number {
  if (typeof month !== "number" || !Number.isInteger(month)) return DEFAULT_FY_START_MONTH;
  return month >= 1 && month <= 12 ? month : DEFAULT_FY_START_MONTH;
}

/**
 * A date string as an instant at noon UTC. Same trick period.ts uses: noon is
 * far enough from both midnights that no interpretation of the value can slip
 * it a day, which is what made the 1-April bug possible in the first place.
 * Anything we feed to financialYearStart() gets anchored this way.
 */
function atNoonUTC(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

/** Format a UTC-constructed Date back to YYYY-MM-DD by reading the very
 * fields it was built from. Not toISOString(): that is safe here, but the
 * habit is what produced this codebase's date bugs, so the explicit read
 * leaves nothing to re-check later. */
function isoUTC(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * A well-formed YYYY-MM-DD that is also a real calendar date — 2026-02-31
 * matches the shape but does not exist, and would raise on the `date` cast in
 * Postgres and take a whole report page down. Same guard, same reasoning, as
 * isIsoDate() in the capture review queue page.
 */
function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * One query-string value, from either accepted shape.
 *
 * Duck-typed rather than `instanceof URLSearchParams`: ReadonlyURLSearchParams
 * is a subclass, and an instanceof check across realms (server bundle vs
 * client bundle) is exactly the kind of thing that works until it doesn't.
 *
 * A repeated key (`?branch=a&branch=b`) takes the first value, matching the
 * `one()` helper the capture page already uses. An empty value is treated as
 * absent: today `?from=` forwards "" straight into the RPC and errors, so
 * dropping it can only turn a broken URL into a working one — it cannot
 * change a screen that works.
 */
function readParam(sp: ContextSearchParams, key: string): string | undefined {
  const maybeUsp = sp as URLSearchParams;
  const raw =
    typeof maybeUsp.get === "function"
      ? maybeUsp.get(key)
      : (sp as Record<string, string | string[] | undefined>)[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Today as a local wall-clock date, borrowed from defaultPeriod rather than
 * recomputed. defaultPeriod's `to` with no override IS todayLocal(), and it
 * is the only place in the app allowed to decide what "today" means. */
function todayFor(startMonth: number): string {
  return defaultPeriod(startMonth).to;
}

/** The financial year a given date falls in, as a label. */
function fyLabelOf(startMonth: number, date: string): string {
  return financialYearLabel(startMonth, atNoonUTC(date));
}

/**
 * The two boundaries of the financial year a label names.
 *
 * The start is asked of financialYearStart() rather than constructed, using
 * an anchor deliberately placed mid-month inside the year's first month —
 * that guarantees this function and financialYearLabel() can never disagree
 * about which calendar year a label refers to, because both go through the
 * same function. The end is "day 0 of the month the next year starts in",
 * JS Date's own idiom for the last day of the preceding month; a
 * milliseconds-minus-one-day subtraction would be a DST/leap trap of exactly
 * the kind period.ts warns about.
 *
 * Note the label convention comes from financialYearLabel() and is not
 * re-litigated here: the year in the label is the CALENDAR year the FY starts
 * in, so a January-start company's "2026-27" runs 1 Jan 2026 to 31 Dec 2026.
 * Odd-looking, but consistent with every existing `?fy=` link in the app.
 */
function fyBounds(startMonth: number, startYear: number): { start: string; end: string } {
  const start = financialYearStart(startMonth, new Date(Date.UTC(startYear, startMonth - 1, 15)));
  const nextStart = financialYearStart(
    startMonth,
    new Date(Date.UTC(startYear + 1, startMonth - 1, 15))
  );
  const end = new Date(Date.UTC(nextStart.getUTCFullYear(), nextStart.getUTCMonth(), 0));
  return { start: isoUTC(start), end: isoUTC(end) };
}

/**
 * A `?fy=` value back into its start year, or undefined if it is not a label
 * this app would ever have produced. Validated by round-tripping through
 * financialYearLabel() instead of by a second regex, so a hand-edited
 * "2026-99" is rejected without this file owning a copy of the label format.
 */
function parseFyLabel(startMonth: number, label: string | undefined): number | undefined {
  if (!label || !/^\d{4}-\d{2}$/.test(label)) return undefined;
  const year = Number(label.slice(0, 4));
  return fyLabelOf(startMonth, fyBounds(startMonth, year).start) === label ? year : undefined;
}

/**
 * The period a financial year implies when the user has not given explicit
 * dates. The CURRENT year means year-to-date — that is what every report
 * shows today and changing it would move numbers on eighteen screens. A year
 * that is over (or has not started) means the whole of it, since "to date"
 * has no meaning for a period that is not running.
 */
function windowForFy(
  startMonth: number,
  fyStartYear: number,
  currentFyStartYear: number
): { from?: string; to?: string } {
  if (fyStartYear === currentFyStartYear) return {}; // let defaultPeriod do year-to-date
  const { start, end } = fyBounds(startMonth, fyStartYear);
  return { from: start, to: end };
}

/**
 * Read the shared context out of a route's company id and query string.
 *
 * Behaviour with no `?fy=` is byte-for-byte what the report pages do today:
 *
 *     defaultPeriod(startMonth, { from: sp.from, to: sp.to })
 *     branchId = sp.branch
 *
 * so adopting this module on an existing screen cannot move a single figure.
 * `?fy=` is new, and is a shorthand for "set the period to that whole year";
 * an explicit `from` still wins over it, because a specific date beats a
 * shorthand for a range (the same precedence withContext() uses).
 */
export function readContext(
  companyId: string,
  searchParams: ContextSearchParams,
  fyStartMonth?: number | null
): AppContext {
  const startMonth = normaliseStartMonth(fyStartMonth);

  const today = todayFor(startMonth);
  const currentFyStartYear = Number(fyLabelOf(startMonth, today).slice(0, 4));

  // An unparseable ?fy= falls back to the current year rather than erroring:
  // a stale bookmark should show this year's books, not a stack trace.
  const requestedFyStartYear =
    parseFyLabel(startMonth, readParam(searchParams, FY_PARAM)) ?? currentFyStartYear;
  const fyDefaults = windowForFy(startMonth, requestedFyStartYear, currentFyStartYear);

  const rawFrom = readParam(searchParams, FROM_PARAM);
  const rawTo = readParam(searchParams, TO_PARAM);

  // defaultPeriod owns the "today", the financial-year start and the
  // never-runs-backwards clamp. All this adds is which fallback to hand it.
  const period = defaultPeriod(startMonth, {
    from: rawFrom && isIsoDate(rawFrom) ? rawFrom : fyDefaults.from,
    to: rawTo && isIsoDate(rawTo) ? rawTo : fyDefaults.to,
  });

  // The labelled year is always the one the period STARTS in, so the context
  // can never describe a year the dates are not in — including when an
  // explicit ?from= overrode the ?fy= shorthand and landed elsewhere.
  const fyLabel = fyLabelOf(startMonth, period.from);
  const { start: fyStart, end: fyEnd } = fyBounds(startMonth, Number(fyLabel.slice(0, 4)));

  return {
    companyId,
    fyLabel,
    fyStart,
    fyEnd,
    branchId: readParam(searchParams, BRANCH_PARAM) ?? null,
    from: period.from,
    to: period.to,
  };
}

/**
 * The context as a query string carrying ONLY what differs from the defaults,
 * so a link to "this company, this year, all branches, year to date" stays a
 * bare path with no query at all. Three reasons that matters beyond looking
 * tidy: a pinned `?to=2026-09-02` silently freezes a report that should keep
 * running to today, duplicate URLs for one view fragment Next's route cache,
 * and a user who copies a link expects to share the view, not a timestamp.
 *
 * Guaranteed to round-trip: readContext(ctx.companyId, contextParams(ctx),
 * startMonth) equals ctx, on the same day.
 */
export function contextParams(ctx: AppContext): URLSearchParams {
  const params = new URLSearchParams();

  // The start month is recoverable from fyStart — it is by definition the
  // first day of the financial year — so AppContext does not have to carry
  // it around as a field that every consumer would then have to thread.
  const startMonth = normaliseStartMonth(Number(ctx.fyStart.slice(5, 7)));

  const today = todayFor(startMonth);
  const currentFyStartYear = Number(fyLabelOf(startMonth, today).slice(0, 4));
  const bare = defaultPeriod(startMonth);

  const isBareDefault = ctx.from === bare.from && ctx.to === bare.to;

  if (!isBareDefault) {
    // A whole financial year compresses to `?fy=2025-26`, which is both
    // shorter and self-describing next to a pair of raw dates.
    const fyStartYear = Number(ctx.fyLabel.slice(0, 4));
    const implied = windowForFy(startMonth, fyStartYear, currentFyStartYear);
    const isWholeFy = implied.from === ctx.from && implied.to === ctx.to;

    if (isWholeFy) {
      params.set(FY_PARAM, ctx.fyLabel);
    } else {
      // Otherwise emit each date only if it differs from what readContext
      // would have defaulted it to — `to === today` is the default whatever
      // `from` is, so pinning it would defeat the point of the exercise.
      if (ctx.from !== bare.from) params.set(FROM_PARAM, ctx.from);
      if (ctx.to !== bare.to) params.set(TO_PARAM, ctx.to);
    }
  }

  // null is "all branches", the default, so it is simply absent.
  if (ctx.branchId) params.set(BRANCH_PARAM, ctx.branchId);

  return params;
}

/**
 * A link that keeps the user where they are. Give it a route and the current
 * context and the period/branch/year survive the click, which is the whole
 * reason this module exists.
 *
 *     withContext(`/${ctx.companyId}/reports/daybook`, ctx)
 *     withContext(`/${ctx.companyId}/reports/profit-loss`, ctx, { view: "detail" })
 *     withContext(href, ctx, { branch: null })   // drop one key
 *
 * Precedence, narrowest wins: `extra` beats anything already in `href`, and
 * `href` beats the ambient context. A key the caller typed into the href by
 * hand — a "compare the other branch" link, say — is a deliberate override
 * and must not be quietly replaced by where the user happens to be standing.
 *
 * A null, undefined or empty `extra` value REMOVES the key rather than
 * writing a blank one, since readContext treats an empty value as absent
 * anyway and `?branch=` in a URL is just noise.
 *
 * Any existing hash is preserved, and a route with no parameters at all comes
 * back without a trailing "?".
 */
export function withContext(
  href: string,
  ctx: AppContext,
  extra?: Record<string, string | number | null | undefined>
): string {
  // Split the hash off first: it is last in a URL, so a "?" inside it belongs
  // to the fragment and must not be read as the start of the query string.
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const beforeHash = hashAt >= 0 ? href.slice(0, hashAt) : href;

  const queryAt = beforeHash.indexOf("?");
  const path = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const params = new URLSearchParams(queryAt >= 0 ? beforeHash.slice(queryAt + 1) : "");

  contextParams(ctx).forEach((value, key) => {
    if (!params.has(key)) params.set(key, value);
  });

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === null || value === undefined || value === "") params.delete(key);
      else params.set(key, String(value));
    }
  }

  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}${hash}`;
}
