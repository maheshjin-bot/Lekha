/**
 * lib/pdf/signature-check.ts — best-effort OFFLINE structural check for
 * "does this PDF contain an embedded digital signature at all", run
 * client-side (in the browser, on the File object's own bytes) before a
 * signer's signed-back copy is uploaded and recorded against
 * public.record_signed_document. Built for 0175 (e-signature request
 * workflow) — see that migration's own header for the full picture of what
 * this app does and does not do around signatures.
 *
 * ==========================================================================
 * WHAT THIS CHECKS, AND — MORE IMPORTANTLY — WHAT IT DOES NOT. Read this
 * before trusting `hasSignature: true` for anything beyond "a signature-
 * shaped structure exists in this file".
 * ==========================================================================
 *
 * A PDF digital signature (whether produced by a DSC token via Adobe/
 * standard PKCS#7, or by an Aadhaar-eSign/PAdES flow using CAdES) is stored
 * as: a /Sig dictionary object carrying a /ByteRange (four integers marking
 * which bytes of the file the signature covers) and a /Contents hex string
 * holding the actual DER-encoded PKCS#7/CMS SignedData blob, with /SubFilter
 * naming which flavour it is (adbe.pkcs7.detached / adbe.pkcs7.sha1 /
 * ETSI.CAdES.detached / adbe.x509.rsa_sha1 — confirmed by WebSearch against
 * ISO 32000-1 §12.8.3.3 and ETSI TS 102 778-3/EN 319 142-2 summaries, Aug
 * 2026). Per the same spec, /ByteRange "shall cover the entire file,
 * including the signature dictionary but excluding the [/Contents] PDF
 * Signature itself" — i.e. a properly formed single signature's covered
 * bytes plus the Contents placeholder should account for the whole file.
 *
 * THIS MODULE CHECKS, PURELY STRUCTURALLY, WITH NO EXTERNAL DEPENDENCY:
 *   1. The file starts with a %PDF- header at all.
 *   2. At least one /Sig-shaped object exists: a /ByteRange array alongside
 *      a /Contents hex string and (when present) a recognised /SubFilter.
 *   3. The /Contents hex decodes to bytes starting with an ASN.1 SEQUENCE
 *      tag (0x30) and containing the PKCS#7 SignedData content-type OID
 *      (1.2.840.113549.1.7.2) — a sanity check that the blob is genuinely
 *      shaped like a PKCS#7/CMS signature, not arbitrary bytes shoved into
 *      a /Contents field.
 *   4. Whether that signature's /ByteRange spans (approximately) the whole
 *      file — i.e. byteRange[0] is 0 and byteRange[1]+byteRange[2] lands at
 *      or near the file's end. This is a STRUCTURAL hint consistent with
 *      "nothing was appended after this signature was applied", not proof.
 *
 * THIS MODULE DOES NOT, AND CANNOT WITHOUT MUCH HEAVIER MACHINERY:
 *   - Recompute the actual message digest over the ByteRange-covered bytes
 *     and compare it to the one inside the PKCS#7 SignerInfo. That is the
 *     real "was the document altered since signing" proof; this check only
 *     looks at whether the declared byte range plausibly spans the file,
 *     which a corrupted or hand-edited file could still satisfy.
 *   - Parse out the signing certificate and check its validity period,
 *     whether it chains to a trusted root, or whether it has been revoked
 *     (CRL/OCSP). That needs a real ASN.1/X.509 library and — for the trust
 *     and revocation parts specifically — a live network call to a CA or a
 *     bundled, kept-current trust store this app does not have. A hand-
 *     rolled walk of the PKCS#7 SET OF Certificate structure to pull out
 *     raw X.509 DER (which Node's own built-in crypto.X509Certificate could
 *     then parse for validity dates) was considered and deliberately left
 *     out: getting nested ASN.1 SEQUENCE/SET length parsing wrong would
 *     produce a plausible-looking but silently incorrect result, which is
 *     worse than not attempting it — exactly the "don't fake a check" the
 *     brief this module was built under warned against.
 *   - Say anything at all about whether the identity behind the signature
 *     is who the signer list says it is. A signature is only ever "this
 *     came from whoever holds this specific private key" — matching that
 *     key to "the person named as signer #2 on this request" is a human
 *     judgement, same as checking a wet-ink signature against a specimen.
 *
 * A PDF PRODUCED BY A MODERN TOOL USING COMPRESSED CROSS-REFERENCE/OBJECT
 * STREAMS may hide its /Sig dictionary inside a zlib-compressed object
 * stream that this text-scan cannot see — this check reads the file as
 * literal bytes/latin1 text, exactly the way the signature dictionary and
 * ByteRange/Contents keys are actually written (they are always literal,
 * per spec, never inside a compressed stream themselves — only OTHER,
 * unrelated objects in the same file might be compressed), so this
 * specific risk is low for a genuinely signed PDF, but is called out here
 * rather than assumed away: a false NEGATIVE (says "no signature found" on
 * a file that actually has one) is more likely than a false positive.
 * ==========================================================================
 */

export type PdfSignatureCheckResult = {
  /** File begins with a %PDF- header. */
  isPdf: boolean;
  /** At least one /Sig object with a parseable ByteRange + Contents was found. */
  hasSignature: boolean;
  signatureCount: number;
  subFilters: string[];
  /** True only when every found signature's ByteRange spans (approximately) the whole file. Null when hasSignature is false. */
  byteRangeCoversWholeFile: boolean | null;
  /** True only when every found /Contents blob decodes to a byte string that looks like DER PKCS#7 SignedData (SEQUENCE tag + the signedData OID). Null when hasSignature is false. */
  looksLikePkcs7: boolean | null;
  /** Plain-English summary, honest about the boundary above — safe to store verbatim and show to a user. */
  note: string;
};

const KNOWN_SUBFILTERS = new Set([
  "adbe.pkcs7.detached",
  "adbe.pkcs7.sha1",
  "adbe.x509.rsa_sha1",
  "ETSI.CAdES.detached",
]);

// DER encoding of OID 1.2.840.113549.1.7.2 (pkcs7-signedData), as it appears
// inside a PKCS#7 ContentInfo: tag 0x06, length 0x09, then the OID bytes.
const PKCS7_SIGNED_DATA_OID = Uint8Array.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]);

function bytesIncludes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function toLatin1String(bytes: Uint8Array): string {
  // PDF's own structural syntax (object dictionaries, names, arrays,
  // ByteRange, Contents' hex delimiters) is always single-byte
  // ASCII/latin1, even in a file whose STREAM contents are binary or
  // compressed — so a plain char-code decode is safe and lossless for the
  // purpose of regex-searching for these tokens, and much cheaper than a
  // real PDF parser.
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const len = Math.floor(clean.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Runs the structural check described above against a File's raw bytes.
 * Pass the result of `await file.arrayBuffer()`. Never throws — a malformed
 * or unrelated file simply comes back as isPdf/hasSignature: false with an
 * explanatory note, since "the check itself blew up" should never block an
 * upload the requester is entitled to make anyway (the signer signed
 * outside this app; this check is informational, not a gate).
 */
export function checkPdfSignaturePresence(buffer: ArrayBuffer): PdfSignatureCheckResult {
  try {
    const bytes = new Uint8Array(buffer);
    const text = toLatin1String(bytes);

    const isPdf = text.startsWith("%PDF-");
    if (!isPdf) {
      return {
        isPdf: false,
        hasSignature: false,
        signatureCount: 0,
        subFilters: [],
        byteRangeCoversWholeFile: null,
        looksLikePkcs7: null,
        note: "Not a PDF file — the structural signature check only applies to PDFs.",
      };
    }

    // Find every /ByteRange[...] occurrence and, near it (either side —
    // PDF dictionary key order is not spec-guaranteed, so /SubFilter or
    // /Filter can legally appear before /ByteRange in the same object), a
    // /Contents<hex> and an optional /SubFilter.
    //
    // /ByteRange's four integers are [offset1 length1 offset2 length2] —
    // NOT [start1 end1 start2 end2] — per ISO 32000-1 §12.8.1: two covered
    // segments, each given as (offset, length). Segment 1 is normally
    // [0, offsetOfContents) and segment 2 is [endOfContents, endOfFile), so
    // "covers the whole file" means offset1 === 0 and offset2 + length2
    // reaches the end of the file — get this backwards (as an earlier draft
    // of this file did, caught by its own synthetic-PDF test before
    // shipping) and every real signature looks like it doesn't cover the
    // file when it does.
    const byteRangeRe = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
    const subFilters: string[] = [];
    let signatureCount = 0;
    let allByteRangesCoverWholeFile = true;
    let allLookLikePkcs7 = true;

    let m: RegExpExecArray | null;
    while ((m = byteRangeRe.exec(text)) !== null) {
      const windowStart = Math.max(0, m.index - 2000);
      const windowEnd = Math.min(text.length, m.index + 20000);
      const window = text.slice(windowStart, windowEnd);

      const contentsMatch = window.match(/\/Contents\s*<([0-9A-Fa-f\s]+)>/);
      if (!contentsMatch) continue; // a /ByteRange with no adjacent /Contents isn't a signature dict we can confirm

      signatureCount++;

      const subFilterMatch = window.match(/\/SubFilter\s*\/([A-Za-z0-9.]+)/);
      if (subFilterMatch) subFilters.push(subFilterMatch[1]);

      const offset1 = Number(m[1]);
      const offset2 = Number(m[3]);
      const length2 = Number(m[4]);
      // Allow a small tolerance for a trailing newline/EOF marker some
      // producers leave outside the covered range.
      const segment2End = offset2 + length2;
      const coversWholeFile = offset1 === 0 && bytes.length - segment2End <= 4 && bytes.length - segment2End >= 0;
      if (!coversWholeFile) allByteRangesCoverWholeFile = false;

      const contentsHex = contentsMatch[1];
      const der = hexToBytes(contentsHex);
      const looksLikePkcs7 = der.length > 0 && der[0] === 0x30 && bytesIncludes(der, PKCS7_SIGNED_DATA_OID);
      if (!looksLikePkcs7) allLookLikePkcs7 = false;
    }

    if (signatureCount === 0) {
      return {
        isPdf: true,
        hasSignature: false,
        signatureCount: 0,
        subFilters: [],
        byteRangeCoversWholeFile: null,
        looksLikePkcs7: null,
        note: "This is a PDF, but no embedded digital signature (/Sig object with a ByteRange and Contents) was found structurally. If it was signed with a hardware DSC token or Aadhaar eSign elsewhere, that step may not have completed — re-check the source before treating this as the final signed copy.",
      };
    }

    const unrecognisedSubFilters = subFilters.filter((s) => !KNOWN_SUBFILTERS.has(s));
    const note =
      `Structural check only, not a cryptographic verification (see lib/pdf/signature-check.ts for exactly why). ` +
      `Found ${signatureCount} embedded signature-shaped object${signatureCount === 1 ? "" : "s"}` +
      (subFilters.length ? ` (type: ${subFilters.join(", ")})` : "") +
      `. ${allLookLikePkcs7 ? "The signature content decodes as a DER-encoded PKCS#7/CMS SignedData block, the shape a real DSC/eSign signature produces." : "The signature content does NOT clearly decode as PKCS#7/CMS SignedData — this may not be a genuine signature block."} ` +
      `${allByteRangesCoverWholeFile ? "Its declared byte range covers the whole file, consistent with nothing being appended after signing." : "Its declared byte range does NOT cover the whole file — this can mean content was added after signing, or that this reflects an earlier signature in a multi-signed document; treat with caution."} ` +
      (unrecognisedSubFilters.length
        ? `Its /SubFilter (${unrecognisedSubFilters.join(", ")}) is not one of the commonly recognised signature types this check knows about — treat the result with extra caution. `
        : "") +
      `This does NOT confirm the signing certificate is valid/unexpired/unrevoked or chains to a licensed CA — that needs a real trust-anchor lookup this app does not perform.`;

    return {
      isPdf: true,
      hasSignature: true,
      signatureCount,
      subFilters,
      byteRangeCoversWholeFile: allByteRangesCoverWholeFile,
      looksLikePkcs7: allLookLikePkcs7,
      note,
    };
  } catch (err) {
    return {
      isPdf: false,
      hasSignature: false,
      signatureCount: 0,
      subFilters: [],
      byteRangeCoversWholeFile: null,
      looksLikePkcs7: null,
      note: `Could not run the structural signature check (${err instanceof Error ? err.message : "unknown error"}). This does not mean the file has no signature — the check itself failed to run.`,
    };
  }
}
