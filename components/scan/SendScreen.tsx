"use client";

import { AlertTriangle, Camera, Check, ClipboardList, CloudOff, RefreshCw } from "lucide-react";

export type SendState = {
  running: boolean;
  total: number;
  /** The page currently in flight. Cleared the moment one fails. */
  currentPage: number | null;
  donePages: number[];
  /** The page the send died on, so it is not left reading "sending…". */
  failedPage: number | null;
  submitting: boolean;
  succeeded: boolean;
  /**
   * The link was down, so the whole document is on this phone's disk waiting
   * for signal. Deliberately a THIRD outcome and not a flavour of `succeeded`:
   * "the office has it" and "this phone has it" are different facts and the
   * shooter has to be able to tell them apart.
   */
  queued: boolean;
  /**
   * Which document went into the queue, so this screen can keep watching it.
   * A "saved on this phone" message that stays on screen while the drain
   * behind it gets the document REFUSED would be the exact lie this whole
   * phase exists to prevent.
   */
  queuedKey: string | null;
  error: string | null;
  /**
   * The server refused this document rather than the link failing, so it will
   * NOT retry on its own and saying "it will go when there is signal" would be
   * a lie. Drives the copy under the error, nothing else.
   */
  permanent: boolean;
};

/**
 * The only screen where waiting happens, so it says what is happening, page by
 * page. On a two-bar connection a five-page document takes a while, and a
 * single indeterminate spinner tells the shooter nothing about whether to keep
 * standing there.
 *
 * On failure it offers Retry, not "start again" — the retry reuses the same
 * document key and skips the pages that already landed (see
 * lib/scan/uploadQueue.ts), so a document that died on page 4 of 5 does not
 * re-upload the first three.
 */
export function SendScreen({
  state,
  onRetry,
  onDone,
  onBack,
  onOpenRecent,
  onOpenQueue,
  queuedRefusal,
}: {
  state: SendState;
  onRetry: () => void;
  onDone: () => void;
  onBack: () => void;
  onOpenRecent: () => void;
  onOpenQueue: () => void;
  /**
   * Non-null once the queue has tried the document this screen queued and the
   * server refused it. Live, because this screen can sit on a counter for
   * minutes while the drain runs behind it.
   */
  queuedRefusal?: string | null;
}) {
  if (state.queued) {
    const refused = Boolean(queuedRefusal);
    return (
      <div className="flex flex-1 flex-col justify-between px-5 pb-8 pt-8">
        <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
          <span
            className={
              "flex h-24 w-24 items-center justify-center rounded-full " +
              (refused ? "bg-error-soft text-error" : "bg-warning-soft text-warning")
            }
          >
            {refused ? (
              <AlertTriangle size={48} strokeWidth={2} />
            ) : (
              <CloudOff size={48} strokeWidth={2} />
            )}
          </span>
          <p className="font-display text-3xl font-semibold text-ink">
            {refused ? "It was not accepted" : "Saved on this phone"}
          </p>
          {/* The whole safety property of phase 4 lives in this paragraph. It
              must never say or imply that the office has it, and it must stop
              promising the document will go by itself the moment that stops
              being true. */}
          <p className="max-w-xs text-base text-ink-soft">
            {refused
              ? `${queuedRefusal} It has NOT reached the office and it will not go by itself. Open what is waiting and deal with it.`
              : "There is no signal, so it has NOT reached the office yet. It is safe here and will go by itself as soon as there is signal, as long as the scanner is open. Carry on photographing."}
          </p>
        </div>
        <div className={"flex gap-3 " + (refused ? "flex-col-reverse" : "flex-col")}>
          <button
            type="button"
            onClick={onDone}
            data-testid="scan-another"
            className="flex min-h-[64px] items-center justify-center gap-2 rounded-card bg-accent px-4 text-xl font-semibold text-accent-ink active:opacity-90"
          >
            <Camera size={24} />
            Next document
          </button>
          <button
            type="button"
            onClick={onOpenQueue}
            data-testid="scan-open-queue"
            className={
              "flex min-h-[56px] items-center justify-center gap-2 rounded-card px-4 text-base font-semibold active:bg-surface-2 " +
              (refused
                ? "border border-error/50 text-error"
                : "border border-border-strong text-ink")
            }
          >
            {refused ? <AlertTriangle size={20} /> : <CloudOff size={20} />}
            See what is waiting
          </button>
        </div>
      </div>
    );
  }

  if (state.succeeded) {
    return (
      <div className="flex flex-1 flex-col justify-between px-5 pb-8 pt-8">
        <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
          <span className="flex h-24 w-24 items-center justify-center rounded-full bg-success-soft text-success">
            <Check size={52} strokeWidth={2.5} />
          </span>
          <p className="font-display text-3xl font-semibold text-ink">Sent for review</p>
          <p className="max-w-xs text-base text-ink-soft">
            The office has it. If they need a better photo it will show up under
            Sent, with the reason.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={onDone}
            data-testid="scan-another"
            className="flex min-h-[64px] items-center justify-center gap-2 rounded-card bg-accent px-4 text-xl font-semibold text-accent-ink active:opacity-90"
          >
            <Camera size={24} />
            Next document
          </button>
          <button
            type="button"
            onClick={onOpenRecent}
            className="flex min-h-[56px] items-center justify-center gap-2 rounded-card border border-border-strong px-4 text-base font-semibold text-ink active:bg-surface-2"
          >
            <ClipboardList size={20} />
            See what I have sent
          </button>
        </div>
      </div>
    );
  }

  const pageNos = Array.from({ length: state.total }, (_, i) => i + 1);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="border-b border-border px-4 py-4">
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
          {state.error ? "It did not all go" : "Sending…"}
        </h1>
        <p className="text-sm text-ink-soft">
          {state.donePages.length} of {state.total} pages through
        </p>
      </header>

      <ul className="flex-1 overflow-y-auto px-4 py-4">
        {pageNos.map((pageNo) => {
          const done = state.donePages.includes(pageNo);
          const active = state.currentPage === pageNo;
          const failed = state.failedPage === pageNo;
          return (
            <li
              key={pageNo}
              className="flex items-center gap-3 border-b border-border py-3 last:border-b-0"
            >
              <span
                className={
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-mono text-sm font-semibold " +
                  (done
                    ? "bg-success-soft text-success"
                    : failed
                      ? "bg-error-soft text-error"
                      : active
                        ? "bg-accent-soft text-accent"
                        : "bg-surface-2 text-ink-faint")
                }
              >
                {done ? <Check size={20} /> : pageNo}
              </span>
              <span className="text-base text-ink">
                Page {pageNo}
                <span
                  className={
                    "ml-2 text-sm " + (failed ? "text-error" : "text-ink-soft")
                  }
                >
                  {done
                    ? "sent"
                    : failed
                      ? "did not go"
                      : active
                        ? "sending…"
                        : "waiting"}
                </span>
              </span>
            </li>
          );
        })}
        {state.submitting && (
          <li className="py-3 text-base text-ink-soft">Handing it to the office…</li>
        )}
      </ul>

      {state.error && (
        <div className="mx-4 mb-3 rounded-card border border-error/40 bg-error-soft px-4 py-3">
          <p className="text-base font-semibold text-error" role="alert">
            {state.error}
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            {state.permanent
              ? "Nothing is lost — the pages are still on this phone — but this will NOT send by itself. The office has not got it."
              : "Nothing is lost. The pages are still on this phone."}
          </p>
        </div>
      )}

      <div
        className="flex flex-col gap-3 border-t border-border bg-surface px-4 pt-4"
        style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          onClick={onRetry}
          disabled={state.running || !state.error}
          data-testid="scan-retry"
          className="flex min-h-[64px] items-center justify-center gap-2 rounded-card bg-accent px-4 text-xl font-semibold text-accent-ink disabled:opacity-40 active:opacity-90"
        >
          <RefreshCw size={22} />
          {state.running ? "Sending…" : "Try again"}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={state.running}
          className="min-h-[52px] rounded-card border border-border-strong px-4 text-base font-semibold text-ink disabled:opacity-40 active:bg-surface-2"
        >
          Back
        </button>
      </div>
    </div>
  );
}
