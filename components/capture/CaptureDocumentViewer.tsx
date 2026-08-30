"use client";

import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { documentKind, fileNameOf } from "@/components/capture/reviewModel";

/**
 * The photograph, beside the fields read off it.
 *
 * This is the half of the review inbox that makes review possible at all: an
 * accountant confirming a rate or a GSTIN has to be able to see the paper,
 * enlarge the blurry corner, and turn a page the shop photographed sideways.
 * Nothing here is decorative.
 *
 * PAGES: a document is now several images (public.capture_draft_pages, one
 * row per page). A draft captured before that table existed has no page rows
 * and exactly one image, at capture_drafts.storage_path — that is what
 * `fallbackPath` is for, and why "no page rows" is a normal outcome here
 * rather than an error.
 *
 * SIGNED URLS: the 'documents' bucket is private, so every image is fetched
 * through a short-lived signed URL, exactly as
 * components/documents/DocumentAttachments.tsx and the print-template preview
 * already do. They are minted per draft, not per app load, and deliberately
 * short: a leaked review URL should stop working long before the bill it
 * shows stops mattering.
 *
 * PDFS: rendered by the browser's own viewer in an <object>, with a
 * download link behind it. This screen does NOT rasterise PDF pages itself —
 * there is no PDF renderer in this app and pretending to have one would mean
 * shipping a blank grey box that looks like a broken image.
 */

type Page = { pageNo: number; path: string; url: string };

const SIGNED_URL_SECONDS = 600;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const;

export function CaptureDocumentViewer({
  draftId,
  fallbackPath,
}: {
  draftId: string;
  /** capture_drafts.storage_path — page 1 of a draft with no page rows. */
  fallbackPath: string | null;
}) {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [zoomStep, setZoomStep] = useState(2); // ZOOM_STEPS[2] === 1
  const [rotation, setRotation] = useState(0);

  // The inbox remounts this component per draft (key={draft.id}), so there is
  // nothing to reset here — every mount starts from the initial state above.
  // Shaped as QuickAddLedgerModal's effect is: an inline async IIFE with a
  // cancelled flag, so no state is set synchronously during the effect and a
  // reply that arrives after unmount is dropped rather than warned about.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const supabase = createClient();

      const { data: pageRows, error: pagesError } = await supabase
        .from("capture_draft_pages")
        .select("page_no, storage_path")
        .eq("draft_id", draftId)
        .order("page_no");

      // An error and a genuinely empty page list are different things, but both
      // leave the same next move: fall back to the draft's own single file,
      // which is where a pre-0870 upload and the WhatsApp path put theirs.
      const rows = pagesError ? [] : (pageRows ?? []);

      const paths = rows.length
        ? rows.map((r) => ({ pageNo: r.page_no, path: r.storage_path }))
        : fallbackPath
          ? [{ pageNo: 1, path: fallbackPath }]
          : [];

      if (cancelled) return;
      if (!paths.length) {
        setPages([]);
        if (pagesError) setError(pagesError.message);
        return;
      }

      const { data: signed, error: signError } = await supabase.storage
        .from("documents")
        .createSignedUrls(
          paths.map((p) => p.path),
          SIGNED_URL_SECONDS
        );

      if (cancelled) return;
      if (signError || !signed) {
        setPages([]);
        setError(signError?.message ?? "Could not open the stored image.");
        return;
      }

      // createSignedUrls answers in the order it was asked, with a per-item
      // error rather than a throw — a page whose object is missing drops out
      // instead of taking the whole document down with it.
      const built: Page[] = [];
      signed.forEach((s, i) => {
        if (s.signedUrl && paths[i]) {
          built.push({ pageNo: paths[i].pageNo, path: paths[i].path, url: s.signedUrl });
        }
      });

      setPages(built);
      if (!built.length) setError("The stored image could not be opened.");
    })();

    return () => {
      cancelled = true;
    };
  }, [draftId, fallbackPath]);

  if (pages === null) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-border bg-surface-2 text-sm text-ink-faint">
        <Loader2 size={16} className="mr-2 animate-spin" />
        Opening the document…
      </div>
    );
  }

  if (!pages.length) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong bg-surface px-4 py-10 text-center text-sm text-ink-faint">
        No image is stored for this document.
        {error && <span className="mt-1 block text-xs">{error}</span>}
      </div>
    );
  }

  const page = pages[Math.min(index, pages.length - 1)];
  const kind = documentKind(page.path);
  const zoom = ZOOM_STEPS[zoomStep];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm">
        <button
          type="button"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
          aria-label="Previous page"
          className="rounded-md p-1 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="tabular-nums text-xs text-ink-soft">
          Page {page.pageNo} of {pages.length}
        </span>
        <button
          type="button"
          onClick={() => setIndex((i) => Math.min(pages.length - 1, i + 1))}
          disabled={index >= pages.length - 1}
          aria-label="Next page"
          className="rounded-md p-1 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30"
        >
          <ChevronRight size={16} />
        </button>

        <span className="mx-1 h-4 w-px bg-border" aria-hidden />

        <button
          type="button"
          onClick={() => setZoomStep((z) => Math.max(0, z - 1))}
          disabled={kind === "pdf" || zoomStep === 0}
          aria-label="Zoom out"
          className="rounded-md p-1 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30"
        >
          <ZoomOut size={16} />
        </button>
        <button
          type="button"
          onClick={() => setZoomStep(2)}
          disabled={kind === "pdf"}
          className="rounded-md px-1.5 py-0.5 text-xs tabular-nums text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => setZoomStep((z) => Math.min(ZOOM_STEPS.length - 1, z + 1))}
          disabled={kind === "pdf" || zoomStep === ZOOM_STEPS.length - 1}
          aria-label="Zoom in"
          className="rounded-md p-1 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30"
        >
          <ZoomIn size={16} />
        </button>
        <button
          type="button"
          onClick={() => setRotation((r) => (r + 90) % 360)}
          disabled={kind === "pdf"}
          aria-label="Rotate 90 degrees"
          className="rounded-md p-1 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30"
        >
          <RotateCw size={16} />
        </button>

        <a
          href={page.url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent transition-colors hover:bg-surface-2"
        >
          <Download size={14} />
          Open original
        </a>
      </div>

      {kind === "pdf" ? (
        <div className="overflow-hidden rounded-lg border border-border bg-surface-2">
          <object data={page.url} type="application/pdf" className="h-[70vh] w-full">
            {/* Shown only when the browser has no built-in PDF viewer — the
                honest fallback, rather than a blank frame. */}
            <div className="px-4 py-10 text-center text-sm text-ink-faint">
              This browser cannot display the PDF inline.{" "}
              <a
                href={page.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline underline-offset-4"
              >
                Open {fileNameOf(page.path)}
              </a>
            </div>
          </object>
        </div>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-surface-2 p-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL, not a static asset Next's <Image> can optimise. */}
          <img
            key={page.url}
            src={page.url}
            alt={`Captured document, page ${page.pageNo}`}
            style={{
              transform: `rotate(${rotation}deg) scale(${zoom})`,
              transformOrigin: "center center",
            }}
            className="mx-auto block max-w-full transition-transform"
          />
        </div>
      )}

      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
