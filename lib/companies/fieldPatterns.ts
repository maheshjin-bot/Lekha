/**
 * One copy of every validation pattern the Company Settings form needs,
 * mirroring the CHECK constraints on public.companies.
 *
 * WHY THIS IS SEPARATE FROM lib/ledgers/fieldPatterns.ts. That file is
 * explicitly scoped to public.ledgers and says so — it mirrors
 * ledgers_pan_check, ledgers_gstin_check and friends. These mirror
 * companies_pan_check, companies_tan_check, companies_iec_check,
 * companies_udyam_number_check and companies_cin_check. The two tables happen
 * to share a PAN shape today (both call app_private.is_valid_pan), but they
 * are different constraints on different tables and nothing guarantees they
 * stay in step — importing one into the other would make a change to a ledger
 * rule silently change a company rule. Same rationale, one table each.
 *
 * THE DATABASE REMAINS THE AUTHORITY. Every pattern here is also a CHECK
 * constraint, and anything these miss comes back through
 * lib/companies/friendlyError.ts. The point of the client-side copy is only
 * that a typo is answered in the preparer's own words before the round trip,
 * instead of as `violates check constraint "companies_cin_check"` — the exact
 * bug commit 7080e88 fixed for the ledger forms.
 */

/** app_private.is_valid_pan, via companies_pan_check. */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** app_private.is_valid_tan, via companies_tan_check. */
export const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

/**
 * app_private.is_valid_iec, via companies_iec_check. DGFT has issued an IEC
 * identical to the holder's PAN since the 2017 harmonisation, so the shape is
 * the PAN's — not a coincidence, and the reason the form offers to copy the
 * PAN across.
 */
export const IEC_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * app_private.is_valid_cin, via companies_cin_check (1360). 21 characters:
 * L/U (listing status), 5-digit NIC industry code, 2-letter ROC state, 4-digit
 * year of incorporation, 3-letter company class (PLC/PTC/OPC/…), 6-digit
 * registration number. Shape only — the class code is not enumerated and the
 * year is not range-checked, both deliberately. See migration 1360.
 */
export const CIN_PATTERN = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;

/** app_private.is_valid_udyam, via companies_udyam_number_check. */
export const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;

/** The human structure of a CIN, written once for every message that needs it. */
export const CIN_STRUCTURE_HINT =
  "A CIN is 21 characters: L or U, a 5-digit industry code, a 2-letter state code, " +
  "the 4-digit year of incorporation, a 3-letter company class (PLC, PTC, OPC and so on) " +
  "and a 6-digit registration number — for example U72900MH2019PTC330045.";

/**
 * The 4th character of a PAN is its holder type. This is the check
 * app_private.is_valid_pan's own migration comment (0001) says belongs here
 * rather than in the constraint: "Type consistency against the company's
 * entity_type is checked at the application layer, not here — a mismatch is a
 * warning worth surfacing, not a reason to reject the row."
 */
export const PAN_HOLDER_TYPE_LETTERS: Record<string, string> = {
  P: "an individual",
  C: "a company",
  H: "a Hindu Undivided Family",
  F: "a firm or LLP",
  A: "an association of persons",
  T: "a trust",
  B: "a body of individuals",
  L: "a local authority",
  J: "an artificial juridical person",
  G: "a government body",
};

/**
 * Which holder-type letters are unremarkable for each entity_type.
 *
 * 'society' and 'aop_boi' are deliberately absent, not forgotten: societies
 * and AOP/BOIs are allotted A, B, T or even L depending on how they were
 * registered, so any expectation tight enough to be useful would fire on
 * somebody's perfectly correct card. No entry means no opinion, which is the
 * right answer when there isn't one.
 */
const EXPECTED_PAN_HOLDER_TYPES: Record<string, { letters: string[]; expectation: string }> = {
  proprietorship: {
    letters: ["P"],
    expectation: "an individual's PAN (4th character P) — a proprietorship files on the proprietor's own PAN",
  },
  partnership: { letters: ["F"], expectation: "a firm's PAN (4th character F)" },
  llp: { letters: ["F"], expectation: "a firm's PAN (4th character F) — an LLP counts as a firm here" },
  pvt_ltd: { letters: ["C"], expectation: "a company's PAN (4th character C)" },
  ltd: { letters: ["C"], expectation: "a company's PAN (4th character C)" },
  opc: { letters: ["C"], expectation: "a company's PAN (4th character C)" },
  huf: { letters: ["H"], expectation: "a HUF's PAN (4th character H)" },
  trust: {
    letters: ["T", "A"],
    expectation: "a trust's PAN (4th character T, or A where the trust was allotted an AOP PAN)",
  },
};

/**
 * A non-blocking sentence when the PAN's holder type doesn't look like this
 * company's entity type, and null whenever there is nothing to say — no
 * opinion for this entity type, an incomplete PAN, or a match. Never a reason
 * to refuse the save: a genuine mismatch happens (a business incorporated
 * mid-year still files part of the year on the old PAN), and the database
 * deliberately does not enforce it either.
 */
export function panHolderTypeWarning(entityType: string, pan: string): string | null {
  const expected = EXPECTED_PAN_HOLDER_TYPES[entityType];
  const value = pan.trim();
  if (!expected || !PAN_PATTERN.test(value)) return null;

  const letter = value[3];
  if (expected.letters.includes(letter)) return null;

  const reads = PAN_HOLDER_TYPE_LETTERS[letter];
  return (
    `The 4th character of a PAN is the holder type, and this one reads ${letter}` +
    (reads ? ` — ${reads}` : "") +
    `. A company registered like this one normally has ${expected.expectation}. ` +
    `LEKHA will still save it; re-check the card if that looks wrong.`
  );
}
