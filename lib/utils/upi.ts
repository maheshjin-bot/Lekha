/**
 * UPI payment deep link — NPCI's published `upi://pay` intent format,
 * confirmed live (WebSearch, Aug 2026) against NPCI's UPI Linking
 * Specifications and current bank/PSP integration guides. A static string
 * built entirely from data this app already has, plus one new fact
 * (companies.upi_vpa) — no payment gateway, no contract, no licence. See
 * supabase/migrations/0111_upi_payee_vpa.sql.
 */

// Mirrors companies_upi_vpa_check exactly (0111) — a structural pre-check
// only, same role TAN_PATTERN/UDYAM_PATTERN play in CompanySettingsForm; the
// database CHECK constraint is the real gate. Deliberately loose: NPCI PSP
// handles (okhdfcbank, ybl, ibl, paytm, and dozens more) are not a closed,
// enumerable list, so this only checks the local-part@handle shape.
export const UPI_VPA_PATTERN = /^[a-zA-Z0-9.\-_]{2,100}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/;

/**
 * Builds `upi://pay?pa=...&pn=...&am=...&cu=INR&tn=...&tr=...`.
 *
 * pa (the VPA) is NOT run through encodeURIComponent — every real-world UPI
 * link (NPCI's own spec examples included) carries the VPA's '@' literally,
 * but encodeURIComponent escapes '@' to %40 (it is a valid, unreserved-enough
 * character in a URI query per RFC 3986, just one encodeURIComponent is
 * conservative about). Safe to leave un-encoded here because upi_vpa is
 * already restricted to URI-safe characters by UPI_VPA_PATTERN/the database
 * CHECK before it ever reaches this function.
 *
 * pn/tn/tr ARE encoded — a payee name or invoice-derived note can contain
 * spaces and other characters that do need escaping, and encodeURIComponent
 * correctly renders a space as %20 (not '+'), matching NPCI's own examples.
 *
 * mc (merchant category code) and tid (PSP transaction id) are deliberately
 * omitted — this schema has no registered merchant category to report, and
 * fabricating one would be exactly the kind of invented value AGENTS.md's
 * STATUTORY CORRECTNESS section forbids; tid is PSP-assigned and this is an
 * unregistered static payee link, not a PSP-brokered transaction.
 */
export function buildUpiPayLink(params: {
  vpa: string;
  payeeName: string;
  amount: number;
  note: string;
  txnRef?: string;
}): string {
  const query = [
    `pa=${params.vpa}`,
    `pn=${encodeURIComponent(params.payeeName)}`,
    `am=${params.amount.toFixed(2)}`,
    `cu=INR`,
    `tn=${encodeURIComponent(params.note)}`,
  ];
  if (params.txnRef) {
    query.push(`tr=${encodeURIComponent(params.txnRef)}`);
  }
  return `upi://pay?${query.join("&")}`;
}
