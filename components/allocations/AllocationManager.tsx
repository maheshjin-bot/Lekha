"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td, num, trSelected } from "@/components/ui/Table";

export type Settlement = {
  ledger_id: string;
  ledger_name: string;
  voucher_id: string;
  voucher_number: string;
  voucher_type: string;
  voucher_date: string;
  reference_number: string | null;
  narration: string | null;
  settlement_amount: number;
  allocated: number;
  on_account: number;
};

export type Bill = {
  ledger_id: string;
  ledger_name: string;
  /** null on the opening-balance row, which is never allocatable. */
  voucher_id: string | null;
  voucher_number: string | null;
  voucher_type: string | null;
  voucher_date: string;
  due_date: string;
  bill_amount: number;
  allocated: number;
  fifo_applied: number;
  outstanding: number;
  allocatable: number;
  days_overdue: number;
};

export type AllocationRow = {
  settlement_voucher_id: string;
  bill_voucher_id: string;
  party_ledger_id: string;
  amount: number;
};

const field =
  "w-32 rounded-lg border border-border-strong bg-surface px-2 py-1 text-right font-mono text-sm tabular-nums text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function AllocationManager({
  companyId,
  role,
  settlements,
  bills,
  allocations,
}: {
  companyId: string;
  role: "debtor" | "creditor";
  settlements: Settlement[];
  bills: Bill[];
  allocations: AllocationRow[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"money" | "bills">("money");
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const active = settlements.find((s) => s.voucher_id === activeId) ?? null;

  /** What this one settlement already points at, so a revise pre-fills. */
  const mine = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of allocations) {
      if (a.settlement_voucher_id === activeId) m[a.bill_voucher_id] = Number(a.amount);
    }
    return m;
  }, [allocations, activeId]);

  /**
   * The bills this settlement may be spread across: the same party's, minus
   * the opening balance (not a document, so nothing can point at it — the
   * fallback settles it instead). The cap on each line is the bill's own
   * amount less whatever OTHER receipts have already claimed of it.
   */
  const partyBills = useMemo(() => {
    if (!active) return [] as Array<Bill & { cap: number }>;
    return bills
      .filter((b) => b.ledger_id === active.ledger_id && b.voucher_id)
      .map((b) => ({ ...b, cap: round2(b.bill_amount - (b.allocated - (mine[b.voucher_id!] ?? 0))) }))
      .filter((b) => b.cap > 0)
      .sort((a, b) => a.voucher_date.localeCompare(b.voucher_date));
  }, [bills, active, mine]);

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
    setActiveId(s.voucher_id);
    const next: Record<string, string> = {};
    for (const a of allocations) {
      if (a.settlement_voucher_id === s.voucher_id) next[a.bill_voucher_id] = String(Number(a.amount));
    }
    setDraft(next);
  }

  function close() {
    setActiveId(null);
    setDraft({});
  }

  function fill(b: Bill & { cap: number }) {
    const room = round2(Math.min(b.cap, remainder + Number(draft[b.voucher_id!] ?? 0)));
    setDraft((d) => ({ ...d, [b.voucher_id!]: room > 0 ? String(room) : "" }));
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
      close();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
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
      toast.success(`${active.voucher_number} is back on account in full.`);
      close();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const openBills = bills.filter((b) => b.outstanding > 0);
  const grand = round2(openBills.reduce((n, b) => n + b.outstanding, 0));
  const grandAllocated = round2(openBills.reduce((n, b) => n + b.allocated, 0));
  const onAccountTotal = round2(settlements.reduce((n, s) => n + s.on_account, 0));

  const partyOrder = Array.from(new Set(openBills.map((b) => b.ledger_name)));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          onClick={() => setTab("money")}
          className={
            tab === "money"
              ? "rounded-full bg-accent-soft px-3 py-1 font-semibold text-accent"
              : "rounded-full px-3 py-1 text-ink-soft hover:bg-surface-2"
          }
        >
          {role === "debtor" ? "Receipts to apply" : "Payments to apply"}
          {settlements.filter((s) => s.on_account > 0).length > 0 && (
            <span className="ml-2 font-mono text-xs">
              {settlements.filter((s) => s.on_account > 0).length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab("bills")}
          className={
            tab === "bills"
              ? "rounded-full bg-accent-soft px-3 py-1 font-semibold text-accent"
              : "rounded-full px-3 py-1 text-ink-soft hover:bg-surface-2"
          }
        >
          {role === "debtor" ? "Unpaid invoices" : "Unpaid bills"}
        </button>
        <span className="ml-auto text-xs text-ink-faint">
          {formatINR(onAccountTotal, { showZero: true })} on account ·{" "}
          {formatINR(grand, { showZero: true })} outstanding
        </span>
      </div>

      {tab === "money" && (
        <TableContainer>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr>
                <th className={th}>Date</th>
                <th className={th}>Voucher</th>
                <th className={th}>Party</th>
                <th className={th + " text-right"}>Amount</th>
                <th className={th + " text-right"}>Applied</th>
                <th className={th + " text-right"}>On account</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {settlements.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-ink-faint">
                    No {role === "debtor" ? "receipts" : "payments"} to apply.
                  </td>
                </tr>
              )}
              {settlements.map((s) => (
                <tr
                  key={s.voucher_id}
                  className={s.voucher_id === activeId ? trSelected : undefined}
                >
                  <td className={td + " whitespace-nowrap font-mono text-xs"}>{s.voucher_date}</td>
                  <td className={td}>
                    <div className="font-medium">{s.voucher_number}</div>
                    {s.narration && (
                      <div className="mt-0.5 max-w-[28rem] truncate text-xs text-ink-faint">
                        {s.narration}
                      </div>
                    )}
                  </td>
                  <td className={td}>{s.ledger_name}</td>
                  <td className={num}>{formatINR(s.settlement_amount)}</td>
                  <td className={num}>{formatINR(s.allocated, { showZero: true })}</td>
                  <td className={num}>
                    {s.on_account > 0 ? (
                      <Badge tone="warn">{formatINR(s.on_account)}</Badge>
                    ) : (
                      <Badge tone="ok">applied</Badge>
                    )}
                  </td>
                  <td className={td + " text-right"}>
                    <button
                      type="button"
                      onClick={() => (s.voucher_id === activeId ? close() : open(s))}
                      className="rounded-lg border border-border-strong px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2"
                    >
                      {s.voucher_id === activeId ? "Close" : s.allocated > 0 ? "Revise" : "Apply to bills"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}

      {tab === "money" && active && (
        <section className="rounded-[14px] border border-border bg-surface p-4 shadow-card">
          <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-lg font-semibold text-ink">
              {active.voucher_number} · {active.ledger_name}
            </h2>
            <p className="font-mono text-sm tabular-nums text-ink-soft">
              {formatINR(active.settlement_amount)} received ·{" "}
              <span className={overspent ? "font-semibold text-error" : ""}>
                {formatINR(remainder, { showZero: true })} left on account
              </span>
            </p>
          </header>

          {partyBills.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-faint">
              This party has no open document to apply money to. Leaving it unallocated is
              correct — it will be applied to the oldest balance, including the opening
              balance, which nothing can point at directly.
            </p>
          ) : (
            <>
              <TableContainer className="shadow-none">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr>
                      <th className={th}>Bill</th>
                      <th className={th}>Date</th>
                      <th className={th + " text-right"}>Bill amount</th>
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
                          <td className={td + " whitespace-nowrap font-mono text-xs"}>
                            {b.voucher_date}
                          </td>
                          <td className={num}>{formatINR(b.bill_amount)}</td>
                          <td className={num}>
                            {formatINR(b.cap)}
                            {b.fifo_applied > 0 && b.allocated === 0 && (
                              <span
                                className="ml-2 text-[11px] font-normal text-ink-faint"
                                title="Nothing is pointed at this bill; the oldest-first fallback is covering it for now."
                              >
                                inferred
                              </span>
                            )}
                          </td>
                          <td className={num}>
                            <input
                              inputMode="decimal"
                              value={v}
                              onChange={(e) =>
                                setDraft((d) => ({ ...d, [b.voucher_id!]: e.target.value }))
                              }
                              className={field + (over ? " border-error" : "")}
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
                </table>
              </TableContainer>

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
                  onClick={apply}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy ? "Applying…" : "Apply"}
                </button>
                <button
                  type="button"
                  disabled={busy || active.allocated === 0}
                  onClick={clearAll}
                  className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-ink disabled:opacity-40"
                >
                  Put back on account
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="text-sm text-ink-soft underline underline-offset-4"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {tab === "bills" && (
        <TableContainer>
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr>
                <th className={th}>Document</th>
                <th className={th}>Date</th>
                <th className={th}>Due</th>
                <th className={th + " text-right"}>Amount</th>
                <th className={th + " text-right"}>Settled — allocated</th>
                <th className={th + " text-right"}>Settled — inferred</th>
                <th className={th + " text-right"}>Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {openBills.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-ink-faint">
                    Nothing outstanding.
                  </td>
                </tr>
              )}
              {partyOrder.map((partyName) => {
                const rows = openBills.filter((b) => b.ledger_name === partyName);
                const subtotal = round2(rows.reduce((n, b) => n + b.outstanding, 0));
                return (
                  <Fragment key={partyName}>
                    <tr className="bg-surface-2">
                      <td colSpan={6} className="px-4 py-2 font-semibold text-ink">
                        {partyName}
                      </td>
                      <td className={num + " font-semibold"}>{formatINR(subtotal)}</td>
                    </tr>
                    {rows.map((b) => (
                      <tr key={`${b.ledger_id}-${b.voucher_id ?? "opening"}`}>
                        <td className={td}>
                          {b.voucher_number ?? (
                            <span className="text-ink-soft">Opening balance</span>
                          )}
                          {b.days_overdue > 0 && (
                            <span className="ml-2 text-xs text-warning">
                              {b.days_overdue}d overdue
                            </span>
                          )}
                        </td>
                        <td className={td + " whitespace-nowrap font-mono text-xs"}>
                          {b.voucher_date}
                        </td>
                        <td className={td + " whitespace-nowrap font-mono text-xs"}>{b.due_date}</td>
                        <td className={num}>{formatINR(b.bill_amount)}</td>
                        <td className={num}>{formatINR(b.allocated, { showZero: true })}</td>
                        <td className={num + " text-ink-soft"}>
                          {formatINR(b.fifo_applied, { showZero: true })}
                        </td>
                        <td className={num + " font-medium"}>{formatINR(b.outstanding)}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border-strong bg-bg font-semibold">
                <td className="px-4 py-2.5" colSpan={4}>
                  Total — ties to the {role === "debtor" ? "sundry debtors" : "sundry creditors"}{" "}
                  control account
                </td>
                <td className={num}>{formatINR(grandAllocated, { showZero: true })}</td>
                <td className={num} />
                <td className={num}>{formatINR(grand, { showZero: true })}</td>
              </tr>
            </tfoot>
          </table>
        </TableContainer>
      )}

      <p className="text-xs text-ink-faint">
        &ldquo;Allocated&rdquo; is money a person said settles this document.
        &ldquo;Inferred&rdquo; is the oldest-first fallback filling the gap for money nobody has
        applied yet — the opening balance can only ever be settled that way, because it is not a
        document anything can point at. Both add up to the same party total either way.
      </p>
    </div>
  );
}
