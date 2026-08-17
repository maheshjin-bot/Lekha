/**
 * The CSV value coercion, which is where three of the defects carried over
 * from HISAB's importer lived. Two of them produced silently wrong data rather
 * than an error, so these vectors are the regression fence.
 */
import { describe, expect, it } from "vitest";
import {
  describeDate,
  inferDateOrder,
  parseAmount,
  parseDate,
} from "@/lib/csv/coerce";

describe("parseAmount", () => {
  it("accepts plain numbers", () => {
    expect(parseAmount("1000")).toBe(1000);
    expect(parseAmount("1000.50")).toBe(1000.5);
    expect(parseAmount(2500)).toBe(2500);
  });

  it("accepts Indian digit grouping, which used to fail every row", () => {
    // Number("1,00,000.00") is NaN. An ordinary Excel export died on this.
    expect(parseAmount("1,00,000.00")).toBe(100000);
    expect(parseAmount("12,34,567.89")).toBe(1234567.89);
  });

  it("accepts western grouping too", () => {
    expect(parseAmount("100,000.00")).toBe(100000);
  });

  it("accepts currency symbols and spacing", () => {
    expect(parseAmount("₹5,000")).toBe(5000);
    expect(parseAmount("Rs. 5,000")).toBe(5000);
    expect(parseAmount("INR 5000")).toBe(5000);
    expect(parseAmount("  1 000  ")).toBe(1000);
  });

  it("reads accounting brackets as negative", () => {
    expect(parseAmount("(1,234.00)")).toBe(-1234);
    expect(parseAmount("-500")).toBe(-500);
  });

  it("strips a trailing Dr/Cr marker without changing the sign", () => {
    // The Dr/Cr column decides the side; the marker here is decoration.
    expect(parseAmount("5,000.00 Dr")).toBe(5000);
    expect(parseAmount("5,000.00 Cr")).toBe(5000);
  });

  it("rejects non-numeric cells rather than coercing them to zero", () => {
    // The dangerous failure: "n/a" silently becoming 0.00 in a ledger.
    expect(parseAmount("n/a")).toBeNull();
    expect(parseAmount("--")).toBeNull();
    expect(parseAmount("1,2,")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe("parseDate", () => {
  it("accepts ISO", () => {
    expect(parseDate("2026-04-01")).toBe("2026-04-01");
  });

  it("reads the same cell differently under each ordering", () => {
    // This is the whole defect: 04/01/2026 is 4 January or 1 April depending
    // on who exported it, and HISAB always assumed the first.
    expect(parseDate("04/01/2026", "dmy")).toBe("2026-01-04");
    expect(parseDate("04/01/2026", "mdy")).toBe("2026-04-01");
  });

  it("accepts several separators", () => {
    expect(parseDate("01-04-2026", "dmy")).toBe("2026-04-01");
    expect(parseDate("01.04.2026", "dmy")).toBe("2026-04-01");
  });

  it("expands two-digit years", () => {
    expect(parseDate("01/04/26", "dmy")).toBe("2026-04-01");
    expect(parseDate("01/04/99", "dmy")).toBe("1999-04-01");
  });

  it("rejects impossible dates instead of handing them to Postgres", () => {
    // 32/13/2026 used to become the string "2026-13-32" and fail at insert,
    // surfacing as a database error rather than a row-level typo.
    expect(parseDate("32/13/2026", "dmy")).toBeNull();
    expect(parseDate("31/02/2026", "dmy")).toBeNull();
    expect(parseDate("29/02/2025", "dmy")).toBeNull();
    expect(parseDate("29/02/2024", "dmy")).toBe("2024-02-29");
  });

  it("rejects junk", () => {
    expect(parseDate("")).toBeNull();
    expect(parseDate("last tuesday")).toBeNull();
  });
});

describe("inferDateOrder", () => {
  it("is certain when a first component exceeds 12", () => {
    const r = inferDateOrder(["01/04/2026", "17/08/2026"]);
    expect(r.order).toBe("dmy");
    expect(r.certain).toBe(true);
  });

  it("is certain the other way when a second component exceeds 12", () => {
    const r = inferDateOrder(["04/01/2026", "08/17/2026"]);
    expect(r.order).toBe("mdy");
    expect(r.certain).toBe(true);
  });

  it("admits uncertainty when every date reads either way", () => {
    // The case that must prompt rather than guess.
    const r = inferDateOrder(["04/01/2026", "05/02/2026"]);
    expect(r.certain).toBe(false);
    if (!r.certain) expect(r.example).toBe("04/01/2026");
  });

  it("flags a file that cannot share one ordering", () => {
    const r = inferDateOrder(["17/08/2026", "08/17/2026"]);
    expect(r.certain).toBe(false);
  });
});

describe("describeDate", () => {
  it("spells out how a cell will be read, for the confirmation prompt", () => {
    expect(describeDate("04/01/2026", "dmy")).toBe("4 January 2026");
    expect(describeDate("04/01/2026", "mdy")).toBe("1 April 2026");
  });
});
