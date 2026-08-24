/**
 * TDS/TCS return quarter arithmetic — Apr-Jun/Jul-Sep/Oct-Dec/Jan-Mar,
 * always the calendar year regardless of a company's own book year, the
 * same convention /reports/tds-summary already established and duplicated
 * here rather than imported from it (tds-summary's own copy is private to
 * that file, and this task does not touch it). Shared by the three
 * tds-return-* pages so the quarter math is written once, not three times.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type QuarterBounds = {
  from: string;
  to: string;
  label: string;
  qkey: string;
  qNum: 1 | 2 | 3 | 4;
  fyStart: number;
};

/**
 * `q` is "YYYY-Q1".."YYYY-Q4" where YYYY is the FY-starting calendar year
 * (e.g. Jan-Mar 2027 is "2026-Q4", the fourth quarter of FY 2026-27) —
 * defaults to the quarter containing today.
 */
export function quarterBounds(q?: string): QuarterBounds {
  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  let fyStart = tm >= 4 ? ty : ty - 1;
  let qNum = tm >= 4 ? Math.floor((tm - 4) / 3) + 1 : 4;

  if (q && /^\d{4}-Q[1-4]$/.test(q)) {
    fyStart = Number(q.slice(0, 4));
    qNum = Number(q.slice(6, 7));
  }

  const startMonth = 4 + (qNum - 1) * 3; // 4, 7, 10, 13
  const startYear = fyStart + Math.floor((startMonth - 1) / 12);
  const startMonthNorm = ((startMonth - 1) % 12) + 1;
  const from = `${startYear}-${pad(startMonthNorm)}-01`;
  const endMonthNorm0 = startMonthNorm + 2;
  const endYear = startYear + Math.floor((endMonthNorm0 - 1) / 12);
  const endMonthNorm = ((endMonthNorm0 - 1) % 12) + 1;
  const lastDay = new Date(Date.UTC(endYear, endMonthNorm, 0)).getUTCDate();
  const to = `${endYear}-${pad(endMonthNorm)}-${pad(lastDay)}`;
  const label = `Q${qNum} FY ${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")} (${from} to ${to})`;
  return { from, to, label, qkey: `${fyStart}-Q${qNum}`, qNum: qNum as 1 | 2 | 3 | 4, fyStart };
}

export function shiftQuarter(qkey: string, delta: number): string {
  const fyStart = Number(qkey.slice(0, 4));
  const qNum = Number(qkey.slice(6, 7));
  const total = fyStart * 4 + (qNum - 1) + delta;
  const newFyStart = Math.floor(total / 4);
  const newQNum = (total % 4) + 1;
  return `${newFyStart}-Q${newQNum}`;
}

/** The financial-year label ("2026-27") a quarter belongs to — matches
 * employee_tax_declarations.financial_year_label's own "^\d{4}-\d{2}$"
 * grain (0093). */
export function financialYearLabel(fyStart: number): string {
  return `${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`;
}

/** First-of-month dates for the 3 calendar months a quarter spans, as
 * "YYYY-MM-01" strings — what get_salary_tds_estimate/get_payroll_run (0049,
 * 0075) take as p_period_month, one call per month since neither accepts a
 * range. */
export function monthsInQuarter(fyStart: number, qNum: 1 | 2 | 3 | 4): string[] {
  const startMonth0 = 3 + (qNum - 1) * 3; // 0-based: Apr=3
  return [0, 1, 2].map((i) => {
    const d = new Date(Date.UTC(fyStart, startMonth0 + i, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
  });
}

/** First-of-month dates for all 12 months of the financial year starting
 * April of `fyStart` — used by Annexure II (Q4 only), which is annual, not
 * quarterly. */
export function monthsInFinancialYear(fyStart: number): string[] {
  return [...Array(12)].map((_, i) => {
    const d = new Date(Date.UTC(fyStart, 3 + i, 1)); // Apr(3) .. Mar(next year, i=11 -> month 14 -> Mar)
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
  });
}

/**
 * The challan-deposit window for a quarter: TDS deducted in a quarter's
 * last month is not due at the bank until the 7th of the following month
 * (30th for a March deduction — see get_compliance_calendar, 0024) — so a
 * challan search scoped strictly to [from, to] would miss exactly the
 * challans a filer most needs to see. Extended by a flat 30 days past
 * quarter-end for every quarter alike (simpler, and always at least as
 * generous as the statutory 7-day/30-day due dates it is standing in for),
 * stated in the page copy rather than left implicit.
 */
export function challanWindow(to: string): string {
  const d = new Date(`${to}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
