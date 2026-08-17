/**
 * Voucher CSV validation.
 *
 * Three stages, because the mistakes are of three kinds: a cell that will not
 * parse, a row that is internally inconsistent, and a *group* of rows that
 * disagree with each other. HISAB's importer only checked the first two, which
 * is how F-05 got through — rows sharing a voucher reference could disagree
 * about the date and the first one silently won.
 *
 * The rule throughout: never accept something that will produce wrong data,
 * and never reject something a human could obviously fix. Anything in between
 * is surfaced with a suggestion rather than a refusal.
 */
import { normalizeName } from "@/lib/csv/normalize";
import { parseAmount, parseDate, type DateOrder } from "@/lib/csv/coerce";

export const VOUCHER_TYPES = [
  "receipt", "payment", "contra", "journal", "sales", "purchase",
  "credit_note", "debit_note",
] as const;

export type VoucherCsvRow = Record<string, string>;

export type ImportContext = {
  ledgers: { id: string; name: string }[];
  dateOrder: DateOrder;
  /** Company lock date, if any. Rows on or before it cannot be posted. */
  lockDate: string | null;
  branchId: string;
};

export type RowIssue = {
  field?: string;
  message: string;
  /** A value the user can accept with one click, where one exists. */
  suggestion?: string;
};

export type ParsedLine = {
  rowNumber: number;
  groupId: string;
  date: string;
  voucherType: string;
  ledgerId: string;
  side: "dr" | "cr";
  amount: number;
  narration: string | null;
  reference: string | null;
};

export type RowResult = {
  rowNumber: number;
  raw: VoucherCsvRow;
  data: ParsedLine | null;
  issues: RowIssue[];
};

export type GroupIssue = { groupId: string; rowNumbers: number[]; message: string };

export type ImportPreview = {
  rows: RowResult[];
  groupIssues: GroupIssue[];
  validGroupCount: number;
  validRowCount: number;
  invalidRowCount: number;
};

/** Header names, matched case- and space-insensitively. */
const COLUMNS = {
  group: "voucher ref",
  date: "date",
  type: "voucher type",
  ledger: "ledger",
  side: "dr/cr",
  amount: "amount",
  narration: "narration",
  // F-07: HISAB had no such column and hardcoded reference_number to null, so
  // importing a purchase book lost every supplier bill number — the one field
  // that makes an AP ledger auditable.
  reference: "reference",
  referenceDate: "reference date",
};

function pick(row: VoucherCsvRow, header: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header) return (v ?? "").trim();
  }
  return "";
}

/**
 * Closest ledger by normalised name, then by a cheap edit-distance ceiling.
 *
 * HISAB matched on trim+lower only, so "A. B. Traders" and "A B Traders" were
 * different ledgers and a 2,000-row import became a manual reconciliation.
 */
function matchLedger(
  name: string,
  ledgers: ImportContext["ledgers"]
): { id: string } | { suggestion: string | null } {
  const target = normalizeName(name);
  if (!target) return { suggestion: null };

  const exact = ledgers.find((l) => normalizeName(l.name) === target);
  if (exact) return { id: exact.id };

  // Prefix or containment covers most real near-misses ("HDFC" vs "HDFC Bank").
  const near = ledgers.find((l) => {
    const n = normalizeName(l.name);
    return n.startsWith(target) || target.startsWith(n) || n.includes(target);
  });
  return { suggestion: near?.name ?? null };
}

export function buildPreview(
  rawRows: VoucherCsvRow[],
  ctx: ImportContext
): ImportPreview {
  const rows: RowResult[] = rawRows.map((raw, i) => {
    const rowNumber = i + 2; // header occupies row 1
    const issues: RowIssue[] = [];

    const groupId = pick(raw, COLUMNS.group);
    if (!groupId) issues.push({ field: "Voucher Ref", message: "Required — it groups the lines of one voucher." });

    const dateRaw = pick(raw, COLUMNS.date);
    const date = parseDate(dateRaw, ctx.dateOrder);
    if (!date) {
      issues.push({ field: "Date", message: dateRaw ? `"${dateRaw}" is not a valid date.` : "Required." });
    } else if (ctx.lockDate && date <= ctx.lockDate) {
      // F-10: HISAB let these through validation and failed at commit, so the
      // preview promised rows it could not deliver.
      issues.push({
        field: "Date",
        message: `The books are locked on or before ${ctx.lockDate}; this row cannot be posted.`,
      });
    }

    const typeRaw = pick(raw, COLUMNS.type).toLowerCase().replace(/\s+/g, "_");
    const voucherType = (VOUCHER_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : "";
    if (!voucherType) {
      issues.push({
        field: "Voucher Type",
        message: typeRaw ? `"${pick(raw, COLUMNS.type)}" is not a voucher type.` : "Required.",
        suggestion: VOUCHER_TYPES.join(", "),
      });
    }

    const ledgerRaw = pick(raw, COLUMNS.ledger);
    const match = ledgerRaw ? matchLedger(ledgerRaw, ctx.ledgers) : { suggestion: null };
    const ledgerId = "id" in match ? match.id : "";
    if (!ledgerId) {
      issues.push({
        field: "Ledger",
        message: ledgerRaw ? `No ledger named "${ledgerRaw}".` : "Required.",
        suggestion: "suggestion" in match && match.suggestion ? match.suggestion : undefined,
      });
    }

    const sideRaw = pick(raw, COLUMNS.side).toLowerCase();
    const side = sideRaw === "dr" || sideRaw === "debit" ? "dr"
      : sideRaw === "cr" || sideRaw === "credit" ? "cr" : "";
    if (!side) issues.push({ field: "Dr/Cr", message: 'Must be "Dr" or "Cr".' });

    const amount = parseAmount(pick(raw, COLUMNS.amount));
    if (amount === null) {
      issues.push({ field: "Amount", message: "Not a number." });
    } else if (amount <= 0) {
      // The Dr/Cr column carries the direction; a negative amount would mean
      // the same thing twice and the two could disagree.
      issues.push({ field: "Amount", message: "Must be greater than zero — use the Dr/Cr column for direction." });
    }

    if (issues.length) return { rowNumber, raw, data: null, issues };

    return {
      rowNumber,
      raw,
      issues: [],
      data: {
        rowNumber,
        groupId,
        date: date!,
        voucherType,
        ledgerId,
        side: side as "dr" | "cr",
        amount: amount!,
        narration: pick(raw, COLUMNS.narration) || null,
        reference: pick(raw, COLUMNS.reference) || null,
      },
    };
  });

  // -------------------------------------------------------------------------
  // Stage three: the group
  // -------------------------------------------------------------------------
  const groups = new Map<string, ParsedLine[]>();
  for (const r of rows) {
    if (!r.data) continue;
    const list = groups.get(r.data.groupId) ?? [];
    list.push(r.data);
    groups.set(r.data.groupId, list);
  }

  const groupIssues: GroupIssue[] = [];
  const failedGroups = new Set<string>();

  for (const [groupId, lines] of groups) {
    const rowNumbers = lines.map((l) => l.rowNumber);
    const fail = (message: string) => {
      groupIssues.push({ groupId, rowNumbers, message });
      failedGroups.add(groupId);
    };

    if (lines.length < 2) {
      fail("A voucher needs at least two lines.");
      continue;
    }

    // F-05. HISAB took the first row's date and type for the whole group and
    // discarded the rest, so two files both using "PMT-0001" merged into one
    // voucher and a typo'd date on line 2 imported under line 1's date — with
    // the preview reporting every row valid.
    const dates = [...new Set(lines.map((l) => l.date))];
    if (dates.length > 1) {
      fail(`Rows disagree about the date: ${dates.join(", ")}. All lines of one voucher must share it.`);
      continue;
    }
    const types = [...new Set(lines.map((l) => l.voucherType))];
    if (types.length > 1) {
      fail(`Rows disagree about the voucher type: ${types.join(", ")}.`);
      continue;
    }
    const refs = [...new Set(lines.map((l) => l.reference ?? ""))];
    if (refs.length > 1) {
      fail(`Rows disagree about the reference: ${refs.map((r) => r || "(blank)").join(", ")}.`);
      continue;
    }

    // Compared in integer paise. Summing rupees as floats is how a group that
    // balances on screen gets rejected by the database.
    const paise = (n: number) => Math.round(n * 100);
    const dr = lines.filter((l) => l.side === "dr").reduce((t, l) => t + paise(l.amount), 0);
    const cr = lines.filter((l) => l.side === "cr").reduce((t, l) => t + paise(l.amount), 0);
    if (dr !== cr) {
      fail(`Debit ${(dr / 100).toFixed(2)} does not equal credit ${(cr / 100).toFixed(2)}.`);
    }
  }

  // A group-level failure invalidates its rows, so "valid" means the same
  // thing at every stage.
  for (const r of rows) {
    if (r.data && failedGroups.has(r.data.groupId)) {
      r.issues.push({ message: "This voucher has a problem — see the group errors above." });
      r.data = null;
    }
  }

  const validRowCount = rows.filter((r) => r.data !== null).length;

  return {
    rows,
    groupIssues,
    validGroupCount: groups.size - failedGroups.size,
    validRowCount,
    invalidRowCount: rows.length - validRowCount,
  };
}

/** Groups the valid rows into the payload create_vouchers_bulk expects. */
export function toBulkPayload(preview: ImportPreview, branchId: string) {
  const groups = new Map<string, ParsedLine[]>();
  for (const r of preview.rows) {
    if (!r.data) continue;
    const list = groups.get(r.data.groupId) ?? [];
    list.push(r.data);
    groups.set(r.data.groupId, list);
  }

  return [...groups.entries()].map(([groupId, lines]) => ({
    group_key: groupId,
    branch_id: branchId,
    voucher_type: lines[0].voucherType,
    voucher_date: lines[0].date,
    narration: lines.find((l) => l.narration)?.narration ?? null,
    reference_number: lines[0].reference,
    lines: lines.map((l, i) => ({
      ledger_id: l.ledgerId,
      debit_amount: l.side === "dr" ? l.amount : 0,
      credit_amount: l.side === "cr" ? l.amount : 0,
      narration: l.narration,
      line_order: i,
    })),
  }));
}
