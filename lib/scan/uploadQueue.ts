/**
 * THE SEAM.
 *
 * Every byte that leaves the phone leaves through this file. Nothing in
 * components/scan/** calls `fetch` or `supabase.rpc` for a send; they call
 * `sendScanDocument` and listen to its events.
 *
 * That is deliberate, and it is the hook for the offline queue that is a LATER
 * phase and belongs to another agent. To add it, that phase should not need to
 * touch a single component:
 *
 *   1. Implement `ScanTransport` over IndexedDB — `uploadPage` writes the blob
 *      and the job row to a store and resolves optimistically; a background
 *      drain replays them against `createHttpTransport` when the connection
 *      returns.
 *   2. Pass that transport into `sendScanDocument` (it is already an option),
 *      or make it the default inside `defaultTransport()`.
 *   3. Replay is already safe: every job carries a `dedupeKey` that the server
 *      treats as idempotent, and `resume` lets a retry skip pages that made it.
 *
 * The two properties that make this possible are structural, so keep them:
 * pages are uploaded ONE AT A TIME (a queue drain is the same loop), and the
 * whole send is expressed as data — a `ScanDocumentJob` — rather than as
 * component state.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc } from "@/lib/supabase/rpc";
import type { ScanDocumentType } from "./types";

export type ScanPageUpload = {
  /** 1-based, and contiguous. The order the reviewer will read them in. */
  pageNo: number;
  blob: Blob;
  filename: string;
};

export type ScanDocumentJob = {
  companyId: string;
  branchId: string | null;
  documentType: ScanDocumentType;
  vendorHint: string | null;
  note: string | null;
  /**
   * One UUID per DOCUMENT, generated when the shooter starts tagging and reused
   * on every retry of that same document. This is what stops a flaky link from
   * turning one bill into four drafts on the reviewer's desk.
   */
  dedupeKey: string;
  pages: ScanPageUpload[];
};

export type ScanUploadedPage = {
  draftId: string;
  pageNo: number;
  storagePath: string;
};

/** Progress, and only progress. No accounting data ever comes back this way. */
export type ScanSendEvent =
  | { type: "page:start"; pageNo: number; total: number }
  | { type: "page:done"; pageNo: number; total: number; draftId: string }
  | { type: "submit:start"; draftId: string }
  | { type: "submit:done"; draftId: string }
  | { type: "error"; message: string; pageNo?: number };

/**
 * Where a partially-completed send got to. Handed back on failure and passed
 * straight back in on retry so a document that died on page 5 of 6 does not
 * re-upload the first four over the same bad connection.
 */
export type ScanSendResume = {
  draftId: string;
  uploadedPageNos: number[];
};

export type ScanSendResult =
  | { ok: true; draftId: string }
  | { ok: false; message: string; resume: ScanSendResume | null };

/**
 * The one interface the offline queue has to satisfy. Both methods may reject;
 * `sendScanDocument` turns a rejection into a resumable failure rather than
 * letting it escape into a React event handler.
 */
export interface ScanTransport {
  uploadPage(input: {
    job: ScanDocumentJob;
    page: ScanPageUpload;
    draftId: string | null;
    signal?: AbortSignal;
  }): Promise<ScanUploadedPage>;

  submitDraft(input: { draftId: string; signal?: AbortSignal }): Promise<void>;
}

/** The API route's own field names, in one place. */
export const SCAN_UPLOAD_ENDPOINT = "/api/capture/upload";

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

/**
 * Straight to Agent A's route + RPC. No retry loop of its own: retrying is the
 * caller's decision (and, later, the offline queue's), because a person holding
 * a phone would rather see "Retry" than watch a silent backoff.
 */
export function createHttpTransport(supabase: SupabaseClient): ScanTransport {
  return {
    async uploadPage({ job, page, draftId, signal }) {
      const form = new FormData();
      form.append("file", page.blob, page.filename);
      form.append("companyId", job.companyId);
      if (job.branchId) form.append("branchId", job.branchId);
      if (draftId) form.append("draftId", draftId);
      form.append("pageNo", String(page.pageNo));
      form.append("documentType", job.documentType);
      if (job.vendorHint) form.append("vendorHint", job.vendorHint);
      if (job.note) form.append("note", job.note);
      form.append("dedupeKey", job.dedupeKey);

      const response = await fetch(SCAN_UPLOAD_ENDPOINT, {
        method: "POST",
        body: form,
        signal,
      });

      if (!response.ok) {
        // The route answers with { error } on the paths it controls; a 502 from
        // in front of it answers with HTML, so never assume JSON.
        let detail = "";
        try {
          const body: unknown = await response.json();
          if (body && typeof body === "object" && "error" in body) {
            detail = String((body as { error: unknown }).error ?? "");
          }
        } catch {
          detail = "";
        }
        if (response.status === 404) {
          throw new Error(
            "The upload service is not available on this server yet."
          );
        }
        if (response.status === 413) {
          throw new Error("That page is too large to send. Take it again.");
        }
        throw new Error(
          detail || `Upload failed (${response.status}). Check the signal and try again.`
        );
      }

      const body = (await response.json()) as Partial<ScanUploadedPage>;
      if (!body?.draftId) {
        throw new Error("The upload service replied without a document id.");
      }
      return {
        draftId: body.draftId,
        pageNo: body.pageNo ?? page.pageNo,
        storagePath: body.storagePath ?? "",
      };
    },

    async submitDraft({ draftId }) {
      // Not in types/database.types.ts yet (that file is regenerated by another
      // agent's phase and must not be edited here), so through callRpc — which
      // also keeps supabase-js's `this` binding, see lib/supabase/rpc.ts.
      const { error } = await callRpc<{ p_draft_id: string }, unknown>(
        supabase,
        "submit_capture_draft",
        { p_draft_id: draftId }
      );
      if (error) throw new Error(error.message);
    },
  };
}

/**
 * Upload every page, then hand the document to the back office.
 *
 * Sequential on purpose. Parallel uploads look faster on office wifi and are
 * measurably worse on a 2-bar mobile link: they share the same tiny uplink,
 * they all time out together, and a partial failure leaves a confusing mix of
 * done and not-done. One at a time also gives an honest per-page progress
 * readout, which is the only reassurance the shooter gets that anything is
 * happening at all.
 */
export async function sendScanDocument(
  job: ScanDocumentJob,
  options?: {
    transport: ScanTransport;
    onEvent?: (event: ScanSendEvent) => void;
    resume?: ScanSendResume | null;
    signal?: AbortSignal;
  }
): Promise<ScanSendResult> {
  const transport = options?.transport;
  if (!transport) {
    return {
      ok: false,
      message: "No upload transport configured.",
      resume: options?.resume ?? null,
    };
  }
  const emit = options?.onEvent ?? (() => {});
  const total = job.pages.length;

  if (total === 0) {
    const message = "There are no pages to send.";
    emit({ type: "error", message });
    return { ok: false, message, resume: null };
  }

  let draftId = options?.resume?.draftId ?? null;
  const done = new Set(options?.resume?.uploadedPageNos ?? []);

  for (const page of job.pages) {
    if (done.has(page.pageNo)) continue;
    emit({ type: "page:start", pageNo: page.pageNo, total });
    try {
      const uploaded = await transport.uploadPage({
        job,
        page,
        draftId,
        signal: options?.signal,
      });
      draftId = uploaded.draftId;
      done.add(page.pageNo);
      emit({ type: "page:done", pageNo: page.pageNo, total, draftId });
    } catch (error) {
      const message = messageFrom(error, "That page did not go through.");
      emit({ type: "error", message, pageNo: page.pageNo });
      return {
        ok: false,
        message,
        resume: draftId ? { draftId, uploadedPageNos: [...done] } : null,
      };
    }
  }

  if (!draftId) {
    const message = "The upload service never returned a document id.";
    emit({ type: "error", message });
    return { ok: false, message, resume: null };
  }

  emit({ type: "submit:start", draftId });
  try {
    await transport.submitDraft({ draftId, signal: options?.signal });
  } catch (error) {
    const message = messageFrom(error, "The pages arrived but the send did not finish.");
    emit({ type: "error", message });
    // Every page IS up there — retrying must not re-upload them, only re-submit.
    return { ok: false, message, resume: { draftId, uploadedPageNos: [...done] } };
  }

  emit({ type: "submit:done", draftId });
  return { ok: true, draftId };
}

/**
 * The name a page travels under. Almost every page is a canvas-re-encoded
 * JPEG, but the "this phone cannot decode HEIC, send it untouched" fallback
 * ships the camera's original file — and naming a HEIC `page-1.jpg` would make
 * the server's own content sniffing disagree with its extension.
 */
export function pageFilename(blob: Blob, pageNo: number): string {
  const byType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "application/pdf": "pdf",
  };
  const ext = byType[blob.type?.toLowerCase() ?? ""] ?? "jpg";
  return `page-${pageNo}.${ext}`;
}

/**
 * A UUID per document. crypto.randomUUID is unavailable on http:// origins on
 * some Android WebViews, so there is a fallback — a duplicate draft is a far
 * smaller problem than a shutter button that throws.
 */
export function newDedupeKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last resort. Not a real UUID's entropy, but still a valid v4-shaped string.
  const rand = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${rand()}${rand()}-${rand()}-4${rand().slice(1)}-a${rand().slice(1)}-${rand()}${rand()}${rand()}`;
}
