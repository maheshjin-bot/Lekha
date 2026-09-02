/**
 * Reading an effective-dated salary structure the way payroll does.
 *
 * public.employee_salary_structures has always been effective-dated, with a
 * unique (employee_id, effective_from) that exists for exactly one purpose —
 * revisions — but until 1380 nothing could write a second row, so every
 * consumer could get away with "the only row there is". Now that increments
 * are real, and can legitimately be dated into the future (an increment letter
 * signed in September, effective 1 November), "current pay" and "latest row"
 * are no longer the same thing, and the Employees screen has to say which it
 * means.
 */

export type SalaryStructure = {
  employee_id: string;
  effective_from: string;
  basic: number;
  dearness_allowance: number;
  hra: number;
  special_allowance: number;
  other_allowance: number;
  pf_applicable: boolean;
  pf_wage_ceiling_applies: boolean;
  esi_applicable: boolean;
  professional_tax_monthly: number;
};

/** basic + DA + HRA + special + other — the same sum get_payroll_run grosses. */
export function structureGross(s: SalaryStructure): number {
  return (
    Number(s.basic) +
    Number(s.dearness_allowance) +
    Number(s.hra) +
    Number(s.special_allowance) +
    Number(s.other_allowance)
  );
}

/**
 * Today's date as the Indian calendar sees it, `YYYY-MM-DD`.
 *
 * Deliberately not `new Date().toISOString().slice(0, 10)`. Nothing in this
 * repo pins the server's TZ, and for the first 5h30m of every IST day a UTC
 * slice is still yesterday — the exact class of date bug vitest.config.ts sets
 * TZ=Asia/Kolkata to keep reachable in the suite. `en-CA` in an explicit zone
 * formats as ISO, so the result sorts correctly against a date column.
 */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** `2026-09-01` -> `Sep 2026`. Read off the string; never builds a Date. */
export function monthLabel(iso: string): string {
  const m = Number(iso.slice(5, 7));
  return `${MONTH_NAMES[m - 1] ?? iso.slice(5, 7)} ${iso.slice(0, 4)}`;
}

/**
 * First of the month after `iso`, as `YYYY-MM-01` — the earliest month a
 * revision can be dated from once an earlier one is posted.
 *
 * Done in string arithmetic on purpose. `new Date(iso)` parses as UTC midnight
 * and `setMonth` then reads local getters, so in IST the December rollover
 * comes back as the wrong year; see todayInIndia for the same hazard.
 */
export function nextMonthStart(iso: string): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const rolls = month === 12;
  return `${rolls ? year + 1 : year}-${String(rolls ? 1 : month + 1).padStart(2, "0")}-01`;
}

/**
 * The structure actually in force on `onDate` — the latest row effective on or
 * before it. Returns null when the employee has nothing yet effective (a hire
 * whose structure starts next month, say).
 *
 * ISO date strings compare correctly with `<=`, so no Date objects are built
 * here at all; see todayInIndia for why that matters.
 */
export function structureInForceOn(
  structures: SalaryStructure[],
  onDate: string
): SalaryStructure | null {
  let best: SalaryStructure | null = null;
  for (const s of structures) {
    if (s.effective_from > onDate) continue;
    if (best === null || s.effective_from > best.effective_from) best = s;
  }
  return best;
}

/**
 * The next revision that has not started yet, if one has been recorded ahead of
 * time. This is what stops the list showing a November increment as though it
 * were being paid in September.
 */
export function nextScheduledStructure(
  structures: SalaryStructure[],
  onDate: string
): SalaryStructure | null {
  let next: SalaryStructure | null = null;
  for (const s of structures) {
    if (s.effective_from <= onDate) continue;
    if (next === null || s.effective_from < next.effective_from) next = s;
  }
  return next;
}

/**
 * Mirrors record_salary_revision's own effective-date rule (1380), so the form
 * can refuse before the round trip and explain the same thing the function
 * would. Same discipline as EmployeeManager's PAN_PATTERN mirroring
 * app_private.is_valid_pan.
 *
 * The rule: the first of a month, because every period-scoped payroll function
 * picks ONE structure for a whole month and cannot blend two rates inside it.
 * The single exception is the employee's own date_of_joining, which is where
 * the structure entered at hire sits and which is legitimately mid-month —
 * re-entering that date is how a typo in the original amounts gets corrected.
 *
 * Returns null when the date is acceptable, otherwise the message to show.
 */
export function revisionDateProblem(
  effectiveFrom: string,
  dateOfJoining: string,
  dateOfLeaving: string | null
): string | null {
  if (!effectiveFrom) return "Pick the month this salary takes effect from.";

  const isMonthStart = effectiveFrom.slice(8, 10) === "01";
  if (!isMonthStart && effectiveFrom !== dateOfJoining) {
    return "Payroll pays one salary rate for a whole month, so a revision has to start on the first of one.";
  }
  if (effectiveFrom < dateOfJoining) {
    return `This employee joined on ${dateOfJoining} — a salary cannot take effect before that.`;
  }
  if (dateOfLeaving && effectiveFrom > dateOfLeaving) {
    return `This employee left on ${dateOfLeaving} — a salary effective after that would never be paid.`;
  }
  return null;
}

/**
 * The latest month this company has already posted payroll for, at or after
 * `effectiveFrom` — the months record_salary_revision refuses to re-rate
 * because they have been paid, remitted and filed. Checked here only so the
 * form can say so up front; the function is the rule.
 *
 * `postedMonths` are the first-of-month dates from public.payroll_postings.
 * Compared against the MONTH effectiveFrom falls in, matching the function:
 * a date_of_joining correction dated the 15th must not be allowed to re-rate a
 * posting dated the 1st of that same month.
 */
export function blockingPostedMonth(
  postedMonths: string[],
  effectiveFrom: string
): string | null {
  const effectiveMonth = effectiveFrom.slice(0, 8) + "01";
  let latest: string | null = null;
  for (const m of postedMonths) {
    if (m < effectiveMonth) continue;
    if (latest === null || m > latest) latest = m;
  }
  return latest;
}
