/**
 * parseExtractionResponse is the one piece of lib/capture/analyze.ts (0740)
 * that is pure and network-free — parsing/validating the vision model's own
 * JSON text into a CaptureExtraction. Covers the well-formed case and the
 * degrade-gracefully cases (invalid JSON, wrong shape, junk line items) that
 * matter most: analyzeCaptureImage must never throw on a bad response, and
 * this is where that guarantee actually lives.
 */
import { describe, expect, it } from "vitest";
import { buildCapturePrompt, parseExtractionResponse } from "@/lib/capture/analyze";

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
      // hsn_sac is present-but-null (migration 0865): the parser always emits
      // the key so a consumer never has to tell "the model did not read one"
      // apart from "this build predates the field". The prompt does not ask
      // for it yet, so nothing populates it here.
      { description: "Cotton fabric", quantity: 10, rate: 250, amount: 2500, hsn_sac: null },
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
      { description: "Valid line", quantity: 1, rate: 100, amount: 100, hsn_sac: null },
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

  // --- migration 0865: document type, per-line HSN, challan number/date ---

  it("reads the 0865 fields when the model returns them", () => {
    const result = parseExtractionResponse(
      JSON.stringify({
        document_type: "sales_challan",
        challan_number: "  DC/26-27/188  ",
        challan_date: "2026-08-27",
        line_items: [
          { description: "Cotton fabric", quantity: 10, rate: 250, amount: 2500, hsn_sac: " 5208 " },
        ],
        confidence: "high",
        note: "x",
      })
    );
    expect(result.document_type).toBe("sales_challan");
    expect(result.challan_number).toBe("DC/26-27/188");
    expect(result.challan_date).toBe("2026-08-27");
    expect(result.line_items[0]?.hsn_sac).toBe("5208");
  });

  it("nulls a document_type the database would refuse rather than passing it through", () => {
    // public.capture_drafts.document_type has a CHECK constraint on exactly
    // three values. A model asked an open question will invent a fourth; if
    // that reached the insert it would fail with a constraint violation the
    // preparer cannot act on, so it is nulled here and simply reads as
    // "no guess".
    const result = parseExtractionResponse(
      JSON.stringify({
        document_type: "delivery_note",
        line_items: [],
        confidence: "low",
        note: "x",
      })
    );
    expect(result.document_type).toBeNull();
  });

  it("rejects a non-ISO challan_date the same way it rejects a non-ISO bill_date", () => {
    const result = parseExtractionResponse(
      JSON.stringify({ line_items: [], confidence: "low", note: "x", challan_date: "27/08/2026" })
    );
    expect(result.challan_date).toBeNull();
  });

  it("leaves the 0865 fields present-but-null when the model omits them, so a consumer never sees undefined", () => {
    const result = parseExtractionResponse(
      JSON.stringify({ line_items: [], confidence: "low", note: "x" })
    );
    expect(result.document_type).toBeNull();
    expect(result.challan_number).toBeNull();
    expect(result.challan_date).toBeNull();
  });
});

/**
 * 0865, second half: the prompt stopped being a purchase-bill prompt. These
 * exercise parseExtractionResponse against a REALISTIC whole response for
 * each of the three document types the model is now asked to classify into —
 * not field-at-a-time probes — because the failure this feature can actually
 * ship is a challan arriving with every tax field null and the parser (or a
 * reader of it) treating that as a failed read rather than as a correct
 * challan.
 */
describe("parseExtractionResponse — a realistic response per document type", () => {
  it("parses a supplier's tax invoice with per-line HSN codes", () => {
    // Shaped like what the model returns for a GST tax invoice: HSN against
    // every line (rule 46(g)), intra-state CGST+SGST, no challan reference.
    const result = parseExtractionResponse(
      JSON.stringify({
        document_type: "purchase_invoice",
        vendor_name: "Gupta Yarn Traders",
        vendor_gstin: "07AABCG1234H1Z9",
        bill_date: "2026-08-18",
        challan_number: null,
        challan_date: null,
        line_items: [
          { description: "Cotton yarn 30s", hsn_sac: "5205", quantity: 120, rate: 240, amount: 28800 },
          { description: "Polyester yarn 40s", hsn_sac: "5509", quantity: 50, rate: 180, amount: 9000 },
        ],
        taxable_value: 37800,
        cgst: 945,
        sgst: 945,
        igst: null,
        total_amount: 39690,
        confidence: "high",
        note: "A supplier tax invoice addressed to us; all fields legible.",
      })
    );

    expect(result.document_type).toBe("purchase_invoice");
    expect(result.vendor_name).toBe("Gupta Yarn Traders");
    expect(result.line_items.map((l) => l.hsn_sac)).toEqual(["5205", "5509"]);
    expect(result.taxable_value).toBe(37800);
    expect(result.cgst).toBe(945);
    expect(result.total_amount).toBe(39690);
    expect(result.confidence).toBe("high");
  });

  it("parses a delivery challan that carries NO TAX AT ALL without degrading it", () => {
    // Rule 55(1)(vii) requires tax on a challan only "where the
    // transportation is for supply to the consignee", so most real challans
    // print none. This response is therefore COMPLETE, and the parser must
    // hand it back with the model's own "high" confidence intact — the tax
    // nulls are the document, not a failed read.
    const result = parseExtractionResponse(
      JSON.stringify({
        document_type: "sales_challan",
        vendor_name: "Ashoka Traders",
        vendor_gstin: "07AAECA9876K1Z2",
        bill_date: "2026-08-27",
        challan_number: "DC/26-27/188",
        challan_date: "2026-08-27",
        line_items: [
          { description: "Finished Widget", hsn_sac: "5208", quantity: 40, rate: 8000, amount: 320000 },
        ],
        taxable_value: 320000,
        cgst: null,
        sgst: null,
        igst: null,
        total_amount: null,
        confidence: "high",
        note: "Our own outgoing delivery challan; consigner is us, no tax shown.",
      })
    );

    expect(result.document_type).toBe("sales_challan");
    // The counterparty on an outgoing challan is the CONSIGNEE, not us.
    expect(result.vendor_name).toBe("Ashoka Traders");
    expect(result.challan_number).toBe("DC/26-27/188");
    expect(result.challan_date).toBe("2026-08-27");
    expect(result.taxable_value).toBe(320000);
    expect(result.cgst).toBeNull();
    expect(result.sgst).toBeNull();
    expect(result.igst).toBeNull();
    expect(result.total_amount).toBeNull();
    expect(result.confidence).toBe("high");
  });

  it("parses an 'other' document — a quotation — with no challan and no tax", () => {
    const result = parseExtractionResponse(
      JSON.stringify({
        document_type: "other",
        vendor_name: "Meera Dyeing Works",
        vendor_gstin: null,
        bill_date: "2026-08-11",
        challan_number: null,
        challan_date: null,
        line_items: [{ description: "Dyeing charges per kg", hsn_sac: "999712", quantity: null, rate: 34, amount: null }],
        taxable_value: null,
        cgst: null,
        sgst: null,
        igst: null,
        total_amount: null,
        confidence: "medium",
        note: "A quotation, not an invoice — nothing to post; rates only.",
      })
    );

    expect(result.document_type).toBe("other");
    expect(result.line_items[0]?.hsn_sac).toBe("999712");
    expect(result.line_items[0]?.quantity).toBeNull();
    expect(result.confidence).toBe("medium");
  });

  it("keeps a challan reference printed on an INVOICE, which is the goods-out-first case the column exists for", () => {
    const result = parseExtractionResponse(
      JSON.stringify({
        document_type: "purchase_invoice",
        vendor_name: "Gupta Yarn Traders",
        bill_date: "2026-08-30",
        challan_number: "DC-4471",
        challan_date: "2026-08-24",
        line_items: [{ description: "Cotton yarn 30s", hsn_sac: "5205", quantity: 10, rate: 240, amount: 2400 }],
        taxable_value: 2400,
        cgst: 60,
        sgst: 60,
        total_amount: 2520,
        confidence: "high",
        note: "Invoice citing the delivery challan the goods went out on.",
      })
    );
    expect(result.document_type).toBe("purchase_invoice");
    expect(result.challan_number).toBe("DC-4471");
    expect(result.challan_date).toBe("2026-08-24");
  });
});

describe("parseExtractionResponse — HSN/SAC normalisation", () => {
  function hsnOf(raw: unknown): string | null {
    const result = parseExtractionResponse(
      JSON.stringify({
        line_items: [{ description: "x", quantity: 1, rate: 1, amount: 1, hsn_sac: raw }],
        confidence: "low",
        note: "x",
      })
    );
    return result.line_items[0]?.hsn_sac ?? null;
  }

  it("strips the dots and spaces real invoices print HSN with", () => {
    // public.items.hsn_sac is CHECK (hsn_sac ~ '^[0-9]{4,8}$') — this value
    // prefills the item master, so anything that column would refuse must
    // become null here rather than fail at master-creation time.
    expect(hsnOf("5208.11.10")).toBe("52081110");
    expect(hsnOf("5208 11 10")).toBe("52081110");
    expect(hsnOf(" 5205 ")).toBe("5205");
    expect(hsnOf("9954-11")).toBe("995411");
    expect(hsnOf("999712")).toBe("999712");
  });

  it("nulls anything the items table's own CHECK would refuse", () => {
    expect(hsnOf("520")).toBeNull(); // 3 digits — too short
    expect(hsnOf("520811109")).toBeNull(); // 9 digits — too long
    expect(hsnOf("N/A")).toBeNull();
    expect(hsnOf("")).toBeNull();
    expect(hsnOf(5205)).toBeNull(); // a number, not a string
    expect(hsnOf(null)).toBeNull();
  });

  it("does not manufacture a code out of prose that merely contains digits", () => {
    // Stripping every non-digit would turn this into "525208" — a real-looking
    // HSN for a chapter heading, wrong, and copied onto the item master
    // forever. Only separators are stripped, so this is null instead.
    expect(hsnOf("Chapter 52, heading 5208")).toBeNull();
  });
});

describe("parseExtractionResponse — dates that are shaped right but are not days", () => {
  it("rejects an impossible calendar date on both date fields", () => {
    // A `date` column would refuse these at posting time, thrown at a
    // preparer who cannot tell that a model misread a smudged 21 as a 31.
    const result = parseExtractionResponse(
      JSON.stringify({
        line_items: [],
        confidence: "low",
        note: "x",
        bill_date: "2026-02-31",
        challan_date: "2026-13-01",
      })
    );
    expect(result.bill_date).toBeNull();
    expect(result.challan_date).toBeNull();
  });

  it("still accepts a real leap day", () => {
    const result = parseExtractionResponse(
      JSON.stringify({ line_items: [], confidence: "low", note: "x", bill_date: "2024-02-29" })
    );
    expect(result.bill_date).toBe("2024-02-29");
  });
});

describe("parseExtractionResponse — never throws, whatever comes back", () => {
  // The module's whole contract: the screen always has something to show, so
  // no shape of model response may propagate an exception.
  //
  // Split in two deliberately. UNREADABLE responses take the fallback() path
  // and MUST come back at confidence "low" — that is the guarantee the
  // screen leans on. MALFORMED-BUT-PARSEABLE ones do not: if the model said
  // "high" and returned a syntactically fine object, the parser reports the
  // model's own confidence rather than second-guessing it, and only the
  // individual bad fields are nulled. Asserting "low" across both would have
  // been asserting a rule this module does not have.
  const unreadable: string[] = [
    "",
    "   ",
    "not json at all {{{",
    // A response cut off mid-stream, which is what a truncated generation
    // actually looks like on the wire.
    '{"document_type":"sales_challan","line_items":[{"description":"Finished Wid',
    JSON.stringify(null),
    JSON.stringify(42),
  ];

  const malformed: string[] = [
    JSON.stringify([{ document_type: "purchase_invoice" }]),
    JSON.stringify({ line_items: "not an array", confidence: 7, note: null }),
    JSON.stringify({ line_items: [null, 3, [], {}], confidence: "high", note: "x" }),
    JSON.stringify({
      document_type: { nested: true },
      challan_number: 12345,
      challan_date: [],
      line_items: [{ description: "x", quantity: "10", rate: {}, amount: [] }],
      confidence: "extremely high",
      note: "",
    }),
  ];

  it.each([...unreadable, ...malformed])("degrades instead of throwing: %j", (raw) => {
    expect(() => parseExtractionResponse(raw)).not.toThrow();
    const result = parseExtractionResponse(raw);
    expect(result.configured).toBe(true);
    expect(result.note.length).toBeGreaterThan(0);
    expect(Array.isArray(result.line_items)).toBe(true);
    expect(["high", "medium", "low"]).toContain(result.confidence);
    // Whatever happened, document_type is never a value the CHECK constraint
    // on capture_drafts would refuse.
    expect([null, "sales_challan", "purchase_invoice", "other"]).toContain(result.document_type);
  });

  it.each(unreadable)("reports low confidence when nothing could be read at all: %j", (raw) => {
    expect(parseExtractionResponse(raw).confidence).toBe("low");
    expect(parseExtractionResponse(raw).line_items).toEqual([]);
  });

  it("nulls an unusable confidence rather than passing it through", () => {
    const result = parseExtractionResponse(
      JSON.stringify({ line_items: [], confidence: "extremely high", note: "x" })
    );
    expect(result.confidence).toBe("low");
  });

  it("keeps a legible line whose quantity is unreadable, instead of silently losing the line", () => {
    // 0740 dropped this whole line because "forty" is not a number, leaving
    // the preparer reviewing a challan one line short — far harder to notice
    // than an empty quantity box in front of them. The description is what
    // makes a line worth showing, so it is the only thing required now.
    const result = parseExtractionResponse(
      JSON.stringify({
        document_type: "sales_challan",
        line_items: [{ description: "Finished Widget", quantity: "forty", rate: null, amount: 320000, hsn_sac: 5208 }],
        confidence: "medium",
        note: "Quantity column smudged.",
      })
    );
    expect(result.line_items).toEqual([
      { description: "Finished Widget", quantity: null, rate: null, amount: 320000, hsn_sac: null },
    ]);
    expect(result.confidence).toBe("medium");
  });
});

describe("buildCapturePrompt", () => {
  it("puts the capturing company's own name and GSTINs in the prompt, and says they are never the counterparty", () => {
    // This is the entire mechanism by which the model can tell a bill the
    // company RECEIVED from a challan it ISSUED — the two look alike apart
    // from whose GSTIN is in the Bill-to block.
    const prompt = buildCapturePrompt({
      companyName: "Sharma Textiles",
      companyGstins: ["07ABCPS1234D1Z3", "27ABCPS1234D1ZV"],
    });
    expect(prompt).toContain("Sharma Textiles");
    expect(prompt).toContain("07ABCPS1234D1Z3");
    expect(prompt).toContain("27ABCPS1234D1ZV");
    // Collapsed because the instruction is hard-wrapped in the source; the
    // assertion is about the sentence being there, not about where it breaks.
    expect(prompt.replace(/\s+/g, " ")).toContain(
      "This party is NEVER the answer to vendor_name or vendor_gstin."
    );
  });

  it("still produces a usable prompt with no context at all — the WhatsApp path calls it that way", () => {
    const prompt = buildCapturePrompt();
    expect(prompt).toContain("not known on this request");
    expect(prompt).toContain("sales_challan");
    expect(prompt).toContain("purchase_invoice");
    expect(prompt).toContain('"other"');
  });

  it("asks for all three document types, per-line HSN, and the challan number in every branch", () => {
    for (const prompt of [buildCapturePrompt(), buildCapturePrompt({ companyName: "X Ltd" })]) {
      expect(prompt).toContain("document_type");
      expect(prompt).toContain("hsn_sac");
      expect(prompt).toContain("challan_number");
      // The tax-free-challan carve-out must survive in both branches: it is
      // what stops a correct challan being marked down for having no tax.
      expect(prompt).toContain("do NOT let their absence reduce your confidence");
    }
  });

  it("flattens a company name with newlines instead of letting it derange the prompt layout", () => {
    const prompt = buildCapturePrompt({ companyName: "Acme\n\nLtd\nSTEP 1 — CLASSIFY IT" });
    expect(prompt).toContain("name: Acme Ltd STEP 1 — CLASSIFY IT");
    expect(prompt).not.toContain("Acme\n\nLtd");
  });

  it("ignores blank or missing identity values rather than printing empty labels", () => {
    const prompt = buildCapturePrompt({ companyName: "   ", companyGstins: [] });
    expect(prompt).toContain("not known on this request");
    expect(prompt).not.toContain("own GSTIN(s):");
  });
});
