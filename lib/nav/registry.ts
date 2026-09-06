/**
 * The navigation registry.
 *
 * NavRail.tsx hard-codes every link it renders — five inline arrays, no data
 * anyone else can search, filter, or re-render from. This module is that
 * same set of links pulled out into typed data, so a command palette (or any
 * future "jump to…" UI) can search by what a user actually TYPES rather than
 * by the exact label a menu happens to use, and so a link only ever has to
 * be added in one place. NavRail itself is untouched by this file — it still
 * owns its own inline arrays until a later task re-points it here. Nothing
 * about that repointing is assumed by this module; it is plain, inert data.
 *
 * href convention: company-scoped routes carry the literal token
 * ":companyId" where NavRail today interpolates `${base}` — a consumer
 * resolves a real link with `entry.href.replace(":companyId", companyId)`.
 * Two routes are NOT company-scoped (a phone picks its own company at
 * /scan, and 2FA belongs to the person logging in, not any one company at
 * /security) — those carry their real absolute path outright and have no
 * ":companyId" token to replace, so treat replace() as a no-op for them
 * rather than assuming every href needs it.
 */

/** One of the ten top-level buckets this app's work sorts into. Chosen by
 * subject matter, not by URL shape — a GST return under /reports/ is
 * 'compliance', not 'reports'; a stock report under /reports/ is
 * 'inventory'. 'reports' is reserved for the core financial statements that
 * don't belong to any one domain (trial balance, P&L, ledger statement). */
export type Workspace =
  | "overview"
  | "sales"
  | "purchases"
  | "banking"
  | "inventory"
  | "payroll"
  | "compliance"
  | "reports"
  | "masters"
  | "setup";

export const WORKSPACES: { id: Workspace; label: string; description: string }[] = [
  { id: "overview", label: "Overview", description: "The dashboard and quick actions that don't belong to one domain." },
  { id: "sales", label: "Sales", description: "Invoicing, orders, price lists, and everything owed to you by customers." },
  { id: "purchases", label: "Purchases", description: "Bills, purchase orders, and everything owed to suppliers." },
  { id: "banking", label: "Banking", description: "Bank accounts, reconciliation, foreign currency, and bank/loan reporting." },
  { id: "inventory", label: "Inventory", description: "Stock items, godowns, batches, and physical stock movement." },
  { id: "payroll", label: "Payroll", description: "Employees, salary, leave, and statutory payroll compliance." },
  { id: "compliance", label: "Compliance", description: "GST, TDS/TCS, income tax, and ROC filings and registers." },
  { id: "reports", label: "Reports", description: "Core financial statements — trial balance, P&L, balance sheet, ledgers." },
  { id: "masters", label: "Masters", description: "Chart of accounts, cost centres, fixed assets, and other setup-once data." },
  { id: "setup", label: "Setup", description: "Company preferences, team, numbering, and account administration." },
];

/** A module code from ref_modules (`select code from ref_modules`), when a
 * link is meaningfully gated by one — omitted for core screens (ledgers,
 * vouchers, the core financial reports) that every company has regardless
 * of which optional/conditional modules it has turned on. */
export type ModuleCode =
  | "gst" | "gst_isd" | "gst_multistate" | "tds" | "tcs" | "income_tax"
  | "tax_audit" | "roc" | "fixed_assets" | "foreign_currency" | "msme"
  | "payroll" | "payroll_statutory" | "job_work" | "manufacturing"
  | "delivery_challan" | "exim" | "orders" | "pos" | "inventory"
  | "batch_serial" | "cost_centres" | "budgets" | "notices" | "ratios"
  | "stock_statement" | "tally_connector" | "documents" | "public_api"
  | "compliance_calendar" | "schedule_iii" | "bank_recon" | "audit_trail"
  | "year_end" | "csv_io";

export interface NavEntry {
  href: string;
  label: string;
  workspace: Workspace;
  /** What someone would TYPE to find this — Indian-accounting synonyms and
   * the Tally-equivalent name where one exists, not just words already in
   * the label. */
  keywords: string[];
  /** The accordion label this link sits under in NavRail today. Absent for
   * the standalone "Overview" link and the bottom account/settings list,
   * neither of which is inside an accordion. */
  group?: string;
  module?: ModuleCode;
}

const C = ":companyId";

// ---------------------------------------------------------------------------
// Overview — the one link NavRail renders above every accordion.
// ---------------------------------------------------------------------------

const overview: NavEntry = {
  href: `${C}`,
  label: "Overview",
  workspace: "overview",
  keywords: ["dashboard", "home"],
};

// ---------------------------------------------------------------------------
// Transactions — everything that creates or moves a voucher.
// ---------------------------------------------------------------------------

const transactions: NavEntry[] = [
  {
    href: `${C}/vouchers/new`,
    label: "New voucher",
    workspace: "overview",
    keywords: ["journal", "payment", "receipt", "contra", "entry", "transaction"],
    group: "Transactions",
  },
  {
    href: `${C}/invoices/new`,
    label: "New invoice",
    workspace: "sales",
    keywords: ["sales invoice", "bill", "tax invoice", "gst invoice"],
    group: "Transactions",
  },
  {
    href: `${C}/pos`,
    label: "Quick billing",
    workspace: "sales",
    keywords: ["point of sale", "pos", "counter sale", "retail billing", "quick bill"],
    group: "Transactions",
    module: "pos",
  },
  {
    href: `${C}/import`,
    label: "Import",
    workspace: "setup",
    keywords: ["csv import", "bulk upload", "migrate data"],
    group: "Transactions",
    module: "csv_io",
  },
  {
    href: `${C}/capture`,
    label: "Document inbox",
    workspace: "purchases",
    keywords: ["ocr", "scan bill", "upload receipt", "review queue"],
    group: "Transactions",
    module: "documents",
  },
  {
    // Not company-scoped: /scan picks its own company on the device and
    // deliberately carries none of this shell (see NavRail.tsx's own
    // comment on this link — preserved here as the same fact, not
    // re-derived).
    href: "/scan",
    label: "Scan on a phone",
    workspace: "purchases",
    keywords: ["mobile scan", "phone camera", "document scanner"],
    group: "Transactions",
    module: "documents",
  },
  {
    href: `${C}/orders`,
    label: "Orders",
    workspace: "sales",
    keywords: ["sales order", "purchase order", "po", "so", "quotation"],
    group: "Transactions",
    module: "orders",
  },
  {
    href: `${C}/forex`,
    label: "Foreign currency",
    workspace: "banking",
    keywords: ["fcy", "exchange rate", "as 11", "revaluation", "forex"],
    group: "Transactions",
    module: "foreign_currency",
  },
  {
    href: `${C}/job-work`,
    label: "Job work",
    workspace: "inventory",
    keywords: ["job work challan", "sec 143", "subcontract", "principal manufacturer"],
    group: "Transactions",
    module: "job_work",
  },
  {
    href: `${C}/manufacturing`,
    label: "Manufacturing",
    workspace: "inventory",
    keywords: ["bom", "bill of materials", "production voucher", "stock journal"],
    group: "Transactions",
    module: "manufacturing",
  },
  {
    href: `${C}/delivery-challans`,
    label: "Delivery challans",
    workspace: "inventory",
    keywords: ["rule 55", "dc", "goods movement", "stock transfer"],
    group: "Transactions",
    module: "delivery_challan",
  },
  {
    href: `${C}/exim`,
    label: "EXIM shipments",
    workspace: "compliance",
    keywords: ["export", "import", "shipping bill", "customs", "lut"],
    group: "Transactions",
    module: "exim",
  },
  {
    href: `${C}/recurring-vouchers`,
    label: "Recurring vouchers",
    workspace: "setup",
    keywords: ["auto voucher", "standing instruction", "template voucher", "schedule"],
    group: "Transactions",
  },
  {
    href: `${C}/service-advances`,
    label: "Service advances (GST)",
    workspace: "compliance",
    keywords: ["advance receipt", "gst advance", "time of supply"],
    group: "Transactions",
    module: "gst",
  },
  {
    href: `${C}/eway-bill`,
    label: "E-way bills",
    workspace: "compliance",
    keywords: ["ewb", "eway bill", "ewb-01", "transport", "part b"],
    group: "Transactions",
    module: "gst",
  },
  {
    href: `${C}/einvoice`,
    label: "E-invoices",
    workspace: "compliance",
    keywords: ["irn", "e-invoicing", "qr code", "irp"],
    group: "Transactions",
    module: "gst",
  },
  {
    href: `${C}/signature-requests`,
    label: "Signature requests",
    workspace: "setup",
    keywords: ["e-sign", "dsc signing", "digital signature", "document signing"],
    group: "Transactions",
  },
  {
    href: `${C}/stock-verification`,
    label: "Stock verification",
    workspace: "inventory",
    keywords: ["physical stock", "stock take", "stock count", "reconcile inventory"],
    group: "Transactions",
    module: "inventory",
  },
  {
    href: `${C}/approvals`,
    label: "Approvals",
    workspace: "overview",
    keywords: ["maker checker", "pending approval", "authorize voucher"],
    group: "Transactions",
  },
];

// ---------------------------------------------------------------------------
// Masters — the reference data everything else is built on.
// ---------------------------------------------------------------------------

const masters: NavEntry[] = [
  {
    href: `${C}/ledgers`,
    label: "Ledgers",
    workspace: "masters",
    keywords: ["accounts", "party master", "customer", "supplier", "ledger master"],
    group: "Masters",
  },
  {
    href: `${C}/items`,
    label: "Items",
    workspace: "inventory",
    keywords: ["stock item", "product master", "sku"],
    group: "Masters",
    module: "inventory",
  },
  {
    href: `${C}/price-lists`,
    label: "Price lists",
    workspace: "sales",
    keywords: ["rate list", "selling price", "mrp", "slab pricing"],
    group: "Masters",
    module: "inventory",
  },
  {
    href: `${C}/discount-agreements`,
    label: "Discount agreements",
    workspace: "sales",
    keywords: ["scheme", "trade discount", "customer discount"],
    group: "Masters",
  },
  {
    href: `${C}/fixed-assets`,
    label: "Fixed assets",
    workspace: "masters",
    keywords: ["asset register", "fa", "block of assets"],
    group: "Masters",
    module: "fixed_assets",
  },
  {
    href: `${C}/cost-centres`,
    label: "Cost centres",
    workspace: "masters",
    keywords: ["cost center", "project", "department"],
    group: "Masters",
    module: "cost_centres",
  },
  {
    href: `${C}/batches`,
    label: "Batches & serials",
    workspace: "inventory",
    keywords: ["batch number", "serial number", "lot", "expiry tracking"],
    group: "Masters",
    module: "batch_serial",
  },
  {
    href: `${C}/closing-stock`,
    label: "Closing stock",
    workspace: "inventory",
    keywords: ["year end stock", "inventory valuation", "stock in hand"],
    group: "Masters",
    module: "inventory",
  },
  {
    href: `${C}/depreciation`,
    label: "Depreciation",
    workspace: "masters",
    keywords: ["books depreciation", "companies act depreciation", "wdv", "slm"],
    group: "Masters",
    module: "fixed_assets",
  },
  {
    href: `${C}/budgets`,
    label: "Budgets",
    workspace: "masters",
    keywords: ["budget master", "annual budget", "forecast"],
    group: "Masters",
    module: "budgets",
  },
  {
    href: `${C}/notices`,
    label: "Notices",
    workspace: "compliance",
    keywords: ["income tax notice", "gst notice", "assessment", "scrutiny"],
    group: "Masters",
    module: "notices",
  },
  {
    href: `${C}/tax-payments`,
    label: "Tax payments",
    workspace: "compliance",
    keywords: ["challan", "gst pmt-06", "tds challan", "advance tax challan"],
    group: "Masters",
  },
  {
    href: `${C}/godowns`,
    label: "Godowns",
    workspace: "inventory",
    keywords: ["warehouse", "location", "store", "stock point"],
    group: "Masters",
    module: "inventory",
  },
  {
    href: `${C}/employees`,
    label: "Employees",
    workspace: "payroll",
    keywords: ["staff", "salary master", "payroll master", "hr"],
    group: "Masters",
    module: "payroll",
  },
  {
    href: `${C}/employees/perquisites`,
    label: "Perquisites",
    workspace: "payroll",
    keywords: ["perks", "hra", "lta", "perquisite valuation"],
    group: "Masters",
    module: "payroll",
  },
  {
    href: `${C}/leave`,
    label: "Leave",
    workspace: "payroll",
    keywords: ["leave balance", "attendance", "earned leave"],
    group: "Masters",
    module: "payroll",
  },
  {
    href: `${C}/fnf-settlement`,
    label: "Full & final settlement",
    workspace: "payroll",
    keywords: ["full and final", "exit settlement", "resignation", "leave encashment"],
    group: "Masters",
    module: "payroll",
  },
  {
    href: `${C}/directors`,
    label: "Directors & KMP",
    workspace: "compliance",
    keywords: ["din", "kmp", "key managerial personnel"],
    group: "Masters",
    module: "roc",
  },
  {
    href: `${C}/significant-beneficial-owners`,
    label: "Significant beneficial owners",
    workspace: "compliance",
    keywords: ["sbo", "ben-1", "beneficial ownership"],
    group: "Masters",
    module: "roc",
  },
  {
    href: `${C}/meetings`,
    label: "Meetings",
    workspace: "compliance",
    keywords: ["board meeting", "agm", "egm", "minutes"],
    group: "Masters",
    module: "roc",
  },
  {
    href: `${C}/share-capital`,
    label: "Share capital",
    workspace: "compliance",
    keywords: ["shareholding", "equity", "share transfer", "mgt-7"],
    group: "Masters",
    module: "roc",
  },
  {
    href: `${C}/charges`,
    label: "Charges (CHG-1/CHG-4)",
    workspace: "compliance",
    keywords: ["chg-1", "chg-4", "mortgage", "hypothecation"],
    group: "Masters",
    module: "roc",
  },
  {
    href: `${C}/sec186-investments`,
    label: "Sec 186 investments",
    workspace: "compliance",
    keywords: ["loans and investments", "inter-corporate loan"],
    group: "Masters",
    module: "roc",
  },
  {
    href: `${C}/dsc-register`,
    label: "DSC register",
    workspace: "compliance",
    keywords: ["digital signature certificate", "token", "dsc validity"],
    group: "Masters",
    module: "roc",
  },
  {
    href: `${C}/filing-register`,
    label: "Filing register",
    workspace: "compliance",
    keywords: ["roc filing", "due date tracker", "form filing log"],
    group: "Masters",
    module: "roc",
  },
];

// ---------------------------------------------------------------------------
// GST — everything under the GST accordion today. All 'compliance' by
// subject matter even though every href here lives under /reports/.
// ---------------------------------------------------------------------------

const gst: NavEntry[] = [
  {
    href: `${C}/registrations`,
    label: "Registrations",
    workspace: "compliance",
    keywords: ["gstin", "state registration", "composition", "qrmp"],
    group: "GST",
    module: "gst",
  },
  {
    href: `${C}/reports/gst-registers`,
    label: "Registers",
    workspace: "compliance",
    keywords: ["sales register", "purchase register", "b2b", "b2c"],
    group: "GST",
    module: "gst",
  },
  {
    href: `${C}/reports/gst-setoff`,
    label: "GST set-off",
    workspace: "compliance",
    keywords: ["itc set off", "igst cgst sgst", "tax liability adjustment"],
    group: "GST",
    module: "gst",
  },
  {
    href: `${C}/reports/itc-180day-reversal`,
    label: "ITC 180-day reversal",
    workspace: "compliance",
    keywords: ["rule 37", "180 days", "itc reversal"],
    group: "GST",
    module: "gst",
  },
  {
    href: `${C}/reports/gstr2b-match`,
    label: "GSTR-2B match",
    workspace: "compliance",
    keywords: ["2b reconciliation", "itc match", "vendor mismatch"],
    group: "GST",
    module: "gst",
  },
  {
    href: `${C}/reports/gstr3b-prep`,
    label: "GSTR-3B prep",
    workspace: "compliance",
    keywords: ["gstr-3b", "monthly return", "summary return"],
    group: "GST",
    module: "gst",
  },
  {
    href: `${C}/reports/gst-refunds`,
    label: "GST refunds",
    workspace: "compliance",
    keywords: ["rfd-01", "refund application", "inverted duty"],
    group: "GST",
    module: "gst",
  },
  {
    href: `${C}/reports/gst-tds-tcs-suffered`,
    label: "GST TDS/TCS suffered",
    workspace: "compliance",
    keywords: ["section 51", "section 52", "gstr-7", "gstr-8"],
    group: "GST",
    module: "gst",
  },
];

// ---------------------------------------------------------------------------
// Reports — sorted by SUBJECT, not by the fact every href lives under
// /reports/: a stock report is 'inventory', a payroll register is
// 'payroll', and only the domain-neutral financial statements are 'reports'.
// ---------------------------------------------------------------------------

const reports: NavEntry[] = [
  {
    href: `${C}/reports/daybook`,
    label: "Daybook",
    workspace: "reports",
    keywords: ["day book", "all vouchers", "transaction log"],
    group: "Reports",
  },
  {
    href: `${C}/reports/sales-invoices`,
    label: "Sales invoices",
    workspace: "sales",
    keywords: ["sales register", "invoice list", "b2b b2c invoices"],
    group: "Reports",
  },
  {
    href: `${C}/reports/purchase-invoices`,
    label: "Purchase invoices",
    workspace: "purchases",
    keywords: ["purchase register", "bill list", "vendor invoices"],
    group: "Reports",
  },
  {
    href: `${C}/reports/sales-returns`,
    label: "Sales returns",
    workspace: "sales",
    keywords: ["credit note", "sales return register"],
    group: "Reports",
  },
  {
    href: `${C}/reports/purchase-returns`,
    label: "Purchase returns",
    workspace: "purchases",
    keywords: ["debit note", "purchase return register"],
    group: "Reports",
  },
  {
    href: `${C}/reports/purchase-analysis`,
    label: "Purchase analysis",
    workspace: "purchases",
    keywords: ["supplier", "top suppliers", "vendor", "purchase by item", "spend analysis"],
    group: "Reports",
  },
  {
    href: `${C}/reports/sales-analysis`,
    label: "Sales analysis",
    workspace: "reports",
    keywords: ["customer", "top customers", "party wise sales", "item wise sales", "best sellers", "sales analysis", "top items", "who buys the most"],
    group: "Reports",
  },
  {
    href: `${C}/reports/ledger-statement`,
    label: "Ledger statement",
    workspace: "reports",
    keywords: ["ledger vouchers", "account statement", "party statement"],
    group: "Reports",
  },
  {
    href: `${C}/reports/trial-balance`,
    label: "Trial balance",
    workspace: "reports",
    keywords: ["tb", "trial bal"],
    group: "Reports",
  },
  {
    href: `${C}/reports/profit-loss`,
    label: "Profit & loss",
    workspace: "reports",
    keywords: ["p&l", "income statement", "trading account"],
    group: "Reports",
  },
  {
    href: `${C}/reports/balance-sheet`,
    label: "Balance sheet",
    workspace: "reports",
    keywords: ["bs", "statement of affairs", "schedule iii"],
    group: "Reports",
  },
  {
    href: `${C}/reports/cash-flow`,
    label: "Cash flow",
    workspace: "reports",
    keywords: ["cash flow statement", "fund flow"],
    group: "Reports",
  },
  {
    href: `${C}/reports/stock`,
    label: "Stock",
    workspace: "inventory",
    keywords: ["stock summary", "inventory report", "item wise stock"],
    group: "Reports",
    module: "inventory",
  },
  {
    href: `${C}/reports/stock-ageing`,
    label: "Stock ageing",
    workspace: "inventory",
    keywords: ["ageing analysis", "slow moving", "aged inventory"],
    group: "Reports",
    module: "inventory",
  },
  {
    href: `${C}/reports/stock-expiry`,
    label: "Stock expiry",
    workspace: "inventory",
    keywords: ["expiry report", "near expiry", "shelf life"],
    group: "Reports",
    module: "batch_serial",
  },
  {
    href: `${C}/reports/outstanding`,
    label: "Outstanding",
    workspace: "sales",
    keywords: ["bills receivable", "bills payable", "debtors", "creditors", "ageing", "party outstanding"],
    group: "Reports",
  },
  {
    href: `${C}/reports/msme`,
    label: "MSME dues",
    workspace: "compliance",
    keywords: ["43b(h)", "msme delayed payment", "udyam"],
    group: "Reports",
    module: "msme",
  },
  {
    href: `${C}/reports/stock-statement`,
    label: "Stock statement",
    workspace: "banking",
    keywords: ["drawing power", "bank stock statement", "cc limit"],
    group: "Reports",
    module: "stock_statement",
  },
  {
    href: `${C}/reports/cost-centre-pnl`,
    label: "Cost centre P&L",
    workspace: "reports",
    keywords: ["project p&l", "department wise profit"],
    group: "Reports",
    module: "cost_centres",
  },
  {
    href: `${C}/reports/budget-variance`,
    label: "Budget variance",
    workspace: "reports",
    keywords: ["actual vs budget", "variance report"],
    group: "Reports",
    module: "budgets",
  },
  {
    href: `${C}/reports/margin-by-item`,
    label: "Margin by item",
    workspace: "reports",
    keywords: ["profitability", "gross margin", "cost of goods sold", "cogs", "item wise margin"],
    group: "Reports",
    module: "inventory",
  },
  {
    href: `${C}/reports/cma-ratios`,
    label: "CMA & ratios",
    workspace: "banking",
    keywords: ["cma data", "tandon mpbf", "bank loan ratios", "financial ratios"],
    group: "Reports",
    module: "ratios",
  },
  {
    href: `${C}/reports/tally-export`,
    label: "Export to Tally",
    workspace: "setup",
    keywords: ["export to tally", "xml export", "data migration"],
    group: "Reports",
    module: "tally_connector",
  },
  {
    href: `${C}/reports/itc-04-prep`,
    label: "ITC-04 prep",
    workspace: "compliance",
    keywords: ["job work return", "itc-04"],
    group: "Reports",
    module: "gst",
  },
  {
    href: `${C}/reports/gstr1-summary`,
    label: "GSTR-1 summary",
    workspace: "compliance",
    keywords: ["gstr-1", "outward supply return"],
    group: "Reports",
    module: "gst",
  },
  {
    href: `${C}/reports/isd-distribution`,
    label: "ISD distribution",
    workspace: "compliance",
    keywords: ["input service distributor", "isd credit"],
    group: "Reports",
    module: "gst_isd",
  },
  {
    href: `${C}/reports/tds-summary`,
    label: "TDS summary",
    workspace: "compliance",
    keywords: ["tds deducted", "section wise tds"],
    group: "Reports",
    module: "tds",
  },
  {
    href: `${C}/reports/tds-threshold-status`,
    label: "TDS threshold status",
    workspace: "compliance",
    keywords: ["tds threshold", "limit crossed"],
    group: "Reports",
    module: "tds",
  },
  {
    href: `${C}/reports/tds-interest-and-fees`,
    label: "TDS interest & 234E fee",
    workspace: "compliance",
    keywords: ["234e", "late filing fee", "interest on tds"],
    group: "Reports",
    module: "tds",
  },
  {
    href: `${C}/reports/tds-return-24q`,
    label: "TDS return 24Q",
    workspace: "compliance",
    keywords: ["24q", "salary tds return"],
    group: "Reports",
    module: "tds",
  },
  {
    href: `${C}/reports/tds-return-26q`,
    label: "TDS return 26Q",
    workspace: "compliance",
    keywords: ["26q", "non-salary tds return"],
    group: "Reports",
    module: "tds",
  },
  {
    href: `${C}/reports/tds-return-27q`,
    label: "TDS return 27Q",
    workspace: "compliance",
    keywords: ["27q", "nri tds return"],
    group: "Reports",
    module: "tds",
  },
  {
    href: `${C}/reports/tds-return-27eq`,
    label: "TDS return 27EQ (TCS)",
    workspace: "compliance",
    keywords: ["27eq", "tcs return"],
    group: "Reports",
    module: "tcs",
  },
  {
    href: `${C}/reports/form16-partb`,
    label: "Form 16 Part B",
    workspace: "compliance",
    keywords: ["form 16", "salary certificate"],
    group: "Reports",
    module: "tds",
  },
  {
    href: `${C}/reports/tds-credit-match`,
    label: "26AS/AIS/TIS match",
    workspace: "compliance",
    keywords: ["26as", "ais", "tis", "form 26as match"],
    group: "Reports",
    module: "tds",
  },
  {
    href: `${C}/lower-deduction`,
    label: "Sec 197 certificates",
    workspace: "compliance",
    keywords: ["197 certificate", "lower deduction certificate", "nil tds"],
    group: "Reports",
    module: "tds",
  },
  {
    href: `${C}/reports/tax-depreciation`,
    label: "Tax depreciation",
    workspace: "compliance",
    keywords: ["income tax depreciation", "block of assets", "wdv"],
    group: "Reports",
    module: "income_tax",
  },
  {
    href: `${C}/deferred-tax`,
    label: "Deferred tax",
    workspace: "compliance",
    keywords: ["dta", "dtl", "as 22", "ind as 12"],
    group: "Reports",
    module: "income_tax",
  },
  {
    href: `${C}/reports/income-tax`,
    label: "Income tax",
    workspace: "compliance",
    keywords: ["income tax computation", "tax liability"],
    group: "Reports",
    module: "income_tax",
  },
  {
    href: `${C}/reports/advance-tax`,
    label: "Advance tax",
    workspace: "compliance",
    keywords: ["quarterly advance tax", "234b", "234c"],
    group: "Reports",
    module: "income_tax",
  },
  {
    href: `${C}/reports/itr-prep`,
    label: "ITR prep",
    workspace: "compliance",
    keywords: ["income tax return", "itr filing"],
    group: "Reports",
    module: "income_tax",
  },
  {
    href: `${C}/reports/tax-audit`,
    label: "Tax audit",
    workspace: "compliance",
    keywords: ["3ca", "3cb", "3cd", "tax audit report"],
    group: "Reports",
    module: "tax_audit",
  },
  {
    href: `${C}/reports/common-credit-apportionment`,
    label: "Common credit (Rules 42/43)",
    workspace: "compliance",
    keywords: ["rule 42", "rule 43", "common credit", "exempt supply reversal"],
    group: "Reports",
    module: "gst",
  },
  {
    href: `${C}/reports/notes-to-accounts`,
    label: "Notes to accounts",
    workspace: "reports",
    keywords: ["schedule iii notes", "financial statement notes"],
    group: "Reports",
    module: "schedule_iii",
  },
  {
    href: `${C}/reports/discount-agreement-coverage`,
    label: "Discount agreement coverage",
    workspace: "sales",
    keywords: ["scheme utilization", "discount usage"],
    group: "Reports",
  },
  {
    href: `${C}/reports/gstr9-workpaper`,
    label: "GSTR-9/9C workpaper",
    workspace: "compliance",
    keywords: ["annual return", "gstr-9", "gstr-9c", "reconciliation statement"],
    group: "Reports",
    module: "gst",
  },
  {
    href: `${C}/reports/dpt3-content`,
    label: "DPT-3 content",
    workspace: "compliance",
    keywords: ["deposits return", "dpt-3"],
    group: "Reports",
    module: "roc",
  },
  {
    href: `${C}/reports/aoc4-xbrl`,
    label: "AOC-4 XBRL",
    workspace: "compliance",
    keywords: ["financial statements filing", "xbrl", "aoc-4"],
    group: "Reports",
    module: "roc",
  },
  {
    href: `${C}/reports/payroll-register`,
    label: "Payroll register",
    workspace: "payroll",
    keywords: ["salary register", "payroll summary"],
    group: "Reports",
    module: "payroll",
  },
  {
    href: `${C}/reports/payroll-registers`,
    label: "Payroll registers (muster/wage)",
    workspace: "payroll",
    keywords: ["muster roll", "wage register"],
    group: "Reports",
    module: "payroll",
  },
  {
    href: `${C}/reports/pt-liability`,
    label: "Professional tax by state",
    workspace: "payroll",
    keywords: ["professional tax", "pt challan", "state pt"],
    group: "Reports",
    module: "payroll_statutory",
  },
  {
    href: `${C}/reports/statutory-bonus`,
    label: "Statutory bonus",
    workspace: "payroll",
    keywords: ["bonus act", "payment of bonus"],
    group: "Reports",
    module: "payroll",
  },
  {
    href: `${C}/reports/gratuity`,
    label: "Gratuity",
    workspace: "payroll",
    keywords: ["gratuity provision", "payment of gratuity act"],
    group: "Reports",
    module: "payroll",
  },
  {
    href: `${C}/reports/pf-ecr`,
    label: "PF ECR",
    workspace: "payroll",
    keywords: ["pf ecr", "epfo", "provident fund"],
    group: "Reports",
    module: "payroll_statutory",
  },
  {
    href: `${C}/reports/esi-mc`,
    label: "ESI MC",
    workspace: "payroll",
    keywords: ["esi monthly contribution", "esic"],
    group: "Reports",
    module: "payroll_statutory",
  },
  {
    href: `${C}/reports/compliance-calendar`,
    label: "Calendar",
    workspace: "compliance",
    keywords: ["due dates", "filing calendar", "reminders", "compliance calendar"],
    group: "Reports",
    module: "compliance_calendar",
  },
];

// ---------------------------------------------------------------------------
// Bottom list — account/settings links NavRail renders below the accordions,
// outside any group.
// ---------------------------------------------------------------------------

const bottom: NavEntry[] = [
  {
    href: `${C}/reconciliation`,
    label: "Reconcile",
    workspace: "banking",
    keywords: ["bank reconciliation", "brs", "statement matching"],
    module: "bank_recon",
  },
  {
    href: `${C}/notifications`,
    label: "Notifications",
    workspace: "overview",
    keywords: ["alerts", "reminders inbox"],
  },
  {
    href: `${C}/audit-trail`,
    label: "Audit trail",
    workspace: "compliance",
    keywords: ["change log", "edit log", "who changed"],
    module: "audit_trail",
  },
  {
    href: `${C}/year-end`,
    label: "Year-end",
    workspace: "setup",
    keywords: ["closing the books", "carry forward", "new financial year"],
    module: "year_end",
  },
  {
    href: `${C}/settings`,
    label: "Settings",
    workspace: "setup",
    keywords: ["company settings", "preferences"],
  },
  {
    href: `${C}/settings/team`,
    label: "Team",
    workspace: "setup",
    keywords: ["users", "roles", "permissions", "invite"],
  },
  {
    href: `${C}/settings/employer-registrations`,
    label: "Employer registrations",
    workspace: "payroll",
    keywords: ["pf code", "esi code", "tan", "pt registration"],
    module: "payroll_statutory",
  },
  {
    href: `${C}/settings/numbering`,
    label: "Voucher numbering",
    workspace: "setup",
    keywords: ["voucher series", "invoice numbering", "prefix suffix"],
  },
  {
    href: `${C}/whatsapp-numbers`,
    label: "WhatsApp numbers",
    workspace: "setup",
    keywords: ["whatsapp business", "send invoice whatsapp"],
  },
  {
    href: `${C}/settings/print-template`,
    label: "Invoice design",
    workspace: "setup",
    keywords: ["invoice template", "print design", "logo"],
  },
  {
    href: `${C}/settings/backup`,
    label: "Backup / export",
    workspace: "setup",
    keywords: ["export data", "download backup"],
  },
  {
    href: `${C}/settings/api-keys`,
    label: "API keys",
    workspace: "setup",
    keywords: ["public api", "integration key"],
    module: "public_api",
  },
  {
    // Not under /:companyId — a second factor belongs to the person, not to
    // a company, so someone working across six companies enrols once (see
    // NavRail.tsx's own comment on this link).
    href: "/security",
    label: "Account security",
    workspace: "setup",
    keywords: ["2fa", "two factor", "password", "mfa"],
  },
  {
    // Also not under /:companyId, alongside /scan and /security above: a
    // circular/notification feed belongs to the person keeping an eye on
    // deadlines, not to whichever company they last opened. The route has
    // existed on disk since it shipped but carried no nav entry anywhere —
    // fe286c9 named this exact gap; wired here.
    href: "/statutory-updates",
    label: "Statutory updates",
    workspace: "setup",
    keywords: ["circulars", "notifications", "compliance calendar", "gst updates"],
  },
];

// ---------------------------------------------------------------------------
// Orphans — routes that exist on disk but appear in no nav group today.
// ---------------------------------------------------------------------------

const orphans: NavEntry[] = [
  {
    href: `${C}/allocations`,
    label: "Bill allocation",
    workspace: "sales",
    keywords: ["bill wise", "agst ref", "settle", "adjust", "against", "bill wise allocation"],
  },
  {
    href: `${C}/account-groups`,
    label: "Account groups",
    workspace: "masters",
    keywords: ["chart of accounts", "group master", "nature of account"],
  },
];

/** Every nav destination, flattened. Order within each source list matches
 * NavRail.tsx exactly, so a straight re-render off this array reproduces
 * today's menu with no visible reordering. */
export const navEntries: NavEntry[] = [
  overview,
  ...transactions,
  ...masters,
  ...gst,
  ...reports,
  ...bottom,
  ...orphans,
];

/** The four accordions, in NavRail's exact current order, each holding
 * exactly the entries NavRail files under that label today. Overview and
 * the bottom list are deliberately excluded — they render outside any
 * accordion, same as today. */
export const navGroups: { label: string; items: NavEntry[] }[] = [
  { label: "Transactions", items: transactions },
  { label: "Masters", items: masters },
  { label: "GST", items: gst },
  { label: "Reports", items: reports },
];
