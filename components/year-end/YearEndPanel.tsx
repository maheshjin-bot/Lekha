"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { previousFinancialYearEnd } from "@/lib/utils/period";

type HistoryRow = {
  id: string;
  changedAt: string;
  changedByName: string | null;
};

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function YearEndPanel({
  companyId,
  lockDate,
  bookBeginningDate,
  financialYearStartMonth,
  history,
}: {
  companyId: string;
  lockDate: string | null;
  bookBeginningDate: string | null;
  financialYearStartMonth: number;
  history: HistoryRow[];
}) {
  const router = useRouter();

  // The natural suggestion is the last day of the FY before this one — but
  // only while it is both ahead of any existing lock and on or after the
  // books' own start. A company still in its first financial year (the most
  // common case for a brand-new one) has no completed prior year at all, so
  // that suggestion would fall before book_beginning_date and be rejected on
  // the very first submit. Either way, the field starts blank rather than
  // offering a number that would just bounce off the server.
  const suggestion = previousFinancialYearEnd(financialYearStartMonth);
  const suggestionIsValid =
    (!bookBeginningDate || suggestion >= bookBeginningDate) && (!lockDate || suggestion > lockDate);
  const defaultCloseDate = suggestionIsValid ? suggestion : "";

  const [closeDate, setCloseDate] = useState(defaultCloseDate);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenDate, setReopenDate] = useState("");
  const [reopenFully, setReopenFully] = useState(true);
  const [reopenBusy, setReopenBusy] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);

  async function onClose(e: React.FormEvent) {
    e.preventDefault();
    setCloseBusy(true);
    setCloseError(null);

    const { error } = await createClient().rpc("close_period", {
      p_company_id: companyId,
      p_lock_date: closeDate,
    });

    setCloseBusy(false);
    if (error) {
      setCloseError(error.message);
      return;
    }
    router.refresh();
  }

  async function onReopen(e: React.FormEvent) {
    e.preventDefault();
    setReopenBusy(true);
    setReopenError(null);

    const { error } = await createClient().rpc("reopen_period", {
      p_company_id: companyId,
      // The RPC's default is SQL NULL ("clear the lock entirely"); the
      // generated type models that default as an omittable arg, not a
      // nullable one, so reopening fully means not sending the key at all.
      ...(reopenFully ? {} : { p_new_lock_date: reopenDate }),
    });

    setReopenBusy(false);
    if (error) {
      setReopenError(error.message);
      return;
    }
    setReopenOpen(false);
    router.refresh();
  }

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section className="rounded-lg border border-border bg-surface p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-semibold">Status</h2>
          {bookBeginningDate && (
            <span className="text-xs text-ink-faint">
              Books began {formatDate(bookBeginningDate)}
            </span>
          )}
        </div>

        {lockDate ? (
          <p className="mt-2 text-sm">
            <span className="rounded bg-warning-soft px-2 py-0.5 font-medium text-warning">
              Closed through {formatDate(lockDate)}
            </span>{" "}
            <span className="text-ink-soft">
              — no voucher dated on or before this can be added, edited, or deleted.
            </span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">
            Books are open. Every period can still be edited.
          </p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Close a period</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Closing only moves forward — pick the last date that should be locked.
        </p>
        <form onSubmit={onClose} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Close through</span>
            <input
              type="date"
              required
              value={closeDate}
              onChange={(e) => setCloseDate(e.target.value)}
              className={field}
            />
          </label>
          <button
            type="submit"
            disabled={closeBusy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {closeBusy ? "Closing…" : "Close books"}
          </button>
        </form>
        {closeError && (
          <p className="mt-3 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
            {closeError}
          </p>
        )}
      </section>

      {lockDate && (
        <section className="rounded-lg border border-error/30 bg-error-soft p-5">
          <h2 className="font-semibold text-error">Reopen</h2>
          <p className="mt-1 text-sm text-error/80">
            Moves the lock date back, letting vouchers be entered or edited in
            a period that was already closed. Every use of this is recorded
            in the audit trail below.
          </p>

          {!reopenOpen ? (
            <button
              type="button"
              onClick={() => setReopenOpen(true)}
              className="mt-4 rounded-lg border border-error/40 bg-surface px-4 py-2 text-sm font-medium text-error transition-colors hover:bg-error-soft"
            >
              Reopen…
            </button>
          ) : (
            <form onSubmit={onReopen} className="mt-4 flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={reopenFully}
                  onChange={() => setReopenFully(true)}
                />
                Reopen fully (clear the lock date)
              </label>
              <label className="flex flex-wrap items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={!reopenFully}
                  onChange={() => setReopenFully(false)}
                />
                Move the lock date back to
                <input
                  type="date"
                  required={!reopenFully}
                  disabled={reopenFully}
                  value={reopenDate}
                  max={lockDate}
                  onChange={(e) => setReopenDate(e.target.value)}
                  className={field + " disabled:opacity-50"}
                />
              </label>

              <div className="mt-1 flex gap-2">
                <button
                  type="submit"
                  disabled={reopenBusy}
                  className="rounded-lg bg-error px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {reopenBusy ? "Reopening…" : "Yes, reopen"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReopenOpen(false);
                    setReopenError(null);
                  }}
                  className="rounded-lg border border-border-strong bg-surface px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-2"
                >
                  Cancel
                </button>
              </div>
              {reopenError && (
                <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
                  {reopenError}
                </p>
              )}
            </form>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 font-semibold">Closing history</h2>
        {history.length === 0 ? (
          <p className="text-sm text-ink-faint">No closes or reopens yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="text-ink-soft">
                  {h.changedByName ?? "Someone"} changed the lock date
                </span>
                <span className="shrink-0 tabular-nums text-ink-faint font-mono">
                  {new Date(h.changedAt).toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
