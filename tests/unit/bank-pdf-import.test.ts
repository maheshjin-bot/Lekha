import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectAndExtractPdfBankRows, extractBankRowsFromPdf } from "@/lib/csv/bank-pdf-import";
import { buildBankPreview } from "@/lib/csv/bank-import";
import { getBankFormat } from "@/lib/csv/bank-format-adapters";

// Synthetic fixtures (E: drive, generated via this app's own puppeteer-core
// dependency from an HTML table mirroring the real column layouts
// bank-format-adapters.ts documents) — not a real bank-issued PDF; see
// bank-pdf-import.ts's own header comment for exactly why and what that
// does and does not prove. Regenerate with .scratch-pdf-test/make-fixtures
// (not checked in) if the extraction algorithm's geometry assumptions ever
// need re-validating against a different layout.
const fixtureDir = path.join(process.cwd(), "tests", "fixtures", "bank-pdf");

function loadFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(fixtureDir, name)));
}

describe("extractBankRowsFromPdf — HDFC split Debit/Credit layout", () => {
  it("finds the header and extracts all three transaction rows with correct debit/credit sides", async () => {
    const bytes = loadFixture("hdfc-sample.pdf");
    const result = await extractBankRowsFromPdf(bytes, getBankFormat("hdfc_netbanking"));

    expect(result.headerFound).toBe(true);
    expect(result.pageCount).toBe(1);
    expect(result.rows).toHaveLength(3);

    expect(result.rows[0]["Date"]).toBe("01/04/26");
    expect(result.rows[0]["Narration"]).toBe("NEFT-UTR8827-ABC TRADERS");
    expect(result.rows[0]["Chq./Ref.No."]).toBe("UTR8827");
    expect(result.rows[0]["Withdrawal Amt."]).toBe(""); // blank interior cell — the normal case, not an edge case
    expect(result.rows[0]["Deposit Amt."]).toBe("5,000.00");

    expect(result.rows[1]["Withdrawal Amt."]).toBe("2,000.00");
    expect(result.rows[1]["Deposit Amt."]).toBe("");

    expect(result.rows[2]["Narration"]).toBe("BANK CHARGES");
    expect(result.rows[2]["Withdrawal Amt."]).toBe("150.00");
  });

  it("feeds straight into buildBankPreview with zero changes to that pipeline", async () => {
    const bytes = loadFixture("hdfc-sample.pdf");
    const format = getBankFormat("hdfc_netbanking");
    const { rows } = await extractBankRowsFromPdf(bytes, format);
    const preview = buildBankPreview(rows, "dmy", format, []);

    expect(preview.every((r) => r.issues.length === 0)).toBe(true);
    expect(preview[0]).toMatchObject({ date: "2026-04-01", side: "credit", amount: 5000 });
    expect(preview[1]).toMatchObject({ date: "2026-04-02", side: "debit", amount: 2000 });
    expect(preview[2]).toMatchObject({ date: "2026-04-03", side: "debit", amount: 150 });
  });
});

describe("extractBankRowsFromPdf — ICICI signed Amount + Dr/Cr layout", () => {
  it("extracts the signed-amount rows and routes them to the right side via the Transaction Type column", async () => {
    const bytes = loadFixture("icici-sample.pdf");
    const format = getBankFormat("icici_netbanking");
    const result = await extractBankRowsFromPdf(bytes, format);

    expect(result.headerFound).toBe(true);
    expect(result.rows).toHaveLength(3);

    const preview = buildBankPreview(result.rows, "dmy", format, []);
    expect(preview.every((r) => r.issues.length === 0)).toBe(true);
    expect(preview[0]).toMatchObject({ date: "2026-04-01", side: "credit", amount: 5000 });
    expect(preview[1]).toMatchObject({ date: "2026-04-02", side: "debit", amount: 2000 });
    expect(preview[2]).toMatchObject({ date: "2026-04-03", side: "debit", amount: 150 });
  });
});

describe("detectAndExtractPdfBankRows — auto-detection across formats", () => {
  it("picks hdfc_netbanking for the HDFC fixture without being told", async () => {
    const outcome = await detectAndExtractPdfBankRows(loadFixture("hdfc-sample.pdf"));
    expect(outcome.formatId).toBe("hdfc_netbanking");
    expect(outcome.rows).toHaveLength(3);
  });

  it("picks icici_netbanking for the ICICI fixture without being told", async () => {
    const outcome = await detectAndExtractPdfBankRows(loadFixture("icici-sample.pdf"));
    expect(outcome.formatId).toBe("icici_netbanking");
    expect(outcome.rows).toHaveLength(3);
  });

  it("does not cross-match — parsing the HDFC fixture under the ICICI format finds no header", async () => {
    const result = await extractBankRowsFromPdf(loadFixture("hdfc-sample.pdf"), getBankFormat("icici_netbanking"));
    expect(result.headerFound).toBe(false);
    expect(result.rows).toHaveLength(0);
  });
});
