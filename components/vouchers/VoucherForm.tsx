"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR, sumPaise, toPaise } from "@/lib/utils/currency";

type Ledger = {
  id: string;
  name: string;
  group_name: string | null;
  is_tds_deductee?: boolean;
  default_tds_section?: string | null;
  ldc_rate?: number | null;
  ldc_valid_from?: string | null;
  ldc_valid_to?: string | null;
  ldc_amount_cap?: number | null;
};
type Branch = { id: string; code: string; name: string };
type TdsSection = { section_code: string; description: string; rate_percent: number };

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

type Line = {
  ledgerId: string;
  side: "dr" | "cr";
  amount: string;
  narration: string;
  // Set once a TDS split has been applied to this line, so the hint doesn't
  // immediately re-trigger on the now-smaller net amount and offer to split
  // an already-split line again.
  tdsSplit?: boolean;
};

const emptyLine = (): Line => ({ ledgerId: "", side: "dr", amount: "", narration: "" });

/**
 * An existing voucher being edited. voucherType and branch are absent by
 * design: neither is editable once a number has been allocated, because the
 * number encodes both.
 */
export type ExistingVoucher = {
  id: string;
  voucherNumber: string;
  voucherType: string;
  financialYearLabel: string;
  date: string;
  narration: string;
  reference: string;
  branchId: string;
  lines: Line[];
};

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The TDS a voucher line would attract, if any — informational only. This
 * never checks whether the deductee's annual threshold has been crossed
 * (the app doesn't track running totals per deductee), so it always offers
 * a split; whether to take it is the preparer's call, same as Tally and
 * every other package that doesn't do full deductee-ledger aggregation.
 *
 * Mirrors app_private.round_rupee (0001): TDS rounds to the nearest whole
 * rupee, not the nearest paisa.
 */
function tdsSuggestion(
  ledger: Ledger | undefined,
  amount: number,
  tdsSections: TdsSection[],
  today: string
): { sectionCode: string; rate: number; usingLdc: boolean; tdsAmount: number; netAmount: number } | null {
  if (!ledger?.is_tds_deductee || !ledger.default_tds_section || !(amount > 0)) return null;
  const section = tdsSections.find((s) => s.section_code === ledger.default_tds_section);
  if (!section) return null;

  // A valid, in-window, in-cap LDC overrides the section rate for the whole
  // line amount — the simplification this app makes rather than splitting
  // an amount that crosses the cap into two differently-taxed portions.
  let rate = section.rate_percent;
  let usingLdc = false;
  if (ledger.ldc_rate != null && ledger.ldc_valid_from && ledger.ldc_valid_to) {
    const inWindow = today >= ledger.ldc_valid_from && today <= ledger.ldc_valid_to;
    const inCap = ledger.ldc_amount_cap == null || amount <= ledger.ldc_amount_cap;
    if (inWindow && inCap) {
      rate = ledger.ldc_rate;
      usingLdc = true;
    }
  }

  const tdsAmount = Math.round(amount * rate) / 100;
  if (tdsAmount <= 0) return null;
  return {
    sectionCode: ledger.default_tds_section,
    rate,
    usingLdc,
    tdsAmount,
    netAmount: amount - tdsAmount,
  };
}

export function VoucherForm({
  companyId,
  ledgers,
  branches,
  tdsSections = [],
  existing,
}: {
  companyId: string;
  ledgers: Ledger[];
  branches: Branch[];
  tdsSections?: TdsSection[];
  existing?: ExistingVoucher;
}) {
  const router = useRouter();
  const isEdit = Boolean(existing);
  const [voucherType, setVoucherType] = useState(existing?.voucherType ?? "payment");
  const [branchId, setBranchId] = useState(existing?.branchId ?? branches[0]?.id ?? "");
  const [date, setDate] = useState(existing?.date ?? todayLocal);
  const [narration, setNarration] = useState(existing?.narration ?? "");
  const [reference, setReference] = useState(existing?.reference ?? "");
  const [lines, setLines] = useState<Line[]>(
    existing?.lines.length ? existing.lines : [emptyLine(), emptyLine()]
  );
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
    setLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== i) return l;
        // Picking a different ledger (or re-entering an amount) means any
        // prior split no longer describes this line — let the hint
        // re-evaluate against whatever is here now.
        const clearsSplit = "ledgerId" in patch || "amount" in patch;
        return { ...l, ...patch, ...(clearsSplit ? { tdsSplit: false } : {}) };
      })
    );
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(i: number) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  // Shrinks the deductee's line to the net amount and inserts a new TDS-payable
  // line right after it, on the same side (crediting the deductee less means
  // crediting something else more). The ledger for that new line is left for
  // the preparer to pick — this app doesn't auto-select a "TDS Payable"
  // ledger the way GST auto-posts through tax_ledger_map, since which ledger
  // that should be varies far more than it does for a fixed GST rate account.
  function splitLineForTds(i: number, suggestion: NonNullable<ReturnType<typeof tdsSuggestion>>) {
    setLines((prev) => {
      const line = prev[i];
      const tdsLine: Line = {
        ledgerId: "",
        side: line.side,
        amount: String(suggestion.tdsAmount),
        narration: `TDS ${suggestion.sectionCode}${suggestion.usingLdc ? " (LDC rate)" : ""}`,
      };
      const next = [...prev];
      next[i] = { ...line, amount: String(suggestion.netAmount), tdsSplit: true };
      next.splice(i + 1, 0, tdsLine);
      return next;
    });
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
    const supabase = createClient();

    // Omitted keys fall through to the SQL defaults. supabase-js drops
    // undefined from the body, and PostgREST matches the overload on exactly
    // the names it receives — so these must be genuinely optional in SQL.
    const payload = filled.map((l, i) => ({
      ledger_id: l.ledgerId,
      debit_amount: l.side === "dr" ? Number(l.amount) : 0,
      credit_amount: l.side === "cr" ? Number(l.amount) : 0,
      narration: l.narration.trim() || null,
      line_order: i,
    }));

    const { error } = existing
      ? await supabase.rpc("update_voucher", {
          p_voucher_id: existing.id,
          p_voucher_date: date,
          p_lines: payload,
          p_narration: narration.trim() || undefined,
          p_reference_number: reference.trim() || undefined,
        })
      : await supabase.rpc("create_voucher", {
          p_company_id: companyId,
          p_branch_id: branchId,
          p_voucher_type: voucherType,
          p_voucher_date: date,
          p_lines: payload,
          p_narration: narration.trim() || undefined,
          p_reference_number: reference.trim() || undefined,
        });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    router.push(
      existing ? `/${companyId}/vouchers/${existing.id}` : `/${companyId}/reports/daybook`
    );
    router.refresh();
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
            // The voucher number encodes the type and the branch, so neither
            // can change once one has been allocated. Renumbering silently
            // would break a number already printed on a document.
            disabled={isEdit}
            className={field + (isEdit ? " opacity-60" : "")}
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
            disabled={isEdit}
            className={field + (isEdit ? " opacity-60" : "")}
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
            {lines.map((line, i) => {
              // Only the crediting side: booking a liability to a deductee —
              // a journal or purchase voucher crediting them — is the point
              // TDS is deducted, not a later payment clearing that liability.
              // Skipped once already split, so the hint doesn't immediately
              // reappear on the shrunk remainder and offer to split again.
              const suggestion =
                line.side === "cr" && !line.tdsSplit
                  ? tdsSuggestion(
                      ledgers.find((l) => l.id === line.ledgerId),
                      Number(line.amount),
                      tdsSections,
                      date
                    )
                  : null;

              return (
                <Fragment key={i}>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800/60">
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
                  {suggestion && (
                    <tr className="border-b border-zinc-100 bg-amber-50/60 dark:border-zinc-800/60 dark:bg-amber-950/20">
                      <td colSpan={5} className="px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200">
                        Sec {suggestion.sectionCode}
                        {suggestion.usingLdc ? " (LDC rate)" : ""} at {suggestion.rate}% →
                        TDS {formatINR(suggestion.tdsAmount)}, net{" "}
                        {formatINR(suggestion.netAmount)}. Doesn&rsquo;t check whether
                        this deductee&rsquo;s threshold has been crossed — that&rsquo;s
                        yours to confirm.{" "}
                        <button
                          type="button"
                          onClick={() => splitLineForTds(i, suggestion)}
                          className="ml-1 underline underline-offset-2 hover:text-amber-950 dark:hover:text-amber-100"
                        >
                          Split line
                        </button>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
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

      {isEdit && (
        <p className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          The date must stay inside financial year {existing!.financialYearLabel}.
          This voucher&rsquo;s number belongs to that series and may already be
          printed on a document sent to the other party — the database refuses
          the move rather than renumbering behind you.
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !totals.balanced}
        className="mt-5 rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
      >
        {busy ? "Saving…" : isEdit ? "Save changes" : "Save voucher"}
      </button>
    </form>
  );
}
