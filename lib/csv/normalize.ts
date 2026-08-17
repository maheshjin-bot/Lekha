/**
 * Name normalisation for matching, mirroring app_private.normalize_name in
 * Postgres. Two implementations exist and the expensive bug is the one where
 * they disagree — the importer would then match a ledger the database's own
 * duplicate index considers different, or vice versa.
 *
 * Collapses everything that is not a letter or digit to a single space and
 * lowercases, so "A. B. Traders" and "A B Traders" are the same name.
 */
export function normalizeName(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
