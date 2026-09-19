/**
 * lib/csv/item-import.ts — Opening Godown resolution (2210).
 *
 * The manufacturing pilot found a real, disclosed gap in item_home_godown:
 * a goods item with opening stock and no voucher history ever placed itself
 * in company-wide totals but in NO single godown's filtered view, in any
 * company with more than one godown — because items.opening_quantity has
 * never carried a godown of its own. 2210 gives it one (opening_godown_id),
 * and this file is where the CSV importer either resolves it unambiguously
 * or refuses the row rather than silently reproducing the same gap on
 * import, the one creation path ItemManager's own form doesn't cover.
 */
import { describe, expect, it } from "vitest";
import { buildItemPreview, type ImportContext } from "@/lib/csv/item-import";

const singleGodownCtx: ImportContext = {
  uoms: [{ code: "NOS", name: "Numbers" }, { code: "KGS", name: "Kilograms" }],
  tcsSections: [],
  existingNames: [],
  godowns: [{ id: "g-main", name: "Main Store" }],
};

const multiGodownCtx: ImportContext = {
  uoms: [{ code: "NOS", name: "Numbers" }, { code: "KGS", name: "Kilograms" }],
  tcsSections: [],
  existingNames: [],
  godowns: [
    { id: "g-rm", name: "Raw Material Store" },
    { id: "g-fg", name: "Finished Goods Store" },
  ],
};

const row = (o: Partial<Record<string, string>>) => ({
  Name: "Test Item",
  Type: "Goods",
  Unit: "NOS",
  "Opening Qty": "0",
  "Opening Value": "0",
  ...o,
}) as Record<string, string>;

describe("opening godown resolution", () => {
  it("auto-resolves to the company's only godown, no column needed", () => {
    const [r] = buildItemPreview(
      [row({ "Opening Qty": "500", "Opening Value": "150000" })],
      singleGodownCtx
    );
    expect(r.issues).toEqual([]);
    expect(r.data?.opening_godown_id).toBe("g-main");
  });

  it("leaves opening_godown_id null when opening qty is zero, even with multiple godowns", () => {
    const [r] = buildItemPreview([row({})], multiGodownCtx);
    expect(r.issues).toEqual([]);
    expect(r.data?.opening_godown_id).toBeNull();
  });

  it("leaves opening_godown_id null for a service item regardless of opening qty text", () => {
    const [r] = buildItemPreview(
      [row({ Type: "Service", "Opening Qty": "500", "Opening Value": "150000" })],
      multiGodownCtx
    );
    expect(r.issues).toEqual([]);
    expect(r.data?.item_type).toBe("service");
    expect(r.data?.opening_godown_id).toBeNull();
  });

  it("resolves a matching Opening Godown column, case-insensitively, in a multi-godown company", () => {
    const [r] = buildItemPreview(
      [
        row({
          "Opening Qty": "500",
          "Opening Value": "150000",
          "Opening Godown": "raw material store",
        }),
      ],
      multiGodownCtx
    );
    expect(r.issues).toEqual([]);
    expect(r.data?.opening_godown_id).toBe("g-rm");
  });

  it("refuses the row — not a silent zero-everywhere item — when the column is missing in a multi-godown company", () => {
    const [r] = buildItemPreview(
      [row({ "Opening Qty": "500", "Opening Value": "150000" })],
      multiGodownCtx
    );
    expect(r.data).toBeNull();
    expect(r.issues.some((i) => i.field === "Opening Godown")).toBe(true);
  });

  it("refuses the row when the named godown doesn't exist in this company", () => {
    const [r] = buildItemPreview(
      [
        row({
          "Opening Qty": "500",
          "Opening Value": "150000",
          "Opening Godown": "Nashik Cold Store",
        }),
      ],
      multiGodownCtx
    );
    expect(r.data).toBeNull();
    expect(r.issues.some((i) => i.field === "Opening Godown")).toBe(true);
  });
});
