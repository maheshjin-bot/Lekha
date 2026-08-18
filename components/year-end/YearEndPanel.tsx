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
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:border-zinc-700 dark:bg-zinc-900";

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
      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-semibold">Status</h2>
          {bookBeginningDate && (
            <span className="text-xs text-zinc-500">
              Books began {formatDate(bookBeginningDate)}
            </span>
          )}
        </div>

        {lockDate ? (
          <p className="mt-2 text-sm">
            <span className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Closed through {formatDate(lockDate)}
            </span>{" "}
            <span className="text-zinc-600 dark:text-zinc-400">
              — no voucher dated on or before this can be added, edited, or deleted.
            </span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Books are open. Every period can still be edited.
          </p>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="font-semibold">Close a period</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
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
            className="rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
          >
            {closeBusy ? "Closing…" : "Close books"}
          </button>
        </form>
        {closeError && (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {closeError}
          </p>
        )}
      </section>

      {lockDate && (
        <section className="rounded-lg border border-red-200 bg-red-50/40 p-5 dark:border-red-900 dark:bg-red-950/20">
          <h2 className="font-semibold text-red-900 dark:text-red-200">Reopen</h2>
          <p className="mt-1 text-sm text-red-800/80 dark:text-red-300/80">
            Moves the lock date back, letting vouchers be entered or edited in
            a period that was already closed. Every use of this is recorded
            in the audit trail below.
          </p>

          {!reopenOpen ? (
            <button
              type="button"
              onClick={() => setReopenOpen(true)}
              className="mt-4 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-800 transition hover:bg-red-50 dark:border-red-800 dark:bg-zinc-900 dark:text-red-300 dark:hover:bg-red-950/40"
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
                  className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600 disabled:opacity-50"
                >
                  {reopenBusy ? "Reopening…" : "Yes, reopen"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReopenOpen(false);
                    setReopenError(null);
                  }}
                  className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
              {reopenError && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
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
          <p className="text-sm text-zinc-500">No closes or reopens yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">
                  {h.changedByName ?? "Someone"} changed the lock date
                </span>
                <span className="shrink-0 tabular-nums text-zinc-500">
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
