/**
 * Turns a raw Postgres error from a direct `ledgers` table insert/update into
 * a plain-English message, the same way the e-invoice and e-way-bill routes
 * already do for their own exceptions.
 *
 * WHY THIS EXISTS SEPARATELY, NOT INLINE. QuickAddLedgerModal.tsx had this
 * exact mapping (23505, ledgers_gstin_check, ledgers_bank_block_anchored,
 * ledgers_state_code_fkey) written inline; LedgerManager.tsx's own "New
 * ledger" form did a structurally identical insert against the same table
 * and constraints but never got the same treatment — its onSubmit just did
 * `setError(error.message)`, so a mistyped GSTIN's last digit surfaced as
 * `new row for relation "ledgers" violates check constraint
 * "ledgers_gstin_check"` verbatim. Found live (wave 7, 1 Sep 2026). Extracted
 * here so there is exactly one mapping to keep in step as new constraints are
 * added, rather than two copies that can silently drift apart again.
 *
 * Only maps constraints actually reachable from a plain ledger form (name,
 * GSTIN/PAN, bank block, MSME, state). Anything unrecognised falls back to
 * the raw Postgres message — better than swallowing a real error into a
 * generic "something went wrong" that hides what to fix.
 *
 * Extended for update_ledger (1330): pincode/email/TAN/bank-name-and-account
 * constraints that a create-only form never hit because neither existing
 * create path (LedgerManager's own form, QuickAddLedgerModal without a
 * prefill) wrote those columns. update_ledger's own RAISE EXCEPTION messages
 * (the admin-only opening-balance/group gate, the new group-lock-once-posted
 * rule, the permission check) are deliberately plain English already, not
 * constraint names — they fall through to the raw `error.message` at the
 * bottom of this function unchanged, which is already what a human should see.
 *
 * Takes the minimal shape this function actually reads (message, optional
 * code) rather than the full supabase-js PostgrestError, so a caller behind
 * callRpc — whose error type is narrower, since update_ledger isn't in
 * generated types yet — can pass its error straight through with no cast.
 * A real PostgrestError satisfies this shape too, so nothing about the
 * direct-table-insert callers (LedgerManager, QuickAddLedgerModal) changes.
 */
export function friendlyLedgerError(
  error: { message: string; code?: string },
  ledgerName: string
): string {
  if (error.code === "23505") {
    return `This company already has a ledger called "${ledgerName}".`;
  }
  const message = error.message ?? "";
  if (message.includes("ledgers_gstin_check")) {
    return "That GSTIN failed its check digit — re-read the last character from the certificate.";
  }
  if (message.includes("ledgers_gstin_matches_pan")) {
    return "That GSTIN's embedded PAN doesn't match the PAN entered — check both against the certificate.";
  }
  if (message.includes("ledgers_gstin_matches_state")) {
    return "That GSTIN's state code doesn't match the state selected — the first two digits of a GSTIN are the state code.";
  }
  if (message.includes("ledgers_pan_check")) {
    return "That doesn't look like a valid PAN (format AAAAA9999A) — re-check it against the card.";
  }
  if (message.includes("ledgers_udyam_number_check")) {
    return "That doesn't look like a valid Udyam number (format UDYAM-XX-00-0000000) — copy it exactly from the registration certificate.";
  }
  if (message.includes("ledgers_bank_ifsc_check")) {
    return "That doesn't look like a valid IFSC (11 characters: 4 letters, a 0, then 6 more) — re-check it against a cheque or passbook.";
  }
  if (message.includes("ledgers_bank_block_anchored")) {
    return "A bank name or IFSC can only be saved together with the account number they belong to — add the account number, or clear both.";
  }
  if (message.includes("ledgers_state_code_fkey")) {
    return "That state code is not one the GST system issues — pick the state from the list.";
  }
  if (message.includes("ledgers_name_check")) {
    return "A ledger needs a name.";
  }
  if (message.includes("ledgers_registered_has_gstin")) {
    return "A registered GST type (Regular, Composition, SEZ, SEZ Developer, UIN or Deemed Export) needs a GSTIN.";
  }
  if (message.includes("ledgers_unregistered_has_no_gstin")) {
    return "Unregistered and Overseas parties can't carry a GSTIN — clear it, or change the GST type.";
  }
  if (message.includes("ledgers_pincode_check")) {
    return "A PIN code is six digits and cannot start with a zero.";
  }
  if (message.includes("ledgers_email_check")) {
    return "That doesn't look like an email address.";
  }
  if (message.includes("ledgers_tan_check")) {
    return "That doesn't look like a valid TAN (format AAAA99999A) — re-check it against the deductor's certificate or Form 26AS.";
  }
  if (message.includes("ledgers_bank_account_number_check")) {
    return "A bank account number is 5 to 34 letters or digits, with no spaces.";
  }
  if (message.includes("ledgers_bank_name_check")) {
    return "A bank name needs to be between 2 and 120 characters — or leave it blank.";
  }
  if (message.includes("ledgers_relationship_type_requires_flag_check")) {
    return "An AS 18 relationship can only be set when \"Related / specified person\" is ticked.";
  }
  return error.message ?? "The ledger could not be saved.";
}
