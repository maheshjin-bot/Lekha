/**
 * Fuzzy name matching for OCR/vision bill capture (0740) — the prefill that
 * lets a vendor name the model read off a photographed bill preselect an
 * existing ledger, without ever being trusted enough to skip human review.
 */
import { describe, expect, it } from "vitest";
import { fuzzyMatchByName, nameSimilarity, normalizeName } from "@/lib/capture/fuzzyMatch";

describe("normalizeName", () => {
  it("lowercases and collapses punctuation/spacing", () => {
    expect(normalizeName("Sharma Textiles Pvt. Ltd.")).toBe("sharma textiles pvt ltd");
    expect(normalizeName("  ABC   Traders  ")).toBe("abc traders");
  });
});

describe("nameSimilarity", () => {
  it("scores an exact match (after normalizing) as 1", () => {
    expect(nameSimilarity("Sharma Textiles", "sharma textiles")).toBe(1);
  });

  it("scores a real substring relationship highly", () => {
    // The bill reads a short form of a name the ledger carries in full.
    expect(nameSimilarity("Sharma Textiles", "Sharma Textiles Pvt Ltd")).toBeGreaterThanOrEqual(0.8);
  });

  it("scores unrelated names at 0", () => {
    expect(nameSimilarity("Sharma Textiles", "Ashok Electricals")).toBe(0);
  });

  it("scores an empty guess or candidate at 0", () => {
    expect(nameSimilarity("", "Sharma Textiles")).toBe(0);
    expect(nameSimilarity("Sharma Textiles", "")).toBe(0);
  });
});

describe("fuzzyMatchByName", () => {
  const ledgers = [
    { id: "1", name: "Sharma Textiles Pvt Ltd" },
    { id: "2", name: "Ashok Electricals" },
    { id: "3", name: "Bansal Traders" },
  ];

  it("returns the best match above the threshold", () => {
    expect(fuzzyMatchByName("Sharma Textiles", ledgers)?.id).toBe("1");
  });

  it("returns null when nothing clears the threshold — the free-text fallback case", () => {
    expect(fuzzyMatchByName("Completely Unrelated Vendor LLP", ledgers)).toBeNull();
  });

  it("returns null for an empty or missing guess", () => {
    expect(fuzzyMatchByName("", ledgers)).toBeNull();
    expect(fuzzyMatchByName(null, ledgers)).toBeNull();
    expect(fuzzyMatchByName(undefined, ledgers)).toBeNull();
  });

  it("returns null against an empty candidate list", () => {
    expect(fuzzyMatchByName("Sharma Textiles", [])).toBeNull();
  });
});
