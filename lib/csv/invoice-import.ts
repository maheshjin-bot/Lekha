/**
 * Item-level sales/purchase CSV validation — one row per invoice line, rows
 * sharing an Invoice Ref become one invoice, exactly like voucher-import.ts's
 * Voucher Ref grouping (same F-05 lesson: a group must agree with itself
 * before anything is written, not just each row individually).
 *
 * Deliberately mirrors what InvoiceForm actually submits — item_id/quantity/
 * rate per line, one party and one trading ledger per invoice — so a CSV row
 * means the same thing typing it into the form does. GST/TCS are computed
 * server-side by create_invoice itself, exactly as they are for a manually
 * entered invoice; this file never computes tax, only validates and groups.
 */
import { normalizeName } from "@/lib/csv/normalize";
import { parseAmount, parseDate, type DateOrder } from "@/lib/csv/coerce";

export type InvoiceCsvRow = Record<string, string>;

export const INVOICE_TYPES = ["sales", "purchase", "credit_note", "debit_note"] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

const PARTY_ROLES: Record<InvoiceType, string[]> = {
  sales: ["debtor", "cash_bank"],
  purchase: ["creditor", "cash_bank"],
  credit_note: ["debtor", "cash_bank"],
  debit_note: ["creditor", "cash_bank"],
};
const TRADING_ROLE: Record<InvoiceType, "income" | "expense"> = {
  sales: "income",
  purchase: "expense",
  credit_note: "income",
  debit_note: "expense",
};

export type Item = { id: string; code: string | null; name: string };
export type Ledger = { id: string; name: string; ledger_role: string; state_code: string | null };

export type ImportContext = {
  items: Item[];
  ledgers: Ledger[];
  dateOrder: DateOrder;
  lockDate: string | null;
  branchId: string;
  godownId: string | null;
};

export type RowIssue = { field?: string; message: string; suggestion?: string };

export type ParsedLine = {
  rowNumber: number;
  groupId: string;
  date: string;
  voucherType: InvoiceType;
  partyLedgerId: string;
  tradingLedgerId: string;
  itemId: string;
  quantity: number;
  rate: number;
  description: string | null;
  reference: string | null;
  placeOfSupply: string | null;
};

export type RowResult = {
  rowNumber: number;
  raw: InvoiceCsvRow;
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

const COLUMNS = {
  group: "invoice ref",
  date: "date",
  type: "type",
  party: "party",
  trading: "trading ledger",
  item: "item",
  quantity: "quantity",
  rate: "rate",
  description: "description",
  reference: "reference",
  placeOfSupply: "place of supply",
};

function pick(row: InvoiceCsvRow, header: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header) return (v ?? "").trim();
  }
  return "";
}

function matchByName<T extends { name: string }>(name: string, pool: T[]): T | null {
  const target = normalizeName(name);
  if (!target) return null;
  const exact = pool.find((p) => normalizeName(p.name) === target);
  if (exact) return exact;
  return pool.find((p) => {
    const n = normalizeName(p.name);
    return n.startsWith(target) || target.startsWith(n) || n.includes(target);
  }) ?? null;
}

function matchItem(raw: string, items: Item[]): Item | null {
  const byCode = items.find((it) => it.code && it.code.toLowerCase() === raw.trim().toLowerCase());
  return byCode ?? matchByName(raw, items);
}

export function buildInvoicePreview(rawRows: InvoiceCsvRow[], ctx: ImportContext): ImportPreview {
  const rows: RowResult[] = rawRows.map((raw, i) => {
    const rowNumber = i + 2;
    const issues: RowIssue[] = [];

    const groupId = pick(raw, COLUMNS.group);
    if (!groupId) issues.push({ field: "Invoice Ref", message: "Required — it groups the lines of one invoice." });

    const dateRaw = pick(raw, COLUMNS.date);
    const date = parseDate(dateRaw, ctx.dateOrder);
    if (!date) {
      issues.push({ field: "Date", message: dateRaw ? `"${dateRaw}" is not a valid date.` : "Required." });
    } else if (ctx.lockDate && date <= ctx.lockDate) {
      issues.push({ field: "Date", message: `The books are locked on or before ${ctx.lockDate}; this row cannot be posted.` });
    }

    const typeRaw = pick(raw, COLUMNS.type).toLowerCase().replace(/\s+/g, "_");
    const voucherType = (INVOICE_TYPES as readonly string[]).includes(typeRaw) ? (typeRaw as InvoiceType) : null;
    if (!voucherType) {
      issues.push({
        field: "Type",
        message: typeRaw ? `"${pick(raw, COLUMNS.type)}" is not an invoice type.` : "Required.",
        suggestion: "Sales, Purchase, Credit Note, Debit Note",
      });
    }

    const partyRaw = pick(raw, COLUMNS.party);
    const eligibleParties = voucherType
      ? ctx.ledgers.filter((l) => PARTY_ROLES[voucherType].includes(l.ledger_role))
      : ctx.ledgers;
    const party = partyRaw ? matchByName(partyRaw, eligibleParties) : null;
    if (!party) {
      issues.push({ field: "Party", message: partyRaw ? `No matching customer/supplier ledger named "${partyRaw}".` : "Required." });
    }

    // Trading ledger is optional in the file — auto-picked when there's
    // exactly one candidate for this invoice type, same as a company with
    // one Sales Account never has to think about it in the form either.
    const tradingRaw = pick(raw, COLUMNS.trading);
    let tradingLedgerId = "";
    if (voucherType) {
      const eligibleTrading = ctx.ledgers.filter((l) => l.ledger_role === TRADING_ROLE[voucherType]);
      if (tradingRaw) {
        const m = matchByName(tradingRaw, eligibleTrading);
        if (m) tradingLedgerId = m.id;
        else issues.push({ field: "Trading Ledger", message: `No matching ledger named "${tradingRaw}".` });
      } else if (eligibleTrading.length === 1) {
        tradingLedgerId = eligibleTrading[0].id;
      } else if (eligibleTrading.length === 0) {
        issues.push({ field: "Trading Ledger", message: `No ${TRADING_ROLE[voucherType]} ledger exists to post this against.` });
      } else {
        issues.push({
          field: "Trading Ledger",
          message: "More than one candidate ledger — name one explicitly.",
          suggestion: eligibleTrading.map((l) => l.name).join(", "),
        });
      }
    }

    const itemRaw = pick(raw, COLUMNS.item);
    const item = itemRaw ? matchItem(itemRaw, ctx.items) : null;
    if (!item) issues.push({ field: "Item", message: itemRaw ? `No item named or coded "${itemRaw}".` : "Required." });

    const quantity = parseAmount(pick(raw, COLUMNS.quantity));
    if (quantity === null) issues.push({ field: "Quantity", message: "Not a number." });
    else if (quantity <= 0) issues.push({ field: "Quantity", message: "Must be greater than zero." });

    const rate = parseAmount(pick(raw, COLUMNS.rate));
    if (pick(raw, COLUMNS.rate) && rate === null) issues.push({ field: "Rate", message: "Not a number." });

    const placeOfSupplyRaw = pick(raw, COLUMNS.placeOfSupply).toUpperCase();

    if (issues.length) return { rowNumber, raw, data: null, issues };

    return {
      rowNumber,
      raw,
      issues: [],
      data: {
        rowNumber,
        groupId,
        date: date!,
        voucherType: voucherType!,
        partyLedgerId: party!.id,
        tradingLedgerId,
        itemId: item!.id,
        quantity: quantity!,
        rate: rate ?? 0,
        description: pick(raw, COLUMNS.description) || null,
        reference: pick(raw, COLUMNS.reference) || null,
        placeOfSupply: placeOfSupplyRaw || null,
      },
    };
  });

  // ---- group consistency, same shape as voucher-import.ts's F-05 fix -----
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

    const dates = [...new Set(lines.map((l) => l.date))];
    if (dates.length > 1) {
      fail(`Rows disagree about the date: ${dates.join(", ")}. All lines of one invoice must share it.`);
      continue;
    }
    const types = [...new Set(lines.map((l) => l.voucherType))];
    if (types.length > 1) {
      fail(`Rows disagree about the invoice type: ${types.join(", ")}.`);
      continue;
    }
    const parties = [...new Set(lines.map((l) => l.partyLedgerId))];
    if (parties.length > 1) {
      fail("Rows disagree about the party — one invoice has one customer or supplier.");
      continue;
    }
    const trading = [...new Set(lines.map((l) => l.tradingLedgerId))];
    if (trading.length > 1) {
      fail("Rows disagree about the trading ledger.");
      continue;
    }
    const refs = [...new Set(lines.map((l) => l.reference ?? ""))];
    if (refs.length > 1) {
      fail(`Rows disagree about the reference: ${refs.map((r) => r || "(blank)").join(", ")}.`);
      continue;
    }
  }

  for (const r of rows) {
    if (r.data && failedGroups.has(r.data.groupId)) {
      r.issues.push({ message: "This invoice has a problem — see the group errors above." });
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

/** Groups the valid rows into the payload create_invoices_bulk expects. */
export function toInvoiceBulkPayload(preview: ImportPreview, ctx: ImportContext) {
  const groups = new Map<string, ParsedLine[]>();
  for (const r of preview.rows) {
    if (!r.data) continue;
    const list = groups.get(r.data.groupId) ?? [];
    list.push(r.data);
    groups.set(r.data.groupId, list);
  }

  return [...groups.entries()].map(([groupId, lines]) => ({
    group_key: groupId,
    branch_id: ctx.branchId,
    voucher_type: lines[0].voucherType,
    voucher_date: lines[0].date,
    party_ledger_id: lines[0].partyLedgerId,
    trading_ledger_id: lines[0].tradingLedgerId,
    godown_id: ctx.godownId,
    narration: lines.find((l) => l.description)?.description ?? null,
    reference_number: lines[0].reference,
    reference_date: null,
    place_of_supply: lines[0].placeOfSupply,
    items: lines.map((l) => ({
      item_id: l.itemId,
      quantity: l.quantity,
      rate: l.rate,
      description: l.description,
    })),
  }));
}
