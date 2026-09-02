/**
 * One copy of every ledgers-form validation pattern, mirroring the CHECK
 * constraints and validator functions on public.ledgers.
 *
 * WHY THIS EXISTS. There are two forms that write a ledger master —
 * components/ledgers/LedgerManager.tsx's "New ledger" panel and
 * components/ledgers/QuickAddLedgerModal.tsx's inline popup — and they have
 * now drifted apart twice against the same table:
 *
 *   1. Error mapping. QuickAddLedgerModal mapped constraint names to English
 *      inline; LedgerManager did a bare setError(error.message), so a mistyped
 *      GSTIN surfaced as `violates check constraint "ledgers_gstin_check"`.
 *      Fixed by extracting lib/ledgers/friendlyError.ts (commit 7080e88).
 *   2. Field set. QuickAddLedgerModal collected address/city/pincode;
 *      LedgerManager collected none of the three — so a B2B customer created
 *      on the main Ledgers screen could never be e-invoice-eligible, because
 *      build_einvoice_json (0230) refuses with 'Buyer (%) is missing a
 *      required address field (address, city or PIN code)'. Live data showed
 *      how far that had run: of 402 ledgers, 19 had an address and 14 a PIN
 *      code. Fixed by adding the three fields to LedgerManager, and by this
 *      file.
 *
 * Extracting the mapping killed the first class of drift; this kills the
 * second half of the same problem — the two forms no longer keep private
 * copies of the same regexes, so a constraint that changes has exactly one
 * place to be updated. The forms themselves are deliberately NOT merged into
 * one component: they answer different questions (a full ~25-field master vs
 * the four things a posting actually needs mid-invoice) and folding them
 * together would put twenty fields in front of someone half-way through an
 * invoice. Shared rules, separate forms.
 *
 * THE DATABASE REMAINS THE AUTHORITY. Every pattern here is also enforced by a
 * CHECK constraint on public.ledgers, and anything these miss comes back
 * through lib/ledgers/friendlyError.ts. Note in particular that the GSTIN
 * pattern is the SHAPE half only — the check digit is arithmetic
 * (app_private.gstin_check_digit) and is deliberately not reimplemented in
 * TypeScript, because a second copy that drifted would reject numbers Postgres
 * accepts.
 */

/** app_private.is_valid_pan, via ledgers_pan_check. */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * The shape half of app_private.is_valid_gstin, via ledgers_gstin_check.
 * 2-digit state, 10-character PAN, entity code, a literal Z, check digit.
 */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** app_private.is_valid_udyam, via ledgers_udyam_number_check. */
export const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;

/** ledgers_pincode_check. Six digits, never leading zero. */
export const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;

/** ledgers_email_check. */
export const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** app_private.is_valid_ifsc, via ledgers_bank_ifsc_check (0995). */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** ledgers_bank_account_number_check (0995). */
export const ACCOUNT_PATTERN = /^[A-Za-z0-9]{5,34}$/;

/**
 * The gst_registration_type values that mean "this party holds a GSTIN",
 * mirroring ledgers_registered_has_gstin (0735). Its converse —
 * ledgers_unregistered_has_no_gstin — covers 'unregistered' and 'overseas',
 * below.
 */
export const GST_TYPES_NEEDING_GSTIN = [
  "regular",
  "composition",
  "sez",
  "sez_developer",
  "uin",
  "deemed_export",
] as const;

/** ledgers_unregistered_has_no_gstin (0735). */
export const GST_TYPES_FORBIDDING_GSTIN = ["unregistered", "overseas"] as const;

/**
 * Both constraints as predicates over the raw select value. "" is neither —
 * it is how both forms spell "Regular / not set", which is stored as null and
 * stays permissive, because enforce_ledger_gst_identity (0006) fills in
 * 'regular' itself once a GSTIN is present.
 */
export const needsGstin = (registrationType: string): boolean =>
  (GST_TYPES_NEEDING_GSTIN as readonly string[]).includes(registrationType);

export const forbidsGstin = (registrationType: string): boolean =>
  (GST_TYPES_FORBIDDING_GSTIN as readonly string[]).includes(registrationType);

/**
 * True for an empty value or one that matches. Both forms want "don't nag
 * about a field nobody has typed in yet", and both had written that as
 * `value.length === 0 || PATTERN.test(value)` in their own words.
 */
export function blankOrMatches(pattern: RegExp, value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || pattern.test(trimmed);
}

/**
 * A GSTIN is a composite key: characters 1-2 are the state code and 3-12 are
 * the PAN. Deriving both from it (rather than asking for them again) is what
 * keeps either form on the right side of ledgers_gstin_matches_state and
 * ledgers_gstin_matches_pan (0735) without the preparer having to know those
 * constraints exist. Empty string when the value is not yet a whole GSTIN, so
 * a half-typed number never stamps a two-character state over a good one.
 */
export const stateFromGstin = (gstin: string): string =>
  GSTIN_PATTERN.test(gstin) ? gstin.slice(0, 2) : "";

export const panFromGstin = (gstin: string): string =>
  GSTIN_PATTERN.test(gstin) ? gstin.slice(2, 12) : "";
