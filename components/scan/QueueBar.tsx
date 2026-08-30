"use client";

import { AlertTriangle, CloudOff, Loader2, RefreshCw } from "lucide-react";
import type { ScanQueueSnapshot } from "@/lib/scan/offlineQueue";

/**
 * The count that makes the queue honest.
 *
 * A queue nobody can see is indistinguishable from a queue that lost your
 * document. This strip sits above every screen the shooter uses and answers one
 * question at a glance: how many photographs are still on this phone and not
 * with the office. It is the only place in /scan that is allowed to be
 * persistently visible, and it earns that by being the difference between
 * "sent" and "not sent".
 *
 * Red beats amber: something the SERVER refused needs a person, and it must not
 * be hidden behind a count of things that are merely waiting for signal.
 */
export function QueueBar({
  snapshot,
  onOpen,
  onTryNow,
}: {
  snapshot: ScanQueueSnapshot;
  onOpen: () => void;
  onTryNow: () => void;
}) {
  const { waiting, blocked, draining, online } = snapshot;
  if (!snapshot.ready || (waiting === 0 && blocked === 0)) return null;

  const problem = blocked > 0;

  return (
    <div
      className={
        "flex items-center gap-2 border-b px-3 py-2 " +
        (problem
          ? "border-error/40 bg-error-soft"
          : "border-warning/40 bg-warning-soft")
      }
      data-testid="scan-queue-bar"
    >
      <span className={problem ? "text-error" : "text-warning"}>
        {problem ? (
          <AlertTriangle size={20} />
        ) : draining ? (
          <Loader2 size={20} className="animate-spin" />
        ) : (
          <CloudOff size={20} />
        )}
      </span>

      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
        data-testid="scan-queue-open"
      >
        <span className="block text-sm font-semibold text-ink">
          {problem
            ? `${blocked} could not be sent`
            : draining
              ? `Sending ${waiting}…`
              : `${waiting} waiting to send`}
        </span>
        <span className="block truncate text-xs text-ink-soft">
          {problem
            ? "Tap to see why"
            : online
              ? "Tap to see them"
              : "No signal — they are safe on this phone"}
        </span>
      </button>

      {!problem && !draining && (
        <button
          type="button"
          onClick={onTryNow}
          className="flex h-10 items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 text-sm font-semibold text-ink active:bg-surface-2"
          data-testid="scan-queue-try-now"
        >
          <RefreshCw size={16} />
          Try now
        </button>
      )}
    </div>
  );
}
