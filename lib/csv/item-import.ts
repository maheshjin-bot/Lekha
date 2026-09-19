/**
 * Item master CSV validation. One row per item — no grouping, unlike the
 * voucher/invoice importers, since an item never spans multiple lines.
 *
 * Mirrors ItemManager's own insert exactly (same fields, same defaults —
 * a service silently carries no stock, GST rate defaults to 0) so a CSV row
 * produces the identical row a human filling in the form would.
 */
import { normalizeName } from "@/lib/csv/normalize";
import { parseAmount } from "@/lib/csv/coerce";

export type ItemCsvRow = Record<string, string>;

export type ImportContext = {
  uoms: { code: string; name: string }[];
  tcsSections: { section_code: string }[];
  /** Names already in the company's item list — flagged, not blocked. */
  existingNames: string[];
  /**
   * 2210: needed only to resolve an "Opening Godown" column when the company
   * has more than one godown and a row carries a positive opening quantity —
   * with zero or one godown there's nowhere else the opening could sit, so
   * this list being empty or singular never blocks a row.
   */
  godowns: { id: string; name: string }[];
};

export type RowIssue = { field?: string; message: string; suggestion?: string };

export type ParsedItem = {
  name: string;
  item_type: "goods" | "service";
  hsn_sac: string | null;
  uom: string;
  maintain_stock: boolean;
  opening_quantity: number;
  opening_value: number;
  /** 2210 — see ImportContext.godowns. */
  opening_godown_id: string | null;
  sale_rate: number | null;
  purchase_rate: number | null;
  gst_rate_percent: number;
  default_tcs_section: string | null;
};

export type RowResult = {
  rowNumber: number;
  raw: ItemCsvRow;
  data: ParsedItem | null;
  issues: RowIssue[];
  /** Same normalised name as an existing item or an earlier row — not an error. */
  possibleDuplicate: boolean;
};

const COLUMNS = {
  name: "name",
  type: "type",
  hsn: "hsn/sac",
  uom: "unit",
  openingQty: "opening qty",
  openingValue: "opening value",
  openingGodown: "opening godown",
  saleRate: "sale rate",
  purchaseRate: "purchase rate",
  gstRate: "gst rate",
  tcs: "tcs section",
};

function pick(row: ItemCsvRow, header: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header) return (v ?? "").trim();
  }
  return "";
}

export function buildItemPreview(rawRows: ItemCsvRow[], ctx: ImportContext): RowResult[] {
  const seenNames = new Set(ctx.existingNames.map((n) => normalizeName(n)));
  const fileNames = new Set<string>();

  return rawRows.map((raw, i) => {
    const rowNumber = i + 2;
    const issues: RowIssue[] = [];

    const name = pick(raw, COLUMNS.name);
    if (!name) issues.push({ field: "Name", message: "Required." });

    const typeRaw = pick(raw, COLUMNS.type).toLowerCase();
    const item_type: "goods" | "service" =
      typeRaw === "service" ? "service" : "goods"; // blank/"goods"/anything else defaults to goods
    if (typeRaw && typeRaw !== "goods" && typeRaw !== "service") {
      issues.push({ field: "Type", message: `"${pick(raw, COLUMNS.type)}" — must be Goods or Service.`, suggestion: "Goods" });
    }

    const hsnRaw = pick(raw, COLUMNS.hsn);
    if (hsnRaw && !/^[0-9]{4,8}$/.test(hsnRaw)) {
      issues.push({ field: "HSN/SAC", message: "Must be 4–8 digits." });
    }

    const uomRaw = pick(raw, COLUMNS.uom) || "NOS";
    const uomMatch = ctx.uoms.find((u) => u.code.toLowerCase() === uomRaw.toLowerCase());
    const uom = uomMatch?.code ?? "";
    if (!uomMatch) {
      issues.push({
        field: "Unit",
        message: `"${uomRaw}" is not a known unit code.`,
        suggestion: ctx.uoms.slice(0, 8).map((u) => u.code).join(", "),
      });
    }

    const openingQty = item_type === "service" ? 0 : parseAmount(pick(raw, COLUMNS.openingQty)) ?? 0;
    const openingValue = item_type === "service" ? 0 : parseAmount(pick(raw, COLUMNS.openingValue)) ?? 0;
    if (item_type === "goods" && pick(raw, COLUMNS.openingQty) && openingQty === null) {
      issues.push({ field: "Opening Qty", message: "Not a number." });
    }

    // 2210: with zero or one godown there's nothing to disambiguate — the
    // database's own "company's only godown" fallback already places it
    // correctly. With two or more AND a real opening quantity, leaving this
    // blank is exactly what used to make an item show its full value
    // company-wide and zero in every single per-godown report.
    let opening_godown_id: string | null = null;
    if (item_type === "goods" && openingQty > 0 && ctx.godowns.length > 1) {
      const godownRaw = pick(raw, COLUMNS.openingGodown);
      const godownMatch = godownRaw
        ? ctx.godowns.find((g) => g.name.toLowerCase() === godownRaw.toLowerCase())
        : null;
      if (!godownRaw) {
        issues.push({
          field: "Opening Godown",
          message: `This company has ${ctx.godowns.length} godowns — say which one holds this item's opening quantity.`,
          suggestion: ctx.godowns.slice(0, 8).map((g) => g.name).join(", "),
        });
      } else if (!godownMatch) {
        issues.push({
          field: "Opening Godown",
          message: `"${godownRaw}" is not one of this company's godowns.`,
          suggestion: ctx.godowns.slice(0, 8).map((g) => g.name).join(", "),
        });
      } else {
        opening_godown_id = godownMatch.id;
      }
    } else if (item_type === "goods" && openingQty > 0 && ctx.godowns.length === 1) {
      opening_godown_id = ctx.godowns[0].id;
    }

    const saleRateRaw = pick(raw, COLUMNS.saleRate);
    const sale_rate = saleRateRaw ? parseAmount(saleRateRaw) : null;
    if (saleRateRaw && sale_rate === null) issues.push({ field: "Sale Rate", message: "Not a number." });

    const purchaseRateRaw = pick(raw, COLUMNS.purchaseRate);
    const purchase_rate = purchaseRateRaw ? parseAmount(purchaseRateRaw) : null;
    if (purchaseRateRaw && purchase_rate === null) issues.push({ field: "Purchase Rate", message: "Not a number." });

    const gstRaw = pick(raw, COLUMNS.gstRate);
    const gst_rate_percent = gstRaw ? parseAmount(gstRaw) ?? 0 : 0;
    if (gstRaw && parseAmount(gstRaw) === null) issues.push({ field: "GST Rate", message: "Not a number." });
    if (gst_rate_percent !== null && (gst_rate_percent < 0 || gst_rate_percent > 100)) {
      issues.push({ field: "GST Rate", message: "Must be between 0 and 100." });
    }

    const tcsRaw = pick(raw, COLUMNS.tcs);
    const tcsMatch = tcsRaw ? ctx.tcsSections.find((s) => s.section_code.toLowerCase() === tcsRaw.toLowerCase()) : null;
    if (tcsRaw && !tcsMatch) {
      issues.push({ field: "TCS Section", message: `"${tcsRaw}" is not a known TCS section.` });
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
        item_type,
        hsn_sac: hsnRaw || null,
        uom: uom || "NOS",
        maintain_stock: item_type === "goods",
        opening_quantity: openingQty ?? 0,
        opening_value: openingValue ?? 0,
        opening_godown_id,
        sale_rate,
        purchase_rate,
        gst_rate_percent: gst_rate_percent ?? 0,
        default_tcs_section: tcsMatch?.section_code ?? null,
      },
    };
  });
}
