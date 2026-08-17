/**
 * Turning spreadsheet cells into values.
 *
 * Three of the defects carried over from HISAB's importer live here, and all
 * three share a shape: the parser was stricter or looser than real exported
 * data, and the failure was either a wall of rejected rows or — worse —
 * silently wrong data.
 */

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * HISAB used `Number(raw)`, so `Number("1,00,000.00")` was NaN and an ordinary
 * Excel export with Indian digit grouping failed on every row, blaming the
 * user's data rather than explaining the fix.
 *
 * Accepts grouping in either convention, a currency symbol, spaces, a trailing
 * Dr/Cr marker, and accounting-style brackets for negatives. Rejects anything
 * genuinely non-numeric rather than coercing it to zero — a cell reading "n/a"
 * must not silently become 0.00.
 */
export function parseAmount(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  let s = raw.trim();
  if (s === "") return null;

  // Accounting negatives: (1,234.00)
  let negative = false;
  if (/^\((.*)\)$/.test(s)) {
    negative = true;
    s = s.replace(/^\((.*)\)$/, "$1").trim();
  }

  // Trailing Dr/Cr markers are a display convention, not part of the number.
  // Cr does NOT mean negative here — the Dr/Cr column decides the side.
  s = s.replace(/\s*(dr|cr)\.?$/i, "").trim();

  // Currency symbols and the words some exports emit.
  s = s.replace(/^(₹|rs\.?|inr)\s*/i, "").trim();

  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }

  // Grouping separators, both 1,00,000.00 and 100,000.00. Only strip commas
  // that sit between digits, so "1,2,3" style junk still fails below.
  s = s.replace(/(?<=\d),(?=\d)/g, "");
  s = s.replace(/\s/g, "");

  if (!/^\d*\.?\d+$/.test(s)) return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export type DateOrder = "dmy" | "mdy";

/** A real calendar date, or null. Rejects 32/13/2026 rather than passing it on. */
function buildDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Round-trip: catches 31 February, which the range check above allows.
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Parses a date cell to YYYY-MM-DD under an explicit ordering.
 *
 * The ordering is a parameter, not a guess. HISAB always read the first
 * component as the day, so a US-locale export writing 1 April as 04/01/2026
 * imported as 4 January — both dates valid, both inside plausible financial
 * years, nothing to error on. An entire book could be silently wrong by
 * months. The caller must decide, and `inferDateOrder` below tells it whether
 * the file itself settles the question.
 */
export function parseDate(raw: string, order: DateOrder = "dmy"): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return buildDate(+iso[1], +iso[2], +iso[3]);

  const parts = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
  if (!parts) return null;

  const a = +parts[1];
  const b = +parts[2];
  let year = +parts[3];
  // Two-digit years: 70-99 are 1900s, everything else 2000s. Arbitrary, but it
  // has to be something, and no accounting file predates 1970.
  if (parts[3].length === 2) year += year >= 70 ? 1900 : 2000;

  return order === "dmy" ? buildDate(year, b, a) : buildDate(year, a, b);
}

export type DateOrderInference =
  | { order: DateOrder; certain: true; reason: string }
  | { order: DateOrder; certain: false; reason: string; example: string | null };

/**
 * Works out whether the file itself settles the day/month ordering.
 *
 * If any row has a first component above 12 it can only be a day, and the file
 * is unambiguous. If every date could be read either way, it is genuinely
 * ambiguous and the user has to confirm — so this returns certain: false with a
 * worked example from their own data, rather than picking silently.
 */
export function inferDateOrder(values: string[]): DateOrderInference {
  let firstOver12 = false;
  let secondOver12 = false;
  let sample: string | null = null;

  for (const v of values) {
    const m = String(v ?? "").trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
    if (!m) continue;
    if (sample === null) sample = String(v).trim();
    if (+m[1] > 12) firstOver12 = true;
    if (+m[2] > 12) secondOver12 = true;
  }

  if (firstOver12 && secondOver12) {
    // Both positions exceed 12 somewhere, so no single ordering fits the file.
    return {
      order: "dmy",
      certain: false,
      reason: "This file has dates that cannot all share one day/month order.",
      example: sample,
    };
  }
  if (firstOver12) {
    return { order: "dmy", certain: true, reason: "A first component above 12 can only be a day." };
  }
  if (secondOver12) {
    return { order: "mdy", certain: true, reason: "A second component above 12 can only be a day." };
  }
  if (sample === null) {
    return { order: "dmy", certain: true, reason: "No ambiguous dates in this file." };
  }
  return {
    order: "dmy",
    certain: false,
    reason: "Every date in this file reads either way. Confirm the order.",
    example: sample,
  };
}

/** How a given cell would read under an ordering — for the confirmation prompt. */
export function describeDate(raw: string, order: DateOrder): string {
  const parsed = parseDate(raw, order);
  if (!parsed) return "not a date";
  const [y, m, d] = parsed.split("-").map(Number);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${d} ${months[m - 1]} ${y}`;
}
