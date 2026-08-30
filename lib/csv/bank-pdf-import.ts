/**
 * PDF bank-statement import — turns a text-based bank statement PDF into the
 * exact same BankCsvRow shape Papa.parse already produces from a CSV export
 * (see bank-import.ts), so the rest of the pipeline (buildBankPreview,
 * mapRowToCanonical, the reconciliation screen's commitImport upsert) needs
 * ZERO changes to accept a PDF-sourced statement. This module's only job is
 * the extraction step CSV never needed: recovering a delimited row shape
 * from a PDF that only has a visual table, not comma-separated fields.
 *
 * WHY THIS IS THE RIGHT V1 (not image OCR). Most Indian bank e-statements
 * downloaded as PDF are TEXT-based (the bank's own statement generator
 * writes real text-showing operators into the PDF, not a scanned bitmap) —
 * confirmed for this app's own sample by grep'ing a puppeteer-rendered PDF's
 * raw bytes for readable ASCII strings, and it is also simply how every
 * mainstream net-banking portal (HDFC/ICICI/Axis included) produces its
 * downloadable statement. A scanned/photographed statement would need image
 * OCR, a genuinely different and harder problem (no ground-truth text layer
 * to read at all) — deliberately NOT attempted here. See this module's own
 * "DELIBERATELY NOT DONE" note in the PDF bank-statement import work log.
 *
 * THE ONE THING A PDF DOESN'T GIVE YOU THAT A CSV DOES: named, delimited
 * columns. A bank's PDF table is just text positioned on a page — this
 * module recovers columns from POSITION, not punctuation:
 *
 *   1. Every text run pdf.js reports carries its own (x, y) origin and
 *      width (see pdfjs-dist's TextItem). Runs are grouped into visual
 *      LINES by y-coordinate (within a small tolerance — the same line of
 *      a table row is drawn at one baseline).
 *   2. Within the line believed to be the COLUMN HEADER, adjacent runs are
 *      clustered into "cells" by horizontal gap: a small gap (<4pt, well
 *      under one character width at statement font sizes) is the same cell
 *      broken across multiple text-showing operators (fonts/kerning do
 *      this even mid-word); a larger gap is a real column boundary.
 *   3. Each cell's (normalised) text is matched against this format's own
 *      real header labels — expectedHeaders(format), the exact same
 *      strings detectBankFormat/mapRowToCanonical already use for the CSV
 *      path (see bank-format-adapters.ts) — so a bank's column NAMES are
 *      never hardcoded a second time here. A match must be in the same
 *      left-to-right order the format declares; extra cells the header row
 *      has that this app doesn't care about (HDFC's "Value Dt", every
 *      format's own running balance column) are simply skipped over, not
 *      matched to anything.
 *   4. A COLUMN RANGE is the midpoint between two adjacent matched header
 *      cells (not "from this header's own left edge to the next one's"),
 *      because bank statement PDFs commonly right-align or centre a numeric
 *      column's header over data that is itself right-aligned — using the
 *      midpoint is the standard, alignment-agnostic way to assign a data
 *      run to "the column whose header it's geometrically closest to"
 *      rather than assuming a particular alignment convention.
 *   5. Every subsequent line (until a new header is matched, e.g. on a
 *      later page that repeats it) is read the SAME way: every text run on
 *      that line is bucketed into whichever column range contains its x
 *      position, and the runs in one bucket are joined left-to-right —
 *      this is what makes a BLANK interior cell (a debit row has an empty
 *      Deposit Amt. cell, and vice versa — the normal case, not an edge
 *      case, for every split-column format) work correctly: a blank cell
 *      just contributes zero runs to its range, and nothing downstream of
 *      it shifts, because ranges are fixed x-positions, not a count of
 *      "the next comma-separated field".
 *
 * The result is a Record<string,string> keyed by the SAME header-label
 * strings the format's own CSV column names use — i.e. a synthetic
 * BankCsvRow — so it is fed straight into the existing mapRowToCanonical /
 * buildBankPreview pipeline completely unchanged.
 *
 * SOURCING HONESTY. bank-format-adapters.ts's CSV header names were sourced
 * from real, independently-published customer statements (WebSearch, Aug
 * 2026). This module was built in a session with no WebSearch access and no
 * real bank-issued PDF sample to test against — it is verified against a
 * SYNTHETIC statement PDF (an HTML table rendered to PDF via this app's own
 * puppeteer-core, mirroring the real column layouts bank-format-adapters.ts
 * already documents) checked in at tests/fixtures/bank-pdf/. The GEOMETRIC
 * extraction algorithm above does not depend on any bank-specific layout
 * assumption beyond "this format's known header text appears somewhere,
 * left-to-right, in one line of the PDF" — which is true of any bank's
 * statement export using its own real column names — but the true header
 * WORDING of a given bank's PDF export (as opposed to its CSV/Excel export,
 * which IS sourced) has not been independently confirmed here. If a real
 * bank's PDF turns out to word a header differently from its own CSV
 * export (e.g. "W/D Amt" instead of "Withdrawal Amt."), header matching
 * below will not recognise it and headerFound will come back false for
 * that format — a loud, visible "nothing parsed" rather than a silent
 * wrong mapping, which is the deliberate fail-safe this module chooses.
 */
import {
  BANK_FORMATS,
  expectedHeaders,
  getBankFormat,
  normalizeHeaderToken,
  type BankFormatDef,
  type BankFormatId,
} from "@/lib/csv/bank-format-adapters";
import type { BankCsvRow } from "@/lib/csv/bank-import";

// A gap under this many PDF points between two text runs on the same line is
// treated as "still the same cell" (kerning/font-run breaks, not a column
// boundary). Comfortably above intra-word gaps and comfortably below a real
// column gap at typical 8-11pt statement font sizes (see this module's own
// header comment and the synthetic-fixture test for the numbers this was
// calibrated against).
const CELL_GAP_THRESHOLD_PT = 4;

// Two text runs are considered to be on the same visual line if their
// baseline y-coordinates differ by no more than this. PDF y increases
// upward; a single line of 8-11pt text has near-identical y across all its
// runs baring float noise.
const LINE_Y_TOLERANCE_PT = 2;

type PositionedRun = { str: string; x: number; end: number; y: number };

type Cell = { text: string; start: number; end: number };

type ColumnRange = { label: string; start: number; end: number };

type Role = "date" | "description" | "reference" | "debit" | "credit" | "amount" | "type";

function labeledColumns(def: BankFormatDef): { role: Role; label: string }[] {
  const c = def.columns;
  const list: { role: Role; label: string | null }[] =
    c.amountShape === "split"
      ? [
          { role: "date", label: c.date },
          { role: "description", label: c.description },
          { role: "reference", label: c.reference },
          { role: "debit", label: c.debit },
          { role: "credit", label: c.credit },
        ]
      : [
          { role: "date", label: c.date },
          { role: "description", label: c.description },
          { role: "reference", label: c.reference },
          { role: "amount", label: c.amount },
          { role: "type", label: c.type },
        ];
  return list.filter((x): x is { role: Role; label: string } => !!x.label);
}

/** Groups text runs into visual lines (top of page first), each sorted left to right. */
function buildLines(runs: PositionedRun[]): PositionedRun[][] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PositionedRun[][] = [];
  for (const run of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - run.y) <= LINE_Y_TOLERANCE_PT) {
      last.push(run);
    } else {
      lines.push([run]);
    }
  }
  for (const line of lines) line.sort((a, b) => a.x - b.x);
  return lines;
}

/** Merges adjacent runs on one line into cells, splitting only on a real horizontal gap. */
function clusterCells(line: PositionedRun[]): Cell[] {
  const cells: Cell[] = [];
  for (const run of line) {
    const cur = cells[cells.length - 1];
    if (cur && run.x - cur.end <= CELL_GAP_THRESHOLD_PT) {
      cur.text = `${cur.text} ${run.str}`;
      cur.end = Math.max(cur.end, run.end);
    } else {
      cells.push({ text: run.str, start: run.x, end: run.end });
    }
  }
  for (const cell of cells) cell.text = cell.text.replace(/\s+/g, " ").trim();
  return cells;
}

/**
 * Matches each expected header label to exactly one, not-yet-claimed cell in
 * this line, ANYWHERE in it — not constrained to left-to-right declaration
 * order. bank-format-adapters.ts's `columns` object lists fields in a fixed
 * semantic order (date, description, reference, debit/amount, credit/type)
 * that is NOT necessarily the bank's own real left-to-right column order —
 * ICICI's real header is Value Date / Transaction Date / Cheque Number /
 * Transaction Remarks / Transaction Type / Amount (INR), i.e. reference
 * (Cheque Number) physically comes BEFORE description (Transaction Remarks)
 * even though the columns object declares description first. A forward-only
 * scan mis-detects that case entirely; requiring only uniqueness (not order)
 * is what makes this robust to that mismatch.
 */
function matchHeaderCells(cells: Cell[], expectedLabels: string[]): { label: string; cellIndex: number }[] | null {
  const normCells = cells.map((c) => normalizeHeaderToken(c.text));
  const claimed = new Set<number>();
  const matches: { label: string; cellIndex: number }[] = [];
  for (const label of expectedLabels) {
    const normLabel = normalizeHeaderToken(label);
    let found = -1;
    for (let i = 0; i < normCells.length; i++) {
      if (claimed.has(i)) continue;
      if (normCells[i].length > 0 && normCells[i].includes(normLabel)) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    claimed.add(found);
    matches.push({ label, cellIndex: found });
  }
  return matches;
}

/**
 * Column ranges as the midpoint between each matched cell and its TRUE
 * physical neighbour in the header line — mapped or not. Using the nearest
 * OTHER MAPPED column instead (skipping over an unmapped one, e.g. HDFC's
 * "Value Dt" between Chq./Ref.No. and Withdrawal Amt.) would silently widen
 * a range across a whole column this app doesn't care about and swallow
 * that column's own data into whichever neighbour's range the midpoint
 * happened to land in — caught by this module's own fixture test before
 * shipping (a "Value Dt" data value bled into the Chq./Ref.No. column).
 */
function buildRanges(cells: Cell[], matches: { label: string; cellIndex: number }[]): ColumnRange[] {
  return matches.map(({ label, cellIndex }) => {
    const cell = cells[cellIndex];
    const prev = cells[cellIndex - 1];
    const next = cells[cellIndex + 1];
    return {
      label,
      start: prev ? (prev.end + cell.start) / 2 : -Infinity,
      end: next ? (cell.end + next.start) / 2 : Infinity,
    };
  });
}

/** Assigns a data line's runs to the known column ranges and joins each column's runs left to right. */
function extractRow(line: PositionedRun[], ranges: ColumnRange[]): BankCsvRow {
  const raw: BankCsvRow = {};
  for (const range of ranges) {
    const inRange = line.filter((run) => run.x >= range.start && run.x < range.end);
    raw[range.label] = inRange
      .map((run) => run.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return raw;
}

/**
 * A candidate row only counts as a transaction line if its date cell has at
 * least a digit AND at least one money-bearing cell is populated — cheap
 * enough to filter out titles, account-info lines, and footer disclaimers
 * without pretending to validate the date itself (buildBankPreview's own
 * parseDate does that, and surfaces a real issue in the preview if it's
 * wrong — this filter only decides whether a line is a candidate row at
 * all).
 */
function looksLikeDataRow(raw: BankCsvRow, dateLabel: string, moneyLabels: string[]): boolean {
  if (!/\d/.test(raw[dateLabel] ?? "")) return false;
  return moneyLabels.some((label) => (raw[label] ?? "").trim() !== "");
}

export type PdfExtractResult = {
  rows: BankCsvRow[];
  /** Whether this format's header row was located anywhere in the document at all. */
  headerFound: boolean;
  pageCount: number;
};

/**
 * Extracts every row this PDF contains under ONE specific, already-chosen
 * bank format — the function to call once a format is known (a manual
 * dropdown pick, or the outcome of detectAndExtractPdfBankRows below).
 */
export async function extractBankRowsFromPdf(bytes: Uint8Array, format: BankFormatDef): Promise<PdfExtractResult> {
  // pdfjs-dist's legacy Node build (recommended by pdfjs-dist itself for
  // non-browser environments) — no canvas, no real Worker thread needed for
  // text extraction. This build detects it is running under Node (no
  // browser Worker constructor available) and automatically falls back to
  // its in-process "fake worker" (LoopbackPort) on its own — there is no
  // `disableWorker`/`isEvalSupported` option in this pdfjs-dist version
  // (confirmed against its own DocumentInitParameters type and by grepping
  // the built bundle for both names — neither exists — before removing an
  // earlier draft's dead pass-through of them).
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // destroy() lives on the LOADING TASK, not the resolved PDFDocumentProxy —
  // keep the task around so the finally block below can actually release
  // the worker/document resources instead of silently no-op'ing on a proxy
  // that has no destroy method of its own.
  // A fresh copy, not the caller's own array — pdfjs-dist's internal fake
  // worker transfers ownership of the underlying ArrayBuffer as part of
  // handing document data to its message-handler plumbing; handing it the
  // CALLER's own buffer risks detaching it out from under a caller that (as
  // detectAndExtractPdfBankRows below does) reuses the same bytes across
  // several getDocument calls while trying each candidate bank format in
  // turn — reproduced live as a DataCloneError before this copy was added.
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await loadingTask.promise;

  const expectedLabels = expectedHeaders(format);
  const roles = labeledColumns(format);
  const dateLabel = roles.find((r) => r.role === "date")?.label;
  const moneyLabels = roles.filter((r) => r.role === "debit" || r.role === "credit" || r.role === "amount").map((r) => r.label);

  let ranges: ColumnRange[] | null = null;
  let headerFound = false;
  const rows: BankCsvRow[] = [];

  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // content.items is (TextItem | TextMarkedContent)[] — only TextItem
      // carries str/transform/width; a plain `for` loop with an `in` guard
      // narrows that union cleanly, which a .filter() type predicate over
      // a hand-rolled shape does not (TypeScript rejects a predicate whose
      // type isn't assignable to the union's own member).
      const runs: PositionedRun[] = [];
      for (const item of content.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        runs.push({ str: item.str, x: item.transform[4], end: item.transform[4] + item.width, y: item.transform[5] });
      }

      const lines = buildLines(runs);
      for (const line of lines) {
        const cells = clusterCells(line);
        const headerMatch = matchHeaderCells(cells, expectedLabels);
        if (headerMatch) {
          headerFound = true;
          ranges = buildRanges(cells, headerMatch);
          continue; // the header line itself is never a data row
        }
        if (!ranges || !dateLabel) continue; // no header seen yet anywhere in the document so far
        const raw = extractRow(line, ranges);
        if (looksLikeDataRow(raw, dateLabel, moneyLabels)) rows.push(raw);
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  return { rows, headerFound, pageCount: doc.numPages };
}

export type PdfBankImportOutcome = {
  /** null only when not even the generic layout's header could be located anywhere in the document. */
  formatId: BankFormatId | null;
  rows: BankCsvRow[];
  pageCount: number;
};

/**
 * Auto-detects which registered bank format this PDF's own header row
 * matches, mirroring detectBankFormat's CSV behaviour: 'generic' is tried
 * last (its header words are common enough to spuriously match unrelated
 * text), never silently guessed — the caller still shows whatever format
 * this returns in the same fully-editable dropdown the CSV path uses, and
 * re-extracts under a different format on request via extractBankRowsFromPdf
 * directly (see the PDF branch in ReconciliationScreen).
 */
export async function detectAndExtractPdfBankRows(bytes: Uint8Array): Promise<PdfBankImportOutcome> {
  const order = [...BANK_FORMATS.filter((f) => f.id !== "generic"), getBankFormat("generic")];
  for (const format of order) {
    const result = await extractBankRowsFromPdf(bytes, format);
    if (result.headerFound && result.rows.length > 0) {
      return { formatId: format.id, rows: result.rows, pageCount: result.pageCount };
    }
  }
  return { formatId: null, rows: [], pageCount: 0 };
}
