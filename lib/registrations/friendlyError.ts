/**
 * Both error shapes this screen can produce. A direct `.update()` on
 * gst_registrations (the LUT editor) returns a full PostgrestError; callRpc
 * returns a bare `{ message }`. Only `message` and `code` are ever read, so
 * one structural type covers both and neither caller needs a cast — the
 * ledgers helper takes PostgrestError because a ledger form only ever has
 * the one shape.
 */
type RegistrationError = { message?: string | null; code?: string };

/**
 * Turns a raw Postgres error from the GST registrations screen into a
 * plain-English message, the same way lib/ledgers/friendlyError.ts already
 * does for the ledger forms.
 *
 * WHAT REACHES THIS. update_gst_registration (1390) raises its own
 * plain-English exceptions for everything it can see coming — the surrender
 * date preceding the registered-from date, a surrender date that predates a
 * voucher already posted, an unknown filing frequency — so those arrive
 * already readable and fall through untouched. What this maps is the set of
 * table constraints reachable from add_gst_registration, where the first
 * thing a user does with a new GSTIN is mistype it:
 *
 *   gst_registrations_gstin_check   — the checksum, the single most common
 *                                     GSTIN typo, and by far the least
 *                                     legible raw message.
 *   gst_registrations_gstin_key     — the same GSTIN already registered,
 *                                     possibly under a different company.
 *   ..._state_code_registration_type_key — one registration per type per
 *                                     state; the duplicate people actually
 *                                     hit is a second regular GSTIN in a
 *                                     state they already have one in.
 *   branches_gst_registration_id_fkey — a branch in another state.
 *
 * Anything unrecognised falls back to the raw Postgres message rather than a
 * generic "something went wrong" that hides what to fix — same rule as the
 * ledgers helper.
 */
export function friendlyRegistrationError(error: RegistrationError, gstin?: string): string {
  const message = error.message ?? "";

  if (message.includes("gst_registrations_gstin_check")) {
    return "That GSTIN failed its check digit — re-read the last character from the registration certificate.";
  }
  if (message.includes("gst_registrations_gstin_key")) {
    return gstin
      ? `GSTIN ${gstin} is already registered in LEKHA. A GSTIN can only be held by one company here.`
      : "That GSTIN is already registered in LEKHA. A GSTIN can only be held by one company here.";
  }
  if (message.includes("gst_registrations_company_id_state_code_registration_type_key")) {
    return "This company already has a registration of this type in this state — a PAN can only hold one per state per type. Surrender the existing one first if it is being replaced.";
  }
  if (message.includes("gst_registrations_period_valid")) {
    return "The surrender date cannot be earlier than the date the GSTIN was registered from.";
  }
  if (message.includes("gst_registrations_state_code_fkey")) {
    return "That GSTIN's first two digits are not a state code the GST system issues — re-check the number.";
  }
  if (message.includes("branches_gst_registration_id_fkey") || message.includes("branches_gst_registration")) {
    return "That branch is not in this GSTIN's state — a branch can only sit under a registration in its own state.";
  }
  if (error.code === "23505") {
    return "That registration already exists.";
  }
  return error.message ?? "The registration could not be saved.";
}
