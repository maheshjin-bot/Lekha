/**
 * AOC-4 XBRL instance generation — unit coverage built from REAL live data
 * pulled from the running project (ref msgzicwfdoxaswgmevyg) on 26 Aug 2026
 * via `select ... from public.get_balance_sheet(...)` /
 * `get_profit_and_loss(...)` for Bharat Industries Limited (a real seeded
 * 'ltd' company, id a6fc600a-1a82-4ef9-baaa-63c03753eb6c) — not synthetic
 * numbers. The two live queries and their exact output are reproduced
 * verbatim below as the test fixtures, so this test doubles as this
 * feature's own hand-verification: it proves the arithmetic this module
 * does over real rows, exactly, not just against invented ones.
 *
 * A second, deliberately UNbalanced live fixture (Nexgen Softwares Private
 * Limited, 3754c8f9-b27e-4f4e-abd0-b99501cb2b9e) is included too — its real
 * balance sheet genuinely does not balance today (Long-term Borrowings
 * ledgers with no offsetting asset increase, a pre-existing data artifact
 * in that seed company, not something this feature caused or fixes) — used
 * here to prove the mapping still sums real rows correctly even when the
 * source data itself is inconsistent, which is exactly the state a real
 * company's half-entered books could be in.
 */
import { describe, expect, it } from "vitest";
import {
  buildBalanceSheetInstance,
  buildProfitAndLossInstance,
  ENTITY_SCHEME,
  escapeXml,
  mapBalanceSheetFacts,
  mapProfitAndLossFacts,
  type BsFactRow,
  type PlFactRow,
} from "@/lib/xbrl/aoc4";

// Live query: select side, nature, group_name, ledger_name, ledger_role, amount
// from public.get_balance_sheet('a6fc600a-...'::uuid, '2026-08-26'::date, null)
const BHARAT_BS_ROWS: BsFactRow[] = [
  { side: "assets", nature: "current_asset", group_name: "Sundry Debtors", ledger_name: "Ashoka Traders (Customer)", ledger_role: "debtor", amount: "53780.00" },
  { side: "assets", nature: "current_asset", group_name: "Bank Accounts", ledger_name: "HDFC Bank Current A/c", ledger_role: "cash_bank", amount: "485000.00" },
  { side: "liabilities", nature: "capital", group_name: "Capital Account", ledger_name: "Capital Account", ledger_role: "capital", amount: "500000.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Sundry Creditors", ledger_name: "Bansal Professional Services (Vendor)", ledger_role: "creditor", amount: "94400.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "Input CGST (24)", ledger_role: "duty_tax", amount: "-7200.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "Input SGST (24)", ledger_role: "duty_tax", amount: "-7200.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "Output CGST (24)", ledger_role: "duty_tax", amount: "6300.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "Output SGST (24)", ledger_role: "duty_tax", amount: "6300.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "TCS Payable", ledger_role: "duty_tax", amount: "1180.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "TDS Payable", ledger_role: "duty_tax", amount: "5000.00" },
];

// Live query: select section, nature, group_name, ledger_name, amount from
// public.get_profit_and_loss('a6fc600a-...'::uuid, '2026-04-01'::date, '2026-08-26'::date, null)
const BHARAT_PL_ROWS: PlFactRow[] = [
  { section: "trading", nature: "direct_expense", group_name: "Direct Expenses", ledger_name: "Purchase Account", amount: "80000.00" },
  { section: "trading", nature: "direct_income", group_name: "Direct Incomes", ledger_name: "Sales Account", amount: "70000.00" },
  { section: "profit_loss", nature: "indirect_expense", group_name: "Indirect Expenses", ledger_name: "Professional Fees", amount: "50000.00" },
];
// Live-computed retained profit for the same period (FY start = book
// beginning date for this company, so brought-forward is 0): 70000 - 80000
// - 50000 = -60000.00, reproduced by app/(app)/[companyId]/reports/
// balance-sheet/page.tsx's own carry-forward logic, not recomputed
// differently here.
const BHARAT_RETAINED_PROFIT = -60000;

// Live query, Nexgen Softwares Private Limited, same as-at date — genuinely
// does not balance (see file header).
const NEXGEN_BS_ROWS: BsFactRow[] = [
  { side: "assets", nature: "current_asset", group_name: "Bank Accounts", ledger_name: "HDFC Bank Current A/c", ledger_role: "cash_bank", amount: "585000.00" },
  { side: "assets", nature: "current_asset", group_name: "Sundry Debtors", ledger_name: "Ashoka Traders (Customer)", ledger_role: "debtor", amount: "53780.00" },
  { side: "liabilities", nature: "capital", group_name: "Capital Account", ledger_name: "Capital Account", ledger_role: "capital", amount: "500000.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "Input CGST (27)", ledger_role: "duty_tax", amount: "-7200.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "Input SGST (27)", ledger_role: "duty_tax", amount: "-7200.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "Output CGST (27)", ledger_role: "duty_tax", amount: "6300.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "Output SGST (27)", ledger_role: "duty_tax", amount: "6300.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "TCS Payable", ledger_role: "duty_tax", amount: "1180.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Duties & Taxes", ledger_name: "TDS Payable", ledger_role: "duty_tax", amount: "5000.00" },
  { side: "liabilities", nature: "current_liability", group_name: "Sundry Creditors", ledger_name: "Bansal Professional Services (Vendor)", ledger_role: "creditor", amount: "94400.00" },
  { side: "liabilities", nature: "non_current_liability", group_name: "Long-term Borrowings", ledger_name: "HDFC Bank - Term Loan", ledger_role: "other", amount: "2000000.00" },
  { side: "liabilities", nature: "non_current_liability", group_name: "Long-term Borrowings", ledger_name: "Priya Menon Personal Loan A/c", ledger_role: "other", amount: "150000.00" },
  { side: "liabilities", nature: "non_current_liability", group_name: "Long-term Borrowings", ledger_name: "Rajesh Nair - Director's Loan", ledger_role: "other", amount: "600000.00" },
  { side: "liabilities", nature: "non_current_liability", group_name: "Long-term Borrowings", ledger_name: "Unsecured Loan - Sunrise Capital Partners", ledger_role: "other", amount: "300000.00" },
];

/**
 * Minimal, dependency-free well-formedness check (no XML parser is a
 * project dependency, and vitest here runs under environment "node", so no
 * DOMParser global either): every tag balances, and no unescaped & or <
 * appears in text content outside a comment. Not a full XML validator, but
 * catches the real classes of generator bugs — mismatched/unclosed tags,
 * unescaped text.
 */
function assertWellFormedXml(xml: string) {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, "");
  const stack: string[] = [];
  const tagRe = /<\/?([a-zA-Z_][\w:.-]*)\b[^>]*?(\/?)>/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = tagRe.exec(withoutComments))) {
    const between = withoutComments.slice(lastIndex, match.index);
    expect(between).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/);
    expect(between).not.toMatch(/<(?![!?])/);
    lastIndex = tagRe.lastIndex;
    const full = match[0];
    const name = match[1];
    const selfClosing = full.endsWith("/>") || match[2] === "/";
    if (full.startsWith("</")) {
      expect(stack.pop()).toBe(name);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  expect(stack).toEqual([]);
}

describe("mapBalanceSheetFacts — real Bharat Industries Limited data", () => {
  const mapping = mapBalanceSheetFacts(BHARAT_BS_ROWS, BHARAT_RETAINED_PROFIT);

  it("buckets current-asset ledger_role rows to their Schedule III captions with exact amounts", () => {
    const byElement = Object.fromEntries(mapping.assets.map((f) => [f.element, f.amount]));
    expect(byElement["in-gaap:CashAndCashEquivalents"]).toBeCloseTo(485000, 2);
    expect(byElement["in-gaap:TradeReceivablesCurrent"]).toBeCloseTo(53780, 2);
  });

  it("nets the six Duties & Taxes ledgers into Other Current Liabilities exactly (-7200-7200+6300+6300+1180+5000)", () => {
    const other = mapping.liabilities.find((f) => f.element === "in-gaap:OtherCurrentLiabilitiesCurrent");
    expect(other?.amount).toBeCloseTo(4380, 2);
  });

  it("folds the legacy 'capital' nature into Other Shareholders' Funds and creditor into Trade Payables", () => {
    const shf = mapping.liabilities.find((f) => f.element === "in-gaap:OtherShareholdersFunds");
    const tp = mapping.liabilities.find((f) => f.element === "in-gaap:TradePayablesCurrent");
    expect(shf?.amount).toBeCloseTo(500000, 2);
    expect(tp?.amount).toBeCloseTo(94400, 2);
  });

  it("adds retained profit into Reserves and Surplus, matching the balance-sheet report page's own carry-forward figure", () => {
    const rs = mapping.liabilities.find((f) => f.element === "in-gaap:ReservesAndSurplus");
    expect(rs?.amount).toBeCloseTo(-60000, 2);
  });

  it("Total Assets equals Total Equity and Liabilities — the real company's books genuinely balance", () => {
    expect(mapping.totalAssets).toBeCloseTo(538780, 2);
    expect(mapping.totalEquityAndLiabilities).toBeCloseTo(538780, 2);
    expect(Math.abs(mapping.totalAssets - mapping.totalEquityAndLiabilities)).toBeLessThan(0.01);
  });
});

describe("mapBalanceSheetFacts — real Nexgen data that does NOT balance", () => {
  // Nexgen's own retained profit for the same period, live-computed the
  // same way: 70000 - 80000 - 50000 = -60000 (identical P&L to Bharat's —
  // both seeded from the same template).
  const mapping = mapBalanceSheetFacts(NEXGEN_BS_ROWS, -60000);

  it("still sums every real row correctly even though the source data is unbalanced", () => {
    // 2,000,000 + 150,000 + 600,000 + 300,000
    const ltb = mapping.liabilities.find((f) => f.element === "in-gaap:OtherLongTermLiabilities");
    expect(ltb?.amount).toBeCloseTo(3050000, 2);
    expect(mapping.totalAssets).toBeCloseTo(638780, 2);
    expect(mapping.totalEquityAndLiabilities).toBeCloseTo(3588780, 2);
    // The real, live gap this feature's own build report calls out — not
    // hidden by the mapping, and exactly what the download panel's own
    // pre-flight balance check (Aoc4XbrlPanel.generateBalanceSheet) uses to
    // refuse the download rather than ship a silently wrong instance.
    expect(mapping.totalAssets - mapping.totalEquityAndLiabilities).toBeCloseTo(-2950000, 2);
  });
});

describe("mapProfitAndLossFacts — real Bharat Industries Limited data", () => {
  const mapping = mapProfitAndLossFacts(BHARAT_PL_ROWS);

  it("tags Revenue from Operations and the expense aggregate with exact live amounts", () => {
    const byElement = Object.fromEntries(mapping.facts.map((f) => [f.element, f.amount]));
    expect(byElement["in-gaap:RevenueFromOperations"]).toBeCloseTo(70000, 2);
    expect(byElement["in-gaap:TotalExpenses"]).toBeCloseTo(130000, 2); // 80000 + 50000
    expect(byElement["in-gaap:OtherIncome"]).toBeUndefined(); // none posted — correctly omitted, not zero-padded
  });

  it("computes Profit/Loss for the Period matching the balance sheet's own retained-profit figure", () => {
    expect(mapping.totalIncome).toBeCloseTo(70000, 2);
    expect(mapping.totalExpenses).toBeCloseTo(130000, 2);
    expect(mapping.profitForPeriod).toBeCloseTo(BHARAT_RETAINED_PROFIT, 2);
  });
});

describe("XBRL instance document assembly", () => {
  const bsMapping = mapBalanceSheetFacts(BHARAT_BS_ROWS, BHARAT_RETAINED_PROFIT);
  const plMapping = mapProfitAndLossFacts(BHARAT_PL_ROWS);
  const cin = "L74999MH2010PLC205678"; // live-set on Bharat Industries Limited for this feature

  const bsXml = buildBalanceSheetInstance({
    cin,
    mapping: bsMapping,
    comparativeMapping: null,
    asAt: "2026-08-26",
    comparativeAsAt: null,
  });
  const plXml = buildProfitAndLossInstance({
    cin,
    mapping: plMapping,
    comparativeMapping: null,
    from: "2026-04-01",
    to: "2026-08-26",
    comparativeFrom: null,
    comparativeTo: null,
  });

  it("produces well-formed XML for both instance documents", () => {
    assertWellFormedXml(bsXml);
    assertWellFormedXml(plXml);
  });

  it("uses the confirmed MCA entity identifier scheme (http://www.mca.gov.in/CIN) with the real CIN as the identifier", () => {
    expect(bsXml).toContain(`scheme="${ENTITY_SCHEME}">${cin}<`);
    expect(plXml).toContain(`scheme="${ENTITY_SCHEME}">${cin}<`);
  });

  it("balance sheet instance uses an instant period; P&L instance uses a duration period", () => {
    expect(bsXml).toContain("<xbrli:instant>2026-08-26</xbrli:instant>");
    expect(bsXml).not.toContain("<xbrli:startDate>");
    expect(plXml).toContain("<xbrli:startDate>2026-04-01</xbrli:startDate><xbrli:endDate>2026-08-26</xbrli:endDate>");
    expect(plXml).not.toContain("<xbrli:instant>");
  });

  it("emits the exact tagged monetary values found live, decimals=2, one shared INR unit", () => {
    expect(bsXml).toContain('<in-gaap:CashAndCashEquivalents contextRef="AsAt_CurrentYear" unitRef="INR" decimals="2">485000.00</in-gaap:CashAndCashEquivalents>');
    expect(bsXml).toContain('<in-gaap:TradeReceivablesCurrent contextRef="AsAt_CurrentYear" unitRef="INR" decimals="2">53780.00</in-gaap:TradeReceivablesCurrent>');
    expect(bsXml).toContain('<in-gaap:TotalAssets contextRef="AsAt_CurrentYear" unitRef="INR" decimals="2">538780.00</in-gaap:TotalAssets>');
    expect(bsXml).toContain('<in-gaap:TotalEquityAndLiabilities contextRef="AsAt_CurrentYear" unitRef="INR" decimals="2">538780.00</in-gaap:TotalEquityAndLiabilities>');
    expect(plXml).toContain('<in-gaap:RevenueFromOperations contextRef="Duration_CurrentYear" unitRef="INR" decimals="2">70000.00</in-gaap:RevenueFromOperations>');
    expect(plXml).toContain('<in-gaap:TotalExpenses contextRef="Duration_CurrentYear" unitRef="INR" decimals="2">130000.00</in-gaap:TotalExpenses>');
    expect(plXml).toContain('<in-gaap:ProfitLossForPeriod contextRef="Duration_CurrentYear" unitRef="INR" decimals="2">-60000.00</in-gaap:ProfitLossForPeriod>');
    expect(bsXml.match(/<xbrli:unit id="INR">/g)?.length).toBe(1);
  });

  it("carries the explicit unverified-taxonomy warning in the document header", () => {
    expect(bsXml).toContain("UNVERIFIED");
    expect(bsXml).toContain("DRAFT, NOT FILING-READY");
  });
});

describe("escapeXml", () => {
  it("escapes all five XML special characters", () => {
    expect(escapeXml(`A & B < C > "D" 'E'`)).toBe("A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos;");
  });
});
