import type { PostgrestError } from "@supabase/supabase-js";
import { CIN_STRUCTURE_HINT } from "./fieldPatterns";

/**
 * Turns a raw Postgres error from a direct `companies` table update into a
 * plain-English message, the same way lib/ledgers/friendlyError.ts does for
 * the two ledger forms.
 *
 * WHY THIS EXISTS. Company Settings writes public.companies directly, in six
 * independent sections, and every one of them did a bare
 * `setError(error.message)`. That is the same bug commit 7080e88 fixed on the
 * ledger forms: a mistyped TAN surfaced as `new row for relation "companies"
 * violates check constraint "companies_tan_check"`. Adding PAN, CIN and IEC —
 * three more format-checked identifiers, one of them (PAN) with a
 * cross-table guard trigger behind it — made having exactly one mapping worth
 * the file rather than three more inline copies.
 *
 * Only maps constraints reachable from this form. Anything unrecognised falls
 * through to the raw Postgres message, deliberately: that includes
 * app_private.enforce_company_pan_matches_registrations (1360), whose own
 * RAISE is already a plain-English sentence naming the offending GSTIN, and
 * swallowing it into a generic "something went wrong" would hide the one
 * detail the user needs.
 */
export function friendlyCompanyError(error: PostgrestError): string {
  const message = error.message ?? "";

  if (message.includes("companies_pan_check")) {
    return "That doesn't look like a valid PAN (format AAAAA9999A — five letters, four digits, one letter). Re-check it against the card.";
  }
  if (message.includes("companies_compliance_requires_pan")) {
    return "A company in compliance mode must have a PAN — every statutory module keys off it, and discovering it missing at filing time is far worse than refusing it here. Switch this company to books-only mode first if you really need to clear it.";
  }
  if (message.includes("companies_tan_check")) {
    return "That doesn't look like a valid TAN (format AAAA99999A — four letters, five digits, one letter). Re-check it against the allotment letter.";
  }
  if (message.includes("companies_iec_check")) {
    return "That doesn't look like a valid IEC. Since 2017 DGFT issues an IEC identical to the holder's PAN, so it has the same shape: AAAAA9999A.";
  }
  if (message.includes("companies_cin_check")) {
    return `That doesn't look like a valid CIN. ${CIN_STRUCTURE_HINT}`;
  }
  if (message.includes("companies_udyam_number_check")) {
    return "That doesn't look like a valid Udyam number (format UDYAM-XX-00-0000000) — copy it exactly from the registration certificate.";
  }
  if (message.includes("companies_udyam_category_check")) {
    return "Pick Micro, Small or Medium — or clear the Udyam number if this company has no registration.";
  }
  if (message.includes("companies_upi_vpa_check")) {
    return "That doesn't look like a UPI ID — expected something like yourname@okhdfcbank.";
  }
  if (message.includes("companies_company_tax_regime_check")) {
    return "That is not one of the four regimes LEKHA knows — pick one from the list.";
  }
  if (
    message.includes("companies_stock_margin_percent_check") ||
    message.includes("companies_debtor_margin_percent_check")
  ) {
    return "A margin has to be between 0 and 100 per cent.";
  }
  if (message.includes("companies_debtor_eligibility_days_check")) {
    return "The debtor eligibility window must be 30, 60 or 90 days.";
  }
  if (message.includes("companies_name_check")) {
    return "A company needs a name.";
  }

  return error.message ?? "The change could not be saved.";
}
