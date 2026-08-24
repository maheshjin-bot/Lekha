/**
 * Tally XML import — the reverse of lib/tally/xml.ts (which only ever
 * SERIALISES LEKHA data out as Tally XML; confirmed live on 24 Aug 2026 that
 * all twelve of its exports are writers, none a reader). This file is the
 * PARSER: it turns a Tally "All Masters" / Day Book style XML export back
 * into plain structured records.
 *
 * Deliberately tolerant. The exporter's own header already documents that
 * real TallyPrime/Tally.ERP9 exports vary in exact shape across versions and
 * localisations more than the tidy shape lib/tally/xml.ts itself produces —
 * some samples researched for this feature use `<GROUP Action="Create">`
 * with child `<NAME>`/`<PARENT>` tags and no NAME attribute at all, others
 * (lib/tally/xml.ts's own output, matching one attested real-world shape)
 * use `<GROUP NAME="..." ACTION="Create">` with BOTH an attribute and a
 * child tag. This parser accepts either: attribute lookups are
 * case-insensitive (ACTION vs Action) and every "read a field" helper tries
 * the attribute first, then the like-named child element.
 *
 * Structural validation only lives here — nothing here decides whether a
 * record is fit to insert (no group/ledger/state lookups, no GSTIN
 * checksum). That is lib/tally/import.ts's job. This file's only
 * responsibility is: given XML text, extract every GROUP/LEDGER/VOUCHER
 * element it can find, and record — per record — anything structurally
 * wrong (no NAME, an unsupported ACTION) as an `issues` entry rather than
 * dropping the record. Per the task's own defensive-parsing requirement, no
 * record is ever silently skipped; everything found is returned, valid or
 * not, so the import summary can report on all of it.
 */

export type RawGroup = {
  sourceIndex: number;
  name: string | null;
  parentName: string | null;
  action: string | null;
  issues: string[];
};

export type RawLedger = {
  sourceIndex: number;
  name: string | null;
  parentName: string | null;
  action: string | null;
  gstin: string | null;
  pan: string | null;
  address: string | null;
  pincode: string | null;
  stateName: string | null;
  email: string | null;
  phone: string | null;
  /** As read from OPENINGBALANCE, signed, whatever convention the source used. Null = tag absent. */
  openingBalanceRaw: number | null;
  issues: string[];
};

export type RawVoucherEntry = {
  ledgerName: string | null;
  /** "Yes" / "No" / anything else the file actually contained, verbatim. */
  isDeemedPositiveRaw: string | null;
  amountRaw: number | null;
};

export type RawVoucher = {
  sourceIndex: number;
  vchType: string | null;
  action: string | null;
  /** As read from DATE, verbatim (expected YYYYMMDD, but not assumed). */
  dateRaw: string | null;
  voucherNumber: string | null;
  narration: string | null;
  entries: RawVoucherEntry[];
  issues: string[];
};

export type TallyParseResult = {
  /** Set only when the file could not be read as XML at all, or contained none of GROUP/LEDGER/VOUCHER anywhere. Nothing below is usable when this is set. */
  fatalError: string | null;
  /** Non-blocking observations about the file shape (e.g. an unexpected root element) — shown, not enforced. */
  notes: string[];
  groups: RawGroup[];
  ledgers: RawLedger[];
  vouchers: RawVoucher[];
};

const ACCEPTED_ACTIONS = new Set(["create", "alter"]);

function attrCI(el: Element, name: string): string | null {
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.name.toUpperCase() === name.toUpperCase()) {
      const v = a.value.trim();
      return v === "" ? null : v;
    }
  }
  return null;
}

function childrenCI(el: Element, name: string): Element[] {
  const upper = name.toUpperCase();
  const out: Element[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (c.tagName.toUpperCase() === upper) out.push(c);
  }
  return out;
}

function childTextCI(el: Element, name: string): string | null {
  const c = childrenCI(el, name)[0];
  if (!c) return null;
  const t = (c.textContent ?? "").trim();
  return t === "" ? null : t;
}

/** Attribute first (matches a real Create/Alter shorthand), then the like-named child tag. */
function field(el: Element, name: string): string | null {
  return attrCI(el, name) ?? childTextCI(el, name);
}

function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const s = raw.replace(/,/g, "").replace(/\s/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Depth-first, tag-name match only (case-insensitive) — deliberately independent of ENVELOPE/BODY/DATA nesting, since that wrapper is exactly the part most likely to differ across Tally versions and export contexts (masters vs Day Book vs a COLLECTION-based report). */
function collectByTag(root: Element, tagNamesUpper: Set<string>): Element[] {
  const out: Element[] = [];
  function walk(el: Element) {
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i];
      if (tagNamesUpper.has(c.tagName.toUpperCase())) out.push(c);
      walk(c);
    }
  }
  walk(root);
  return out;
}

function parseGroup(el: Element, sourceIndex: number): RawGroup {
  const issues: string[] = [];
  const name = field(el, "NAME");
  if (!name) issues.push("No NAME found (checked the NAME attribute and a child <NAME> tag).");

  const action = attrCI(el, "ACTION");
  if (action && !ACCEPTED_ACTIONS.has(action.toLowerCase())) {
    issues.push(`ACTION="${action}" is not Create or Alter — this importer only creates/updates masters, never deletes them.`);
  }

  return { sourceIndex, name, parentName: childTextCI(el, "PARENT"), action, issues };
}

function parseLedger(el: Element, sourceIndex: number): RawLedger {
  const issues: string[] = [];
  const name = field(el, "NAME");
  if (!name) issues.push("No NAME found (checked the NAME attribute and a child <NAME> tag).");

  const action = attrCI(el, "ACTION");
  if (action && !ACCEPTED_ACTIONS.has(action.toLowerCase())) {
    issues.push(`ACTION="${action}" is not Create or Alter — this importer only creates/updates masters, never deletes them.`);
  }

  // ADDRESS.LIST can hold several <ADDRESS> lines; joined for a single-field match.
  const addressList = childrenCI(el, "ADDRESS.LIST")[0];
  const addressLines = addressList
    ? childrenCI(addressList, "ADDRESS").map((a) => (a.textContent ?? "").trim()).filter(Boolean)
    : [];

  return {
    sourceIndex,
    name,
    parentName: childTextCI(el, "PARENT"),
    action,
    gstin: childTextCI(el, "PARTYGSTIN") ?? childTextCI(el, "GSTIN"),
    pan: childTextCI(el, "INCOMETAXNUMBER") ?? childTextCI(el, "PAN"),
    address: addressLines.length ? addressLines.join(", ") : null,
    pincode: childTextCI(el, "PINCODE"),
    stateName: childTextCI(el, "LEDSTATENAME") ?? childTextCI(el, "STATENAME"),
    email: childTextCI(el, "EMAIL"),
    phone: childTextCI(el, "LEDGERPHONE") ?? childTextCI(el, "PHONE"),
    openingBalanceRaw: parseNumber(childTextCI(el, "OPENINGBALANCE")),
    issues,
  };
}

function parseVoucher(el: Element, sourceIndex: number): RawVoucher {
  const issues: string[] = [];
  const action = attrCI(el, "ACTION");
  if (action && !ACCEPTED_ACTIONS.has(action.toLowerCase())) {
    issues.push(`ACTION="${action}" is not Create or Alter — this importer only creates vouchers, never deletes them.`);
  }

  const vchType = attrCI(el, "VCHTYPE") ?? childTextCI(el, "VOUCHERTYPENAME");
  if (!vchType) issues.push("No voucher type found (checked the VCHTYPE attribute and a child <VOUCHERTYPENAME> tag).");

  // The exporter's own header flags this as genuinely unresolved: real
  // exports are attested using either tag for a plain accounting line. Both
  // are read here without preference.
  const entryEls = [
    ...childrenCI(el, "ALLLEDGERENTRIES.LIST"),
    ...childrenCI(el, "LEDGERENTRIES.LIST"),
  ];
  const entries: RawVoucherEntry[] = entryEls.map((e) => ({
    ledgerName: childTextCI(e, "LEDGERNAME"),
    isDeemedPositiveRaw: childTextCI(e, "ISDEEMEDPOSITIVE"),
    amountRaw: parseNumber(childTextCI(e, "AMOUNT")),
  }));

  return {
    sourceIndex,
    vchType,
    action,
    dateRaw: childTextCI(el, "DATE"),
    voucherNumber: childTextCI(el, "VOUCHERNUMBER"),
    narration: childTextCI(el, "NARRATION"),
    entries,
    issues,
  };
}

export function parseTallyXml(xmlText: string): TallyParseResult {
  const notes: string[] = [];

  if (!xmlText || !xmlText.trim()) {
    return { fatalError: "That file is empty.", notes, groups: [], ledgers: [], vouchers: [] };
  }

  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) {
    return {
      fatalError: `Not valid XML: ${(parserError.textContent ?? "unrecognised syntax").trim().slice(0, 300)}`,
      notes,
      groups: [],
      ledgers: [],
      vouchers: [],
    };
  }

  const root = doc.documentElement;
  if (!root) {
    return { fatalError: "That file has no XML root element.", notes, groups: [], ledgers: [], vouchers: [] };
  }
  if (root.tagName.toUpperCase() !== "ENVELOPE") {
    notes.push(`Root element is <${root.tagName}>, not the <ENVELOPE> a Tally export normally starts with — reading it anyway.`);
  }

  const groupEls = collectByTag(root, new Set(["GROUP"]));
  const ledgerEls = collectByTag(root, new Set(["LEDGER"]));
  const voucherEls = collectByTag(root, new Set(["VOUCHER"]));

  if (groupEls.length === 0 && ledgerEls.length === 0 && voucherEls.length === 0) {
    return {
      fatalError: "No <GROUP>, <LEDGER>, or <VOUCHER> elements found anywhere in this file — is this a Tally masters or Day Book export?",
      notes,
      groups: [],
      ledgers: [],
      vouchers: [],
    };
  }

  return {
    fatalError: null,
    notes,
    groups: groupEls.map(parseGroup),
    ledgers: ledgerEls.map(parseLedger),
    vouchers: voucherEls.map(parseVoucher),
  };
}
