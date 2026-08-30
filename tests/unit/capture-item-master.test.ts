/**
 * The ITEM half of capture review: reading a line's unit and tax rate off the
 * paper, and identifying which item on file that line refers to.
 *
 * The sibling of tests/unit/capture-fuzzy-match.test.ts's matchParty block —
 * same question (what on this document identifies a master record, and how
 * strongly), asked one line further down the page.
 */
import { describe, expect, it } from "vitest";
import {
  parseExtractionResponse,
  toGstRatePercentOrNull,
  toUomCodeOrNull,
  REF_UOM,
} from "@/lib/capture/analyze";
import { matchItem } from "@/lib/capture/fuzzyMatch";

describe("toUomCodeOrNull", () => {
  it("matches a notified code however it was printed", () => {
    expect(toUomCodeOrNull("NOS")).toBe("NOS");
    expect(toUomCodeOrNull("nos")).toBe("NOS");
    expect(toUomCodeOrNull("Nos.")).toBe("NOS");
    expect(toUomCodeOrNull(" Mtr ")).toBe("MTR");
    expect(toUomCodeOrNull("KGS")).toBe("KGS");
  });

  it("matches a unit printed by its ref_uom NAME, singular or plural", () => {
    expect(toUomCodeOrNull("Rolls")).toBe("ROL");
    // ref_uom's names are plural; invoices print the singular.
    expect(toUomCodeOrNull("Roll")).toBe("ROL");
    expect(toUomCodeOrNull("Kilograms")).toBe("KGS");
    expect(toUomCodeOrNull("Bag")).toBe("BAG");
    expect(toUomCodeOrNull("Square Feet")).toBe("SQF");
  });

  it("resolves the printed abbreviations that are neither a code nor a name", () => {
    expect(toUomCodeOrNull("Pcs")).toBe("PCS"); // a code outright
    expect(toUomCodeOrNull("Pc")).toBe("PCS");
    expect(toUomCodeOrNull("No")).toBe("NOS");
    expect(toUomCodeOrNull("Unit")).toBe("NOS");
    expect(toUomCodeOrNull("Kg")).toBe("KGS");
    // "MT" on an Indian invoice is a metric tonne, not a metre.
    expect(toUomCodeOrNull("MT")).toBe("TON");
    expect(toUomCodeOrNull("Sq.Ft.")).toBe("SQF");
    expect(toUomCodeOrNull("Mtrs")).toBe("MTR");
    expect(toUomCodeOrNull("Meter")).toBe("MTR");
  });

  it("returns null rather than inventing a unit the database would refuse", () => {
    // items.uom is a FOREIGN KEY to ref_uom(code), so a made-up code is a
    // 23503 on a field the preparer never typed. Null lets the popup keep its
    // own default, which the preparer can see and change.
    expect(toUomCodeOrNull("carton of 12")).toBeNull();
    expect(toUomCodeOrNull("")).toBeNull();
    expect(toUomCodeOrNull("   ")).toBeNull();
    expect(toUomCodeOrNull(null)).toBeNull();
    expect(toUomCodeOrNull(undefined)).toBeNull();
    expect(toUomCodeOrNull(12)).toBeNull();
  });

  it("only ever returns a code REF_UOM actually holds", () => {
    const codes = new Set(REF_UOM.map((u) => u.code));
    const printed = [
      "Nos", "NOS", "Pcs", "Pc", "No", "Unit", "Each", "Mtr", "Mtrs", "Meter", "M",
      "Kg", "Kgs", "Gm", "MT", "Ton", "Tonnes", "Qtl", "Ltr", "Litre", "L", "ML",
      "Box", "Boxes", "Bag", "Bags", "Roll", "Rolls", "Set", "Dozen", "Dzn",
      "Sq.Ft", "SqFt", "Sqm", "CBM", "Hrs", "Hr", "Days", "Pkt", "Pack", "Bottle",
      "CM", "KM", "Others",
    ];
    for (const p of printed) {
      const code = toUomCodeOrNull(p);
      expect(code, `"${p}" resolved to ${code}`).not.toBeNull();
      expect(codes.has(code!), `"${p}" -> ${code} is not in ref_uom`).toBe(true);
    }
  });
});

describe("toGstRatePercentOrNull", () => {
  it("keeps every notified rate", () => {
    for (const r of [0, 0.25, 3, 5, 12, 18, 28]) {
      expect(toGstRatePercentOrNull(r)).toBe(r);
    }
  });

  it("DROPS a half-rate — the CGST-column misreading this whole check exists for", () => {
    // An intra-state invoice prints "CGST 9%" and "SGST 9%" in two adjacent
    // columns. 9 is what is literally written under each, and a 9% item master
    // would charge half the tax on every future invoice, silently, forever.
    // No notified rate is half of another notified rate, so the list catches
    // every one of these.
    for (const half of [0.125, 1.5, 2.5, 6, 9, 14]) {
      expect(toGstRatePercentOrNull(half), `${half}% survived`).toBeNull();
    }
  });

  it("drops anything else rather than rounding it to the nearest notified rate", () => {
    expect(toGstRatePercentOrNull(17.5)).toBeNull();
    expect(toGstRatePercentOrNull(20)).toBeNull();
    // A tax AMOUNT returned where a rate was asked for.
    expect(toGstRatePercentOrNull(2160)).toBeNull();
    expect(toGstRatePercentOrNull("18")).toBeNull();
    expect(toGstRatePercentOrNull(null)).toBeNull();
    expect(toGstRatePercentOrNull(Number.NaN)).toBeNull();
  });
});

describe("parseExtractionResponse — the line's unit and rate", () => {
  const line = (extra: Record<string, unknown>) =>
    JSON.stringify({
      document_type: "purchase_invoice",
      confidence: "high",
      note: "A supplier's tax invoice.",
      line_items: [{ description: "Cotton Shirting 44in", ...extra }],
    });

  it("normalises the printed unit into a ref_uom code", () => {
    const ex = parseExtractionResponse(line({ unit: "Mtr", quantity: 120 }));
    expect(ex.line_items[0].uom).toBe("MTR");
  });

  it("keeps a notified line rate and drops a half-rate", () => {
    expect(parseExtractionResponse(line({ gst_rate_percent: 18 })).line_items[0].gst_rate_percent)
      .toBe(18);
    expect(parseExtractionResponse(line({ gst_rate_percent: 9 })).line_items[0].gst_rate_percent)
      .toBeNull();
  });

  it("reads null for both when the document printed neither", () => {
    const ex = parseExtractionResponse(line({ quantity: 3, rate: 100, amount: 300 }));
    expect(ex.line_items[0].uom).toBeNull();
    expect(ex.line_items[0].gst_rate_percent).toBeNull();
    // And the pre-existing fields are untouched by the addition.
    expect(ex.line_items[0].quantity).toBe(3);
    expect(ex.line_items[0].rate).toBe(100);
    expect(ex.line_items[0].amount).toBe(300);
  });

  it("still keeps a line whose unit is unreadable — a line is never dropped for it", () => {
    const ex = parseExtractionResponse(line({ unit: "carton of 12", quantity: 4 }));
    expect(ex.line_items).toHaveLength(1);
    expect(ex.line_items[0].uom).toBeNull();
    expect(ex.line_items[0].quantity).toBe(4);
  });
});

describe("matchItem", () => {
  // A mill's item master: several fabrics under one tariff heading, plus an
  // unrelated item and one with no HSN on file at all.
  const items = [
    { id: "grey", name: "Cotton Shirting 44in Grey", hsn_sac: "52081190" },
    { id: "white", name: "Cotton Shirting 44in White", hsn_sac: "52081190" },
    { id: "poplin", name: "Poplin Dyed 58in", hsn_sac: "52081190" },
    { id: "button", name: "Shirt Buttons 18L", hsn_sac: "96062100" },
    { id: "thread", name: "Sewing Thread Cone", hsn_sac: null },
  ];

  it("takes the HSN and a similar name together as near-conclusive", () => {
    const m = matchItem(
      { description: "COTTON SHIRTING 44IN GREY", hsn_sac: "52081190" },
      items
    );
    expect(m?.signal).toBe("hsn_and_name");
    expect(m?.item.id).toBe("grey");
    expect(m?.candidates).toHaveLength(1);
    expect(m?.score).toBeGreaterThanOrEqual(0.5);
  });

  it("OFFERS the whole family when the HSN matches several and the name matches none", () => {
    // The heart of it: 52081190 is every plain cotton fabric this mill sells,
    // so choosing one arbitrarily posts the right total against the wrong
    // stock. The caller is handed the set instead.
    const m = matchItem({ description: "FABRIC AS PER SAMPLE", hsn_sac: "52081190" }, items);
    expect(m?.signal).toBe("hsn");
    expect(m?.candidates.map((c) => c.id).sort()).toEqual(["grey", "poplin", "white"]);
  });

  it("does not select even when exactly ONE item shares the HSN", () => {
    // "You own one thing in this family" is not "this line is that thing".
    const m = matchItem({ description: "PLASTIC FASTENERS", hsn_sac: "96062100" }, items);
    expect(m?.signal).toBe("hsn");
    expect(m?.candidates.map((c) => c.id)).toEqual(["button"]);
  });

  it("orders an offered family best-name-first", () => {
    // Every member of the family scores BELOW the threshold here — "dyed" is
    // the only word shared with anything — so this is still an "hsn" offer and
    // not a match. Written first as "Poplin Dyed" and it FAILED, correctly:
    // that is a substring of "Poplin Dyed 58in" and scores 0.8, which is a
    // real hsn_and_name hit and made the test's premise wrong, not the
    // matcher. What is asserted here is only the ORDER of an offered set.
    const m = matchItem({ description: "DYED FABRIC LOT 7", hsn_sac: "52081190" }, items);
    expect(m?.signal).toBe("hsn");
    expect(m?.candidates[0].id).toBe("poplin");
  });

  it("falls back to the name when the HSN identifies nobody on file", () => {
    const m = matchItem({ description: "Sewing Thread Cone", hsn_sac: "54011000" }, items);
    expect(m?.signal).toBe("name");
    expect(m?.item.id).toBe("thread");
  });

  it("falls back to the name when the document printed no HSN at all", () => {
    const m = matchItem({ description: "Cotton Shirting 44in Grey" }, items);
    expect(m?.signal).toBe("name");
    expect(m?.item.id).toBe("grey");
  });

  it("compares HSNs exactly, never by prefix", () => {
    // A 4-digit heading read off a small supplier's bill does not silently
    // claim every 8-digit item under it — the name matcher decides instead.
    const m = matchItem({ description: "SOMETHING UNRELATED", hsn_sac: "5208" }, items);
    expect(m).toBeNull();
  });

  it("tolerates a separator-laden HSN on either side", () => {
    const withDots = [{ id: "grey", name: "Cotton Shirting 44in Grey", hsn_sac: "5208.11.90" }];
    const m = matchItem({ description: "Cotton Shirting 44in Grey", hsn_sac: "52081190" }, withDots);
    expect(m?.signal).toBe("hsn_and_name");
  });

  it("returns null when nothing on file is identified at all", () => {
    expect(matchItem({ description: "Completely Unrelated Widget" }, items)).toBeNull();
    expect(matchItem({}, items)).toBeNull();
    expect(matchItem({ description: "Cotton Shirting 44in Grey" }, [])).toBeNull();
  });
});
