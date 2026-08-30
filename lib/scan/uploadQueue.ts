/**
 * THE SEAM.
 *
 * Every byte that leaves the phone leaves through this file. Nothing in
 * components/scan/** calls `fetch` or `supabase.rpc` for a send; they call
 * `sendScanDocument` and listen to its events.
 *
 * That is deliberate, and it was the hook for the offline queue. That queue now
 * exists — lib/scan/offlineQueue.ts and lib/scan/queueStore.ts — and it was
 * built on the two structural properties this file was shaped around, so keep
 * them: pages are uploaded ONE AT A TIME (a queue drain is literally the same
 * loop, called again later), and the whole send is expressed as data — a
 * `ScanDocumentJob` — rather than as component state, which is what lets it be
 * written to IndexedDB and replayed after the tab has died.
 *
 * ONE DEVIATION FROM THE ORIGINAL SKETCH, and it is deliberate. The plan above
 * was for the queue's `uploadPage` to write to IndexedDB and "resolve
 * optimistically". It does not, because an optimistic resolve makes the send
 * screen draw a green tick beside a page that is sitting on the phone. The
 * safety property of the whole feature is that a person is never left believing
 * a document was sent when it was not, and a tick that means two different
 * things breaks it. Instead the send fails honestly, and the CALLER decides to
 * queue — with a third outcome on screen ("saved on this phone") that is
 * neither success nor error.
 *
 * Replay is safe because the server says so, and that was verified against the
 * live database rather than taken from these comments: three
 * `create_capture_draft` calls with one dedupe key produce ONE draft,
 * `add_capture_draft_page` upserts on (draft, page no), and a second
 * `submit_capture_draft` leaves `submitted_at` untouched. A queue that retries
 * aggressively cannot duplicate a document.
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

/**
 * Is it worth trying this again?
 *
 * The offline queue lives or dies on this distinction. "retryable" means the
 * link was bad — no network, a 502 from the proxy, a timeout — and the same
 * bytes sent again in ten minutes will land. "permanent" means the SERVER
 * looked at this document and said no: too large, not signed in, not your
 * company. Retrying that forever would hide a bill from the office behind a
 * spinner that never stops, which is precisely the failure this whole feature
 * exists to prevent. A permanent failure has to reach a human.
 */
export type ScanFailureKind = "retryable" | "permanent";

/**
 * An upload failure that still knows WHY it failed by the time it reaches the
 * queue. `createHttpTransport` used to throw a bare Error carrying only prose,
 * which reads fine on the send screen and is useless to a retry loop.
 */
export class ScanTransportError extends Error {
  readonly status: number | null;
  readonly kind: ScanFailureKind;

  constructor(
    message: string,
    options: { status?: number | null; kind: ScanFailureKind; cause?: unknown }
  ) {
    super(message);
    this.name = "ScanTransportError";
    this.status = options.status ?? null;
    this.kind = options.kind;
    if (options.cause !== undefined) {
      // `cause` in the Error constructor needs ES2022; assigning it keeps the
      // ES2017 target this project compiles to.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * 5xx and the "slow down" family are the link's fault; everything else in 4xx
 * is a decision about THIS document that will be repeated identically forever.
 * 404 is deliberately permanent: it means the upload route is not deployed on
 * this server, and a phone silently re-queueing against a route that does not
 * exist is a bill that is never seen again.
 */
export function classifyHttpStatus(status: number): ScanFailureKind {
  if (status === 408 || status === 425 || status === 429) return "retryable";
  if (status >= 500) return "retryable";
  return "permanent";
}

const NETWORK_FAILURE = new RegExp(
  [
    "failed to fetch",
    "networkerror",
    "network request failed",
    "network error",
    "load failed", // Safari's own wording for a dead fetch
    "connection",
    "timeout",
    "timed out",
    "err_internet_disconnected",
    "err_network",
    "socket",
    "offline",
  ].join("|"),
  "i"
);

/**
 * Anything that escapes the transport, classified. Unknown failures are treated
 * as RETRYABLE on purpose: the cost of a wrong "retryable" is one extra attempt,
 * and the cost of a wrong "permanent" is a document a person is told to
 * re-photograph when it would have gone through on its own.
 */
export function classifySendError(error: unknown): ScanFailureKind {
  if (error instanceof ScanTransportError) return error.kind;
  const name = (error as { name?: unknown })?.name;
  if (name === "AbortError" || name === "TimeoutError") return "retryable";
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (NETWORK_FAILURE.test(message)) return "retryable";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "retryable";
  return "retryable";
}

/**
 * A PostgREST/Postgres error that came back with a code is the DATABASE having
 * an opinion — "this draft is already confirmed", "you may not capture for this
 * company" — and no amount of retrying changes it. A code-less failure from
 * supabase-js is almost always the fetch underneath it dying.
 */
export function classifyRpcError(error: {
  message?: string | null;
  code?: string | null;
}): ScanFailureKind {
  const message = error.message ?? "";
  if (NETWORK_FAILURE.test(message)) return "retryable";
  if (error.code) return "permanent";
  return "permanent";
}

/** Progress, and only progress. No accounting data ever comes back this way. */
export type ScanSendEvent =
  | { type: "page:start"; pageNo: number; total: number }
  | { type: "page:done"; pageNo: number; total: number; draftId: string }
  | { type: "submit:start"; draftId: string }
  | { type: "submit:done"; draftId: string }
  | { type: "error"; message: string; kind: ScanFailureKind; pageNo?: number };

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
  | {
      ok: false;
      message: string;
      /** Whether the offline queue should hold this and try again. */
      kind: ScanFailureKind;
      resume: ScanSendResume | null;
    };

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

      let response: Response;
      try {
        response = await fetch(SCAN_UPLOAD_ENDPOINT, {
          method: "POST",
          body: form,
          signal,
        });
      } catch (cause) {
        // fetch only rejects when the request never got an answer at all — no
        // signal, DNS gone, connection cut mid-body. Always worth another go.
        throw new ScanTransportError(
          "No signal. This page has not gone yet.",
          { kind: "retryable", cause }
        );
      }

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
        const kind = classifyHttpStatus(response.status);
        if (response.status === 404) {
          throw new ScanTransportError(
            "The upload service is not available on this server yet.",
            { status: 404, kind }
          );
        }
        if (response.status === 413) {
          throw new ScanTransportError(
            "That page is too large to send. Take it again.",
            { status: 413, kind }
          );
        }
        if (response.status === 401) {
          throw new ScanTransportError(
            "This phone is signed out. Sign in again, then send it.",
            { status: 401, kind }
          );
        }
        throw new ScanTransportError(
          detail ||
            `Upload failed (${response.status}). Check the signal and try again.`,
          { status: response.status, kind }
        );
      }

      const body = (await response.json()) as Partial<ScanUploadedPage>;
      if (!body?.draftId) {
        throw new ScanTransportError(
          "The upload service replied without a document id.",
          { status: response.status, kind: "retryable" }
        );
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
      if (error) {
        throw new ScanTransportError(error.message, {
          kind: classifyRpcError(error as { message?: string; code?: string }),
        });
      }
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
      kind: "permanent",
      resume: options?.resume ?? null,
    };
  }
  const emit = options?.onEvent ?? (() => {});
  const total = job.pages.length;

  if (total === 0) {
    const message = "There are no pages to send.";
    emit({ type: "error", message, kind: "permanent" });
    return { ok: false, message, kind: "permanent", resume: null };
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
      const kind = classifySendError(error);
      emit({ type: "error", message, kind, pageNo: page.pageNo });
      return {
        ok: false,
        message,
        kind,
        resume: draftId ? { draftId, uploadedPageNos: [...done] } : null,
      };
    }
  }

  if (!draftId) {
    const message = "The upload service never returned a document id.";
    emit({ type: "error", message, kind: "retryable" });
    return { ok: false, message, kind: "retryable", resume: null };
  }

  emit({ type: "submit:start", draftId });
  try {
    await transport.submitDraft({ draftId, signal: options?.signal });
  } catch (error) {
    const message = messageFrom(error, "The pages arrived but the send did not finish.");
    const kind = classifySendError(error);
    emit({ type: "error", message, kind });
    // Every page IS up there — retrying must not re-upload them, only re-submit.
    return {
      ok: false,
      message,
      kind,
      resume: { draftId, uploadedPageNos: [...done] },
    };
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
