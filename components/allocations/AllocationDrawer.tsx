"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { cn } from "@/lib/utils/cn";
import { th, td, num } from "@/components/ui/Table";
import type { Bill } from "@/components/allocations/AllocationManager";

const field =
  "w-28 rounded-lg border border-border-strong bg-surface px-2 py-1 text-right font-mono text-sm tabular-nums text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type DrawerAllocation = { billVoucherId: string; amount: number };

/**
 * Embeddable sibling of AllocationManager (/allocations, 1490/1491) for a
 * voucher/invoice form that hasn't been saved yet: same "which bill does this
 * money settle" question, same get_bill_wise_outstanding cap math, but with
 * nothing to call set_voucher_allocations against yet (that RPC needs a real
 * settlement_voucher_id, which only exists after create_voucher/create_invoice
 * returns one). So this drawer only ever hands its draft back via onConfirm —
 * the caller applies it, in sequence, once its own voucher exists.
 *
 * `amount` is the total the settlement being drafted is for (what the receipt/
 * payment/credit note currently reads) — everything not pointed at a specific
 * bill is reported back as on-account, exactly like AllocationManager's own
 * "left on account" figure.
 */
export function AllocationDrawer({
  companyId,
  partyLedgerId,
  role,
  amount,
  asAt,
  open,
  onClose,
  onConfirm,
}: {
  companyId: string;
  partyLedgerId: string;
  role: "debtor" | "creditor";
  /** The settlement's own total — the cap that allocations + on-account must not exceed. */
  amount: number;
  /** Bills are "open" as at this date; defaults to today. Pass the voucher's own date. */
  asAt?: string;
  open: boolean;
  onClose: () => void;
  /** Hands back the chosen split. Does not post anything — see file header. */
  onConfirm: (allocations: DrawerAllocation[], onAccount: number) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bills, setBills] = useState<Array<Bill & { cap: number }>>([]);
  const [partyName, setPartyName] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const effectiveAsAt = asAt ?? new Date().toISOString().slice(0, 10);

  // Flip into "loading" (and clear the previous fetch's error/draft) the
  // instant the drawer opens or its party/role/date changes — during render,
  // not in the effect below, and guarded by comparing against the key last
  // fetched. Same "seed on key change" pattern as useScreenConfig.ts's own
  // loadingFor check: an unconditional setState at the top of an effect body
  // is exactly what this project's react-hooks/set-state-in-effect rule
  // refuses, and doing it here during render also paints the loading state
  // one render sooner than an effect (which only runs after commit) could.
  // "closed" is a distinct key from any real fetch so that closing and later
  // reopening on the SAME party (going through "closed" in between) is still
  // seen as a key change and triggers a fresh fetch, matching the original
  // effect's behavior of refetching on every `open` transition.
  const fetchKey =
    open && partyLedgerId ? `${partyLedgerId}|${role}|${companyId}|${effectiveAsAt}` : "closed";
  const [fetchingFor, setFetchingFor] = useState(fetchKey);
  if (fetchKey !== fetchingFor) {
    setFetchingFor(fetchKey);
    setLoading(true);
    setError(null);
    setDraft({});
  }

  // Same Escape-to-close as Modal (components/ui/Modal.tsx) — this drawer
  // doesn't reuse that component directly (a slide-over, not a centered
  // dialog) but keeps its interaction contract.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !partyLedgerId) return;
    let cancelled = false;
    const supabase = createClient();
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_bill_wise_outstanding (1490) predates the generated types, same escape hatch as AllocationManager/allocations page.
      .rpc("get_bill_wise_outstanding" as any, {
        p_company_id: companyId,
        p_role: role,
        p_as_at: effectiveAsAt,
      })
      .then(({ data, error: rpcError }) => {
        if (cancelled) return;
        if (rpcError) {
          setError(rpcError.message);
          setBills([]);
          setLoading(false);
          return;
        }
        const rows = ((data ?? []) as unknown as Bill[])
          .filter((b) => b.ledger_id === partyLedgerId && b.voucher_id)
          .map((b) => ({
            ...b,
            bill_amount: Number(b.bill_amount),
            allocated: Number(b.allocated),
            fifo_applied: Number(b.fifo_applied),
            outstanding: Number(b.outstanding),
            // allocatable is already "bill amount less what's already pointed at
            // it" (1490's own definition) — there is no existing settlement
            // voucher here to subtract "mine" from, unlike AllocationManager's
            // revise case, so it doubles directly as this row's cap.
            cap: round2(Number(b.allocatable)),
            days_overdue: Number(b.days_overdue),
          }))
          .filter((b) => b.cap > 0)
          .sort((a, b) => a.voucher_date.localeCompare(b.voucher_date));
        setBills(rows);
        setPartyName(rows[0]?.ledger_name ?? null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveAsAt is derived from asAt each render; including it would refetch every render when asAt is left undefined.
  }, [open, partyLedgerId, role, companyId, asAt]);

  const draftTotal = round2(
    Object.values(draft).reduce((n, v) => {
      const x = Number(v);
      return n + (Number.isFinite(x) ? x : 0);
    }, 0)
  );
  const remainder = round2(amount - draftTotal);
  const overspent = remainder < 0;
  const overLine = bills.some((b) => round2(Number(draft[b.voucher_id!] ?? 0)) > b.cap);

  function fill(b: Bill & { cap: number }) {
    const room = round2(Math.min(b.cap, remainder + Number(draft[b.voucher_id!] ?? 0)));
    setDraft((d) => ({ ...d, [b.voucher_id!]: room > 0 ? String(room) : "" }));
  }

  function confirm() {
    const allocations = Object.entries(draft)
      .map(([billVoucherId, v]) => ({ billVoucherId, amount: round2(Number(v) || 0) }))
      .filter((r) => r.amount > 0);
    onConfirm(allocations, round2(Math.max(0, remainder)));
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-ink/40 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="allocation-drawer-title"
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-surface p-6 shadow-card"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="allocation-drawer-title" className="text-lg font-semibold text-ink">
              Apply to bills
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              {partyName ?? "This party"} · {formatINR(amount)}{" "}
              {role === "debtor" ? "received" : "paid"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        {loading && <p className="py-6 text-center text-sm text-ink-faint">Loading open bills…</p>}

        {!loading && error && <p className="py-6 text-center text-sm text-error">{error}</p>}

        {!loading && !error && bills.length === 0 && (
          <p className="py-6 text-sm text-ink-faint">
            This party has no open document to apply money to. Leaving it unallocated is
            correct — it will be applied to the oldest balance, including the opening balance,
            which nothing can point at directly.
          </p>
        )}

        {!loading && !error && bills.length > 0 && (
          <div className="overflow-x-auto rounded-[14px] border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={th}>Bill</th>
                  <th className={th + " text-right"}>Open</th>
                  <th className={th + " text-right"}>Apply</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => {
                  const v = draft[b.voucher_id!] ?? "";
                  const over = round2(Number(v) || 0) > b.cap;
                  return (
                    <tr key={b.voucher_id}>
                      <td className={td}>
                        <div className="font-medium">{b.voucher_number}</div>
                        <div className="text-xs text-ink-faint">
                          {b.voucher_date}
                          {b.days_overdue > 0 && (
                            <span className="ml-2 text-warning">{b.days_overdue}d overdue</span>
                          )}
                        </div>
                      </td>
                      <td className={num}>{formatINR(b.cap)}</td>
                      <td className={num}>
                        <input
                          inputMode="decimal"
                          value={v}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, [b.voucher_id!]: e.target.value }))
                          }
                          className={cn(field, over && "border-error")}
                          placeholder="0.00"
                          aria-label={`Amount to apply to ${b.voucher_number}`}
                        />
                      </td>
                      <td className={td + " text-right"}>
                        <button
                          type="button"
                          onClick={() => fill(b)}
                          className="text-xs font-medium text-accent underline underline-offset-4"
                        >
                          Full
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className={td + " font-medium"} colSpan={2}>
                    Advance / On account
                  </td>
                  <td colSpan={2} className={num + (overspent ? " font-semibold text-error" : "")}>
                    {formatINR(Math.max(0, remainder), { showZero: true })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {(overspent || overLine) && (
          <p className="mt-3 text-sm text-error">
            {overspent
              ? `That is ${formatINR(Math.abs(remainder))} more than this settlement is for.`
              : "One line is more than that bill still has open."}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={loading || overspent || overLine}
            onClick={confirm}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-ink-soft underline underline-offset-4"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
