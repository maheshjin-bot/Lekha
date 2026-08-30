/**
 * Bank statement column-layout adapters.
 *
 * Before this file, bank-import.ts hardcoded exactly one column layout —
 * Date, Description, Reference, Debit, Credit — and any real bank export
 * that didn't match that shape (which is most of them; it is this app's own
 * template, not any bank's) had to be hand-edited before upload. This file
 * adds a small registry of REAL, sourced column layouts and maps any of
 * them onto the same canonical shape the rest of the importer already
 * understands, so buildBankPreview and the reconciliation screen do not
 * need to know which bank a file came from.
 *
 * SOURCING DISCIPLINE — every layout below is backed by either (a) a real,
 * independently-published customer statement (not a converter's marketing
 * copy) or (b) multiple independent parser implementations agreeing on the
 * same header text. WebSearch'd today (26 Aug 2026). Two banks that were
 * deliberately investigated and DROPPED rather than guessed at:
 *   - SBI: every source found says SBI's net-banking download is PDF or
 *     Excel, and no independently-verifiable real sample of its native
 *     column header text turned up (only third-party converters describing
 *     their OWN normalised output columns, which is not evidence of SBI's
 *     own export format). Not included.
 *   - Kotak Mahindra: same problem — every source was a converter's
 *     marketing page describing its own output shape, not a real Kotak
 *     export. Not included.
 * Both are common enough that a real sample should be added here the day
 * one is confirmed, rather than shipping a guess now.
 *
 * THE ONE GENUINE SURPRISE OF THE RESEARCH: ICICI and Axis do NOT use a
 * split Debit/Credit column pair the way HDFC (and this app's own existing
 * template) does. Real statement samples of both (see per-format citations
 * below) show a single signed "Amount" column plus a separate transaction-
 * type column carrying a Dr/Cr-style marker. That is a genuinely different
 * SHAPE, not just different header text, which is why `amountShape` below
 * is a first-class distinction (`'split'` vs `'signed'`) and not just a
 * column-name lookup table.
 */
import { normalizeName } from "@/lib/csv/normalize";
import { parseAmount } from "@/lib/csv/coerce";

export type BankFormatId = "generic" | "hdfc_netbanking" | "icici_netbanking" | "axis_netbanking";

type SplitColumns = {
  amountShape: "split";
  date: string;
  description: string;
  reference: string | null;
  debit: string;
  credit: string;
};

type SignedColumns = {
  amountShape: "signed";
  date: string;
  description: string;
  reference: string | null;
  amount: string;
  type: string;
  /** Normalised (see normalizeHeaderToken) prefixes of the type column that mean money OUT. */
  debitTokens: string[];
  /** Normalised prefixes of the type column that mean money IN. */
  creditTokens: string[];
};

export type BankFormatDef = {
  id: BankFormatId;
  label: string;
  /** Shown in the UI so a user can sanity-check the match against their own file. */
  source: string;
  columns: SplitColumns | SignedColumns;
};

export const BANK_FORMATS: BankFormatDef[] = [
  {
    id: "generic",
    label: "Generic (Date, Description, Reference, Debit, Credit)",
    source: "This app's own template — use this for any file already in this shape, or export from another accounting package.",
    columns: {
      amountShape: "split",
      date: "date",
      description: "description",
      reference: "reference",
      debit: "debit",
      credit: "credit",
    },
  },
  {
    id: "hdfc_netbanking",
    label: "HDFC Bank (NetBanking statement export)",
    source:
      "Real HDFC customer statements (multiple independent account holders, Aug 2026 search) and independent open-source HDFC statement parsers all agree on this 7-column header.",
    columns: {
      amountShape: "split",
      date: "Date",
      description: "Narration",
      reference: "Chq./Ref.No.",
      debit: "Withdrawal Amt.",
      credit: "Deposit Amt.",
    },
  },
  {
    id: "icici_netbanking",
    label: "ICICI Bank (account statement export)",
    source:
      "A real ICICI customer statement (Aug 2026 search) — single signed Amount column plus a separate Transaction Type (Dr/Cr) column, NOT a split Debit/Credit pair.",
    columns: {
      amountShape: "signed",
      date: "Transaction Date",
      description: "Transaction Remarks",
      reference: "Cheque Number",
      amount: "Amount (INR)",
      type: "Transaction Type",
      debitTokens: ["d"], // "Dr", "Debit", "D" all normalise to a leading "d"
      creditTokens: ["c"], // "Cr", "Credit", "C"
    },
  },
  {
    id: "axis_netbanking",
    label: "Axis Bank (account statement export)",
    source:
      "A real Axis Bank customer statement (Aug 2026 search): \"Tran Date / Value Date / Transaction Particulars / Chq No / Amount(in Rs.) / DR/CR / Balance\" — same single-signed-amount shape as ICICI, different header text. (Axis is also known to have a second, split-Debit/Credit layout on some channels; only this confirmed real-sample layout is included.)",
    columns: {
      amountShape: "signed",
      date: "Tran Date",
      description: "Transaction Particulars",
      reference: "Chq No",
      amount: "Amount(in Rs.)",
      type: "DR/CR",
      debitTokens: ["d"],
      creditTokens: ["c"],
    },
  },
];

export function getBankFormat(id: BankFormatId): BankFormatDef {
  const def = BANK_FORMATS.find((f) => f.id === id);
  if (!def) throw new Error(`Unknown bank format: ${id}`);
  return def;
}

/** Strips everything but letters/digits and lowercases, so "Chq./Ref.No." and "Chq / Ref No" match. */
export function normalizeHeaderToken(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Exported for lib/csv/bank-pdf-import.ts — the PDF path needs the exact
 * same header-label strings CSV detection matches against, to locate a
 * format's header row inside a PDF's extracted text and to build the
 * geometric column ranges from it. detectBankFormat/mapRowToCanonical stay
 * the single source of truth for what each format's own real column names
 * are; the PDF path never hardcodes them a second time.
 */
export function expectedHeaders(def: BankFormatDef): string[] {
  const c = def.columns;
  return c.amountShape === "split"
    ? [c.date, c.description, c.reference, c.debit, c.credit].filter((x): x is string => !!x)
    : [c.date, c.description, c.reference, c.amount, c.type].filter((x): x is string => !!x);
}

/**
 * Best-guess format from a file's header row, or null if nothing matches
 * confidently. Never auto-COMMITS to a guess — the reconciliation screen
 * always shows the detected format and lets the user override it before
 * anything is imported, the same "infer, then let the user confirm"
 * pattern this file's date-order inference already uses. That matters more
 * here than for dates: picking the wrong format can silently swap which
 * column is debit and which is credit.
 */
export function detectBankFormat(headerRow: string[]): BankFormatId | null {
  const uploaded = new Set(headerRow.map(normalizeHeaderToken));
  // Skip 'generic' for detection purposes — its header names ("date",
  // "description", "debit", "credit") are generic enough that they would
  // spuriously partial-match real bank exports too. A file that really is
  // in the generic shape is exactly matched at 100% and nothing else comes
  // close, so it still wins on score; it just isn't given a home-field
  // advantage.
  let best: { id: BankFormatId; score: number } | null = null;
  for (const def of BANK_FORMATS) {
    const expected = expectedHeaders(def);
    const hits = expected.filter((h) => uploaded.has(normalizeHeaderToken(h))).length;
    const score = hits / expected.length;
    if (!best || score > best.score) best = { id: def.id, score };
  }
  // Require every expected column present — these header sets are short
  // (5) and distinctive; a partial match is more likely a coincidence than
  // a real file with one renamed column, and guessing wrong on debit/credit
  // is worse than asking.
  return best && best.score >= 1 ? best.id : null;
}

export type CanonicalRow = {
  date: string;
  description: string;
  reference: string;
  debitRaw: string;
  creditRaw: string;
};

/** Maps one raw CSV row (whatever headers it has) onto the canonical 5-field shape. */
export function mapRowToCanonical(raw: Record<string, string>, def: BankFormatDef): CanonicalRow {
  const pick = (header: string | null): string => {
    if (!header) return "";
    const target = normalizeHeaderToken(header);
    for (const [k, v] of Object.entries(raw)) {
      if (normalizeHeaderToken(k) === target) return (v ?? "").trim();
    }
    return "";
  };

  const c = def.columns;
  const date = pick(c.date);
  const description = pick(c.description);
  const reference = pick(c.reference);

  if (c.amountShape === "split") {
    return { date, description, reference, debitRaw: pick(c.debit), creditRaw: pick(c.credit) };
  }

  const amountRaw = pick(c.amount);
  const amount = parseAmount(amountRaw);
  const typeRaw = normalizeHeaderToken(pick(c.type));
  const isDebit = c.debitTokens.some((t) => typeRaw.startsWith(t));
  const isCredit = c.creditTokens.some((t) => typeRaw.startsWith(t));

  // Feed the ORIGINAL raw string through when it fails to parse (so
  // buildBankPreview's existing "Amount is not a number." message fires
  // with the right wording), and the absolute magnitude when it parses
  // successfully (so a sign embedded in the source Amount column never
  // fights the separate type column, which is authoritative for the side).
  const forSide = (on: boolean): string => (!on ? "" : amount === null ? amountRaw : String(Math.abs(amount)));

  // An unrecognised (or blank) type marker deliberately leaves BOTH sides
  // blank rather than guessing a side — buildBankPreview already raises
  // "Either a debit or a credit amount is required." for that shape, which
  // is the honest outcome for a row this adapter cannot confidently sign.
  return {
    date,
    description,
    reference,
    debitRaw: forSide(isDebit),
    creditRaw: forSide(isCredit),
  };
}

/**
 * A deterministic idempotency key for one statement line, computed purely
 * from the line's own (already-canonicalised) content plus its occurrence
 * index among identical-looking rows in the same file. Re-uploading a
 * byte-identical file reproduces the exact same sequence of keys, because
 * rows are processed in file order every time — that is what makes
 * re-import idempotent without needing every bank export to carry its own
 * unique reference number (many don't, e.g. an interest credit or a cash
 * deposit often has a blank Chq/Ref field).
 *
 * When a real reference number IS present it is included directly, so two
 * genuinely different transactions that happen to share a date/description/
 * amount but carry different bank references are correctly treated as
 * different lines even out of file order.
 *
 * NOT a cryptographic hash — just a stable, readable composite key. There
 * is no confidentiality requirement on a dedupe key for one company's own
 * already-visible bank_statement_lines rows.
 */
export function computeExternalTxnId(
  row: { date: string; description: string; reference: string; debit: number; credit: number },
  occurrenceIndex: number
): string {
  const desc = normalizeName(row.description).slice(0, 80);
  const ref = normalizeName(row.reference);
  return [row.date, desc, ref, row.debit.toFixed(2), row.credit.toFixed(2), occurrenceIndex].join("|");
}
