/**
 * Report periods, keyed to the company's financial year rather than the
 * calendar. A company on a July year must not be shown "1 April to today" —
 * that is the most common date bug in Indian accounting software, and it hides
 * because April is also the most common FY start.
 *
 * The split of responsibilities here is deliberate, and getting it wrong
 * produced two real bugs on a UTC+05:30 clock:
 *
 *   financialYearStart  is pure UTC calendar arithmetic on a date it is given.
 *                       It mirrors app_private.fy_start_date in Postgres, which
 *                       also works on dates rather than instants.
 *
 *   defaultPeriod       decides what "today" means, and that is a LOCAL
 *                       wall-clock date. A voucher entered at 1am on 17 August
 *                       in Mumbai is dated the 17th, not the 16th.
 *
 * Reading "today" through toISOString() made the period end yesterday between
 * midnight and 05:30 IST, and — worse — made it run backwards on 1 April,
 * when the year start was already April but "today" was still 31 March in UTC.
 * A backwards period returns no rows and reads as missing data, not a bug.
 */

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const pad = (n: number) => String(n).padStart(2, "0");

/** The local wall-clock date, as YYYY-MM-DD. Never toISOString(). */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A date string as an instant at noon UTC — far from any boundary, so it
 * cannot slip a day under either interpretation.
 */
function atNoonUTC(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function isoUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First day of the financial year containing `on`, as a UTC-midnight date. */
export function financialYearStart(startMonth: number, on = new Date()): Date {
  const year =
    on.getUTCMonth() + 1 >= startMonth ? on.getUTCFullYear() : on.getUTCFullYear() - 1;
  return new Date(Date.UTC(year, startMonth - 1, 1));
}

export function financialYearLabel(startMonth: number, on = new Date()): string {
  const y = financialYearStart(startMonth, on).getUTCFullYear();
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

function formatDate(date: string): string {
  const d = atNoonUTC(date);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Resolves an explicit from/to if given, otherwise the financial year to date.
 * The result is guaranteed never to run backwards.
 */
export function defaultPeriod(
  startMonth: number,
  override?: { from?: string; to?: string }
): { from: string; to: string; label: string } {
  // "Today" is a local calendar date, then re-anchored at noon UTC so the
  // financial-year arithmetic below is boundary-safe.
  const today = todayLocal();
  const reference = atNoonUTC(today);

  const from = override?.from ?? isoUTC(financialYearStart(startMonth, reference));
  let to = override?.to ?? today;

  // Clamp rather than trust: a period that starts after it ends returns
  // nothing and looks like missing data rather than a fault.
  if (to < from) to = from;

  const isDefaultRange = !override?.from && !override?.to;

  return {
    from,
    to,
    label: isDefaultRange
      ? `FY ${financialYearLabel(startMonth, reference)} to date · ${formatDate(from)} to ${formatDate(to)}`
      : `${formatDate(from)} to ${formatDate(to)}`,
  };
}

export type PeriodPresetKey =
  | "currentFY"
  | "thisQuarter"
  | "previousQuarter"
  | "currentMonth"
  | "previousMonth";

export const PERIOD_PRESETS: { key: PeriodPresetKey; label: string }[] = [
  { key: "currentFY", label: "Current financial year" },
  { key: "thisQuarter", label: "This quarter" },
  { key: "previousQuarter", label: "Previous quarter" },
  { key: "currentMonth", label: "Current month" },
  { key: "previousMonth", label: "Previous month" },
];

/**
 * Quarter boundaries are relative to the company's own financial year, not
 * the calendar — a July-year company's Q1 is July-September, not January-
 * March, the same reasoning defaultPeriod already applies to the year itself.
 * "This quarter"/"current month" run to today, matching defaultPeriod's own
 * to-date convention; "previous quarter"/"previous month" are the full,
 * already-closed period, since there is no "to date" for something over.
 */
export function periodPreset(
  key: PeriodPresetKey,
  startMonth: number
): { from: string; to: string } {
  const today = todayLocal();
  const reference = atNoonUTC(today);
  const fyStart = financialYearStart(startMonth, reference);
  const fyStartYear = fyStart.getUTCFullYear();

  if (key === "currentFY") {
    return { from: isoUTC(fyStart), to: today };
  }

  if (key === "currentMonth" || key === "previousMonth") {
    const monthOffset = key === "previousMonth" ? -1 : 0;
    const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + monthOffset, 1));
    if (key === "currentMonth") return { from: isoUTC(start), to: today };
    // Day 0 of the *next* month is JS Date's idiom for "last day of this month".
    const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 0));
    return { from: isoUTC(start), to: isoUTC(end) };
  }

  // Months elapsed since the FY started, 0-11, then which 3-month block that
  // falls in (0-3) — quarter start/end fall out of simple month arithmetic
  // from there, and Date.UTC normalises a month index outside 0-11 into the
  // correct adjacent year on its own.
  const monthsSinceFyStart = (reference.getUTCMonth() + 1 - startMonth + 12) % 12;
  const quarterIndex = Math.floor(monthsSinceFyStart / 3);
  const quarterMonthOffset = quarterIndex * 3 + (key === "previousQuarter" ? -3 : 0);
  const qStartMonth0 = startMonth - 1 + quarterMonthOffset; // 0-based month index from Jan of fyStartYear

  const qStart = new Date(Date.UTC(fyStartYear, qStartMonth0, 1));
  if (key === "thisQuarter") return { from: isoUTC(qStart), to: today };
  const qEnd = new Date(Date.UTC(fyStartYear, qStartMonth0 + 3, 0));
  return { from: isoUTC(qStart), to: isoUTC(qEnd) };
}

/**
 * The comparative (previous-period) range for a report's current {from, to}
 * — used by the Profit & Loss comparative column (and, potentially, the
 * Balance Sheet's own comparative column, which is a separate page not
 * touched here). Schedule III General Instruction 1 requires a previous-
 * year figure on any filed set of accounts; this is the date arithmetic
 * half of that, independent of which report calls it.
 *
 * Two rules, chosen by what shape the CURRENT period has:
 *
 *   - Full financial year (from == that year's FY start, per the company's
 *     financial_year_start_month): the comparative is the PRIOR financial
 *     year, same relative length — the same month/day shifted back exactly
 *     one year, whether the current period runs to the FY's own close (a
 *     finished year) or only to today (FY-to-date). That is what "previous
 *     year" means on a Schedule III statement: the prior REPORTING year,
 *     not a same-day-count window, which for a July-year company would
 *     land mid-quarter instead of on the year boundary.
 *
 *   - Any other from/to (a custom range the user picked): the comparative
 *     is the immediately preceding period of the SAME LENGTH in days,
 *     ending the day before `from`. There is no "prior custom period"
 *     concept to be more clever about than that — same length, immediately
 *     before, is the simplest rule that is always well-defined.
 *
 * A year-shift is done on UTC calendar fields (getUTCFullYear/Month/Date),
 * never a millisecond subtraction — subtracting 365*86400000ms would drift
 * by a day across every leap year in between, the same class of bug this
 * file's header already warns about for toISOString(). The one genuine
 * edge case left is 29 February landing on a non-leap year: Date.UTC's own
 * overflow rule turns Date.UTC(year, 1, 29) into 1 March when that year has
 * no 29 February, so a Schedule III "to" of 29 Feb 2028 gets a comparative
 * "to" of 1 March 2027, not 28 Feb 2027 — confirmed by running this
 * function directly (node, ad hoc script) rather than assumed. Left as-is:
 * it is JS's own well-defined rollover, and neither 28 Feb nor 1 Mar is
 * more "correct" for a date that did not exist the year before.
 */
export function comparativePeriod(
  from: string,
  to: string,
  startMonth: number
): { from: string; to: string } {
  const fromInstant = atNoonUTC(from);
  const fyStartOfFrom = isoUTC(financialYearStart(startMonth, fromInstant));

  if (fyStartOfFrom === from) {
    const shiftBackOneYear = (date: string): string => {
      const d = atNoonUTC(date);
      return isoUTC(new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate())));
    };
    return { from: shiftBackOneYear(from), to: shiftBackOneYear(to) };
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const fromMs = atNoonUTC(from).getTime();
  const toMs = atNoonUTC(to).getTime();
  const lengthDays = Math.round((toMs - fromMs) / DAY_MS) + 1; // inclusive of both ends
  return {
    from: isoUTC(new Date(fromMs - lengthDays * DAY_MS)),
    to: isoUTC(new Date(fromMs - DAY_MS)),
  };
}

/** `${formatDate(from)} to ${formatDate(to)}`, exposed for callers (report
 * pages) that need to print an arbitrary from/to pair — such as the
 * comparative period's own label — without going through defaultPeriod's
 * override/"today" resolution, which does not apply to an already-computed
 * range. */
export function periodRangeLabel(from: string, to: string): string {
  return `${formatDate(from)} to ${formatDate(to)}`;
}

/**
 * The last day of the financial year before the one containing today — the
 * natural default to suggest when closing books, since it is the most
 * recent period that has fully finished. Same local-date-then-noon-UTC
 * anchoring as defaultPeriod, for the same reason: a naive `new Date()` read
 * through UTC fields is the bug this file exists to avoid.
 */
export function previousFinancialYearEnd(startMonth: number): string {
  const reference = atNoonUTC(todayLocal());
  const currentFyStart = financialYearStart(startMonth, reference);
  const prevDay = new Date(currentFyStart.getTime() - 24 * 60 * 60 * 1000);
  return isoUTC(prevDay);
}
