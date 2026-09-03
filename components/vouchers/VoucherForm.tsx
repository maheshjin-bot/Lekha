"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR, sumPaise, toPaise } from "@/lib/utils/currency";
import {
  QuickAddLedgerModal,
  type QuickAddedLedger,
} from "@/components/ledgers/QuickAddLedgerModal";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { useGridNav } from "@/components/ui/EntryGrid";
import { VoucherNumberField } from "@/components/numbering/VoucherNumberField";
import {
  friendlyNumberingError,
  validateManualNumber,
  type VoucherNumberingByBranch,
} from "@/lib/numbering/voucher-numbering";
import { useShortcuts } from "@/lib/keys/useShortcuts";
import { AllocationDrawer, type DrawerAllocation } from "@/components/allocations/AllocationDrawer";
import { SessionStrip, type SessionStripEntry } from "@/components/vouchers/SessionStrip";

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
  // Not yet selected by either vouchers/new or vouchers/[id]/edit (1780) --
  // tdsReceivableSuggestion below is written against them but stays inert
  // (always null) until those two pages add the columns. See that
  // function's own comment.
  party_type?: string | null;
  gstin?: string | null;
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

/** Same rounding convention as AllocationDrawer/AllocationManager — avoids
 * float drift (0.1 + 0.2 !== 0.3) when summing typed rupee amounts. */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The TDS a voucher line would attract, if any — informational only. This
 * never checks whether the deductee's annual threshold has been crossed
 * (the app doesn't track running totals per deductee), so it always offers
 * a split; whether to take it is the preparer's call, same as Tally and
 * every other package that doesn't do full deductee-ledger aggregation.
 *
 * `gstComponent` is the portion of `amount` that is GST rather than the
 * underlying value — CBDT Circular No. 23/2017 (19 Jul 2017) requires
 * Sec 194-series TDS (recodified under Sec 393, Income-tax Act 2025; see
 * 0022) to be computed on the amount EXCLUDING GST wherever GST is
 * indicated separately, not on the GST-inclusive gross a plain journal's
 * party line actually carries — confirmed for services by 23/2017 itself
 * and, on the credit/booking side this form offers the hint for, extended
 * to goods purchases (Sec 194Q) by CBDT Circular No. 13/2021 too. This form
 * has no item-level GST split, so the caller derives `gstComponent` from
 * sibling lines in the same voucher (see gstComponentFor below) — 0 when
 * none exist, which leaves the base as the full typed amount, same as
 * before this parameter existed.
 *
 * Mirrors app_private.round_rupee (0001): TDS rounds to the nearest whole
 * rupee, not the nearest paisa. (The `Math.round(base * rate) / 100` line
 * below actually rounds to the nearest paisa whenever rate has a decimal
 * place — a pre-existing mismatch with that doc comment, not part of this
 * fix; see the report for 1780.)
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
  // line's TDS base — the simplification this app makes rather than
  // splitting an amount that crosses the cap into two differently-taxed
  // portions. The cap itself is on the TDS base (the amount TDS actually
  // applies to), not the GST-inclusive line total, so it is tested against
  // `base` too.
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
 * The mirror-image case (1780 Finding C): a CUSTOMER withholding TDS on
 * money they owe us calls for crediting them the full (gross) invoice value
 * and debiting a TDS Receivable line for the withheld amount — never
 * crediting them only for the cash actually received, which strands a
 * permanent, uncollectible residual on their ledger (the same failure shape
 * tdsSuggestion above exists to prevent on the payable side).
 *
 * Deliberately narrow, by necessity rather than choice: ledgers.
 * is_tds_deductee and default_tds_section are the VENDOR-direction fields,
 * and LedgerManager.tsx (out of this file's scope) nulls default_tds_section
 * outright whenever is_tds_deductee is false — so a plain customer ledger
 * never carries a section here to reuse, and this form has no way to know
 * what rate a given customer might withhold at. The one ledger shape where a
 * real, already-on-file section CAN safely be reused is one recorded as
 * BOTH a supplier and a customer (party_type = 'both'): the section already
 * on file for deducting FROM them is, in practice, the same section that
 * would apply to the reverse relationship. A pure customer has nothing on
 * file to borrow, so this intentionally returns null for one rather than
 * guessing a rate. Closing that gap for good needs its own
 * is_tds_deductor/customer-section columns plus a LedgerManager.tsx UI for
 * them — schema and form work outside this task's owned files.
 *
 * It also needs `ledgers.gstin` and `.party_type`, which the two pages that
 * feed this form's `ledgers` prop (vouchers/new, vouchers/[id]/edit — both
 * out of scope here) do not currently select; until they do, both fields
 * are always undefined and this safely always returns null. That select-list
 * addition is the minimum viable next step to actually light this up.
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

  // `amount` here is the (buggy-if-left-alone) net cash this line already
  // credits the customer for -- grossing it back up to the invoice value is
  // the inverse of tdsSuggestion's deduction, not a re-run of it.
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
  // AppShell's Alt+R (receipt) global shortcut lands here via
  // /vouchers/new?type=receipt — a `type` query param, read once on mount,
  // that preselects the right option in the type selector below instead of
  // always opening on "Payment". Only a fresh /new (never an edit, which
  // already has its own real voucherType) honours it, and only when the
  // value is one this form actually knows — an unrecognised or absent param
  // falls back to the pre-existing "payment" default exactly as before this
  // was added.
  const searchParams = useSearchParams();
  const typeParam = searchParams.get("type");
  const initialVoucherType =
    !isEdit && typeParam && VOUCHER_TYPES.some((t) => t.value === typeParam) ? typeParam : "payment";
  const [voucherType, setVoucherType] = useState(existing?.voucherType ?? initialVoucherType);
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
  // Set only when the modal was opened FROM a Combobox's own "Create <text>"
  // row / Alt+C, carrying whatever the preparer had already typed there
  // (Combobox's own header comment names this exact hand-off: "a prefill.name
  // this component's typed text drops straight into"). Left empty when
  // opened from the plain "+ New" button beside the field, so that button
  // keeps opening the same blank popup it always has — QuickAddLedgerModal
  // renders nine extra address/bank fields whenever ANY prefill is passed
  // (see its own header), which is worth paying only when there is
  // something to seed them with.
  const [ledgerModalPrefillName, setLedgerModalPrefillName] = useState("");
  const allLedgers = useMemo(() => mergeById(ledgers, addedLedgers), [ledgers, addedLedgers]);

  // Combobox (F2) options for every ledger-picking line — label is what gets
  // searched/matched first, sublabel (the ledger's group) is what breaks a
  // tie between two same-named or similarly-named ledgers in different
  // groups, same as the group column LedgerManager's own table shows.
  const ledgerOptions = useMemo<ComboboxOption[]>(
    () => allLedgers.map((l) => ({ id: l.id, label: l.name, sublabel: l.group_name })),
    [allLedgers]
  );

  function openLedgerCreate(lineIndex: number, typedText: string) {
    setLedgerModalLine(lineIndex);
    setLedgerModalPrefillName(typedText.trim());
  }

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

  // Lines with both a ledger and a positive amount — the same filter
  // onSubmit's payload-builder applies, hoisted up here so the party guess
  // below and the submit handler read one shared definition rather than two
  // that could quietly drift apart.
  const filled = useMemo(() => lines.filter((l) => l.ledgerId && Number(l.amount) > 0), [lines]);

  // The same single-debtor-or-creditor-line guess onSubmit already made for
  // vouchers.party_ledger_id (see that comment for the full reasoning) —
  // hoisted here too, because the allocation drawer below needs to know
  // "is there a party on this voucher at all" while the user is still
  // editing it, not only once they hit save.
  const partyLedgerId = useMemo(() => {
    const candidates = Array.from(
      new Set(
        filled
          .map((l) => allLedgers.find((x) => x.id === l.ledgerId))
          .filter((l): l is Ledger => l?.ledger_role === "debtor" || l?.ledger_role === "creditor")
          .map((l) => l.id)
      )
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }, [filled, allLedgers]);
  const partyLedger = partyLedgerId ? allLedgers.find((l) => l.id === partyLedgerId) : undefined;

  // Bill-wise settlement only ever applies to a Receipt or a Payment — a
  // contra or journal entry between two ledgers is not "money received from
  // or paid to a party against specific bills" even on the rare occasion one
  // of its lines happens to hit a debtor/creditor ledger (F7's own recon
  // names this exact trap: this form's "sales"/"purchase"/"credit_note"/
  // "debit_note" options are a separate generic Dr/Cr code path from
  // InvoiceForm's own item-based one and must not trigger this on a string
  // match alone).
  const canAllocate =
    (voucherType === "receipt" || voucherType === "payment") && partyLedger !== undefined;

  // What this settlement is actually FOR, from the party's own side — the sum
  // of just its own line(s), not the voucher's whole Dr or Cr total (which,
  // on a voucher touching a bank-charges or rounding line alongside the
  // party, would overstate what money actually moved against that party's
  // bills). This is the cap AllocationDrawer enforces (F6: "amount" is the
  // settlement's own total).
  const partyAmount = useMemo(() => {
    if (!partyLedgerId) return 0;
    return round2(
      sumPaise(
        filled.filter((l) => l.ledgerId === partyLedgerId).map((l) => toPaise(Number(l.amount)))
      ) / 100
    );
  }, [filled, partyLedgerId]);

  // The bill allocation chosen in the drawer, held locally exactly like
  // AllocationDrawer's own header says a not-yet-saved caller must: nothing
  // is posted until this voucher exists, so set_voucher_allocations can only
  // ever be the SECOND call, once create_voucher has returned a real id.
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [pendingAllocations, setPendingAllocations] = useState<DrawerAllocation[]>([]);
  const [allocationSummary, setAllocationSummary] = useState<{ count: number; onAccount: number } | null>(
    null
  );
  // The exact (party, amount) pair the pending pick above was drawn up
  // against. Compared below on every render so that changing the party (by
  // editing which line holds it) or the amount actually settled — after the
  // drawer has already been closed — silently drops a now-stale pick instead
  // of letting an over-cap or wrong-party allocation ride through to save.
  const [allocationLockKey, setAllocationLockKey] = useState<string | null>(null);
  const currentAllocationKey = canAllocate ? `${partyLedgerId}:${partyAmount}` : null;
  // Done during render (not in a useEffect): calling setState synchronously
  // at the top of an effect body is exactly what this project's
  // react-hooks/set-state-in-effect rule refuses, and the check above is
  // already a pure comparison of two render-time values — see
  // InvoiceForm.tsx's matching allocationSyncKey check for the same pattern.
  if (allocationLockKey !== null && allocationLockKey !== currentAllocationKey) {
    setPendingAllocations([]);
    setAllocationSummary(null);
    setAllocationLockKey(null);
  }

  function onAllocationConfirm(allocations: DrawerAllocation[], onAccount: number) {
    setPendingAllocations(allocations);
    setAllocationSummary({ count: allocations.length, onAccount });
    setAllocationLockKey(currentAllocationKey);
    setAllocationOpen(false);
  }

  // Which line, if any, is the guessed party — the row the "Apply to bills"
  // affordance attaches to below, in both the mobile and desktop renderings.
  // findIndex rather than a boolean per row: two lines could in principle
  // share the same ledger id, and the control should appear exactly once.
  const partyRowIndex = canAllocate ? lines.findIndex((l) => l.ledgerId === partyLedgerId) : -1;

  // Save-and-new session strip (F4/F7's "thirty bills in one sitting" case),
  // /new flow only — editing an existing voucher has no "session" of freshly
  // entered ones to show. Append-only for the life of the screen, exactly as
  // SessionStrip's own header requires.
  const [sessionEntries, setSessionEntries] = useState<SessionStripEntry[]>([]);

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

  // Ctrl+D on the desktop grid (below) — a copy of one line inserted right
  // after it, tdsSplit included, so a duplicated already-split line does not
  // immediately re-offer the split it just got.
  function duplicateLine(i: number) {
    setLines((prev) => [...prev.slice(0, i + 1), { ...prev[i] }, ...prev.slice(i + 1)]);
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

  // 1780 Finding B's follow-up-journal case: the deductee was already
  // credited in full elsewhere (typically via Invoices, which never
  // withholds TDS), so unlike splitLineForTds above this does NOT shrink the
  // line to a "net" remainder — there is no second, already-posted net
  // figure to preserve here. It replaces the typed amount outright with just
  // the TDS amount and books the liability on the OPPOSITE side, since a
  // plain two-line carve-out (Dr deductee / Cr TDS Payable) needs both legs
  // equal to the TDS amount, not split across net + TDS on the same side.
  function splitLineForTdsCarveOut(
    i: number,
    suggestion: NonNullable<ReturnType<typeof tdsSuggestion>>
  ) {
    setLines((prev) => {
      const line = prev[i];
      const tdsLine: Line = {
        ledgerId: tdsPayableLedgerId ?? "",
        side: line.side === "dr" ? "cr" : "dr",
        amount: String(suggestion.tdsAmount),
        narration: `TDS ${suggestion.sectionCode}${suggestion.usingLdc ? " (LDC rate)" : ""}`,
      };
      const next = [...prev];
      next[i] = { ...line, amount: String(suggestion.tdsAmount), tdsSplit: true };
      next.splice(i + 1, 0, tdsLine);
      return next;
    });
  }

  // 1780 Finding C's mirror case: grows this line back up to the customer's
  // full (gross) invoice value, clearing their ledger in full, and inserts a
  // TDS Receivable line on the opposite side for the withheld amount. Blank
  // ledger, same fallback convention as splitLineForTds's own TDS Payable
  // line above — this form has no resolved TDS Receivable ledger id to
  // pre-select.
  function splitLineForTdsReceivable(
    i: number,
    suggestion: NonNullable<ReturnType<typeof tdsReceivableSuggestion>>
  ) {
    setLines((prev) => {
      const line = prev[i];
      const receivableLine: Line = {
        ledgerId: "",
        side: line.side === "cr" ? "dr" : "cr",
        amount: String(suggestion.tdsAmount),
        narration: `TDS Receivable ${suggestion.sectionCode}`,
      };
      const next = [...prev];
      next[i] = { ...line, amount: String(suggestion.grossAmount), tdsSplit: true };
      next.splice(i + 1, 0, receivableLine);
      return next;
    });
  }

  // Enter adds a row from the last one, which is what makes rapid entry
  // possible without reaching for the mouse. Kept as a standalone handler for
  // the sm:hidden mobile cards below — useGridNav's own equivalent (next)
  // targets the desktop table's cells specifically, and the two renderings
  // share no DOM nodes to wire once instead of twice.
  function onAmountKeyDown(e: React.KeyboardEvent, i: number) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (i === lines.length - 1) addLine();
    }
  }

  // F3's EntryGrid, for the desktop table only. Two columns — side=0 (Dr/Cr),
  // amount=1 — covering exactly the two native <select>/<input> cells in that
  // row; Enter on the last row's amount cell (col 1) reaches onAddRow the
  // same way onAmountKeyDown does for the mobile cards above, so the two
  // renderings agree on when a new line appears even though only one of them
  // goes through this hook.
  //
  // The Ledger cell is a Combobox (F2) and is deliberately NOT given a column
  // index: Combobox.tsx does not spread extra props onto its own <input> (no
  // ref/onKeyDown/tabIndex passthrough), so a cell handed to it here would
  // silently register nowhere and never receive a keystroke — Tab still
  // reaches it in its normal DOM position, first in the row, just outside
  // this grid's own arrow-key stepping. Narration is left out for the same
  // reason InvoiceForm's own convention leaves its trailing free-text
  // "description" cell out: a running note, not a value worth arrow-keying
  // row to row.
  const { getCellProps } = useGridNav({
    rowCount: lines.length,
    colCount: 2,
    onAddRow: addLine,
    onDuplicateRow: duplicateLine,
    onRemoveRow: removeLine,
  });

  // What the session-strip pill under a save-and-new should call this
  // voucher's "party" column — the guessed party's own name when there is
  // one, falling back to every filled line's ledger name (a Contra or
  // Journal has no single party, but "Cash / Bank OD" still says more than
  // a blank pill would).
  function sessionPartyLabel(): string {
    if (partyLedger) return partyLedger.name;
    const names = filled
      .map((l) => allLedgers.find((x) => x.id === l.ledgerId)?.name)
      .filter((n): n is string => Boolean(n));
    return names.join(" / ") || "—";
  }

  /**
   * The one save path both the submit button and both keyboard shortcuts
   * below go through. `mode` is the only thing that differs at the end:
   * "close" leaves this screen the way the form always has (an edit goes
   * back to the voucher, a new one goes to the daybook); "new" — only ever
   * requested for a fresh voucher, never mid-edit — clears the form back to
   * a blank one, keeping Type/Date/Branch, and drops a pill onto the session
   * strip so the last several saves stay one click away without a trip
   * through a list screen.
   */
  async function performSave(mode: "new" | "close") {
    setError(null);

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

    // create_voucher/update_voucher have always accepted p_party_ledger_id
    // (0007) — this generic screen just never passed it, so it defaulted to
    // null on every single voucher ever created through it (Receipt,
    // Payment, Contra, Journal have no dedicated Party field the way
    // InvoiceForm does). Two real, distinct consequences: the Daybook's own
    // Party column reads blank for every one of these voucher types, and
    // get_taggable_receipt_vouchers (service advances, Sec 13(2)/GSTR-1
    // Table 11) filters on party_ledger_id is not null — so its picker can
    // never show a single voucher, no matter how the advance was recorded.
    // Found live (wave 7, 1 Sep 2026). partyLedgerId is the same guess,
    // hoisted above so the allocation drawer can see it while still editing.
    const { data, error: saveError } = existing
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

    if (saveError) {
      setError(friendlyNumberingError(saveError.message));
      setBusy(false);
      return;
    }

    const voucherId = existing ? existing.id : (data as unknown as string);

    // Bill allocation, ALWAYS the second call, only once create_voucher has
    // returned a real id for set_voucher_allocations to point at (F6/rule 6:
    // two calls in sequence, never one atomic RPC). Exactly the same
    // non-catastrophic handling InvoiceForm's ship-to write uses: the
    // voucher itself is already real by this point, so a failure here is
    // reported, not treated as a failed save — re-submitting the form would
    // raise a second voucher.
    if (pendingAllocations.length > 0 && partyLedgerId) {
      const { error: allocError } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- set_voucher_allocations (1490) predates the generated types.
        .rpc("set_voucher_allocations" as any, {
          p_company_id: companyId,
          p_settlement_voucher_id: voucherId,
          p_party_ledger_id: partyLedgerId,
          p_allocations: pendingAllocations.map((a) => ({
            bill_voucher_id: a.billVoucherId,
            amount: a.amount,
          })),
        });
      if (allocError) {
        toast.error(
          `The voucher was saved, but its bill allocation was not: ${allocError.message}. Open Reports → Allocations to apply it there instead.`
        );
      }
    }

    if (mode === "new") {
      // Best-effort: a failure here (RLS hiccup, a dropped connection) only
      // costs the pill's own voucher-number label, never the voucher that
      // was already posted above.
      const { data: createdRow } = await supabase
        .from("vouchers")
        .select("voucher_number")
        .eq("id", voucherId)
        .maybeSingle();

      setSessionEntries((prev) => [
        ...prev,
        {
          id: voucherId,
          number: createdRow?.voucher_number ?? "—",
          party: sessionPartyLabel(),
          amount: totals.dr / 100,
          href: `/${companyId}/vouchers/${voucherId}`,
        },
      ]);

      // Back to a blank form, Type/Date/Branch kept exactly as F5's task
      // asks — everything else (lines, narration, reference, the manual
      // number, any allocation drawn up) belongs to the voucher just saved,
      // not the next one.
      setLines([emptyLine(), emptyLine()]);
      setNarration("");
      setReference("");
      setManualNumber("");
      setPendingAllocations([]);
      setAllocationSummary(null);
      setAllocationLockKey(null);
      setBusy(false);
      return;
    }

    router.push(
      existing ? `/${companyId}/vouchers/${existing.id}` : `/${companyId}/reports/daybook`
    );
    router.refresh();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await performSave("close");
  }

  // Tally's own PgUp/PgDn, via F5's get_adjacent_voucher — edit mode only,
  // since a not-yet-saved voucher on /new has no place in that ordering to
  // move from. Same-type by the RPC's own default, matching what a preparer
  // flipping through a stack of receipts (say) actually wants to see next.
  async function goAdjacent(direction: "prev" | "next") {
    if (!existing || busy) return;
    const supabase = createClient();
    const { data, error: rpcError } = await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_adjacent_voucher (F5) predates the generated types.
      .rpc("get_adjacent_voucher" as any, {
        p_company_id: companyId,
        p_voucher_id: existing.id,
        p_direction: direction,
      });
    if (rpcError) {
      toast.error(rpcError.message);
      return;
    }
    const row = ((data ?? []) as unknown as Array<{ id: string }>)[0];
    if (!row) {
      toast(
        direction === "prev"
          ? "This is the first voucher of its type."
          : "This is the last voucher of its type."
      );
      return;
    }
    router.push(`/${companyId}/vouchers/${row.id}/edit`);
    router.refresh();
  }

  // F1's accelerators. Every combo here duplicates a control already visible
  // on screen below (the Save/Save & new buttons, the Previous/Next buttons
  // in edit mode) — see useShortcuts.ts's own header for why that is a hard
  // rule, not a nicety. mod+s/mod+shift+s resolve to Ctrl on Windows/Linux
  // and Cmd on a Mac (registry.ts's own "mod" abstraction) rather than being
  // pinned to "ctrl+s" literally, so the same binding is correct on both.
  //
  // In edit mode there is no "new" to save into, so mod+s collapses onto the
  // same single Save action mod+shift+s already performs — both still fire,
  // both still point at the one reachable button, neither is a dead combo.
  useShortcuts("voucher-form", [
    {
      combo: "mod+s",
      label: isEdit ? "Save" : "Save & new",
      handler: () => {
        if (!busy) void performSave(isEdit ? "close" : "new");
      },
    },
    {
      combo: "mod+shift+s",
      label: "Save & close",
      handler: () => {
        if (!busy) void performSave("close");
      },
    },
    ...(isEdit
      ? [
          {
            combo: "alt+ArrowUp",
            label: "Previous voucher",
            handler: () => void goAdjacent("prev"),
          },
          {
            combo: "alt+ArrowDown",
            label: "Next voucher",
            handler: () => void goAdjacent("next"),
          },
        ]
      : []),
  ]);

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <form onSubmit={onSubmit} className="mt-8">
      {/* F5's get_adjacent_voucher, company-wide Tally PgUp/PgDn — the
          visible control Alt+Up/Alt+Down (registered above) duplicates, per
          useShortcuts.ts's own rule that a shortcut is never the only way to
          reach an action. */}
      {isEdit && (
        <div className="mb-5 flex items-center gap-2 print:hidden">
          <button
            type="button"
            onClick={() => goAdjacent("prev")}
            title="Previous voucher of this type (Alt+↑)"
            className="rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            ← Previous
          </button>
          <button
            type="button"
            onClick={() => goAdjacent("next")}
            title="Next voucher of this type (Alt+↓)"
            className="rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            Next →
          </button>
        </div>
      )}

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
        // 1780: the portion of a line's amount that is GST rather than the
        // underlying value, inferred from sibling lines in the SAME voucher
        // posted to a "duty_tax"-role ledger (Input/Output CGST/SGST/IGST/
        // Cess — see 0006's seed_gst_ledgers) — zero when none exist. The
        // TDS Payable ledger itself also lives under Duties & Taxes (0030)
        // and is excluded by id, not role, so an already-split OTHER line's
        // TDS leg is never mistaken for GST and netted out of this one.
        function gstComponentFor(i: number) {
          return lines.reduce((sum, l, idx) => {
            if (idx === i || !l.ledgerId || l.ledgerId === tdsPayableLedgerId) return sum;
            const led = allLedgers.find((x) => x.id === l.ledgerId);
            if (led?.ledger_role !== "duty_tax") return sum;
            const amt = Number(l.amount);
            return Number.isFinite(amt) ? sum + amt : sum;
          }, 0);
        }

        // Three directions live here (1780):
        //  - Crediting a deductee inside a receipt voucher is money coming
        //    IN, not a bill we owe — routed to the customer-side receivable
        //    hint instead of the vendor-deduction one below.
        //  - Crediting a deductee anywhere else books a liability to them —
        //    the point TDS is deducted (Finding A's base fix applies here).
        //  - Debiting a deductee in a plain journal (not a payment clearing
        //    an already-net liability) is the correct follow-up carve-out
        //    for a bill already booked gross elsewhere (Finding B).
        // Skipped once already split/applied, so the hint doesn't
        // immediately reappear on the changed line and offer to act again.
        function suggestionFor(line: Line, i: number) {
          if (line.tdsSplit) return null;
          const ledger = allLedgers.find((l) => l.id === line.ledgerId);
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

        return (
          <>
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
                          <Combobox
                            aria-label={`Ledger on line ${i + 1}`}
                            value={line.ledgerId}
                            onChange={(v) => update(i, { ledgerId: v })}
                            options={ledgerOptions}
                            placeholder="Select a ledger…"
                            onCreateNew={(typedText) => openLedgerCreate(i, typedText)}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => openLedgerCreate(i, "")}
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
                            onClick={() => setAllocationOpen(true)}
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
                              ? splitLineForTds(i, suggestion)
                              : splitLineForTdsCarveOut(i, suggestion)
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
                        {suggestion.rate}% → TDS {formatINR(suggestion.tdsAmount)}. Crediting only
                        the cash received leaves a permanent residual — credit the full{" "}
                        {formatINR(suggestion.grossAmount)} instead and debit TDS Receivable for
                        the difference.{" "}
                        <button
                          type="button"
                          onClick={() => splitLineForTdsReceivable(i, suggestion)}
                          className="ml-1 font-medium text-accent underline underline-offset-2"
                        >
                          Gross up for TDS
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
                    const suggestion = suggestionFor(line, i);

                    return (
                <Fragment key={i}>
                  <tr className="border-b border-border">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <Combobox
                          aria-label={`Ledger on line ${i + 1}`}
                          value={line.ledgerId}
                          onChange={(v) => update(i, { ledgerId: v })}
                          options={ledgerOptions}
                          placeholder="Select a ledger…"
                          onCreateNew={(typedText) => openLedgerCreate(i, typedText)}
                          className="min-w-0 flex-1"
                        />
                        <button
                          type="button"
                          onClick={() => openLedgerCreate(i, "")}
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
                        onChange={(e) => update(i, { side: e.target.value as "dr" | "cr" })}
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
                        onChange={(e) => update(i, { amount: e.target.value })}
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
                              ? splitLineForTds(i, suggestion)
                              : splitLineForTdsCarveOut(i, suggestion)
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
                          onClick={() => splitLineForTdsReceivable(i, suggestion)}
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
                          onClick={() => setAllocationOpen(true)}
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

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={busy || !totals.balanced}
          className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50 sm:w-auto"
        >
          {busy ? "Saving…" : isEdit ? "Save changes" : "Save voucher"}
        </button>

        {/* /new only: editing an existing voucher has no "next one" to save
            into. This is the visible control mod+s (registered above) fires
            — the primary Save button above is mod+shift+s's. */}
        {!isEdit && (
          <button
            type="button"
            onClick={() => void performSave("new")}
            disabled={busy || !totals.balanced}
            className="w-full rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50 sm:w-auto"
          >
            {busy ? "Saving…" : "Save & new"}
          </button>
        )}

        <span className="text-xs text-ink-faint">
          {isEdit
            ? "Ctrl+S to save · Alt+↑ / Alt+↓ for the previous or next voucher"
            : "Ctrl+S saves and starts the next · Ctrl+Shift+S saves and returns to the daybook"}
        </span>
      </div>

      {/* /new only — see SessionStrip's own header for why this is
          append-only and never reordered by the strip itself. */}
      {!isEdit && sessionEntries.length > 0 && (
        <div className="mt-4">
          <SessionStrip entries={sessionEntries} onClear={() => setSessionEntries([])} />
        </div>
      )}

      {/* No role restriction: a journal line may legitimately hit any ledger
          in the company, so every group is offered. `prefill` is set only
          when the popup was opened from a line's Combobox (F2) itself — its
          own "Create <text>" row or Alt+C — carrying whatever was typed
          there; a plain "+ New" click still opens exactly the blank popup it
          always has (see ledgerModalPrefillName above for why that
          distinction is worth keeping). */}
      <QuickAddLedgerModal
        open={ledgerModalLine !== null}
        onClose={() => {
          setLedgerModalLine(null);
          setLedgerModalPrefillName("");
        }}
        companyId={companyId}
        title="New ledger"
        description="Enough to post against. TDS, MSME, related-party and the rest live on the ledgers screen."
        prefill={ledgerModalPrefillName ? { name: ledgerModalPrefillName } : undefined}
        onCreated={(created) => {
          if (ledgerModalLine !== null) onLedgerCreated(ledgerModalLine, created);
          setLedgerModalPrefillName("");
        }}
      />

      {/* F6. Always mounted, gated on `open` — same convention as
          QuickAddLedgerModal above — so opening it never depends on
          `canAllocate` still being true at the exact render the click
          happened on. It only reads (get_bill_wise_outstanding); nothing is
          posted here — performSave applies the pick, second, once this
          voucher itself exists. */}
      <AllocationDrawer
        companyId={companyId}
        partyLedgerId={partyLedgerId ?? ""}
        role={partyLedger?.ledger_role === "creditor" ? "creditor" : "debtor"}
        amount={partyAmount}
        asAt={date}
        open={allocationOpen}
        onClose={() => setAllocationOpen(false)}
        onConfirm={onAllocationConfirm}
      />
    </form>
  );
}
