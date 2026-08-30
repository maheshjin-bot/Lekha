import type { CaptureDocumentType, CaptureExtraction } from "@/lib/capture/analyze";
import { PURCHASE_TRADING_ROLES, SALE_TRADING_ROLES } from "@/lib/invoices/trading-roles";

/**
 * The pure, React-free half of the capture REVIEW INBOX.
 *
 * Deliberately a plain module, NOT an export from one of the "use client"
 * components beside it: lib/invoices/trading-roles.ts records at length why
 * ("every value exported from a client module becomes a client REFERENCE when
 * a server component imports it — a proxy object, not the array"). The page
 * that renders this inbox is a server component and reads these values to
 * validate its own searchParams, so this file must stay outside the client
 * boundary.
 *
 * It is also the only part of the screen that CAN be unit-tested: this
 * project's vitest environment is "node" with no jsdom and no testing
 * library, so anything worth a regression test has to live here rather than
 * inside a component.
 *
 * DELIBERATELY NOT HERE: anything that touches Supabase, Storage or fetch,
 * and anything to do with the review form's own arithmetic — the form owns
 * its line maths, in the one file that also renders it, so the preview and
 * the markup cannot drift apart.
 */

/* -------------------------------------------------------------------------- */
/* Document types — the one place the whole feature decides what a draft posts */
/* -------------------------------------------------------------------------- */

/**
 * Everything that differs between the three capture_drafts.document_type
 * values (0865), in one place, so no part of the screen can disagree with
 * another about what a sales challan is.
 *
 * `voucherType` mirrors app_private.enforce_capture_draft's own CASE
 * value-for-value, and must keep mirroring it: the trigger refuses a
 * confirmation whose voucher type does not match the draft's document type,
 * so a disagreement here is not cosmetic — it is a post that succeeds and
 * then cannot be recorded against the draft it came from. null is the whole
 * definition of 'other': there is no voucher it may be confirmed against, so
 * there is no post button.
 */
export type DocConfig = {
  value: CaptureDocumentType;
  label: string;
  /** Two words at most — the queue row's own badge, where space is scarce. */
  shortLabel: string;
  blurb: string;
  voucherType: "sales" | "purchase" | null;
  partyLabel: string;
  /** Which ledger roles may be the PARTY. Mirrors InvoiceForm's TYPES table. */
  partyRoles: readonly string[];
  /** The single role a quick-added party is created under. */
  quickAddRole: string;
  quickAddDescription: string;
  tradingLabel: string;
  tradingRoles: readonly string[];
  tradingDescription: string;
  /** vouchers.reference_number is the COUNTERPARTY's document — 0865 s.4. */
  referenceLabel: string;
  challanLabel: string;
  challanHelp: string;
  postLabel: string;
};

export const DOC_TYPES: readonly DocConfig[] = [
  {
    value: "sales_challan",
    label: "Sales challan",
    shortLabel: "Challan",
    blurb:
      "Goods that went out on our own delivery challan. Posts a SALES invoice — Rule 55(4): the goods move on the challan, the tax invoice follows.",
    voucherType: "sales",
    partyLabel: "Customer",
    partyRoles: ["debtor", "cash_bank"],
    quickAddRole: "debtor",
    quickAddDescription:
      "Created under a receivables group, so it appears in the customer list straight away.",
    tradingLabel: "Sales ledger",
    tradingRoles: SALE_TRADING_ROLES,
    tradingDescription: "An income ledger — what the sale is credited to.",
    referenceLabel: "Their PO no.",
    challanLabel: "Our challan no.",
    challanHelp: "The delivery challan these goods went out on.",
    postLabel: "Post as sales invoice",
  },
  {
    value: "purchase_invoice",
    label: "Purchase invoice",
    shortLabel: "Purchase",
    blurb:
      "A supplier's bill. Posts a PURCHASE bill — capture's original and, until 0865, only behaviour.",
    voucherType: "purchase",
    partyLabel: "Supplier",
    partyRoles: ["creditor", "cash_bank"],
    quickAddRole: "creditor",
    quickAddDescription:
      "Created under a payables group, so it appears in the supplier list straight away.",
    tradingLabel: "Purchase/expense ledger",
    tradingRoles: PURCHASE_TRADING_ROLES,
    tradingDescription: "An expense ledger — what the purchase is debited to.",
    referenceLabel: "Their bill no.",
    challanLabel: "Their challan no.",
    challanHelp: "The challan these goods arrived on.",
    postLabel: "Post as purchase bill",
  },
  {
    value: "other",
    label: "Something else",
    shortLabel: "Other",
    blurb:
      "A quotation, a covering letter, a bank advice — captured and kept, but it posts nothing to the books.",
    voucherType: null,
    partyLabel: "Party",
    partyRoles: ["debtor", "creditor", "cash_bank"],
    quickAddRole: "creditor",
    quickAddDescription: "",
    tradingLabel: "Ledger",
    tradingRoles: PURCHASE_TRADING_ROLES,
    tradingDescription: "",
    referenceLabel: "Their document no.",
    challanLabel: "Challan no.",
    challanHelp: "",
    postLabel: "",
  },
];

/** Falls back to the purchase invoice — 0740's original and commonest case. */
export function docConfig(t: CaptureDocumentType | null | undefined): DocConfig {
  return DOC_TYPES.find((d) => d.value === t) ?? DOC_TYPES[1];
}

export function isDocumentType(v: unknown): v is CaptureDocumentType {
  return v === "sales_challan" || v === "purchase_invoice" || v === "other";
}

export type DraftStatus = "pending_review" | "confirmed" | "rejected";

export const DRAFT_STATUSES: readonly DraftStatus[] = [
  "pending_review",
  "confirmed",
  "rejected",
];

export function isDraftStatus(v: unknown): v is DraftStatus {
  return v === "pending_review" || v === "confirmed" || v === "rejected";
}

/**
 * Plain words for a status the reviewer is looking at, not the column's own
 * value: "rejected" reads like a verdict on the sender, and the whole point of
 * the reason field is that it is a request for a better photograph.
 */
export const STATUS_LABELS: Record<DraftStatus, string> = {
  pending_review: "Waiting for review",
  confirmed: "Posted",
  rejected: "Sent back",
};

/* -------------------------------------------------------------------------- */
/* Master shapes the review form is handed                                    */
/* -------------------------------------------------------------------------- */

/**
 * The item and ledger columns the review form actually reads. Declared here,
 * in the plain module, rather than inside the "use client" form: the page is a
 * server component and maps its own query results into these, and a type
 * imported across that boundary must not drag a client module with it.
 *
 * hsn_sac and gstin are not decoration. HSN lives on the ITEM MASTER
 * (voucher_items only ever holds a copy taken at posting time), so the form
 * needs the master value to know whether the HSN printed on the paper is new.
 * gstin is the strongest available evidence that the party matched by NAME is
 * the right party — which is exactly the match a reviewer most needs a second
 * opinion on.
 */
export type Item = {
  id: string;
  name: string;
  uom: string;
  hsn_sac: string | null;
  sale_rate: number | null;
  purchase_rate: number | null;
  gst_rate_percent: number;
  default_tcs_section: string | null;
};

export type Ledger = {
  id: string;
  name: string;
  ledger_role: string;
  state_code: string | null;
  pan: string | null;
  gstin: string | null;
};

/* -------------------------------------------------------------------------- */
/* The queue row                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One row of the review queue, as this screen wants it — camelCase, every
 * optional thing already resolved to a definite value.
 *
 * Built by normalizeQueueRow below from what public.get_capture_review_queue
 * (0870) returns. That RPC is owned by another author and was still being
 * written when this screen was built, so each field is read through a small
 * list of plausible column names rather than one hardcoded guess. That is not
 * defensiveness for its own sake: a naming difference then shows up as a
 * missing capturer name rather than as a screen that throws, and it is the one
 * thing here genuinely worth a regression test.
 */
export type QueueRow = {
  id: string;
  documentType: CaptureDocumentType;
  status: DraftStatus;
  source: string;
  /** Page 1's path — the RPC already coalesces the pre-0870 single file in. */
  storagePath: string | null;
  branchId: string | null;
  branchLabel: string | null;
  /** Present only if the RPC returns the extraction itself; 0870 returns a flag. */
  extraction: CaptureExtraction | null;
  /** The RPC's own has_extraction — whether extracted_json is already stored. */
  hasExtraction: boolean;
  extractedAt: string | null;
  /** submitted_at if the phone stamped one, else created_at. */
  arrivedAt: string;
  pageCount: number;
  capturedById: string | null;
  /** Display name, falling back to the email, falling back to null. */
  capturedByLabel: string | null;
  /** True when another draft in this company shares page 1's sha256. */
  isDuplicate: boolean;
  /** What the person holding the phone typed about who this is from. */
  vendorHint: string | null;
  /** What they typed about the document itself. */
  note: string | null;
  rejectedReason: string | null;
  confirmedVoucherId: string | null;
};

type Raw = Record<string, unknown>;

function pickString(raw: Raw, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickNumber(raw: Raw, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    // PostgREST hands a bigint back as a string often enough to matter.
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function pickBoolean(raw: Raw, keys: readonly string[]): boolean | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "boolean") return v;
  }
  return null;
}

/**
 * The vision model's own output, if this row carries it at all.
 *
 * A stored extraction always has line_items, so an empty object — which is
 * what a not-yet-extracted draft could plausibly hold — reads as "no
 * extraction" rather than as "an extraction that found nothing". The
 * difference matters: the first means run the model, the second means the
 * paper was unreadable and the reviewer types it in.
 */
export function asExtraction(raw: unknown): CaptureExtraction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Array.isArray((raw as Raw).line_items)) return null;
  return raw as CaptureExtraction;
}

/**
 * One RPC row -> one QueueRow, or null if it has no usable id (a row this
 * screen could neither select nor act on is worse than a row it drops).
 */
export function normalizeQueueRow(raw: Raw): QueueRow | null {
  const id = pickString(raw, ["id", "draft_id", "capture_draft_id"]);
  if (!id) return null;

  const documentTypeRaw = pickString(raw, ["document_type"]);
  const statusRaw = pickString(raw, ["status"]);
  const storagePath = pickString(raw, ["storage_path"]);

  const capturedByName = pickString(raw, [
    "captured_by_name",
    "capturer_name",
    "created_by_name",
    "submitted_by_name",
  ]);
  const capturedByEmail = pickString(raw, [
    "captured_by_email",
    "capturer_email",
    "created_by_email",
    "submitted_by_email",
  ]);

  const duplicateOf = pickString(raw, ["duplicate_of_draft_id", "duplicate_draft_id"]);
  const duplicateCount = pickNumber(raw, ["duplicate_count"]);
  const extraction = asExtraction(raw.extracted_json ?? raw.extraction);
  const pageCount = pickNumber(raw, ["page_count", "pages", "page_total"]);

  return {
    id,
    documentType: isDocumentType(documentTypeRaw) ? documentTypeRaw : "other",
    status: isDraftStatus(statusRaw) ? statusRaw : "pending_review",
    source: pickString(raw, ["source"]) ?? "upload",
    storagePath,
    branchId: pickString(raw, ["branch_id"]),
    branchLabel: pickString(raw, ["branch_code", "branch_name"]),
    extraction,
    hasExtraction: pickBoolean(raw, ["has_extraction"]) ?? extraction !== null,
    extractedAt: pickString(raw, ["extracted_at"]),
    // submitted_at is when the phone let go of it; created_at is when the row
    // first appeared. They differ for a draft assembled page by page.
    arrivedAt: pickString(raw, ["submitted_at", "created_at"]) ?? "",
    // A draft captured before capture_draft_pages existed has no page rows and
    // counts 0, but still has exactly one image at storage_path — call it the
    // one page it is rather than printing "0 pages" over a picture.
    pageCount: pageCount && pageCount > 0 ? pageCount : storagePath ? 1 : 0,
    capturedById: pickString(raw, ["captured_by", "created_by", "submitted_by"]),
    capturedByLabel: capturedByName ?? capturedByEmail,
    isDuplicate:
      pickBoolean(raw, ["is_possible_duplicate", "is_duplicate", "has_duplicate", "duplicate"]) ??
      (duplicateOf !== null || (duplicateCount !== null && duplicateCount > 0)),
    vendorHint: pickString(raw, ["vendor_hint"]),
    note: pickString(raw, ["note"]),
    rejectedReason: pickString(raw, ["rejected_reason", "rejection_reason"]),
    confirmedVoucherId: pickString(raw, ["confirmed_voucher_id"]),
  };
}

export function normalizeQueue(rows: unknown): QueueRow[] {
  if (!Array.isArray(rows)) return [];
  const out: QueueRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = normalizeQueueRow(r as Raw);
    if (row) out.push(row);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Display helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The one line that identifies a document in the queue, BEFORE anyone has
 * opened it. OCR now runs at review time, so a waiting row usually has no
 * extraction at all — what the person holding the phone typed is the only
 * thing there is, and that is exactly why the phone surface asks for it.
 *
 * The FILENAME is in this chain, not as filler but because it is often the
 * most identifying thing left: verified against the live queue, seeded rows
 * carry no hint and no note but are stored as "challan-DC-26-27-207.jpg".
 *
 * "Not yet read" is the last resort and is deliberately gated on
 * hasExtraction: get_capture_review_queue returns that flag but NOT the
 * extraction itself (it is large, and most rows in a queue are never opened),
 * so without the guard every already-read document in the list would claim it
 * had not been read — which is what it did say before this was fixed. The
 * proper fix is a vendor-name summary column on the RPC; see this task's
 * report.
 */
export function queueRowTitle(row: QueueRow): string {
  const vendor = row.extraction?.vendor_name ?? row.vendorHint;
  if (vendor) return vendor;
  if (row.note) return row.note;
  const fileName = row.storagePath ? fileNameOf(row.storagePath) : null;
  if (fileName && fileName !== "document") return fileName;
  return row.hasExtraction ? "Read — open to see the details" : "Not yet read";
}

/** Absolute local date and time, in the audit trail's own two-line shape. */
export function formatWhen(iso: string): { date: string; time: string } {
  if (!iso) return { date: "—", time: "" };
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return { date: "—", time: "" };
  return {
    date: d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
  };
}

/**
 * How the viewer should render a stored file. Decided from the path's
 * extension because capture_draft_pages carries no mime column — and the
 * answer only ever picks between an <img> and a PDF embed, so a wrong guess
 * degrades to "offer the download link" rather than to anything unsafe.
 */
export function documentKind(path: string | null | undefined): "pdf" | "image" {
  return typeof path === "string" && /\.pdf(\?.*)?$/i.test(path.trim()) ? "pdf" : "image";
}

/** Filename at the tail of a storage path, for the download link's label. */
export function fileNameOf(path: string | null | undefined): string {
  if (!path) return "document";
  const tail = path.split("/").pop() ?? path;
  // Both writers prefix a uuid ("<uuid>-<original name>"). Strip it so the
  // reviewer sees the name the shop's own phone gave the file.
  const stripped = tail.replace(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,
    ""
  );
  return stripped || tail;
}
