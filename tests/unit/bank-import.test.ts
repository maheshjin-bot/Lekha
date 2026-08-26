import { describe, expect, it } from "vitest";
import { buildBankPreview, type ExistingLine } from "@/lib/csv/bank-import";
import { computeExternalTxnId, getBankFormat } from "@/lib/csv/bank-format-adapters";

const generic = getBankFormat("generic");
const hdfc = getBankFormat("hdfc_netbanking");

const row = (o: Partial<Record<string, string>>) =>
  ({ Date: "01/04/2026", Description: "Inward transfer", Reference: "", Debit: "", Credit: "5000", ...o }) as Record<
    string,
    string
  >;

describe("buildBankPreview — generic format (unchanged behaviour)", () => {
  it("accepts a well-formed credit line", () => {
    const [r] = buildBankPreview([row({})], "dmy", generic, []);
    expect(r.issues).toEqual([]);
    expect(r.side).toBe("credit");
    expect(r.amount).toBe(5000);
  });

  it("accepts Indian digit grouping in the amount", () => {
    const [r] = buildBankPreview([row({ Credit: "1,00,000" })], "dmy", generic, []);
    expect(r.issues).toEqual([]);
    expect(r.amount).toBe(100000);
  });

  it("rejects a line with both debit and credit", () => {
    const [r] = buildBankPreview([row({ Debit: "100", Credit: "5000" })], "dmy", generic, []);
    expect(r.issues).toContain("A line cannot have both a debit and a credit amount.");
  });

  it("rejects a line with neither", () => {
    const [r] = buildBankPreview([row({ Credit: "" })], "dmy", generic, []);
    expect(r.issues).toContain("Either a debit or a credit amount is required.");
  });
});

describe("buildBankPreview — HDFC's real column layout", () => {
  const hdfcRow = (o: Partial<Record<string, string>>) =>
    ({
      Date: "01/04/2026",
      Narration: "NEFT-UTR12345-ABC TRADERS",
      "Chq./Ref.No.": "UTR12345",
      "Value Dt": "01/04/2026",
      "Withdrawal Amt.": "",
      "Deposit Amt.": "5000",
      "Closing Balance": "50000",
      ...o,
    }) as Record<string, string>;

  it("imports correctly into the same canonical shape as the generic template", () => {
    const [r] = buildBankPreview([hdfcRow({})], "dmy", hdfc, []);
    expect(r.issues).toEqual([]);
    expect(r.date).toBe("2026-04-01");
    expect(r.description).toBe("NEFT-UTR12345-ABC TRADERS");
    expect(r.reference).toBe("UTR12345");
    expect(r.side).toBe("credit");
    expect(r.amount).toBe(5000);
  });

  it("a withdrawal (Withdrawal Amt. populated) comes through as a debit", () => {
    const [r] = buildBankPreview(
      [hdfcRow({ "Withdrawal Amt.": "2000", "Deposit Amt.": "" })],
      "dmy",
      hdfc,
      []
    );
    expect(r.side).toBe("debit");
    expect(r.amount).toBe(2000);
  });
});

describe("buildBankPreview — idempotent re-import via external_txn_id", () => {
  it("flags a line already on file (matched by fingerprint, not a fuzzy amount/date guess) without treating it as an error", () => {
    const [first] = buildBankPreview([row({})], "dmy", generic, []);
    const existing: ExistingLine[] = [{ externalTxnId: first.externalTxnId }];
    const [r] = buildBankPreview([row({})], "dmy", generic, existing);
    expect(r.externalTxnId).toBe(first.externalTxnId);
    expect(r.possibleDuplicate).toBe(true);
    expect(r.issues).toEqual([]); // still importable — genuine repeats happen; the DB-level upsert is what actually dedupes
  });

  it("does not flag a different amount on the same day as a duplicate", () => {
    const differentAmount = buildBankPreview([row({ Credit: "4000" })], "dmy", generic, [])[0];
    const existing: ExistingLine[] = [{ externalTxnId: differentAmount.externalTxnId }];
    const [r] = buildBankPreview([row({})], "dmy", generic, existing);
    expect(r.possibleDuplicate).toBe(false);
  });

  it("re-parsing a byte-identical file reproduces the exact same external_txn_id per row, including two identical-looking rows", () => {
    const file = [row({ Reference: "" }), row({ Reference: "" })]; // two genuinely identical rows in one file
    const firstParse = buildBankPreview(file, "dmy", generic, []);
    const secondParse = buildBankPreview(file, "dmy", generic, []);
    expect(secondParse.map((r) => r.externalTxnId)).toEqual(firstParse.map((r) => r.externalTxnId));
    // and the two rows within one file are still distinguishable from each other
    expect(firstParse[0].externalTxnId).not.toBe(firstParse[1].externalTxnId);
  });

  it("computeExternalTxnId agrees with what buildBankPreview actually produces for a simple row", () => {
    const [r] = buildBankPreview([row({})], "dmy", generic, []);
    const expected = computeExternalTxnId(
      { date: "2026-04-01", description: "Inward transfer", reference: "", debit: 0, credit: 5000 },
      0
    );
    expect(r.externalTxnId).toBe(expected);
  });
});
