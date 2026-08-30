"use client";

import { useCallback, useEffect, useState } from "react";
import { Camera, ChevronLeft, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { effectiveStage, fetchRecentSends, formatSentAt } from "@/lib/scan/recentSends";
import { describeSendStatus, scanDocumentTypeLabel, type ScanRecentSend } from "@/lib/scan/types";

/**
 * The loop that makes the whole feature work.
 *
 * A photographed bill that the back office cannot read is worse than no
 * photograph at all, because everyone believes it is handled. This screen is
 * where "Sent back" arrives, WITH THE REVIEWER'S REASON IN FULL, and where a
 * re-shoot starts from — pre-tagged with the same document type, so the
 * correction costs two taps.
 *
 * Notice what is not here: no amount, no vendor ledger, no voucher number, no
 * link into the books. Status and reason only.
 */
export function RecentSendsScreen({
  companyId,
  onBack,
  onReshoot,
}: {
  companyId: string;
  onBack: () => void;
  onReshoot: (documentType: string | null) => void;
}) {
  const [rows, setRows] = useState<ScanRecentSend[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  const apply = useCallback((result: Awaited<ReturnType<typeof fetchRecentSends>>) => {
    setRows(result.rows);
    setError(result.error);
    // Read the clock here, in a callback, not during render — a render-time
    // `new Date()` is exactly the impurity this project's lint rules flag, and
    // it would also desync server and client HTML.
    setNow(new Date());
    setLoading(false);
  }, []);

  // The first load runs on mount, and every setState it performs happens in
  // the promise callback rather than synchronously in the effect body — the
  // same shape components/whatsapp/ConfirmWhatsAppDraftPanel.tsx uses, and the
  // one this project's react-hooks lint allows.
  useEffect(() => {
    let cancelled = false;
    fetchRecentSends(createClient(), companyId).then((result) => {
      if (cancelled) return;
      apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apply, companyId]);

  // The refresh button, by contrast, is an event handler, so it may flip the
  // spinner on immediately.
  const refresh = useCallback(async () => {
    setLoading(true);
    apply(await fetchRecentSends(createClient(), companyId));
  }, [apply, companyId]);

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
          What I have sent
        </h1>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex h-12 w-12 items-center justify-center rounded-full text-ink-soft disabled:opacity-40 active:bg-surface-2"
          aria-label="Check again"
        >
          <RefreshCw size={20} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading && rows.length === 0 && (
          <p className="py-10 text-center text-base text-ink-soft">Checking…</p>
        )}

        {!loading && error && (
          <p className="rounded-card border border-border-strong bg-surface-2 px-4 py-4 text-base text-ink-soft">
            {error}
          </p>
        )}

        {!loading && !error && rows.length === 0 && (
          <p className="py-10 text-center text-base text-ink-soft">
            Nothing sent from this phone yet.
          </p>
        )}

        <ul className="flex flex-col gap-3">
          {rows.map((row) => {
            const status = describeSendStatus(effectiveStage(row));
            return (
              <li
                key={row.draft_id}
                className={
                  // The border matches the pill, rather than every attention
                  // case borrowing the red one — "not sent yet" is a nudge,
                  // "sent back" is a rejection, and they should not look alike.
                  "rounded-card border bg-surface p-4 " +
                  (status.sentBack
                    ? "border-error/50"
                    : status.unsent
                      ? "border-warning/50"
                      : "border-border")
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-ink">
                      {scanDocumentTypeLabel(row.document_type)}
                    </p>
                    {row.vendor_hint && (
                      <p className="truncate text-sm text-ink-soft">{row.vendor_hint}</p>
                    )}
                    <p className="text-sm text-ink-faint">
                      {row.page_count} {row.page_count === 1 ? "page" : "pages"}
                      {now && row.created_at ? ` · ${formatSentAt(row.created_at, now)}` : ""}
                    </p>
                  </div>
                  <span
                    className={
                      "shrink-0 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide " +
                      status.tone
                    }
                  >
                    {status.label}
                  </span>
                </div>

                {status.sentBack && (
                  <div className="mt-3">
                    {/* The reason gets the most space on the card on purpose.
                        This sentence is the only thing that tells the shooter
                        what to do differently, and it is why the loop closes. */}
                    <p className="rounded-lg bg-error-soft px-3 py-3 text-base text-ink">
                      <span className="block text-xs font-semibold uppercase tracking-wide text-error">
                        The office says
                      </span>
                      {row.rejected_reason ?? "No reason given. Ask the office."}
                    </p>
                    <button
                      type="button"
                      onClick={() => onReshoot(row.document_type)}
                      data-testid="scan-reshoot"
                      className="mt-3 flex min-h-[56px] w-full items-center justify-center gap-2 rounded-card bg-accent px-4 text-lg font-semibold text-accent-ink active:opacity-90"
                    >
                      <Camera size={22} />
                      Shoot it again
                    </button>
                  </div>
                )}

                {status.unsent && (
                  <p className="mt-3 rounded-lg bg-warning-soft px-3 py-3 text-base text-ink">
                    The photos reached the office&rsquo;s store but the send never
                    finished, so nobody is looking at it. Photograph it again.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
