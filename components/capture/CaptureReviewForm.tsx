"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR, sumPaise, toPaise } from "@/lib/utils/currency";
import {
  matchItem,
  matchParty,
  type ItemMatch,
  type PartyMatch,
} from "@/lib/capture/fuzzyMatch";
import type {
  CaptureDocumentType,
  CaptureExtraction,
  CaptureLineItem,
} from "@/lib/capture/analyze";
import {
  QuickAddLedgerModal,
  type LedgerPrefill,
  type QuickAddedLedger,
} from "@/components/ledgers/QuickAddLedgerModal";
import {
  QuickAddItemModal,
  type ItemPrefill,
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
 * IDENTIFYING THE PARTY: THREE SIGNALS, NOT ONE
 * ============================================================================
 * 0740 matched the party BY NAME ONLY, which is the weakest thing on an
 * invoice — while the same invoice prints a GSTIN, which identifies exactly
 * one registration of one legal entity and is checksummed. lib/capture/
 * fuzzyMatch.ts's matchParty now tries GSTIN, then PAN, then the name, and
 * says WHICH one hit; this screen treats the three differently, because they
 * do not deserve the same confidence:
 *
 *   gstin — selected outright. The same GSTIN is the same registration.
 *   name  — selected outright, as it always was, and labelled as a name match
 *           so the reader knows how thin the evidence is.
 *   pan   — NEVER selected automatically. A shared PAN means the same
 *           BUSINESS with (almost always) a different state registration, and
 *           silently posting a Gujarat bill against a Maharashtra ledger would
 *           put the wrong place of supply on the voucher and the wrong GSTIN
 *           in GSTR-1. It is offered instead, with that said in words, and one
 *           click accepts it.
 *
 * A GSTIN that matches a ledger the document type CANNOT use as a party (the
 * supplier already exists as a customer) is reported too — it is the answer to
 * "why can I not find them in the list", and this schema genuinely needs a
 * second ledger for the other side.
 *
 * ============================================================================
 * IDENTIFYING THE ITEM: THE SAME ARGUMENT, ONE LINE FURTHER DOWN THE PAGE
 * ============================================================================
 * 0740 matched each line to an item BY ITS DESCRIPTION ONLY — and a
 * description is written by the SUPPLIER'S billing clerk, not by the company
 * reading the bill, so "CTN SHRTNG 44in GREY" and our own "Cotton Shirting
 * 44 inch Grey" are the same goods and score nothing alike. The same line
 * prints an HSN, which rule 46(g) requires and which both parties take from
 * the same tariff. lib/capture/fuzzyMatch.ts's matchItem now tries the HSN
 * and the name together, then the HSN alone, then the name alone, and says
 * which fired. This screen treats the three differently for the same reason
 * it treats the party's three differently:
 *
 *   hsn_and_name — selected outright. The right family AND the right name.
 *   name         — selected outright, as it always was, and labelled a name
 *                  match so the reader knows how thin the evidence is.
 *   hsn          — NEVER selected. An HSN is a code for a CLASS of goods:
 *                  5208 is every plain cotton fabric a mill sells. Every item
 *                  sharing the code is offered instead, best-name-first, and
 *                  one click accepts any of them. Choosing arbitrarily would
 *                  post the wrong item to stock — the same voucher, the same
 *                  total, the wrong godown balance, and nothing on the face of
 *                  the invoice to show it.
 *
 * ============================================================================
 * INLINE MASTER CREATION IS REUSED, NOT REBUILT — AND IS NOW PREFILLED
 * ============================================================================
 * QuickAddLedgerModal and QuickAddItemModal are still used as they stand, and
 * BOTH now take the optional `prefill` prop this file's header used to ask
 * for. The whole party master the model read — name, GSTIN, PAN, address,
 * town, PIN, phone, email, Udyam number and their bank block — and the whole
 * item master it read off the line — description, HSN, unit, GST rate and the
 * rate — are handed straight to their popups instead of being retyped out of
 * them. The COPY chips stay: they are still the only way to get a value into
 * a field the popup is not asking for, and they still work when nothing
 * matched.
 *
 * The item popup is also told WHICH SIDE of the trade it was opened from
 * (`rateSide`), and that is not cosmetic. The rate on a supplier's bill is
 * what THEY charge US: it is a purchase rate, and the popup used to write
 * every rate to items.sale_rate. Creating an item from a captured purchase
 * bill therefore recorded our cost as our selling price, and the next sales
 * invoice for it prefilled at cost. Rare while few items were made that way;
 * routine the moment this screen makes it the normal path. Fixed in the popup
 * itself — see its header — and passed from here as sale on a sales challan,
 * purchase on a purchase bill.
 *
 * HSN is the one extracted value that must not be lost, because it belongs on
 * the ITEM MASTER (public.items.hsn_sac) and voucher_items only ever holds a
 * copy taken at posting time. So where the bill shows an HSN and the matched
 * (or just-created) item has none, this screen offers a single explicit button
 * that writes it onto the item — never silently, never overwriting one already
 * on file, and shown as a plain disagreement when the two differ. The UNIT and
 * the GST RATE are shown against an existing item the same way but are NOT
 * offered as a write-back: an HSN is a fact about the goods that both parties
 * copy from one tariff, whereas a unit is a fact about how THIS supplier packs
 * them (they sell rolls, we stock metres) and a rate on their paper is their
 * classification, not ours. Both belong on a master being created; neither is
 * grounds to edit a master already on file.
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
  /**
   * The description AS PRINTED, kept beside the editable one.
   *
   * `description` above starts as this value and is then the preparer's to
   * change — it ends up in the voucher line's own description. The matcher and
   * every "the document reads …" sentence must go on quoting the paper after
   * that edit, exactly as the party block quotes extraction.vendor_name rather
   * than whatever is in the party box now.
   */
  readDescription: string;
  /**
   * The unit printed against this line, already resolved to a ref_uom code by
   * analyze.ts. Belongs on the ITEM MASTER (items.uom) — a voucher line has no
   * unit of its own, it inherits the item's.
   */
  readUom: string | null;
  /**
   * The whole GST rate printed against this line — 18, never the 9 in a CGST
   * column. Belongs on the ITEM MASTER (items.gst_rate_percent), which is also
   * where the tax on step 3 is computed from, so a disagreement between this
   * and the matched item is the explanation for a total that will not tally.
   */
  readGstRate: number | null;
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

/**
 * An HSN-only match is a suggestion, never a selection — see the file header.
 * Every other signal preselects the item, which is 0740's behaviour for the
 * name and the new, stronger behaviour for the HSN-and-name pair.
 *
 * The party's own rule is written the same way one screen up (autoSelects), and
 * the two are deliberately the same shape: one predicate saying which signals
 * this screen is willing to act on without being asked.
 */
function autoSelectsItem(m: ItemMatch<Item> | null): boolean {
  return m !== null && m.signal !== "hsn";
}

/** What one captured line says about which item it is, in matchItem's terms. */
function itemReading(li: { readDescription: string; readHsn: string | null }) {
  return { description: li.readDescription, hsn_sac: li.readHsn };
}

function extractionLineToFormLine(li: CaptureLineItem, items: Item[], isSale: boolean): Line {
  const readHsn = li.hsn_sac?.trim() || null;
  const match = matchItem({ description: li.description, hsn_sac: readHsn }, items);
  const selected = autoSelectsItem(match) ? match!.item : null;
  const fallbackRate = isSale ? selected?.sale_rate : selected?.purchase_rate;
  return {
    itemId: selected?.id ?? "",
    quantity: li.quantity != null ? String(li.quantity) : "1",
    rate: li.rate != null ? String(li.rate) : fallbackRate != null ? String(fallbackRate) : "",
    // Read off the document (0147's column). Missing this was what made a
    // 60%-discounted line compute 6,279.00 against a printed 2,511.60.
    discountPercent: li.discount_percent != null ? String(li.discount_percent) : "",
    description: li.description,
    readAmount: li.amount ?? null,
    readHsn,
    readDescription: li.description,
    // Both already normalised by analyze.ts to what public.items will accept —
    // a ref_uom code and a notified rate — so anything surviving here is
    // insertable. `?? null` only because both keys are absent from every
    // extraction stored before this feature.
    readUom: li.uom ?? null,
    readGstRate: li.gst_rate_percent ?? null,
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
  readDescription: "",
  readUom: null,
  readGstRate: null,
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
 * Both popups now take their own prefill, so this is no longer the only way a
 * read value reaches a master. It stays because it is still the only way to
 * get a value into a field the popup is NOT asking for — and because the popup
 * covers the text it was read from, so a preparer who wants a figure anywhere
 * else would otherwise have to close it, memorise the number and reopen it.
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

/**
 * What the document says about who it is with, in matchParty's own three
 * terms. `hint` is what the person holding the phone typed into "who is this
 * from?" — the only identification a draft has when OCR read nothing at all,
 * and a name, never a number.
 */
function partyReading(ex: CaptureExtraction | null, hint: string | null) {
  return {
    name: ex?.vendor_name ?? hint,
    gstin: ex?.vendor_gstin ?? null,
    pan: ex?.vendor_pan ?? null,
  };
}

/**
 * A PAN match is a suggestion, never a selection — see the file header. Every
 * other signal preselects the party, which is 0740's behaviour for the name
 * and the new, stronger behaviour for the GSTIN.
 */
function autoSelects(m: PartyMatch<Ledger> | null): boolean {
  return m !== null && m.signal !== "pan";
}

/**
 * The whole party master the model read, in QuickAddLedgerModal's own shape.
 *
 * Passed whenever this screen opens the party popup, even when the extraction
 * is empty: on THIS screen the document is on the display behind the popup, so
 * an empty address box is somewhere to type what is visibly printed, not
 * clutter. The invoice and voucher screens pass no prefill at all and never
 * see these fields — see QuickAddLedgerModal's header.
 */
function partyPrefill(ex: CaptureExtraction | null, hint: string | null): LedgerPrefill {
  return {
    name: ex?.vendor_name ?? hint ?? "",
    gstin: ex?.vendor_gstin ?? null,
    pan: ex?.vendor_pan ?? null,
    stateCode: ex?.vendor_state_code ?? null,
    address: ex?.vendor_address ?? null,
    city: ex?.vendor_city ?? null,
    pincode: ex?.vendor_pincode ?? null,
    phone: ex?.vendor_phone ?? null,
    email: ex?.vendor_email ?? null,
    udyamNumber: ex?.vendor_udyam_number ?? null,
    bankName: ex?.vendor_bank_name ?? null,
    bankAccountNumber: ex?.vendor_bank_account_number ?? null,
    bankIfsc: ex?.vendor_bank_ifsc ?? null,
  };
}

/**
 * The whole item master one captured line describes, in QuickAddItemModal's
 * own shape.
 *
 * Passed whenever this screen opens the item popup, even for a line the
 * preparer added by hand: on THIS screen the document is on the display behind
 * the popup, so an empty HSN box is somewhere to type what is visibly printed,
 * not clutter. The invoice screen passes no prefill and is unaffected — see
 * QuickAddItemModal's header.
 *
 * The description is seeded as the NAME, which is the one value here that is
 * genuinely a guess rather than a reading: a supplier's line text is how THEY
 * describe the goods, and it becomes this company's own item name only if the
 * preparer leaves it alone. It is seeded anyway because a name is required and
 * an editable wrong name beats an empty box beside a covered document.
 */
function itemPrefill(line: Line): ItemPrefill {
  return {
    name: line.readDescription || line.description || "",
    hsnSac: line.readHsn,
    uom: line.readUom,
    gstRatePercent: line.readGstRate,
    // The rate as read, falling back to whatever is in the line's own rate box
    // — the preparer may have corrected it against the paper already, and the
    // corrected figure is the better one to carry into the master.
    rate: line.rate.trim() ? Number(line.rate) : null,
  };
}

/** Uppercase, separators stripped — the same comparison matchParty makes. */
function sameCode(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/[\s.-]/g, "").toUpperCase() === b.replace(/[\s.-]/g, "").toUpperCase();
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
    const m = matchParty(
      partyReading(extraction, draft.vendorHint),
      ledgers.filter((l) => conf.partyRoles.includes(l.ledger_role))
    );
    return autoSelects(m) ? m!.party.id : "";
  });
  const [placeOfSupplyTouched, setPlaceOfSupplyTouched] = useState(false);
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [tradingId, setTradingId] = useState("");
  // The document's own printed number, seeded the same way the date above is.
  // It lands in vouchers.reference_number, which this screen labels "Their
  // bill no." on a purchase — the supplier's invoice number, off their paper.
  const [reference, setReference] = useState(() => extraction?.bill_number ?? "");
  // The bill-to check is a flag, never a gate: a sister concern, a group
  // company or a branch billed under another name are all ordinary reasons
  // for a supplier to address paper elsewhere. Acknowledging it collapses the
  // banner; it never changes what is posted.
  const [wrongCompanyAcknowledged, setWrongCompanyAcknowledged] = useState(false);
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
  //
  // The vendor HINT is deliberately not fed in here, unlike the initial
  // selection above: this value drives sentences that say what the DOCUMENT
  // reads, and what somebody typed on a phone is not what the document reads.
  const partyMatch = matchParty(
    { name: extraction?.vendor_name, gstin: extraction?.vendor_gstin, pan: extraction?.vendor_pan },
    partyLedgers
  );

  /**
   * A ledger carrying the document's GSTIN that this document type cannot use
   * as its party — the supplier already on file as a customer, or the reverse.
   *
   * Not a duplicate and not offerable: the party dropdown filters on the
   * ledger's GROUP role, and one ledger sits in one group, so a business that
   * both buys and sells genuinely needs two ledgers in this schema. Reported
   * because it is the answer to "we deal with them, why are they not in the
   * list" — which otherwise ends in a second ledger created under a
   * mangled name.
   */
  const crossRoleGstinLedger =
    extraction?.vendor_gstin
      ? (allLedgers.find(
          (l) => !cfg.partyRoles.includes(l.ledger_role) && sameCode(l.gstin, extraction.vendor_gstin)
        ) ?? null)
      : null;

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
    // Same three signals and the same "a PAN match is offered, not taken" rule
    // as the initial selection — switching the document type must not quietly
    // apply a weaker rule than opening the screen did.
    const matched = matchParty(partyReading(ex, draft.vendorHint), candidates);
    const matchedParty = autoSelects(matched) ? matched!.party : null;

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
                    {/* The rest of the party master. Every one of these has a
                        column on public.ledgers waiting for it, and every one
                        of them is handed to the "+ New" popup as a prefill —
                        the chips are here so a value can also be pasted
                        somewhere the popup does not ask for it. */}
                    {extraction?.vendor_pan && <ReadChip label="PAN" value={extraction.vendor_pan} />}
                    {extraction?.vendor_address && (
                      <ReadChip label="Address" value={extraction.vendor_address} />
                    )}
                    {extraction?.vendor_city && <ReadChip label="Town" value={extraction.vendor_city} />}
                    {extraction?.vendor_pincode && (
                      <ReadChip label="PIN" value={extraction.vendor_pincode} />
                    )}
                    {extraction?.vendor_phone && (
                      <ReadChip label="Phone" value={extraction.vendor_phone} />
                    )}
                    {extraction?.vendor_email && (
                      <ReadChip label="Email" value={extraction.vendor_email} />
                    )}
                    {extraction?.vendor_udyam_number && (
                      <ReadChip label="Udyam" value={extraction.vendor_udyam_number} />
                    )}
                    {extraction?.vendor_bank_account_number && (
                      <ReadChip label="A/c" value={extraction.vendor_bank_account_number} />
                    )}
                    {extraction?.vendor_bank_ifsc && (
                      <ReadChip label="IFSC" value={extraction.vendor_bank_ifsc} />
                    )}
                    {extraction?.vendor_bank_name && (
                      <ReadChip label="Bank" value={extraction.vendor_bank_name} />
                    )}
                  </div>

                  {/* What the reader had to reconcile or throw away. Machine
                      warnings, not the model's own note — a PAN that
                      disagrees with the PAN inside the GSTIN is exactly the
                      thing to look at before a master record is created. */}
                  {extraction?.party_warnings?.length ? (
                    <ul className="mt-2 flex flex-col gap-1">
                      {extraction.party_warnings.map((w) => (
                        <li key={w} className="text-xs text-warning">
                          {w}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {extraction?.vendor_udyam_number && (
                    <p className="mt-2 text-xs text-ink-faint">
                      The Udyam number proves this supplier is on the MSME register. It does{" "}
                      <span className="text-ink-soft">not</span> say whether they are micro,
                      small or medium — the number carries no category and neither does the
                      invoice. Sec 43B(h) covers micro and small only, so until somebody sets
                      the category on the ledgers screen this supplier stays out of the MSME
                      dues report. The payment deadline is left unset too: 45 days needs a
                      written agreement, 15 without one, and that is a fact about a contract,
                      not about this bill.
                    </p>
                  )}

                  <p className="mt-2 text-xs text-ink-faint">
                    All of this is carried into the &ldquo;+ New&rdquo; popup already — the chips
                    are for pasting a value somewhere else.
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

                  {/*
                    WHICH SIGNAL MATCHED, said out loud. "Same GSTIN" and
                    "similar name" are not the same claim and must not read
                    like one: the first is the GST Network's own identifier for
                    one registration, the second is a token-overlap heuristic
                    over a shop name that half a district shares.
                  */}
                  {partyMatch && partyMatch.party.id === partyId && (
                    <p
                      className={
                        "text-xs " +
                        (partyMatch.signal === "gstin" ? "text-success" : "text-ink-faint")
                      }
                    >
                      {partyMatch.signal === "gstin" ? (
                        <>
                          Same GSTIN — this is{" "}
                          <span className="font-medium">{partyMatch.party.name}</span>, already on
                          file. A GSTIN identifies one registration of one business, so there is
                          nothing to create here.
                        </>
                      ) : (
                        <>
                          Matched <span className="text-ink-soft">{partyMatch.party.name}</span> by
                          NAME only, from the document&rsquo;s &ldquo;
                          {extraction?.vendor_name ?? draft.vendorHint}&rdquo; — the weakest signal
                          on the page. Check it is the right one.
                        </>
                      )}
                    </p>
                  )}

                  {/*
                    A PAN match. Never selected for the preparer — see the file
                    header — because two registrations of one business are two
                    ledgers here, and picking the wrong one puts the wrong
                    place of supply on the voucher and the wrong GSTIN in
                    GSTR-1. Offered with the reason, and one click accepts it.
                  */}
                  {partyMatch && partyMatch.signal === "pan" && partyMatch.party.id !== partyId && (
                    <div className="rounded-lg border border-warning/40 bg-warning-soft/40 px-3 py-2">
                      <p className="text-xs text-ink-soft">
                        <span className="font-medium text-ink">{partyMatch.party.name}</span> is on
                        file under the same PAN. That is the same legal business — but{" "}
                        {partyMatch.party.gstin && extraction?.vendor_gstin
                          ? `a different GST registration (${partyMatch.party.gstin} on file, ${extraction.vendor_gstin} on this document), which normally means a different state.`
                          : "probably a different state registration."}{" "}
                        Use it only if this bill really belongs to that registration; otherwise
                        create the second one with &ldquo;+ New&rdquo;.
                      </p>
                      <button
                        type="button"
                        onClick={() => selectParty(partyMatch.party.id)}
                        className="mt-1.5 text-xs font-medium text-accent underline underline-offset-4"
                      >
                        Use {partyMatch.party.name}
                      </button>
                    </div>
                  )}

                  {crossRoleGstinLedger && (
                    <p className="text-xs text-ink-faint">
                      This GSTIN is already on file as{" "}
                      <span className="text-ink-soft">{crossRoleGstinLedger.name}</span>, but under
                      a group this document cannot be posted against — so it is not in the list
                      above. A business you both buy from and sell to needs one ledger on each
                      side; create the {cfg.partyLabel.toLowerCase()} one with &ldquo;+ New&rdquo;.
                    </p>
                  )}

                  {(extraction?.vendor_name || draft.vendorHint) && (
                    <p className="text-xs text-ink-faint">
                      {partyMatch && partyMatch.party.id === partyId ? null : partyId ? (
                        <>
                          Chosen by hand. The document reads &ldquo;
                          {extraction?.vendor_name ?? draft.vendorHint}&rdquo;.
                        </>
                      ) : partyMatch ? null : (
                        <>
                          No {cfg.partyLabel.toLowerCase()} on file matches &ldquo;
                          {extraction?.vendor_name ?? draft.vendorHint}&rdquo; by GSTIN, PAN or
                          name. Create one with &ldquo;+ New&rdquo; — everything read off the
                          document is already filled in — or pick an existing one. Posting needs a
                          real ledger id, so the name on its own can never be sent.
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
                    /*
                     * Recomputed per render rather than stored on the line, for
                     * the same reason partyMatch is: `allItems` grows when the
                     * preparer creates a master from this very screen, and a
                     * match frozen at seeding time would go on saying "nothing
                     * on file is like this" about an item that now exists.
                     *
                     * Matched on what the DOCUMENT reads, never on the
                     * editable description — the same rule the party block
                     * follows.
                     */
                    const match = matchItem(itemReading(line), allItems);
                    // The HSN family, offered when this screen will not choose
                    // from it. Suppressed once the selection IS one of them:
                    // the question has been answered.
                    const hsnFamily =
                      match && match.signal === "hsn" &&
                      !match.candidates.some((c) => c.id === line.itemId)
                        ? match.candidates
                        : null;
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

                        {(line.readDescription ||
                          readAmount != null ||
                          readHsn ||
                          line.readUom ||
                          line.readGstRate != null) && (
                          <div className="mb-2.5 rounded-md border border-border bg-bg p-2">
                            <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                              Read off the document
                            </p>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {line.readDescription && (
                                <ReadChip label="Description" value={line.readDescription} />
                              )}
                              {readHsn && <ReadChip label="HSN" value={readHsn} />}
                              {line.readUom && <ReadChip label="Unit" value={line.readUom} />}
                              {line.readGstRate != null && (
                                <ReadChip label="GST" value={`${line.readGstRate}%`} />
                              )}
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
                                All of this is carried into the &ldquo;+ New&rdquo; popup already —
                                the chips are for pasting a value somewhere else. The{" "}
                                {isSale ? "rate is saved as the sale rate" : "rate is saved as the purchase rate, not as what you sell it for"}.
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

                          {/*
                            WHICH SIGNAL MATCHED, said out loud — the same
                            three-way distinction the party block makes one
                            step up. "The same HSN and a name like it" and
                            "one of eleven things sharing a tariff heading"
                            are not the same claim and must not read alike.
                          */}
                          {match && match.item.id === line.itemId && (
                            <p
                              className={
                                "text-xs " +
                                (match.signal === "hsn_and_name"
                                  ? "text-success"
                                  : "text-ink-faint")
                              }
                            >
                              {match.signal === "hsn_and_name" ? (
                                <>
                                  Same HSN <span className="font-mono">{readHsn}</span> and a
                                  matching name — this is{" "}
                                  <span className="font-medium">{match.item.name}</span>, already
                                  on file.
                                </>
                              ) : (
                                <>
                                  Matched <span className="text-ink-soft">{match.item.name}</span>{" "}
                                  by NAME only, from the document&rsquo;s &ldquo;
                                  {line.readDescription}&rdquo; — the weakest signal on the line,
                                  and the supplier wrote it. Check it is the right one.
                                </>
                              )}
                            </p>
                          )}

                          {/*
                            An HSN-only match. Never chosen for the preparer —
                            see the file header — because an HSN names a class
                            of goods, not a product, and posting the wrong item
                            moves the wrong stock at the right total. Every
                            member of the family is offered, best-name-first,
                            and one click accepts any of them.
                          */}
                          {hsnFamily && (
                            <div className="rounded-lg border border-warning/40 bg-warning-soft/40 px-3 py-2">
                              <p className="text-xs text-ink-soft">
                                {hsnFamily.length === 1 ? (
                                  <>
                                    <span className="font-medium text-ink">
                                      {hsnFamily[0].name}
                                    </span>{" "}
                                    is on file under the same HSN{" "}
                                    <span className="font-mono">{readHsn}</span>, but is not called
                                    anything like &ldquo;{line.readDescription}&rdquo;.
                                  </>
                                ) : (
                                  <>
                                    {hsnFamily.length} items on file carry HSN{" "}
                                    <span className="font-mono">{readHsn}</span>, and none is called
                                    anything like &ldquo;{line.readDescription}&rdquo;.
                                  </>
                                )}{" "}
                                An HSN covers a whole family of goods, so this screen will not
                                choose for you — the wrong one posts the right total against the
                                wrong stock. Pick the right one, or create a new item.
                              </p>
                              <div className="mt-1.5 flex flex-wrap gap-2">
                                {hsnFamily.map((c) => (
                                  <button
                                    key={c.id}
                                    type="button"
                                    onClick={() => update(i, { itemId: c.id })}
                                    className="text-xs font-medium text-accent underline underline-offset-4"
                                  >
                                    Use {c.name}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

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

                          {/*
                            The unit and the rate the document printed, against
                            what the item already holds. REPORTED, NOT OFFERED
                            AS A WRITE-BACK, unlike the HSN above: a supplier's
                            unit is how THEY pack the goods (they sell rolls,
                            we stock metres) and their tax rate is their own
                            classification. Neither is grounds to edit a master
                            somebody already set up — but both explain a
                            document that will not tally, so they are said.
                          */}
                          {item && line.readUom && line.readUom !== item.uom && (
                            <p className="text-xs text-ink-faint">
                              The document bills this in {line.readUom}; {item.name} is stocked in{" "}
                              {item.uom}. The quantity above is taken as {item.uom} — convert it if
                              the two are not the same measure.
                            </p>
                          )}
                          {gstOn && item && line.readGstRate != null &&
                            line.readGstRate !== Number(item.gst_rate_percent) && (
                              <p className="text-xs text-warning">
                                The document charges GST at {line.readGstRate}% on this line;{" "}
                                {item.name} is on file at {item.gst_rate_percent}%. Step 3 computes
                                the tax from the ITEM, so this is why the totals will not agree.
                                Whichever is wrong, it is fixed on the items screen — not from a
                                photograph.
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
                {extraction?.addressed_to_this_company === false &&
                  !wrongCompanyAcknowledged && (
                    <div className="mb-4 rounded-lg border border-warning bg-warning-soft p-4">
                      <p className="text-sm font-medium text-warning">
                        This bill is addressed to someone else
                      </p>
                      <p className="mt-1 text-sm text-ink-soft">
                        The document is made out to{" "}
                        <span className="font-medium text-ink">
                          {extraction.recipient_name ?? "another party"}
                        </span>
                        {extraction.recipient_gstin ? (
                          <>
                            {" "}(<span className="font-mono text-xs">{extraction.recipient_gstin}</span>)
                          </>
                        ) : null}
                        , which is not this company. Posting it here books another
                        firm&rsquo;s purchase into your accounts and claims their input
                        credit as yours.
                      </p>
                      <p className="mt-1 text-xs text-ink-faint">
                        If that is deliberate — a sister concern, or a supplier who
                        bills a group company — carry on.
                      </p>
                      <button
                        type="button"
                        onClick={() => setWrongCompanyAcknowledged(true)}
                        className="mt-3 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-ink-soft hover:bg-surface-2"
                      >
                        I know, carry on
                      </button>
                    </div>
                  )}

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

      {/* The three popups, reused as they stand. The PARTY and the ITEM one
          are prefilled; the TRADING ledger deliberately is not — it is a
          purchase/expense or income account of ours and nothing on the
          counterparty's letterhead belongs on it. */}
      <QuickAddLedgerModal
        open={partyModalOpen}
        onClose={() => setPartyModalOpen(false)}
        companyId={companyId}
        title={`New ${cfg.partyLabel.toLowerCase()}`}
        description={cfg.quickAddDescription}
        roles={[cfg.quickAddRole]}
        prefill={partyPrefill(extraction, draft.vendorHint)}
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
        /*
         * WHICH COLUMN THE RATE GOES IN. The figure in the rate column of a
         * supplier's bill is what they charge US, and writing it to
         * items.sale_rate — which is what this popup did for every caller
         * until it was given this prop — records our cost as our selling
         * price. See both file headers.
         *
         * Derived from isSale, so it follows the confirmed document type and
         * agrees with the line-rate fallback and the "+ New" hint above. A
         * document typed "other" posts nothing and lands on the purchase
         * side, which is the same choice every other rate decision on this
         * screen already makes for it.
         */
        rateSide={isSale ? "sale" : "purchase"}
        prefill={
          itemModalLine !== null && lines[itemModalLine]
            ? itemPrefill(lines[itemModalLine])
            : undefined
        }
        onCreated={(created: QuickAddedItem) => {
          const lineIndex = itemModalLine;
          setAddedItems((prev) => [
            ...prev,
            {
              id: created.id,
              name: created.name,
              uom: created.uom,
              // Read straight back by the popup now. It used to be re-fetched
              // here because QuickAddedItem did not carry it; it does.
              hsn_sac: created.hsn_sac,
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
