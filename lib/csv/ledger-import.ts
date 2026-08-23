/**
 * Ledger (account) master CSV validation. One row per ledger — no grouping.
 * Mirrors LedgerManager's own insert exactly, including its PAN/Udyam format
 * checks, so a CSV row produces the identical row a human filling in the
 * form would.
 */
import { normalizeName } from "@/lib/csv/normalize";
import { parseAmount } from "@/lib/csv/coerce";

export type LedgerCsvRow = Record<string, string>;

export type ImportContext = {
  groups: { id: string; name: string; parent_group_id: string | null }[];
  tdsSections: { section_code: string }[];
  existingNames: string[];
};

export type RowIssue = { field?: string; message: string; suggestion?: string };

export type ParsedLedger = {
  name: string;
  group_id: string;
  opening_balance_amount: number;
  opening_balance_type: "debit" | "credit";
  pan: string | null;
  is_tds_deductee: boolean;
  default_tds_section: string | null;
  udyam_number: string | null;
  msme_category: string | null;
  msme_payment_days: number | null;
};

export type RowResult = {
  rowNumber: number;
  raw: LedgerCsvRow;
  data: ParsedLedger | null;
  issues: RowIssue[];
  possibleDuplicate: boolean;
};

const COLUMNS = {
  name: "name",
  group: "group",
  opening: "opening balance",
  side: "dr/cr",
  pan: "pan",
  tdsDeductee: "tds deductee",
  tdsSection: "tds section",
  udyam: "udyam number",
  msmeCategory: "msme category",
  msmeDays: "msme payment days",
};

// Mirrors app_private.is_valid_pan / is_valid_udyam exactly (LedgerManager.tsx).
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;

function pick(row: LedgerCsvRow, header: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header) return (v ?? "").trim();
  }
  return "";
}

/** Same fuzzy match voucher-import.ts uses for ledgers, applied to groups here. */
function matchGroup(
  name: string,
  groups: ImportContext["groups"]
): { id: string } | { suggestion: string | null } {
  const target = normalizeName(name);
  if (!target) return { suggestion: null };
  const exact = groups.find((g) => normalizeName(g.name) === target);
  if (exact) return { id: exact.id };
  const near = groups.find((g) => {
    const n = normalizeName(g.name);
    return n.startsWith(target) || target.startsWith(n) || n.includes(target);
  });
  return { suggestion: near?.name ?? null };
}

export function buildLedgerPreview(rawRows: LedgerCsvRow[], ctx: ImportContext): RowResult[] {
  const seenNames = new Set(ctx.existingNames.map((n) => normalizeName(n)));
  const fileNames = new Set<string>();

  return rawRows.map((raw, i) => {
    const rowNumber = i + 2;
    const issues: RowIssue[] = [];

    const name = pick(raw, COLUMNS.name);
    if (!name) issues.push({ field: "Name", message: "Required." });

    const groupRaw = pick(raw, COLUMNS.group);
    const match = groupRaw ? matchGroup(groupRaw, ctx.groups) : { suggestion: null };
    const group_id = "id" in match ? match.id : "";
    if (!group_id) {
      issues.push({
        field: "Group",
        message: groupRaw ? `No group named "${groupRaw}".` : "Required.",
        suggestion: "suggestion" in match && match.suggestion ? match.suggestion : undefined,
      });
    }

    const openingRaw = pick(raw, COLUMNS.opening);
    const opening_balance_amount = openingRaw ? parseAmount(openingRaw) ?? 0 : 0;
    if (openingRaw && parseAmount(openingRaw) === null) {
      issues.push({ field: "Opening Balance", message: "Not a number." });
    }

    const sideRaw = pick(raw, COLUMNS.side).toLowerCase();
    const opening_balance_type: "debit" | "credit" =
      sideRaw === "cr" || sideRaw === "credit" ? "credit" : "debit"; // blank defaults to debit, matching the form
    if (sideRaw && sideRaw !== "dr" && sideRaw !== "debit" && sideRaw !== "cr" && sideRaw !== "credit") {
      issues.push({ field: "Dr/Cr", message: `"${pick(raw, COLUMNS.side)}" — must be Dr or Cr.` });
    }

    const panRaw = pick(raw, COLUMNS.pan).toUpperCase();
    if (panRaw && !PAN_PATTERN.test(panRaw)) {
      issues.push({ field: "PAN", message: "Doesn't match the PAN format (5 letters, 4 digits, 1 letter)." });
    }

    const tdsDeducteeRaw = pick(raw, COLUMNS.tdsDeductee).toLowerCase();
    const is_tds_deductee = tdsDeducteeRaw === "y" || tdsDeducteeRaw === "yes" || tdsDeducteeRaw === "true";
    const tdsSectionRaw = pick(raw, COLUMNS.tdsSection);
    const tdsMatch = tdsSectionRaw
      ? ctx.tdsSections.find((s) => s.section_code.toLowerCase() === tdsSectionRaw.toLowerCase())
      : null;
    if (is_tds_deductee && tdsSectionRaw && !tdsMatch) {
      issues.push({ field: "TDS Section", message: `"${tdsSectionRaw}" is not a known TDS section.` });
    }

    const udyamRaw = pick(raw, COLUMNS.udyam).toUpperCase();
    if (udyamRaw && !UDYAM_PATTERN.test(udyamRaw)) {
      issues.push({ field: "Udyam Number", message: "Doesn't match the Udyam number format." });
    }

    const msmeDaysRaw = pick(raw, COLUMNS.msmeDays);
    const msme_payment_days = msmeDaysRaw ? Math.round(parseAmount(msmeDaysRaw) ?? NaN) : null;
    if (msmeDaysRaw && (msme_payment_days === null || Number.isNaN(msme_payment_days))) {
      issues.push({ field: "MSME Payment Days", message: "Not a number." });
    }

    const normalized = normalizeName(name);
    const possibleDuplicate = name.length > 0 && (seenNames.has(normalized) || fileNames.has(normalized));
    if (name) fileNames.add(normalized);

    if (issues.length) return { rowNumber, raw, data: null, issues, possibleDuplicate };

    return {
      rowNumber,
      raw,
      issues: [],
      possibleDuplicate,
      data: {
        name,
        group_id,
        opening_balance_amount: opening_balance_amount ?? 0,
        opening_balance_type,
        pan: panRaw || null,
        is_tds_deductee,
        default_tds_section: is_tds_deductee ? tdsMatch?.section_code ?? null : null,
        udyam_number: udyamRaw || null,
        msme_category: pick(raw, COLUMNS.msmeCategory).toLowerCase() || null,
        msme_payment_days,
      },
    };
  });
}
