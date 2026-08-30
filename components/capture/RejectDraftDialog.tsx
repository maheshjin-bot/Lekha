"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { createClient } from "@/lib/supabase/client";

/**
 * Sending a document back to the person who photographed it.
 *
 * The REASON is the product here, not a formality. This is the only channel
 * that reaches the counter: someone photographed a bill, walked away, and
 * will never see this screen. "Rejected" on its own teaches them nothing and
 * they will photograph the next one exactly the same way. "Page 2 is cut off
 * — reshoot with the whole bill in frame" gets a usable picture back in two
 * minutes. So the field is required, short reasons are pushed back on, and
 * the suggestions below are the four failures that actually recur, offered as
 * a starting sentence to edit rather than as canned codes to pick.
 *
 * The write goes through public.reject_capture_draft(p_draft_id, p_reason) —
 * never a direct status='rejected' UPDATE, which is what this screen's
 * predecessor did and which stores no reason at all.
 *
 * A reason typed against one document must never survive into the next, and
 * that is the CALLER's job: the inbox keys this component by draft id, so a
 * different document is a different mount with empty state. Reopening the
 * SAME document keeps what was typed, which is the right answer for somebody
 * who cancelled to go and look at page 2 again.
 */

const SUGGESTIONS = [
  "Too blurry to read the amounts — please reshoot in better light.",
  "The bill is cut off — please include the whole page, edge to edge.",
  "A page is missing — please send every page of this bill.",
  "We already have this bill from another photo.",
];

/** Short enough to be useless to the person receiving it. */
const MIN_REASON_LENGTH = 10;

export function RejectDraftDialog({
  open,
  onClose,
  draftId,
  documentLabel,
  onRejected,
}: {
  open: boolean;
  onClose: () => void;
  draftId: string;
  /** What the reviewer is looking at, so the dialog names it back to them. */
  documentLabel: string;
  onRejected: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Say why this is going back — it is the only thing the sender will see.");
      return;
    }
    if (trimmed.length < MIN_REASON_LENGTH) {
      setError(
        "Give the sender something they can act on — which page, what was wrong, what to do instead."
      );
      return;
    }

    setBusy(true);
    setError(null);
    const { error: rpcError } = await createClient().rpc("reject_capture_draft", {
      p_draft_id: draftId,
      p_reason: trimmed,
    });
    setBusy(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    toast.success("Sent back with your reason");
    onRejected(trimmed);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send this document back"
      description={`${documentLabel} — nothing is posted, and the reason you write below is what reaches whoever photographed it.`}
      className="max-w-lg"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">Reason</span>
          <textarea
            required
            autoFocus
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. The total is covered by your thumb — please reshoot the bottom third."
            className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
          />
          <span className="text-xs text-ink-faint">
            Name the page and the problem. This is the whole message they get.
          </span>
        </label>

        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setReason(s)}
              className="rounded-md border border-border-strong px-2 py-1 text-left text-xs text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {s}
            </button>
          ))}
        </div>

        {error && (
          <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border-strong px-4 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Sending back…" : "Send back"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
