/**
 * Financial-year and default-period handling.
 *
 * The test vectors here are deliberately the same ones asserted in SQL by
 * supabase/tests/guarantees.sql against app_private.fy_start_date/fy_label.
 * Two implementations of the financial year exist — one in Postgres, one in
 * TypeScript — and the expensive bug is the one where they disagree, because
 * a report header and the rows underneath it are then computed from different
 * years. Sharing the vectors is what makes that disagreement fail a test.
 *
 * The suite runs with TZ=Asia/Kolkata (see vitest.config.ts). That is not
 * incidental: a UTC+05:30 clock is the only place where mixing local and UTC
 * date arithmetic is observable, and this module mixes them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPeriod, financialYearLabel, financialYearStart } from "@/lib/utils/period";

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Noon UTC — far from any date boundary, so the input itself is unambiguous. */
const on = (date: string) => new Date(`${date}T12:00:00Z`);

afterEach(() => {
  vi.useRealTimers();
});

describe("financialYearStart", () => {
  it("puts 31 March in the year that began the previous April", () => {
    expect(iso(financialYearStart(4, on("2026-03-31")))).toBe("2025-04-01");
  });

  it("opens a new year on 1 April", () => {
    expect(iso(financialYearStart(4, on("2026-04-01")))).toBe("2026-04-01");
  });

  it("honours a non-April year start", () => {
    // A July-year company must not be told its year began in April. April is
    // also the default, so a hardcoded 4 passes every April-only test.
    expect(iso(financialYearStart(7, on("2026-06-30")))).toBe("2025-07-01");
    expect(iso(financialYearStart(7, on("2026-07-01")))).toBe("2026-07-01");
  });

  it("handles a January year start, where the FY is the calendar year", () => {
    expect(iso(financialYearStart(1, on("2026-01-01")))).toBe("2026-01-01");
    expect(iso(financialYearStart(1, on("2026-12-31")))).toBe("2026-01-01");
  });
});

describe("financialYearLabel", () => {
  it("labels the April year by its opening year", () => {
    expect(financialYearLabel(4, on("2026-04-01"))).toBe("2026-27");
    expect(financialYearLabel(4, on("2026-03-31"))).toBe("2025-26");
  });

  it("labels a July year by its opening year, not the calendar year", () => {
    expect(financialYearLabel(7, on("2026-07-01"))).toBe("2026-27");
    expect(financialYearLabel(7, on("2026-06-30"))).toBe("2025-26");
  });

  it("wraps the two-digit suffix at the century instead of overflowing", () => {
    // Matches app_private.fy_label: 2099 must give 2099-00, not 2099-100.
    expect(financialYearLabel(4, on("2099-05-01"))).toBe("2099-00");
  });
});

describe("defaultPeriod", () => {
  it("returns the explicit range when one is given, unchanged", () => {
    const p = defaultPeriod(4, { from: "2025-04-01", to: "2025-06-30" });
    expect(p.from).toBe("2025-04-01");
    expect(p.to).toBe("2025-06-30");
  });

  it("defaults to the financial year to date for a July-year company", () => {
    // F-01: the FY label shown to the user must be derived from the company's
    // own year start, not from a cached or April-assumed value.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00+05:30"));
    const p = defaultPeriod(7);
    expect(p.from).toBe("2026-07-01");
    expect(p.label).toContain("FY 2026-27");
  });

  it("never returns a period that starts after it ends", () => {
    // F-06: `from` is derived from the local calendar date and `to` from the
    // UTC one. Between 00:00 and 05:30 IST those are different days, so on the
    // first morning of the financial year the period inverts.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:30:00+05:30"));
    const p = defaultPeriod(4);
    expect(
      p.from <= p.to,
      `period runs backwards: from ${p.from} to ${p.to} (label: ${p.label})`
    ).toBe(true);
  });

  it("ends on today's Indian date, not yesterday's UTC date", () => {
    // F-06 again, the everyday form: a report run before 05:30 IST silently
    // omits everything posted since midnight.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T02:00:00+05:30"));
    expect(defaultPeriod(4).to).toBe("2026-08-17");
  });
});
