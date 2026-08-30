"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR, sumPaise, toPaise } from "@/lib/utils/currency";
import { fuzzyMatchByName } from "@/lib/capture/fuzzyMatch";
import type {
  CaptureDocumentType,
  CaptureExtraction,
  CaptureLineItem,
} from "@/lib/capture/analyze";
import {
  QuickAddLedgerModal,
  type QuickAddedLedger,
} from "@/components/ledgers/QuickAddLedgerModal";
import {
  QuickAddItemModal,
  type QuickAddedItem,
} from "@/components/items/QuickAddItemModal";
import { VoucherNumberField } from "@/components/numbering/VoucherNumberField";
import {
  friendlyNumberingError,
  validateManualNumber,
  type VoucherNumberingByBranch,
} from "@/lib/numbering/voucher-numbering";
import {
  DOC_TYPES,
  docConfig,
  type Item,
  type Ledger,
  type QueueRow,
} from "@/components/capture/reviewModel";

/**
 * The STAGED review-and-post pane for one captured document
 * (0740, made universal by 0865, moved into the inbox by 0870).
 *
 * ============================================================================
 * WHAT THIS FILE IS, AND WHERE IT CAME FROM
 * ============================================================================
 * This is the review half of what used to be CaptureWorkspace — the screen
 * that did capture and review together, a file picker at the top and a form
 * below. Capture moved to the phone surface at /scan, so the upload half, the
 * draft list and the draft-selection state are gone; everything else here is
 * carried over deliberately unchanged, because it was right: the three steps,
 * the read-off-the-document copy chips, the GSTIN evidence, the HSN
 * write-back, the figure-by-figure comparison against the paper.
 *
 * WHICH DOCUMENT is being reviewed is no longer this component's business.
 * CaptureReviewInbox owns the queue and remounts this component per draft, so
 * every field below is seeded once, at mount, and there is no "select another
 * draft" path to keep in step. The two callbacks are the whole contract back:
 * onDocumentTypeChanged (so the queue row agrees with what was just saved)
 * and onPosted (so the reviewer stays in the queue instead of being thrown at
 * the voucher after every single document).
 *
 * ============================================================================
 * WHY THREE STEPS, AND WHY IN THIS ORDER
 * ============================================================================
 * The alternative is dumping every field the model read into one long form:
 * party, lines, header and totals all at once. Checking a captured document is
 * not one decision, it is
 * three, and they are strictly ordered because each genuinely depends on the
 * one before it:
 *
 *   1. WHO is this document with?  Until the party is settled nothing else can
 *      be judged: the rate on a line is a rate agreed with somebody, the place
 *      of supply comes off the party's own state, and on a purchase the whole
 *      question of which ledger is debited follows from who billed us.
 *   2. WHAT is on it?  A line cannot be reviewed before the party is known,
 *      and it cannot be POSTED at all until it points at a real item id —
 *      create_invoice takes item ids, never the description strings the model
 *      read. So this step's completion test is exactly that: every line
 *      matched to a real item.
 *   3. Does the WHOLE thing agree with the paper?  Totals are the last check
 *      because they are a consequence of steps 1 and 2 — comparing them before
 *      the lines are settled compares against a number still being built.
 *
 * DELIBERATELY NOT A TRAP. The three step headers are buttons and every one of
 * them is clickable at any time, in both directions: this is a REVIEW screen,
 * and refusing to let somebody look at the totals before they have finished
 * the lines would be refusing them the one view that tells them whether the
 * lines are worth finishing. What is gated is POSTING, not looking — and when
 * a validation fails, the failure jumps to the step that owns it rather than
 * printing a sentence about a field three screens away. If the model got
 * everything right, two clicks of "Next" reach the post button.
 *
 * ============================================================================
 * A DRAFT STILL NEVER POSTS ITSELF
 * ============================================================================
 * Unchanged from 0740 and non-negotiable: there is no function anywhere that
 * calls create_invoice on a draft's behalf. The button below calls the
 * EXISTING create_invoice RPC — the same one InvoiceForm.tsx calls, with the
 * same arguments — and only once it has returned a voucher id does this
 * component write confirmed_voucher_id onto the draft. 0865 widened WHICH
 * voucher type a human may confirm against; it did not move the confirming.
 * Nothing on this screen writes voucher_entries, and nothing posts before the
 * button is pressed.
 *
 * ============================================================================
 * THE DOCUMENT TYPE
 * ============================================================================
 * Shown at the top and overridable, above the steps, because it decides what
 * every step below MEANS: a sales challan is reviewed against customers and an
 * income ledger and posts a SALES invoice; a purchase invoice is reviewed
 * against suppliers and an expense ledger and posts a PURCHASE bill; "something
 * else" posts nothing at all and the database refuses to let it
 * (app_private.enforce_capture_draft, 0865 section 2), so this screen does not
 * offer a post button for it rather than offering one that is guaranteed to
 * raise.
 *
 * The model's own guess (extracted_json.document_type) is advisory and only
 * ever PRESELECTS the choice. The authoritative value is
 * capture_drafts.document_type, and it is written in the SAME statement as
 * confirmed_voucher_id when the human posts, so the row can never claim one
 * document type while pointing at a voucher of the other.
 *
 * ============================================================================
 * INLINE MASTER CREATION IS REUSED, NOT REBUILT — AND CANNOT BE PREFILLED
 * ============================================================================
 * QuickAddLedgerModal and QuickAddItemModal are used exactly as they stand.
 * Neither takes an initial-value prop — QuickAddLedgerModal's props are
 * (open, onClose, companyId, title, description, roles, onCreated) and
 * QuickAddItemModal's are (open, onClose, companyId, gstOn, requireStockItem,
 * onCreated) — and both are owned by another author, so this screen does not
 * add one. What it does instead is put every value the model read on a
 * one-click COPY chip immediately beside the "+ New" button, because the popup
 * covers the text it was read from the moment it opens. See the final report:
 * a five-line prop addition on those two files is the real fix.
 *
 * HSN is the one extracted value that must not be lost that way, because it
 * belongs on the ITEM MASTER (public.items.hsn_sac) and voucher_items only
 * ever holds a copy taken at posting time. So where the bill shows an HSN and
 * the matched (or just-created) item has none, this screen offers a single
 * explicit button that writes it onto the item — never silently, never
 * overwriting one already on file, and shown as a plain disagreement when the
 * two differ.
 */

type Branch = { id: string; code: string; name: string; registeredState: string | null };
type Godown = { id: string; code: string; name: string };
type StateOption = { code: string; name: string };

type Line = {
  itemId: string;
  quantity: string;
  rate: string;
  discountPercent: string;
  description: string;
  /**
   * What the model read for this line, kept beside the editable values rather
   * than merged into them: the line total below is computed from qty x rate,
   * and the only way to notice that the model read a rate off one column and
   * an amount off another is to show both and subtract.
   */
  readAmount: number | null;
  /** HSN printed against this line. Belongs on the ITEM MASTER — see header. */
  readHsn: string | null;
};

type Step = 1 | 2 | 3;

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Mirrors create_invoice's own per-line formula exactly (0147), the same
// copy InvoiceForm.tsx keeps for the same reason: this is a client-side
// preview only, so the number shown here must never disagree with what the
// database will actually post.
function lineAmounts(quantity: string, rate: string, discountPercent: string) {
  const qty = Number(quantity) || 0;
  const r = Number(rate) || 0;
  const discPct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const gross = Math.round(qty * r * 100) / 100;
  const discount = Math.round(((gross * discPct) / 100) * 100) / 100;
  const net = Math.round((gross - discount) * 100) / 100;
  return { gross, discount, net };
}

/**
 * Which document type the screen OPENS on.
 *
 * The draft's own value wins whenever it is not the schema default, because a
 * value other than 'purchase_invoice' can only have got there by somebody
 * choosing it — on the phone at /scan, or on this screen. When the row still
 * holds the default, the model's guess is preferred: that is what "advisory
 * preselect" means. The one case this cannot represent is a human who
 * deliberately picked 'purchase_invoice' over the model's 'sales_challan' and
 * then walked away without posting.
 */
function preselectDocType(
  draft: QueueRow,
  extraction: CaptureExtraction | null
): CaptureDocumentType {
  if (draft.documentType && draft.documentType !== "purchase_invoice") {
    return draft.documentType;
  }
  return extraction?.document_type ?? draft.documentType ?? "purchase_invoice";
}

function extractionLineToFormLine(li: CaptureLineItem, items: Item[], isSale: boolean): Line {
  const match = fuzzyMatchByName(li.description, items);
  const fallbackRate = isSale ? match?.sale_rate : match?.purchase_rate;
  return {
    itemId: match?.id ?? "",
    quantity: li.quantity != null ? String(li.quantity) : "1",
    rate: li.rate != null ? String(li.rate) : fallbackRate != null ? String(fallbackRate) : "",
    discountPercent: "",
    description: li.description,
    readAmount: li.amount ?? null,
    readHsn: li.hsn_sac?.trim() || null,
  };
}

const emptyLine = (): Line => ({
  itemId: "",
  quantity: "1",
  rate: "",
  discountPercent: "",
  description: "",
  readAmount: null,
  readHsn: null,
});

function seedLines(ex: CaptureExtraction | null, items: Item[], isSale: boolean): Line[] {
  return ex?.line_items?.length
    ? ex.line_items.map((li) => extractionLineToFormLine(li, items, isSale))
    : [emptyLine()];
}

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

/**
 * One value the model read, on a chip that copies it.
 *
 * This exists only because QuickAddLedgerModal and QuickAddItemModal take no
 * initial values and are owned elsewhere (see the file header). The popup
 * covers the text it was read from, so without this the preparer has to close
 * it, memorise a fifteen-character GSTIN and reopen it.
 */
function ReadChip({ label, value }: { label: string; value: string }) {
  return (
    <button
      type="button"
      title={`Copy ${label} — the popup covers this text once it opens`}
      aria-label={`Copy ${label}: ${value}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success(`${label} copied — paste it into the popup.`);
        } catch {
          toast.error("This browser would not let the page use the clipboard — retype it by hand.");
        }
      }}
      className="inline-flex max-w-full items-baseline gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs transition-colors hover:border-accent hover:bg-accent/5"
    >
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className="truncate font-mono text-ink">{value}</span>
      <span aria-hidden className="shrink-0 text-ink-faint">
        copy
      </span>
    </button>
  );
}

export function CaptureReviewForm({
  companyId,
  draft,
  extraction,
  items,
  ledgers,
  branches,
  godowns,
  gstOn,
  states,
  numbering,
  onDocumentTypeChanged,
  onPosted,
}: {
  companyId: string;
  /** The one document being reviewed. The inbox owns which one that is. */
  draft: QueueRow;
  /**
   * What the model read, or null when nothing could be read at all — a
   * genuine and expected state now that OCR runs on demand at review time
   * and this project's free-tier model really does fail. Null means every
   * field below simply starts blank, which is a bill typed in by hand.
   */
  extraction: CaptureExtraction | null;
  items: Item[];
  ledgers: Ledger[];
  branches: Branch[];
  godowns: Godown[];
  gstOn: boolean;
  states: StateOption[];
  numbering: VoucherNumberingByBranch;
  /** Persisted here; the inbox keeps its queue row in step through this. */
  onDocumentTypeChanged: (value: CaptureDocumentType) => void;
  onPosted: (voucherId: string) => void;
}) {
  const router = useRouter();

  const [addedLedgers, setAddedLedgers] = useState<Ledger[]>([]);
  const [addedItems, setAddedItems] = useState<Item[]>([]);
  /**
   * HSNs this screen has written onto the item master during this session,
   * itemId -> hsn. Kept locally rather than re-fetching the whole item list:
   * `items` is a server prop and router.refresh() will bring it back with the
   * new value, but the button must stop offering itself the instant it is
   * pressed, not one navigation later.
   */
  const [hsnSaved, setHsnSaved] = useState<Record<string, string>>({});

  const allLedgers = useMemo(() => {
    const known = new Set(ledgers.map((l) => l.id));
    return [...ledgers, ...addedLedgers.filter((l) => !known.has(l.id))];
  }, [ledgers, addedLedgers]);
  const allItems = useMemo(() => {
    const known = new Set(items.map((i) => i.id));
    return [...items, ...addedItems.filter((i) => !known.has(i.id))];
  }, [items, addedItems]);

  const [docType, setDocType] = useState<CaptureDocumentType>(() =>
    preselectDocType(draft, extraction)
  );
  const cfg = docConfig(docType);
  const isSale = cfg.voucherType === "sales";

  const partyLedgers = allLedgers.filter((l) => cfg.partyRoles.includes(l.ledger_role));
  const tradingLedgers = allLedgers.filter((l) => cfg.tradingRoles.includes(l.ledger_role));

  const [step, setStep] = useState<Step>(1);

  // Review-form state — reset whenever the selected draft or the confirmed
  // document type changes, since both change what these fields mean.
  const [branchId, setBranchId] = useState(draft.branchId ?? branches[0]?.id ?? "");
  const [godownId, setGodownId] = useState(godowns[0]?.id ?? "");
  const [date, setDate] = useState(() => extraction?.bill_date ?? todayLocal());
  const [partyId, setPartyId] = useState(() => {
    const conf = docConfig(preselectDocType(draft, extraction));
    return (
      fuzzyMatchByName(
        // The name the model read, or — when nothing was read — what the
        // person holding the phone typed into "who is this from?".
        extraction?.vendor_name ?? draft.vendorHint,
        ledgers.filter((l) => conf.partyRoles.includes(l.ledger_role))
      )?.id ?? ""
    );
  });
  const [placeOfSupplyTouched, setPlaceOfSupplyTouched] = useState(false);
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [tradingId, setTradingId] = useState("");
  const [reference, setReference] = useState("");
  const [challanNumber, setChallanNumber] = useState(
    () => extraction?.challan_number?.trim() ?? ""
  );
  const [challanDate, setChallanDate] = useState(() => extraction?.challan_date ?? "");
  const [narration, setNarration] = useState(() =>
    // What the sender typed is the better narration when there is one: it is
    // a human sentence about this document, not the model's own hedging.
    draft.note
      ? `Captured document — ${draft.note}`
      : extraction?.note
        ? `Captured document — ${extraction.note}`
        : ""
  );
  const [lines, setLines] = useState<Line[]>(() =>
    seedLines(extraction, items, preselectDocType(draft, extraction) === "sales_challan")
  );
  const [manualNumber, setManualNumber] = useState("");
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [partyModalOpen, setPartyModalOpen] = useState(false);
  const [tradingModalOpen, setTradingModalOpen] = useState(false);
  const [itemModalLine, setItemModalLine] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const branch = branches.find((b) => b.id === branchId);
  // The numbering policy follows the CONFIRMED document type, because the
  // voucher type does: a sales challan draws its number from the sales series,
  // not the purchase one.
  const policy = cfg.voucherType ? numbering[branchId]?.[cfg.voucherType] : undefined;
  const seriesOptions = policy?.mode === "series" ? policy.series : [];
  const effectiveSeriesId = seriesOptions.some((s) => s.id === seriesId)
    ? seriesId
    : (seriesOptions.find((s) => s.isDefault)?.id ?? seriesOptions[0]?.id ?? null);

  const partyLedger = allLedgers.find((l) => l.id === partyId) ?? null;
  // Not memoized, for the same reason as `comparison` below: partyLedgers is
  // rebuilt every render by design, so its identity is not a dependency worth
  // declaring, and the match is a linear scan over one company's ledgers.
  const partyMatch = fuzzyMatchByName(extraction?.vendor_name, partyLedgers);

  function selectParty(id: string) {
    setPartyId(id);
    if (placeOfSupplyTouched) return;
    const party = allLedgers.find((l) => l.id === id);
    if (party?.state_code) setPlaceOfSupply(party.state_code);
  }

  const supplyType =
    gstOn && branch?.registeredState && placeOfSupply
      ? branch.registeredState === placeOfSupply
        ? "intra"
        : "inter"
      : null;

  const taxable = useMemo(
    () => sumPaise(lines.map((l) => toPaise(lineAmounts(l.quantity, l.rate, l.discountPercent).net))) / 100,
    [lines]
  );

  const tax = useMemo(() => {
    if (!supplyType) return { cgst: 0, sgst: 0, igst: 0 };
    let cgst = 0,
      sgst = 0,
      igst = 0;
    for (const l of lines) {
      const item = allItems.find((x) => x.id === l.itemId);
      if (!item || !item.gst_rate_percent) continue;
      const amount = lineAmounts(l.quantity, l.rate, l.discountPercent).net;
      if (supplyType === "intra") {
        const half = Math.round(((amount * item.gst_rate_percent) / 2 / 100) * 100) / 100;
        cgst += half;
        sgst += half;
      } else {
        igst += Math.round(((amount * item.gst_rate_percent) / 100) * 100) / 100;
      }
    }
    return { cgst, sgst, igst };
  }, [lines, allItems, supplyType]);

  const grandTotal = taxable + tax.cgst + tax.sgst + tax.igst;

  /**
   * Every figure the model read off the paper, beside the one this draft would
   * actually post. A mismatch has to be visible BEFORE posting — the old
   * screen showed a single sentence about the grand total, which says a bill
   * disagrees but not where, and a rate typo and a missed line look identical
   * through it. Component by component, the two are told apart at a glance.
   *
   * A row is shown when the model read something for it, or when this draft
   * computes something for it — a tax the model missed entirely is exactly the
   * disagreement worth seeing.
   */
  const comparison = [
    { key: "taxable", label: "Taxable value", read: extraction?.taxable_value ?? null, computed: taxable },
    { key: "cgst", label: "CGST", read: extraction?.cgst ?? null, computed: tax.cgst },
    { key: "sgst", label: "SGST", read: extraction?.sgst ?? null, computed: tax.sgst },
    { key: "igst", label: "IGST", read: extraction?.igst ?? null, computed: tax.igst },
    { key: "total", label: "Total", read: extraction?.total_amount ?? null, computed: grandTotal },
    // Plainly, not inside a useMemo: five subtractions, and the React
    // Compiler refuses to preserve a manual memo over an array literal it
    // cannot prove is never mutated. It memoizes this for us.
  ].filter((r) => r.read != null || Math.abs(r.computed) >= 0.005);

  // One rupee, the same tolerance the pre-staged screen used: rounding on a
  // photographed bill is routinely a few paise out and a warning that cries
  // wolf on every document is a warning nobody reads.
  const mismatchRows = comparison.filter(
    (r) => r.read != null && Math.abs(r.read - r.computed) > 1
  );

  /**
   * Sales TCS (206C) is computed server-side by create_invoice and is
   * deliberately NOT replicated here — InvoiceForm carries that arithmetic
   * because it is the full sales screen; a capture preview that guessed at it
   * would be a second twin to keep in step. What this screen owes the preparer
   * is the warning that the posted total will be higher, so the comparison
   * above is not read as a clean match when it is about to stop being one.
   */
  const tcsLikely =
    isSale && lines.some((l) => allItems.find((x) => x.id === l.itemId)?.default_tcs_section);

  const partyDone = Boolean(partyId);
  const unmatchedLine = lines.findIndex((l) => !l.itemId);
  const billableLines = lines.filter((l) => l.itemId && Number(l.quantity) > 0);
  const itemsDone = unmatchedLine === -1 && billableLines.length > 0;
  const manualProblem = policy?.mode === "manual" ? validateManualNumber(manualNumber) : null;
  const invoiceDone =
    Boolean(tradingId) && taxable > 0 && (!gstOn || Boolean(placeOfSupply)) && !manualProblem;

  /**
   * Reseeds every field the document type decides. Only the type switch needs
   * it now — which draft is being reviewed is the inbox's business, and it
   * remounts this component rather than asking it to reset itself.
   */
  function seedFrom(nextType: CaptureDocumentType, keepLines: Line[] | null) {
    const ex = extraction;
    const conf = docConfig(nextType);
    const sale = conf.voucherType === "sales";
    const candidates = allLedgers.filter((l) => conf.partyRoles.includes(l.ledger_role));
    const matchedParty = fuzzyMatchByName(ex?.vendor_name ?? draft.vendorHint, candidates);

    setDate(ex?.bill_date ?? todayLocal());
    setPlaceOfSupplyTouched(false);
    setPartyId(matchedParty?.id ?? "");
    setPlaceOfSupply(matchedParty?.state_code ?? "");
    setTradingId("");
    setReference("");
    setChallanNumber(ex?.challan_number?.trim() ?? "");
    setChallanDate(ex?.challan_date ?? "");
    setNarration(
      draft.note
        ? `Captured document — ${draft.note}`
        : ex?.note
          ? `Captured document — ${ex.note}`
          : ""
    );
    setLines(keepLines ?? seedLines(ex, allItems, sale));
    setManualNumber("");
    setSeriesId(null);
    setError(null);
    setStep(1);
  }

  /**
   * Changing the document type re-decides who the party may be (a sale cannot
   * be billed to a supplier), which ledger the other side posts to, and which
   * numbering series is drawn from — so all three are re-derived rather than
   * left pointing at a ledger the new type's own dropdown would not offer.
   *
   * The LINES are deliberately kept. An item match is a fact about the
   * description on the paper, not about which way the goods moved, and
   * throwing away work the preparer has already done to a mis-guessed type is
   * the surest way to make them stop correcting it. Only the rate FALLBACK
   * differs by side, and that only applies to a line the model read no rate
   * for at all.
   *
   * The choice is persisted immediately so that a document filed as "something
   * else" — which never posts, and so never reaches the confirm write below —
   * is still recorded as what it is.
   */
  async function chooseDocType(next: CaptureDocumentType) {
    if (next === docType || busy) return;
    const previous = docType;
    setDocType(next);
    seedFrom(next, lines);
    const { error: typeError } = await createClient()
      .from("capture_drafts")
      .update({ document_type: next })
      .eq("id", draft.id);
    if (typeError) {
      // Put it back rather than leave the screen claiming something the
      // database does not agree with: enforce_capture_draft reads the STORED
      // value when the post is confirmed, so a silent divergence here would
      // surface as a refused confirmation after the voucher already exists.
      setDocType(previous);
      seedFrom(previous, lines);
      toast.error(`The document type could not be saved: ${typeError.message}`);
      return;
    }
    onDocumentTypeChanged(next);
  }

  function update(i: number, patch: Partial<Line>) {
    setLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== i) return l;
        const next = { ...l, ...patch };
        // Prefill the rate when an item is picked and the rate is still blank —
        // never overwrite something read off the bill or typed by hand.
        if (patch.itemId && !l.rate) {
          const it = allItems.find((x) => x.id === patch.itemId);
          const suggested = isSale ? it?.sale_rate : it?.purchase_rate;
          if (suggested) next.rate = String(suggested);
        }
        return next;
      })
    );
  }

  /** The HSN on file for an item, including one saved from this screen. */
  function itemHsn(item: Item | undefined): string | null {
    if (!item) return null;
    return hsnSaved[item.id] ?? item.hsn_sac ?? null;
  }

  /**
   * Writes the HSN the bill showed onto the item master. Explicit, one item at
   * a time, and only ever offered when the item has none — an HSN already on
   * file was put there by somebody and a photograph is not grounds to
   * overwrite it. This is the one master field capture must not lose, because
   * voucher_items only carries a COPY of it taken at posting time.
   */
  async function saveHsn(itemId: string, hsn: string) {
    if (busy) return;
    setBusy(true);
    const { error: hsnError } = await createClient()
      .from("items")
      .update({ hsn_sac: hsn })
      .eq("id", itemId);
    setBusy(false);
    if (hsnError) {
      toast.error(hsnError.message);
      return;
    }
    setHsnSaved((prev) => ({ ...prev, [itemId]: hsn }));
    toast.success(`HSN ${hsn} saved on this item.`);
    router.refresh();
  }

  /** Validates one step and moves on, or points at what is missing. */
  function goNext() {
    setError(null);
    if (step === 1) {
      if (!partyDone) {
        return setError(
          `Pick the ${cfg.partyLabel.toLowerCase()} this document is with, or create it with “+ New ${cfg.partyLabel.toLowerCase()}”. Posting needs a real ledger, not the name the model read.`
        );
      }
      return setStep(2);
    }
    if (step === 2) {
      if (unmatchedLine !== -1) {
        return setError(
          `Line ${unmatchedLine + 1} is not matched to an item yet. Every line has to point at a real item before it can be posted — pick one, create it with “+ New”, or remove the line.`
        );
      }
      if (!billableLines.length) {
        return setError("Every line has a quantity of zero — nothing would be billed.");
      }
      return setStep(3);
    }
  }

  async function post(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (busy) return;

    const voucherType = cfg.voucherType;
    if (!voucherType) {
      return setError(
        "A document filed as “something else” records no entry, so there is nothing to post. Change its type above if it is really a challan or a bill."
      );
    }
    if (!partyId) {
      setStep(1);
      return setError(`Select or create the ${cfg.partyLabel.toLowerCase()} ledger.`);
    }
    if (unmatchedLine !== -1) {
      setStep(2);
      return setError(
        `Line ${unmatchedLine + 1} is not matched to an item — pick one from the dropdown or create it with “+ New”.`
      );
    }
    if (!billableLines.length) {
      setStep(2);
      return setError("Match at least one line with a quantity above zero before posting.");
    }
    if (!tradingId) {
      setStep(3);
      return setError(`Select the ${cfg.tradingLabel.toLowerCase()}.`);
    }
    if (taxable <= 0) {
      setStep(3);
      return setError("The document must come to more than zero.");
    }
    if (gstOn && !placeOfSupply) {
      setStep(3);
      return setError("Select a place of supply.");
    }
    if (manualProblem) {
      setStep(3);
      return setError(manualProblem);
    }

    setBusy(true);
    const items_payload = billableLines.map((l) => ({
      item_id: l.itemId,
      quantity: Number(l.quantity),
      rate: Number(l.rate) || 0,
      discount_percent: Number(l.discountPercent) || 0,
      description: l.description.trim() || null,
    }));

    // The two trailing arguments migration 0865 added to create_invoice.
    // Carried in their own object because types/database.types.ts — owned by
    // the integration pass — does not know them yet. A date with no number is
    // deliberately still sent: the database accepts it, because a challan
    // whose printed number is illegible is still dated.
    const challanArgs = {
      p_challan_number: challanNumber.trim() || undefined,
      p_challan_date: challanDate || undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    } as any;

    const { data: voucherId, error: postError } = await createClient().rpc("create_invoice", {
      p_company_id: companyId,
      p_branch_id: branchId,
      p_voucher_type: voucherType,
      p_voucher_date: date,
      p_party_ledger_id: partyId,
      p_trading_ledger_id: tradingId,
      p_godown_id: godownId,
      p_items: items_payload,
      p_narration: narration.trim() || undefined,
      p_reference_number: reference.trim() || undefined,
      p_place_of_supply: placeOfSupply || undefined,
      p_voucher_number: policy?.mode === "manual" ? manualNumber.trim() : undefined,
      p_number_series_id: policy?.mode === "series" ? (effectiveSeriesId ?? undefined) : undefined,
      ...challanArgs,
    });

    if (postError || !voucherId) {
      setError(friendlyNumberingError(postError?.message ?? "Could not post this document."));
      setBusy(false);
      return;
    }

    // The voucher is posted at this point — a real, already-final ledger
    // effect. Marking the draft confirmed is bookkeeping about THAT fact,
    // never a precondition for it, so a failure here is a warning, not a
    // reason to pretend the post did not happen.
    //
    // document_type travels in the SAME statement as confirmed_voucher_id, on
    // purpose: app_private.enforce_capture_draft checks the two against each
    // other, so writing them separately would either leave a window where the
    // row disagrees with itself or be refused outright when the type on file
    // is still the one the model guessed.
    const { error: confirmError } = await createClient()
      .from("capture_drafts")
      .update({ document_type: docType, confirmed_voucher_id: voucherId, branch_id: branchId })
      .eq("id", draft.id);
    if (confirmError) {
      toast.error(`Posted, but the draft record could not be updated: ${confirmError.message}`);
    }

    setBusy(false);
    // Deliberately NOT a navigation to the voucher. This form now lives
    // inside a queue, and jumping to the posted voucher after every document
    // would throw the reviewer out of it on each one. The inbox shows the
    // link and offers the next waiting document instead.
    onPosted(voucherId as string);
    router.refresh();
  }

  const steps: { n: Step; label: string; done: boolean; hint: string }[] = [
    { n: 1, label: "Party", done: partyDone, hint: partyLedger?.name ?? "not chosen" },
    {
      n: 2,
      label: "Items",
      done: itemsDone,
      hint: `${lines.filter((l) => l.itemId).length} of ${lines.length} matched`,
    },
    {
      n: 3,
      label: "Whole invoice",
      done: invoiceDone,
      hint: formatINR(grandTotal, { showZero: true }),
    },
  ];

  return (
    <>
      <form
        onSubmit={(e) => {
          // Enter anywhere in the form advances rather than posting: the post
          // button exists only on step 3, and a keystroke must never be the
          // thing that writes to the ledger.
          if (step !== 3) {
            e.preventDefault();
            goNext();
            return;
          }
          void post(e);
        }}
      >
        {extraction && !extraction.configured && (
          <p className="mt-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
            Vision capture isn&rsquo;t configured on this server (no GOOGLE_API_KEY). Nothing was
            read automatically — fill in every field below by hand.
          </p>
        )}
        {extraction?.configured && (
          <p className="mt-2 text-xs text-ink-faint">
            Model read this at {extraction.confidence} confidence: {extraction.note}
          </p>
        )}
        {!extraction && (
          <p className="mt-2 text-xs text-ink-faint">
            Nothing was read off this document — every field below starts blank and is yours to
            fill in, exactly as if the bill were being typed in by hand.
          </p>
        )}

        {/* ── What the paper IS. Above the steps, because it decides what
            every step below means. ─────────────────────────────────────── */}
        <fieldset className="mt-5">
          <legend className="text-sm font-medium text-ink">This document is a…</legend>
          <div
            role="group"
            aria-label="Document type"
            className="mt-2 grid gap-2 sm:grid-cols-3"
          >
            {DOC_TYPES.map((d) => (
              <button
                key={d.value}
                type="button"
                aria-pressed={docType === d.value}
                aria-label={`Document type: ${d.label}`}
                onClick={() => void chooseDocType(d.value)}
                className={
                  "rounded-lg border px-3 py-2 text-left transition-colors " +
                  (docType === d.value
                    ? "border-accent bg-accent/5"
                    : "border-border-strong hover:bg-surface-2")
                }
              >
                <span className="block text-sm font-medium text-ink">{d.label}</span>
                <span className="mt-0.5 block text-xs text-ink-faint">{d.blurb}</span>
              </button>
            ))}
          </div>
          {extraction?.document_type && extraction.document_type !== docType && (
            <p className="mt-2 text-xs text-ink-faint">
              The model read this as a{" "}
              <span className="text-ink-soft">
                {docConfig(extraction.document_type).label.toLowerCase()}
              </span>
              . Your choice is the one that counts — it is what the database records and what
              decides the voucher type.
            </p>
          )}
        </fieldset>

        {cfg.voucherType === null ? (
          /* ── 'other': storable, never postable (0865 §2). No post button,
             rather than a button guaranteed to raise. ───────────────────── */
          <div className="mt-6 rounded-lg border border-border bg-surface p-4">
            <p className="text-sm text-ink">
              Filed as <span className="font-medium">something else</span>. This document is kept
              with its image and everything the model read, and it posts <strong>nothing</strong>{" "}
              to your books — the database refuses to link it to any voucher at all.
            </p>
            {extraction && (
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-faint">Read as</dt>
                  <dd className="text-right">{extraction.vendor_name ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-faint">GSTIN</dt>
                  <dd className="text-right font-mono">{extraction.vendor_gstin ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-faint">Date</dt>
                  <dd className="text-right">{extraction.bill_date ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-faint">Total on document</dt>
                  <dd className="text-right tabular-nums font-mono">
                    {extraction.total_amount != null
                      ? formatINR(extraction.total_amount, { showZero: true })
                      : "—"}
                  </dd>
                </div>
              </dl>
            )}
            <p className="mt-3 text-xs text-ink-faint">
              If it really is a challan or a bill, change the type above and the three review
              steps come back. To send it back to whoever photographed it instead, use
              &ldquo;Send back&rdquo; at the top of this document.
            </p>
          </div>
        ) : (
          <>
            {/* ── The three steps. Every header is clickable in both
                directions — see the file header on why. ───────────────── */}
            <ol className="mt-6 grid gap-2 sm:grid-cols-3" aria-label="Review steps">
              {steps.map((s) => (
                <li key={s.n}>
                  <button
                    type="button"
                    aria-current={step === s.n ? "step" : undefined}
                    aria-label={`Step ${s.n}: ${s.label}`}
                    onClick={() => {
                      setError(null);
                      setStep(s.n);
                    }}
                    className={
                      "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors " +
                      (step === s.n
                        ? "border-accent bg-accent/5"
                        : "border-border hover:bg-surface-2")
                    }
                  >
                    <span
                      className={
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold " +
                        (s.done
                          ? "bg-success-soft text-success"
                          : step === s.n
                            ? "bg-accent text-accent-ink"
                            : "bg-surface-2 text-ink-faint")
                      }
                    >
                      {s.done ? "✓" : s.n}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{s.label}</span>
                      <span className="block truncate text-xs text-ink-faint">{s.hint}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>

            {/* ══ STEP 1 — the party ══════════════════════════════════════ */}
            {step === 1 && (
              <section className="mt-5" aria-label="Step 1: party">
                <h3 className="text-sm font-semibold text-ink">
                  Who is this document with?
                </h3>
                <p className="mt-1 text-sm text-ink-soft">
                  Everything after this depends on it: the rates on the lines were agreed with
                  somebody, and the place of supply comes off their own state.
                </p>

                <div className="mt-4 rounded-lg border border-border bg-surface p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                    Read off the document
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {extraction?.vendor_name ? (
                      <ReadChip label="Name" value={extraction.vendor_name} />
                    ) : (
                      <span className="text-sm text-ink-faint">No name could be read.</span>
                    )}
                    {extraction?.vendor_gstin && (
                      <ReadChip label="GSTIN" value={extraction.vendor_gstin} />
                    )}
                  </div>
                  <p className="mt-2 text-xs text-ink-faint">
                    Copy either one straight into the &ldquo;+ New&rdquo; popup — it covers this
                    panel once it opens.
                  </p>
                </div>

                <div className="mt-4 flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{cfg.partyLabel}</span>
                    <button
                      type="button"
                      onClick={() => setPartyModalOpen(true)}
                      className="text-xs text-accent underline underline-offset-4"
                    >
                      + New {cfg.partyLabel.toLowerCase()}
                    </button>
                  </div>
                  <select
                    aria-label={cfg.partyLabel}
                    value={partyId}
                    onChange={(e) => selectParty(e.target.value)}
                    className={field}
                  >
                    <option value="">Select…</option>
                    {partyLedgers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>

                  {extraction?.vendor_name && (
                    <p className="text-xs text-ink-faint">
                      {partyMatch && partyMatch.id === partyId ? (
                        <>
                          Matched <span className="text-ink-soft">{partyMatch.name}</span> from the
                          document&rsquo;s &ldquo;{extraction.vendor_name}&rdquo; — change it above if
                          that is the wrong one.
                        </>
                      ) : partyId ? (
                        <>
                          Chosen by hand. The document reads &ldquo;{extraction.vendor_name}&rdquo;.
                        </>
                      ) : (
                        <>
                          No {cfg.partyLabel.toLowerCase()} on file matches &ldquo;
                          {extraction.vendor_name}&rdquo;. Create one with &ldquo;+ New&rdquo;, or
                          pick an existing one — posting needs a real ledger id, so the name on its
                          own can never be sent.
                        </>
                      )}
                    </p>
                  )}

                  {partyLedger && extraction?.vendor_gstin && (
                    <p
                      className={
                        "text-xs " +
                        (partyLedger.gstin
                          ? partyLedger.gstin.toUpperCase() ===
                            extraction.vendor_gstin.toUpperCase()
                            ? "text-success"
                            : "text-warning"
                          : "text-ink-faint")
                      }
                    >
                      {partyLedger.gstin
                        ? partyLedger.gstin.toUpperCase() ===
                          extraction.vendor_gstin.toUpperCase()
                          ? `GSTIN on the document matches this ledger (${partyLedger.gstin}).`
                          : `The document shows GSTIN ${extraction.vendor_gstin}, but this ledger is on file as ${partyLedger.gstin}. One of the two is wrong — check before posting.`
                        : `This ledger has no GSTIN on file; the document shows ${extraction.vendor_gstin}.`}
                    </p>
                  )}
                  {partyLedger?.state_code && (
                    <p className="text-xs text-ink-faint">
                      Place of supply will default to this party&rsquo;s state ({partyLedger.state_code}),
                      and stays editable on step 3.
                    </p>
                  )}
                </div>
              </section>
            )}

            {/* ══ STEP 2 — the items ══════════════════════════════════════ */}
            {step === 2 && (
              <section className="mt-5" aria-label="Step 2: items">
                <h3 className="text-sm font-semibold text-ink">What is on it?</h3>
                <p className="mt-1 text-sm text-ink-soft">
                  One row per line the model read. Every line has to end up pointing at a real
                  item before this document can be posted — create_invoice is given item ids, never
                  the descriptions printed on the paper.
                </p>

                <div className="mt-4 flex flex-col gap-3">
                  {lines.map((line, i) => {
                    const item = allItems.find((x) => x.id === line.itemId);
                    const { gross, discount, net } = lineAmounts(
                      line.quantity,
                      line.rate,
                      line.discountPercent
                    );
                    const onFile = itemHsn(item);
                    // Hoisted out of the JSX so the narrowing survives into
                    // the click handler below — a `line.readHsn` guarded in
                    // markup is still `string | null` inside a closure.
                    const readHsn = line.readHsn;
                    const readAmount = line.readAmount;
                    const lineOff = readAmount != null && Math.abs(readAmount - net) > 1;
                    return (
                      <div key={i} className="rounded-lg border border-border bg-surface p-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                            Line {i + 1}
                          </span>
                          <span
                            className={
                              "rounded-full px-2 py-0.5 text-xs " +
                              (line.itemId
                                ? "bg-success-soft text-success"
                                : "bg-warning-soft text-warning")
                            }
                          >
                            {line.itemId ? "Matched" : "No item yet"}
                          </span>
                          {lines.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))}
                              className="rounded px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-soft"
                            >
                              Remove
                            </button>
                          )}
                        </div>

                        {(line.description || readAmount != null || readHsn) && (
                          <div className="mb-2.5 rounded-md border border-border bg-bg p-2">
                            <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                              Read off the document
                            </p>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {line.description && (
                                <ReadChip label="Description" value={line.description} />
                              )}
                              {readHsn && <ReadChip label="HSN" value={readHsn} />}
                              {line.rate && <ReadChip label="Rate" value={line.rate} />}
                              {readAmount != null && (
                                <span className="inline-flex items-baseline gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs">
                                  <span className="text-ink-faint">Amount</span>
                                  <span className="font-mono">{formatINR(readAmount)}</span>
                                </span>
                              )}
                            </div>
                            {!line.itemId && (
                              <p className="mt-1.5 text-xs text-ink-faint">
                                Copy what you need, then use &ldquo;+ New&rdquo; — the popup covers
                                this panel while it is open, and it takes no starting values.
                              </p>
                            )}
                          </div>
                        )}

                        <div className="flex flex-col gap-2.5">
                          <div className="flex items-end gap-1.5">
                            <label className="flex flex-1 flex-col gap-1">
                              <span className="text-xs text-ink-faint">Item</span>
                              <select
                                aria-label={`Item on line ${i + 1}`}
                                value={line.itemId}
                                onChange={(e) => update(i, { itemId: e.target.value })}
                                className={field}
                              >
                                <option value="">Select an item…</option>
                                {allItems.map((it) => (
                                  <option key={it.id} value={it.id}>
                                    {it.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              type="button"
                              onClick={() => setItemModalLine(i)}
                              aria-label={`New item for line ${i + 1}`}
                              className="shrink-0 rounded-lg border border-border-strong px-2.5 py-2 text-xs text-accent"
                            >
                              + New
                            </button>
                          </div>

                          {/* HSN belongs on the item master — 0865 fact 6.
                              Offered, never written silently. */}
                          {item && readHsn && !onFile && (
                            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                              <span>
                                The document shows HSN{" "}
                                <span className="font-mono text-ink-soft">{readHsn}</span> and{" "}
                                {item.name} has none on file.
                              </span>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void saveHsn(item.id, readHsn)}
                                className="rounded border border-border-strong px-2 py-0.5 text-xs text-accent transition-colors hover:bg-surface-2 disabled:opacity-50"
                              >
                                Save it on the item
                              </button>
                            </p>
                          )}
                          {item && readHsn && onFile && onFile !== readHsn && (
                            <p className="text-xs text-warning">
                              The document shows HSN {readHsn}; {item.name} is on file as{" "}
                              {onFile}. Left alone — an HSN already on the item master was put
                              there by somebody, and a photograph is not grounds to overwrite it.
                            </p>
                          )}
                          {item && readHsn && onFile === readHsn && (
                            <p className="text-xs text-success">
                              HSN {onFile} on the item master matches the document.
                            </p>
                          )}

                          <div className="grid grid-cols-3 gap-2.5">
                            <label className="flex flex-col gap-1">
                              <span className="text-xs text-ink-faint">
                                Qty {item ? `(${item.uom})` : ""}
                              </span>
                              <input
                                inputMode="decimal"
                                aria-label={`Quantity on line ${i + 1}`}
                                value={line.quantity}
                                onChange={(e) => update(i, { quantity: e.target.value })}
                                className={field + " text-right tabular-nums"}
                              />
                            </label>
                            <label className="flex flex-col gap-1">
                              <span className="text-xs text-ink-faint">Rate</span>
                              <input
                                inputMode="decimal"
                                aria-label={`Rate on line ${i + 1}`}
                                value={line.rate}
                                onChange={(e) => update(i, { rate: e.target.value })}
                                className={field + " text-right tabular-nums"}
                              />
                            </label>
                            <label className="flex flex-col gap-1">
                              <span className="text-xs text-ink-faint">Disc %</span>
                              <input
                                inputMode="decimal"
                                aria-label={`Discount percent on line ${i + 1}`}
                                value={line.discountPercent}
                                placeholder="0"
                                onChange={(e) => update(i, { discountPercent: e.target.value })}
                                className={field + " text-right tabular-nums"}
                              />
                            </label>
                          </div>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs text-ink-faint">
                              Description <span className="font-normal">optional</span>
                            </span>
                            <input
                              aria-label={`Description on line ${i + 1}`}
                              value={line.description}
                              onChange={(e) => update(i, { description: e.target.value })}
                              className={field}
                            />
                          </label>
                        </div>

                        <div className="mt-2.5 flex items-center justify-between border-t border-border pt-2 text-sm">
                          {gstOn && (
                            <span className="text-xs text-ink-faint">
                              GST {item ? `${item.gst_rate_percent}%` : "—"}
                            </span>
                          )}
                          <span className="ml-auto tabular-nums font-mono font-medium">
                            {formatINR(net)}
                            {discount > 0 && (
                              <span className="block text-right text-[11px] font-sans font-normal text-ink-faint">
                                {formatINR(gross)} − {formatINR(discount)} disc.
                              </span>
                            )}
                          </span>
                        </div>
                        {lineOff && readAmount != null && (
                          <p className="mt-1.5 text-xs text-warning">
                            This line computes {formatINR(net)}, but the document reads{" "}
                            {formatINR(readAmount)} against it.
                          </p>
                        )}
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => setLines((p) => [...p, emptyLine()])}
                    className="self-start rounded px-2 py-1 text-xs text-accent underline underline-offset-4"
                  >
                    Add line
                  </button>

                  <div className="rounded-lg border border-border bg-bg p-3 text-sm">
                    <div className="flex justify-between tabular-nums font-mono">
                      <span className="text-ink-faint">Lines so far</span>
                      <span>{formatINR(taxable, { showZero: true })}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-faint">
                      Tax and the comparison against what the document says come on step 3, once
                      the lines are settled.
                    </p>
                  </div>
                </div>
              </section>
            )}

            {/* ══ STEP 3 — the whole invoice ══════════════════════════════ */}
            {step === 3 && (
              <section className="mt-5" aria-label="Step 3: whole invoice">
                <h3 className="text-sm font-semibold text-ink">Does the whole thing agree?</h3>
                <p className="mt-1 text-sm text-ink-soft">
                  The header facts, and every figure this draft computes beside the one the model
                  read off the paper.
                </p>

                <div className="mt-4 grid gap-4 sm:grid-cols-3">
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
                    <span className="text-sm font-medium">
                      {cfg.referenceLabel}{" "}
                      <span className="font-normal text-ink-faint">optional</span>
                    </span>
                    <input
                      aria-label={cfg.referenceLabel}
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      className={field}
                    />
                    <span className="text-xs text-ink-faint">
                      The other side&rsquo;s own document number — not the challan below.
                    </span>
                  </label>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Branch</span>
                    <select
                      aria-label="Branch"
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

                  {/* vouchers.challan_number / challan_date (0865). A
                      DIFFERENT fact from reference_number above: that is the
                      counterparty's document, this is the delivery challan
                      the goods actually moved on, and an invoice raised
                      after a Rule 55(4) removal carries both at once. */}
                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">
                      {cfg.challanLabel}{" "}
                      <span className="font-normal text-ink-faint">optional</span>
                    </span>
                    <input
                      aria-label={cfg.challanLabel}
                      value={challanNumber}
                      onChange={(e) => setChallanNumber(e.target.value)}
                      className={field}
                    />
                    <span className="text-xs text-ink-faint">{cfg.challanHelp}</span>
                  </label>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">
                      Challan date <span className="font-normal text-ink-faint">optional</span>
                    </span>
                    <input
                      type="date"
                      aria-label="Challan date"
                      value={challanDate}
                      onChange={(e) => setChallanDate(e.target.value)}
                      className={field}
                    />
                    <span className="text-xs text-ink-faint">
                      The challan&rsquo;s own date, not this document&rsquo;s. A dated challan whose
                      number is illegible is still a real reading, so this is accepted on its own.
                    </span>
                  </label>

                  <VoucherNumberField
                    policy={policy}
                    manualNumber={manualNumber}
                    onManualNumberChange={setManualNumber}
                    seriesId={effectiveSeriesId}
                    onSeriesIdChange={setSeriesId}
                  />

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{cfg.tradingLabel}</span>
                      <button
                        type="button"
                        onClick={() => setTradingModalOpen(true)}
                        className="text-xs text-accent underline underline-offset-4"
                      >
                        + New
                      </button>
                    </div>
                    <select
                      aria-label={cfg.tradingLabel}
                      value={tradingId}
                      onChange={(e) => setTradingId(e.target.value)}
                      className={field}
                    >
                      <option value="">Select…</option>
                      {tradingLedgers.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Godown</span>
                    <select
                      aria-label="Godown"
                      value={godownId}
                      onChange={(e) => setGodownId(e.target.value)}
                      className={field}
                    >
                      {godowns.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.code} — {g.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  {gstOn && (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-sm font-medium">Place of supply</span>
                      <select
                        aria-label="Place of supply"
                        value={placeOfSupply}
                        onChange={(e) => {
                          setPlaceOfSupply(e.target.value);
                          setPlaceOfSupplyTouched(true);
                        }}
                        className={field}
                      >
                        <option value="">Select…</option>
                        {states.map((s) => (
                          <option key={s.code} value={s.code}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                {/* ── Computed vs read, component by component ───────────── */}
                <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-bg">
                  <table className="w-full min-w-[26rem] text-sm">
                    <caption className="px-3 pt-3 text-left text-xs font-medium uppercase tracking-wide text-ink-faint">
                      This draft, against what was read off the document
                    </caption>
                    <thead>
                      <tr className="text-xs text-ink-faint">
                        <th scope="col" className="px-3 py-2 text-left font-medium">
                          &nbsp;
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          On the document
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          This draft
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                          Difference
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.map((r) => {
                        const diff = r.read == null ? null : r.computed - r.read;
                        const off = diff != null && Math.abs(diff) > 1;
                        return (
                          <tr
                            key={r.key}
                            className={
                              "border-t border-border " + (r.key === "total" ? "font-semibold" : "")
                            }
                          >
                            <th scope="row" className="px-3 py-2 text-left font-normal text-ink-soft">
                              {r.label}
                            </th>
                            <td className="px-3 py-2 text-right tabular-nums font-mono text-ink-soft">
                              {r.read == null ? "not read" : formatINR(r.read, { showZero: true })}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-mono">
                              {formatINR(r.computed, { showZero: true })}
                            </td>
                            <td
                              className={
                                "px-3 py-2 text-right tabular-nums font-mono " +
                                (diff == null ? "text-ink-faint" : off ? "text-warning" : "text-success")
                              }
                            >
                              {diff == null
                                ? "—"
                                : (diff > 0 ? "+" : "") + formatINR(diff, { showZero: true })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="border-t border-border px-3 py-2">
                    {mismatchRows.length > 0 ? (
                      <p className="text-xs text-warning">
                        {mismatchRows.map((r) => r.label).join(", ")}{" "}
                        {mismatchRows.length === 1 ? "does" : "do"} not agree with the document by
                        more than a rupee. Go back to the lines and check the quantities and rates
                        before posting — the figures in the &ldquo;this draft&rdquo; column are what
                        will be written to the ledger.
                      </p>
                    ) : comparison.some((r) => r.read != null) ? (
                      <p className="text-xs text-success">
                        Every figure the model could read agrees with this draft to within a rupee.
                      </p>
                    ) : (
                      <p className="text-xs text-ink-faint">
                        The model read no totals off this document, so there is nothing to compare
                        against — check the lines yourself.
                      </p>
                    )}
                    {!supplyType && gstOn && (
                      <p className="mt-1 text-xs text-ink-faint">
                        No tax is shown yet because the place of supply is not set — pick one above
                        and the CGST/SGST/IGST split appears.
                      </p>
                    )}
                    {tcsLikely && (
                      <p className="mt-1 text-xs text-ink-faint">
                        One or more items carry a TCS section. TCS under Sec 206C is computed by
                        the database when this posts, and is deliberately not previewed here — the
                        posted total will be a little higher than the figure above.
                      </p>
                    )}
                  </div>
                </div>

                <label className="mt-5 flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Narration</span>
                  <textarea
                    rows={2}
                    aria-label="Narration"
                    value={narration}
                    onChange={(e) => setNarration(e.target.value)}
                    className={field}
                  />
                </label>
              </section>
            )}

            {error && (
              <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
            )}

            <p className="mt-5 text-xs text-ink-faint">
              Posting calls the same create_invoice the ordinary invoice screen uses — a{" "}
              {cfg.label.toLowerCase()} posts a <strong>{cfg.voucherType}</strong> voucher through
              it, and nothing here bypasses it. Nothing is written to your books until you press
              the post button on step 3.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              {step > 1 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setStep((s) => (s === 3 ? 2 : 1));
                  }}
                  className="rounded-lg border border-border-strong px-4 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-2 disabled:opacity-50"
                >
                  Back
                </button>
              )}
              {step < 3 ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={goNext}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  Next: {step === 1 ? "items" : "whole invoice"}
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? "Posting…" : cfg.postLabel}
                </button>
              )}
            </div>
          </>
        )}
      </form>

      {/* The three popups, reused exactly as they stand — see the file header
          on why neither takes the extracted values as a starting point. */}
      <QuickAddLedgerModal
        open={partyModalOpen}
        onClose={() => setPartyModalOpen(false)}
        companyId={companyId}
        title={`New ${cfg.partyLabel.toLowerCase()}`}
        description={cfg.quickAddDescription}
        roles={[cfg.quickAddRole]}
        onCreated={(created: QuickAddedLedger) => {
          setAddedLedgers((prev) => [
            ...prev,
            {
              id: created.id,
              name: created.name,
              ledger_role: created.ledger_role,
              state_code: created.state_code,
              pan: created.pan,
              gstin: created.gstin,
            },
          ]);
          setPartyId(created.id);
          if (!placeOfSupplyTouched && created.state_code) setPlaceOfSupply(created.state_code);
          router.refresh();
        }}
      />

      <QuickAddLedgerModal
        open={tradingModalOpen}
        onClose={() => setTradingModalOpen(false)}
        companyId={companyId}
        title={`New ${cfg.tradingLabel.toLowerCase()}`}
        description={cfg.tradingDescription}
        roles={cfg.tradingRoles}
        onCreated={(created: QuickAddedLedger) => {
          setAddedLedgers((prev) => [
            ...prev,
            {
              id: created.id,
              name: created.name,
              ledger_role: created.ledger_role,
              state_code: created.state_code,
              pan: created.pan,
              gstin: created.gstin,
            },
          ]);
          setTradingId(created.id);
          router.refresh();
        }}
      />

      <QuickAddItemModal
        open={itemModalLine !== null}
        onClose={() => setItemModalLine(null)}
        companyId={companyId}
        gstOn={gstOn}
        // An invoice line is a stock line — voucher_items refuses anything
        // that does not maintain stock. See the prop's own comment.
        requireStockItem
        onCreated={async (created: QuickAddedItem) => {
          const lineIndex = itemModalLine;
          // QuickAddedItem does not carry hsn_sac — the modal writes it but
          // does not read it back, and it is not this screen's file to change.
          // Read it here so the "save the HSN on this item" offer below knows
          // whether the preparer already typed it into the popup.
          const { data: fresh } = await createClient()
            .from("items")
            .select("hsn_sac")
            .eq("id", created.id)
            .maybeSingle();
          setAddedItems((prev) => [
            ...prev,
            {
              id: created.id,
              name: created.name,
              uom: created.uom,
              hsn_sac: fresh?.hsn_sac ?? null,
              sale_rate: created.sale_rate,
              purchase_rate: created.purchase_rate,
              gst_rate_percent: created.gst_rate_percent,
              default_tcs_section: created.default_tcs_section,
            },
          ]);
          if (lineIndex !== null) {
            const suggested = isSale ? created.sale_rate : created.purchase_rate;
            setLines((prev) =>
              prev.map((l, idx) =>
                idx === lineIndex
                  ? { ...l, itemId: created.id, rate: l.rate || (suggested ? String(suggested) : "") }
                  : l
              )
            );
          }
          router.refresh();
        }}
      />
    </>
  );
}
