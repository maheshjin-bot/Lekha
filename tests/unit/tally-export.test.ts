/**
 * Tally XML export — unit coverage for the parts that are cheap to get
 * wrong silently: the debit=negative-amount sign convention (the single
 * biggest "opposite of naive accounting intuition" gotcha the research
 * flagged), the built-in-vs-custom group resolution against LEKHA's real,
 * live-verified 2-level Schedule III chart of accounts (Current Assets /
 * Current Liabilities / etc. as top-level, Sundry Debtors / Bank Accounts /
 * etc. nested beneath), and XML escaping.
 */
import { describe, expect, it } from "vitest";
import {
  buildGroupsXml,
  buildLedgersXml,
  buildVouchersXml,
  escapeXml,
  isTallyBuiltinGroup,
  resolveTallyParent,
  type ExportGroup,
  type ExportLedger,
  type ExportVoucher,
} from "@/lib/tally/xml";

describe("escapeXml", () => {
  it("escapes all five XML special characters", () => {
    expect(escapeXml(`A & B < C > "D" 'E'`)).toBe("A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos;");
  });
});

describe("isTallyBuiltinGroup", () => {
  it("matches LEKHA's exact-name seeded groups (Sundry Debtors, Current Assets, ...)", () => {
    expect(isTallyBuiltinGroup("Sundry Debtors")).toBe("Sundry Debtors");
    expect(isTallyBuiltinGroup("Current Assets")).toBe("Current Assets");
    expect(isTallyBuiltinGroup("Fixed Assets")).toBe("Fixed Assets");
  });

  it("normalizes LEKHA's near-but-not-exact seeded names to Tally's real canonical casing/symbol", () => {
    // Live-verified (21 Aug 2026) these are the actual seeded names in
    // every LEKHA company — case/symbol differences from Tally's own
    // reserved names, not typos, so the normalizer has to bridge them.
    expect(isTallyBuiltinGroup("Cash-in-Hand")).toBe("Cash-in-hand");
    expect(isTallyBuiltinGroup("Reserves and Surplus")).toBe("Reserves & Surplus");
  });

  it("does not match LEKHA's genuinely custom Schedule III groups", () => {
    expect(isTallyBuiltinGroup("Non-current Liabilities")).toBeNull();
    expect(isTallyBuiltinGroup("Long-term Borrowings")).toBeNull();
    expect(isTallyBuiltinGroup("Share Capital")).toBeNull();
    expect(isTallyBuiltinGroup("Outstanding Expenses")).toBeNull();
  });
});

describe("resolveTallyParent", () => {
  it("sends a top-level custom group (no LEKHA parent) to Tally's Primary root", () => {
    const group: ExportGroup = { id: "1", name: "Non-current Liabilities", parent_group_id: null };
    expect(resolveTallyParent(group, new Map())).toBe("Primary");
  });

  it("resolves a custom sub-group's parent to the built-in canonical name when the LEKHA parent is itself built-in", () => {
    const parent: ExportGroup = { id: "p", name: "Fixed Assets", parent_group_id: null };
    const child: ExportGroup = { id: "c", name: "Plant & Machinery", parent_group_id: "p" };
    const byId = new Map([["p", parent], ["c", child]]);
    expect(resolveTallyParent(child, byId)).toBe("Fixed Assets");
  });

  it("chains a custom sub-group up to its custom LEKHA parent's own name when that parent isn't built-in either", () => {
    const parent: ExportGroup = { id: "p", name: "Non-current Liabilities", parent_group_id: null };
    const child: ExportGroup = { id: "c", name: "Long-term Borrowings", parent_group_id: "p" };
    const byId = new Map([["p", parent], ["c", child]]);
    expect(resolveTallyParent(child, byId)).toBe("Non-current Liabilities");
  });
});

describe("buildGroupsXml", () => {
  it("emits exactly one TALLYMESSAGE per custom group and skips built-ins entirely", () => {
    const groups: ExportGroup[] = [
      { id: "1", name: "Current Assets", parent_group_id: null }, // built-in, skipped
      { id: "2", name: "Sundry Debtors", parent_group_id: "1" }, // built-in, skipped
      { id: "3", name: "Non-current Liabilities", parent_group_id: null }, // custom
      { id: "4", name: "Long-term Borrowings", parent_group_id: "3" }, // custom
    ];
    const xml = buildGroupsXml(groups);
    const messageCount = (xml.match(/<TALLYMESSAGE/g) ?? []).length;
    expect(messageCount).toBe(2);
    expect(xml).toContain('<GROUP NAME="Non-current Liabilities" ACTION="Create">');
    expect(xml).toContain("<PARENT>Primary</PARENT>");
    expect(xml).toContain('<GROUP NAME="Long-term Borrowings" ACTION="Create">');
    expect(xml).not.toContain("Sundry Debtors");
    expect(xml).not.toContain("Current Assets");
  });

  it("deduplicates a top-level group and a nested sub-group that share the exact same name (a real LEKHA pattern), keeping only the nested one's PARENT", () => {
    // Caught live by browser-testing the actual export before this test
    // existed: LEKHA seeds a top-level "Long-term Borrowings" AND a nested
    // sub-group also named "Long-term Borrowings" (child of "Non-current
    // Liabilities") — emitting one <GROUP Create> per row produced two
    // Tally groups with the identical name and conflicting PARENTs.
    const groups: ExportGroup[] = [
      { id: "top", name: "Non-current Liabilities", parent_group_id: null },
      { id: "orphan", name: "Long-term Borrowings", parent_group_id: null }, // top-level pass-through
      { id: "real", name: "Long-term Borrowings", parent_group_id: "top" }, // the one ledgers attach to
    ];
    const xml = buildGroupsXml(groups);
    const borrowingsCount = (xml.match(/NAME="Long-term Borrowings"/g) ?? []).length;
    expect(borrowingsCount).toBe(1);
    expect(xml).toContain('<GROUP NAME="Long-term Borrowings" ACTION="Create"><NAME>Long-term Borrowings</NAME><PARENT>Non-current Liabilities</PARENT>');
  });

  it("orders top-level custom groups before nested custom groups so PARENT always already exists", () => {
    const groups: ExportGroup[] = [
      { id: "2", name: "Long-term Borrowings", parent_group_id: "1" }, // nested, listed first in input
      { id: "1", name: "Non-current Liabilities", parent_group_id: null }, // top-level, listed second
    ];
    const xml = buildGroupsXml(groups);
    expect(xml.indexOf("Non-current Liabilities")).toBeLessThan(xml.indexOf("Long-term Borrowings"));
  });
});

describe("buildLedgersXml", () => {
  const groups: ExportGroup[] = [{ id: "g1", name: "Sundry Debtors", parent_group_id: null }];

  function ledger(overrides: Partial<ExportLedger> = {}): ExportLedger {
    return {
      id: "l1",
      name: "Ashoka Traders",
      group_id: "g1",
      gstin: null,
      pan: null,
      address: null,
      city: null,
      pincode: null,
      state_name: null,
      email: null,
      phone: null,
      opening_balance_amount: 0,
      opening_balance_type: "debit",
      ...overrides,
    };
  }

  it("uses the built-in canonical group name as PARENT", () => {
    const xml = buildLedgersXml([ledger()], groups);
    expect(xml).toContain("<PARENT>Sundry Debtors</PARENT>");
  });

  it("signs OPENINGBALANCE positive for a debit balance and negative for a credit balance", () => {
    const debitXml = buildLedgersXml([ledger({ opening_balance_amount: 5000, opening_balance_type: "debit" })], groups);
    expect(debitXml).toContain("<OPENINGBALANCE>5000.00</OPENINGBALANCE>");

    const creditXml = buildLedgersXml([ledger({ opening_balance_amount: 5000, opening_balance_type: "credit" })], groups);
    expect(creditXml).toContain("<OPENINGBALANCE>-5000.00</OPENINGBALANCE>");
  });

  it("omits OPENINGBALANCE entirely when there is none, rather than emitting a zero", () => {
    const xml = buildLedgersXml([ledger({ opening_balance_amount: 0 })], groups);
    expect(xml).not.toContain("OPENINGBALANCE");
  });
});

describe("buildVouchersXml — the debit=negative-amount sign convention", () => {
  it("marks the debit leg ISDEEMEDPOSITIVE=Yes with a NEGATIVE amount, and the credit leg No with a POSITIVE amount", () => {
    // The exact shape confirmed by three independent official Tally
    // examples during research — this is deliberately the opposite of
    // naive accounting intuition (debit = negative here), so it's worth
    // a hard regression test rather than trusting it stays right.
    const voucher: ExportVoucher = {
      voucher_type: "receipt",
      voucher_number: "HO/REC/2026-27/00001",
      voucher_date: "2026-08-21",
      narration: "Test receipt",
      entries: [
        { ledger_name: "HDFC Bank", debit_amount: 1000, credit_amount: 0 },
        { ledger_name: "Ashoka Traders", debit_amount: 0, credit_amount: 1000 },
      ],
    };
    const xml = buildVouchersXml([voucher]);

    // Debit leg: Yes + negative
    const debitLegMatch = xml.match(/<LEDGERNAME>HDFC Bank<\/LEDGERNAME><ISDEEMEDPOSITIVE>(\w+)<\/ISDEEMEDPOSITIVE><AMOUNT>([-\d.]+)<\/AMOUNT>/);
    expect(debitLegMatch?.[1]).toBe("Yes");
    expect(debitLegMatch?.[2]).toBe("-1000.00");

    // Credit leg: No + positive
    const creditLegMatch = xml.match(/<LEDGERNAME>Ashoka Traders<\/LEDGERNAME><ISDEEMEDPOSITIVE>(\w+)<\/ISDEEMEDPOSITIVE><AMOUNT>([-\d.]+)<\/AMOUNT>/);
    expect(creditLegMatch?.[1]).toBe("No");
    expect(creditLegMatch?.[2]).toBe("1000.00");
  });

  it("formats the date as plain YYYYMMDD with no separators", () => {
    const voucher: ExportVoucher = {
      voucher_type: "journal",
      voucher_number: "HO/JRN/2026-27/00001",
      voucher_date: "2026-08-21",
      narration: null,
      entries: [
        { ledger_name: "A", debit_amount: 100, credit_amount: 0 },
        { ledger_name: "B", debit_amount: 0, credit_amount: 100 },
      ],
    };
    const xml = buildVouchersXml([voucher]);
    expect(xml).toContain("<DATE>20260821</DATE>");
  });

  it("carries both VCHTYPE (attribute) and VOUCHERTYPENAME (element) with the same mapped Tally name", () => {
    const voucher: ExportVoucher = {
      voucher_type: "credit_note",
      voucher_number: "HO/CRN/2026-27/00001",
      voucher_date: "2026-08-21",
      narration: null,
      entries: [
        { ledger_name: "A", debit_amount: 100, credit_amount: 0 },
        { ledger_name: "B", debit_amount: 0, credit_amount: 100 },
      ],
    };
    const xml = buildVouchersXml([voucher]);
    expect(xml).toContain('VCHTYPE="Credit Note"');
    expect(xml).toContain("<VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME>");
  });

  it("silently skips voucher types Tally has no equivalent for (job_work_out/in, stock_journal) rather than emitting something wrong", () => {
    const voucher: ExportVoucher = {
      voucher_type: "job_work_out",
      voucher_number: "HO/JWO/2026-27/00001",
      voucher_date: "2026-08-21",
      narration: null,
      entries: [
        { ledger_name: "A", debit_amount: 100, credit_amount: 0 },
        { ledger_name: "B", debit_amount: 0, credit_amount: 100 },
      ],
    };
    expect(buildVouchersXml([voucher])).toBe("");
  });
});
