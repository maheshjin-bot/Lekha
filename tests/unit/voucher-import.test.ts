/**
 * The three-stage voucher import.
 *
 * Most of these are regression fences for defects carried over from HISAB's
 * importer. The dangerous ones are F-05 and F-10: both let bad data through
 * while reporting every row valid.
 */
import { describe, expect, it } from "vitest";
import { buildPreview, toBulkPayload, type ImportContext } from "@/lib/csv/voucher-import";

const ctx: ImportContext = {
  ledgers: [
    { id: "l-cash", name: "Cash-in-Hand" },
    { id: "l-sales", name: "Sales" },
    { id: "l-rent", name: "A. B. Landlords" },
  ],
  dateOrder: "dmy",
  lockDate: null,
  branchId: "b-ho",
};

const row = (o: Partial<Record<string, string>>) => ({
  "Voucher Ref": "V1",
  Date: "01/04/2026",
  "Voucher Type": "Payment",
  Ledger: "Cash-in-Hand",
  "Dr/Cr": "Dr",
  Amount: "1000",
  ...o,
}) as Record<string, string>;

describe("row validation", () => {
  it("accepts a well-formed balanced voucher", () => {
    const p = buildPreview(
      [row({}), row({ Ledger: "Sales", "Dr/Cr": "Cr" })],
      ctx
    );
    expect(p.invalidRowCount).toBe(0);
    expect(p.validGroupCount).toBe(1);
    expect(p.groupIssues).toEqual([]);
  });

  it("matches a ledger through punctuation differences", () => {
    // "A B Landlords" must find "A. B. Landlords" — HISAB matched on
    // trim+lower only, so this failed and needed manual reconciliation.
    const p = buildPreview(
      [row({ Ledger: "A B Landlords" }), row({ Ledger: "Sales", "Dr/Cr": "Cr" })],
      ctx
    );
    expect(p.invalidRowCount).toBe(0);
  });

  it("suggests a near match rather than only refusing", () => {
    const p = buildPreview([row({ Ledger: "Cash" })], ctx);
    const issue = p.rows[0].issues.find((i) => i.field === "Ledger");
    expect(issue?.suggestion).toBe("Cash-in-Hand");
  });

  it("rejects a negative amount instead of double-encoding direction", () => {
    const p = buildPreview([row({ Amount: "-500" })], ctx);
    expect(p.rows[0].issues.some((i) => i.field === "Amount")).toBe(true);
  });

  it("accepts Indian grouping in the amount column", () => {
    const p = buildPreview(
      [row({ Amount: "1,00,000" }), row({ Ledger: "Sales", "Dr/Cr": "Cr", Amount: "1,00,000" })],
      ctx
    );
    expect(p.invalidRowCount).toBe(0);
  });
});

describe("group validation", () => {
  it("rejects a group whose rows disagree about the date", () => {
    // F-05. HISAB took the first row's date for the whole group and discarded
    // the rest — silently, with the preview reporting every row valid.
    const p = buildPreview(
      [row({}), row({ Ledger: "Sales", "Dr/Cr": "Cr", Date: "02/04/2026" })],
      ctx
    );
    expect(p.validGroupCount).toBe(0);
    expect(p.invalidRowCount).toBe(2);
    expect(p.groupIssues[0].message).toContain("disagree about the date");
  });

  it("rejects a group whose rows disagree about the voucher type", () => {
    const p = buildPreview(
      [row({}), row({ Ledger: "Sales", "Dr/Cr": "Cr", "Voucher Type": "Sales" })],
      ctx
    );
    expect(p.groupIssues[0].message).toContain("disagree about the voucher type");
  });

  it("rejects an unbalanced group", () => {
    const p = buildPreview(
      [row({}), row({ Ledger: "Sales", "Dr/Cr": "Cr", Amount: "900" })],
      ctx
    );
    expect(p.groupIssues[0].message).toContain("does not equal credit");
  });

  it("rejects a single-line voucher", () => {
    const p = buildPreview([row({})], ctx);
    expect(p.groupIssues[0].message).toContain("at least two lines");
  });

  it("keeps a good group when another group fails", () => {
    const p = buildPreview(
      [
        row({}),
        row({ Ledger: "Sales", "Dr/Cr": "Cr" }),
        row({ "Voucher Ref": "V2", Amount: "500" }),
        row({ "Voucher Ref": "V2", Ledger: "Sales", "Dr/Cr": "Cr", Amount: "400" }),
      ],
      ctx
    );
    expect(p.validGroupCount).toBe(1);
    expect(p.validRowCount).toBe(2);
  });
});

describe("lock date", () => {
  it("flags locked rows in the preview, not at commit", () => {
    // F-10. These used to pass all validation and fail per-group at insert,
    // so the preview promised rows it could not deliver.
    const p = buildPreview(
      [row({}), row({ Ledger: "Sales", "Dr/Cr": "Cr" })],
      { ...ctx, lockDate: "2026-04-30" }
    );
    expect(p.invalidRowCount).toBe(2);
    expect(p.rows[0].issues[0].message).toContain("locked");
  });
});

describe("toBulkPayload", () => {
  it("carries the reference number through", () => {
    // F-07. HISAB hardcoded reference_number to null, so importing a purchase
    // book lost every supplier bill number.
    const p = buildPreview(
      [
        row({ "Voucher Type": "Purchase", Reference: "INV-8891" }),
        row({ "Voucher Type": "Purchase", Reference: "INV-8891", Ledger: "Sales", "Dr/Cr": "Cr" }),
      ],
      ctx
    );
    const payload = toBulkPayload(p, "b-ho");
    expect(payload).toHaveLength(1);
    expect(payload[0].reference_number).toBe("INV-8891");
    expect(payload[0].voucher_type).toBe("purchase");
    expect(payload[0].lines).toHaveLength(2);
  });

  it("rejects a group whose rows disagree about the reference", () => {
    const p = buildPreview(
      [
        row({ Reference: "INV-1" }),
        row({ Reference: "INV-2", Ledger: "Sales", "Dr/Cr": "Cr" }),
      ],
      ctx
    );
    expect(p.groupIssues[0].message).toContain("disagree about the reference");
  });
});
