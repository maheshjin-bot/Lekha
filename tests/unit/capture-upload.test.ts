/**
 * lib/capture/upload.ts — the pure file rules the 0870 scanner routes share.
 *
 * Everything here is synchronous and dependency-free, so these are real
 * assertions about real behaviour, not mocks agreeing with themselves.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ALLOWED_MIME,
  MAX_BYTES,
  capturePagePath,
  extensionForMime,
  isAllowedMime,
  mimeForPath,
  optionalText,
  parsePageNo,
  resolveMime,
  sha256Hex,
} from "@/lib/capture/upload";

const CO = "9321ef74-8b82-45e4-bcab-fbe50d659e1f";
const DRAFT = "11111111-2222-3333-4444-555555555555";

describe("accepted file types", () => {
  it("accepts HEIC and HEIF, which is what an iPhone camera actually produces", () => {
    expect(isAllowedMime("image/heic")).toBe(true);
    expect(isAllowedMime("image/heif")).toBe(true);
  });

  it("accepts the four types 0740 already allowed", () => {
    for (const m of ["image/jpeg", "image/png", "image/webp", "application/pdf"]) {
      expect(isAllowedMime(m)).toBe(true);
    }
  });

  it("rejects anything else, including types that merely look image-ish", () => {
    for (const m of ["image/gif", "image/svg+xml", "text/html", "application/octet-stream", ""]) {
      expect(isAllowedMime(m)).toBe(false);
    }
  });

  it("caps a page at 10 MB", () => {
    expect(MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("gives every accepted type a real extension — none falls through to .bin", () => {
    for (const m of ALLOWED_MIME) {
      expect(extensionForMime(m)).not.toBe("bin");
    }
    expect(extensionForMime("image/gif")).toBe("bin");
  });
});

describe("resolveMime — browsers lie about, or omit, a file's type", () => {
  it("trusts a declared type when it is one we accept", () => {
    expect(resolveMime("image/png", "bill.jpg")).toBe("image/png");
  });

  it("falls back to the extension when the browser sends no type at all", () => {
    // Android's picker does this for HEIC often enough that trusting `type`
    // alone would reject valid photographs.
    expect(resolveMime("", "IMG_0421.HEIC")).toBe("image/heic");
    expect(resolveMime(undefined, "scan.pdf")).toBe("application/pdf");
    expect(resolveMime(null, "page.JPEG")).toBe("image/jpeg");
  });

  it("falls back to the extension when the browser sends a useless generic type", () => {
    expect(resolveMime("application/octet-stream", "bill.jpg")).toBe("image/jpeg");
  });

  it("is case-insensitive about the declared type", () => {
    expect(resolveMime("IMAGE/JPEG", "x.bin")).toBe("image/jpeg");
  });

  it("leaves a genuinely unknown file unknown rather than guessing it is an image", () => {
    expect(isAllowedMime(resolveMime("application/zip", "bills.zip"))).toBe(false);
    expect(isAllowedMime(resolveMime("", "notes.txt"))).toBe(false);
  });
});

describe("mimeForPath", () => {
  it("reads the extension of a stored object path", () => {
    expect(mimeForPath(`${CO}/capture/${DRAFT}/page-001.jpg`)).toBe("image/jpeg");
    expect(mimeForPath(`${CO}/capture/${DRAFT}/page-002.PDF`)).toBe("application/pdf");
  });

  it("returns null for a path with no usable extension", () => {
    expect(mimeForPath(`${CO}/capture/${DRAFT}/`)).toBeNull();
    expect(mimeForPath("something")).toBeNull();
  });
});

describe("capturePagePath", () => {
  it("is deterministic: the same page uploaded twice resolves to the same object", () => {
    const a = capturePagePath(CO, DRAFT, 1, "image/jpeg");
    const b = capturePagePath(CO, DRAFT, 1, "image/jpeg");
    expect(a).toBe(b);
  });

  it("puts the company id first, which is the segment the bucket's RLS keys off", () => {
    expect(capturePagePath(CO, DRAFT, 1, "image/jpeg").split("/")[0]).toBe(CO);
  });

  it("zero-pads to three digits so pages sort in order in the bucket", () => {
    expect(capturePagePath(CO, DRAFT, 1, "image/jpeg")).toMatch(/\/page-001\.jpg$/);
    expect(capturePagePath(CO, DRAFT, 9, "image/jpeg")).toMatch(/\/page-009\.jpg$/);
    expect(capturePagePath(CO, DRAFT, 10, "image/jpeg")).toMatch(/\/page-010\.jpg$/);
  });

  it("pads rather than truncates past three digits", () => {
    // JS padStart pads and never truncates; Postgres lpad would have cut this
    // to '100'. Asserted because the two are not the same function.
    expect(capturePagePath(CO, DRAFT, 1000, "image/jpeg")).toMatch(/\/page-1000\.jpg$/);
  });

  it("separates two drafts in the same company", () => {
    const other = "99999999-8888-7777-6666-555555555555";
    expect(capturePagePath(CO, DRAFT, 1, "image/jpeg")).not.toBe(
      capturePagePath(CO, other, 1, "image/jpeg")
    );
  });

  it("uses the extension of the resolved type", () => {
    expect(capturePagePath(CO, DRAFT, 2, "application/pdf")).toMatch(/\/page-002\.pdf$/);
    expect(capturePagePath(CO, DRAFT, 2, "image/heic")).toMatch(/\/page-002\.heic$/);
  });
});

describe("parsePageNo", () => {
  it("accepts 1-based whole numbers", () => {
    expect(parsePageNo("1")).toBe(1);
    expect(parsePageNo("12")).toBe(12);
    expect(parsePageNo(" 7 ")).toBe(7);
  });

  it("refuses 0, negatives, fractions and anything past the cap", () => {
    for (const bad of ["0", "-1", "1.5", "101", "1e9", "abc", "", "   "]) {
      expect(parsePageNo(bad), `expected ${JSON.stringify(bad)} to be refused`).toBeNull();
    }
  });

  it("refuses a non-string form field", () => {
    expect(parsePageNo(null)).toBeNull();
  });
});

describe("optionalText", () => {
  it("trims, and turns blank into null so the RPCs see 'absent' not ''", () => {
    expect(optionalText("  Sharma Textiles ")).toBe("Sharma Textiles");
    expect(optionalText("   ")).toBeNull();
    expect(optionalText("")).toBeNull();
    expect(optionalText(null)).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 of the empty input", () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("matches node's own digest for arbitrary bytes", () => {
    const bytes = Buffer.from("a photographed bill", "utf8");
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("differs for one flipped byte — the duplicate flag depends on this", () => {
    expect(sha256Hex(Buffer.from([1, 2, 3]))).not.toBe(sha256Hex(Buffer.from([1, 2, 4])));
  });
});
