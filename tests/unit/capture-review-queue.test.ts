import { describe, expect, it } from "vitest";
import {
  DOC_TYPES,
  asExtraction,
  docConfig,
  documentKind,
  fileNameOf,
  isDocumentType,
  isDraftStatus,
  normalizeQueue,
  normalizeQueueRow,
  queueRowTitle,
} from "@/components/capture/reviewModel";

/**
 * Regression tests for the capture review inbox's own logic.
 *
 * This project's vitest environment is "node" with no jsdom and no testing
 * library, so the components themselves cannot be rendered here. Everything
 * worth guarding therefore lives in components/capture/reviewModel.ts, and
 * these are the four things that would actually cost money or trust if they
 * broke:
 *
 *   1. The document-type -> voucher-type mapping, which must keep agreeing
 *      with app_private.enforce_capture_draft. A disagreement is not a
 *      cosmetic bug: create_invoice succeeds, then the confirming UPDATE is
 *      refused, and the books hold a voucher no draft points at.
 *   2. normalizeQueueRow against the real get_capture_review_queue (0870)
 *      column names, since the screen and that RPC were written in parallel.
 *   3. asExtraction's "{} is not an extraction" rule, which is what decides
 *      whether the vision model is called again.
 *   4. The arrived-between range is NOT tested here any more: 0871 moved it
 *      into get_capture_review_queue, where the day boundary is Asia/Kolkata
 *      rather than whatever the browser's timezone happens to be. It is
 *      covered by a live boundary probe against the real function instead.
 */

/** A row shaped exactly as public.get_capture_review_queue returns one. */
function rpcRow(over: Record<string, unknown> = {}) {
  return {
    id: "d-1",
    draft_id: "d-1",
    company_id: "c-1",
    branch_id: "b-1",
    source: "upload",
    document_type: "purchase_invoice",
    status: "pending_review",
    stage: "pending_review",
    page_count: 3,
    storage_path: "c-1/capture/d-1/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d-bill.jpg",
    vendor_hint: "Verma Supplies",
    note: "second page is the annexure",
    captured_by: "u-9",
    captured_by_name: "Ramesh at the counter",
    captured_by_email: "ramesh@shop.test",
    submitted_at: "2026-08-29T11:00:00+00:00",
    created_at: "2026-08-29T10:00:00+00:00",
    extracted_at: null,
    has_extraction: false,
    rejected_reason: null,
    rejected_at: null,
    confirmed_voucher_id: null,
    is_possible_duplicate: false,
    duplicate_of_draft_id: null,
    ...over,
  };
}

describe("document type -> voucher type", () => {
  it("mirrors app_private.enforce_capture_draft's CASE exactly", () => {
    // 0865: 'sales_challan' -> 'sales', 'purchase_invoice' -> 'purchase',
    // 'other' -> refused against a voucher of ANY type.
    expect(docConfig("sales_challan").voucherType).toBe("sales");
    expect(docConfig("purchase_invoice").voucherType).toBe("purchase");
    expect(docConfig("other").voucherType).toBeNull();
  });

  it("covers exactly the three values the column's CHECK constraint allows", () => {
    expect(DOC_TYPES.map((d) => d.value).sort()).toEqual([
      "other",
      "purchase_invoice",
      "sales_challan",
    ]);
    expect(isDocumentType("sales_challan")).toBe(true);
    expect(isDocumentType("sales_invoice")).toBe(false);
    expect(isDocumentType(null)).toBe(false);
  });

  it("puts a sale's party on receivables and a purchase's on payables", () => {
    // A sales challan billed to a supplier ledger would post a sale against a
    // creditor — the mis-posting this split exists to prevent.
    expect(docConfig("sales_challan").partyRoles).toContain("debtor");
    expect(docConfig("sales_challan").partyRoles).not.toContain("creditor");
    expect(docConfig("purchase_invoice").partyRoles).toContain("creditor");
    expect(docConfig("purchase_invoice").partyRoles).not.toContain("debtor");
  });

  it("credits a sale to income and debits a purchase to an expense role", () => {
    expect(docConfig("sales_challan").tradingRoles).toContain("income");
    expect(docConfig("purchase_invoice").tradingRoles).not.toContain("income");
  });

  it("falls back to the purchase invoice for an unknown value", () => {
    expect(docConfig(undefined).value).toBe("purchase_invoice");
  });
});

describe("normalizeQueueRow", () => {
  it("reads a real get_capture_review_queue row", () => {
    const row = normalizeQueueRow(rpcRow())!;
    expect(row.id).toBe("d-1");
    expect(row.documentType).toBe("purchase_invoice");
    expect(row.status).toBe("pending_review");
    expect(row.pageCount).toBe(3);
    expect(row.capturedById).toBe("u-9");
    expect(row.capturedByLabel).toBe("Ramesh at the counter");
    expect(row.vendorHint).toBe("Verma Supplies");
    expect(row.note).toBe("second page is the annexure");
    expect(row.isDuplicate).toBe(false);
    expect(row.hasExtraction).toBe(false);
    // submitted_at wins over created_at: it is when the phone let go of it.
    expect(row.arrivedAt).toBe("2026-08-29T11:00:00+00:00");
  });

  it("falls back to the email when nobody set a display name", () => {
    const row = normalizeQueueRow(rpcRow({ captured_by_name: null }))!;
    expect(row.capturedByLabel).toBe("ramesh@shop.test");
  });

  it("leaves the sender null rather than inventing one", () => {
    const row = normalizeQueueRow(rpcRow({ captured_by_name: null, captured_by_email: null }))!;
    expect(row.capturedByLabel).toBeNull();
  });

  it("counts a pre-0870 draft with no page rows as the one page it has", () => {
    const row = normalizeQueueRow(rpcRow({ page_count: 0 }))!;
    expect(row.pageCount).toBe(1);
  });

  it("counts zero pages when there is genuinely no file either", () => {
    const row = normalizeQueueRow(rpcRow({ page_count: 0, storage_path: null }))!;
    expect(row.pageCount).toBe(0);
  });

  it("flags a duplicate from the boolean and from the pointer alone", () => {
    expect(normalizeQueueRow(rpcRow({ is_possible_duplicate: true }))!.isDuplicate).toBe(true);
    expect(
      normalizeQueueRow(rpcRow({ is_possible_duplicate: null, duplicate_of_draft_id: "d-7" }))!
        .isDuplicate
    ).toBe(true);
  });

  it("treats an unknown document type or status as the safe value", () => {
    // 'other' posts nothing and 'pending_review' is not terminal — an
    // unrecognised value must never become something postable or closed.
    const row = normalizeQueueRow(rpcRow({ document_type: "sales_invoice", status: "filed" }))!;
    expect(row.documentType).toBe("other");
    expect(row.status).toBe("pending_review");
  });

  it("drops a row with no id rather than rendering an unusable one", () => {
    expect(normalizeQueueRow({ status: "pending_review" })).toBeNull();
    expect(normalizeQueue([rpcRow(), { status: "pending_review" }, null, 7])).toHaveLength(1);
  });

  it("returns an empty list for a failed or missing RPC result", () => {
    expect(normalizeQueue(null)).toEqual([]);
    expect(normalizeQueue(undefined)).toEqual([]);
  });

  it("survives the RPC naming the id column draft_id only", () => {
    const raw = rpcRow();
    delete (raw as Record<string, unknown>).id;
    expect(normalizeQueueRow(raw)!.id).toBe("d-1");
  });
});

describe("asExtraction", () => {
  it("accepts a real extraction, including one that read no lines", () => {
    expect(asExtraction({ line_items: [], confidence: "low", note: "blurry" })).not.toBeNull();
  });

  it("rejects an empty object — that is 'not read yet', not 'read nothing'", () => {
    // The difference decides whether a vision call is spent.
    expect(asExtraction({})).toBeNull();
    expect(asExtraction(null)).toBeNull();
    expect(asExtraction("{}")).toBeNull();
    expect(asExtraction([])).toBeNull();
  });

  it("drives hasExtraction when the RPC did not say", () => {
    const row = normalizeQueueRow(
      rpcRow({ has_extraction: null, extracted_json: { line_items: [] } })
    )!;
    expect(row.hasExtraction).toBe(true);
  });
});

describe("viewer helpers", () => {
  it("tells a PDF from a photograph by extension", () => {
    expect(documentKind("c-1/capture/x.pdf")).toBe("pdf");
    expect(documentKind("c-1/capture/x.PDF")).toBe("pdf");
    expect(documentKind("c-1/capture/x.jpg")).toBe("image");
    // A wrong guess only ever picks the download link over an <img>.
    expect(documentKind(null)).toBe("image");
  });

  it("strips the uuid both upload paths prefix onto the filename", () => {
    expect(fileNameOf("c-1/capture/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d-bill.jpg")).toBe(
      "bill.jpg"
    );
    expect(fileNameOf("c-1/capture/plain.jpg")).toBe("plain.jpg");
    expect(fileNameOf(null)).toBe("document");
  });
});

describe("queueRowTitle", () => {
  const base = normalizeQueueRow(rpcRow())!;

  it("prefers what the model read over what the sender typed", () => {
    expect(
      queueRowTitle({
        ...base,
        extraction: asExtraction({ line_items: [], vendor_name: "Verma Industrial Supplies" }),
      })
    ).toBe("Verma Industrial Supplies");
  });

  it("falls back to the sender's own hint, then their note", () => {
    expect(queueRowTitle(base)).toBe("Verma Supplies");
    expect(queueRowTitle({ ...base, vendorHint: null })).toBe("second page is the annexure");
  });

  it("falls back to the stored filename, which is often the most telling thing", () => {
    // Caught against the LIVE queue: the seeded rows carry no hint and no
    // note, but are stored as "challan-DC-26-27-207.jpg".
    expect(queueRowTitle({ ...base, vendorHint: null, note: null })).toBe("bill.jpg");
  });

  it("never claims an already-read document has not been read", () => {
    // get_capture_review_queue returns has_extraction but NOT the extraction,
    // so without this guard every read row in the list said "Not yet read".
    const bare = { ...base, vendorHint: null, note: null, storagePath: null };
    expect(queueRowTitle({ ...bare, hasExtraction: true })).toBe(
      "Read — open to see the details"
    );
    expect(queueRowTitle({ ...bare, hasExtraction: false })).toBe("Not yet read");
  });
});

describe("status guards", () => {
  it("accepts only the three values the column's CHECK allows", () => {
    expect(isDraftStatus("pending_review")).toBe(true);
    expect(isDraftStatus("confirmed")).toBe(true);
    expect(isDraftStatus("rejected")).toBe(true);
    // 'filed' was considered and rejected by 0865 — it must not creep back in
    // through a URL.
    expect(isDraftStatus("filed")).toBe(false);
    expect(isDraftStatus("")).toBe(false);
  });
});
