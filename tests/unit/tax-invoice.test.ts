import { describe, it, expect } from "vitest";
import {
  buildRateWiseBreakup,
  isReverseCharge,
  documentTitle,
  copyLabels,
  exportEndorsement,
  isGstDocument,
} from "@/lib/invoice/taxInvoice";

const NO_TAX = { cgst: 0, sgst: 0, igst: 0, cess: 0 };

describe("buildRateWiseBreakup", () => {
  it("splits a genuinely mixed-rate invoice the way the ledger posted it", () => {
    // Sharma Textiles HO/SAL/2026-27/00007, read live from the database:
    // 5,000 of Product A at 18% + 3,000 of the 12% variant, CGST 630 and
    // SGST 630 actually posted. Hand-derived truth: the 18% bucket bears
    // 5000 x 9% = 450 of the CGST and the 12% bucket 3000 x 6% = 180.
    const buckets = buildRateWiseBreakup(
      [
        { amount: 5000, gstRatePercent: 18, cessRatePercent: 0 },
        { amount: 3000, gstRatePercent: 12, cessRatePercent: 0 },
      ],
      { cgst: 630, sgst: 630, igst: 0, cess: 0 }
    );

    expect(buckets).toHaveLength(2);
    // Sorted low rate first.
    expect(buckets[0]).toMatchObject({ ratePercent: 12, taxableValue: 3000, cgst: 180, sgst: 180 });
    expect(buckets[1]).toMatchObject({ ratePercent: 18, taxableValue: 5000, cgst: 450, sgst: 450 });
  });

  it("would have misallocated under a plain taxable-value share", () => {
    // The regression this weighting exists to prevent: a value share gives
    // the 12% bucket 3/8 of 630 = 236.25, not the 180 it actually bears.
    const buckets = buildRateWiseBreakup(
      [
        { amount: 5000, gstRatePercent: 18, cessRatePercent: 0 },
        { amount: 3000, gstRatePercent: 12, cessRatePercent: 0 },
      ],
      { cgst: 630, sgst: 630, igst: 0, cess: 0 }
    );
    expect(buckets.find((b) => b.ratePercent === 12)!.cgst).not.toBeCloseTo(236.25, 2);
  });

  it("foots exactly to the posted tax even when the weights do not divide", () => {
    // Three lines at three rates against a total that cannot split cleanly
    // into paise. The invariant that matters is not any single bucket but
    // that the buckets re-sum to precisely what the ledger holds.
    const posted = { cgst: 333.33, sgst: 333.33, igst: 0, cess: 0 };
    const buckets = buildRateWiseBreakup(
      [
        { amount: 1000, gstRatePercent: 5, cessRatePercent: 0 },
        { amount: 1000, gstRatePercent: 12, cessRatePercent: 0 },
        { amount: 1000, gstRatePercent: 18, cessRatePercent: 0 },
      ],
      posted
    );
    const sum = (k: "cgst" | "sgst") =>
      Math.round(buckets.reduce((n, b) => n + b[k], 0) * 100) / 100;
    expect(sum("cgst")).toBe(333.33);
    expect(sum("sgst")).toBe(333.33);
  });

  it("keeps every rupee of taxable value across buckets", () => {
    const buckets = buildRateWiseBreakup(
      [
        { amount: 8500, gstRatePercent: 18, cessRatePercent: 0 },
        { amount: 8000, gstRatePercent: 18, cessRatePercent: 0 },
      ],
      { cgst: 1485, sgst: 1485, igst: 0, cess: 0 }
    );
    // Sharma HO/SAL/2026-27/00018 — both lines at one rate collapse to a
    // single row carrying the whole 16,500 and the whole 1,485 per head.
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ ratePercent: 18, taxableValue: 16500, cgst: 1485, sgst: 1485 });
  });

  it("gives an exempt/zero-rated line its own 0% bucket rather than dropping it", () => {
    const buckets = buildRateWiseBreakup(
      [
        { amount: 1000, gstRatePercent: 0, cessRatePercent: 0 },
        { amount: 1000, gstRatePercent: 18, cessRatePercent: 0 },
      ],
      { cgst: 90, sgst: 90, igst: 0, cess: 0 }
    );
    expect(buckets.map((b) => b.ratePercent)).toEqual([0, 18]);
    expect(buckets[0]).toMatchObject({ taxableValue: 1000, cgst: 0, sgst: 0 });
    expect(buckets[1]).toMatchObject({ taxableValue: 1000, cgst: 90, sgst: 90 });
  });

  it("still distributes posted tax when no line carries a rate at all", () => {
    // Nothing in the item master, but the ledger holds tax. Falling back to
    // a value share keeps the document honest about what was posted instead
    // of printing a break-up that sums to nothing.
    const buckets = buildRateWiseBreakup(
      [
        { amount: 3000, gstRatePercent: 0, cessRatePercent: 0 },
        { amount: 1000, gstRatePercent: 0, cessRatePercent: 0 },
      ],
      { cgst: 100, sgst: 100, igst: 0, cess: 0 }
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].cgst).toBe(100);
  });

  it("handles an export with no tax posted", () => {
    // Sharma HO/SAL/2026-27/00011, export under LUT: 100,000 taxable, nil tax.
    const buckets = buildRateWiseBreakup(
      [{ amount: 100000, gstRatePercent: 18, cessRatePercent: 0 }],
      NO_TAX
    );
    expect(buckets[0]).toMatchObject({ taxableValue: 100000, cgst: 0, sgst: 0, igst: 0 });
  });

  it("allocates cess on its own weighting, not the GST one", () => {
    // Only the second line bears cess, so all of it must land there even
    // though the first line carries more GST.
    const buckets = buildRateWiseBreakup(
      [
        { amount: 10000, gstRatePercent: 18, cessRatePercent: 0 },
        { amount: 1000, gstRatePercent: 5, cessRatePercent: 12 },
      ],
      { cgst: 925, sgst: 925, igst: 0, cess: 120 }
    );
    expect(buckets.find((b) => b.ratePercent === 5)!.cess).toBe(120);
    expect(buckets.find((b) => b.ratePercent === 18)!.cess).toBe(0);
  });

  it("returns nothing for a voucher with no item lines", () => {
    expect(buildRateWiseBreakup([], { cgst: 10, sgst: 10, igst: 0, cess: 0 })).toEqual([]);
  });
});

describe("isReverseCharge", () => {
  it("is true when any single line is flagged", () => {
    expect(isReverseCharge([{ isRcmApplicable: false }, { isRcmApplicable: true }])).toBe(true);
  });
  it("is false for an ordinary forward-charge invoice", () => {
    expect(isReverseCharge([{ isRcmApplicable: false }])).toBe(false);
  });
  it("is false, not undefined, for a voucher with no lines", () => {
    expect(isReverseCharge([])).toBe(false);
  });
});

describe("documentTitle", () => {
  it("defaults a sales voucher to Tax Invoice", () => {
    expect(documentTitle("sales", "auto")).toBe("Tax Invoice");
    expect(documentTitle("sales", null)).toBe("Tax Invoice");
  });
  it("honours the Rule 49 / Rule 46A overrides", () => {
    expect(documentTitle("sales", "bill_of_supply")).toBe("Bill of Supply");
    expect(documentTitle("sales", "invoice_cum_bill_of_supply")).toBe("Invoice-cum-Bill of Supply");
    expect(documentTitle("sales", "invoice")).toBe("Invoice");
  });
  it("ignores the override on documents Sec 34 already names", () => {
    expect(documentTitle("credit_note", "bill_of_supply")).toBe("Credit Note");
    expect(documentTitle("debit_note", "bill_of_supply")).toBe("Debit Note");
    expect(documentTitle("purchase", "bill_of_supply")).toBe("Purchase Bill");
  });
  it("names non-GST vouchers as themselves", () => {
    expect(documentTitle("journal", "auto")).toBe("Journal Voucher");
    expect(documentTitle("receipt", "auto")).toBe("Receipt");
    expect(documentTitle("something_new", "auto")).toBe("Voucher");
  });
});

describe("copyLabels", () => {
  it("marks three copies for goods, per Rule 48(1)", () => {
    expect(copyLabels("sales", "goods", false)).toEqual([
      "Original for Recipient",
      "Duplicate for Transporter",
      "Triplicate for Supplier",
    ]);
  });
  it("marks two for services and the second is the SUPPLIER'S, per Rule 48(2)", () => {
    expect(copyLabels("sales", "services", false)).toEqual([
      "Original for Recipient",
      "Duplicate for Supplier",
    ]);
  });
  it("suppresses the markings entirely once an IRN exists — Rule 48(6)", () => {
    expect(copyLabels("sales", "goods", true)).toEqual([]);
    expect(copyLabels("sales", "services", true)).toEqual([]);
  });
  it("never marks a document this company did not issue as supplier", () => {
    expect(copyLabels("purchase", "goods", false)).toEqual([]);
    expect(copyLabels("journal", "goods", false)).toEqual([]);
  });
  it("prints one unmarked copy when the company has not opted in", () => {
    expect(copyLabels("sales", "none", false)).toEqual([]);
    expect(copyLabels("sales", null, false)).toEqual([]);
  });
});

describe("exportEndorsement", () => {
  it("uses the on-payment wording for an export with IGST", () => {
    expect(exportEndorsement("export_igst", 9000)).toContain("ON PAYMENT OF INTEGRATED TAX");
  });
  it("uses the LUT wording for a zero-rated export", () => {
    expect(exportEndorsement("export_lut", 0)).toContain(
      "UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX"
    );
  });
  it("decides an SEZ supply from whether IGST was actually posted", () => {
    expect(exportEndorsement("sez", 0)).toContain("WITHOUT PAYMENT OF INTEGRATED TAX");
    expect(exportEndorsement("sez", 7200)).toContain("ON PAYMENT OF INTEGRATED TAX");
  });
  it("prints no Rule 46 endorsement on a domestic or deemed-export supply", () => {
    expect(exportEndorsement("intra", 0)).toBeNull();
    expect(exportEndorsement("inter", 900)).toBeNull();
    expect(exportEndorsement("deemed_export", 5400)).toBeNull();
    expect(exportEndorsement(null, 0)).toBeNull();
  });
});

describe("isGstDocument", () => {
  it("covers exactly the four voucher types that carry item lines and tax", () => {
    for (const t of ["sales", "purchase", "credit_note", "debit_note"]) {
      expect(isGstDocument(t)).toBe(true);
    }
    for (const t of ["journal", "receipt", "payment", "contra", "branch_transfer", "stock_journal"]) {
      expect(isGstDocument(t)).toBe(false);
    }
  });
});
