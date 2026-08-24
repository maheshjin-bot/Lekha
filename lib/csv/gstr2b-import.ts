/**
 * GSTR-2B upload validation. Not a raw GSTN JSON/Excel parser — this session
 * could not confirm the government's byte-level field spec with confidence
 * (see supabase/migrations/0120_gstr2b_match.sql's header for the sources
 * checked), so this asks for a NORMALIZED CSV shape built from the columns
 * every independently-checked source agrees the downloaded B2B/CDNR sheets
 * carry (Supplier GSTIN, Trade Name, Invoice Number, Invoice Date, Taxable
 * Value, CGST/SGST/IGST, ITC Available), the same "normalized CSV, not a
 * raw file parser" choice this app already made for bank statements
 * (lib/csv/bank-import.ts). Reuses the same amount/date coercion as every
 * other importer in this app.
 *
 * SIGN CONVENTION: taxable value and every tax figure are stored NEGATIVE
 * for a credit note line, regardless of how the source file encoded the
 * sign — deterministic here rather than trusting an external file's own
 * convention, and it matches get_gst_input_register's own documented
 * choice for debit notes (0035) exactly, so the two sides sum consistently
 * once matched.
 */
import { normalizeName } from "@/lib/csv/normalize";
import { parseAmount, parseDate, type DateOrder } from "@/lib/csv/coerce";

export type Gstr2bCsvRow = Record<string, string>;

export type DocumentType = "invoice" | "credit_note";
export type ItcAvailability = "available" | "not_available" | "reversal" | "rejected";

export type ParsedGstr2bLine = {
  gstr2b_table: string | null;
  document_type: DocumentType;
  supplier_gstin: string;
  supplier_name: string | null;
  invoice_number: string;
  invoice_date: string;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  invoice_value: number;
  itc_availability: ItcAvailability;
  itc_reason: string | null;
};

export type RowResult = {
  rowNumber: number;
  raw: Gstr2bCsvRow;
  data: ParsedGstr2bLine | null;
  issues: string[];
};

const COLUMNS = {
  table: "gstr-2b table",
  docType: "document type",
  gstin: "supplier gstin",
  name: "supplier name",
  invoiceNumber: "invoice number",
  invoiceDate: "invoice date",
  taxable: "taxable value",
  cgst: "cgst",
  sgst: "sgst",
  igst: "igst",
  cess: "cess",
  itcAvailability: "itc availability",
  reason: "reason",
};

// Mirrors app_private.is_valid_gstin's structural check (the checksum digit
// itself is not re-verified client-side — the server-side check constraint
// on gstr2b_lines.supplier_gstin is the real gate, this just short-circuits
// an obviously-mistyped GSTIN before a round trip).
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function pick(row: Gstr2bCsvRow, header: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header) return (v ?? "").trim();
  }
  return "";
}

function parseDocumentType(raw: string): DocumentType | null {
  const s = raw.trim().toLowerCase();
  if (["invoice", "inv", "b2b", "b2ba"].includes(s)) return "invoice";
  if (["credit note", "credit_note", "creditnote", "cdnr", "cdnra", "cn"].includes(s)) return "credit_note";
  return null;
}

function parseItcAvailability(raw: string): ItcAvailability | null {
  const s = raw.trim().toLowerCase();
  if (["available", "yes", "y"].includes(s)) return "available";
  if (["not available", "not_available", "no", "n"].includes(s)) return "not_available";
  if (s === "reversal") return "reversal";
  if (s === "rejected") return "rejected";
  return null;
}

export function buildGstr2bPreview(rawRows: Gstr2bCsvRow[], dateOrder: DateOrder): RowResult[] {
  return rawRows.map((raw, i) => {
    const rowNumber = i + 2;
    const issues: string[] = [];

    const docTypeRaw = pick(raw, COLUMNS.docType);
    const document_type = docTypeRaw ? parseDocumentType(docTypeRaw) : null;
    if (!document_type) {
      issues.push(
        docTypeRaw
          ? `"${docTypeRaw}" — Document Type must be Invoice or Credit Note.`
          : "Document Type is required (Invoice or Credit Note)."
      );
    }

    const gstinRaw = pick(raw, COLUMNS.gstin).toUpperCase().replace(/\s/g, "");
    if (!gstinRaw) {
      issues.push("Supplier GSTIN is required.");
    } else if (!GSTIN_PATTERN.test(gstinRaw)) {
      issues.push(`"${gstinRaw}" doesn't match the GSTIN format.`);
    }

    const supplier_name = pick(raw, COLUMNS.name) || null;

    const invoice_number = pick(raw, COLUMNS.invoiceNumber);
    if (!invoice_number) issues.push("Invoice Number is required.");

    const dateRaw = pick(raw, COLUMNS.invoiceDate);
    const invoice_date = parseDate(dateRaw, dateOrder);
    if (!invoice_date) issues.push(dateRaw ? `"${dateRaw}" is not a valid date.` : "Invoice Date is required.");

    const amounts: Record<"taxable" | "cgst" | "sgst" | "igst" | "cess", number> = {
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      cess: 0,
    };
    for (const key of ["taxable", "cgst", "sgst", "igst", "cess"] as const) {
      const colRaw = pick(raw, COLUMNS[key]);
      if (!colRaw) continue;
      const parsed = parseAmount(colRaw);
      if (parsed === null) {
        issues.push(`"${colRaw}" in ${key === "taxable" ? "Taxable Value" : key.toUpperCase()} is not a number.`);
      } else {
        amounts[key] = Math.abs(parsed);
      }
    }

    const itcRaw = pick(raw, COLUMNS.itcAvailability);
    const itc_availability = itcRaw ? parseItcAvailability(itcRaw) : null;
    if (!itc_availability) {
      issues.push(
        itcRaw
          ? `"${itcRaw}" — ITC Availability must be Available, Not Available, Reversal or Rejected.`
          : "ITC Availability is required."
      );
    }

    if (issues.length) return { rowNumber, raw, data: null, issues };

    // Sign applied deterministically by document_type — see file header.
    const sign = document_type === "credit_note" ? -1 : 1;
    const taxable_value = sign * amounts.taxable;
    const cgst = sign * amounts.cgst;
    const sgst = sign * amounts.sgst;
    const igst = sign * amounts.igst;
    const cess = sign * amounts.cess;

    return {
      rowNumber,
      raw,
      issues: [],
      data: {
        gstr2b_table: pick(raw, COLUMNS.table).toUpperCase() || null,
        document_type: document_type!,
        supplier_gstin: gstinRaw,
        supplier_name,
        invoice_number,
        invoice_date: invoice_date!,
        taxable_value,
        cgst,
        sgst,
        igst,
        cess,
        invoice_value: taxable_value + cgst + sgst + igst + cess,
        itc_availability: itc_availability!,
        itc_reason: pick(raw, COLUMNS.reason) || null,
      },
    };
  });
}

/** For the "supplier appears more than once with the same invoice number"
 * sanity nudge shown in the preview — not an error, just a heads-up, since a
 * genuine amendment (B2BA) legitimately repeats the same invoice number. */
export function duplicateKey(line: ParsedGstr2bLine): string {
  return `${line.supplier_gstin}|${normalizeName(line.invoice_number)}`;
}
