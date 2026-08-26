import { describe, expect, it } from "vitest";
import {
  BANK_FORMATS,
  computeExternalTxnId,
  detectBankFormat,
  getBankFormat,
  mapRowToCanonical,
} from "@/lib/csv/bank-format-adapters";

describe("detectBankFormat", () => {
  it("detects the generic template exactly", () => {
    expect(detectBankFormat(["Date", "Description", "Reference", "Debit", "Credit"])).toBe("generic");
  });

  it("detects HDFC's real 7-column header regardless of extra whitespace/punctuation", () => {
    expect(
      detectBankFormat(["Date", "Narration", "Chq / Ref No", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"])
    ).toBe("hdfc_netbanking");
  });

  it("detects ICICI's signed-amount header", () => {
    expect(
      detectBankFormat(["Value Date", "Transaction Date", "Cheque Number", "Transaction Remarks", "Transaction Type", "Amount (INR)", "Balance (INR)"])
    ).toBe("icici_netbanking");
  });

  it("detects Axis's signed-amount header, distinct from ICICI's despite the same shape", () => {
    expect(
      detectBankFormat(["Tran Date", "Value Date", "Transaction Particulars", "Chq No", "Amount(in Rs.)", "DR/CR", "Balance(in Rs.)"])
    ).toBe("axis_netbanking");
  });

  it("returns null rather than guessing when headers do not confidently match any known layout", () => {
    expect(detectBankFormat(["Sl No", "Some Bank's Own Column", "Amount"])).toBeNull();
  });
});

describe("mapRowToCanonical — split shape (HDFC)", () => {
  const hdfc = getBankFormat("hdfc_netbanking");

  it("maps a withdrawal row", () => {
    const row = {
      Date: "01/04/2026",
      Narration: "NEFT-UTR12345-ABC TRADERS",
      "Chq./Ref.No.": "UTR12345",
      "Value Dt": "01/04/2026",
      "Withdrawal Amt.": "2,000.00",
      "Deposit Amt.": "",
      "Closing Balance": "48,000.00",
    };
    const canon = mapRowToCanonical(row, hdfc);
    expect(canon).toEqual({
      date: "01/04/2026",
      description: "NEFT-UTR12345-ABC TRADERS",
      reference: "UTR12345",
      debitRaw: "2,000.00",
      creditRaw: "",
    });
  });

  it("is insensitive to real-world header punctuation variance", () => {
    const row = {
      Date: "02/04/2026",
      Narration: "Salary credit",
      "Chq/Ref No": "", // no periods, no slash-spacing — same as "Chq./Ref.No." after normalisation
      "Withdrawal Amt": "",
      "Deposit Amt": "50000",
    };
    const canon = mapRowToCanonical(row, hdfc);
    expect(canon.creditRaw).toBe("50000");
  });
});

describe("mapRowToCanonical — signed shape (ICICI / Axis)", () => {
  const icici = getBankFormat("icici_netbanking");
  const axis = getBankFormat("axis_netbanking");

  it("ICICI: a 'Dr' transaction type routes the amount to debit", () => {
    const row = {
      "Value Date": "01-04-2026",
      "Transaction Date": "01-04-2026",
      "Cheque Number": "",
      "Transaction Remarks": "UPI/mmid/paytm",
      "Transaction Type": "Dr",
      "Amount (INR)": "750.50",
      "Balance (INR)": "10000",
    };
    const canon = mapRowToCanonical(row, icici);
    expect(canon.debitRaw).toBe("750.5");
    expect(canon.creditRaw).toBe("");
  });

  it("ICICI: a 'Cr' transaction type routes the amount to credit", () => {
    const row = {
      "Value Date": "02-04-2026",
      "Transaction Date": "02-04-2026",
      "Cheque Number": "",
      "Transaction Remarks": "Interest credit",
      "Transaction Type": "Cr",
      "Amount (INR)": "120",
      "Balance (INR)": "10120",
    };
    const canon = mapRowToCanonical(row, icici);
    expect(canon.creditRaw).toBe("120");
    expect(canon.debitRaw).toBe("");
  });

  it("ICICI: an unrecognised type marker leaves both sides blank rather than guessing", () => {
    const row = {
      "Transaction Date": "03-04-2026",
      "Transaction Remarks": "??",
      "Transaction Type": "X",
      "Amount (INR)": "500",
    };
    const canon = mapRowToCanonical(row, icici);
    expect(canon.debitRaw).toBe("");
    expect(canon.creditRaw).toBe("");
  });

  it("a sign embedded in the source Amount column never fights the separate type column", () => {
    const row = {
      "Transaction Date": "04-04-2026",
      "Transaction Remarks": "Cheque deposit",
      "Transaction Type": "Cr",
      "Amount (INR)": "-2500.00", // some exports sign the amount too; type column stays authoritative
    };
    const canon = mapRowToCanonical(row, icici);
    expect(canon.creditRaw).toBe("2500");
    expect(canon.debitRaw).toBe("");
  });

  it("Axis: DR/CR column, different header text, same shape", () => {
    const row = {
      "Tran Date": "05-04-2026",
      "Value Date": "05-04-2026",
      "Transaction Particulars": "ATM WDL",
      "Chq No": "",
      "Amount(in Rs.)": "1000",
      "DR/CR": "DR",
      "Balance(in Rs.)": "9000",
    };
    const canon = mapRowToCanonical(row, axis);
    expect(canon.debitRaw).toBe("1000");
  });
});

describe("computeExternalTxnId — idempotent re-import", () => {
  it("is stable across two identical invocations (a byte-identical re-upload)", () => {
    const line = { date: "2026-04-01", description: "NEFT transfer", reference: "UTR12345", debit: 0, credit: 5000 };
    expect(computeExternalTxnId(line, 0)).toBe(computeExternalTxnId(line, 0));
  });

  it("differentiates two identical-looking lines in the same file by occurrence index", () => {
    const line = { date: "2026-04-01", description: "UPI payment", reference: "", debit: 500, credit: 0 };
    const first = computeExternalTxnId(line, 0);
    const second = computeExternalTxnId(line, 1);
    expect(first).not.toBe(second);
  });

  it("differentiates two same-day, same-amount lines that carry different real references", () => {
    const a = computeExternalTxnId({ date: "2026-04-01", description: "NEFT", reference: "UTR001", debit: 0, credit: 5000 }, 0);
    const b = computeExternalTxnId({ date: "2026-04-01", description: "NEFT", reference: "UTR002", debit: 0, credit: 5000 }, 0);
    expect(a).not.toBe(b);
  });
});

describe("every registered format's columns are self-consistent", () => {
  it.each(BANK_FORMATS)("$id declares at least date/description/amount fields", (def) => {
    expect(def.columns.date).toBeTruthy();
    expect(def.columns.description).toBeTruthy();
    if (def.columns.amountShape === "split") {
      expect(def.columns.debit).toBeTruthy();
      expect(def.columns.credit).toBeTruthy();
    } else {
      expect(def.columns.amount).toBeTruthy();
      expect(def.columns.type).toBeTruthy();
    }
  });
});
