/**
 * parseExtractionResponse is the one piece of lib/capture/analyze.ts (0740)
 * that is pure and network-free — parsing/validating the vision model's own
 * JSON text into a CaptureExtraction. Covers the well-formed case and the
 * degrade-gracefully cases (invalid JSON, wrong shape, junk line items) that
 * matter most: analyzeCaptureImage must never throw on a bad response, and
 * this is where that guarantee actually lives.
 */
import { describe, expect, it } from "vitest";
import { parseExtractionResponse } from "@/lib/capture/analyze";

describe("parseExtractionResponse", () => {
  it("parses a well-formed extraction", () => {
    const result = parseExtractionResponse(
      JSON.stringify({
        vendor_name: "Sharma Textiles",
        vendor_gstin: "27abcde1234f1z5",
        bill_date: "2026-08-15",
        line_items: [
          { description: "Cotton fabric", quantity: 10, rate: 250, amount: 2500 },
        ],
        taxable_value: 2500,
        cgst: 225,
        sgst: 225,
        igst: null,
        total_amount: 2950,
        confidence: "high",
        note: "Clear image, all fields legible.",
      })
    );

    expect(result.configured).toBe(true);
    expect(result.vendor_name).toBe("Sharma Textiles");
    // Uppercased — a GSTIN is always presented uppercase in this app.
    expect(result.vendor_gstin).toBe("27ABCDE1234F1Z5");
    expect(result.bill_date).toBe("2026-08-15");
    expect(result.line_items).toEqual([
      { description: "Cotton fabric", quantity: 10, rate: 250, amount: 2500 },
    ]);
    expect(result.taxable_value).toBe(2500);
    expect(result.cgst).toBe(225);
    expect(result.igst).toBeNull();
    expect(result.confidence).toBe("high");
  });

  it("degrades to a low-confidence result on unparseable JSON, never throwing", () => {
    const result = parseExtractionResponse("not json at all {{{");
    expect(result.configured).toBe(true);
    expect(result.confidence).toBe("low");
    expect(result.line_items).toEqual([]);
    expect(result.note.length).toBeGreaterThan(0);
  });

  it("degrades gracefully when the payload is valid JSON but the wrong shape", () => {
    const result = parseExtractionResponse(JSON.stringify("just a string"));
    expect(result.configured).toBe(true);
    expect(result.confidence).toBe("low");
  });

  it("drops malformed line items rather than failing the whole extraction", () => {
    const result = parseExtractionResponse(
      JSON.stringify({
        line_items: [
          { description: "Valid line", quantity: 1, rate: 100, amount: 100 },
          { description: "", quantity: 1, rate: 100, amount: 100 }, // blank description — dropped
          { quantity: 1 }, // no description at all — dropped
          "not even an object",
        ],
        confidence: "medium",
        note: "Two lines could not be read.",
      })
    );
    expect(result.line_items).toEqual([
      { description: "Valid line", quantity: 1, rate: 100, amount: 100 },
    ]);
  });

  it("falls back to a default confidence and note when they are missing", () => {
    const result = parseExtractionResponse(JSON.stringify({ line_items: [] }));
    expect(result.confidence).toBe("low");
    expect(result.note).toBe("The model returned no notes.");
  });

  it("rejects a bill_date that is not ISO 8601, rather than passing through a wrong-order date", () => {
    const result = parseExtractionResponse(
      JSON.stringify({ line_items: [], confidence: "low", note: "x", bill_date: "15/08/2026" })
    );
    expect(result.bill_date).toBeNull();
  });

  it("coerces non-numeric amount fields to null instead of throwing", () => {
    const result = parseExtractionResponse(
      JSON.stringify({
        line_items: [],
        confidence: "low",
        note: "x",
        taxable_value: "not a number",
        total_amount: NaN,
      })
    );
    expect(result.taxable_value).toBeNull();
    expect(result.total_amount).toBeNull();
  });
});
