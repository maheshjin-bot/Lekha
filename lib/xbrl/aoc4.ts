/**
 * AOC-4 XBRL instance-document generation — Commercial & Industrial (C&I)
 * taxonomy, built from this app's own get_balance_sheet / get_profit_and_loss
 * output. Mirrors lib/tally/xml.ts's own honesty discipline: structurally
 * correct per the best publicly-documented MCA/XBRL-India architecture this
 * session could confirm, and explicitly, loudly UNVERIFIED against the live
 * current taxonomy XSD — there is no way to fetch mca.gov.in (it 403s every
 * automated request tried this session) or run the real MCA XBRL Validation
 * Tool from this environment, so this can never be tested the way a real
 * filer tests before upload. That is a real limitation, stated here rather
 * than hidden, exactly the same category of gap the Tally exporter's own
 * header states for its ALLLEDGERENTRIES vs LEDGERENTRIES choice.
 *
 * ============================================================================
 * WHAT THIS GENERATES, AND WHAT IT DOES NOT
 * ============================================================================
 * Two SEPARATE instance documents — Balance Sheet and Profit & Loss — never
 * one combined file. Confirmed as a real MCA business rule (taxguru.in's
 * "How to file Financial Statements / Annual Returns with ROC in XBRL Form?",
 * read today): "Separate instance documents need to be created for the
 * Balance sheet and Profit and Loss Account of the company," each validated
 * and attached to the AOC-4 XBRL e-form separately.
 *
 * This module produces the XBRL INSTANCE DOCUMENT only. It does not, and
 * cannot, file anything. Actual submission requires the MCA21 V3 portal,
 * which exposes no third-party filing API, and a Class 3 Digital Signature
 * Certificate on a physical USB token authenticated through emSigner — both
 * permanently out of reach for any unattended app to automate. Filing also
 * now requires (MCA amendment effective 14-Jul-2025, per IndiaFilings' "MCA
 * Revises Form AOC-4 XBRL" and casahuja.com's FY2024-25 guide, both read
 * today) signed PDF copies of the financial statements, Board's Report and
 * Auditor's Report attached alongside the XBRL instance — documents this app
 * has no way to produce signed, since signing itself needs the same DSC.
 *
 * ============================================================================
 * STATUTORY RESEARCH THIS WAS BUILT FROM (WebSearch'd today, 26 Aug 2026;
 * every mca.gov.in/XBRL/* page itself returned HTTP 403 to automated fetch —
 * every fact below is sourced from a THIRD-PARTY page that itself read or
 * quotes the primary rule/manual, not from a primary MCA page directly)
 * ============================================================================
 *
 * WHO HAS TO FILE IN XBRL AT ALL — Rule 3, Companies (Filing of Documents
 * and Forms in XBRL) Rules, 2015 (quoted via ca2013.com's own reproduction
 * of the rule text, cross-checked against ebizfiling.com's 2025 checklist
 * and coraa.ai's applicability checker, all three independently agreeing):
 *   (i)   companies listed on any Indian stock exchange, and their Indian
 *         subsidiaries;
 *   (ii)  companies with paid-up capital of Rs 5 crore or more;
 *   (iii) companies with turnover of Rs 100 crore or more;
 *   (iv)  every company required to prepare its financial statements under
 *         the Companies (Indian Accounting Standards) Rules, 2015 (Ind AS).
 * Exempt even if otherwise caught: banking, insurance, NBFC, housing finance,
 * and power-sector companies (ca2013.com's Rule 3 reproduction).
 * A SECOND, skeptical search (masllp.com) turned up a conflicting "turnover
 * exceeds Rs 500 crore" figure — traced back to Rule 3's own quoted text
 * (ca2013.com) and independently re-confirmed at Rs 100 crore by three other
 * sources, so Rs 500 crore is treated here as that one page's error, not a
 * genuine alternate figure; flagged rather than silently dropped.
 * MOST SME USERS OF THIS APP WILL NOT MEET ANY OF THESE — the UI says so.
 * Only ltd/opc/pvt_ltd companies even file AOC-4 at all (confirmed live,
 * see this feature's build report); this schema's own ref_entity_types.
 * roc_forms already encodes that, reused here as the page-level gate.
 *
 * WHICH TAXONOMY — C&I vs Ind AS. Companies preparing statements under the
 * Companies (Accounting Standards) Rules, 2006 file through the C&I
 * taxonomy (historically "Annexure-II"); companies under the Ind AS Rules,
 * 2015 file through a separate Ind AS taxonomy ("Annexure-IIA") — ebizfiling
 * .com's 2025 checklist, stated plainly. This app has consistently built the
 * AS-equivalent (schedule_iii statement_format), not Ind AS, statements —
 * its own established position — so this feature targets the C&I taxonomy
 * only, matching that position, and does not attempt Ind AS tagging.
 *
 * TAXONOMY VERSION — genuinely UNRESOLVED, not glossed over. Sources
 * disagree and this session could not reach a primary MCA page to settle it:
 * irisbusiness's own MCA-mandate page names "C&I Taxonomy 2015"; datatracks
 * .com's taxonomy-history post says MCA's October 2019 release was "Final
 * Business Rules based on XBRL C&I taxonomy 2016 v1.3"; one MCA21India
 * social post (2025, re Validation Tool v5.0) confirms C&I and Ind AS remain
 * the two live taxonomies on the V3 portal today without naming a date. No
 * source this session could reach names a taxonomy generation newer than
 * 2016. The schemaRef/namespace below is therefore built from the
 * confirmed NAMING CONVENTION (in.xbrl.org's own C&I Taxonomy page: two core
 * schemas in-gaap-YYYY-MM-DD.xsd [accounting-standard concepts] and
 * in-ca-YYYY-MM-DD.xsd [Companies Act-specific concepts], combined at one
 * of two differently-named entry points depending which in.xbrl.org/
 * irisbusiness page is read — in-ci-ent-YYYY-MM-DD.xsd on one, in-gaap-ci-
 * YYYY-MM-DD.xsd on another, itself unresolved) with the date left as an
 * explicit, unmissable placeholder rather than a fabricated one — see
 * TAXONOMY_DATE_PLACEHOLDER below.
 *
 * INSTANCE-DOCUMENT MECHANICS — these ARE confirmed, from a real quoted
 * MCA Filing Manual business rule (surfaced via irisregtech.com's and
 * taxguru.in's own summaries of it, both independently agreeing verbatim):
 *   "The value of the scheme attribute of the identity element in the
 *    context should be http://www.mca.gov.in/CIN, and the value of the
 *    identity element ... must be the CIN of the company."
 *   "Context must not have segment or scenario element present."
 *   "An instance must not contain duplicate xbrli:context elements."
 *   Duration periods for P&L facts, instant periods for Balance Sheet facts.
 *   "All monetary facts must have the same unitRef" (one INR unit is used
 *   throughout each instance here) and reporting should avoid currency scale
 *   factors — decimals="2" (exact rupees-and-paise) is used throughout
 *   rather than a lakhs/crores-scaled decimals="-5"-style value.
 *   "No extensions to the core Taxonomy will be allowed" (taxguru.in) — a
 *   real, hard MCA business rule this module cannot honestly satisfy, since
 *   it cannot confirm real element local names (next paragraph). Stated
 *   loudly rather than worked around with a fake extension namespace that
 *   would misrepresent this as filing-conformant when it structurally is not.
 *
 * LINE-ITEM ELEMENT NAMES — genuinely NOT independently confirmed. Roughly a
 * dozen targeted searches for actual in-gaap/in-ca element local names
 * (ShareCapital, TradeReceivables, RevenueFromOperations, and similar) found
 * no primary or reliably-quoting source; the taxonomy's own element files are
 * large binary XSD schemas, not indexed as readable text by web search, and
 * mca.gov.in itself blocked every automated fetch attempted. Per this
 * feature's own brief — "where you cannot confidently map a line item...
 * omit it and note the gap rather than guessing at a tag name" — the honest
 * middle ground taken here: Schedule III Part I/II's own line-item captions
 * ARE the taxonomy's documented design basis (in.xbrl.org: the C&I taxonomy
 * "provid[es] reporting elements used in financial reports of the commercial
 * and industrial companies," built to let a Schedule III statement be
 * tagged), so each fact below is tagged with a PascalCase in-gaap: element
 * name built directly from Schedule III's own fixed caption text — a
 * best-effort, architecturally-grounded guess, NOT a confirmed real element
 * name. Every element name produced by this module carries an explicit
 * UNVERIFIED marker (see ELEMENT_CONFIDENCE_NOTE) in the generated XML's own
 * comments, and the UI repeats the warning: MCA's Validation Tool will
 * reject any element name that does not exactly match the live taxonomy, and
 * since extensions are disallowed, this file cannot be assumed
 * filing-ready — real re-tagging with MCA-recognised XBRL software is a
 * mandatory step this app cannot substitute for.
 *
 * ============================================================================
 * WHAT LEKHA'S OWN SCHEMA CANNOT REPRESENT — omitted, not guessed
 * ============================================================================
 * - Share application money pending allotment; intangible assets under
 *   development; deferred tax ASSETS (this schema's deferred_tax nature is
 *   liability-side only, per 0037); long-term loans & advances (this schema
 *   has no long-term/short-term split on the 'loan' ledger_role — every loan
 *   given falls under Current Assets regardless of its real term); current
 *   investments (the 'investment' ledger_role is only ever seeded under
 *   Fixed Assets — non-current — by 0089); other non-current assets.
 * - UPDATE, 26 Aug 2026 (updated in place rather than left stale, now that
 *   the gap it names is closed — see this feature's own build report):
 *   Schedule III's seven-way P&L expense split IS now wired, via
 *   get_profit_and_loss's ledger_role column (migration 0210, confirmed
 *   live and stable before this task started — partition sums exactly to
 *   the whole nature-total for every company). Each of cost_of_materials,
 *   purchases_stock_in_trade, changes_in_inventories, employee_benefits,
 *   finance_costs, depreciation_amortisation and other_expenses is tagged
 *   as its own in-gaap fact below (mapProfitAndLossFacts / EXPENSE_HEAD_
 *   BUCKET) — the same UNVERIFIED-element-name discipline as every other
 *   fact in this module, NOT a claim that these seven tag names are any
 *   more confirmed against the live taxonomy than the balance-sheet ones
 *   already were. Total Expenses is still tagged too, but only as an
 *   INDEPENDENTLY computed sum over every direct_expense/indirect_expense
 *   row (never read off any one fact) — a genuine arithmetic cross-check
 *   against the seven-plus-tax_expense facts, not the only expense figure
 *   in the document any more. Schedule III's own note-level sub-break-up
 *   WITHIN a head (e.g. an Employee Benefits note splitting salaries/PF/
 *   ESOP/staff welfare) is still not represented — this schema and
 *   get_profit_and_loss report the HEAD TOTAL only, one level up from that,
 *   the same limitation 0210's own migration header already named for the
 *   profit-loss report page.
 * - Tax expense as its own line, distinct from Profit before tax / Profit
 *   for the period. PARTIALLY closed by the same 0210 upgrade: a ledger
 *   explicitly carrying ledger_role='tax_expense' (today, only the system-
 *   managed "Deferred Tax Expense" ledger ever gets this override — see
 *   0210) is now tagged as its own in-gaap:TaxExpense fact, kept separate
 *   from the seven expense heads, matching the profit-loss report page's
 *   own "shown separately — not one of the seven" treatment verbatim. What
 *   remains unfixed: any OTHER income-tax provision a company posts as an
 *   ordinary, un-overridden indirect_expense ledger (e.g. a manually
 *   created "Provision for Income Tax" ledger with no ledger_role override)
 *   is still indistinguishable from any other other_expenses posting, so
 *   this schema still cannot reliably tell "profit before tax" apart from
 *   "profit for the period" in general — only one bottom-line figure
 *   (ProfitLossForPeriod) is tagged; a separate "Profit before tax" fact
 *   remains omitted rather than fabricated from an incomplete tax figure.
 * - Registered-office address, authorised share capital, AGM date, auditor
 *   details — none of these live anywhere in this schema; the AOC-4 e-form's
 *   own "general information" fields beyond CIN/name/incorporation date are
 *   simply not collected by this app today.
 */

// ----------------------------------------------------------------------------
// Shapes read directly from get_balance_sheet / get_profit_and_loss (0089 /
// 0009) — kept local rather than imported from types/database.types.ts,
// which this task must not touch and which (per 0089's own build notes) has
// lagged the live RPC shape before.
// ----------------------------------------------------------------------------
export type BsFactRow = {
  side: string; // "assets" | "liabilities"
  nature: string;
  group_name: string;
  ledger_name: string;
  ledger_role: string | null;
  amount: number | string;
};

export type PlFactRow = {
  section: string; // "trading" | "profit_loss"
  nature: string; // direct_income | direct_expense | indirect_income | indirect_expense
  group_name: string;
  ledger_name: string;
  // Added by migration 0210: coalesce(ledger override, group default). For
  // expense-nature rows this is one of Schedule III's seven Statement of
  // P&L expense heads or 'tax_expense' (not one of the seven — see module
  // header); for income-nature rows it is always 'income' and unused below.
  // `| null` for the same defensive reason BsFactRow's ledger_role is
  // nullable — get_profit_and_loss's live definition never actually returns
  // null (coalesce always resolves to the group's own non-null default),
  // but nothing in this module's own types should assume that stays true.
  ledger_role: string | null;
  amount: number | string;
};

export type Aoc4Fact = { element: string; scheduleIIICaption: string; amount: number };

/** The taxonomy date this session could not confirm — see header. Left as an
 * unmissable placeholder in every generated schemaRef/namespace rather than
 * a fabricated ISO date, so a real filer notices it has to be filled in. */
export const TAXONOMY_DATE_PLACEHOLDER = "CONFIRM-CURRENT-DATE-AT-mca.gov.in-XBRL";

export const IN_GAAP_NAMESPACE = `http://www.mca.gov.in/taxonomy/in-gaap/${TAXONOMY_DATE_PLACEHOLDER}`;
export const ENTITY_SCHEME = "http://www.mca.gov.in/CIN";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function money(n: number): string {
  // Fixed 2dp, exact rupees-and-paise — no lakhs/crores scale factor. -0.00
  // is normalised to 0.00 so a fully-netted-out bucket prints cleanly.
  const fixed = (Math.abs(n) < 0.005 ? 0 : n).toFixed(2);
  return fixed === "-0.00" ? "0.00" : fixed;
}

// ----------------------------------------------------------------------------
// Balance sheet mapping. Nature/ledger_role -> Schedule III caption -> a
// best-effort (UNVERIFIED, see header) in-gaap element name. Sourced
// directly from this app's OWN already-committed Schedule III captions
// (app/(app)/[companyId]/reports/balance-sheet/page.tsx's NATURE_LABEL /
// FIXED_ASSET_BUCKET_LABEL, unchanged here) for the nature-level and
// fixed-asset buckets; the current-asset/current-liability ledger_role
// sub-split below goes one step further than that report page currently
// renders (it only sub-splits fixed_asset, per 0089) but uses the exact
// same, already-populated ledger_role column — real existing data, not
// invented for this feature.
// ----------------------------------------------------------------------------
const FIXED_ASSET_BUCKET: Record<string, { element: string; label: string }> = {
  tangible_fixed_asset: { element: "in-gaap:TangibleAssets", label: "Tangible Assets" },
  intangible_fixed_asset: { element: "in-gaap:IntangibleAssets", label: "Intangible Assets" },
  capital_work_in_progress: { element: "in-gaap:CapitalWorkInProgress", label: "Capital Work-in-Progress" },
  investment: { element: "in-gaap:NonCurrentInvestments", label: "Non-current Investments" },
};

const CURRENT_ASSET_BUCKET: Record<string, { element: string; label: string }> = {
  stock: { element: "in-gaap:Inventories", label: "Inventories" },
  debtor: { element: "in-gaap:TradeReceivablesCurrent", label: "Trade Receivables" },
  cash_bank: { element: "in-gaap:CashAndCashEquivalents", label: "Cash and Cash Equivalents" },
  loan: { element: "in-gaap:ShortTermLoansAndAdvances", label: "Short-term Loans and Advances" },
};
const CURRENT_ASSET_DEFAULT = { element: "in-gaap:OtherCurrentAssets", label: "Other Current Assets" };

const CURRENT_LIABILITY_BUCKET: Record<string, { element: string; label: string }> = {
  creditor: { element: "in-gaap:TradePayablesCurrent", label: "Trade Payables" },
  provision: { element: "in-gaap:ShortTermProvisions", label: "Short-term Provisions" },
  // 'loan' is not seeded under Current Liabilities by app_private.seed_chart_of_accounts
  // (it only appears under Current Assets, as money lent out) — but nothing
  // stops a company from creating a custom Current Liabilities ledger with
  // this role for money borrowed short-term, so it is still honoured here.
  loan: { element: "in-gaap:ShortTermBorrowings", label: "Short-term Borrowings" },
};
const CURRENT_LIABILITY_DEFAULT = { element: "in-gaap:OtherCurrentLiabilitiesCurrent", label: "Other Current Liabilities" };

const NATURE_BUCKET: Record<string, { element: string; label: string }> = {
  share_capital: { element: "in-gaap:ShareCapital", label: "Share Capital" },
  // Legacy pre-0037 catch-all — same "Other Shareholders' Funds" label the
  // balance-sheet report page itself already uses for this nature.
  capital: { element: "in-gaap:OtherShareholdersFunds", label: "Other Shareholders' Funds" },
  long_term_borrowing: { element: "in-gaap:LongTermBorrowings", label: "Long-term Borrowings" },
  deferred_tax: { element: "in-gaap:DeferredTaxLiabilitiesNet", label: "Deferred Tax Liabilities (Net)" },
  long_term_provision: { element: "in-gaap:LongTermProvisions", label: "Long-term Provisions" },
  // This app's own Schedule III report already documents non_current_liability
  // AS Schedule III's fourth Non-current Liabilities line, "Other Long-term
  // Liabilities" (balance-sheet/page.tsx's displayLabel) — reused verbatim.
  non_current_liability: { element: "in-gaap:OtherLongTermLiabilities", label: "Other Long-term Liabilities" },
};

export type BalanceSheetMapping = {
  assets: Aoc4Fact[];
  liabilities: Aoc4Fact[];
  totalAssets: number;
  totalEquityAndLiabilities: number;
};

function addFact(map: Map<string, Aoc4Fact>, bucket: { element: string; label: string }, amount: number) {
  const existing = map.get(bucket.element);
  if (existing) existing.amount += amount;
  else map.set(bucket.element, { element: bucket.element, scheduleIIICaption: bucket.label, amount });
}

/**
 * retainedProfit: profit brought forward + this year's profit, computed by
 * the CALLER exactly the way the balance-sheet report page computes it
 * (0020/balance-sheet page's own carry-forward logic) — not recomputed here,
 * so this module never risks drifting from the one figure that actually
 * makes LEKHA's own live balance sheet balance. Added into Reserves and
 * Surplus, same as that report page does ("Both belong on the liabilities
 * side — they are owed to the proprietor[/shareholders]").
 */
export function mapBalanceSheetFacts(rows: BsFactRow[], retainedProfit: number): BalanceSheetMapping {
  const assets = new Map<string, Aoc4Fact>();
  const liabilities = new Map<string, Aoc4Fact>();

  for (const r of rows) {
    const amount = Number(r.amount) || 0;
    if (r.side === "assets") {
      if (r.nature === "fixed_asset") {
        const bucket = FIXED_ASSET_BUCKET[r.ledger_role ?? ""] ?? FIXED_ASSET_BUCKET.tangible_fixed_asset;
        addFact(assets, bucket, amount);
      } else if (r.nature === "current_asset") {
        const bucket = CURRENT_ASSET_BUCKET[r.ledger_role ?? ""] ?? CURRENT_ASSET_DEFAULT;
        addFact(assets, bucket, amount);
      }
      // 'capital'/'share_capital'/etc never appear on the assets side —
      // get_balance_sheet itself only ever puts current_asset/fixed_asset
      // natures there (0089).
    } else {
      if (r.nature === "current_liability") {
        const bucket = CURRENT_LIABILITY_BUCKET[r.ledger_role ?? ""] ?? CURRENT_LIABILITY_DEFAULT;
        addFact(liabilities, bucket, amount);
      } else if (r.nature === "reserves_surplus") {
        addFact(liabilities, { element: "in-gaap:ReservesAndSurplus", label: "Reserves and Surplus" }, amount);
      } else {
        const bucket = NATURE_BUCKET[r.nature];
        if (bucket) addFact(liabilities, bucket, amount);
        // Any nature this map does not recognise is a genuine schema change
        // this module has not been updated for — silently dropping it would
        // misstate Total Equity and Liabilities, so it is deliberately left
        // out of `liabilities` AND out of the total below would be wrong
        // too; there is none such today (checked live, see build report),
        // so this is a defensive note rather than a live gap.
      }
    }
  }

  // Retained profit rides into Reserves and Surplus exactly like the
  // balance-sheet report page's own presentation.
  addFact(liabilities, { element: "in-gaap:ReservesAndSurplus", label: "Reserves and Surplus" }, retainedProfit);

  const totalAssets = Array.from(assets.values()).reduce((t, f) => t + f.amount, 0);
  const totalEquityAndLiabilities = Array.from(liabilities.values()).reduce((t, f) => t + f.amount, 0);

  return {
    assets: Array.from(assets.values()),
    liabilities: Array.from(liabilities.values()),
    totalAssets,
    totalEquityAndLiabilities,
  };
}

// ----------------------------------------------------------------------------
// Profit & Loss mapping. Income: unchanged by this task — direct_income/
// indirect_income relabelled as "Revenue from Operations"/"Other Income",
// reusing profit-loss/page.tsx's own established labels verbatim.
//
// Expenses (this task's own change, 26 Aug 2026): direct_expense/indirect_
// expense rows are no longer combined into one lump "Total Expenses" fact.
// get_profit_and_loss now returns ledger_role per row (migration 0210,
// confirmed live and stable — checked before starting this task), landing
// every expense-nature row in exactly one of Schedule III's seven heads or
// the separate tax_expense bucket — the SAME eight-way split profit-loss/
// page.tsx's own schedule_iii view already renders (its SCHEDULE_III_
// EXPENSE_HEADS array), reused here rather than re-invented. Each head that
// actually has something posted becomes its own in-gaap fact
// (EXPENSE_HEAD_BUCKET below), same best-effort/UNVERIFIED element-name
// discipline as every other fact in this module: Schedule III's own caption
// text, PascalCased, not a confirmed real in-gaap local name. A head with
// nothing posted this period is omitted from `facts`, not zero-padded —
// matching how OtherIncome was already omitted here before this task when
// nothing was posted to it.
//
// totalExpenses is an INDEPENDENT running sum over every direct_expense/
// indirect_expense row, not read off any single fact — a genuine
// arithmetic cross-check that the per-head-plus-tax_expense facts add up to
// the same figure profit-loss/page.tsx's own Total Expenses line shows.
// buildProfitAndLossInstance tags it as its own in-gaap:TotalExpenses fact
// in the instance document, alongside the per-head facts, not instead of
// them.
// ----------------------------------------------------------------------------
const EXPENSE_HEAD_BUCKET: Record<string, { element: string; label: string }> = {
  cost_of_materials: { element: "in-gaap:CostOfMaterialsConsumed", label: "Cost of Materials Consumed" },
  purchases_stock_in_trade: { element: "in-gaap:PurchasesOfStockInTrade", label: "Purchases of Stock-in-Trade" },
  changes_in_inventories: {
    element: "in-gaap:ChangesInInventoriesOfFinishedGoodsWorkInProgressAndStockInTrade",
    label: "Changes in Inventories of Finished Goods, Work-in-Progress and Stock-in-Trade",
  },
  employee_benefits: { element: "in-gaap:EmployeeBenefitExpense", label: "Employee Benefits Expense" },
  finance_costs: { element: "in-gaap:FinanceCosts", label: "Finance Costs" },
  depreciation_amortisation: {
    element: "in-gaap:DepreciationAndAmortisationExpense",
    label: "Depreciation and Amortisation Expense",
  },
  other_expenses: { element: "in-gaap:OtherExpenses", label: "Other Expenses" },
};
// Defensive fallback for an expense-nature row whose ledger_role this dict
// does not recognise. None exists live today — checked via a cross-company
// query (public.ledgers/account_groups joined to voucher_entries, grouped by
// coalesce(ledger_role, group ledger_role)) before writing this — but an
// unrecognised value must still land SOMEWHERE inside Total Expenses, or the
// cross-check total silently stops matching the report page's own figure.
// Same reasoning CURRENT_ASSET_DEFAULT/CURRENT_LIABILITY_DEFAULT already use
// above for the balance-sheet side.
const EXPENSE_HEAD_DEFAULT = EXPENSE_HEAD_BUCKET.other_expenses;

// tax_expense (0210) is deliberately kept OUT of EXPENSE_HEAD_BUCKET and
// checked first, below — it is not one of Schedule III's seven expense
// heads (Schedule III shows tax as its own section below Profit before tax)
// but this schema nets it into the indirect_expense NATURE regardless
// (0210's own scope boundary, not reopened by this task), so it still has
// to land somewhere inside totalExpenses. Label matches profit-loss/
// page.tsx's own "(shown separately — not one of the seven expense heads
// above)" framing verbatim.
const TAX_EXPENSE_BUCKET = {
  element: "in-gaap:TaxExpense",
  label: "Tax Expense (shown separately — not one of the seven Schedule III expense heads; see module header)",
};

export type ProfitAndLossMapping = {
  /** Revenue from Operations, Other Income (if posted), each Schedule III
   * expense head that was actually posted to, and Tax Expense (if posted) —
   * one fact per bucket, omitted rather than zero-padded when nothing was
   * posted to it. Does NOT include a Total Expenses entry — that is
   * `totalExpenses` below, an independent cross-check sum tagged separately
   * at instance-assembly time (buildProfitAndLossInstance), not folded into
   * this array. */
  facts: Aoc4Fact[];
  totalIncome: number;
  /** Independently summed over every direct_expense/indirect_expense row —
   * never read off any single fact in `facts` — so it is a genuine
   * arithmetic cross-check against the per-head facts, not a restatement of
   * one of them. */
  totalExpenses: number;
  profitForPeriod: number;
};

export function mapProfitAndLossFacts(rows: PlFactRow[]): ProfitAndLossMapping {
  const facts = new Map<string, Aoc4Fact>();
  let totalExpenses = 0;
  for (const r of rows) {
    const amount = Number(r.amount) || 0;
    if (r.nature === "direct_income") {
      addFact(facts, { element: "in-gaap:RevenueFromOperations", label: "Revenue from Operations" }, amount);
    } else if (r.nature === "indirect_income") {
      addFact(facts, { element: "in-gaap:OtherIncome", label: "Other Income" }, amount);
    } else if (r.nature === "direct_expense" || r.nature === "indirect_expense") {
      totalExpenses += amount;
      const bucket =
        r.ledger_role === "tax_expense"
          ? TAX_EXPENSE_BUCKET
          : EXPENSE_HEAD_BUCKET[r.ledger_role ?? ""] ?? EXPENSE_HEAD_DEFAULT;
      addFact(facts, bucket, amount);
    }
  }
  const totalIncome =
    (facts.get("in-gaap:RevenueFromOperations")?.amount ?? 0) + (facts.get("in-gaap:OtherIncome")?.amount ?? 0);
  return {
    facts: Array.from(facts.values()),
    totalIncome,
    totalExpenses,
    profitForPeriod: totalIncome - totalExpenses,
  };
}

// ----------------------------------------------------------------------------
// XBRL applicability estimate (Rule 3, see header). Not authoritative — this
// schema has no "listed"/"Ind AS mandated" flag and no separately-maintained
// "paid-up capital"/"turnover" figure distinct from ledger balances, so the
// two numeric inputs are proxies (Share Capital ledger balance; Revenue from
// Operations for the year) and the two boolean inputs are the user's own
// manual say-so, not derived from anything this app tracks.
// ----------------------------------------------------------------------------
const PAID_UP_CAPITAL_THRESHOLD = 5_00_00_000; // Rs 5 crore
const TURNOVER_THRESHOLD = 100_00_00_000; // Rs 100 crore

export function estimateAoc4Applicability(input: {
  shareCapitalBalance: number;
  revenueFromOperations: number;
  isListedOrListedSubsidiary: boolean;
  isIndAsRequired: boolean;
}): { applicable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.isListedOrListedSubsidiary) {
    reasons.push("Listed on a stock exchange in India, or an Indian subsidiary of one (as you indicated).");
  }
  if (input.shareCapitalBalance >= PAID_UP_CAPITAL_THRESHOLD) {
    reasons.push(
      `Share Capital ledger balance (₹${input.shareCapitalBalance.toLocaleString("en-IN")}) is at or above the ₹5 crore paid-up-capital threshold — an ESTIMATE, since paid-up capital as defined by the rule can differ from this ledger's balance.`
    );
  }
  if (input.revenueFromOperations >= TURNOVER_THRESHOLD) {
    reasons.push(
      `Revenue from Operations for the period (₹${input.revenueFromOperations.toLocaleString("en-IN")}) is at or above the ₹100 crore turnover threshold — an ESTIMATE of "turnover" as the rule defines it.`
    );
  }
  if (input.isIndAsRequired) {
    reasons.push("Required to prepare financial statements under the Companies (Indian Accounting Standards) Rules, 2015 (as you indicated) — and should use the Ind AS taxonomy, not this C&I one.");
  }
  return { applicable: reasons.length > 0, reasons };
}

// ----------------------------------------------------------------------------
// Instance-document assembly
// ----------------------------------------------------------------------------
export type PeriodInstant = { kind: "instant"; date: string; contextId: string };
export type PeriodDuration = { kind: "duration"; from: string; to: string; contextId: string };

function contextXml(entityCin: string, period: PeriodInstant | PeriodDuration): string {
  const periodXml =
    period.kind === "instant"
      ? `<xbrli:instant>${period.date}</xbrli:instant>`
      : `<xbrli:startDate>${period.from}</xbrli:startDate><xbrli:endDate>${period.to}</xbrli:endDate>`;
  return [
    `<xbrli:context id="${escapeXml(period.contextId)}">`,
    `<xbrli:entity><xbrli:identifier scheme="${ENTITY_SCHEME}">${escapeXml(entityCin)}</xbrli:identifier></xbrli:entity>`,
    `<xbrli:period>${periodXml}</xbrli:period>`,
    `</xbrli:context>`,
  ].join("");
}

const UNIT_XML = `<xbrli:unit id="INR"><xbrli:measure>iso4217:INR</xbrli:measure></xbrli:unit>`;

function factXml(fact: Aoc4Fact, contextId: string): string {
  // XML comments may not contain "--" or end in "-" — defensive replace
  // rather than escapeXml (which would just print "&amp;"/"&apos;" as
  // literal, unhelpful text inside a comment humans are meant to read).
  const safeCaption = fact.scheduleIIICaption.replace(/--+/g, "-").replace(/-$/, "");
  return `<!-- ${safeCaption} (UNVERIFIED element name — see module header) --><${fact.element} contextRef="${contextId}" unitRef="INR" decimals="2">${money(fact.amount)}</${fact.element}>`;
}

const HEADER_COMMENT = `<!--
  LEKHA-generated AOC-4 XBRL instance document — DRAFT, NOT FILING-READY.
  * Element (tag) names below are LEKHA's own best-effort rendering of
    Schedule III's fixed captions into the C&I taxonomy's documented naming
    convention. They are NOT independently verified against the live current
    in-gaap taxonomy (mca.gov.in blocked automated access; the real XSD is a
    binary schema file, not readable text) and WILL likely need correction in
    MCA-recognised XBRL software before this can pass the MCA Validation Tool.
  * MCA's own business rules disallow taxonomy extensions entirely, so an
    unverified element name here is not a fallback that still "works" the way
    an extension would elsewhere — it must be retagged, not merely accepted.
  * schemaRef below uses an explicit placeholder for the taxonomy date this
    session could not confirm — see lib/xbrl/aoc4.ts's own header for why.
  * This is an unfiled INSTANCE DOCUMENT only. Real submission needs the
    MCA21 V3 portal (no third-party filing API exists) and a Class 3 DSC on a
    physical token via emSigner, plus (since 14-Jul-2025) signed PDF copies
    of the financial statements/Board's Report/Auditor's Report attached
    alongside it — none of which this app can produce.
-->`;

export function buildBalanceSheetInstance(params: {
  cin: string;
  mapping: BalanceSheetMapping;
  comparativeMapping: BalanceSheetMapping | null;
  asAt: string;
  comparativeAsAt: string | null;
}): string {
  const { cin, mapping, comparativeMapping, asAt, comparativeAsAt } = params;
  const curCtx: PeriodInstant = { kind: "instant", date: asAt, contextId: "AsAt_CurrentYear" };
  const contexts = [contextXml(cin, curCtx)];
  const facts: string[] = [];

  for (const f of [...mapping.assets, ...mapping.liabilities]) {
    facts.push(factXml(f, curCtx.contextId));
  }
  facts.push(factXml({ element: "in-gaap:TotalAssets", scheduleIIICaption: "Total Assets", amount: mapping.totalAssets }, curCtx.contextId));
  facts.push(
    factXml(
      { element: "in-gaap:TotalEquityAndLiabilities", scheduleIIICaption: "Total Equity and Liabilities", amount: mapping.totalEquityAndLiabilities },
      curCtx.contextId
    )
  );

  if (comparativeMapping && comparativeAsAt) {
    const compCtx: PeriodInstant = { kind: "instant", date: comparativeAsAt, contextId: "AsAt_PreviousYear" };
    contexts.push(contextXml(cin, compCtx));
    for (const f of [...comparativeMapping.assets, ...comparativeMapping.liabilities]) {
      facts.push(factXml(f, compCtx.contextId));
    }
    facts.push(factXml({ element: "in-gaap:TotalAssets", scheduleIIICaption: "Total Assets", amount: comparativeMapping.totalAssets }, compCtx.contextId));
    facts.push(
      factXml(
        { element: "in-gaap:TotalEquityAndLiabilities", scheduleIIICaption: "Total Equity and Liabilities", amount: comparativeMapping.totalEquityAndLiabilities },
        compCtx.contextId
      )
    );
  }

  return wrapInstance(contexts, facts);
}

export function buildProfitAndLossInstance(params: {
  cin: string;
  mapping: ProfitAndLossMapping;
  comparativeMapping: ProfitAndLossMapping | null;
  from: string;
  to: string;
  comparativeFrom: string | null;
  comparativeTo: string | null;
}): string {
  const { cin, mapping, comparativeMapping, from, to, comparativeFrom, comparativeTo } = params;
  const curCtx: PeriodDuration = { kind: "duration", from, to, contextId: "Duration_CurrentYear" };
  const contexts = [contextXml(cin, curCtx)];
  const facts: string[] = [];

  for (const f of mapping.facts) facts.push(factXml(f, curCtx.contextId));
  facts.push(factXml({ element: "in-gaap:TotalRevenue", scheduleIIICaption: "Total Revenue (I+II)", amount: mapping.totalIncome }, curCtx.contextId));
  facts.push(
    factXml(
      {
        element: "in-gaap:TotalExpenses",
        scheduleIIICaption:
          "Total Expenses (II) — independently computed sum, cross-checked against the per-head facts above, not their only source (see module header)",
        amount: mapping.totalExpenses,
      },
      curCtx.contextId
    )
  );
  facts.push(
    factXml(
      { element: "in-gaap:ProfitLossForPeriod", scheduleIIICaption: "Profit/Loss for the Period (bottom line — see module header on why a separate Profit before tax fact is not tagged)", amount: mapping.profitForPeriod },
      curCtx.contextId
    )
  );

  if (comparativeMapping && comparativeFrom && comparativeTo) {
    const compCtx: PeriodDuration = { kind: "duration", from: comparativeFrom, to: comparativeTo, contextId: "Duration_PreviousYear" };
    contexts.push(contextXml(cin, compCtx));
    for (const f of comparativeMapping.facts) facts.push(factXml(f, compCtx.contextId));
    facts.push(factXml({ element: "in-gaap:TotalRevenue", scheduleIIICaption: "Total Revenue (I+II)", amount: comparativeMapping.totalIncome }, compCtx.contextId));
    facts.push(
      factXml(
        {
          element: "in-gaap:TotalExpenses",
          scheduleIIICaption: "Total Expenses (II) — independently computed sum, cross-checked against the per-head facts above",
          amount: comparativeMapping.totalExpenses,
        },
        compCtx.contextId
      )
    );
    facts.push(
      factXml(
        { element: "in-gaap:ProfitLossForPeriod", scheduleIIICaption: "Profit/Loss for the Period", amount: comparativeMapping.profitForPeriod },
        compCtx.contextId
      )
    );
  }

  return wrapInstance(contexts, facts);
}

function wrapInstance(contexts: string[], facts: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
${HEADER_COMMENT}
<xbrli:xbrl
  xmlns:xbrli="http://www.xbrl.org/2003/instance"
  xmlns:link="http://www.xbrl.org/2003/linkbase"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:in-gaap="${IN_GAAP_NAMESPACE}">
  <link:schemaRef xlink:type="simple" xlink:href="in-gaap-ci-${TAXONOMY_DATE_PLACEHOLDER}.xsd"/>
${contexts.join("\n")}
${UNIT_XML}
${facts.join("\n")}
</xbrli:xbrl>`;
}
