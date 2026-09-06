import { describe, expect, it } from "vitest";
import {
  classifySupplyType,
  isLutActive,
  lineGstSplit,
} from "@/lib/invoices/foreign-currency";

/**
 * classifySupplyType/lineGstSplit exist to stop InvoiceForm's client-side tax
 * PREVIEW from disagreeing with what create_invoice actually posts on an
 * export — before this, the preview only ever computed a plain intra/inter
 * split and had no idea an LUT exists, so a preparer shipping under a valid
 * LUT (Sec 16(3)(a), zero tax) was shown a full IGST figure the server was
 * never going to charge. Every case below was cross-checked against
 * app_private.gst_supply_type's real 4-argument overload (migration 0087)
 * and create_invoice's own per-line if/elsif chain (also 0087) — not against
 * this file's own reasoning about them.
 */
describe("classifySupplyType mirrors app_private.gst_supply_type", () => {
  it("an overseas party under an active LUT is export_lut (Sec 16(3)(a), zero-rated)", () => {
    expect(classifySupplyType("27", "96", "overseas", true)).toBe("export_lut");
  });

  it("an overseas party with no LUT active is export_igst (Sec 16(3)(b), IGST charged)", () => {
    expect(classifySupplyType("27", "96", "overseas", false)).toBe("export_igst");
  });

  it("sez and sez_developer both classify as sez regardless of LUT (the split is decided by lutActive downstream)", () => {
    expect(classifySupplyType("27", "24", "sez", true)).toBe("sez");
    expect(classifySupplyType("27", "24", "sez_developer", false)).toBe("sez");
  });

  it("deemed_export is its own label, distinct from intra/inter", () => {
    expect(classifySupplyType("27", "27", "deemed_export", false)).toBe("deemed_export");
  });

  it("an ordinary domestic party (regular/unregistered/composition/null) falls to plain intra or inter by state", () => {
    expect(classifySupplyType("27", "27", "regular", false)).toBe("intra");
    expect(classifySupplyType("27", "24", "regular", false)).toBe("inter");
    expect(classifySupplyType("27", "27", "unregistered", false)).toBe("intra");
    expect(classifySupplyType("27", "24", null, false)).toBe("inter");
  });
});

describe("isLutActive mirrors create_invoice's own LUT-window SELECT", () => {
  const branch = { lutNumber: "AD2408260012345", lutValidFrom: "2026-07-01", lutValidTo: "2027-03-31" };

  it("active inside the window", () => {
    expect(isLutActive(branch, "2026-09-03")).toBe(true);
    expect(isLutActive(branch, "2026-07-01")).toBe(true);
    expect(isLutActive(branch, "2027-03-31")).toBe(true);
  });

  it("not yet active before lut_valid_from, and expired after lut_valid_to", () => {
    expect(isLutActive(branch, "2026-06-30")).toBe(false);
    expect(isLutActive(branch, "2027-04-01")).toBe(false);
  });

  it("open-ended (lut_valid_to null) stays active indefinitely", () => {
    expect(isLutActive({ lutNumber: "X", lutValidFrom: "2026-01-01", lutValidTo: null }, "2099-01-01")).toBe(true);
  });

  it("no LUT on file, or the branch itself missing, is never active", () => {
    expect(isLutActive({ lutNumber: null, lutValidFrom: null, lutValidTo: null }, "2026-09-03")).toBe(false);
    expect(isLutActive(undefined, "2026-09-03")).toBe(false);
  });
});

describe("lineGstSplit mirrors create_invoice's per-line if/elsif chain exactly", () => {
  it("export_lut (or sez under an active LUT): zero tax, Sec 16(3)(a)", () => {
    expect(lineGstSplit(10000, 18, "export_lut", true, false)).toEqual({ cgst: 0, sgst: 0, igst: 0 });
    expect(lineGstSplit(10000, 18, "sez", true, false)).toEqual({ cgst: 0, sgst: 0, igst: 0 });
  });

  it("export_igst (or sez without an LUT): full IGST, always — Sec 16(3)(b) is always inter-State by IGST Act Sec 7(5), regardless of isIntrastate", () => {
    expect(lineGstSplit(10000, 18, "export_igst", false, true)).toEqual({ cgst: 0, sgst: 0, igst: 1800 });
    expect(lineGstSplit(10000, 18, "sez", false, true)).toEqual({ cgst: 0, sgst: 0, igst: 1800 });
  });

  it("intrastate (ordinary domestic, or a deemed_export line that happens to be intrastate): half CGST + half SGST", () => {
    expect(lineGstSplit(10000, 18, "intra", false, true)).toEqual({ cgst: 900, sgst: 900, igst: 0 });
    expect(lineGstSplit(10000, 18, "deemed_export", false, true)).toEqual({ cgst: 900, sgst: 900, igst: 0 });
  });

  it("interstate ordinary domestic: full IGST", () => {
    expect(lineGstSplit(10000, 18, "inter", false, false)).toEqual({ cgst: 0, sgst: 0, igst: 1800 });
  });

  it("hand-checked against the live invoice this task actually posted: Nexgen Softwares -> Lonestar Apparel Imports LLC (overseas, no LUT), 2 x Product A @ INR 5000 = 10000 taxable, 18% GST", () => {
    // voucher HO/SAL/2026-27/00010, id f75541e4-82a7-48d6-83b6-8c7061c76154 —
    // create_invoice posted exactly this: Cr Output IGST (27) 1800.00, no
    // CGST/SGST, confirming both this classification and this split.
    const supplyType = classifySupplyType("27", "96", "overseas", isLutActive({ lutNumber: null, lutValidFrom: null, lutValidTo: null }, "2026-09-03"));
    expect(supplyType).toBe("export_igst");
    expect(lineGstSplit(10000, 18, supplyType, false, false)).toEqual({ cgst: 0, sgst: 0, igst: 1800 });
  });
});
