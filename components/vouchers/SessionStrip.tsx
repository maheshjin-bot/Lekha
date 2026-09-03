"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { formatINRWithSymbol } from "@/lib/utils/currency";

/**
 * One voucher entered since this screen was opened. `id` keys the pill (and
 * should be the voucher id, so it survives a re-order); `href` is where the
 * pill navigates — typically the voucher's own detail/edit page.
 */
export type SessionStripEntry = {
  id: string;
  number: string;
  party: string;
  amount: number;
  href: string;
};

/** Pills shown before the row collapses the rest behind a "+N more" affordance. */
const COLLAPSED_VISIBLE_COUNT = 5;

/**
 * A thin strip that lists what has been entered in this sitting — number,
 * party, amount — each a link back to that voucher.
 *
 * This is the piece that makes "thirty bills entered in one sitting" possible
 * without ever bouncing back to a list screen to confirm the last one saved:
 * save-and-new clears the form but the strip keeps growing underneath it, so
 * the operator can glance down, or click back to fix a fat-fingered amount,
 * without losing their place.
 *
 * Pure presentation — this component owns none of the state it renders.
 * `entries` is expected to be *append-only* for the life of the screen (the
 * form that renders this pushes one entry per successful save-and-new); this
 * component reverses it for display so the most recent save is always the
 * first pill, but it never mutates or reorders the array it was given.
 *
 * Deliberately not wired into any form yet — a later change owns building
 * the `entries` array and appending to it after each save.
 */
export function SessionStrip({
  entries,
  onClear,
}: {
  entries: SessionStripEntry[];
  /** Optional "clear this list" affordance. Omit to hide the control entirely
   * (e.g. a form that has no notion of resetting the session). */
  onClear?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Nothing entered yet: render nothing rather than an empty strip with a
  // "This session (0)" label sitting under the form for no reason.
  if (entries.length === 0) return null;

  const newestFirst = [...entries].reverse();
  const hiddenCount = newestFirst.length - COLLAPSED_VISIBLE_COUNT;
  const visible = expanded || hiddenCount <= 0 ? newestFirst : newestFirst.slice(0, COLLAPSED_VISIBLE_COUNT);

  return (
    // print:hidden — this is a working aid for the person at the keyboard,
    // not part of the voucher/invoice that gets printed or exported.
    <div className="flex items-center gap-2 border-t border-border pt-2 print:hidden">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
        This session ({entries.length})
      </span>

      {/* overflow-x-auto, not wrap — a growing session should scroll
          sideways rather than push the page taller with every save. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {visible.map((entry) => (
          <Link
            key={entry.id}
            href={entry.href}
            title={`${entry.number} — ${entry.party}`}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-ink-soft",
              "transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-ink",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
            )}
          >
            <span className="font-medium text-ink">{entry.number}</span>
            <span className="max-w-[9rem] truncate text-ink-faint">{entry.party}</span>
            <span className="tabular-nums text-ink-soft">{formatINRWithSymbol(entry.amount)}</span>
          </Link>
        ))}

        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-2.5 py-1",
              "text-xs font-medium text-ink-soft transition-colors hover:text-ink",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
            )}
          >
            {expanded ? (
              <>
                Show fewer <ChevronUp size={12} aria-hidden="true" />
              </>
            ) : (
              <>
                +{hiddenCount} more <ChevronDown size={12} aria-hidden="true" />
              </>
            )}
          </button>
        )}
      </div>

      {onClear && (
        <button
          type="button"
          onClick={onClear}
          title="Clear this session's list"
          aria-label="Clear this session's list"
          className={cn(
            "shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:text-ink",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          )}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
