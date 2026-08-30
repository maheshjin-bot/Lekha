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
 *
 * That is still true of the NAME matcher, and it is why matchParty below now
 * sits beside it: a party is the one thing on a captured document that is
 * usually identified by something far stronger than its name — its GSTIN, or
 * failing that its PAN. Item descriptions have nothing of the kind, so they
 * keep using fuzzyMatchByName directly.
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

/* -------------------------------------------------------------------------- */
/* Matching a PARTY, where the name is the weakest evidence on the page       */
/* -------------------------------------------------------------------------- */

/**
 * Which fact matched, in the order this module trusts them.
 *
 * "gstin" — the two numbers are identical. A GSTIN identifies ONE legal
 *   entity's registration in ONE state; it is issued by the GST Network, it
 *   is unique, and its last character is a checksum over the other fourteen,
 *   so it does not collide by accident. Treat this as conclusive.
 *
 * "pan" — the same PAN, but not the same GSTIN (or one of the two has no
 *   GSTIN on file). A PAN is issued to a legal entity, and one entity holds
 *   one PAN and as many GSTINs as it has states. So this says "the same
 *   business, very probably a different state registration" — which is a
 *   thing worth telling a preparer and NOT a thing to act on silently: two
 *   registrations of one supplier legitimately need two ledgers here, because
 *   place of supply and the GSTR-1 tables follow the registration, not the
 *   business.
 *
 * "name" — fuzzyMatchByName above. A convenience, and the weakest signal on
 *   the paper: "Super Electricals" is a shop name in every district in India.
 */
export type PartyMatchSignal = "gstin" | "pan" | "name";

export type PartyMatch<T> = {
  party: T;
  signal: PartyMatchSignal;
  /** Only meaningful for "name" — 0 to 1 from nameSimilarity. */
  score: number;
};

/** The subset of a ledger this matcher reads. */
export type PartyCandidate = {
  id: string;
  name: string;
  gstin?: string | null;
  pan?: string | null;
};

/** What was read off the document, in the same three terms. */
export type PartyReading = {
  name?: string | null;
  gstin?: string | null;
  pan?: string | null;
};

/** Strips spacing/punctuation and uppercases, so "27 ABCDE 1234 F1Z5" matches. */
function normalizeCode(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const c = v.replace(/[\s.-]/g, "").toUpperCase();
  return c || null;
}

/**
 * The strongest available identification of the party a captured document is
 * with, or null when nothing identifies it.
 *
 * WHY THIS EXISTS BESIDE fuzzyMatchByName rather than replacing it: capture
 * shipped in 0740 matching parties BY NAME ONLY, which is the weakest thing
 * printed on an invoice — while the same invoice usually prints a GSTIN, a
 * fifteen-character checksummed token that names exactly one registration.
 * Matching on the name and ignoring the number meant the commonest and most
 * expensive mistake in this screen — creating a SECOND ledger for a supplier
 * already on file under a slightly different name — was invited by the one
 * document that carried the evidence to prevent it.
 *
 * The order is evidential strength, not convenience, and it stops at the
 * first hit: a GSTIN match is never overridden by a better-scoring name, and
 * a PAN match is never overridden by a name at all. Within a signal the first
 * candidate wins; a company holding two ledgers with one GSTIN is a data
 * problem this function cannot resolve and should not pretend to.
 *
 * WHAT THIS DOES NOT DO: decide. It reports which signal matched so the
 * caller can treat the three differently — the review screen selects the
 * party outright on a GSTIN match, and merely OFFERS a PAN match with the
 * "same business, different state registration" caveat, because acting on a
 * PAN match would quietly post a Gujarat bill against a Maharashtra
 * registration. See CaptureReviewForm.
 *
 * `candidates` is the caller's own filtered set — normally the ledgers whose
 * role the document type allows as a party. Matching outside that set is the
 * caller's business too (the review screen does it separately, to say "this
 * GSTIN is already on file as a CUSTOMER"), because a hit there is
 * information, not a party this document can be posted against.
 */
export function matchParty<T extends PartyCandidate>(
  reading: PartyReading,
  candidates: readonly T[],
  threshold = 0.5
): PartyMatch<T> | null {
  const gstin = normalizeCode(reading.gstin);
  if (gstin) {
    const hit = candidates.find((c) => normalizeCode(c.gstin) === gstin);
    if (hit) return { party: hit, signal: "gstin", score: 1 };
  }

  // The PAN read off the paper, or — much more usually — the one inside the
  // GSTIN. lib/capture/analyze.ts already reconciles those two and hands back
  // one value, but this function is also called with a raw reading and must
  // not depend on that having happened.
  const pan =
    normalizeCode(reading.pan) ?? (gstin && gstin.length === 15 ? gstin.slice(2, 12) : null);
  if (pan) {
    const hit = candidates.find(
      (c) => normalizeCode(c.pan) === pan || normalizeCode(c.gstin)?.slice(2, 12) === pan
    );
    if (hit) return { party: hit, signal: "pan", score: 1 };
  }

  const byName = fuzzyMatchByName(reading.name, candidates, threshold);
  return byName ? { party: byName, signal: "name", score: nameSimilarity(reading.name ?? "", byName.name) } : null;
}
