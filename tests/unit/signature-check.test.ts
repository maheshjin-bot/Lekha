/**
 * lib/pdf/signature-check.ts's structural PDF-signature-presence check.
 *
 * These vectors are the regression fence for two real bugs an early draft
 * of this file shipped with, both caught by exactly this kind of synthetic
 * PDF construction before the migration/RPC layer ever saw a real upload:
 *   1. /ByteRange's four integers are [offset1 length1 offset2 length2],
 *      not [start1 end1 start2 end2] — an earlier draft read them as the
 *      latter, so every genuinely whole-file-covering signature was
 *      reported as NOT covering the whole file.
 *   2. /SubFilter can legally appear BEFORE /ByteRange in the same
 *      dictionary (PDF key order is unspecified) — an earlier draft only
 *      searched forward from the ByteRange match, so a well-formed
 *      signature dictionary with /SubFilter first came back with an empty
 *      subFilters list.
 * Both are exercised below (case "well-formed…") so neither regresses.
 */
import { describe, expect, it } from "vitest";
import { checkPdfSignaturePresence } from "@/lib/pdf/signature-check";

// DER encoding of the pkcs7-signedData content-type OID
// (1.2.840.113549.1.7.2), as a real PKCS#7 ContentInfo carries it.
const PKCS7_SIGNED_DATA_OID_HEX = "06092a864886f70d010702";

function buildSyntheticSignedPdf(): string {
  const der =
    "3082" + // SEQUENCE, long-form length (arbitrary placeholder length bytes below)
    "0100" +
    PKCS7_SIGNED_DATA_OID_HEX +
    "ff".repeat(50);
  const contentsHex = der.padEnd(4000, "0");
  const prefix = "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n";
  const contentsToken = `/Contents <${contentsHex}>`;
  // Fixed-width 6-digit placeholders so substituting in the real byte
  // offsets afterwards does not shift the string length out from under the
  // offsets that were computed against the placeholder version.
  const full = `${prefix}4 0 obj << /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [000000 111111 222222 333333] ${contentsToken} >> endobj\n%%EOF`;

  const contentsStart = full.indexOf(contentsToken);
  const contentsEnd = contentsStart + contentsToken.length;
  const totalLen = full.length;
  const offset1 = 0;
  const length1 = contentsStart; // segment 1 = [0, contentsStart)
  const offset2 = contentsEnd; // segment 2 starts right after Contents closes
  const length2 = totalLen - contentsEnd; // ... and runs to end of file
  const pad = (n: number) => String(n).padStart(6, "0");

  return full
    .replace("000000", pad(offset1))
    .replace("111111", pad(length1))
    .replace("222222", pad(offset2))
    .replace("333333", pad(length2));
}

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes.buffer;
}

describe("checkPdfSignaturePresence", () => {
  it("finds a well-formed whole-file signature: SubFilter, PKCS7 shape, and byte-range coverage all correct", () => {
    const result = checkPdfSignaturePresence(toArrayBuffer(buildSyntheticSignedPdf()));
    expect(result.isPdf).toBe(true);
    expect(result.hasSignature).toBe(true);
    expect(result.signatureCount).toBe(1);
    expect(result.subFilters).toEqual(["adbe.pkcs7.detached"]);
    expect(result.looksLikePkcs7).toBe(true);
    expect(result.byteRangeCoversWholeFile).toBe(true);
  });

  it("rejects a non-PDF file outright", () => {
    const result = checkPdfSignaturePresence(toArrayBuffer("just some random text, not a pdf"));
    expect(result.isPdf).toBe(false);
    expect(result.hasSignature).toBe(false);
  });

  it("reports no signature on a plain, unsigned PDF", () => {
    const result = checkPdfSignaturePresence(
      toArrayBuffer("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF")
    );
    expect(result.isPdf).toBe(true);
    expect(result.hasSignature).toBe(false);
    expect(result.byteRangeCoversWholeFile).toBeNull();
  });

  it("flags content appended after signing (byte range no longer reaches EOF) and non-PKCS7 /Contents garbage", () => {
    const contentsToken = "/Contents <deadbeef00>";
    let text = `%PDF-1.7\n4 0 obj << /Type /Sig /ByteRange [0 40 60 5] ${contentsToken} >> endobj\n%%EOF`;
    text += "TRAILING_BYTES_APPENDED_AFTER_SIGNING";
    const result = checkPdfSignaturePresence(toArrayBuffer(text));
    expect(result.isPdf).toBe(true);
    expect(result.hasSignature).toBe(true);
    expect(result.byteRangeCoversWholeFile).toBe(false);
    expect(result.looksLikePkcs7).toBe(false);
  });

  it("never throws on garbage input", () => {
    expect(() => checkPdfSignaturePresence(toArrayBuffer(""))).not.toThrow();
    expect(() => checkPdfSignaturePresence(new Uint8Array([0, 1, 2, 255, 254]).buffer)).not.toThrow();
  });
});
