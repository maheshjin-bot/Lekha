"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR, sumPaise, toPaise } from "@/lib/utils/currency";

type Ledger = { id: string; name: string; group_name: string | null };
type Branch = { id: string; code: string; name: string };

const VOUCHER_TYPES = [
  { value: "receipt", label: "Receipt" },
  { value: "payment", label: "Payment" },
  { value: "contra", label: "Contra" },
  { value: "journal", label: "Journal" },
  { value: "sales", label: "Sales" },
  { value: "purchase", label: "Purchase" },
  { value: "credit_note", label: "Credit note" },
  { value: "debit_note", label: "Debit note" },
];

type Line = { ledgerId: string; side: "dr" | "cr"; amount: string; narration: string };

const emptyLine = (): Line => ({ ledgerId: "", side: "dr", amount: "", narration: "" });

export function VoucherForm({
  companyId,
  ledgers,
  branches,
}: {
  companyId: string;
  ledgers: Ledger[];
  branches: Branch[];
}) {
  const router = useRouter();
  const [voucherType, setVoucherType] = useState("payment");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Totals in integer paise. Comparing rupee floats is how a voucher that
  // looks balanced on screen gets rejected by the database.
  const totals = useMemo(() => {
    const dr = sumPaise(
      lines.filter((l) => l.side === "dr").map((l) => toPaise(Number(l.amount)))
    );
    const cr = sumPaise(
      lines.filter((l) => l.side === "cr").map((l) => toPaise(Number(l.amount)))
    );
    return { dr, cr, balanced: dr === cr && dr > 0, difference: dr - cr };
  }, [lines]);

  function update(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(i: number) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  // Enter adds a row from the last one, which is what makes rapid entry
  // possible without reaching for the mouse.
  function onAmountKeyDown(e: React.KeyboardEvent, i: number) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (i === lines.length - 1) addLine();
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const filled = lines.filter((l) => l.ledgerId && Number(l.amount) > 0);
    if (filled.length < 2) {
      setError("A voucher needs at least two lines with a ledger and an amount.");
      return;
    }
    if (!totals.balanced) {
      setError("Debit and credit totals must match before this can be saved.");
      return;
    }

    setBusy(true);
    const { data, error } = await createClient().rpc("create_voucher", {
      p_company_id: companyId,
      p_branch_id: branchId,
      p_voucher_type: voucherType,
      p_voucher_date: date,
      // Omitted keys fall through to the SQL defaults. supabase-js drops
      // undefined from the body, and PostgREST matches the overload on exactly
      // the names it receives — so these must be genuinely optional in SQL.
      p_narration: narration.trim() || undefined,
      p_reference_number: reference.trim() || undefined,
      p_lines: filled.map((l, i) => ({
        ledger_id: l.ledgerId,
        debit_amount: l.side === "dr" ? Number(l.amount) : 0,
        credit_amount: l.side === "cr" ? Number(l.amount) : 0,
        narration: l.narration.trim() || null,
        line_order: i,
      })),
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    router.push(`/${companyId}/reports/daybook`);
    router.refresh();
    void data;
  }

  const field =
    "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <form onSubmit={onSubmit} className="mt-8">
      <div className="grid gap-4 sm:grid-cols-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Type</span>
          <select
            value={voucherType}
            onChange={(e) => setVoucherType(e.target.value)}
            className={field}
          >
            {VOUCHER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Date</span>
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={field}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Branch</span>
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className={field}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            Reference <span className="font-normal text-zinc-500">optional</span>
          </span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Bill / PO no."
            className={field}
          />
        </label>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="px-3 py-2.5 font-medium">Ledger</th>
              <th className="w-24 px-3 py-2.5 font-medium">Dr / Cr</th>
              <th className="w-40 px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="px-3 py-2.5 font-medium">Line narration</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                <td className="px-3 py-2">
                  <select
                    value={line.ledgerId}
                    onChange={(e) => update(i, { ledgerId: e.target.value })}
                    className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 outline-none focus-visible:border-zinc-300 focus-visible:ring-2 focus-visible:ring-emerald-600 dark:focus-visible:border-zinc-700"
                  >
                    <option value="">Select a ledger…</option>
                    {ledgers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={line.side}
                    onChange={(e) => update(i, { side: e.target.value as "dr" | "cr" })}
                    className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 font-medium outline-none focus-visible:border-zinc-300 focus-visible:ring-2 focus-visible:ring-emerald-600 dark:focus-visible:border-zinc-700"
                  >
                    <option value="dr">Dr</option>
                    <option value="cr">Cr</option>
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    inputMode="decimal"
                    value={line.amount}
                    onChange={(e) => update(i, { amount: e.target.value })}
                    onKeyDown={(e) => onAmountKeyDown(e, i)}
                    className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 text-right tabular-nums outline-none focus-visible:border-zinc-300 focus-visible:ring-2 focus-visible:ring-emerald-600 dark:focus-visible:border-zinc-700"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    value={line.narration}
                    onChange={(e) => update(i, { narration: e.target.value })}
                    className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 outline-none focus-visible:border-zinc-300 focus-visible:ring-2 focus-visible:ring-emerald-600 dark:focus-visible:border-zinc-700"
                  />
                </td>
                <td className="px-2 py-2 text-center">
                  {lines.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeLine(i)}
                      aria-label={`Remove line ${i + 1}`}
                      className="rounded px-1.5 py-0.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-zinc-200 bg-zinc-50 text-sm font-medium dark:border-zinc-800 dark:bg-zinc-800/50">
              <td className="px-3 py-2.5" colSpan={2}>
                <button
                  type="button"
                  onClick={addLine}
                  className="rounded px-2 py-1 text-xs text-emerald-800 underline underline-offset-4 dark:text-emerald-400"
                >
                  Add line
                </button>
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                <div>{formatINR(totals.dr / 100, { showZero: true })} Dr</div>
                <div>{formatINR(totals.cr / 100, { showZero: true })} Cr</div>
              </td>
              <td className="px-3 py-2.5" colSpan={2}>
                <span
                  className={
                    "rounded px-2 py-1 text-xs font-medium " +
                    (totals.balanced
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                      : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300")
                  }
                >
                  {totals.balanced
                    ? "Balanced"
                    : `Out by ${formatINR(Math.abs(totals.difference) / 100, { showZero: true })}`}
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <label className="mt-5 flex flex-col gap-1.5">
        <span className="text-sm font-medium">Narration</span>
        <textarea
          rows={2}
          value={narration}
          onChange={(e) => setNarration(e.target.value)}
          placeholder="Being…"
          className={field}
        />
      </label>

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !totals.balanced}
        className="mt-5 rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
      >
        {busy ? "Saving…" : "Save voucher"}
      </button>
    </form>
  );
}
