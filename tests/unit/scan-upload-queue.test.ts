import { describe, expect, it, vi } from "vitest";
import {
  newDedupeKey,
  pageFilename,
  sendScanDocument,
  type ScanDocumentJob,
  type ScanSendEvent,
  type ScanTransport,
  type ScanUploadedPage,
} from "@/lib/scan/uploadQueue";

/**
 * The upload seam.
 *
 * The properties tested here are the ones the LATER offline-queue phase will
 * depend on, so they are worth pinning now: pages go up one at a time and in
 * order, a failure hands back enough to resume rather than restart, and a
 * resume genuinely does not re-upload what already landed. Get any of those
 * wrong and a flaky shop-floor connection turns one bill into three drafts on
 * a reviewer's desk.
 */

function blob(text = "x"): Blob {
  return new Blob([text], { type: "image/jpeg" });
}

function job(pageCount: number): ScanDocumentJob {
  return {
    companyId: "company-1",
    branchId: "branch-1",
    documentType: "purchase_invoice",
    vendorHint: "Ramesh Textiles",
    note: null,
    dedupeKey: "dedupe-1",
    pages: Array.from({ length: pageCount }, (_, i) => ({
      pageNo: i + 1,
      blob: blob(`page ${i + 1}`),
      filename: `page-${i + 1}.jpg`,
    })),
  };
}

type UploadCall = { pageNo: number; draftId: string | null };

function fakeTransport(options?: {
  failOnPage?: number;
  failSubmit?: boolean;
  calls?: UploadCall[];
  submits?: string[];
}): ScanTransport {
  return {
    async uploadPage({ page, draftId }): Promise<ScanUploadedPage> {
      options?.calls?.push({ pageNo: page.pageNo, draftId });
      if (options?.failOnPage === page.pageNo) {
        throw new Error("Connection lost");
      }
      return {
        draftId: draftId ?? "draft-1",
        pageNo: page.pageNo,
        storagePath: `documents/draft-1/${page.pageNo}.jpg`,
      };
    },
    async submitDraft({ draftId }) {
      options?.submits?.push(draftId);
      if (options?.failSubmit) throw new Error("Submit refused");
    },
  };
}

describe("sendScanDocument — the happy path", () => {
  it("uploads every page in order, then submits once", async () => {
    const calls: UploadCall[] = [];
    const submits: string[] = [];
    const events: ScanSendEvent[] = [];

    const result = await sendScanDocument(job(3), {
      transport: fakeTransport({ calls, submits }),
      onEvent: (e) => events.push(e),
    });

    expect(result).toEqual({ ok: true, draftId: "draft-1" });
    expect(calls.map((c) => c.pageNo)).toEqual([1, 2, 3]);
    expect(submits).toEqual(["draft-1"]);
  });

  it("creates the draft on page 1 and names it on every page after", async () => {
    const calls: UploadCall[] = [];
    await sendScanDocument(job(3), { transport: fakeTransport({ calls }) });
    expect(calls[0].draftId).toBeNull();
    expect(calls[1].draftId).toBe("draft-1");
    expect(calls[2].draftId).toBe("draft-1");
  });

  it("emits progress the send screen can actually render", async () => {
    const events: ScanSendEvent[] = [];
    await sendScanDocument(job(2), {
      transport: fakeTransport(),
      onEvent: (e) => events.push(e),
    });
    expect(events.map((e) => e.type)).toEqual([
      "page:start",
      "page:done",
      "page:start",
      "page:done",
      "submit:start",
      "submit:done",
    ]);
  });
});

describe("sendScanDocument — failure and resume", () => {
  it("stops at the failing page and reports how far it got", async () => {
    const calls: UploadCall[] = [];
    const result = await sendScanDocument(job(4), {
      transport: fakeTransport({ failOnPage: 3, calls }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("Connection lost");
    expect(result.resume).toEqual({ draftId: "draft-1", uploadedPageNos: [1, 2] });
    // Page 4 must NOT have been attempted — an ordered document with a hole in
    // it is worse than a short one.
    expect(calls.map((c) => c.pageNo)).toEqual([1, 2, 3]);
  });

  it("a retry with the resume token re-uploads only what is missing", async () => {
    const calls: UploadCall[] = [];
    const submits: string[] = [];
    const result = await sendScanDocument(job(4), {
      transport: fakeTransport({ calls, submits }),
      resume: { draftId: "draft-1", uploadedPageNos: [1, 2] },
    });

    expect(result).toEqual({ ok: true, draftId: "draft-1" });
    expect(calls.map((c) => c.pageNo)).toEqual([3, 4]);
    expect(submits).toEqual(["draft-1"]);
  });

  it("a failed submit is resumable with NO pages re-uploaded", async () => {
    const result = await sendScanDocument(job(2), {
      transport: fakeTransport({ failSubmit: true }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.resume).toEqual({ draftId: "draft-1", uploadedPageNos: [1, 2] });

    const calls: UploadCall[] = [];
    const retry = await sendScanDocument(job(2), {
      transport: fakeTransport({ calls }),
      resume: result.resume,
    });
    expect(retry.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses a document with no pages instead of creating an empty draft", async () => {
    const upload = vi.fn();
    const result = await sendScanDocument(job(0), {
      transport: { uploadPage: upload, submitDraft: vi.fn() } as unknown as ScanTransport,
    });
    expect(result.ok).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it("reuses the SAME dedupe key across a retry, which is what makes it idempotent", async () => {
    const seen: string[] = [];
    const transport: ScanTransport = {
      async uploadPage({ job: j, page }) {
        seen.push(j.dedupeKey);
        return { draftId: "draft-1", pageNo: page.pageNo, storagePath: "" };
      },
      async submitDraft() {},
    };
    const document = job(2);
    await sendScanDocument(document, { transport });
    await sendScanDocument(document, { transport });
    expect(new Set(seen)).toEqual(new Set(["dedupe-1"]));
  });
});

describe("pageFilename", () => {
  it("names a cropped page as the JPEG it actually is", () => {
    expect(pageFilename(new Blob([""], { type: "image/jpeg" }), 2)).toBe("page-2.jpg");
  });

  it("keeps the real extension for an original sent uncropped", () => {
    // The "this phone cannot decode HEIC" fallback ships the camera's own file.
    expect(pageFilename(new Blob([""], { type: "image/heic" }), 1)).toBe("page-1.heic");
    expect(pageFilename(new Blob([""], { type: "application/pdf" }), 1)).toBe("page-1.pdf");
  });

  it("falls back to jpg for an empty content type rather than producing 'page-1.'", () => {
    expect(pageFilename(new Blob([""]), 1)).toBe("page-1.jpg");
  });
});

describe("newDedupeKey", () => {
  it("is a v4-shaped UUID, and a different one each time", () => {
    const a = newDedupeKey();
    const b = newDedupeKey();
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(a).not.toBe(b);
  });
});
