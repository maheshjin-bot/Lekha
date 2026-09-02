/**
 * The Employees screen's reading of an effective-dated salary.
 *
 * WHY THIS FILE EXISTS. Until 1380 employee_salary_structures only ever held
 * one row per employee, so "the newest row" and "what this person is paid
 * today" were the same thing and the page could not tell them apart. Recording
 * a real revision — including one dated ahead of the month it starts, which is
 * how an increment letter actually arrives — makes them different, and getting
 * it wrong shows a November increment as though it were being paid in
 * September.
 *
 * The assertions here are about the TypeScript the screen runs. They are NOT a
 * re-implementation of get_payroll_run's own month rule: that lives in SQL and
 * was verified against live data (a July run still on the old salary after an
 * August revision exists), because a TS copy of a SQL rule checked against
 * itself proves only that the copy was made.
 */
import { describe, expect, it } from "vitest";
import {
  blockingPostedMonth,
  monthLabel,
  nextMonthStart,
  nextScheduledStructure,
  revisionDateProblem,
  structureGross,
  structureInForceOn,
  todayInIndia,
  type SalaryStructure,
} from "@/lib/employees/salaryStructures";

function structure(effective_from: string, basic: number): SalaryStructure {
  return {
    employee_id: "e1",
    effective_from,
    basic,
    dearness_allowance: 0,
    hra: 0,
    special_allowance: 0,
    other_allowance: 0,
    pf_applicable: true,
    pf_wage_ceiling_applies: true,
    esi_applicable: true,
    professional_tax_monthly: 200,
  };
}

describe("structureInForceOn", () => {
  const hire = structure("2020-01-01", 10000);
  const raise = structure("2026-09-01", 14000);
  const future = structure("2026-11-01", 18000);

  it("is the joining structure before any revision starts", () => {
    expect(structureInForceOn([hire, raise], "2026-08-31")?.basic).toBe(10000);
  });

  it("switches on the first day of the revision's month, not before", () => {
    expect(structureInForceOn([hire, raise], "2026-09-01")?.basic).toBe(14000);
  });

  /**
   * The bug this function exists to prevent: a revision recorded in advance
   * must not be shown as current pay. "Newest row" would answer 18000 here.
   */
  it("ignores a revision dated into the future", () => {
    expect(structureInForceOn([hire, raise, future], "2026-09-15")?.basic).toBe(14000);
  });

  it("is insensitive to the order rows arrive in", () => {
    const shuffled = [future, hire, raise];
    expect(structureInForceOn(shuffled, "2026-09-15")?.basic).toBe(14000);
  });

  it("is null when nothing is effective yet", () => {
    expect(structureInForceOn([structure("2026-10-01", 9000)], "2026-09-30")).toBeNull();
  });

  it("is null for an employee with no structure at all", () => {
    expect(structureInForceOn([], "2026-09-15")).toBeNull();
  });
});

describe("nextScheduledStructure", () => {
  it("is the earliest revision that has not started", () => {
    const rows = [
      structure("2020-01-01", 10000),
      structure("2026-11-01", 18000),
      structure("2026-10-01", 16000),
    ];
    expect(nextScheduledStructure(rows, "2026-09-15")?.effective_from).toBe("2026-10-01");
  });

  it("is null once every row has started", () => {
    expect(
      nextScheduledStructure([structure("2020-01-01", 10000)], "2026-09-15")
    ).toBeNull();
  });

  it("does not count a revision starting today as still upcoming", () => {
    expect(
      nextScheduledStructure([structure("2026-09-15", 10000)], "2026-09-15")
    ).toBeNull();
  });
});

describe("revisionDateProblem", () => {
  it("accepts the first of a month", () => {
    expect(revisionDateProblem("2026-09-01", "2020-01-01", null)).toBeNull();
  });

  /**
   * Mirrors record_salary_revision (1380). Payroll picks one structure for a
   * whole month, so a mid-month date would silently mean "from next month" and
   * underpay the rest of this one.
   */
  it("refuses a mid-month date", () => {
    expect(revisionDateProblem("2026-09-15", "2020-01-01", null)).toMatch(
      /one salary rate for a whole month/
    );
  });

  /**
   * The one exception, and the reason a hire's own typo is fixable: the very
   * first structure is dated to date_of_joining, which is usually mid-month.
   */
  it("allows exactly the date of joining, mid-month or not", () => {
    expect(revisionDateProblem("2026-06-18", "2026-06-18", null)).toBeNull();
  });

  it("refuses a date before the employee joined", () => {
    expect(revisionDateProblem("2019-01-01", "2020-01-01", null)).toMatch(/joined on/);
  });

  it("refuses a date after the employee left", () => {
    expect(revisionDateProblem("2026-10-01", "2020-01-01", "2026-08-20")).toMatch(
      /left on/
    );
  });

  it("asks for a month when nothing is entered", () => {
    expect(revisionDateProblem("", "2020-01-01", null)).toMatch(/Pick the month/);
  });
});

describe("blockingPostedMonth", () => {
  const posted = ["2026-07-01", "2026-08-01"];

  it("names the latest posted month at or after the revision", () => {
    expect(blockingPostedMonth(posted, "2026-07-01")).toBe("2026-08-01");
  });

  it("does not block a revision dated after every posted month", () => {
    expect(blockingPostedMonth(posted, "2026-09-01")).toBeNull();
  });

  /**
   * The hole found while writing this: a date_of_joining correction dated the
   * 15th must not be allowed to re-rate a posting dated the 1st of that same
   * month. Migration 1380 compares the MONTH for the same reason.
   */
  it("blocks a mid-month joining-date correction inside a posted month", () => {
    expect(blockingPostedMonth(posted, "2026-08-18")).toBe("2026-08-01");
  });

  it("is null when nothing has been posted", () => {
    expect(blockingPostedMonth([], "2026-08-01")).toBeNull();
  });
});

describe("nextMonthStart", () => {
  it("advances within a year", () => {
    expect(nextMonthStart("2026-08-01")).toBe("2026-09-01");
  });

  /** String arithmetic on purpose — a Date-based version gets this wrong in IST. */
  it("rolls over December into the next year", () => {
    expect(nextMonthStart("2026-12-01")).toBe("2027-01-01");
  });

  it("normalises a mid-month date to the following month's first", () => {
    expect(nextMonthStart("2026-08-18")).toBe("2026-09-01");
  });
});

describe("monthLabel", () => {
  it("reads the month off the string", () => {
    expect(monthLabel("2026-09-01")).toBe("Sep 2026");
    expect(monthLabel("2026-01-31")).toBe("Jan 2026");
    expect(monthLabel("2026-12-01")).toBe("Dec 2026");
  });
});

describe("todayInIndia", () => {
  /**
   * 18:45 UTC on 1 September is already 2 September in India. A UTC slice
   * answers the 1st, and an employee whose revision starts on the 2nd would be
   * shown as still on the old salary for another five and a half hours.
   */
  it("is the Indian calendar date, not the UTC one", () => {
    expect(todayInIndia(new Date("2026-09-01T18:45:00Z"))).toBe("2026-09-02");
  });

  it("agrees with UTC in the middle of the Indian day", () => {
    expect(todayInIndia(new Date("2026-09-01T06:00:00Z"))).toBe("2026-09-01");
  });

  it("returns an ISO-sortable string", () => {
    expect(todayInIndia(new Date("2026-03-05T04:00:00Z"))).toBe("2026-03-05");
  });
});

describe("structureGross", () => {
  it("sums the five pay components", () => {
    expect(
      structureGross({
        ...structure("2026-09-01", 14000),
        dearness_allowance: 2800,
        hra: 4200,
        special_allowance: 1400,
        other_allowance: 100,
      })
    ).toBe(22500);
  });
});
