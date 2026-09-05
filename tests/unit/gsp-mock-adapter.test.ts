/**
 * lib/gsp/mockAdapter.ts — the deterministic, zero-network GspAdapter used
 * for local development and tests until a real GSP is chosen (see
 * lib/gsp/types.ts's header). Covers all three GspAdapter operations: a
 * successful call returns the shape the interface promises, and the fields
 * that must satisfy an existing DB CHECK constraint (irn, ackNumber,
 * ewbNumber) actually do — a mock whose fake IRN could never be saved to
 * einvoice_details would be worse than no mock at all. Also covers each
 * method's empty-payload error path and the same-payload determinism the
 * adapter's own header promises.
 */
import { describe, expect, it } from "vitest";
import { mockGspAdapter } from "@/lib/gsp/mockAdapter";
import { getGspAdapter, isGspError } from "@/lib/gsp";

const EINVOICE_PAYLOAD = {
  Version: "1.1",
  TranDtls: { TaxSch: "GST", SupTyp: "B2B" },
  DocDtls: { Typ: "INV", No: "SAL/26-27/0001", Dt: "01/09/2026" },
  SellerDtls: { Gstin: "27AAAAA0000A1Z5", LglNm: "Test Seller" },
  BuyerDtls: { Gstin: "29BBBBB0000B1Z1", LglNm: "Test Buyer" },
  ItemList: [{ SlNo: "1", HsnCd: "998314", Qty: 1, UnitPrice: 1000, TotAmt: 1000 }],
};

const EWB_PAYLOAD = {
  supplyType: "O",
  transDetails: { transMode: "1", transDistance: "120" },
  itemList: [{ hsnCode: "998314", taxableAmount: 1000 }],
};

// Same shape lib/gsp/types.ts's own GstReturnFilingPayload documents.
const GSTR1_PAYLOAD = { formCode: "GSTR-1", periodLabel: "Apr-2026", data: { b2b: [] } };

describe("mockGspAdapter.providerName", () => {
  it("names itself as a mock so a caller/log can never mistake it for a real GSP", () => {
    expect(mockGspAdapter.providerName.toLowerCase()).toContain("mock");
  });
});

describe("mockGspAdapter.submitEinvoice", () => {
  it("returns an IRN/ackNumber shaped exactly like einvoice_details' own CHECK constraints (0230)", async () => {
    const result = await mockGspAdapter.submitEinvoice(EINVOICE_PAYLOAD);
    expect(isGspError(result)).toBe(false);
    if (isGspError(result)) return; // narrows for TS below
    expect(result.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ackNumber).toMatch(/^[0-9]{1,20}$/);
    expect(typeof result.signedQrPayload).toBe("string");
    expect(result.signedQrPayload.trim().length).toBeGreaterThan(0);
    expect(() => new Date(result.ackDate).toISOString()).not.toThrow();
  });

  it("is deterministic — the same payload always produces the same fake IRN", async () => {
    const first = await mockGspAdapter.submitEinvoice(EINVOICE_PAYLOAD);
    const second = await mockGspAdapter.submitEinvoice({ ...EINVOICE_PAYLOAD });
    if (isGspError(first) || isGspError(second)) throw new Error("expected both calls to succeed");
    expect(second.irn).toBe(first.irn);
    expect(second.ackNumber).toBe(first.ackNumber);
  });

  it("produces a different IRN for a different payload — not a constant stub", async () => {
    const a = await mockGspAdapter.submitEinvoice(EINVOICE_PAYLOAD);
    const b = await mockGspAdapter.submitEinvoice({ ...EINVOICE_PAYLOAD, DocDtls: { ...EINVOICE_PAYLOAD.DocDtls, No: "SAL/26-27/0002" } });
    if (isGspError(a) || isGspError(b)) throw new Error("expected both calls to succeed");
    expect(a.irn).not.toBe(b.irn);
  });

  it("refuses an empty payload instead of fabricating an IRN for nothing", async () => {
    const result = await mockGspAdapter.submitEinvoice({});
    expect(isGspError(result)).toBe(true);
    if (!isGspError(result)) throw new Error("expected an error result");
    expect(result.error).toMatch(/empty/i);
  });
});

describe("mockGspAdapter.submitEwayBill", () => {
  it("returns an ewbNumber shaped exactly like ewb_details' own CHECK constraint (0190), with a validity window", async () => {
    const result = await mockGspAdapter.submitEwayBill(EWB_PAYLOAD);
    expect(isGspError(result)).toBe(false);
    if (isGspError(result)) return;
    expect(result.ewbNumber).toMatch(/^[0-9]{12}$/);
    const generated = new Date(result.ewbGeneratedDate);
    const validUntil = new Date(result.ewbValidUntil);
    expect(Number.isNaN(generated.getTime())).toBe(false);
    // ewb_details' own CHECK constraint (0190) requires valid_until >=
    // generated_date whenever both are present — the mock must not violate
    // the very constraint a caller would later save it against.
    expect(validUntil.getTime()).toBeGreaterThanOrEqual(generated.getTime());
  });

  it("is deterministic per payload, like submitEinvoice", async () => {
    const first = await mockGspAdapter.submitEwayBill(EWB_PAYLOAD);
    const second = await mockGspAdapter.submitEwayBill({ ...EWB_PAYLOAD });
    if (isGspError(first) || isGspError(second)) throw new Error("expected both calls to succeed");
    expect(second.ewbNumber).toBe(first.ewbNumber);
  });

  it("refuses an empty payload", async () => {
    const result = await mockGspAdapter.submitEwayBill({});
    expect(isGspError(result)).toBe(true);
  });
});

describe("mockGspAdapter.fileGstReturn", () => {
  it("returns an acknowledgementNumber and a filedDate (date-only, per filing_register.filed_date)", async () => {
    const result = await mockGspAdapter.fileGstReturn(GSTR1_PAYLOAD);
    expect(isGspError(result)).toBe(false);
    if (isGspError(result)) return;
    expect(result.acknowledgementNumber.length).toBeGreaterThan(0);
    expect(result.filedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses a payload missing formCode or periodLabel", async () => {
    const missingForm = await mockGspAdapter.fileGstReturn({ formCode: "", periodLabel: "Apr-2026", data: {} });
    const missingPeriod = await mockGspAdapter.fileGstReturn({ formCode: "GSTR-3B", periodLabel: "", data: {} });
    expect(isGspError(missingForm)).toBe(true);
    expect(isGspError(missingPeriod)).toBe(true);
  });
});

describe("getGspAdapter", () => {
  it("defaults to the mock adapter, since no real GSP is configured yet", () => {
    expect(getGspAdapter()).toBe(mockGspAdapter);
  });
});
