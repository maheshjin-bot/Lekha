/**
 * Tally XML export — one-directional, LEKHA → Tally, structurally correct
 * per Tally Solutions' own official documentation but UNVERIFIED against a
 * real TallyPrime install (no live Tally exists in this environment to
 * test-import against). See the research this was built from (21 Aug 2026
 * session) for exactly which parts are strong vs. genuinely unresolved:
 *
 * STRONG (drawn directly from multiple independent official Tally pages):
 * the ENVELOPE/HEADER/BODY skeleton, the minimal GROUP/LEDGER/VOUCHER
 * Create shapes, the debit=negative-amount/ISDEEMEDPOSITIVE sign
 * convention, and the YYYYMMDD date format.
 *
 * UNRESOLVED, a real risk, flagged rather than hidden: whether Tally wants
 * ALLLEDGERENTRIES.LIST or LEDGERENTRIES.LIST for plain accounting lines —
 * both are attested in official docs for what looks like the same purpose.
 * This defaults to ALLLEDGERENTRIES.LIST (the tag used in Tally's own
 * create/alter integration walkthrough, and the one live TallyPrime data
 * exports are widely reported to use), matching the research's own
 * recommendation. If a real TallyPrime import rejects a file this
 * produces, this is the first thing to try changing.
 *
 * SCOPE, v1: ledgers and plain accounting vouchers (receipt, payment,
 * contra, journal, sales, purchase, credit_note, debit_note) for the
 * chosen date range. No item/inventory export (ALLINVENTORYENTRIES.LIST,
 * batch/godown allocations) and no bill-wise allocation — a genuinely
 * bigger scope this session didn't attempt.
 */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tag(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return `<${name}>${escapeXml(String(value))}</${name}>`;
}

/**
 * Tally's classic ~28 reserved/primary group names, canonical casing.
 * Any account_groups row whose (normalized) name matches one of these is
 * treated as already existing in a fresh Tally company — no <GROUP>
 * element is emitted for it, and its CANONICAL Tally name is used
 * wherever it's referenced as a PARENT, not LEKHA's own casing (a few of
 * LEKHA's seeded names are near-but-not-exact matches — e.g.
 * "Cash-in-Hand" vs Tally's "Cash-in-hand", "Reserves and Surplus" vs
 * Tally's "Reserves & Surplus" — normalized here rather than risking a
 * case-sensitive mismatch creating an unwanted duplicate group in Tally).
 */
const TALLY_BUILTIN_GROUPS: Record<string, string> = {};
for (const name of [
  "Bank OD A/c",
  "Bank Accounts",
  "Branch / Divisions",
  "Capital Account",
  "Cash-in-hand",
  "Current Assets",
  "Current Liabilities",
  "Deposits (Asset)",
  "Direct Expenses",
  "Direct Incomes",
  "Duties & Taxes",
  "Fixed Assets",
  "Indirect Expenses",
  "Indirect Incomes",
  "Investments",
  "Loans & Advances (Asset)",
  "Loans (Liability)",
  "Misc. Expenses (ASSET)",
  "Provisions",
  "Purchase Accounts",
  "Reserves & Surplus",
  "Retained Earnings",
  "Sales Accounts",
  "Secured Loans",
  "Stock-in-Hand",
  "Sundry Creditors",
  "Sundry Debtors",
  "Suspense A/c",
  "Unsecured Loans",
]) {
  TALLY_BUILTIN_GROUPS[normalizeGroupName(name)] = name;
}

/** Loose match: case-insensitive, "&"/"and" and "-"/" " treated the same, trailing (Asset)/(Liability) qualifiers ignored for matching purposes only. */
function normalizeGroupName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(asset\)|\(liability\)|\(net\)/g, "")
    .replace(/&/g, "and")
    .replace(/[-\s]+/g, " ")
    .trim();
}

export type ExportGroup = { id: string; name: string; parent_group_id: string | null };

/** Resolves the Tally PARENT name for a LEKHA group: its canonical Tally
 * name if it's a built-in, its own (LEKHA) name if custom-but-nested under
 * another custom group, or "Primary" (Tally's actual root keyword) if
 * custom and top-level with no clean Tally home. */
export function resolveTallyParent(group: ExportGroup, byId: Map<string, ExportGroup>): string {
  if (!group.parent_group_id) return "Primary";
  const parent = byId.get(group.parent_group_id);
  if (!parent) return "Primary";
  const builtin = TALLY_BUILTIN_GROUPS[normalizeGroupName(parent.name)];
  return builtin ?? parent.name;
}

export function isTallyBuiltinGroup(name: string): string | null {
  return TALLY_BUILTIN_GROUPS[normalizeGroupName(name)] ?? null;
}

export function buildGroupsXml(groups: ExportGroup[]): string {
  const byId = new Map(groups.map((g) => [g.id, g]));

  // LEKHA's Schedule III chart of accounts genuinely has "pass-through"
  // pairs — a top-level group AND a nested sub-group sharing the exact
  // same name (e.g. a top-level "Long-term Borrowings" alongside a child
  // of "Non-current Liabilities" also named "Long-term Borrowings"; the
  // top-level one is a reporting-classification container, the nested one
  // is what ledgers actually attach to). Caught live by browser-testing
  // the real export, not by code review: emitting one <GROUP Create> per
  // account_groups ROW produced two Tally groups with the identical name
  // and different PARENTs — an ambiguous/conflicting import. Fixed by
  // deduplicating on the resolved name first: when two rows share a name,
  // the nested one (real parent_group_id) wins, since that's the one with
  // an actually-informative PARENT — the orphaned top-level duplicate is
  // dropped rather than emitted a second time.
  const custom = groups.filter((g) => !isTallyBuiltinGroup(g.name));
  const byName = new Map<string, ExportGroup>();
  for (const g of custom) {
    const key = normalizeGroupName(g.name);
    const existing = byName.get(key);
    if (!existing || (!existing.parent_group_id && g.parent_group_id)) {
      byName.set(key, g);
    }
  }

  // Emit top-level customs before nested customs — correct for LEKHA's
  // confirmed-live 2-level-deep chart of accounts; a deeper tree would
  // need a real topological sort, which this doesn't attempt.
  const winners = Array.from(byName.values()).sort(
    (a, b) => (a.parent_group_id ? 1 : 0) - (b.parent_group_id ? 1 : 0)
  );

  return winners
    .map((g) => {
      const parent = resolveTallyParent(g, byId);
      return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="${escapeXml(g.name)}" ACTION="Create">${tag("NAME", g.name)}${tag("PARENT", parent)}</GROUP></TALLYMESSAGE>`;
    })
    .join("\n");
}

export type ExportLedger = {
  id: string;
  name: string;
  group_id: string;
  gstin: string | null;
  pan: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  state_name: string | null;
  email: string | null;
  phone: string | null;
  opening_balance_amount: number;
  opening_balance_type: string;
};

export function buildLedgersXml(ledgers: ExportLedger[], groups: ExportGroup[]): string {
  const byId = new Map(groups.map((g) => [g.id, g]));
  return ledgers
    .map((l) => {
      const group = byId.get(l.group_id);
      const parentName = group ? (isTallyBuiltinGroup(group.name) ?? group.name) : "Primary";
      // Tally convention: OPENINGBALANCE is signed, debit positive.
      const signedOpening =
        l.opening_balance_amount > 0
          ? l.opening_balance_type === "debit"
            ? l.opening_balance_amount
            : -l.opening_balance_amount
          : 0;
      return [
        `<TALLYMESSAGE xmlns:UDF="TallyUDF">`,
        `<LEDGER NAME="${escapeXml(l.name)}" ACTION="Create">`,
        tag("NAME", l.name),
        tag("PARENT", parentName),
        l.gstin ? tag("PARTYGSTIN", l.gstin) : "",
        l.pan ? tag("INCOMETAXNUMBER", l.pan) : "",
        l.address ? `<ADDRESS.LIST><ADDRESS>${escapeXml(l.address)}</ADDRESS></ADDRESS.LIST>` : "",
        tag("PINCODE", l.pincode),
        tag("LEDSTATENAME", l.state_name),
        tag("EMAIL", l.email),
        tag("LEDGERPHONE", l.phone),
        signedOpening !== 0 ? tag("OPENINGBALANCE", signedOpening.toFixed(2)) : "",
        `</LEDGER>`,
        `</TALLYMESSAGE>`,
      ]
        .filter(Boolean)
        .join("");
    })
    .join("\n");
}

export type ExportVoucherEntry = { ledger_name: string; debit_amount: number; credit_amount: number };
export type ExportVoucher = {
  voucher_type: string;
  voucher_number: string;
  voucher_date: string; // YYYY-MM-DD
  narration: string | null;
  entries: ExportVoucherEntry[];
};

const TALLY_VOUCHER_TYPE_NAME: Record<string, string> = {
  receipt: "Receipt",
  payment: "Payment",
  contra: "Contra",
  journal: "Journal",
  sales: "Sales",
  purchase: "Purchase",
  credit_note: "Credit Note",
  debit_note: "Debit Note",
};

function yyyymmdd(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

export function buildVouchersXml(vouchers: ExportVoucher[]): string {
  return vouchers
    .filter((v) => TALLY_VOUCHER_TYPE_NAME[v.voucher_type])
    .map((v) => {
      const typeName = TALLY_VOUCHER_TYPE_NAME[v.voucher_type];
      const lines = v.entries
        .map((e) => {
          const isDebit = e.debit_amount > 0;
          const amount = isDebit ? -e.debit_amount : e.credit_amount;
          return [
            `<ALLLEDGERENTRIES.LIST>`,
            tag("LEDGERNAME", e.ledger_name),
            tag("ISDEEMEDPOSITIVE", isDebit ? "Yes" : "No"),
            tag("AMOUNT", amount.toFixed(2)),
            `</ALLLEDGERENTRIES.LIST>`,
          ].join("");
        })
        .join("\n");
      return [
        `<TALLYMESSAGE xmlns:UDF="TallyUDF">`,
        `<VOUCHER VCHTYPE="${escapeXml(typeName)}" ACTION="Create">`,
        tag("DATE", yyyymmdd(v.voucher_date)),
        tag("VOUCHERTYPENAME", typeName),
        tag("VOUCHERNUMBER", v.voucher_number),
        tag("NARRATION", v.narration),
        lines,
        `</VOUCHER>`,
        `</TALLYMESSAGE>`,
      ].join("");
    })
    .join("\n");
}

export function wrapMastersEnvelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>All Masters</REPORTNAME>
   </REQUESTDESC>
   <REQUESTDATA>
${body}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}

export function wrapVouchersEnvelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import</TALLYREQUEST>
  <TYPE>Data</TYPE>
  <ID>Vouchers</ID>
 </HEADER>
 <BODY>
  <DESC></DESC>
  <DATA>
${body}
  </DATA>
 </BODY>
</ENVELOPE>`;
}
