/**
 * Shared vocabulary for the phone scanner (/scan).
 *
 * This surface is deliberately tiny. The person holding the phone is shop-floor
 * staff, not a book-keeper: they photograph paper, say what kind of paper it is,
 * and send it. Nothing here describes a ledger, an amount or a voucher, because
 * nothing on this screen is ever allowed to show one.
 */

/**
 * Mirrors capture_drafts.document_type as shipped in migration 0865. Kept as a
 * hand-written union rather than pulled from types/database.types.ts because
 * that generated file has not been regenerated since 0865 landed, and this
 * session must not touch it.
 */
export type ScanDocumentType = "sales_challan" | "purchase_invoice" | "other";

export const SCAN_DOCUMENT_TYPES: ScanDocumentType[] = [
  "sales_challan",
  "purchase_invoice",
  "other",
];

/**
 * Plain language, not accounting language. "Delivery challan" is what the words
 * on the paper actually say in a godown; "outward supply document" is not.
 */
export const SCAN_DOCUMENT_TYPE_LABELS: Record<
  ScanDocumentType,
  { title: string; hint: string }
> = {
  sales_challan: {
    title: "Delivery challan",
    hint: "Goods going OUT of here",
  },
  purchase_invoice: {
    title: "Supplier bill",
    hint: "A bill someone gave US",
  },
  other: {
    title: "Something else",
    hint: "Office will sort it out",
  },
};

export function scanDocumentTypeLabel(value: string | null | undefined): string {
  if (value && value in SCAN_DOCUMENT_TYPE_LABELS) {
    return SCAN_DOCUMENT_TYPE_LABELS[value as ScanDocumentType].title;
  }
  return "Document";
}

/** A company this phone is allowed to send into. Name only — never a balance. */
export type ScanCompany = {
  id: string;
  name: string;
};

export type ScanBranch = {
  id: string;
  company_id: string;
  code: string;
  name: string;
};

/**
 * One photographed page, held in memory between the shutter and the send.
 *
 * `blob` is the already-cropped, already-downscaled JPEG — the original camera
 * file is dropped as soon as the crop is confirmed, because a cheap Android
 * holding six 12 MP originals in memory is a cheap Android that gets killed by
 * the OS mid-document.
 */
export type ScanPage = {
  /** Stable across reorders; the wire `pageNo` is the array index + 1. */
  id: string;
  blob: Blob;
  /** Object URL for the thumbnail. Revoked when the page is dropped. */
  previewUrl: string;
  width: number;
  height: number;
  bytes: number;
};

/** The three-tap tagging step. Both text fields are genuinely optional. */
export type ScanTags = {
  documentType: ScanDocumentType;
  vendorHint: string;
  note: string;
};

/**
 * What `get_my_capture_drafts` gives back. Declared structurally (not from the
 * generated DB types) for the same reason as ScanDocumentType above.
 */
export type ScanRecentSend = {
  draft_id: string;
  status: string;
  /**
   * 0870's own one-word collapse of status + submitted_at:
   * capturing | pending_review | confirmed | rejected. Preferred over `status`
   * because it is the only thing that distinguishes "the office has it" from
   * "the send died halfway and this draft never actually left the phone" —
   * both of which are status = 'pending_review'.
   */
  stage: string | null;
  rejected_reason: string | null;
  page_count: number;
  document_type: string | null;
  vendor_hint: string | null;
  created_at: string;
};

export type ScanSendStatus = {
  label: string;
  /** Tailwind classes for the status pill. */
  tone: string;
  /** Something is wrong with this one — draw the eye to it. */
  attention: boolean;
  /** The office pushed it back WITH a reason; offer a re-shoot. */
  sentBack: boolean;
  /** The pages uploaded but the send never finished — it is in nobody's queue. */
  unsent: boolean;
};

/**
 * Words a person with no accounting training can act on. "confirmed" becomes
 * "Posted" and "rejected" becomes "Sent back" — "rejected" reads as an
 * accusation, and the whole point of the loop is that they re-shoot it.
 *
 * Pass 0870's `stage` when it is there rather than `status`: "capturing" is a
 * draft whose pages uploaded but whose submit never landed, and calling that
 * "Pending review" would be a lie that leaves a bill sitting in nobody's queue
 * forever.
 */
export function describeSendStatus(status: string): ScanSendStatus {
  switch (status) {
    case "capturing":
      return {
        label: "Not sent",
        tone: "bg-warning-soft text-warning",
        attention: true,
        sentBack: false,
        unsent: true,
      };
    case "confirmed":
      return {
        label: "Posted",
        tone: "bg-success-soft text-success",
        attention: false,
        sentBack: false,
        unsent: false,
      };
    case "rejected":
      return {
        label: "Sent back",
        tone: "bg-error-soft text-error",
        attention: true,
        sentBack: true,
        unsent: false,
      };
    case "pending_review":
      return {
        label: "Pending review",
        tone: "bg-surface-2 text-ink-soft",
        attention: false,
        sentBack: false,
        unsent: false,
      };
    default:
      return {
        label: status,
        tone: "bg-surface-2 text-ink-soft",
        attention: false,
        sentBack: false,
        unsent: false,
      };
  }
}
