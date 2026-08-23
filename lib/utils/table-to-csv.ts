/**
 * Reads a rendered <table> back out as CSV — exports exactly what's on
 * screen (same formatting, same rounding) rather than re-deriving it from
 * the underlying data, so a report's CSV can never disagree with its own
 * table.
 */
export function tableToCsv(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  const lines = rows.map((row) => {
    // print:hidden already marks a column as UI chrome (an Edit/action link,
    // say) rather than report content — the same signal that keeps it off a
    // physical printout keeps it out of the CSV too.
    const cells = Array.from(row.querySelectorAll("th, td")).filter(
      (cell) => !cell.classList.contains("print:hidden")
    );
    return cells.map((cell) => escapeCsvCell(cellText(cell))).join(",");
  });
  return lines.join("\r\n");
}

/** Collapses internal whitespace and strips the — placeholder to blank. */
function cellText(cell: Element): string {
  const text = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
  return text === "—" ? "" : text;
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function downloadCsv(csv: string, filename: string) {
  // A UTF-8 BOM so Excel (still, in 2026) doesn't mangle the ₹ symbol into
  // question marks when it guesses the encoding.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
