/**
 * 26AS / AIS / TIS upload validation. Not a raw parser of the portal's own
 * PDF/JSON/Excel — AIS's own JSON download is PAN+DOB password protected on
 * top of having no published byte-level schema this session could confirm,
 * and 26AS's PDF has no machine-readable export at all — so this asks for a
 * NORMALIZED CSV shape built from the columns Form 26AS Part A / AIS's
 * TDS-TCS Information part are independently confirmed to carry (Deductor
 * Name, Deductor TAN, Section, Transaction Date, Amount Paid/Credited, Tax
 * Deducted, Tax Deposited, Status of Booking) — the same "normalized CSV,
 * not a raw file parser" choice this app already made for GSTR-2B
 * (lib/csv/gstr2b-import.ts) and bank statements (lib/csv/bank-import.ts).
 * See supabase/migrations/0148_income_tax_statement_match.sql's header for
 * the sources checked.
 *
 * TIS rows are a different shape (category-aggregated, usually no
 * per-deductor TAN at all — confirmed by a deliberately skeptical second
 * search, since "AIS/TIS are the same shape" is the wrong-sounding obvious
 * answer) — so a TIS upload does not require a TAN column to be filled in;
 * 26AS and AIS uploads do, since a TAN-less row can never enter the match.
 */
import { parseAmount, parseDate, type DateOrder } from "@/lib/csv/coerce";

export type StatementCsvRow = Record<string, string>;
export type StatementSource = "26as" | "ais" | "tis";
export type TransactionType = "tds" | "tcs" | "other";

export type ParsedStatementLine = {
  deductor_tan: string | null;
  deductor_name: string | null;
  section_code: string | null;
  information_category: string | null;
  transaction_type: TransactionType;
  transaction_date: string | null;
  amount_paid_credited: number;
  tax_deducted: number;
  tax_deposited: number;
  status_of_booking: string | null;
};

export type RowResult = {
  rowNumber: number;
  raw: StatementCsvRow;
  data: ParsedStatementLine | null;
  issues: string[];
};

const COLUMNS = {
  tan: "deductor tan",
  name: "deductor name",
  section: "section",
  category: "information category",
  type: "transaction type",
  date: "transaction date",
  amountPaid: "amount paid/credited",
  taxDeducted: "tax deducted",
  taxDeposited: "tax deposited",
  status: "status of booking",
};

// Mirrors app_private.is_valid_tan's structural check exactly: 4 letters,
// 5 digits, 1 letter.
const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

function pick(row: StatementCsvRow, header: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header) return (v ?? "").trim();
  }
  return "";
}

function parseTransactionType(raw: string): TransactionType | null {
  const s = raw.trim().toLowerCase();
  if (["tds", "194", ""].includes(s)) return s === "" ? null : "tds";
  if (s === "tcs" || s === "206c") return "tcs";
  if (s === "other" || s === "sft" || s === "info") return "other";
  return null;
}

export function buildStatementPreview(
  rawRows: StatementCsvRow[],
  source: StatementSource,
  dateOrder: DateOrder
): RowResult[] {
  return rawRows.map((raw, i) => {
    const rowNumber = i + 2;
    const issues: string[] = [];

    const tanRaw = pick(raw, COLUMNS.tan).toUpperCase().replace(/\s/g, "");
    let deductor_tan: string | null = null;
    if (!tanRaw) {
      // TIS is genuinely category-aggregated and usually carries no
      // per-deductor TAN at all — not an error for that source. 26AS and
      // AIS rows without a TAN can never enter the deductor-keyed match, so
      // it is required for those.
      if (source !== "tis") {
        issues.push("Deductor TAN is required for a 26AS/AIS upload — a row without one can never be matched.");
      }
    } else if (!TAN_PATTERN.test(tanRaw)) {
      issues.push(`"${tanRaw}" doesn't match the TAN format (4 letters, 5 digits, 1 letter).`);
    } else {
      deductor_tan = tanRaw;
    }

    const deductor_name = pick(raw, COLUMNS.name) || null;

    const typeRaw = pick(raw, COLUMNS.type);
    const transaction_type = typeRaw ? parseTransactionType(typeRaw) : "tds";
    if (typeRaw && !transaction_type) {
      issues.push(`"${typeRaw}" — Transaction Type must be TDS, TCS or Other.`);
    }

    const dateRaw = pick(raw, COLUMNS.date);
    const transaction_date = dateRaw ? parseDate(dateRaw, dateOrder) : null;
    if (dateRaw && !transaction_date) {
      issues.push(`"${dateRaw}" is not a valid date.`);
    }

    const amounts: Record<"amountPaid" | "taxDeducted" | "taxDeposited", number> = {
      amountPaid: 0,
      taxDeducted: 0,
      taxDeposited: 0,
    };
    for (const key of ["amountPaid", "taxDeducted", "taxDeposited"] as const) {
      const colRaw = pick(raw, COLUMNS[key]);
      if (!colRaw) continue;
      const parsed = parseAmount(colRaw);
      if (parsed === null) {
        issues.push(`"${colRaw}" in ${key === "amountPaid" ? "Amount Paid/Credited" : key} is not a number.`);
      } else {
        amounts[key] = Math.abs(parsed);
      }
    }
    // Falls back to Tax Deducted when the file has no separate Tax
    // Deposited column — some AIS exports do not split the two — never
    // guessed the other way around, since deducted-but-not-deposited is a
    // real, meaningful state (Status of Booking = U, Unmatched).
    const taxDeposited = pick(raw, COLUMNS.taxDeposited) ? amounts.taxDeposited : amounts.taxDeducted;

    if (issues.length) return { rowNumber, raw, data: null, issues };

    return {
      rowNumber,
      raw,
      issues: [],
      data: {
        deductor_tan,
        deductor_name,
        section_code: pick(raw, COLUMNS.section) || null,
        information_category: pick(raw, COLUMNS.category) || null,
        transaction_type: (transaction_type ?? "tds") as TransactionType,
        transaction_date,
        amount_paid_credited: amounts.amountPaid,
        tax_deducted: amounts.taxDeducted,
        tax_deposited: taxDeposited,
        status_of_booking: pick(raw, COLUMNS.status) || null,
      },
    };
  });
}
