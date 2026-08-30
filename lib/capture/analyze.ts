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

  /* ---------------------------------------------------------------------- */
  /* The rest of the party master, added by 0995's task                      */
  /* ---------------------------------------------------------------------- */
  /*
   * 0740 read exactly two things about the counterparty — vendor_name and
   * vendor_gstin — and discarded the rest of the page. A real Indian invoice
   * prints a whole party master: postal address with PIN, telephone, email,
   * PAN, UDYAM registration, and the supplier's bank block. public.ledgers
   * has had a column for nearly all of it since 0006 (0995 added only the
   * three bank ones), so what follows is not new storage, it is the reading
   * that was missing.
   *
   * EVERY FIELD HERE IS OPTIONAL AND NULLABLE, and that is a compatibility
   * contract, not carelessness: extracted_json rows stored before this change
   * carry none of these keys, and both the review screen and the WhatsApp
   * confirm screen must keep rendering them unchanged.
   *
   * The vendor_ prefix is kept for the same reason vendor_name itself was
   * never renamed (see its own comment): read the prefix as "counterparty".
   * A nested `party: {...}` block was considered and rejected — it would have
   * left vendor_name and vendor_gstin outside it or duplicated inside it, and
   * a shape where the same fact can live in two places is exactly what a
   * stored-JSON contract must not have.
   *
   * Each field is normalised by parseExtractionResponse to what its
   * public.ledgers column will actually accept, so anything surviving here is
   * insertable. See normalizeParty for the 0735 reconciliation, which is the
   * part that is not merely a regex.
   */
  /** PAN. Reconciled against vendor_gstin — see normalizeParty. */
  vendor_pan?: string | null;
  /** Street address as printed, newlines collapsed. Maps to ledgers.address. */
  vendor_address?: string | null;
  /** Town/city only, never the state. Maps to ledgers.city. */
  vendor_city?: string | null;
  /** Six digits, first non-zero — ledgers_pincode_check's own rule. */
  vendor_pincode?: string | null;
  /** Two-digit GST state code. Derived from the GSTIN whenever there is one. */
  vendor_state_code?: string | null;
  /** Telephone(s) as printed; an invoice routinely prints two. */
  vendor_phone?: string | null;
  /** Must satisfy ledgers_email_check or it is dropped. */
  vendor_email?: string | null;
  /**
   * UDYAM registration number, UDYAM-XX-00-0000000 (app_private.is_valid_udyam).
   * Proof of MSMED registration and NOT of the micro/small/medium tier — the
   * number has no class field. Nothing in this module infers a tier or a
   * payment period from it; see the 0995 header, section 3.
   */
  vendor_udyam_number?: string | null;
  /** Bank and branch as printed. 0995: only storable with an account number. */
  vendor_bank_name?: string | null;
  /** 5-34 alphanumerics, separators stripped. */
  vendor_bank_account_number?: string | null;
  /** IFSC, shape-checked against app_private.is_valid_ifsc's own pattern. */
  vendor_bank_ifsc?: string | null;
  /**
   * Plain sentences about the PARTY block that THIS MODULE worked out — never
   * the model's. Populated by normalizeParty when a reading had to be
   * reconciled or dropped: a PAN that disagrees with the PAN inside the
   * GSTIN, a bank block with no account number to anchor it, an unusable
   * UDYAM number. Kept out of `note` on purpose — `note` is the model's own
   * voice and the review screen turns it into the voucher narration, so a
   * machine-generated caveat appended there would end up printed on a
   * voucher. Absent (not empty) when there is nothing to say.
   */
  party_warnings?: string[];

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

  /* ---------------------------------------------------------------------- */
  /* The rest of the ITEM master, added by the item sibling of 0995's task   */
  /* ---------------------------------------------------------------------- */
  /*
   * hsn_sac above was the only item-master field this module read, and it is
   * not the only one an invoice prints. Every line of a rule-46 tax invoice
   * carries a UNIT and a TAX RATE beside the HSN, and public.items has had a
   * column for both since 0006 (uom, gst_rate_percent). So — exactly as with
   * the party block in 0995 — this is not new storage, it is reading that was
   * being thrown away, and it exists for the same single purpose: to prefill
   * QuickAddItemModal when the preparer creates the item this line refers to.
   *
   * BOTH ARE OPTIONAL AND NULLABLE, and that is a compatibility contract, not
   * carelessness: every extracted_json row stored before this change carries
   * neither key, and the review screen and the WhatsApp confirm screen must
   * keep rendering those rows unchanged.
   *
   * Neither is ever written to a voucher line. create_invoice takes item ids
   * and reads the rate off the item master itself; a unit or a rate read off a
   * photograph is a suggestion for a MASTER a human is about to create, and
   * nothing more.
   */
  /**
   * The line's unit, normalised to a public.ref_uom CODE — never the string
   * the document printed. items.uom is a FOREIGN KEY to ref_uom(code)
   * (items_uom_fkey, confirmed live), so a unit the reference table does not
   * hold is not a weaker reading, it is an insert that fails. "Mtr" off the
   * paper becomes "MTR"; "Rolls" becomes "ROL"; anything unrecognised becomes
   * null and QuickAddItemModal keeps its own default. See toUomCodeOrNull.
   */
  uom?: string | null;
  /**
   * The WHOLE GST rate for this line as a percentage — 18, never the 9 that a
   * CGST column prints. See toGstRatePercentOrNull for why the notified-rate
   * list is what makes that distinction enforceable rather than hoped for.
   */
  gst_rate_percent?: number | null;
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

- THE REST OF THAT SAME PARTY'S DETAILS. Having named the counterparty in
  vendor_name, read the rest of THAT party's own block — an Indian invoice
  prints a full party master across its letterhead and its foot, and each of
  these fields describes the party you have just named, not a second one.
  Fill vendor_name and vendor_gstin FIRST and then work down. Never return an
  address, a phone number or a bank account for a party while leaving
  vendor_name null: if you can read their letterhead you can read their name,
  and that combination is always a mistake. Each individual field is null
  only when that particular line is not printed or not legible.

  - vendor_address: their street address as printed, on one line, commas
    kept, WITHOUT the town, state, PIN, phone or GSTIN — those have their own
    fields.
  - vendor_city: the town or city only. Not the state, not the district.
  - vendor_pincode: the 6-digit PIN of that address. Digits only.
  - vendor_state_code: the 2-digit GST state code where the document prints
    one ("State: Gujarat, Code: 24"). Null if only the state's NAME is
    printed and no code — do not look the code up from the name.
  - vendor_phone: their telephone number(s) as printed. Many invoices print
    two or three; return them separated by ", " in the order printed.
  - vendor_email: their email address, exactly as printed.
  - vendor_pan: their PAN where it is printed as its own field ("PAN:
    AEMPB3576L"). Do NOT extract the PAN out of the middle of the GSTIN —
    that is done afterwards, and reading it twice only creates a
    disagreement. Null unless PAN is printed separately.
  - vendor_udyam_number: their MSME/Udyam registration number, printed as
    "UDYAM-GJ-22-0090672" and labelled Udyam / UAM / MSME Reg. No. Copy it
    exactly, including the UDYAM- prefix and both hyphens. Do NOT return an
    MSME "category" or a payment period — the number does not carry one and
    neither does the invoice.
  - vendor_bank_name, vendor_bank_account_number, vendor_bank_ifsc: the bank
    block printed for THEM to be paid into ("Bank Details", "Our Bank
    Details", "Payment to be made to"), which on a supplier's invoice is the
    supplier's own account. bank_name is the bank and branch as printed
    ("HDFC Bank Ltd - Kadodara"); the account number is letters and digits
    with spaces and hyphens removed; the IFSC is 11 characters, 4 letters
    then a 0 then 6 more.

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
- unit on each line: the unit of measure printed against that line, EXACTLY as
  printed and with nothing else attached — "Nos", "Mtr", "Kgs", "Pcs", "Box",
  "Rolls", "Sq.Ft". Many invoices print it as its own column headed UOM / Unit
  / Qty Unit; many others print it stuck to the quantity ("120 Mtr", "8 Nos"),
  and then the unit is "Mtr" and the quantity is 120. Return null when the
  document prints no unit at all — never invent one from the description, and
  never return a packing description ("carton of 12") as a unit.
- gst_rate_percent on each line: the GST RATE applying to that line, as a
  percentage number — the RATE column, never a tax amount in rupees. Read it
  as the WHOLE rate on the goods:
    * CGST 9% and SGST 9% printed side by side is an 18% line. Return 18.
      CGST and SGST are two halves of one rate and are never added to each
      other by the reader of an invoice; returning 9 is always wrong.
    * IGST 18% is also an 18% line. Return 18.
    * A single "GST %" or "Tax Rate" column showing 12 is a 12% line.
    * Never add IGST to CGST or SGST — a line carries one or the other.
  The rates actually notified in India are 0, 0.25, 3, 5, 12, 18 and 28.
  Return null if the document prints no rate against the line, or prints only
  tax amounts and no rate at all — do not divide an amount by a value to
  recover one.
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
unregistered party, a rate column the paper simply does not have, a UDYAM
number a supplier that is not MSME-registered has none of, a bank block the
paper does not print — is not a failure and must not lower it.

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
    // The rest of the counterparty's master (0995's task). Placed directly
    // after the two fields they extend, so the model reads the whole party
    // block off the letterhead in one pass rather than returning to it after
    // the line items. All nullable, none required: a document that prints
    // none of them — a handwritten cash memo — is a complete extraction, not
    // a failed one, and RESPONSE_SCHEMA's `required` list is what says so.
    vendor_pan: { type: "STRING", nullable: true },
    vendor_address: { type: "STRING", nullable: true },
    vendor_city: { type: "STRING", nullable: true },
    vendor_pincode: { type: "STRING", nullable: true },
    vendor_state_code: { type: "STRING", nullable: true },
    vendor_phone: { type: "STRING", nullable: true },
    vendor_email: { type: "STRING", nullable: true },
    vendor_udyam_number: { type: "STRING", nullable: true },
    vendor_bank_name: { type: "STRING", nullable: true },
    vendor_bank_account_number: { type: "STRING", nullable: true },
    vendor_bank_ifsc: { type: "STRING", nullable: true },
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
          // `unit` on the wire, `uom` in CaptureLineItem — deliberately two
          // names for two different things. The model is asked for the string
          // the paper printed ("Mtr"), because that is a reading; what is
          // stored is a ref_uom code ("MTR"), because that is what
          // items.uom's foreign key will accept. Asking the model for the
          // code directly would invite it to invent one.
          unit: { type: "STRING", nullable: true },
          quantity: { type: "NUMBER", nullable: true },
          rate: { type: "NUMBER", nullable: true },
          // After `rate`, so the model has already read the money columns and
          // is less likely to hand back a tax AMOUNT here.
          gst_rate_percent: { type: "NUMBER", nullable: true },
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
    // 0995's task, spelled out for exactly the reason document_type above is:
    // every CaptureExtraction this module returns carries the same key set, so
    // no consumer has to tell "nothing was read" apart from "this extraction
    // predates the field". party_warnings is the one exception and is absent
    // rather than empty — it says something happened, and on a total failure
    // nothing did.
    vendor_pan: null,
    vendor_address: null,
    vendor_city: null,
    vendor_pincode: null,
    vendor_state_code: null,
    vendor_phone: null,
    vendor_email: null,
    vendor_udyam_number: null,
    vendor_bank_name: null,
    vendor_bank_account_number: null,
    vendor_bank_ifsc: null,
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

/* -------------------------------------------------------------------------- */
/* The line's unit, and the line's tax rate                                   */
/* -------------------------------------------------------------------------- */

/**
 * public.ref_uom, mirrored — the notified Unit Quantity Codes, which is the
 * only vocabulary items.uom may hold: items_uom_fkey is a FOREIGN KEY to
 * ref_uom(code) (confirmed live, and it is a foreign key rather than a CHECK,
 * so a stray value is a 23503 at insert time, not a friendly validation).
 *
 * COPIED RATHER THAN QUERIED because this module has no database access at
 * all and is not about to grow one — see the file header. The copy is not
 * left to trust: tests/unit/capture-item-master.test.ts reads ref_uom live and
 * fails if this table and that one have drifted, which is the same discipline
 * every mirrored CHECK constraint in normalizeParty is held to.
 *
 * The names are ref_uom's own, and they matter: an invoice prints "Rolls" as
 * often as it prints "ROL", so the name is a second key into the same row.
 */
export const REF_UOM: readonly { readonly code: string; readonly name: string }[] = [
  { code: "BAG", name: "Bags" },
  { code: "BOX", name: "Box" },
  { code: "BTL", name: "Bottles" },
  { code: "CBM", name: "Cubic Metre" },
  { code: "CMS", name: "Centimetre" },
  { code: "DAY", name: "Days" },
  { code: "DOZ", name: "Dozen" },
  { code: "GMS", name: "Grams" },
  { code: "HRS", name: "Hours" },
  { code: "KGS", name: "Kilograms" },
  { code: "KLR", name: "Kilolitre" },
  { code: "KME", name: "Kilometre" },
  { code: "LTR", name: "Litres" },
  { code: "MLT", name: "Millilitre" },
  { code: "MTR", name: "Metres" },
  { code: "NOS", name: "Numbers" },
  { code: "OTH", name: "Others" },
  { code: "PAC", name: "Pack" },
  { code: "PCS", name: "Pieces" },
  { code: "QTL", name: "Quintal" },
  { code: "ROL", name: "Rolls" },
  { code: "SET", name: "Set" },
  { code: "SQF", name: "Square Feet" },
  { code: "SQM", name: "Square Metre" },
  { code: "TON", name: "Tonnes" },
];

/** Lowercased with every separator removed: "Sq. Ft." and "SQFT" both key alike. */
function uomKey(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** One trailing "s" removed, so a printed "Bag" reaches ref_uom's "Bags". */
function singular(v: string): string {
  return v.length > 2 && v.endsWith("s") ? v.slice(0, -1) : v;
}

/**
 * Printed abbreviations that are NEITHER a UQC code NOR a UQC name, even
 * after the plural is taken off. Every entry is a form that appears on real
 * Indian invoices; none of them invents a unit, they all point at a ref_uom
 * row that already exists.
 *
 * Kept deliberately short. The notified codes ARE the common trade
 * abbreviations — NOS, MTR, KGS, PCS, BOX, ROL, SET all match the printed
 * form outright — so this table only has to cover the SI short forms and the
 * two-or-three spellings ("Meter" for "Metre", "MT" for a metric tonne) that
 * a code-and-name comparison genuinely cannot reach.
 */
const PRINTED_UNIT_ALIASES: Readonly<Record<string, string>> = {
  // Countables. "Unit", "Each" and "No." are all the same UQC as "Nos".
  no: "NOS",
  number: "NOS",
  unit: "NOS",
  each: "NOS",
  ea: "NOS",
  pc: "PCS",
  pkt: "PAC",
  packet: "PAC",
  packets: "PAC",
  boxes: "BOX",
  dzn: "DOZ",
  dozens: "DOZ",
  // Length. "M" and "Mtrs" for metres, "CM" and "KM" for their multiples.
  m: "MTR",
  mtrs: "MTR",
  meter: "MTR",
  meters: "MTR",
  cm: "CMS",
  centimeter: "CMS",
  centimeters: "CMS",
  km: "KME",
  kilometer: "KME",
  kilometers: "KME",
  kilometres: "KME",
  // Mass. "MT" on an Indian invoice is a metric tonne, not a metre.
  kg: "KGS",
  kilogram: "KGS",
  gm: "GMS",
  gram: "GMS",
  mt: "TON",
  tonne: "TON",
  quintals: "QTL",
  // Volume and capacity.
  l: "LTR",
  lit: "LTR",
  ltrs: "LTR",
  liter: "LTR",
  liters: "LTR",
  litre: "LTR",
  ml: "MLT",
  milliliter: "MLT",
  milliliters: "MLT",
  millilitres: "MLT",
  kl: "KLR",
  kiloliter: "KLR",
  kilolitre: "KLR",
  cum: "CBM",
  m3: "CBM",
  cubicmeter: "CBM",
  // Area, where the printed form almost never matches the notified name.
  sqft: "SQF",
  sft: "SQF",
  squarefeet: "SQF",
  squarefoot: "SQF",
  sqm: "SQM",
  sqmt: "SQM",
  sqmtr: "SQM",
  sqmtrs: "SQM",
  squaremeter: "SQM",
  m2: "SQM",
  // Time.
  hr: "HRS",
  hour: "HRS",
  // Containers.
  bottle: "BTL",
  roll: "ROL",
  rol: "ROL",
  other: "OTH",
};

/**
 * The unit printed on a line, resolved to a ref_uom CODE, or null.
 *
 * NULL IS A GOOD ANSWER and is why this function does not guess. items.uom is
 * NOT NULL with a default of 'NOS' and carries a foreign key to ref_uom, so
 * there are exactly two outcomes for an unrecognised reading: return null and
 * let QuickAddItemModal keep its own default (which the preparer sees, in a
 * dropdown, before anything is created), or return something ref_uom does not
 * hold and turn a master creation into a foreign-key error on a field nobody
 * typed. The first is a unit to correct; the second is a dead end.
 *
 * Three keys into the same reference table, tried in order — the code, the
 * name, then the name with the plural taken off (ref_uom's names are plural,
 * invoices print the singular) — and only then the alias table above.
 */
export function toUomCodeOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const key = uomKey(v);
  if (!key) return null;

  const byCode = REF_UOM.find((u) => uomKey(u.code) === key);
  if (byCode) return byCode.code;

  const byName = REF_UOM.find((u) => uomKey(u.name) === key);
  if (byName) return byName.code;

  const bySingular = REF_UOM.find((u) => singular(uomKey(u.name)) === singular(key));
  if (bySingular) return bySingular.code;

  return PRINTED_UNIT_ALIASES[key] ?? null;
}

/**
 * Every GST rate actually notified for goods and services in India. The same
 * list QuickAddItemModal's dropdown offers, and that is not a coincidence —
 * this value exists to preselect an option in that dropdown, so a rate the
 * dropdown cannot show is a rate that would silently display as something
 * else.
 */
const NOTIFIED_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;

/**
 * The line's whole GST rate, or null.
 *
 * THE NOTIFIED LIST IS NOT DECORATION — IT IS THE HALF-RATE DETECTOR, and it
 * is the reason this module asks the model for one combined rate rather than
 * for the CGST and SGST columns separately.
 *
 * The one mistake that matters here is returning 9 for an 18% line, because
 * an intra-state invoice prints "CGST 9%" and "SGST 9%" in two adjacent
 * columns and 9 is what is literally written under each. A 9% item master
 * would then charge half the tax on every future invoice — wrong numbers,
 * silently, forever. But no notified rate is half of another notified rate:
 * the halves of 0.25, 3, 5, 12, 18 and 28 are 0.125, 1.5, 2.5, 6, 9 and 14,
 * and not one of those is itself notified. So checking a reading against the
 * list catches EVERY half-rate misreading, and nothing else does — arithmetic
 * on the model's own components would only move the mistake.
 *
 * A rate that is not on the list is therefore dropped rather than rounded to
 * the nearest one: 9 is far more likely to be half of 18 than a real rate,
 * and an empty rate box in the popup is a question the preparer answers in
 * one click. (0 stays: nil-rated and exempt supplies exist, the value is
 * notified, and QuickAddItemModal offers it.)
 */
export function toGstRatePercentOrNull(v: unknown): number | null {
  const n = toNumberOrNull(v);
  if (n === null) return null;
  return NOTIFIED_GST_RATES.some((r) => Math.abs(r - n) < 1e-9) ? n : null;
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

/* -------------------------------------------------------------------------- */
/* The party master (0995's task)                                             */
/* -------------------------------------------------------------------------- */

/*
 * Every pattern below is a copy of a CHECK constraint that public.ledgers
 * already enforces, and each names the constraint it mirrors. That duplication
 * is deliberate and bounded: these values exist to PREFILL a ledger insert, so
 * a value the ledgers table would refuse is worse than no value at all — the
 * preparer would meet a constraint error while creating a master out of a
 * field they never typed. The database stays the authority; this is the door
 * check, not the lock.
 */

/** ledgers_gstin_check's shape half. The check digit is Postgres's business. */
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/** app_private.is_valid_pan, verbatim. */
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** app_private.is_valid_udyam, verbatim. */
const UDYAM_SHAPE = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
/** app_private.is_valid_ifsc, verbatim. */
const IFSC_SHAPE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
/** ledgers_pincode_check, verbatim. */
const PINCODE_SHAPE = /^[1-9][0-9]{5}$/;
/** companies.print_bank_account_number's charset (0800), reused by 0995. */
const ACCOUNT_NUMBER_SHAPE = /^[A-Za-z0-9]{5,34}$/;
/** ledgers_email_check, verbatim. */
const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Newlines and runs of spaces to one space. A letterhead is multi-line. */
function flatten(v: unknown, maxLength: number): string | null {
  if (typeof v !== "string") return null;
  const flat = v.replace(/\s+/g, " ").trim().replace(/[,;]+$/, "").trim();
  return flat ? flat.slice(0, maxLength) : null;
}

/** Uppercase with every space and separator removed — for coded values. */
function code(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.replace(/[\s.]/g, "").toUpperCase();
  return c || null;
}

/**
 * The counterparty's master, normalised to what public.ledgers will accept,
 * and internally reconciled so that the whole block can be inserted as one
 * row without tripping migration 0735.
 *
 * THIS IS THE PART THAT IS NOT A REGEX. 0735 makes three of these fields a
 * composite rather than three independent readings:
 *
 *   ledgers_gstin_matches_state — a non-null gstin FORCES
 *                                 state_code = substr(gstin, 1, 2)
 *   ledgers_gstin_matches_pan   — and, when pan is also present,
 *                                 pan = substr(gstin, 3, 10)
 *
 * A GSTIN therefore GIVES the state and the PAN for free, and it is the
 * stronger reading of all three: it is one fifteen-character token whose
 * final character is a checksum over the other fourteen, so a misread digit
 * anywhere in it usually fails the check digit and is caught, whereas a PAN
 * printed on its own line has no such protection and a misread state code
 * none at all.
 *
 * So where a GSTIN of the right shape was read, the state code and the PAN
 * are DERIVED from it and the model's own separate readings of those two are
 * discarded. That is the reconciliation the task asks for, and the discarded
 * PAN is not silently dropped: a disagreement means one of the two numbers on
 * the paper was misread, which is exactly the thing a human should look at
 * before a master record is created, so it is reported in party_warnings and
 * shown on the review screen.
 *
 * vendor_gstin itself is deliberately NOT gated on GSTIN_SHAPE here. That
 * field shipped in 0740 as "trim and uppercase, whatever was read", the
 * review screen prints it and compares it against the matched ledger's own
 * number, and a human staring at a mis-shaped reading beside the real one is
 * better served than by a blank. A mis-shaped GSTIN simply derives nothing
 * and earns a warning.
 */
export function normalizeParty(p: Record<string, unknown>): {
  fields: Pick<
    CaptureExtraction,
    | "vendor_pan"
    | "vendor_address"
    | "vendor_city"
    | "vendor_pincode"
    | "vendor_state_code"
    | "vendor_phone"
    | "vendor_email"
    | "vendor_udyam_number"
    | "vendor_bank_name"
    | "vendor_bank_account_number"
    | "vendor_bank_ifsc"
  >;
  warnings: string[];
} {
  const warnings: string[] = [];

  const gstinRaw = code(p.vendor_gstin);
  const gstinUsable = gstinRaw !== null && GSTIN_SHAPE.test(gstinRaw);
  if (gstinRaw !== null && !gstinUsable) {
    warnings.push(
      `“${gstinRaw}” was read as the GSTIN but is not the right shape (15 characters: 2-digit state, 10-character PAN, entity code, Z, checksum), so the state and PAN could not be taken from it.`
    );
  }

  // PAN. Derived from the GSTIN when there is a usable one, because the GSTIN
  // contains it and is checksummed; only used as an independent reading when
  // there is not.
  const panRead = code(p.vendor_pan);
  const panFromGstin = gstinUsable ? gstinRaw.slice(2, 12) : null;
  let pan: string | null;
  if (panFromGstin) {
    pan = panFromGstin;
    if (panRead && panRead !== panFromGstin) {
      warnings.push(
        `The PAN printed on the document (${panRead}) does not match the PAN inside its GSTIN (${panFromGstin}). The GSTIN's has been used, because its last character is a checksum over the whole number. Check the paper before creating the party.`
      );
    }
  } else if (panRead && PAN_SHAPE.test(panRead)) {
    pan = panRead;
  } else {
    pan = null;
    if (panRead) {
      warnings.push(
        `“${panRead}” was read as the PAN but is not the right shape (5 letters, 4 digits, 1 letter), so it was not kept.`
      );
    }
  }

  // State code. Definitionally the first two characters of the GSTIN, so it
  // is taken from there without comment when there is one — a disagreement
  // with a separately printed "Code: 24" is not worth a warning, because the
  // derived value cannot be the wrong one if the GSTIN is right.
  const stateRead = code(p.vendor_state_code);
  const stateCode = gstinUsable
    ? gstinRaw.slice(0, 2)
    : stateRead && /^[0-9]{2}$/.test(stateRead)
      ? stateRead
      : null;

  const pincodeRead = code(p.vendor_pincode);
  const pincode = pincodeRead && PINCODE_SHAPE.test(pincodeRead) ? pincodeRead : null;
  if (pincodeRead && !pincode) {
    warnings.push(
      `“${pincodeRead}” was read as the PIN code but is not six digits starting with a non-zero, so it was not kept.`
    );
  }

  const emailRead = flatten(p.vendor_email, 200);
  const email = emailRead && EMAIL_SHAPE.test(emailRead) ? emailRead : null;
  if (emailRead && !email) {
    warnings.push(
      `“${emailRead}” was read as the email address but is not a usable one, so it was not kept.`
    );
  }

  // Phone is the one field with no constraint on its column, so the only job
  // here is to stop a caption ("Mob.", "Ph. No.") being stored as if it were a
  // number. Two or three numbers on one invoice is normal and they are kept
  // together, as printed — splitting them would need a second column.
  const phoneRead = flatten(p.vendor_phone, 80);
  const phoneCleaned = phoneRead
    ? phoneRead
        .replace(/[^0-9+\-/(), ]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s,/-]+|[\s,/-]+$/g, "")
    : null;
  const phone = phoneCleaned && /[0-9]{6,}/.test(phoneCleaned.replace(/[^0-9]/g, "")) ? phoneCleaned : null;

  const udyamRead = code(p.vendor_udyam_number);
  const udyam = udyamRead && UDYAM_SHAPE.test(udyamRead) ? udyamRead : null;
  if (udyamRead && !udyam) {
    warnings.push(
      `“${udyamRead}” was read as a Udyam/MSME registration number but is not in the UDYAM-XX-00-0000000 form the register issues, so it was not kept.`
    );
  }

  // The bank block. 0995 anchors it on the account number: a bank name or an
  // IFSC with no account is not a fact about where to pay anybody, and the
  // ledgers_bank_block_anchored constraint refuses the row outright — so it is
  // dropped here rather than carried to an insert that cannot succeed.
  const accountRead = typeof p.vendor_bank_account_number === "string"
    ? p.vendor_bank_account_number.replace(/[\s-]/g, "")
    : null;
  const account = accountRead && ACCOUNT_NUMBER_SHAPE.test(accountRead) ? accountRead : null;
  if (accountRead && !account) {
    warnings.push(
      `“${accountRead}” was read as the bank account number but is not 5 to 34 letters or digits, so it was not kept.`
    );
  }

  const ifscRead = code(p.vendor_bank_ifsc);
  const ifscValid = ifscRead && IFSC_SHAPE.test(ifscRead) ? ifscRead : null;
  if (ifscRead && !ifscValid) {
    warnings.push(
      `“${ifscRead}” was read as the IFSC but is not 11 characters in the form ABCD0123456, so it was not kept.`
    );
  }

  const bankNameRead = flatten(p.vendor_bank_name, 120);
  const bankNameValid = bankNameRead && bankNameRead.trim().length >= 2 ? bankNameRead : null;

  const bankName = account ? bankNameValid : null;
  const ifsc = account ? ifscValid : null;
  if (!account && (bankNameValid || ifscValid)) {
    warnings.push(
      `A bank was read off the document (${[bankNameValid, ifscValid].filter(Boolean).join(", ")}) but no account number was, so none of it was kept — an account is what the rest of a bank block hangs on.`
    );
  }

  return {
    fields: {
      vendor_pan: pan,
      vendor_address: flatten(p.vendor_address, 300),
      vendor_city: flatten(p.vendor_city, 80),
      vendor_pincode: pincode,
      vendor_state_code: stateCode,
      vendor_phone: phone,
      vendor_email: email,
      vendor_udyam_number: udyam,
      vendor_bank_name: bankName,
      vendor_bank_account_number: account,
      vendor_bank_ifsc: ifsc,
    },
    warnings,
  };
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
    // The item sibling of 0995's task. Read from `unit` on the wire and
    // stored as `uom`, because the two are different things — see the
    // RESPONSE_SCHEMA comment. Both of these, like hsn_sac above, go on to
    // prefill a MASTER record rather than a single voucher line, so both are
    // normalised to what public.items will actually accept and neither is
    // trusted as returned.
    uom: toUomCodeOrNull(li.unit),
    gst_rate_percent: toGstRatePercentOrNull(li.gst_rate_percent),
  }));

  const confidence = p.confidence === "high" || p.confidence === "medium" || p.confidence === "low"
    ? p.confidence
    : "low";

  // 0995's task. Every field of the party master in one call, because they
  // are not independent of each other: see normalizeParty on the 0735
  // composite the GSTIN, the state code and the PAN form.
  const party = normalizeParty(p);

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
    ...party.fields,
    // Absent, not empty, when nothing needed saying — see the field's comment.
    ...(party.warnings.length ? { party_warnings: party.warnings } : {}),
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
