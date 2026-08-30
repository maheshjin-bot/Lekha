"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Upload a document from THIS machine into the capture inbox.
 *
 * WHY THIS EXISTS SEPARATELY. The inbox was built around /scan — somebody
 * photographs a document on a phone and sends it, somebody else reviews it
 * here. That is the two-person case. But the one-person case is just as
 * ordinary: a bill arrives as a PDF by email, or was already scanned, and the
 * person at the desk simply wants to put it in. Losing that left the inbox
 * able to review documents it had no way of being given.
 *
 * It posts to the SAME /api/capture/upload the phone uses — same auth, same
 * MIME allow-list, same 10 MB cap, same dedupe, same storage layout. A second
 * upload path would be a second set of rules to keep in step; there is only
 * one, and this is a second door onto it.
 *
 * Multi-page works the way the phone's does: page 1 is posted with no
 * draftId and the route mints one, pages 2..n are posted against that same
 * draftId in order, so a two-page bill is one document rather than two.
 */

const ALLOWED = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

export function CaptureUploadPanel({ companyId }: { companyId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0 || busy) return;
    setError(null);

    const list = Array.from(files);
    // Checked here only so the reader gets a sentence instead of a 400 — the
    // route enforces both again, and it is the route that actually decides.
    const bad = list.find((f) => !ALLOWED.includes(f.type));
    if (bad) {
      return setError(
        `${bad.name} is a ${bad.type || "file of unknown type"}. Upload a PDF, PNG, JPEG or WebP.`
      );
    }
    const tooBig = list.find((f) => f.size > MAX_BYTES);
    if (tooBig) {
      return setError(`${tooBig.name} is larger than 10 MB. Photograph it again at a lower size.`);
    }

    setBusy(true);
    let draftId: string | null = null;
    try {
      for (let i = 0; i < list.length; i++) {
        setProgress(list.length === 1 ? "Uploading…" : `Uploading page ${i + 1} of ${list.length}…`);
        const fd = new FormData();
        fd.append("file", list[i]);
        fd.append("companyId", companyId);
        fd.append("pageNo", String(i + 1));
        // Page 1 mints the draft; every later page joins it, which is what
        // makes several files one document rather than several.
        if (draftId) fd.append("draftId", draftId);

        const res = await fetch("/api/capture/upload", { method: "POST", body: fd });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(json?.error ?? `Upload failed on page ${i + 1}.`);
        }
        draftId = json.draftId ?? draftId;
      }
      setProgress(null);
      if (inputRef.current) inputRef.current.value = "";
      // The document is in; the inbox below is server-rendered, so refresh
      // rather than trying to splice a row into a list this panel does not own.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload did not finish.");
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-[14px] border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-ink">Upload a document</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            A bill that arrived as a PDF, or one already scanned on this machine. It lands in the
            same inbox as anything sent from a phone, and is read the same way. Choose several
            files at once and they become one multi-page document, in the order you pick them.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy ? progress ?? "Uploading…" : "Choose a file"}
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ALLOWED.join(",")}
        onChange={(e) => void onFiles(e.target.files)}
        className="sr-only"
      />

      {error && (
        <p className="mt-3 rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        PDF, PNG, JPEG or WebP, up to 10 MB each. Nothing is posted to your books by uploading —
        it only becomes a draft here for you to check.
      </p>
    </div>
  );
}
