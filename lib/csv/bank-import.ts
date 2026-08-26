/**
 * Bank statement import validation. Simpler than the voucher importer — no
 * grouping, since a statement line stands alone — but it reuses the same
 * amount and date coercion, because a bank export is exactly as likely to
 * carry Indian digit grouping and an ambiguous date order as a voucher file.
 *
 * Column layout is no longer hardcoded here. A BankFormatDef (see
 * bank-format-adapters.ts) maps whatever headers the file actually has onto
 * the canonical 5-field shape this module has always worked with, so
 * everything below is unchanged in spirit from before that layer existed.
 */
import { normalizeName } from "@/lib/csv/normalize";
import { parseAmount, parseDate, type DateOrder } from "@/lib/csv/coerce";
import { type BankFormatDef, mapRowToCanonical, computeExternalTxnId } from "@/lib/csv/bank-format-adapters";

export type BankCsvRow = Record<string, string>;

/** externalTxnId is the same fingerprint commitImport writes as bank_statement_lines.external_txn_id. */
export type ExistingLine = { externalTxnId: string | null };

export type BankRowResult = {
  rowNumber: number;
  date: string | null;
  description: string | null;
  reference: string | null;
  side: "debit" | "credit" | null;
  amount: number | null;
  issues: string[];
  /** The idempotency key this row would be inserted with — see computeExternalTxnId. */
  externalTxnId: string;
  /** Not an error — a line with this exact fingerprint is already on file. Re-importing skips it (see commitImport's upsert). */
  possibleDuplicate: boolean;
};

export function buildBankPreview(
  rawRows: BankCsvRow[],
  dateOrder: DateOrder,
  format: BankFormatDef,
  existing: ExistingLine[]
): BankRowResult[] {
  const existingIds = new Set(existing.map((e) => e.externalTxnId).filter((x): x is string => !!x));
  // Occurrence index per identical-looking (date, description, reference,
  // debit, credit) tuple within THIS file — see computeExternalTxnId for
  // why this is what makes re-uploading an identical file idempotent.
  const seenCounts = new Map<string, number>();

  return rawRows.map((raw, i) => {
    const rowNumber = i + 2;
    const issues: string[] = [];

    const canon = mapRowToCanonical(raw, format);

    const date = parseDate(canon.date, dateOrder);
    if (!date) issues.push(canon.date ? `"${canon.date}" is not a valid date.` : "Date is required.");

    const description = canon.description || null;
    const reference = canon.reference || null;

    const debitRaw = canon.debitRaw;
    const creditRaw = canon.creditRaw;
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

    const groupKey = `${date ?? ""}|${normalizeName(description)}|${normalizeName(reference)}|${(side === "debit" ? amount : 0)?.toFixed(2) ?? "0.00"}|${(side === "credit" ? amount : 0)?.toFixed(2) ?? "0.00"}`;
    const occurrenceIndex = seenCounts.get(groupKey) ?? 0;
    seenCounts.set(groupKey, occurrenceIndex + 1);

    const externalTxnId = computeExternalTxnId(
      {
        date: date ?? "",
        description: description ?? "",
        reference: reference ?? "",
        debit: side === "debit" ? (amount ?? 0) : 0,
        credit: side === "credit" ? (amount ?? 0) : 0,
      },
      occurrenceIndex
    );

    const possibleDuplicate = issues.length === 0 && existingIds.has(externalTxnId);

    return { rowNumber, date, description, reference, side, amount, issues, externalTxnId, possibleDuplicate };
  });
}
