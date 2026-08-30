/**
 * Fuzzy name matching for the capture review screen: given a name the vision
 * model guessed off a photographed bill (a vendor, or a line-item
 * description), find the closest existing ledger/item by NAME, or hand back
 * null so the screen falls back to free text / "+ New".
 *
 * Deliberately not a real edit-distance library — Indian vendor names and
 * item descriptions on a bill routinely differ from the master record by a
 * suffix ("Sharma Textiles" on the bill vs "Sharma Textiles Pvt Ltd" in the
 * ledger) or by word order/spacing, not by single-character typos, so a
 * normalize + substring + token-overlap heuristic catches the cases that
 * actually occur without pulling in a dependency for it. This is a
 * convenience prefill only — the human confirms or overrides every match in
 * the review form before anything posts.
 */

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** 0 (no relation) to 1 (identical after normalizing). */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  const tokensA = new Set(na.split(" ").filter(Boolean));
  const tokensB = new Set(nb.split(" ").filter(Boolean));
  const union = new Set([...tokensA, ...tokensB]);
  if (union.size === 0) return 0;
  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap++;
  return overlap / union.size;
}

/**
 * The best candidate for `guess` by name, or null if nothing clears the
 * threshold (or `guess` itself is empty) — the review form treats null as
 * "no suggestion, leave it to the human".
 */
export function fuzzyMatchByName<T extends { name: string }>(
  guess: string | null | undefined,
  candidates: readonly T[],
  threshold = 0.5
): T | null {
  if (!guess || !guess.trim()) return null;

  let best: T | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = nameSimilarity(guess, candidate.name);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= threshold ? best : null;
}
