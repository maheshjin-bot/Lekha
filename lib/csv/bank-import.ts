/**
 * Bank statement import validation. Simpler than the voucher importer — no
 * grouping, since a statement line stands alone — but it reuses the same
 * amount and date coercion, because a bank export is exactly as likely to
 * carry Indian digit grouping and an ambiguous date order as a voucher file.
 */
import { normalizeName } from "@/lib/csv/normalize";
import { parseAmount, parseDate, type DateOrder } from "@/lib/csv/coerce";

export type BankCsvRow = Record<string, string>;

export type ExistingLine = { txnDate: string; description: string | null; debit: number; credit: number };

export type BankRowResult = {
  rowNumber: number;
  date: string | null;
  description: string | null;
  reference: string | null;
  side: "debit" | "credit" | null;
  amount: number | null;
  issues: string[];
  /** Not an error — a same date/description/amount row already on file. */
  possibleDuplicate: boolean;
};

const COLUMNS = { date: "date", description: "description", reference: "reference", debit: "debit", credit: "credit" };

function pick(row: BankCsvRow, header: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header) return (v ?? "").trim();
  }
  return "";
}

export function buildBankPreview(
  rawRows: BankCsvRow[],
  dateOrder: DateOrder,
  existing: ExistingLine[]
): BankRowResult[] {
  const existingKeys = new Set(
    existing.map(
      (e) => `${e.txnDate}|${normalizeName(e.description)}|${e.debit.toFixed(2)}|${e.credit.toFixed(2)}`
    )
  );

  return rawRows.map((raw, i) => {
    const rowNumber = i + 2;
    const issues: string[] = [];

    const dateRaw = pick(raw, COLUMNS.date);
    const date = parseDate(dateRaw, dateOrder);
    if (!date) issues.push(dateRaw ? `"${dateRaw}" is not a valid date.` : "Date is required.");

    const description = pick(raw, COLUMNS.description) || null;
    const reference = pick(raw, COLUMNS.reference) || null;

    const debitRaw = pick(raw, COLUMNS.debit);
    const creditRaw = pick(raw, COLUMNS.credit);
    const debit = debitRaw ? parseAmount(debitRaw) : null;
    const credit = creditRaw ? parseAmount(creditRaw) : null;

    let side: "debit" | "credit" | null = null;
    let amount: number | null = null;

    if ((debitRaw && debit === null) || (creditRaw && credit === null)) {
      issues.push("Amount is not a number.");
    } else if (debit && credit) {
      issues.push("A line cannot have both a debit and a credit amount.");
    } else if (debit && debit > 0) {
      side = "debit";
      amount = debit;
    } else if (credit && credit > 0) {
      side = "credit";
      amount = credit;
    } else {
      issues.push("Either a debit or a credit amount is required.");
    }

    const possibleDuplicate =
      date !== null &&
      amount !== null &&
      side !== null &&
      existingKeys.has(
        `${date}|${normalizeName(description)}|${side === "debit" ? amount.toFixed(2) : "0.00"}|${side === "credit" ? amount.toFixed(2) : "0.00"}`
      );

    return { rowNumber, date, description, reference, side, amount, issues, possibleDuplicate };
  });
}
