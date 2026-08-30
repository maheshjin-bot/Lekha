/**
 * Shared server-side vision analysis for OCR/vision document capture (0740,
 * made multi-document by 0865).
 *
 * 0740 shipped this as a PURCHASE BILL reader and its prompt said so in its
 * first line. 0865 gave capture_drafts a document_type, so this module now
 * asks the model to work out for itself which of the three kinds of paper it
 * is looking at — a supplier's invoice, the company's own outgoing delivery
 * challan, or something that posts nothing — and to read the per-line HSN/SAC
 * codes and the challan number/date that go with them. The classification is
 * ADVISORY throughout: a human confirms it on the review screen and the
 * database enforces it, so a wrong guess costs one click.
 *
 * Mirrors app/api/support-chat/route.ts's exact Gemini pattern: same model
 * alias, same env var, same "not configured" shape when the key is missing —
 * see that file's own comments for why "gemini-flash-latest" and not a pinned
 * snapshot. This module never throws. A bad image, a missing key, a network
 * failure or a malformed model response all come back as a normal
 * CaptureExtraction with confidence "low" and a `note` explaining why —
 * never an exception the caller has to remember to catch. The caller (the
 * /api/capture/analyze route) always has something to save to
 * capture_drafts.extracted_json, even on total failure.
 *
 * DELIBERATELY NOT HERE: any database access, any Supabase import, any
 * knowledge of capture_drafts. This file takes bytes and returns a typed
 * result — the route owns storage and the table row.
 */

// Ordered fallback, not a single model. Both entries are Google-MAINTAINED
// ALIASES, never pinned snapshots: support-chat's own comment records that
// "gemini-2.5-pro" was retired for new API keys and 404'd, which is exactly
// why an alias is used here. That reasoning still holds — probing this key
// today, the pinned "gemini-2.5-flash" 404s while every alias resolves — so
// the fix for an overloaded model is a SECOND ALIAS, never a pin.
//
// Why a fallback at all: observed live in production, gemini-flash-latest
// returned 503 "This model is currently experiencing high demand" on all
// three retry attempts and on three further probes two minutes later, while
// gemini-flash-lite-latest answered 200 throughout. A sustained overload on
// one model is not something a few hundred milliseconds of backoff can ride
// out, so once the retries are spent we move to the next model rather than
// giving up and making the preparer type the whole bill in by hand.
//
// Lite is second, not first: it is a smaller model and this is OCR of a
// document whose numbers get posted to a ledger, so the stronger model is
// always tried first and lite only rescues an outage.
const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"] as const;

/**
 * What the captured paper IS, mirroring public.capture_drafts.document_type
 * (migration 0865) value-for-value. Keep the two in step: the column has a
 * CHECK constraint on exactly these three strings, and the trigger
 * app_private.enforce_capture_draft maps them to the voucher type it will
 * accept a confirmation against —
 *
 *   'sales_challan'    -> confirms against a SALES voucher
 *   'purchase_invoice' -> confirms against a PURCHASE voucher (0740's original
 *                         and, until 0865, only behaviour)
 *   'other'            -> storable and filed, NEVER postable against any
 *                         voucher at all (a quotation, a delivery note, a
 *                         covering letter — and what a model returns when it
 *                         cannot tell what the paper is)
 *
 * See the 0865 migration header, section 1, for why the set is exactly these
 * three and why it is deliberately NOT vouchers.voucher_type.
 */
export type CaptureDocumentType = "sales_challan" | "purchase_invoice" | "other";

/** Structured extraction for one uploaded/forwarded Indian business document. */
export type CaptureExtraction = {
  /** False only when GOOGLE_API_KEY is not set on this server. */
  configured: boolean;
  /**
   * The model's GUESS at what the document is (0865). Advisory only, and
   * optional throughout: it is absent from every extraction stored before
   * 0865, and absent from every failure path here. The AUTHORITATIVE value is
   * capture_drafts.document_type, which a human confirms and the database
   * enforces — this field exists to preselect that choice, never to decide it.
   */
  document_type?: CaptureDocumentType | null;
  /**
   * The OTHER party named on the document. Still called vendor_name, and
   * deliberately not renamed when 0865 made capture universal: renaming it
   * would break every stored extracted_json and both sibling screens for a
   * cosmetic gain. Read it as "the counterparty" — the supplier on a purchase
   * invoice, the customer on a sales challan.
   */
  vendor_name: string | null;
  /** The counterparty's GSTIN — see vendor_name on whose it is. */
  vendor_gstin: string | null;
  /** Best-effort ISO 8601 (yyyy-mm-dd), or null if illegible/undeterminable. */
  bill_date: string | null;
  /**
   * The challan's own printed number, where the document IS a challan (0865).
   * Flows to vouchers.challan_number via create_invoice's p_challan_number.
   * Distinct from the counterparty's document reference, which is
   * vouchers.reference_number — an invoice can carry both.
   */
  challan_number?: string | null;
  /**
   * The challan's own printed date, ISO 8601 (yyyy-mm-dd), where readable.
   * Deliberately independent of challan_number: a dated challan whose number
   * is illegible is a real reading, and the database accepts it.
   */
  challan_date?: string | null;
  line_items: CaptureLineItem[];
  taxable_value: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  total_amount: number | null;
  confidence: "high" | "medium" | "low";
  /** Always present — what the model saw, or why nothing could be extracted. */
  note: string;
};

export type CaptureLineItem = {
  description: string;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
  /**
   * HSN/SAC printed against this line (0865). HSN lives on the ITEM MASTER
   * (public.items.hsn_sac) — voucher_items only ever holds a copy taken at
   * posting time — so this is here to prefill QuickAddItemModal when the
   * preparer creates the item the line refers to, NOT to be written onto the
   * voucher line directly. Optional: absent from every extraction stored
   * before 0865.
   */
  hsn_sac?: string | null;
};

/**
 * Who captured this document, so the model can work out which SIDE of the
 * paper they are on. Entirely optional and every field nullable: the
 * WhatsApp inbound path (0745) calls the analyzer with no context at all,
 * and must keep working, so the prompt has a no-context branch that
 * classifies from the document's own title alone.
 *
 * Why it matters: an Indian tax invoice the company issued and one it
 * received look nearly identical — the difference is whose GSTIN sits in the
 * "Bill to" block. Handing the model the capturing company's own name and
 * GSTINs turns "guess the perspective" into "read a name off the page", and
 * it is also how the model knows NOT to report the capturing company itself
 * as the counterparty.
 */
export type CaptureContext = {
  companyName?: string | null;
  /** Every ACTIVE own-GSTIN — public.gst_registrations is one row per state. */
  companyGstins?: readonly string[] | null;
};

/**
 * Company-supplied strings go into a prompt, so they are trimmed to one line
 * and a sane length first. Not a security boundary — the identity is the
 * user's own, and it only ever skews the user's own extraction — but a
 * company name carrying newlines would visibly derange the prompt's layout,
 * and there is no reason to let it.
 */
function promptSafe(v: string | null | undefined, maxLength: number): string | null {
  if (typeof v !== "string") return null;
  const flat = v.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, maxLength) : null;
}

/**
 * The "which side are we on" preamble. Present only when the caller knows;
 * see CaptureContext for why the absent case is a supported branch and not a
 * bug.
 */
function identityBlock(context?: CaptureContext): string {
  const name = promptSafe(context?.companyName, 120);
  const gstins = (context?.companyGstins ?? [])
    .map((g) => promptSafe(g, 15))
    .filter((g): g is string => !!g)
    .slice(0, 8);

  if (!name && gstins.length === 0) {
    return `WHOSE DESK THIS CAME FROM: not known on this request. Classify the
document from its own title and layout alone. You cannot tell which side of a
delivery challan the capturing company is on, so if the document is a
delivery challan return "sales_challan" (a company files the challans it
issued far more often than ones it received), say in the note that you could
not verify which side they are on, and use confidence no higher than
"medium" for that classification.`;
  }

  const lines = [
    "WHOSE DESK THIS CAME FROM — the company that captured this document is:",
    name ? `  name: ${name}` : null,
    gstins.length ? `  own GSTIN(s): ${gstins.join(", ")}` : null,
    `Use this to work out which side of the paper they are on. If that name or
one of those GSTINs is the SUPPLIER / CONSIGNER / "from" party, the document
went OUT from them. If it appears in the "Bill to" / "Billed to" / "Buyer" /
"Consignee" block, the document came IN to them. This party is NEVER the
answer to vendor_name or vendor_gstin.`,
  ].filter((l): l is string => l !== null);

  return lines.join("\n");
}

/**
 * The instruction half of the prompt. Rewritten for 0865: 0740's version
 * opened "You are extracting structured data from ... an Indian purchase bill
 * / tax invoice", which is exactly the assumption this feature no longer
 * makes. Step 1 now classifies, and the extraction rules below it are written
 * so that a delivery challan — a document that legitimately carries no tax at
 * all — reads as complete rather than as a failed bill.
 */
const INSTRUCTIONS = `You are reading a photograph or scan of ONE Indian business document that a
company's accounts preparer has just captured. First decide WHAT THE DOCUMENT
IS, then extract only the fields actually printed on it.

STEP 1 — CLASSIFY IT (document_type). Choose exactly one:

- "purchase_invoice" — a tax invoice, bill of supply, cash memo or debit note
  ISSUED BY ANOTHER BUSINESS TO the capturing company: a bill they have to
  pay and book as a purchase. Usual signs: titled Tax Invoice / Invoice /
  Bill / Cash Memo; a supplier's name and GSTIN at the top; the capturing
  company in the "Bill to" / "Buyer" block; GST charged.

- "sales_challan" — the capturing company's OWN OUTGOING DELIVERY CHALLAN:
  the paper the goods physically travelled out on, before the tax invoice was
  raised. Usual signs: titled Delivery Challan / Challan / Challan cum
  Delivery Note; a CONSIGNER and a CONSIGNEE rather than a seller and a
  buyer; copies marked ORIGINAL FOR CONSIGNEE / DUPLICATE FOR TRANSPORTER /
  TRIPLICATE FOR CONSIGNER (rule 55(2), CGST Rules); a vehicle or transporter
  number; and very often NO TAX AT ALL. Choose it only when the capturing
  company is the CONSIGNER — the side sending the goods out.

- "other" — everything else, and the right answer whenever you are unsure. A
  quotation, proforma invoice or estimate; a purchase order; a receipt or
  payment advice; a bank statement, letter or e-way bill printout; a
  handwritten slip; a photograph that is not a document at all. Also choose
  "other" for a delivery challan on which the capturing company is the
  CONSIGNEE — goods arriving on somebody else's challan are NOT a purchase
  bill, because no tax invoice has been issued for them yet. An "other"
  document is filed for a human to read and posts nothing to the accounts, so
  it is a safe answer; a confidently wrong one is not.

STEP 2 — EXTRACT.

- If a field is illegible, absent, or you are not confident, return null for
  it rather than a plausible-looking guess.
- vendor_name and vendor_gstin are always THE OTHER PARTY, never the
  capturing company. On a purchase_invoice that is the SUPPLIER who issued
  the bill; on a sales_challan it is the CONSIGNEE the goods went to. Read
  the field names as "counterparty".
- A GSTIN is exactly 15 characters: 2-digit state code, 10-character PAN,
  entity code, the letter Z, checksum. Never fabricate one.
- Every date must be ISO 8601 (yyyy-mm-dd). Indian documents are written
  dd/mm/yyyy or dd-mm-yyyy — convert them; never read them as mm/dd/yyyy.
- bill_date is the date printed on THIS document: the invoice date, or on a
  challan the challan's own date.
- challan_number and challan_date: the DELIVERY CHALLAN's own number and date
  when this document is a challan, AND ALSO when this document is an invoice
  that prints a challan reference ("Challan No.", "D.C. No.", "Delivery
  Challan No. & Date"). Never put this document's own invoice number here,
  and return null when no challan number is printed anywhere.
- line_items: every distinct goods or service line you can read, description
  exactly as printed, with quantity, rate and amount as plain numbers — no
  currency symbol, no thousands separator, no unit suffix. Use null for any
  of the three you cannot read, but still include the line if its description
  is legible. Never include subtotal, tax, discount, round-off or grand-total
  rows as line items.
- hsn_sac on each line: the HSN code (goods) or SAC code (services) printed
  against that line. DIGITS ONLY — HSN is 4, 6 or 8 digits and SAC is 6
  digits beginning 99; strip any dots or spaces, so "5208.11.10" becomes
  "52081110". Rule 46(g) requires this code on a tax invoice and rule
  55(1)(iv) requires it on a delivery challan, so it is usually printed. If
  the document prints only a summary HSN table at the foot instead of a
  per-line column, take a code from it for a line ONLY when it is unambiguous
  which line it belongs to. Never derive a code from the description: null is
  correct, and a wrong HSN is worse than none because it is copied onto the
  item master.
- taxable_value is the pre-tax value of the goods or services; cgst, sgst and
  igst are the tax AMOUNTS printed, never the rates; total_amount is the
  final payable / grand total.

TAX ON A DELIVERY CHALLAN — read this before judging a challan harshly. Rule
55(1) of the CGST Rules requires a delivery challan to carry the HSN code,
description, quantity and taxable value, but requires the tax rate and tax
amount ONLY "where the transportation is for supply to the consignee". Most
genuine challans therefore print NO tax whatever, and many print no grand
total either. That is a complete and correct challan, not a bad photograph.
Return null for cgst, sgst, igst and total_amount when they are simply not
printed — and do NOT let their absence reduce your confidence.

confidence:
- "high" — clear image, you are sure what the document is, and you read every
  field the document actually prints.
- "medium" — legible, but some printed fields are uncertain or unreadable, or
  you are torn between two document types.
- "low" — blurry, cropped, mostly unreadable, or you cannot tell what it is.
Judge confidence ONLY on what you failed to read of what IS printed. A field
the document legitimately does not carry — tax on a challan, a GSTIN for an
unregistered party, a rate column the paper simply does not have — is not a
failure and must not lower it.

note: one or two plain sentences, beginning with what kind of document you
decided this is and why, then anything you could not read and why (blur,
glare, cut off, handwritten). Never leave it empty.

Return JSON matching the given schema only.`;

/**
 * The full prompt for one request. Exported so its two branches can be
 * asserted in unit tests without a network call — in particular that the
 * capturing company's own GSTIN is actually in the text when the caller
 * supplied it, which is the whole mechanism by which "is this ours or
 * theirs?" gets answered.
 */
export function buildCapturePrompt(context?: CaptureContext): string {
  return `${identityBlock(context)}\n\n${INSTRUCTIONS}`;
}

/**
 * document_type is FIRST in this schema on purpose. Gemini emits the object's
 * properties in schema order, so classifying before extracting means every
 * later field is generated already conditioned on the decision — the tax
 * fields of a document the model has just called a challan, for instance.
 * Reversing the order would make the classification a post-hoc label on an
 * extraction already performed as if it were a bill.
 *
 * It is REQUIRED and non-nullable, with "other" as the escape hatch, rather
 * than nullable: a nullable enum invites the model to decline, and "cannot
 * tell" already has a value that means exactly that. parseExtractionResponse
 * still coerces anything outside the three to null — the model is asked for a
 * clean answer, never trusted for one.
 */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    document_type: {
      type: "STRING",
      enum: ["sales_challan", "purchase_invoice", "other"],
    },
    vendor_name: { type: "STRING", nullable: true },
    vendor_gstin: { type: "STRING", nullable: true },
    bill_date: { type: "STRING", nullable: true },
    challan_number: { type: "STRING", nullable: true },
    challan_date: { type: "STRING", nullable: true },
    line_items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          description: { type: "STRING" },
          hsn_sac: { type: "STRING", nullable: true },
          quantity: { type: "NUMBER", nullable: true },
          rate: { type: "NUMBER", nullable: true },
          amount: { type: "NUMBER", nullable: true },
        },
        required: ["description"],
      },
    },
    taxable_value: { type: "NUMBER", nullable: true },
    cgst: { type: "NUMBER", nullable: true },
    sgst: { type: "NUMBER", nullable: true },
    igst: { type: "NUMBER", nullable: true },
    total_amount: { type: "NUMBER", nullable: true },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    note: { type: "STRING" },
  },
  required: ["document_type", "line_items", "confidence", "note"],
} as const;

/** What every "nothing usable happened" path returns — never thrown. */
function fallback(note: string): CaptureExtraction {
  return {
    configured: true,
    // 0865. Spelled out as null rather than omitted so that every
    // CaptureExtraction this module hands back — success or failure — has the
    // same set of keys, and a consumer never has to distinguish "the model
    // could not tell" from "this build predates the field".
    document_type: null,
    challan_number: null,
    challan_date: null,
    vendor_name: null,
    vendor_gstin: null,
    bill_date: null,
    line_items: [],
    taxable_value: null,
    cgst: null,
    sgst: null,
    igst: null,
    total_amount: null,
    confidence: "low",
    note,
  };
}

function notConfigured(): CaptureExtraction {
  return {
    ...fallback(
      "Vision capture isn't configured on this server yet (missing GOOGLE_API_KEY). Fill in the bill details manually below."
    ),
    configured: false,
  };
}

// Same retry shape as app/api/support-chat/route.ts, for the same reason:
// Gemini's free tier occasionally 429s/503s and clears a moment later.
const RETRYABLE_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [400, 1000];

async function fetchGeminiWithRetry(urls: readonly string[], body: string): Promise<Response> {
  let lastRetryable: Response | null = null;
  let lastError: unknown = null;

  // Each model gets the full backoff before we move on, so an ordinary blip
  // is still ridden out on the preferred model rather than silently demoting
  // every request to the weaker one.
  for (const url of urls) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        // A non-retryable status is this model's real answer — return it
        // rather than asking another model the same question.
        if (res.ok || !RETRYABLE_STATUSES.has(res.status)) return res;
        lastRetryable = res;
        if (isLastAttempt) break;
      } catch (err) {
        lastError = err;
        if (isLastAttempt) break;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }

  // Every model exhausted. Hand back the last real response if there was one,
  // so the caller logs Google's own status and message rather than a generic
  // failure it would have to guess at.
  if (lastRetryable) return lastRetryable;
  throw lastError ?? new Error("fetchGeminiWithRetry: exhausted attempts without returning");
}

// isFiniteNumberOrNull was 0740's line-item gate and is gone with it — see
// isPlainLineItem below for why a non-numeric quantity no longer discards the
// whole line. toNumberOrNull does the same job where it is still wanted:
// coercing rather than rejecting.
function toNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// 0865 helpers. Kept beside the existing ones and used only by the fields
// 0865 adds, so the pre-existing parsing lines are untouched.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toTrimmedStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * ISO 8601 shape AND a real day on the calendar. The shape check alone lets
 * "2026-02-31" through, and both dates this validates land in `date` columns
 * (vouchers.voucher_date via the review form, vouchers.challan_date via
 * create_invoice's p_challan_date) — so an impossible date would survive all
 * the way to a posting-time constraint error, thrown at a preparer who has no
 * idea a model misread a smudged "21" as "31". Rejecting it here turns that
 * into an empty field they simply fill in, which is what every other
 * unreadable field already does.
 */
function toIsoDateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = ISO_DATE.exec(v);
  if (!m) return null;
  const [, y, mo, d] = m;
  const parsed = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip: JS rolls 2026-02-31 forward to 2026-03-03 rather than
  // failing, so the only reliable test is whether it comes back unchanged.
  return parsed.toISOString().slice(0, 10) === v ? v : null;
}

/**
 * An HSN/SAC code, normalised to what public.items.hsn_sac will actually
 * accept: its CHECK is `hsn_sac ~ '^[0-9]{4,8}$'` — digits only, four to
 * eight of them. This value exists to prefill QuickAddItemModal, so a code
 * the items table would refuse is worse than no code: the preparer would hit
 * a constraint error while creating a master from a field they did not type.
 *
 * Separators are stripped because "5208.11.10" and "5208 11 10" are how the
 * code is printed on real invoices even though the prompt asks for digits
 * only. Only whitespace, dots and hyphens are stripped — deliberately NOT
 * every non-digit: stripping letters too would turn "Chapter 52 heading 5208"
 * into the plausible-looking and wrong "525208". Anything still not 4-8
 * digits after that becomes null.
 */
function toHsnSacOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.trim().replace(/[\s.\-]/g, "");
  return /^\d{4,8}$/.test(cleaned) ? cleaned : null;
}

/**
 * Only the three values public.capture_drafts.document_type's CHECK
 * constraint accepts survive. Anything else the model invents — and a model
 * asked an open question will invent — becomes null, which reads as "no
 * guess" rather than as a value the database would later reject.
 */
function toDocumentTypeOrNull(v: unknown): CaptureDocumentType | null {
  return v === "sales_challan" || v === "purchase_invoice" || v === "other" ? v : null;
}

/**
 * A line survives on the strength of its DESCRIPTION ALONE.
 *
 * 0740's version also required quantity, rate and amount each to be a finite
 * number or null, and dropped the whole line otherwise. That was too strict
 * in the one direction that hurts: a legible line whose quantity cell came
 * back as anything other than a number — a word, a range, a unit stuck to the
 * figure — disappeared from the extraction entirely. The preparer then
 * reviews a bill that is silently one line short, which is much harder to
 * notice than a line with an empty quantity box sitting in front of them.
 * toNumberOrNull already turns every unusable numeric into null, so the three
 * numbers no longer gate the line; the prompt's own rule ("still include the
 * line if its description is legible") and the parser now agree.
 *
 * A line with no legible description is still dropped: there would be nothing
 * to show, nothing to match against the item master, and nothing to type.
 */
function isPlainLineItem(v: unknown): v is Record<string, unknown> & { description: string } {
  if (!v || typeof v !== "object") return false;
  const { description } = v as Record<string, unknown>;
  return typeof description === "string" && description.trim().length > 0;
}

/**
 * Parses and validates Gemini's own JSON text into a CaptureExtraction.
 * Pure and synchronous — no network — so it is unit-testable without mocking
 * fetch. Never throws: an unparseable or wrongly-shaped response degrades to
 * a "low confidence, could not extract" result rather than propagating.
 */
export function parseExtractionResponse(rawJsonText: string): CaptureExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch {
    return fallback(
      "The vision model's response could not be read as JSON. Fill in the bill details manually below."
    );
  }

  if (!parsed || typeof parsed !== "object") {
    return fallback("The vision model returned an unexpected response. Fill in the bill details manually below.");
  }

  const p = parsed as Record<string, unknown>;
  const lineItemsRaw = Array.isArray(p.line_items) ? p.line_items : [];
  const lineItems = lineItemsRaw.filter(isPlainLineItem).map((li) => ({
    description: li.description.trim(),
    quantity: toNumberOrNull(li.quantity),
    rate: toNumberOrNull(li.rate),
    amount: toNumberOrNull(li.amount),
    // 0865. The schema now asks for this, but it stays defensively read and
    // normalised rather than trusted: it is the one extracted value that goes
    // on to be written to a MASTER record (items.hsn_sac) rather than to a
    // single voucher, so a wrong one is copied onto every future line for
    // that item. See toHsnSacOrNull.
    hsn_sac: toHsnSacOrNull(li.hsn_sac),
  }));

  const confidence = p.confidence === "high" || p.confidence === "medium" || p.confidence === "low"
    ? p.confidence
    : "low";

  return {
    configured: true,
    // 0865. Still read defensively even though the schema now requires it:
    // an extraction stored before 0865, or one from a model that ignored the
    // enum, must degrade to "no guess" rather than to a value the
    // capture_drafts CHECK constraint would refuse.
    document_type: toDocumentTypeOrNull(p.document_type),
    challan_number: toTrimmedStringOrNull(p.challan_number),
    challan_date: toIsoDateOrNull(p.challan_date),
    vendor_name: typeof p.vendor_name === "string" && p.vendor_name.trim() ? p.vendor_name.trim() : null,
    vendor_gstin: typeof p.vendor_gstin === "string" && p.vendor_gstin.trim() ? p.vendor_gstin.trim().toUpperCase() : null,
    // Shares toIsoDateOrNull with challan_date as of 0865, which tightened it
    // from a shape test to a real-calendar test; 0740's own inline regex
    // accepted "2026-02-31".
    bill_date: toIsoDateOrNull(p.bill_date),
    line_items: lineItems,
    taxable_value: toNumberOrNull(p.taxable_value),
    cgst: toNumberOrNull(p.cgst),
    sgst: toNumberOrNull(p.sgst),
    igst: toNumberOrNull(p.igst),
    total_amount: toNumberOrNull(p.total_amount),
    confidence,
    note: typeof p.note === "string" && p.note.trim() ? p.note.trim() : "The model returned no notes.",
  };
}

/**
 * Analyzes one uploaded/forwarded document image or PDF — a supplier's bill,
 * an outgoing delivery challan, or something else the model is asked to
 * identify for itself (0865). Never throws: every failure mode (no API key,
 * network error, non-OK response, unparseable output) returns a
 * CaptureExtraction with confidence "low" and a `note` explaining what
 * happened, so the caller always has something to persist and show for
 * review.
 *
 * `context` is optional and additive — the WhatsApp inbound route (0745)
 * calls this with two arguments and keeps working unchanged; it only makes
 * the classification better where the caller knows whose company this is.
 */
export async function analyzeCaptureImage(
  fileBuffer: Buffer,
  mimeType: string,
  context?: CaptureContext
): Promise<CaptureExtraction> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return notConfigured();
  }

  const base64 = fileBuffer.toString("base64");

  let upstream: Response;
  try {
    upstream = await fetchGeminiWithRetry(
      MODELS.map(
        (m) =>
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`
      ),
      JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: buildCapturePrompt(context) },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      })
    );
  } catch (err) {
    console.error("[capture/analyze] failed to reach Gemini", err);
    return fallback(
      "Could not reach the vision service right now. Fill in the bill details manually below."
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    console.error("[capture/analyze] Gemini error", upstream.status, errText.slice(0, 500));
    return fallback(
      "The vision service could not process this file right now. Fill in the bill details manually below."
    );
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return fallback(
      "The vision service's response could not be read. Fill in the bill details manually below."
    );
  }

  const text = (
    body as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    }
  )?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== "string" || !text.trim()) {
    return fallback(
      "The vision service returned no readable content — the image may be unclear or not a bill. Fill in the bill details manually below."
    );
  }

  return parseExtractionResponse(text);
}
