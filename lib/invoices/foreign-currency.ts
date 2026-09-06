/**
 * Foreign-currency invoice support for InvoiceForm — currency/rate/rate-source
 * are voucher-level metadata (create_invoice, migration 0065), never an input
 * to how item lines are priced or taxed. This file exists so InvoiceForm's
 * client-side tax PREVIEW stops disagreeing with what create_invoice actually
 * posts on an export: before this, the preview only ever computed a plain
 * intra/inter split (branch.registeredState vs placeOfSupply) and had no idea
 * an LUT exists — so an exporter shipping under a valid LUT (Sec 16(3)(a),
 * zero tax) was shown a full IGST figure on screen that the database was
 * never going to charge. The server is still the one that actually decides;
 * this only has to stop lying about it on the way there.
 */

/** Mirrors ForexManager's own list (components/forex/ForexManager.tsx) so the
 * two currency pickers in the app never disagree. Kept here rather than
 * imported from that client component, which this form has no reason to
 * depend on. */
export const FOREIGN_CURRENCIES = ["USD", "EUR", "GBP", "AED", "SGD", "JPY", "AUD", "CAD"] as const;

/** The exact CHECK constraint on vouchers.rate_source (migration 0071):
 * `rate_source is null or rate_source = any(array['rbi','bank','cbic','manual'])`.
 * Confirmed live against the real constraint before writing this, not
 * guessed — offering anything else here is a guaranteed round-trip failure. */
export const RATE_SOURCES = [
  { value: "rbi", label: "RBI reference rate" },
  { value: "bank", label: "Bank-advised rate" },
  { value: "cbic", label: "CBIC notified rate" },
  { value: "manual", label: "Manual" },
] as const;

export type SupplyType = "intra" | "inter" | "export_lut" | "export_igst" | "sez" | "deemed_export";

/**
 * Mirrors create_invoice's own LUT-active test exactly (its SELECT off
 * gst_registrations): lut_number is not null and the voucher date falls
 * inside [lut_valid_from, lut_valid_to] (or open-ended when lut_valid_to is
 * null). Preview-only — the database is still the one that actually decides.
 */
export function isLutActive(
  branch:
    | { lutNumber?: string | null; lutValidFrom?: string | null; lutValidTo?: string | null }
    | undefined,
  onDate: string
): boolean {
  if (!branch?.lutNumber || !branch.lutValidFrom) return false;
  if (onDate < branch.lutValidFrom) return false;
  if (branch.lutValidTo && onDate > branch.lutValidTo) return false;
  return true;
}

/**
 * Mirrors app_private.gst_supply_type's 4-argument overload exactly
 * (migration 0087) — this is the classification create_invoice actually
 * uses, not the 2-argument intra/inter-only overload the old preview code
 * effectively reimplemented by hand.
 */
export function classifySupplyType(
  supplierState: string,
  placeOfSupply: string,
  partyRegistrationType: string | null | undefined,
  lutActive: boolean
): SupplyType {
  if (partyRegistrationType === "overseas") return lutActive ? "export_lut" : "export_igst";
  if (partyRegistrationType === "sez" || partyRegistrationType === "sez_developer") return "sez";
  if (partyRegistrationType === "deemed_export") return "deemed_export";
  return supplierState === placeOfSupply ? "intra" : "inter";
}

/**
 * One line's CGST/SGST/IGST split, mirroring create_invoice's own per-line
 * if/elsif chain exactly — INCLUDING the export_lut/sez-under-LUT
 * zero-rating and the export_igst/sez-without-LUT full-IGST-always-inter-
 * State route, not just the plain intra/inter split the old preview did.
 *
 * isIntrastate is a SEPARATE argument, not derived from supplyType, because
 * that mirrors a real subtlety in create_invoice: a 'deemed_export' line
 * (Sec 147) is TAXED the ordinary domestic way — the label exists only for
 * GSTR-1, per that migration's own header comment — so it falls through to
 * the same real-state intra/inter test as an ordinary sale, not to a forced
 * IGST branch. Collapsing that distinction away would have reintroduced
 * exactly the kind of preview/server disagreement this file exists to close.
 */
export function lineGstSplit(
  amount: number,
  gstRatePercent: number,
  supplyType: SupplyType,
  lutActive: boolean,
  isIntrastate: boolean
): { cgst: number; sgst: number; igst: number } {
  const r2 = (n: number) => Math.round(n * 100) / 100;

  if (supplyType === "export_lut" || (supplyType === "sez" && lutActive)) {
    return { cgst: 0, sgst: 0, igst: 0 };
  }
  if (supplyType === "export_igst" || (supplyType === "sez" && !lutActive)) {
    return { cgst: 0, sgst: 0, igst: r2((amount * gstRatePercent) / 100) };
  }
  if (isIntrastate) {
    const half = r2((amount * gstRatePercent) / 2 / 100);
    return { cgst: half, sgst: half, igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: r2((amount * gstRatePercent) / 100) };
}
