"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR, sumPaise, toPaise } from "@/lib/utils/currency";
import {
  QuickAddLedgerModal,
  type QuickAddedLedger,
} from "@/components/ledgers/QuickAddLedgerModal";
import { VoucherNumberField } from "@/components/numbering/VoucherNumberField";
import {
  friendlyNumberingError,
  validateManualNumber,
  type VoucherNumberingByBranch,
} from "@/lib/numbering/voucher-numbering";

type Ledger = {
  id: string;
  name: string;
  group_name: string | null;
  // From the ledger's GROUP, same convention as InvoiceForm's own
  // ledger_role — used only to guess which line (if any) is "the party" for
  // vouchers.party_ledger_id, since this generic form has no dedicated
  // Party field the way InvoiceForm does.
  ledger_role?: string | null;
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

/**
 * Server-fetched ledgers first, then anything quick-added in this session the
 * server has not caught up with yet, then sorted by name the way the page's
 * own query ordered them. Keyed on id so that once router.refresh() lands and
 * the same row arrives from both sides, the server's copy — the authoritative
 * one, carrying the TDS columns the insert's narrow select never read back —
 * is the one that survives.
 */
function mergeById<T extends { id: string; name: string }>(server: T[], added: T[]): T[] {
  const known = new Set(server.map((r) => r.id));
  return [...server, ...added.filter((a) => !known.has(a.id))].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

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
  tdsPayableLedgerId = null,
  numbering = {},
  existing,
}: {
  companyId: string;
  ledgers: Ledger[];
  branches: Branch[];
  tdsSections?: TdsSection[];
  tdsPayableLedgerId?: string | null;
  /**
   * The company's numbering policy per branch and voucher type (migration
   * 0725), fetched by the page exactly as ledgers and branches are. Absent on
   * the edit screen, and an empty object everywhere else means "automatic" —
   * which is both the safe default and the true default for every company
   * that has not deliberately changed it.
   */
  numbering?: VoucherNumberingByBranch;
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

  // Numbering (0725). Only ever consulted on a NEW voucher: an issued number
  // is fixed, so the edit screen passes no policy and renders no control.
  const [manualNumber, setManualNumber] = useState("");
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const policy = isEdit ? undefined : numbering[branchId]?.[voucherType];
  const seriesOptions = policy?.mode === "series" ? policy.series : [];
  // Resolved rather than stored, so changing the voucher type or the branch
  // cannot leave a series selected that belongs to the type you just left.
  // An id that is no longer on offer falls back to the default series.
  const effectiveSeriesId = seriesOptions.some((s) => s.id === seriesId)
    ? seriesId
    : (seriesOptions.find((s) => s.isDefault)?.id ?? seriesOptions[0]?.id ?? null);

  // Quick-added ledgers, held locally until the server catches up — this form
  // receives its ledgers as server-fetched props, so a popup cannot select
  // what it just created until the row is in a list this render can see.
  const [addedLedgers, setAddedLedgers] = useState<Ledger[]>([]);
  const [ledgerModalLine, setLedgerModalLine] = useState<number | null>(null);
  const allLedgers = useMemo(() => mergeById(ledgers, addedLedgers), [ledgers, addedLedgers]);

  // A quick-added ledger is never a TDS deductee (the popup does not offer
  // that field), so the section-and-rate columns the hint reads are absent by
  // construction rather than by omission — no split will be suggested against
  // it until it has been given a section on the full ledgers screen, and the
  // refresh below replaces this row with the server's own copy anyway.
  function onLedgerCreated(lineIndex: number, created: QuickAddedLedger) {
    setAddedLedgers((prev) => [
      ...prev,
      { id: created.id, name: created.name, group_name: created.group_name },
    ]);
    setLines((prev) =>
      prev.map((l, idx) =>
        idx === lineIndex ? { ...l, ledgerId: created.id, tdsSplit: false } : l
      )
    );
    router.refresh();
  }

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
  // crediting something else more). Pre-selects the company's "TDS Payable"
  // ledger (0030, wired the same way GST auto-posts through tax_ledger_map)
  // when one was resolved server-side; falls back to blank — still editable
  // and removable exactly as before — if a company somehow predates it.
  function splitLineForTds(i: number, suggestion: NonNullable<ReturnType<typeof tdsSuggestion>>) {
    setLines((prev) => {
      const line = prev[i];
      const tdsLine: Line = {
        ledgerId: tdsPayableLedgerId ?? "",
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
    // Same rule app_private.assert_rule46b_number applies, checked here so the
    // preparer reads a sentence instead of waiting for a round trip to fail.
    if (policy?.mode === "manual") {
      const problem = validateManualNumber(manualNumber);
      if (problem) {
        setError(problem);
        return;
      }
    }

    setBusy(true);
    const supabase = createClient();

    // create_voucher/update_voucher have always accepted p_party_ledger_id
    // (0007) — this generic screen just never passed it, so it defaulted to
    // null on every single voucher ever created through it (Receipt,
    // Payment, Contra, Journal have no dedicated Party field the way
    // InvoiceForm does). Two real, distinct consequences: the Daybook's own
    // Party column reads blank for every one of these voucher types, and
    // get_taggable_receipt_vouchers (service advances, Sec 13(2)/GSTR-1
    // Table 11) filters on party_ledger_id is not null — so its picker can
    // never show a single voucher, no matter how the advance was recorded.
    // Found live (wave 7, 1 Sep 2026).
    //
    // Guessed here the same way a bookkeeper would read the voucher: if
    // exactly one line hits a debtor or creditor ledger, that is the party.
    // Left undefined (not guessed) when zero or more than one line qualifies
    // — a Contra between two bank accounts has no party at all, and a
    // Journal touching two different customers has no single right answer,
    // so this deliberately does not force one.
    const partyCandidates = Array.from(
      new Set(
        filled
          .map((l) => allLedgers.find((x) => x.id === l.ledgerId))
          .filter((l): l is Ledger => l?.ledger_role === "debtor" || l?.ledger_role === "creditor")
          .map((l) => l.id)
      )
    );
    const partyLedgerId = partyCandidates.length === 1 ? partyCandidates[0] : undefined;

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
          // update_voucher's own coalesce(p_party_ledger_id, party_ledger_id)
          // means leaving this undefined preserves whatever the voucher
          // already had — passing a freshly-guessed id here only ever fills
          // in a party this voucher didn't already have one for, including
          // retroactively on an older voucher being edited for any other
          // reason.
          p_party_ledger_id: partyLedgerId,
        })
      : await supabase.rpc("create_voucher", {
          p_company_id: companyId,
          p_branch_id: branchId,
          p_voucher_type: voucherType,
          p_voucher_date: date,
          p_lines: payload,
          p_narration: narration.trim() || undefined,
          p_reference_number: reference.trim() || undefined,
          p_party_ledger_id: partyLedgerId,
          // Exactly one of these, and only when the mode calls for it.
          // next_voucher_number REFUSES a series it was not asked for in
          // automatic mode, and resolve_manual_voucher_number refuses a typed
          // number outside manual mode — both deliberately, so that a UI bug
          // cannot quietly fork a company's GST series. undefined is dropped
          // from the request body by supabase-js and falls through to the SQL
          // default, which is how every other optional argument here works.
          p_voucher_number: policy?.mode === "manual" ? manualNumber.trim() : undefined,
          p_number_series_id:
            policy?.mode === "series" ? (effectiveSeriesId ?? undefined) : undefined,
        });

    if (error) {
      setError(friendlyNumberingError(error.message));
      setBusy(false);
      return;
    }

    router.push(
      existing ? `/${companyId}/vouchers/${existing.id}` : `/${companyId}/reports/daybook`
    );
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

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

        {/* Nothing at all in automatic mode — see VoucherNumberField. */}
        <VoucherNumberField
          policy={policy}
          manualNumber={manualNumber}
          onManualNumberChange={setManualNumber}
          seriesId={effectiveSeriesId}
          onSeriesIdChange={setSeriesId}
        />

        {/* Read-only on purpose. The number is allocated once, at the moment
            the voucher is posted, and may already be printed on a document
            sent to the other party; update_voucher takes no number argument
            at all, so there is nothing here for an input to send. */}
        {isEdit && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Number</span>
            <span className="rounded-lg border border-border bg-bg px-3 py-2 text-sm font-mono text-ink-soft">
              {existing!.voucherNumber}
            </span>
            <span className="text-xs text-ink-faint">Fixed once issued.</span>
          </div>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            Reference <span className="font-normal text-ink-faint">optional</span>
          </span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Bill / PO no."
            className={field}
          />
        </label>
      </div>

      {/* Two renderings of the same `lines` state: a table from sm: up, and
          stacked cards below it. A borderless table cell that relies on
          precise pointer clicks is workable with a mouse but a poor touch
          target, and the table itself needs horizontal scroll under ~640px
          to fit five columns — the exact "desktop-only in practice" gap the
          dossier's own audit (F-12) flagged. Both share suggestionFor() so
          the TDS hint can never disagree between the two views. */}
      {(() => {
        // Only the crediting side: booking a liability to a deductee — a
        // journal or purchase voucher crediting them — is the point TDS is
        // deducted, not a later payment clearing that liability. Skipped once
        // already split, so the hint doesn't immediately reappear on the
        // shrunk remainder and offer to split again.
        function suggestionFor(line: Line) {
          return line.side === "cr" && !line.tdsSplit
            ? tdsSuggestion(
                allLedgers.find((l) => l.id === line.ledgerId),
                Number(line.amount),
                tdsSections,
                date
              )
            : null;
        }

        return (
          <>
            <div className="mt-6 flex flex-col gap-3 sm:hidden">
              {lines.map((line, i) => {
                const suggestion = suggestionFor(line);
                return (
                  <div key={i} className="rounded-lg border border-border bg-surface p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                        Line {i + 1}
                      </span>
                      {lines.length > 2 && (
                        <button
                          type="button"
                          onClick={() => removeLine(i)}
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
                          <select
                            aria-label={`Ledger on line ${i + 1}`}
                            value={line.ledgerId}
                            onChange={(e) => update(i, { ledgerId: e.target.value })}
                            className={field}
                          >
                            <option value="">Select a ledger…</option>
                            {allLedgers.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          onClick={() => setLedgerModalLine(i)}
                          aria-label={`New ledger for line ${i + 1}`}
                          className="shrink-0 rounded-lg border border-border-strong px-2.5 py-2 text-xs text-accent"
                        >
                          + New
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2.5">
                        <label className="flex flex-col gap-1">
                          <span className="text-xs text-ink-faint">Dr / Cr</span>
                          <select
                            value={line.side}
                            onChange={(e) => update(i, { side: e.target.value as "dr" | "cr" })}
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
                            onChange={(e) => update(i, { amount: e.target.value })}
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
                          onChange={(e) => update(i, { narration: e.target.value })}
                          className={field}
                        />
                      </label>
                    </div>
                    {suggestion && (
                      <p className="mt-2.5 rounded-md bg-warning-soft px-2.5 py-2 text-xs text-warning">
                        Sec {suggestion.sectionCode}
                        {suggestion.usingLdc ? " (LDC rate)" : ""} at {suggestion.rate}% →
                        TDS {formatINR(suggestion.tdsAmount)}, net{" "}
                        {formatINR(suggestion.netAmount)}. Doesn&rsquo;t check whether
                        this deductee&rsquo;s threshold has been crossed — that&rsquo;s
                        yours to confirm.{" "}
                        <button
                          type="button"
                          onClick={() => splitLineForTds(i, suggestion)}
                          className="ml-1 underline underline-offset-2 hover:text-warning"
                        >
                          Split line
                        </button>
                      </p>
                    )}
                  </div>
                );
              })}

              <div className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2.5">
                <button
                  type="button"
                  onClick={addLine}
                  className="rounded px-2 py-1 text-xs text-accent underline underline-offset-4"
                >
                  Add line
                </button>
                <span
                  className={
                    "rounded px-2 py-1 text-xs font-medium " +
                    (totals.balanced
                      ? "bg-success-soft text-success"
                      : "bg-warning-soft text-warning")
                  }
                >
                  {totals.balanced
                    ? "Balanced"
                    : `Out by ${formatINR(Math.abs(totals.difference) / 100, { showZero: true })}`}
                </span>
              </div>
              <div className="flex justify-between px-1 text-sm font-medium tabular-nums font-mono">
                <span>{formatINR(totals.dr / 100, { showZero: true })} Dr</span>
                <span>{formatINR(totals.cr / 100, { showZero: true })} Cr</span>
              </div>
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
                    const suggestion = suggestionFor(line);

                    return (
                <Fragment key={i}>
                  <tr className="border-b border-border">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <select
                          aria-label={`Ledger on line ${i + 1}`}
                          value={line.ledgerId}
                          onChange={(e) => update(i, { ledgerId: e.target.value })}
                          className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                        >
                          <option value="">Select a ledger…</option>
                          {allLedgers.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => setLedgerModalLine(i)}
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
                        value={line.side}
                        onChange={(e) => update(i, { side: e.target.value as "dr" | "cr" })}
                        className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 font-medium outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent"
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
                        className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 text-right tabular-nums outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent font-mono"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={line.narration}
                        onChange={(e) => update(i, { narration: e.target.value })}
                        className="w-full rounded border border-transparent bg-transparent px-2 py-1.5 outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
                      />
                    </td>
                    <td className="px-2 py-2 text-center">
                      {lines.length > 2 && (
                        <button
                          type="button"
                          onClick={() => removeLine(i)}
                          aria-label={`Remove line ${i + 1}`}
                          className="rounded px-1.5 py-0.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-soft"
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                  {suggestion && (
                    <tr className="border-b border-border bg-warning-soft">
                      <td colSpan={5} className="px-3 py-1.5 text-xs text-warning">
                        Sec {suggestion.sectionCode}
                        {suggestion.usingLdc ? " (LDC rate)" : ""} at {suggestion.rate}% →
                        TDS {formatINR(suggestion.tdsAmount)}, net{" "}
                        {formatINR(suggestion.netAmount)}. Doesn&rsquo;t check whether
                        this deductee&rsquo;s threshold has been crossed — that&rsquo;s
                        yours to confirm.{" "}
                        <button
                          type="button"
                          onClick={() => splitLineForTds(i, suggestion)}
                          className="ml-1 underline underline-offset-2 hover:text-warning"
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
                  <tr className="border-t border-border bg-bg text-sm font-medium">
                    <td className="px-3 py-2.5" colSpan={2}>
                      <button
                        type="button"
                        onClick={addLine}
                        className="rounded px-2 py-1 text-xs text-accent underline underline-offset-4"
                      >
                        Add line
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-mono">
                      <div>{formatINR(totals.dr / 100, { showZero: true })} Dr</div>
                      <div>{formatINR(totals.cr / 100, { showZero: true })} Cr</div>
                    </td>
                    <td className="px-3 py-2.5" colSpan={2}>
                      <span
                        className={
                          "rounded px-2 py-1 text-xs font-medium " +
                          (totals.balanced
                            ? "bg-success-soft text-success"
                            : "bg-warning-soft text-warning")
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
          </>
        );
      })()}

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
        <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}

      {isEdit && (
        <p className="mt-4 rounded-md border border-border bg-bg px-3 py-2 text-xs text-ink-soft">
          The date must stay inside financial year {existing!.financialYearLabel}.
          This voucher&rsquo;s number belongs to that series and may already be
          printed on a document sent to the other party — the database refuses
          the move rather than renumbering behind you.
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !totals.balanced}
        className="mt-5 w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50 sm:w-auto"
      >
        {busy ? "Saving…" : isEdit ? "Save changes" : "Save voucher"}
      </button>

      {/* No role restriction: a journal line may legitimately hit any ledger
          in the company, so every group is offered. */}
      <QuickAddLedgerModal
        open={ledgerModalLine !== null}
        onClose={() => setLedgerModalLine(null)}
        companyId={companyId}
        title="New ledger"
        description="Enough to post against. TDS, MSME, related-party and the rest live on the ledgers screen."
        onCreated={(created) => {
          if (ledgerModalLine !== null) onLedgerCreated(ledgerModalLine, created);
        }}
      />
    </form>
  );
}
