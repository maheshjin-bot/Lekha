"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { cn } from "@/lib/utils/cn";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import type { AllocationRow, Bill, Settlement } from "@/components/allocations/AllocationManager";

const field =
  "w-32 rounded-lg border border-border-strong bg-surface px-2 py-1 text-right font-mono text-sm tabular-nums text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

// Duplicated from AllocationManager/AllocationDrawer rather than imported —
// this codebase's own established pattern for these two sibling files
// (each already carries its own copy) rather than exporting a shared util
// neither of those files was written to expose.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Worklist mode for /allocations (1490/1491 follow-up).
 *
 * The rest of this page (AllocationManager) is a browse-everything table: it
 * shows every settlement, applied or not, and a preparer clearing a real
 * backlog has to scan for the ones still needing attention, open one, apply
 * it, then wait for router.refresh() to reload the whole page and re-find
 * their place. This component is the other mode: only what still needs
 * doing, oldest first (the debt that has waited longest gets dealt with
 * first), bucketed by party (so the same customer's receipts get worked
 * together instead of interleaved with everyone else's), one inline panel
 * per row, and a plain running count of what got done.
 *
 * "Oldest first, grouped by party" is read literally as: order the PARTIES
 * by their oldest unworked settlement, then within a party list that
 * party's own settlements oldest first too — so the whole page still reads
 * top-to-bottom as "longest waiting first" while keeping one customer's
 * items together.
 *
 * Finishing a settlement (applied in full, applied in part, or explicitly
 * put back on account) removes it from the list — it has been looked at and
 * decided, which is the point of a worklist, even if money is deliberately
 * left on account. It does NOT trigger router.refresh(): that would re-fetch
 * and re-sort the whole settlements list from the server mid-session, which
 * is exactly the "lose your place" experience this mode exists to avoid.
 * What DOES need a fresh read after every apply is the bill side — the same
 * bill can be shared by several of this party's settlements, so its
 * remaining room has to come from the server's own FIFO-aware arithmetic
 * (app_private.party_document_outstanding), not reimplemented here — so
 * only bills + voucher_allocations are re-fetched, quietly, in place.
 */
export function AllocationWorklist({
  companyId,
  role,
  asAt,
  settlements,
  bills,
  allocations,
}: {
  companyId: string;
  role: "debtor" | "creditor";
  asAt: string;
  settlements: Settlement[];
  bills: Bill[];
  allocations: AllocationRow[];
}) {
  // The starting backlog size, captured once at mount (the parent remounts
  // this component with a fresh `key` whenever role/as-at changes, so this
  // never needs to change on its own) — the "M" in "N of M this session".
  const [total] = useState(() => settlements.filter((s) => round2(s.on_account) > 0).length);

  const [localBills, setLocalBills] = useState(bills);
  const [localAllocations, setLocalAllocations] = useState(allocations);
  // Settlements this session has finished with — applied, part-applied, or
  // explicitly left on account. Removed from the worklist regardless of
  // which, because all three are a real decision, not an omission.
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  // Set aside for later in this sitting without counting as done — lets a
  // preparer skip past one they need more information for and keep moving.
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const pending = useMemo(
    () =>
      settlements
        .filter((s) => round2(s.on_account) > 0 && !doneIds.has(s.voucher_id))
        .slice()
        .sort((a, b) =>
          a.voucher_date === b.voucher_date
            ? a.voucher_number.localeCompare(b.voucher_number)
            : a.voucher_date.localeCompare(b.voucher_date)
        ),
    [settlements, doneIds]
  );

  // Keep something open: land on the oldest not-yet-skipped item, but never
  // fight a preparer who deliberately closed the panel on the last one.
  // Adjusted during render (React's documented pattern for "state derived
  // from a prop/memo that changed") rather than in an effect, so this
  // doesn't cost an extra committed render with a stale panel showing —
  // only react to `pending` itself changing (a new settlement finished or
  // put back), never to `skippedIds` alone, which would re-fight a manual
  // close right after skipping.
  const [pendingSnapshot, setPendingSnapshot] = useState(pending);
  if (pendingSnapshot !== pending) {
    setPendingSnapshot(pending);
    if (!(openId && pending.some((s) => s.voucher_id === openId))) {
      const next = pending.find((s) => !skippedIds.has(s.voucher_id)) ?? pending[0] ?? null;
      setOpenId(next?.voucher_id ?? null);
      setDraft({});
    }
  }

  const active = pending.find((s) => s.voucher_id === openId) ?? null;

  const mine = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of localAllocations) if (a.settlement_voucher_id === openId) m[a.bill_voucher_id] = Number(a.amount);
    return m;
  }, [localAllocations, openId]);

  const partyBills = useMemo(() => {
    if (!active) return [] as Array<Bill & { cap: number }>;
    return localBills
      .filter((b) => b.ledger_id === active.ledger_id && b.voucher_id)
      .map((b) => ({ ...b, cap: round2(b.bill_amount - (b.allocated - (mine[b.voucher_id!] ?? 0))) }))
      .filter((b) => b.cap > 0)
      .sort((a, b) => a.voucher_date.localeCompare(b.voucher_date));
  }, [localBills, active, mine]);

  const draftTotal = useMemo(
    () =>
      round2(
        Object.values(draft).reduce((n, v) => {
          const x = Number(v);
          return n + (Number.isFinite(x) ? x : 0);
        }, 0)
      ),
    [draft]
  );
  const remainder = active ? round2(active.settlement_amount - draftTotal) : 0;
  const overspent = remainder < 0;
  const overLine = active
    ? partyBills.some((b) => round2(Number(draft[b.voucher_id!] ?? 0)) > b.cap)
    : false;

  function open(s: Settlement) {
    setOpenId(s.voucher_id);
    const next: Record<string, string> = {};
    for (const a of localAllocations) {
      if (a.settlement_voucher_id === s.voucher_id) next[a.bill_voucher_id] = String(Number(a.amount));
    }
    setDraft(next);
  }

  function skip() {
    if (!active) return;
    setSkippedIds((s) => new Set(s).add(active.voucher_id));
    const next = pending.find((s) => s.voucher_id !== active.voucher_id && !skippedIds.has(s.voucher_id));
    setOpenId(next?.voucher_id ?? null);
    setDraft({});
  }

  function fill(b: Bill & { cap: number }) {
    const room = round2(Math.min(b.cap, remainder + Number(draft[b.voucher_id!] ?? 0)));
    setDraft((d) => ({ ...d, [b.voucher_id!]: room > 0 ? String(room) : "" }));
  }

  /**
   * Re-reads bills + voucher_allocations only (not settlements) after every
   * apply — so the next settlement in the same party's group sees this
   * one's bite taken out of a shared bill's remaining room, computed by the
   * database's own FIFO-aware function rather than guessed at here.
   */
  async function refreshBillsAndAllocations() {
    const supabase = createClient();
    const [{ data: freshBills, error: billsError }, { data: freshAllocations, error: allocError }] =
      await Promise.all([
        supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_bill_wise_outstanding (1490) predates the generated types, same escape hatch as AllocationManager/the /allocations page.
          .rpc("get_bill_wise_outstanding" as any, { p_company_id: companyId, p_role: role, p_as_at: asAt }),
        supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .from("voucher_allocations" as any)
          .select("settlement_voucher_id, bill_voucher_id, party_ledger_id, amount")
          .eq("company_id", companyId),
      ]);
    if (!billsError && freshBills) {
      setLocalBills(
        (freshBills as unknown as Bill[]).map((b) => ({
          ...b,
          bill_amount: Number(b.bill_amount),
          allocated: Number(b.allocated),
          fifo_applied: Number(b.fifo_applied),
          outstanding: Number(b.outstanding),
          allocatable: Number(b.allocatable),
          days_overdue: Number(b.days_overdue),
        }))
      );
    }
    if (!allocError && freshAllocations) {
      setLocalAllocations(
        (freshAllocations as unknown as AllocationRow[]).map((a) => ({ ...a, amount: Number(a.amount) }))
      );
    }
  }

  async function apply() {
    if (!active) return;
    setBusy(true);
    try {
      const supabase = createClient();
      const payload = Object.entries(draft)
        .map(([bill_voucher_id, v]) => ({ bill_voucher_id, amount: round2(Number(v) || 0) }))
        .filter((r) => r.amount > 0);

      const { data, error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- set_voucher_allocations (1490) predates the generated types.
        .rpc("set_voucher_allocations" as any, {
          p_company_id: companyId,
          p_settlement_voucher_id: active.voucher_id,
          p_party_ledger_id: active.ledger_id,
          p_allocations: payload,
        });

      if (error) {
        toast.error(error.message);
        return;
      }
      const left = Number(data ?? 0);
      toast.success(
        left > 0
          ? `Allocated. ${formatINR(left)} left on account.`
          : `${active.voucher_number} fully allocated.`
      );
      setDoneIds((s) => new Set(s).add(active.voucher_id));
      await refreshBillsAndAllocations();
    } finally {
      setBusy(false);
    }
  }

  async function putOnAccount() {
    if (!active) return;
    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        .rpc("set_voucher_allocations" as any, {
          p_company_id: companyId,
          p_settlement_voucher_id: active.voucher_id,
          p_party_ledger_id: active.ledger_id,
          p_allocations: [],
        });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(`${active.voucher_number} left on account in full.`);
      setDoneIds((s) => new Set(s).add(active.voucher_id));
      if (active.allocated > 0) await refreshBillsAndAllocations();
    } finally {
      setBusy(false);
    }
  }

  // Parties ordered by their own oldest pending settlement — so the page
  // still reads top-to-bottom as "longest waiting first" across parties,
  // while each party's items stay together underneath.
  const partyOrder = useMemo(() => {
    const oldest = new Map<string, { id: string; name: string; date: string }>();
    for (const s of pending) {
      const cur = oldest.get(s.ledger_id);
      if (!cur || s.voucher_date < cur.date) oldest.set(s.ledger_id, { id: s.ledger_id, name: s.ledger_name, date: s.voucher_date });
    }
    return Array.from(oldest.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [pending]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-border bg-surface-2 px-4 py-3">
        <p className="text-sm font-medium text-ink">
          <span className="font-mono tabular-nums">{doneIds.size}</span> of{" "}
          <span className="font-mono tabular-nums">{total}</span> allocated this session
        </p>
        {skippedIds.size > 0 && pending.length > 0 && (
          <p className="text-xs text-ink-faint">{skippedIds.size} set aside for later</p>
        )}
      </div>

      {pending.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-border-strong p-8 text-center text-sm text-ink-faint">
          {total === 0
            ? `No unallocated ${role === "debtor" ? "receipts" : "payments"} — every settlement already points at a bill.`
            : "Every item in this backlog has been worked through this session."}
        </p>
      ) : (
        partyOrder.map((party) => {
          const rows = pending.filter((s) => s.ledger_id === party.id);
          return (
            <section key={party.id} className="space-y-2">
              <h3 className="flex items-baseline gap-2 text-sm font-semibold text-ink">
                {party.name}
                <span className="text-xs font-normal text-ink-faint">
                  {rows.length} to work through
                </span>
              </h3>
              <TableContainer>
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr>
                      <th className={th}>Date</th>
                      <th className={th}>Voucher</th>
                      <th className={th + " text-right"}>Amount</th>
                      <th className={th + " text-right"}>On account</th>
                      <th className={th} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <RowWithPanel
                        key={s.voucher_id}
                        s={s}
                        isOpen={s.voucher_id === openId}
                        busy={busy}
                        onOpen={() => (s.voucher_id === openId ? setOpenId(null) : open(s))}
                        panel={
                          s.voucher_id === openId && active ? (
                            <AllocationPanel
                              active={active}
                              partyBills={partyBills}
                              draft={draft}
                              setDraft={setDraft}
                              remainder={remainder}
                              overspent={overspent}
                              overLine={overLine}
                              busy={busy}
                              onFill={fill}
                              onApply={apply}
                              onPutOnAccount={putOnAccount}
                              onSkip={skip}
                              onClose={() => setOpenId(null)}
                            />
                          ) : null
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </TableContainer>
            </section>
          );
        })
      )}
    </div>
  );
}

function RowWithPanel({
  s,
  isOpen,
  busy,
  onOpen,
  panel,
}: {
  s: Settlement;
  isOpen: boolean;
  busy: boolean;
  onOpen: () => void;
  panel: React.ReactNode;
}) {
  return (
    <>
      <tr className={isOpen ? "bg-accent-soft [&>td:first-child]:shadow-[inset_2px_0_0_var(--accent)]" : undefined}>
        <td className={td + " whitespace-nowrap font-mono text-xs"}>{s.voucher_date}</td>
        <td className={td}>
          <div className="font-medium">{s.voucher_number}</div>
          {s.narration && (
            <div className="mt-0.5 max-w-[28rem] truncate text-xs text-ink-faint">{s.narration}</div>
          )}
        </td>
        <td className={num}>{formatINR(s.settlement_amount)}</td>
        <td className={num}>
          <Badge tone="warn">{formatINR(s.on_account)}</Badge>
        </td>
        <td className={td + " text-right"}>
          <button
            type="button"
            disabled={busy}
            onClick={onOpen}
            className="rounded-lg border border-border-strong px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-40"
          >
            {isOpen ? "Close" : s.allocated > 0 ? "Revise" : "Allocate"}
          </button>
        </td>
      </tr>
      {panel && (
        <tr>
          <td colSpan={5} className="border-b border-border p-0">
            {panel}
          </td>
        </tr>
      )}
    </>
  );
}

function AllocationPanel({
  active,
  partyBills,
  draft,
  setDraft,
  remainder,
  overspent,
  overLine,
  busy,
  onFill,
  onApply,
  onPutOnAccount,
  onSkip,
  onClose,
}: {
  active: Settlement;
  partyBills: Array<Bill & { cap: number }>;
  draft: Record<string, string>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  remainder: number;
  overspent: boolean;
  overLine: boolean;
  busy: boolean;
  onFill: (b: Bill & { cap: number }) => void;
  onApply: () => void;
  onPutOnAccount: () => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  return (
    <div className="border-t border-border bg-surface p-4">
      <p className="mb-3 font-mono text-sm tabular-nums text-ink-soft">
        {formatINR(active.settlement_amount)} received ·{" "}
        <span className={overspent ? "font-semibold text-error" : ""}>
          {formatINR(remainder, { showZero: true })} left on account
        </span>
      </p>

      {partyBills.length === 0 ? (
        <p className="py-4 text-sm text-ink-faint">
          This party has no open document to apply money to. Leaving it unallocated is correct —
          it will be applied to the oldest balance, including the opening balance, which nothing
          can point at directly.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[14px] border border-border">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr>
                <th className={th}>Bill</th>
                <th className={th}>Date</th>
                <th className={th + " text-right"}>Still open</th>
                <th className={th + " text-right"}>Apply</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {partyBills.map((b) => {
                const v = draft[b.voucher_id!] ?? "";
                const over = round2(Number(v) || 0) > b.cap;
                return (
                  <tr key={b.voucher_id}>
                    <td className={td + " font-medium"}>{b.voucher_number}</td>
                    <td className={td + " whitespace-nowrap font-mono text-xs"}>{b.voucher_date}</td>
                    <td className={num}>{formatINR(b.cap)}</td>
                    <td className={num}>
                      <input
                        inputMode="decimal"
                        value={v}
                        onChange={(e) => setDraft((d) => ({ ...d, [b.voucher_id!]: e.target.value }))}
                        className={cn(field, over && "border-error")}
                        placeholder="0.00"
                        aria-label={`Amount to apply to ${b.voucher_number}`}
                      />
                    </td>
                    <td className={td + " text-right"}>
                      <button
                        type="button"
                        onClick={() => onFill(b)}
                        className="text-xs font-medium text-accent underline underline-offset-4"
                      >
                        Full
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(overspent || overLine) && (
        <p className="mt-3 text-sm text-error">
          {overspent
            ? `That is ${formatINR(Math.abs(remainder))} more than came in on this voucher.`
            : "One line is more than that bill still has open."}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || overspent || overLine}
          onClick={onApply}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Applying…" : "Apply and next"}
        </button>
        <button
          type="button"
          disabled={busy || active.allocated === 0}
          onClick={onPutOnAccount}
          className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-ink disabled:opacity-40"
        >
          Put back on account
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSkip}
          className="text-sm text-ink-soft underline underline-offset-4"
        >
          Skip for now
        </button>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-sm text-ink-soft underline underline-offset-4"
        >
          Close
        </button>
      </div>
    </div>
  );
}
