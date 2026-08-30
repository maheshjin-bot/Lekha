/**
 * Fuzzy name matching for OCR/vision bill capture (0740) — the prefill that
 * lets a vendor name the model read off a photographed bill preselect an
 * existing ledger, without ever being trusted enough to skip human review.
 */
import { describe, expect, it } from "vitest";
import {
  fuzzyMatchByName,
  matchParty,
  nameSimilarity,
  normalizeName,
} from "@/lib/capture/fuzzyMatch";

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

/**
 * matchParty (0995's task) — the replacement for name-only party matching on
 * the capture review screen. What is under test is the ORDER: a captured
 * invoice usually prints a GSTIN, which identifies exactly one registration
 * of one legal entity, and matching on the shop name while ignoring that
 * number is what let a second ledger be created for a supplier already on
 * file. The signal it reports back matters as much as the party it picks,
 * because the review screen selects on "gstin" and only OFFERS on "pan".
 */
describe("matchParty", () => {
  const ledgers = [
    {
      id: "gj",
      name: "Super Electricals",
      gstin: "24AEMPB3576L1ZA",
      pan: "AEMPB3576L",
    },
    // The same legal business, registered in a second state: same PAN inside
    // the GSTIN, different state code, and a name a human would write
    // differently.
    { id: "mh", name: "Super Electricals - Mumbai", gstin: "27AEMPB3576L1Z7", pan: "AEMPB3576L" },
    { id: "other", name: "Sharma Textiles Pvt Ltd", gstin: null, pan: "AAACS1234K" },
  ];

  it("matches on GSTIN first and says so", () => {
    const m = matchParty({ name: "Totally Different Name Ltd", gstin: "24AEMPB3576L1ZA" }, ledgers);
    expect(m?.party.id).toBe("gj");
    expect(m?.signal).toBe("gstin");
  });

  it("ignores spacing and case in a GSTIN, as printed invoices do", () => {
    const m = matchParty({ gstin: " 24 aempb3576l1za " }, ledgers);
    expect(m?.party.id).toBe("gj");
    expect(m?.signal).toBe("gstin");
  });

  it("beats a better-scoring NAME with a GSTIN — the whole point of the order", () => {
    // The name is an exact match for the Mumbai ledger; the GSTIN is the
    // Gujarat one. The number wins.
    const m = matchParty(
      { name: "Super Electricals - Mumbai", gstin: "24AEMPB3576L1ZA" },
      ledgers
    );
    expect(m?.party.id).toBe("gj");
    expect(m?.signal).toBe("gstin");
  });

  it("falls back to PAN when no GSTIN on file matches, and labels it 'pan'", () => {
    // A third registration of the same business — same PAN, a state neither
    // ledger holds. This is the "same business, different state" case, and
    // the review screen must not select it silently.
    const m = matchParty({ name: "Super Electricals", gstin: "29AEMPB3576L1Z8" }, ledgers);
    expect(m?.signal).toBe("pan");
    expect(["gj", "mh"]).toContain(m?.party.id);
  });

  it("finds a PAN match through the PAN embedded in a candidate's GSTIN", () => {
    const gstinOnly = [{ id: "g", name: "Nothing Alike", gstin: "24AEMPB3576L1ZA" }];
    const m = matchParty({ name: "Nothing Alike At All", pan: "AEMPB3576L" }, gstinOnly);
    expect(m?.party.id).toBe("g");
    expect(m?.signal).toBe("pan");
  });

  it("falls back to the name when neither number identifies anyone", () => {
    const m = matchParty({ name: "Sharma Textiles" }, ledgers);
    expect(m?.party.id).toBe("other");
    expect(m?.signal).toBe("name");
    expect(m?.score).toBeGreaterThanOrEqual(0.5);
  });

  it("does not match a party whose GSTIN merely shares a state code", () => {
    // Same state code 24, a PAN nobody on file holds. Written first with
    // 24AAACS1234K1Z9 and it FAILED, correctly: that number embeds the Sharma
    // Textiles PAN, so it was a real PAN hit and the test's premise was wrong,
    // not the matcher. A state code is not an identity; the ten characters
    // after it are.
    const m = matchParty({ gstin: "24ZZZZZ9999Z1Z9" }, ledgers);
    expect(m).toBeNull();
  });

  it("returns null when the document identifies nobody on file", () => {
    expect(matchParty({ name: "Completely Unrelated Vendor LLP" }, ledgers)).toBeNull();
    expect(matchParty({}, ledgers)).toBeNull();
    expect(matchParty({ gstin: "24AEMPB3576L1ZA" }, [])).toBeNull();
  });
});
