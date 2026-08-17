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
