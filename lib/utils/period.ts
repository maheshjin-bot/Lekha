/**
 * Report periods, keyed to the company's financial year rather than the
 * calendar. A company on a July year must not be shown "1 April to today" as
 * its default — that is the single most common date bug in Indian accounting
 * software, and it hides because April is also the most common FY start.
 */

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First day of the financial year containing `on`. */
export function financialYearStart(startMonth: number, on = new Date()): Date {
  const year = on.getMonth() + 1 >= startMonth ? on.getFullYear() : on.getFullYear() - 1;
  return new Date(Date.UTC(year, startMonth - 1, 1));
}

export function financialYearLabel(startMonth: number, on = new Date()): string {
  const start = financialYearStart(startMonth, on);
  const y = start.getUTCFullYear();
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/**
 * Resolves an explicit from/to if given, otherwise the financial year to date.
 */
export function defaultPeriod(
  startMonth: number,
  override?: { from?: string; to?: string }
): { from: string; to: string; label: string } {
  const today = new Date();
  const from = override?.from ?? iso(financialYearStart(startMonth, today));
  const to = override?.to ?? iso(today);

  const fromDate = new Date(from + "T00:00:00Z");
  const toDate = new Date(to + "T00:00:00Z");

  const fmt = (d: Date) =>
    `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

  return {
    from,
    to,
    label: override?.from
      ? `${fmt(fromDate)} to ${fmt(toDate)}`
      : `FY ${financialYearLabel(startMonth, today)} to date · ${fmt(fromDate)} to ${fmt(toDate)}`,
  };
}
