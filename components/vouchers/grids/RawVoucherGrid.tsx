"use client";

import { Fragment } from "react";
import { formatINR } from "@/lib/utils/currency";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { useGridNav } from "@/components/ui/EntryGrid";

/**
 * The Dr/Cr line grid VoucherForm.tsx (raw-voucher mode) has always rendered
 * inline, pulled out into a standalone component per Recon PART B3b. Ported,
 * not redesigned: every class name, every TDS/GST hint computation and every
 * keyboard behaviour below is copied verbatim from VoucherForm.tsx (the
 * "LIVE EDIT DURING THIS RECON" version read in full for this task) — this
 * file changes WHERE that logic runs, never WHAT it does or what it posts.
 * VoucherForm.tsx itself is untouched; nothing here is wired into it or into
 * any route yet. See rule 5/6 in this wave's task: nothing in this file
 * changes what create_voucher/update_voucher/set_voucher_allocations receive
 * — this component never calls any RPC itself, it only edits an array the
 * shell (VoucherScreen, built separately) turns into that payload.
 *
 * ============================================================================
 * TWO DELIBERATE DEPARTURES FROM RECON PART B3b's LITERAL PROPS-IN LIST
 * ============================================================================
 * 1. `getCellProps` is NOT accepted as a prop here, even though B3b's own
 *    list documents it as one ("shell-owned hook instance"). This file's own
 *    task instructions say, in so many words: "Reuse EntryGrid's useGridNav
 *    exactly as VoucherForm already does" — i.e. call the hook HERE, the way
 *    VoucherForm.tsx's own grid section already does, rather than have the
 *    shell call it and hand down the result. That direct instruction is
 *    followed literally; the shell only needs to supply onAddRow/
 *    onDuplicateRow/onRemoveRow (already in B3b's list) and this component
 *    builds `getCellProps` from them internally, keeping the desktop table's
 *    keyboard wiring self-contained the same way it is today.
 * 2. `onInsertLineAfter` is a NEW prop, not in B3b's enumerated list. The
 *    ported TDS-split functions (splitLineForTds and its two siblings, see
 *    below) don't just patch one existing line the way `onChange` does — they
 *    insert a brand-new line at i+1 (VoucherForm.tsx's own `next.splice(i + 1,
 *    0, tdsLine)`). B3b's Props IN list has no "insert a row at a specific
 *    position" callback, only onChange (patch-in-place) and onAddRow
 *    (append at the very end) — neither fits. Rather than reach past this
 *    component's own state (which it doesn't own — `lines` is a prop) to do
 *    something the given callbacks cannot express, this adds the one missing
 *    primitive the ported logic genuinely needs. REQUIRES the shell to
 *    implement both `onChange` and `onInsertLineAfter` with the functional
 *    `setLines(prev => ...)` form (exactly as VoucherForm.tsx's own `update()`
 *    already does) — a TDS split calls onChange(i, patch) and
 *    onInsertLineAfter(i, newLine) back to back in the same handler, and only
 *    the functional form composes them correctly under React's automatic
 *    batching (the second call must see the first's result, not the
 *    render's stale `lines`).
 *
 * ============================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT RENDER
 * ============================================================================
 * No "Add line" button, no Balanced/Out-by badge, no Dr/Cr totals row. Recon
 * B3's governing decision is explicit: "NO grid mode reports totals 'up' to
 * the shell... A grid mode's only obligation is: given `lines` and a
 * mutation callback, let the user edit lines. It never becomes a second
 * source of truth for money." VoucherForm.tsx's own totals memo (`totals`,
 * lines 368-376 there) needs nothing this component receives, and B3b's own
 * Props IN list carries no `totals` prop — so the combined "Add line +
 * Balanced badge + Dr/Cr total" bar that today sits at the bottom of the
 * mobile card stack and in the desktop table's <tfoot> belongs to the shell,
 * rendered around this component using its own totals useMemo and the same
 * `onAddRow` passed down here. `onAddRow` is still required by this
 * component regardless — it is what Enter-on-the-last-cell (both the mobile
 * card's own handler and the desktop grid's useGridNav) calls to grow the
 * array, independent of whether a visible button exists anywhere.
 */

/**
 * Structurally the same Ledger shape VoucherForm.tsx declares today —
 * re-declared locally rather than imported, the same convention every other
 * file bordering InvoiceForm/VoucherForm already follows (Recon PART A: no
 * file in this codebase imports a type from either form; each re-declares
 * the shape it needs). VoucherScreen's eventual unified Ledger (Recon B1b) is
 * a structural superset of every field read here, so passing it through
 * needs no cast at the call site.
 */
export type Ledger = {
  id: string;
  name: string;
  group_name?: string | null;
  ledger_role?: string | null;
  is_tds_deductee?: boolean;
  default_tds_section?: string | null;
  ldc_rate?: number | null;
  ldc_valid_from?: string | null;
  ldc_valid_to?: string | null;
  ldc_amount_cap?: number | null;
  party_type?: string | null;
  gstin?: string | null;
};

export type TdsSection = { section_code: string; description: string; rate_percent: number };

/** One Dr/Cr line of a raw voucher — byte-identical shape to VoucherForm's own `Line`. */
export type DrCrLine = {
  ledgerId: string;
  side: "dr" | "cr";
  amount: string;
  narration: string;
  /** Set once a TDS split has been applied to this line, so the hint doesn't
   * immediately re-trigger on the now-smaller net amount and offer to split
   * an already-split line again. */
  tdsSplit?: boolean;
};

/** Same rounding convention as AllocationDrawer/VoucherForm — avoids float
 * drift (0.1 + 0.2 !== 0.3) when summing typed rupee amounts. */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The TDS a voucher line would attract, if any — informational only. Ported
 * verbatim from VoucherForm.tsx (see that file's own header comment on this
 * function for the full CBDT-circular reasoning); this copy changes nothing
 * about the math, only where it lives.
 */
function tdsSuggestion(
  ledger: Ledger | undefined,
  amount: number,
  tdsSections: TdsSection[],
  today: string,
  gstComponent = 0
): { sectionCode: string; rate: number; usingLdc: boolean; tdsAmount: number; netAmount: number } | null {
  if (!ledger?.is_tds_deductee || !ledger.default_tds_section || !(amount > 0)) return null;
  const section = tdsSections.find((s) => s.section_code === ledger.default_tds_section);
  if (!section) return null;

  const base = Math.max(0, round2(amount - gstComponent));
  if (!(base > 0)) return null;

  // A valid, in-window, in-cap LDC overrides the section rate for the whole
  // line's TDS base — same simplification VoucherForm.tsx already makes
  // rather than splitting an amount that crosses the cap into two
  // differently-taxed portions.
  let rate = section.rate_percent;
  let usingLdc = false;
  if (ledger.ldc_rate != null && ledger.ldc_valid_from && ledger.ldc_valid_to) {
    const inWindow = today >= ledger.ldc_valid_from && today <= ledger.ldc_valid_to;
    const inCap = ledger.ldc_amount_cap == null || base <= ledger.ldc_amount_cap;
    if (inWindow && inCap) {
      rate = ledger.ldc_rate;
      usingLdc = true;
    }
  }

  const tdsAmount = Math.round(base * rate) / 100;
  if (tdsAmount <= 0) return null;
  return {
    sectionCode: ledger.default_tds_section,
    rate,
    usingLdc,
    tdsAmount,
    netAmount: amount - tdsAmount,
  };
}

/**
 * The mirror-image case (1780 Finding C) — a customer withholding TDS on
 * money owed to us. Ported verbatim from VoucherForm.tsx; see that file's own
 * header comment on this function for why it stays deliberately narrow
 * (party_type = 'both' only) until LedgerManager.tsx grows dedicated
 * customer-side TDS columns.
 */
function tdsReceivableSuggestion(
  ledger: Ledger | undefined,
  amount: number,
  tdsSections: TdsSection[]
): { sectionCode: string; rate: number; tdsAmount: number; grossAmount: number } | null {
  if (
    ledger?.party_type !== "both" ||
    !ledger.is_tds_deductee ||
    !ledger.default_tds_section ||
    !ledger.gstin ||
    !(amount > 0)
  ) {
    return null;
  }
  const section = tdsSections.find((s) => s.section_code === ledger.default_tds_section);
  if (!section || !(section.rate_percent > 0) || section.rate_percent >= 100) return null;

  const grossRaw = amount / (1 - section.rate_percent / 100);
  const tdsAmount = Math.round(grossRaw - amount);
  if (tdsAmount <= 0) return null;
  return {
    sectionCode: ledger.default_tds_section,
    rate: section.rate_percent,
    tdsAmount,
    grossAmount: round2(amount + tdsAmount),
  };
}

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

export type RawVoucherGridProps = {
  lines: DrCrLine[];
  onChange: (index: number, patch: Partial<DrCrLine>) => void;
  /** Append one blank line at the end — the same thing the (shell-owned,
   * not rendered here) "Add line" button and Enter-on-the-last-cell both
   * call. */
  onAddRow: () => void;
  /** Ctrl+D on a focused desktop cell — copy of one line inserted right
   * after it. */
  onDuplicateRow: (index: number) => void;
  /** Ctrl+Delete on a focused desktop cell, or the mobile card's own Remove
   * button. Refuses below 2 rows — the shell's job, matching VoucherForm's
   * own `removeLine`; this component only hides the affordance below 2 rows,
   * it never re-checks the floor itself. */
  onRemoveRow: (index: number) => void;
  /** Inserts `line` immediately after `index` — what a TDS split needs and
   * neither onChange nor onAddRow can express. See this file's header
   * comment for the functional-setState requirement this depends on. */
  onInsertLineAfter: (index: number, line: DrCrLine) => void;
  /** Full ledger rows, for the TDS/GST hint machinery's own lookups
   * (is_tds_deductee, ldc_*, party_type, gstin — none of which
   * `ledgerOptions` below carries). */
  ledgers: Ledger[];
  /** Combobox (F2) options for every ledger-picking line — shell-derived
   * `useMemo` over its own ledgers list, id/label/sublabel(group) shape. */
  ledgerOptions: ComboboxOption[];
  /** Opens the shell's QuickAddLedgerModal for this line — from the "+ New"
   * button (typedText = "") or the Combobox's own "Create <text>" row / Alt+C
   * (typedText = whatever was typed). The modal itself stays shell-owned. */
  onNewLedger: (lineIndex: number, typedText: string) => void;
  tdsSections: TdsSection[];
  tdsPayableLedgerId: string | null;
  /** The eight input/output CGST/SGST/IGST/Cess ledger ids this company's GST
   * registration(s) use — netted out of a TDS base, never confused with the
   * broader ledger_role === "duty_tax" set (which also covers PF/ESI/PT/TCS/
   * RCM/TDS Payable/GST Payable/GST TDS Receivable). */
  gstLedgerIds: string[];
  /** suggestionFor() branches on "receipt"/"journal". */
  voucherType: string;
  /** Used as "today" for the LDC in-window check. */
  date: string;
  /** -1, or the index of the guessed party's line — the shell computes this
   * (it needs `partyLedgerId`, derived from the full `lines` array plus the
   * full ledger list, both more naturally shell-level state). Renders the
   * inline "Apply to bills" affordance on that one row. */
  partyRowIndex: number;
  allocationSummary: { count: number; onAccount: number } | null;
  onOpenAllocation: () => void;
};

export function RawVoucherGrid({
  lines,
  onChange,
  onAddRow,
  onDuplicateRow,
  onRemoveRow,
  onInsertLineAfter,
  ledgers,
  ledgerOptions,
  onNewLedger,
  tdsSections,
  tdsPayableLedgerId,
  gstLedgerIds,
  voucherType,
  date,
  partyRowIndex,
  allocationSummary,
  onOpenAllocation,
}: RawVoucherGridProps) {
  // Enter adds a row from the last one — the mobile cards' own handler.
  // useGridNav's equivalent (below) targets the desktop table's cells
  // specifically; the two renderings share no DOM nodes to wire once instead
  // of twice, exactly as VoucherForm.tsx's own onAmountKeyDown did.
  function onAmountKeyDown(e: React.KeyboardEvent, i: number) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (i === lines.length - 1) onAddRow();
    }
  }

  // F3's EntryGrid, for the desktop table only — reused exactly as
  // VoucherForm.tsx already does, just called from inside this component now
  // instead of the form that used to render these rows inline. Two columns —
  // side=0 (Dr/Cr), amount=1 — covering exactly the two native
  // <select>/<input> cells in that row.
  //
  // The Ledger cell is a Combobox (F2) and is deliberately NOT given a column
  // index: Combobox.tsx does not spread extra props onto its own <input> (no
  // ref/onKeyDown/tabIndex passthrough), so a cell handed to it here would
  // silently register nowhere and never receive a keystroke — Tab still
  // reaches it in its normal DOM position, first in the row, just outside
  // this grid's own arrow-key stepping. Narration is left out for the same
  // reason: a running note, not a value worth arrow-keying row to row.
  const { getCellProps } = useGridNav({
    rowCount: lines.length,
    colCount: 2,
    onAddRow,
    onDuplicateRow,
    onRemoveRow,
  });

  // 1780/1781: the portion of a line's amount that is GST rather than the
  // underlying value, inferred from sibling lines in the SAME voucher posted
  // to one of the eight input/output CGST/SGST/IGST/Cess ledgers this
  // company's GST registration(s) actually use (gstLedgerIds) — zero when
  // none exist.
  function gstComponentFor(i: number) {
    return lines.reduce((sum, l, idx) => {
      if (idx === i || !l.ledgerId || l.ledgerId === tdsPayableLedgerId) return sum;
      if (!gstLedgerIds.includes(l.ledgerId)) return sum;
      const amt = Number(l.amount);
      return Number.isFinite(amt) ? sum + amt : sum;
    }, 0);
  }

  // Three directions live here (1780) — see VoucherForm.tsx's own comment on
  // this function (ported verbatim) for the full reasoning on each branch.
  // Skipped once already split/applied, so the hint doesn't immediately
  // reappear on the changed line and offer to act again.
  function suggestionFor(line: DrCrLine, i: number) {
    if (line.tdsSplit) return null;
    const ledger = ledgers.find((l) => l.id === line.ledgerId);
    const amount = Number(line.amount);

    if (line.side === "cr" && voucherType === "receipt") {
      const receivable = tdsReceivableSuggestion(ledger, amount, tdsSections);
      if (receivable) return { kind: "receivable" as const, ...receivable };
      // Falls through: a receipt voucher crediting an actual vendor
      // (rare — e.g. a refund) still gets the deduction hint below.
    }

    if (line.side === "cr" || (line.side === "dr" && voucherType === "journal")) {
      const deduct = tdsSuggestion(ledger, amount, tdsSections, date, gstComponentFor(i));
      if (deduct) return { kind: "deduct" as const, ...deduct };
    }
    return null;
  }

  // Shrinks the deductee's line to the net amount and inserts a new
  // TDS-payable line right after it, on the same side. Ported from
  // VoucherForm.tsx's splitLineForTds — see this file's header comment for
  // why this now goes through onChange + onInsertLineAfter instead of one
  // setLines call.
  function splitLineForTds(i: number, line: DrCrLine, suggestion: NonNullable<ReturnType<typeof tdsSuggestion>>) {
    const tdsLine: DrCrLine = {
      ledgerId: tdsPayableLedgerId ?? "",
      side: line.side,
      amount: String(suggestion.tdsAmount),
      narration: `TDS ${suggestion.sectionCode}${suggestion.usingLdc ? " (LDC rate)" : ""}`,
    };
    onChange(i, { amount: String(suggestion.netAmount), tdsSplit: true });
    onInsertLineAfter(i, tdsLine);
  }

  // 1780 Finding B's follow-up-journal case — ported from VoucherForm.tsx's
  // splitLineForTdsCarveOut. Unlike splitLineForTds above this does NOT
  // shrink the line to a "net" remainder; it replaces the typed amount
  // outright with just the TDS amount and books the liability on the
  // OPPOSITE side.
  function splitLineForTdsCarveOut(
    i: number,
    line: DrCrLine,
    suggestion: NonNullable<ReturnType<typeof tdsSuggestion>>
  ) {
    const tdsLine: DrCrLine = {
      ledgerId: tdsPayableLedgerId ?? "",
      side: line.side === "dr" ? "cr" : "dr",
      amount: String(suggestion.tdsAmount),
      narration: `TDS ${suggestion.sectionCode}${suggestion.usingLdc ? " (LDC rate)" : ""}`,
    };
    onChange(i, { amount: String(suggestion.tdsAmount), tdsSplit: true });
    onInsertLineAfter(i, tdsLine);
  }

  // 1780 Finding C's mirror case — ported from VoucherForm.tsx's
  // splitLineForTdsReceivable. Grows this line back up to the customer's
  // full (gross) invoice value and inserts a TDS Receivable line on the
  // opposite side for the withheld amount.
  function splitLineForTdsReceivable(
    i: number,
    line: DrCrLine,
    suggestion: NonNullable<ReturnType<typeof tdsReceivableSuggestion>>
  ) {
    const receivableLine: DrCrLine = {
      ledgerId: "",
      side: line.side === "cr" ? "dr" : "cr",
      amount: String(suggestion.tdsAmount),
      narration: `TDS Receivable ${suggestion.sectionCode}`,
    };
    onChange(i, { amount: String(suggestion.grossAmount), tdsSplit: true });
    onInsertLineAfter(i, receivableLine);
  }

  return (
    <>
      {/* Two renderings of the same `lines` prop: stacked cards below
          sm:, a table from sm: up. A borderless table cell that relies on
          precise pointer clicks is workable with a mouse but a poor touch
          target, and the table itself needs horizontal scroll under ~640px
          to fit five columns. Both share suggestionFor() so the TDS hint
          can never disagree between the two views — ported unchanged from
          VoucherForm.tsx. */}
      <div className="mt-6 flex flex-col gap-3 sm:hidden">
        {lines.map((line, i) => {
          const suggestion = suggestionFor(line, i);
          return (
            <div key={i} className="rounded-lg border border-border bg-surface p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                  Line {i + 1}
                </span>
                {lines.length > 2 && (
                  <button
                    type="button"
                    onClick={() => onRemoveRow(i)}
                    className="rounded px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-soft"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-2.5">
                <div className="flex items-end gap-1.5">
                  <label className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-xs text-ink-faint">Ledger</span>
                    <Combobox
                      aria-label={`Ledger on line ${i + 1}`}
                      value={line.ledgerId}
                      onChange={(v) => onChange(i, { ledgerId: v })}
                      options={ledgerOptions}
                      placeholder="Select a ledger…"
                      onCreateNew={(typedText) => onNewLedger(i, typedText)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => onNewLedger(i, "")}
                    aria-label={`New ledger for line ${i + 1}`}
                    className="shrink-0 rounded-lg border border-border-strong px-2.5 py-2 text-xs text-accent"
                  >
                    + New
                  </button>
                </div>
                {i === partyRowIndex && (
                  <div className="flex items-center justify-between gap-2 rounded-md bg-accent-soft/50 px-2.5 py-1.5 text-xs">
                    <span className="text-ink-soft">
                      {allocationSummary
                        ? `${allocationSummary.count} bill${allocationSummary.count === 1 ? "" : "s"} · ${formatINR(allocationSummary.onAccount, { showZero: true })} on account`
                        : "Settling an open bill for this party?"}
                    </span>
                    <button
                      type="button"
                      onClick={onOpenAllocation}
                      className="shrink-0 font-medium text-accent underline underline-offset-2"
                    >
                      {allocationSummary ? "Change" : "Apply to bills"}
                    </button>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-ink-faint">Dr / Cr</span>
                    <select
                      value={line.side}
                      onChange={(e) => onChange(i, { side: e.target.value as "dr" | "cr" })}
                      className={field + " font-medium"}
                    >
                      <option value="dr">Dr</option>
                      <option value="cr">Cr</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-ink-faint">Amount</span>
                    <input
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(e) => onChange(i, { amount: e.target.value })}
                      onKeyDown={(e) => onAmountKeyDown(e, i)}
                      className={field + " text-right tabular-nums font-mono"}
                    />
                  </label>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-ink-faint">
                    Line narration <span className="font-normal">optional</span>
                  </span>
                  <input
                    value={line.narration}
                    onChange={(e) => onChange(i, { narration: e.target.value })}
                    className={field}
                  />
                </label>
              </div>
              {suggestion && suggestion.kind === "deduct" && (
                <p className="mt-2.5 rounded-md bg-warning-soft px-2.5 py-2 text-xs text-warning">
                  Sec {suggestion.sectionCode}
                  {suggestion.usingLdc ? " (LDC rate)" : ""} at {suggestion.rate}% excl. GST →
                  TDS {formatINR(suggestion.tdsAmount)}
                  {line.side === "cr" ? (
                    <>, net {formatINR(suggestion.netAmount)}</>
                  ) : (
                    <>. Already booked gross elsewhere? Carve the TDS out here instead</>
                  )}
                  . Doesn&rsquo;t check whether this deductee&rsquo;s threshold has been
                  crossed — that&rsquo;s yours to confirm.{" "}
                  <button
                    type="button"
                    onClick={() =>
                      line.side === "cr"
                        ? splitLineForTds(i, line, suggestion)
                        : splitLineForTdsCarveOut(i, line, suggestion)
                    }
                    className="ml-1 underline underline-offset-2 hover:text-warning"
                  >
                    {line.side === "cr" ? "Split line" : "Record TDS carve-out"}
                  </button>
                </p>
              )}
              {suggestion && suggestion.kind === "receivable" && (
                <p className="mt-2.5 rounded-md bg-accent-soft/50 px-2.5 py-2 text-xs text-ink-soft">
                  This customer may be withholding TDS: Sec {suggestion.sectionCode} at{" "}
                  {suggestion.rate}% → TDS {formatINR(suggestion.tdsAmount)}. Crediting only the
                  cash received leaves a permanent residual — credit the full{" "}
                  {formatINR(suggestion.grossAmount)} instead and debit TDS Receivable for the
                  difference.{" "}
                  <button
                    type="button"
                    onClick={() => splitLineForTdsReceivable(i, line, suggestion)}
                    className="ml-1 font-medium text-accent underline underline-offset-2"
                  >
                    Gross up for TDS
                  </button>
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 hidden overflow-x-auto rounded-lg border border-border bg-surface sm:block">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-3 py-2.5 font-medium">Ledger</th>
              <th className="w-24 px-3 py-2.5 font-medium">Dr / Cr</th>
              <th className="w-40 px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="px-3 py-2.5 font-medium">Line narration</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const suggestion = suggestionFor(line, i);

              return (
                <Fragment key={i}>
                  <tr className="border-b border-border">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <Combobox
                          aria-label={`Ledger on line ${i + 1}`}
                          value={line.ledgerId}
                          onChange={(v) => onChange(i, { ledgerId: v })}
                          options={ledgerOptions}
                          placeholder="Select a ledger…"
                          onCreateNew={(typedText) => onNewLedger(i, typedText)}
                          className="min-w-0 flex-1"
                        />
                        <button
                          type="button"
                          onClick={() => onNewLedger(i, "")}
                          aria-label={`New ledger for line ${i + 1}`}
                          title="Create a ledger without leaving this voucher"
                          className="shrink-0 rounded px-1.5 py-1 text-xs text-accent underline underline-offset-4"
                        >
                          + New
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        {...getCellProps(i, 0)}
                        aria-label={`Debit or credit on line ${i + 1}`}
                        value={line.side}
                        onChange={(e) => onChange(i, { side: e.target.value as "dr" | "cr" })}
                        className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 font-medium outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <option value="dr">Dr</option>
                        <option value="cr">Cr</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        {...getCellProps(i, 1)}
                        aria-label={`Amount on line ${i + 1}`}
                        inputMode="decimal"
                        value={line.amount}
                        onChange={(e) => onChange(i, { amount: e.target.value })}
                        className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 text-right tabular-nums outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent font-mono"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={line.narration}
                        onChange={(e) => onChange(i, { narration: e.target.value })}
                        className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                      />
                    </td>
                    <td className="px-2 py-2 text-center">
                      {lines.length > 2 && (
                        <button
                          type="button"
                          onClick={() => onRemoveRow(i)}
                          aria-label={`Remove line ${i + 1}`}
                          className="rounded px-1.5 py-0.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-soft"
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                  {suggestion && suggestion.kind === "deduct" && (
                    <tr className="border-b border-border bg-warning-soft">
                      <td colSpan={5} className="px-3 py-1.5 text-xs text-warning">
                        Sec {suggestion.sectionCode}
                        {suggestion.usingLdc ? " (LDC rate)" : ""} at {suggestion.rate}% excl. GST →
                        TDS {formatINR(suggestion.tdsAmount)}
                        {line.side === "cr" ? (
                          <>, net {formatINR(suggestion.netAmount)}</>
                        ) : (
                          <>. Already booked gross elsewhere? Carve the TDS out here instead</>
                        )}
                        . Doesn&rsquo;t check whether this deductee&rsquo;s threshold has been
                        crossed — that&rsquo;s yours to confirm.{" "}
                        <button
                          type="button"
                          onClick={() =>
                            line.side === "cr"
                              ? splitLineForTds(i, line, suggestion)
                              : splitLineForTdsCarveOut(i, line, suggestion)
                          }
                          className="ml-1 underline underline-offset-2 hover:text-warning"
                        >
                          {line.side === "cr" ? "Split line" : "Record TDS carve-out"}
                        </button>
                      </td>
                    </tr>
                  )}
                  {suggestion && suggestion.kind === "receivable" && (
                    <tr className="border-b border-border bg-accent-soft/50">
                      <td colSpan={5} className="px-3 py-1.5 text-xs text-ink-soft">
                        This customer may be withholding TDS: Sec {suggestion.sectionCode} at{" "}
                        {suggestion.rate}% → TDS {formatINR(suggestion.tdsAmount)}. Crediting only
                        the cash received leaves a permanent residual — credit the full{" "}
                        {formatINR(suggestion.grossAmount)} instead and debit TDS Receivable for
                        the difference.{" "}
                        <button
                          type="button"
                          onClick={() => splitLineForTdsReceivable(i, line, suggestion)}
                          className="ml-1 font-medium text-accent underline underline-offset-2"
                        >
                          Gross up for TDS
                        </button>
                      </td>
                    </tr>
                  )}
                  {i === partyRowIndex && (
                    <tr className="border-b border-border bg-bg">
                      <td colSpan={5} className="px-3 py-1.5 text-xs text-ink-soft">
                        {allocationSummary
                          ? `${allocationSummary.count} bill${allocationSummary.count === 1 ? "" : "s"} applied · ${formatINR(allocationSummary.onAccount, { showZero: true })} left on account.`
                          : "Settling an open bill for this party?"}{" "}
                        <button
                          type="button"
                          onClick={onOpenAllocation}
                          className="ml-1 font-medium text-accent underline underline-offset-2"
                        >
                          {allocationSummary ? "Change allocation" : "Apply to bills"}
                        </button>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
