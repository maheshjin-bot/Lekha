"use client";

import { useState } from "react";
import { AlertTriangle, ChevronLeft, CloudOff, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { ScanQueueEntry, ScanQueueSnapshot } from "@/lib/scan/offlineQueue";
import { scanDocumentTypeLabel } from "@/lib/scan/types";
import { formatSentAt } from "@/lib/scan/recentSends";

/**
 * Everything this phone is still holding.
 *
 * The screen exists to make one promise checkable: nothing photographed has
 * quietly evaporated. Each row says what it is, how many pages, when it was
 * taken, and — the part that matters — whether it is merely WAITING or has been
 * REFUSED. Those two are drawn nothing alike, because they need opposite things
 * from the person holding the phone: patience, or action.
 *
 * The footer says plainly that sending only happens while this screen is open.
 * That is the true behaviour on every handset (see lib/scan/offlineQueue.ts for
 * why Background Sync is not used), and a screen that implied otherwise would
 * be the single most damaging sentence in the product.
 */
export function QueueScreen({
  snapshot,
  onBack,
  onTryNow,
  onDiscard,
  onUnblock,
}: {
  snapshot: ScanQueueSnapshot;
  onBack: () => void;
  onTryNow: () => void;
  onDiscard: (dedupeKey: string) => void;
  onUnblock: (dedupeKey: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const now = new Date();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b border-border px-3 py-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-12 w-12 items-center justify-center rounded-full text-ink-soft active:bg-surface-2"
          aria-label="Back to the camera"
        >
          <ChevronLeft size={26} />
        </button>
        <h1 className="flex-1 font-display text-xl font-semibold tracking-tight text-ink">
          Still on this phone
        </h1>
        <button
          type="button"
          onClick={onTryNow}
          disabled={snapshot.draining}
          className="flex h-12 w-12 items-center justify-center rounded-full text-ink-soft disabled:opacity-40 active:bg-surface-2"
          aria-label="Try sending now"
          data-testid="scan-queue-screen-try"
        >
          {snapshot.draining ? (
            <Loader2 size={20} className="animate-spin" />
          ) : (
            <RefreshCw size={20} />
          )}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {snapshot.entries.length === 0 && (
          <p className="py-10 text-center text-base text-ink-soft">
            Nothing is waiting. Everything photographed on this phone has reached
            the office.
          </p>
        )}

        {snapshot.storageProblem && (
          <p className="mb-4 rounded-card border border-error/40 bg-error-soft px-4 py-3 text-base text-ink">
            {snapshot.storageProblem}
          </p>
        )}

        <ul className="flex flex-col gap-3">
          {snapshot.entries.map((entry) => (
            <QueueRow
              key={entry.dedupeKey}
              entry={entry}
              now={now}
              online={snapshot.online}
              confirming={confirming === entry.dedupeKey}
              onAskDiscard={() => setConfirming(entry.dedupeKey)}
              onCancelDiscard={() => setConfirming(null)}
              onDiscard={() => {
                setConfirming(null);
                onDiscard(entry.dedupeKey);
              }}
              onUnblock={() => onUnblock(entry.dedupeKey)}
            />
          ))}
        </ul>
      </div>

      <div
        className="border-t border-border bg-surface px-4 pt-3 text-sm text-ink-soft"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        {/* The honest sentence. It is the same on an iPhone and on an Android,
            because the mechanism is the same on both: this queue is drained by
            the scanner itself, and only while the scanner is open. */}
        These send by themselves as soon as there is signal — as long as this
        scanner is open. If you close it, they will go the next time you open it.
        Nothing is lost either way.
      </div>
    </div>
  );
}

function QueueRow({
  entry,
  now,
  online,
  confirming,
  onAskDiscard,
  onCancelDiscard,
  onDiscard,
  onUnblock,
}: {
  entry: ScanQueueEntry;
  now: Date;
  online: boolean;
  confirming: boolean;
  onAskDiscard: () => void;
  onCancelDiscard: () => void;
  onDiscard: () => void;
  onUnblock: () => void;
}) {
  const blocked = entry.state === "blocked";
  const sending = entry.state === "sending";

  return (
    <li
      className={
        "rounded-card border bg-surface p-4 " +
        (blocked ? "border-error/50" : "border-warning/50")
      }
      data-testid="scan-queue-row"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">
            {scanDocumentTypeLabel(entry.documentType)}
          </p>
          {entry.vendorHint && (
            <p className="truncate text-sm text-ink-soft">{entry.vendorHint}</p>
          )}
          <p className="text-sm text-ink-faint">
            {entry.pageCount} {entry.pageCount === 1 ? "page" : "pages"} ·{" "}
            {Math.max(1, Math.round(entry.bytes / 1024))} KB
            {entry.queuedAt ? ` · ${formatSentAt(new Date(entry.queuedAt).toISOString(), now)}` : ""}
          </p>
        </div>
        <span
          className={
            "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide " +
            (blocked
              ? "bg-error-soft text-error"
              : sending
                ? "bg-accent-soft text-accent"
                : "bg-warning-soft text-warning")
          }
        >
          {blocked ? (
            <AlertTriangle size={14} />
          ) : sending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <CloudOff size={14} />
          )}
          {blocked ? "Refused" : sending ? "Sending" : online ? "Waiting" : "No signal"}
        </span>
      </div>

      {blocked && (
        <div className="mt-3">
          <p className="rounded-lg bg-error-soft px-3 py-3 text-base text-ink">
            <span className="block text-xs font-semibold uppercase tracking-wide text-error">
              This one will not send
            </span>
            {entry.lastError ?? "The office's system refused it."}
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            It has NOT reached the office. Fix what it says above and try again,
            or throw it away and photograph the paper afresh.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onUnblock}
              className="flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-card bg-accent px-3 text-base font-semibold text-accent-ink active:opacity-90"
              data-testid="scan-queue-unblock"
            >
              <RefreshCw size={18} />
              Try it again
            </button>
            <button
              type="button"
              onClick={onAskDiscard}
              aria-label="Throw this document away"
              className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-card border border-error/50 text-error active:bg-error-soft"
            >
              <Trash2 size={20} />
            </button>
          </div>
        </div>
      )}

      {!blocked && entry.attempts > 0 && entry.lastError && (
        <p className="mt-3 text-sm text-ink-soft">
          Last try: {entry.lastError} It will keep trying on its own.
        </p>
      )}

      {confirming && (
        <div className="mt-3 rounded-lg border border-error/40 bg-error-soft px-3 py-3">
          <p className="text-base text-ink">
            Throw away {entry.pageCount}{" "}
            {entry.pageCount === 1 ? "photograph" : "photographs"}? The office
            will never see this document and you will have to photograph the
            paper again.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onDiscard}
              className="min-h-[48px] flex-1 rounded-card bg-error px-3 text-base font-semibold text-white active:opacity-90"
              data-testid="scan-queue-discard-confirm"
            >
              Throw it away
            </button>
            <button
              type="button"
              onClick={onCancelDiscard}
              className="min-h-[48px] flex-1 rounded-card border border-border-strong px-3 text-base font-semibold text-ink active:bg-surface-2"
            >
              Keep it
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
