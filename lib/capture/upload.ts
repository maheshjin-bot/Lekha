/**
 * Shared file rules for the capture routes (migration 0870).
 *
 * Deliberately has NO Supabase import and NO knowledge of capture_drafts —
 * same split lib/capture/analyze.ts already keeps. This module answers three
 * questions and nothing else: is this file acceptable, what is it actually,
 * and where does it belong in the bucket.
 */
import { createHash } from "node:crypto";

/**
 * What a phone camera or a scanner can send.
 *
 * HEIC/HEIF are here because they are what an iPhone produces by default —
 * "High Efficiency" is the factory camera setting, and a browser upload from
 * one arrives as image/heic, not image/jpeg. Rejecting it would mean the
 * feature simply does not work on roughly half the phones that will use it.
 * The vision model is handed the bytes and the declared type as-is; nothing
 * here transcodes.
 */
export const ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

export type CaptureMime = (typeof ALLOWED_MIME)[number];

/** Per PAGE, not per document — a 6-page bill may legitimately be 60 MB. */
export const MAX_BYTES = 10 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<CaptureMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

const MIME_BY_EXTENSION: Record<string, CaptureMime> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};

export function isAllowedMime(mime: string): mime is CaptureMime {
  return (ALLOWED_MIME as readonly string[]).includes(mime);
}

export function extensionForMime(mime: string): string {
  return isAllowedMime(mime) ? EXTENSION_BY_MIME[mime] : "bin";
}

export function mimeForPath(path: string): CaptureMime | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? null;
}

/**
 * A browser does not always tell the truth — or anything at all — about a
 * file's type. Android's own file picker hands back an empty `type` for HEIC
 * often enough that trusting it alone would reject valid photographs, and
 * some pickers send the generic "application/octet-stream". Where the
 * declared type is missing or useless, fall back to the filename's extension;
 * where it is present and acceptable, it wins.
 */
export function resolveMime(declared: string | undefined | null, fileName: string): string {
  const d = (declared ?? "").trim().toLowerCase();
  if (isAllowedMime(d)) return d;
  return mimeForPath(fileName) ?? d;
}

/**
 * DETERMINISTIC per (draft, page) — the whole point. A phone whose upload
 * response was lost retries and overwrites the same object rather than
 * leaving an orphan in the bucket behind every dropped connection, and
 * add_capture_draft_page's upsert then replaces the same row.
 *
 * The first path segment is the company id because that is exactly what the
 * 'documents' bucket's storage.objects RLS keys off (migration 0060), and
 * what add_capture_draft_page independently re-checks.
 */
export function capturePagePath(
  companyId: string,
  draftId: string,
  pageNo: number,
  mime: string
): string {
  const n = String(pageNo).padStart(3, "0");
  return `${companyId}/capture/${draftId}/page-${n}.${extensionForMime(mime)}`;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 1-based, and bounded so a malformed field cannot ask for page 2 billion. */
export function parsePageNo(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}

/** Trimmed, or null — never an empty string, which the RPCs treat as absent. */
export function optionalText(raw: FormDataEntryValue | null): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}
