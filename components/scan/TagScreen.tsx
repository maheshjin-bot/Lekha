"use client";

import { ChevronLeft } from "lucide-react";
import {
  SCAN_DOCUMENT_TYPES,
  SCAN_DOCUMENT_TYPE_LABELS,
  type ScanDocumentType,
  type ScanTags,
} from "@/lib/scan/types";

/**
 * Three taps, no typing.
 *
 * Tap a type, tap Send. That is the whole required path — the vendor name and
 * the note are genuinely optional and the button below them is enabled before
 * either is touched. Three big buttons rather than a <select>: a native select
 * on Android opens a modal wheel, needs two taps and a scroll, and shows the
 * options one at a time, which is exactly wrong for a choice of three.
 */
export function TagScreen({
  pageCount,
  tags,
  onChange,
  onBack,
  onSend,
}: {
  pageCount: number;
  tags: ScanTags;
  /**
   * A React setter, taken as one deliberately. The obvious signature —
   * `(tags: ScanTags) => void`, called as `onChange({ ...tags, note })` —
   * reads the `tags` PROP out of the handler's closure, so two changes that
   * land in the same React batch each start from the same stale object and the
   * second silently discards the first. Caught live: tapping a document type
   * and immediately editing the note sent the OLD document type to the server.
   * Functional updates cannot do that.
   */
  onChange: React.Dispatch<React.SetStateAction<ScanTags>>;
  onBack: () => void;
  onSend: () => void;
}) {
  function setType(documentType: ScanDocumentType) {
    onChange((current) => ({ ...current, documentType }));
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b border-border px-3 py-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-12 w-12 items-center justify-center rounded-full text-ink-soft active:bg-surface-2"
          aria-label="Back to the photos"
        >
          <ChevronLeft size={26} />
        </button>
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            What is this paper?
          </h1>
          <p className="text-xs text-ink-faint">
            {pageCount} {pageCount === 1 ? "page" : "pages"} ready
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <fieldset>
          <legend className="sr-only">Document type</legend>
          <div className="flex flex-col gap-3">
            {SCAN_DOCUMENT_TYPES.map((value) => {
              const label = SCAN_DOCUMENT_TYPE_LABELS[value];
              const selected = tags.documentType === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setType(value)}
                  aria-pressed={selected}
                  data-testid={`scan-type-${value}`}
                  className={
                    "flex min-h-[84px] w-full flex-col justify-center rounded-card border-2 px-5 text-left transition-colors " +
                    (selected
                      ? "border-accent bg-accent-soft"
                      : "border-border-strong bg-surface active:bg-surface-2")
                  }
                >
                  <span
                    className={
                      "text-lg font-semibold " + (selected ? "text-accent" : "text-ink")
                    }
                  >
                    {label.title}
                  </span>
                  <span className="text-sm text-ink-soft">{label.hint}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-7 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">
              Party name <span className="font-normal text-ink-faint">(optional)</span>
            </span>
            <input
              type="text"
              value={tags.vendorHint}
              onChange={(event) => {
                const vendorHint = event.target.value;
                onChange((current) => ({ ...current, vendorHint }));
              }}
              placeholder="Who it is from or for"
              autoComplete="off"
              autoCapitalize="words"
              data-testid="scan-vendor"
              className="min-h-[56px] rounded-card border border-border-strong bg-surface px-4 text-lg text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink-soft">
              Note for the office{" "}
              <span className="font-normal text-ink-faint">(optional)</span>
            </span>
            <textarea
              value={tags.note}
              onChange={(event) => {
                const note = event.target.value;
                onChange((current) => ({ ...current, note }));
              }}
              placeholder="Anything they should know"
              rows={3}
              data-testid="scan-note"
              className="rounded-card border border-border-strong bg-surface px-4 py-3 text-lg text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
          </label>
        </div>
      </div>

      <div
        className="border-t border-border bg-surface px-4 pt-4"
        style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          onClick={onSend}
          disabled={pageCount === 0}
          data-testid="scan-send"
          className="min-h-[64px] w-full rounded-card bg-accent px-4 text-xl font-semibold text-accent-ink disabled:opacity-40 active:opacity-90"
        >
          Send {pageCount} {pageCount === 1 ? "page" : "pages"}
        </button>
      </div>
    </div>
  );
}
