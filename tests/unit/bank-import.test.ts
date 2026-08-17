import { describe, expect, it } from "vitest";
import { buildBankPreview } from "@/lib/csv/bank-import";

const row = (o: Partial<Record<string, string>>) =>
  ({ Date: "01/04/2026", Description: "Inward transfer", Reference: "", Debit: "", Credit: "5000", ...o }) as Record<
    string,
    string
  >;

describe("buildBankPreview", () => {
  it("accepts a well-formed credit line", () => {
    const [r] = buildBankPreview([row({})], "dmy", []);
    expect(r.issues).toEqual([]);
    expect(r.side).toBe("credit");
    expect(r.amount).toBe(5000);
  });

  it("accepts Indian digit grouping in the amount", () => {
    const [r] = buildBankPreview([row({ Credit: "1,00,000" })], "dmy", []);
    expect(r.issues).toEqual([]);
    expect(r.amount).toBe(100000);
  });

  it("rejects a line with both debit and credit", () => {
    const [r] = buildBankPreview([row({ Debit: "100", Credit: "5000" })], "dmy", []);
    expect(r.issues).toContain("A line cannot have both a debit and a credit amount.");
  });

  it("rejects a line with neither", () => {
    const [r] = buildBankPreview([row({ Credit: "" })], "dmy", []);
    expect(r.issues).toContain("Either a debit or a credit amount is required.");
  });

  it("flags a likely duplicate without treating it as an error", () => {
    const existing = [{ txnDate: "2026-04-01", description: "Inward transfer", debit: 0, credit: 5000 }];
    const [r] = buildBankPreview([row({})], "dmy", existing);
    expect(r.possibleDuplicate).toBe(true);
    expect(r.issues).toEqual([]); // still importable — genuine repeats happen
  });

  it("does not flag a different amount on the same day as a duplicate", () => {
    const existing = [{ txnDate: "2026-04-01", description: "Inward transfer", debit: 0, credit: 4000 }];
    const [r] = buildBankPreview([row({})], "dmy", existing);
    expect(r.possibleDuplicate).toBe(false);
  });
});
