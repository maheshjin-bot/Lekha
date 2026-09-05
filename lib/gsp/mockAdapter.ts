import { createHash } from "node:crypto";
import type {
  EinvoicePayload,
  EinvoiceSubmitResult,
  EwayBillPayload,
  EwayBillSubmitResult,
  GspAdapter,
  GspResult,
  GstReturnFilingPayload,
  GstReturnFilingResult,
} from "./types";

/**
 * NOT FOR PRODUCTION. This is a deterministic, zero-network stand-in for a
 * real GspAdapter (lib/gsp/types.ts) — for local development and tests only,
 * until a GSP is actually chosen and a real adapter is written against the
 * same interface. Every IRN, e-Way Bill number and acknowledgement it hands
 * back is FAKE: none of it was ever seen by any government system, and none
 * of it will pass a real IRP/NIC/GST-portal validation.
 *
 * DETERMINISM. Every identifier is derived from a SHA-256 hash of the
 * payload rather than Math.random(), so calling this adapter twice with the
 * same (unchanged) payload returns the same fake IRN/EWB number/QR both
 * times — the property a test actually wants (reproducible assertions, no
 * flakiness) and, incidentally, the same real-world behaviour a live IRP
 * shows when the exact same document is resubmitted (it returns the
 * existing IRN rather than minting a new one for a duplicate). Timestamp
 * fields (ackDate, filedDate, ...) are real wall-clock time — a live
 * acknowledgement is stamped "now", and faking that too would make this
 * mock less representative of what a caller actually receives, not more.
 */

/** SHA-256 hex digest of the payload — 64 hex characters, which is
 * conveniently exactly the length a real IRN must be (see
 * einvoice_details.irn's CHECK constraint, 0230), so the e-invoice path
 * below uses this hash as the IRN outright rather than truncating it. */
function seedHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload) ?? "null").digest("hex");
}

/** `len` base-10 digits squeezed out of a hex hash, one nibble at a time.
 * Never round-trips the whole hash through parseInt/Number — that silently
 * overflows well before 20 hex characters, which is exactly the field this
 * feeds (ackNumber). Deterministic and pure: same hash, same digits. */
function digitsFrom(hash: string, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += String(parseInt(hash[i % hash.length], 16) % 10);
  }
  return out;
}

/** A plausible-SHAPED JWS token (header.payload.signature, base64url
 * segments) standing in for the IRP's real SignedQRCode — enough for
 * components/einvoice/EinvoiceQr.tsx to render *something* scannable in a
 * dev build, and enough to satisfy einvoice_details.signed_qr_payload's only
 * real constraint (non-empty after trim). The "signature" segment is not a
 * signature — it is the same hash everything else here is derived from,
 * clearly marked "mock" in the header so nobody mistakes this for a real
 * token if it ever leaks into a log. */
function mockSignedQr(hash: string, irn: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "MOCK", typ: "MOCK-JWS" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ irn, mock: true, note: "lib/gsp/mockAdapter.ts — not a real IRP signature" })).toString(
    "base64url"
  );
  return `${header}.${body}.${hash.slice(0, 43)}`;
}

function isEmptyPayload(payload: unknown): boolean {
  return payload == null || (typeof payload === "object" && Object.keys(payload as object).length === 0);
}

export const mockGspAdapter: GspAdapter = {
  providerName: "mock (local dev/test only — no GSP is configured; see lib/gsp/types.ts)",

  async submitEinvoice(payload: EinvoicePayload): Promise<GspResult<EinvoiceSubmitResult>> {
    if (isEmptyPayload(payload)) {
      return { error: "Mock GSP: empty e-invoice payload — nothing to submit. Build the JSON first." };
    }
    const hash = seedHash(payload);
    const irn = hash; // sha256 hex is exactly 64 chars — see seedHash's own comment
    return {
      irn,
      signedQrPayload: mockSignedQr(hash, irn),
      ackNumber: digitsFrom(hash, 15),
      ackDate: new Date().toISOString(),
    };
  },

  async submitEwayBill(payload: EwayBillPayload): Promise<GspResult<EwayBillSubmitResult>> {
    if (isEmptyPayload(payload)) {
      return { error: "Mock GSP: empty e-Way Bill payload — nothing to submit. Build the JSON first." };
    }
    const hash = seedHash(payload);
    const generated = new Date();
    // Real validity is distance/mode-dependent (CGST Rule 138(10)) — that
    // computation belongs to the GSP/NIC portal, not this mock. A flat
    // 1-day placeholder is deliberately not a real-rule approximation.
    const validUntil = new Date(generated.getTime() + 24 * 60 * 60 * 1000);
    return {
      ewbNumber: digitsFrom(hash, 12),
      ewbGeneratedDate: generated.toISOString(),
      ewbValidUntil: validUntil.toISOString(),
    };
  },

  async fileGstReturn(payload: GstReturnFilingPayload): Promise<GspResult<GstReturnFilingResult>> {
    if (!payload || !payload.formCode?.trim() || !payload.periodLabel?.trim()) {
      return { error: "Mock GSP: formCode and periodLabel are both required to file a return." };
    }
    const hash = seedHash(payload);
    return {
      // Deliberately not called ackNumber here — see lib/gsp/types.ts's
      // header on why a filed return is shaped like a filing_register row
      // (0095), not an e-invoice acknowledgement.
      acknowledgementNumber: `AA${digitsFrom(hash, 13)}A${digitsFrom(hash.slice(1), 1)}`,
      filedDate: new Date().toISOString().slice(0, 10), // filing_register.filed_date is a date, not a timestamp
    };
  },
};
