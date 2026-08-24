/**
 * Tally XML import — validation and commit-payload layer.
 *
 * Takes the structurally-parsed records from lib/tally/parse.ts and resolves
 * them against what already exists in this company (groups, ledgers,
 * states), producing one preview row per record with either a ready-to-write
 * payload or a plain-English reason it cannot be imported. Nothing here
 * silently drops a record — every RawGroup/RawLedger/RawVoucher that came
 * out of the parser gets exactly one row back, and any row without a
 * `resolved`/`data` payload carries the reason in `issues`.
 *
 * Groups: relies on lib/tally/xml.ts's own exported isTallyBuiltinGroup() to
 * recognise Tally's ~28 reserved group names — reusing the exporter's own
 * table rather than re-deriving it, so the two stay in sync by construction.
 * normalizeLoose() below duplicates that file's private (unexported)
 * normalizeGroupName — same loose match ("&"/"and", "-"/" ", trailing
 * (Asset)/(Liability)/(Net) qualifiers) — kept in sync by hand since the
 * original cannot be imported.
 */
import { normalizeName } from "@/lib/csv/normalize";
import { isTallyBuiltinGroup } from "@/lib/tally/xml";
import type { RawGroup, RawLedger, RawVoucher } from "@/lib/tally/parse";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Mirrors lib/tally/xml.ts's private normalizeGroupName. Used for group/parent name matching, where LEKHA's own spelling and Tally's canonical spelling can differ cosmetically ("Cash-in-Hand" vs "Cash-in-hand", "Reserves and Surplus" vs "Reserves & Surplus"). */
function normalizeLoose(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(asset\)|\(liability\)|\(net\)/g, "")
    .replace(/&/g, "and")
    .replace(/[-\s]+/g, " ")
    .trim();
}

// Mirrors app_private.is_valid_pan exactly (also duplicated in
// components/csv's LedgerImport — see that file's own comment for why: a CSV
// row must produce the identical row a human filling in the form would).
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const GSTIN_STRUCTURE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Mirrors app_private.gstin_check_digit / is_valid_gstin exactly (0001_schema_helpers_validators.sql) — same GSTN checksum algorithm, so a bad GSTIN is caught before the insert rather than surfacing as an opaque DB constraint failure. */
export function isValidGstin(gstin: string): boolean {
  if (!GSTIN_STRUCTURE.test(gstin)) return false;
  if (!PAN_PATTERN.test(gstin.slice(2, 12))) return false;

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const idx = GSTIN_CHARSET.indexOf(gstin[i]);
    if (idx < 0) return false;
    const weight = i % 2 === 0 ? 1 : 2; // i is 0-based; odd 1-based position (i even) weighs 1, even position weighs 2
    const product = idx * weight;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const checkDigit = GSTIN_CHARSET[(36 - (sum % 36)) % 36];
  return gstin[14] === checkDigit;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type ExistingGroup = { id: string; name: string; normal_balance: string };

export type GroupResolution =
  | { kind: "exists"; id: string; normalBalance: "debit" | "credit" }
  | { kind: "create"; parent: { type: "existing"; id: string } | { type: "in_file"; key: string }; normalBalance: "debit" | "credit" };

export type GroupPreviewRow = {
  sourceIndex: number;
  name: string | null;
  parentNameRaw: string | null;
  /** normalizeLoose(name) once name is known-good and not a within-file duplicate — undefined otherwise. */
  key?: string;
  /** Position to commit this row in (parents before children) — undefined for rows that never resolved. Sort by this before inserting. */
  commitOrder?: number;
  issues: string[];
  resolved: GroupResolution | null;
};

/** The same existing-group lookup buildGroupPreview seeds internally, exposed so the component can extend it with newly-created group ids as it commits them in commitOrder, then hand the combined map to buildLedgerPreview. */
export function groupKeyIndexFromExisting(existingGroups: ExistingGroup[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of existingGroups) {
    const ownKey = normalizeLoose(g.name);
    if (!out.has(ownKey)) out.set(ownKey, g.id);
    const canonical = isTallyBuiltinGroup(g.name);
    if (canonical) {
      const canonKey = normalizeLoose(canonical);
      if (!out.has(canonKey)) out.set(canonKey, g.id);
    }
  }
  return out;
}

/** Topologically orders groups so a custom group nested under another custom group in the same file is resolved after its parent. Returns indices into `groups`; anything left out formed a cycle. */
function topoOrderGroups(groups: RawGroup[]): { order: number[]; cyclic: Set<number> } {
  const keyToIndex = new Map<string, number>();
  groups.forEach((g, i) => {
    if (g.name) keyToIndex.set(normalizeLoose(g.name), i);
  });

  const indeg = new Map<number, number>();
  const edges = new Map<number, number[]>(); // parent index -> [child indices]
  groups.forEach((_, i) => indeg.set(i, 0));

  groups.forEach((g, i) => {
    const parentKey = g.parentName ? normalizeLoose(g.parentName) : null;
    const parentIdx = parentKey ? keyToIndex.get(parentKey) : undefined;
    if (parentIdx !== undefined && parentIdx !== i) {
      indeg.set(i, (indeg.get(i) ?? 0) + 1);
      edges.set(parentIdx, [...(edges.get(parentIdx) ?? []), i]);
    }
  });

  const queue: number[] = [];
  indeg.forEach((d, i) => {
    if (d === 0) queue.push(i);
  });
  const order: number[] = [];
  while (queue.length) {
    const i = queue.shift()!;
    order.push(i);
    for (const j of edges.get(i) ?? []) {
      indeg.set(j, (indeg.get(j) ?? 1) - 1);
      if (indeg.get(j) === 0) queue.push(j);
    }
  }

  const cyclic = new Set<number>(groups.map((_, i) => i).filter((i) => !order.includes(i)));
  return { order, cyclic };
}

/** An index entry either points at a real, already-in-the-database group (`existing`, carrying its real id — used directly at commit time) or at another row in THIS SAME file that hasn't been inserted yet (`in_file`, carrying only the key — the component resolves it to a real id once that row is actually committed, in commitOrder). Collapsing these into one shape (as an earlier version of this function did, storing a `PENDING:<key>` string in place of a real id) is exactly the bug that sends a literal placeholder string to the database as a parent_group_id — caught live via the round-trip verification, not by review. */
type GroupIndexEntry =
  | { source: "existing"; id: string; normalBalance: "debit" | "credit" }
  | { source: "in_file"; normalBalance: "debit" | "credit" };

export function buildGroupPreview(rawGroups: RawGroup[], existingGroups: ExistingGroup[]): GroupPreviewRow[] {
  const idByKey = new Map<string, GroupIndexEntry>();
  for (const g of existingGroups) {
    const nb = g.normal_balance === "credit" ? "credit" : "debit";
    const ownKey = normalizeLoose(g.name);
    if (!idByKey.has(ownKey)) idByKey.set(ownKey, { source: "existing", id: g.id, normalBalance: nb });
    const canonical = isTallyBuiltinGroup(g.name);
    if (canonical) {
      const canonKey = normalizeLoose(canonical);
      if (!idByKey.has(canonKey)) idByKey.set(canonKey, { source: "existing", id: g.id, normalBalance: nb });
    }
  }

  const rows: GroupPreviewRow[] = rawGroups.map((g) => ({
    sourceIndex: g.sourceIndex,
    name: g.name,
    parentNameRaw: g.parentName,
    issues: [...g.issues],
    resolved: null,
  }));

  // Parse-stage issues (missing NAME, bad ACTION) already block the row —
  // nothing else to resolve for those.
  const eligible = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.issues.length === 0 && r.name);

  // Duplicate names within the file: first occurrence proceeds, the rest are
  // reported and excluded rather than attempted twice against a unique index.
  const seenKeys = new Set<string>();
  const dupIndices = new Set<number>();
  for (const { r, i } of eligible) {
    const key = normalizeLoose(r.name!);
    if (seenKeys.has(key)) {
      dupIndices.add(i);
      r.issues.push(`Duplicate of an earlier <GROUP NAME="${r.name}"> in this same file — only the first is imported.`);
    } else {
      seenKeys.add(key);
    }
  }

  const { order, cyclic } = topoOrderGroups(rawGroups);
  for (const i of cyclic) {
    if (!dupIndices.has(i) && rows[i].issues.length === 0) {
      rows[i].issues.push("This group's parent chain (within this file) loops back on itself — cannot be resolved.");
    }
  }

  let position = 0;
  for (const i of order) {
    const row = rows[i];
    if (row.issues.length > 0 || dupIndices.has(i) || !row.name) continue;
    row.commitOrder = position++;

    const key = normalizeLoose(row.name);
    row.key = key;
    const parentRaw = row.parentNameRaw;
    const parentKey = parentRaw ? normalizeLoose(parentRaw) : null;
    const isTopLevel = !parentKey || parentKey === "primary";

    // A row's own name can only collide here with an EXISTING seeded entry —
    // never with another in-file row's pending entry, since dupIndices above
    // already excluded same-key duplicates within the file.
    const alreadyExists = idByKey.get(key);
    if (alreadyExists && alreadyExists.source === "existing") {
      row.resolved = { kind: "exists", id: alreadyExists.id, normalBalance: alreadyExists.normalBalance };
      continue;
    }

    if (isTopLevel) {
      row.issues.push(
        "This is a top-level group (Tally PARENT is \"Primary\" or blank). Tally's own export format doesn't carry a top-level custom group's accounting nature (asset / liability / income / expense / capital) since there's no parent to inherit it from. Create it manually in LEKHA first — choosing its nature there — and re-run this import; the ledgers under it will then resolve automatically."
      );
      continue;
    }

    const parentMatch = idByKey.get(parentKey!);
    if (parentMatch) {
      row.resolved =
        parentMatch.source === "existing"
          ? { kind: "create", parent: { type: "existing", id: parentMatch.id }, normalBalance: parentMatch.normalBalance }
          : { kind: "create", parent: { type: "in_file", key: parentKey! }, normalBalance: parentMatch.normalBalance };
      // Registers this row's own key so a later row nested under IT (e.g. a
      // third level of custom groups) can also resolve — as an in_file
      // reference, never as a fake "existing" id.
      idByKey.set(key, { source: "in_file", normalBalance: parentMatch.normalBalance });
      continue;
    }

    row.issues.push(
      `Parent group "${parentRaw}" not found — it isn't an existing LEKHA group, a recognised Tally built-in group name, or another group in this file. Create "${parentRaw}" first, or check the spelling.`
    );
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------

export type LedgerInsertPayload = {
  name: string;
  group_id: string;
  opening_balance_amount: number;
  opening_balance_type: "debit" | "credit";
  gstin: string | null;
  pan: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  state_code: string | null;
  email: string | null;
  phone: string | null;
};

export type LedgerPreviewRow = {
  sourceIndex: number;
  name: string | null;
  parentNameRaw: string | null;
  issues: string[];
  notes: string[];
  possibleDuplicate: boolean;
  data: LedgerInsertPayload | null;
};

/**
 * `ctx.groupIdByKey` maps a group's normalized name to its id — seeded from
 * the company's existing groups and, once known, newly-created ones too.
 * This function only reads it; the caller decides what's in it. For a
 * display-only preview a not-yet-inserted group can use any placeholder
 * string here safely, since nothing in this function writes to the
 * database — the component's real commit path always substitutes real ids
 * before calling this again for the authoritative, ready-to-insert pass.
 */
export function buildLedgerPreview(
  rawLedgers: RawLedger[],
  ctx: {
    groupIdByKey: Map<string, string>;
    existingLedgerNames: string[];
    refStates: { code: string; name: string }[];
  }
): LedgerPreviewRow[] {
  const existingNamesNorm = new Set(ctx.existingLedgerNames.map((n) => normalizeName(n)));
  const fileNamesNorm = new Set<string>();
  // ledgers_company_name_idx is a real UNIQUE (company_id, lower(name))
  // index — confirmed live (not assumed from migration 0006, which predates
  // it) after this importer's own round-trip test hit it: ten ledgers
  // previewed as merely "possible duplicate" and then failed at commit with
  // exactly this constraint. An exact lower(name) collision is now a
  // blocking issue rather than a soft warning; a same-ish-but-not-identical
  // name (extra punctuation/spacing) still only gets the soft note, since
  // that case genuinely does insert successfully.
  const existingExactNorm = new Set(ctx.existingLedgerNames.map((n) => n.trim().toLowerCase()));
  const fileExactNorm = new Set<string>();
  const stateByName = new Map(ctx.refStates.map((s) => [normalizeLoose(s.name), s.code]));

  return rawLedgers.map((l): LedgerPreviewRow => {
    const issues: string[] = [...l.issues];
    const notes: string[] = [];

    if (!l.name) {
      return { sourceIndex: l.sourceIndex, name: null, parentNameRaw: l.parentName, issues, notes, possibleDuplicate: false, data: null };
    }

    const parentKey = l.parentName ? normalizeLoose(l.parentName) : null;
    const groupId = parentKey ? ctx.groupIdByKey.get(parentKey) : undefined;
    if (!groupId) {
      issues.push(
        l.parentName
          ? `No group named "${l.parentName}" — import chart-of-accounts groups first (either in this file or already in LEKHA), then re-import ledgers.`
          : "No PARENT group given for this ledger."
      );
    }

    let gstin: string | null = null;
    if (l.gstin) {
      const g = l.gstin.toUpperCase().trim();
      if (!isValidGstin(g)) {
        issues.push(`GSTIN "${l.gstin}" doesn't pass the GSTN structure/checksum check.`);
      } else {
        gstin = g;
      }
    }

    let pan: string | null = null;
    if (l.pan) {
      const p = l.pan.toUpperCase().trim();
      if (!PAN_PATTERN.test(p)) {
        issues.push(`PAN "${l.pan}" doesn't match the PAN format (5 letters, 4 digits, 1 letter).`);
      } else {
        pan = p;
      }
    }

    let pincode: string | null = null;
    if (l.pincode) {
      if (!PINCODE_PATTERN.test(l.pincode.trim())) {
        issues.push(`Pincode "${l.pincode}" isn't a valid 6-digit Indian PIN.`);
      } else {
        pincode = l.pincode.trim();
      }
    }

    let email: string | null = null;
    if (l.email) {
      if (!EMAIL_PATTERN.test(l.email.trim())) {
        issues.push(`Email "${l.email}" doesn't look like a valid address.`);
      } else {
        email = l.email.trim();
      }
    }

    // GSTIN embeds the state, and the DB derives state_code from it on
    // insert anyway (app_private.enforce_ledger_gst_identity) — LEDSTATENAME
    // only needs resolving when there's no GSTIN to derive it from.
    let stateCode: string | null = null;
    if (!gstin && l.stateName) {
      const match = stateByName.get(normalizeLoose(l.stateName));
      if (match) {
        stateCode = match;
      } else {
        notes.push(`State "${l.stateName}" wasn't recognised — left blank. Set it manually on the ledger if needed.`);
      }
    }

    const openingAbs = l.openingBalanceRaw === null ? 0 : Math.abs(l.openingBalanceRaw);
    // Matches lib/tally/xml.ts's own documented (and, per this feature's own
    // research, genuinely unresolved-against-real-Tally) convention: positive
    // = debit. See this feature's final report for the caveat — files this
    // app's own exporter produced round-trip correctly either way since both
    // sides agree; a real third-party Tally export is the actual risk.
    const openingType: "debit" | "credit" = (l.openingBalanceRaw ?? 0) >= 0 ? "debit" : "credit";

    const normalized = normalizeName(l.name);
    const exact = l.name.trim().toLowerCase();
    const exactDuplicate = existingExactNorm.has(exact) || fileExactNorm.has(exact);
    const possibleDuplicate = !exactDuplicate && (existingNamesNorm.has(normalized) || fileNamesNorm.has(normalized));
    fileNamesNorm.add(normalized);
    if (exactDuplicate) {
      issues.push(
        fileExactNorm.has(exact)
          ? `Duplicate of an earlier ledger named "${l.name}" in this same file — ledger names must be unique, only the first is imported.`
          : `A ledger named "${l.name}" already exists in LEKHA — ledger names must be unique here even though Tally allows same-named ledgers under different internal IDs. Rename one of them.`
      );
    }
    fileExactNorm.add(exact);

    if (issues.length > 0) {
      return { sourceIndex: l.sourceIndex, name: l.name, parentNameRaw: l.parentName, issues, notes, possibleDuplicate, data: null };
    }

    return {
      sourceIndex: l.sourceIndex,
      name: l.name,
      parentNameRaw: l.parentName,
      issues: [],
      notes,
      possibleDuplicate,
      data: {
        name: l.name,
        group_id: groupId!,
        opening_balance_amount: openingAbs,
        opening_balance_type: openingType,
        gstin,
        pan,
        address: l.address,
        city: null,
        pincode,
        state_code: stateCode,
        email,
        phone: l.phone,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Vouchers (phase 2 — plain accounting vouchers only)
// ---------------------------------------------------------------------------

/** Tally voucher-type name (lowercased) -> LEKHA voucher_type. Deliberately the mirror image of the same four-plus-four split lib/tally/xml.ts's TALLY_VOUCHER_TYPE_NAME makes, but that map isn't exported, so this is hand-kept in sync. */
const SUPPORTED_VOUCHER_TYPES: Record<string, string> = {
  receipt: "receipt",
  payment: "payment",
  contra: "contra",
  journal: "journal",
};

const OUT_OF_SCOPE_VOUCHER_TYPES = new Set(["sales", "purchase", "credit note", "debit note"]);

export type VoucherLinePayload = { ledger_id: string; debit_amount: number; credit_amount: number; line_order: number };
export type VoucherInsertPayload = {
  group_key: string;
  branch_id: string;
  voucher_type: string;
  voucher_date: string;
  narration: string | null;
  reference_number: string | null;
  lines: VoucherLinePayload[];
};

export type VoucherPreviewRow = {
  sourceIndex: number;
  vchType: string | null;
  dateRaw: string | null;
  voucherNumber: string | null;
  issues: string[];
  data: VoucherInsertPayload | null;
};

function parseTallyDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const [, y, m, d] = compact;
    return `${y}-${m}-${d}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  return null;
}

export function buildVoucherPreview(
  rawVouchers: RawVoucher[],
  ctx: { ledgerIdByName: Map<string, string>; lockDate: string | null; branchId: string }
): VoucherPreviewRow[] {
  return rawVouchers.map((v): VoucherPreviewRow => {
    const issues: string[] = [...v.issues];

    const typeLower = v.vchType?.trim().toLowerCase() ?? "";
    const mappedType = SUPPORTED_VOUCHER_TYPES[typeLower];
    if (!mappedType) {
      if (OUT_OF_SCOPE_VOUCHER_TYPES.has(typeLower)) {
        issues.push(
          `"${v.vchType}" vouchers are out of scope for this importer — they need item-level HSN/rate mapping from Tally's own stock item master, which this pass doesn't attempt. Use the item-level Sales & Purchase CSV importer instead.`
        );
      } else if (v.vchType) {
        issues.push(`Voucher type "${v.vchType}" isn't one this importer handles (Receipt, Payment, Contra, Journal only).`);
      }
    }

    const date = parseTallyDate(v.dateRaw);
    if (!date) {
      issues.push(v.dateRaw ? `DATE "${v.dateRaw}" isn't a valid YYYYMMDD date.` : "No DATE found.");
    } else if (ctx.lockDate && date <= ctx.lockDate) {
      issues.push(`The books are locked on or before ${ctx.lockDate}; this voucher's date (${date}) is on or before that.`);
    }

    if (v.entries.length < 2) {
      issues.push("A voucher needs at least two ledger entries.");
    }

    const lines: VoucherLinePayload[] = [];
    let drPaise = 0;
    let crPaise = 0;
    let entryProblem = false;
    v.entries.forEach((e, i) => {
      if (!e.ledgerName) {
        issues.push(`Entry ${i + 1} has no LEDGERNAME.`);
        entryProblem = true;
        return;
      }
      const ledgerId = ctx.ledgerIdByName.get(normalizeName(e.ledgerName));
      if (!ledgerId) {
        issues.push(`No ledger named "${e.ledgerName}" — import chart-of-accounts ledgers first, then re-import vouchers.`);
        entryProblem = true;
        return;
      }
      if (e.amountRaw === null) {
        issues.push(`Entry for "${e.ledgerName}" has no AMOUNT.`);
        entryProblem = true;
        return;
      }
      // ISDEEMEDPOSITIVE is the authoritative flag; the amount's own sign
      // (debit-negative, per lib/tally/xml.ts's STRONGLY-sourced convention
      // for voucher entries) is only a fallback for a file that omits it.
      const isDebit =
        e.isDeemedPositiveRaw?.toLowerCase() === "yes"
          ? true
          : e.isDeemedPositiveRaw?.toLowerCase() === "no"
            ? false
            : e.amountRaw < 0;
      const amount = Math.abs(e.amountRaw);
      const paise = Math.round(amount * 100);
      if (isDebit) drPaise += paise;
      else crPaise += paise;
      lines.push({
        ledger_id: ledgerId,
        debit_amount: isDebit ? amount : 0,
        credit_amount: isDebit ? 0 : amount,
        line_order: i,
      });
    });

    if (!entryProblem && v.entries.length >= 2 && drPaise !== crPaise) {
      issues.push(`Debit ${(drPaise / 100).toFixed(2)} does not equal credit ${(crPaise / 100).toFixed(2)}.`);
    }

    if (issues.length > 0) {
      return { sourceIndex: v.sourceIndex, vchType: v.vchType, dateRaw: v.dateRaw, voucherNumber: v.voucherNumber, issues, data: null };
    }

    return {
      sourceIndex: v.sourceIndex,
      vchType: v.vchType,
      dateRaw: v.dateRaw,
      voucherNumber: v.voucherNumber,
      issues: [],
      data: {
        group_key: v.voucherNumber ? `${v.voucherNumber}-${v.sourceIndex}` : `TALLY-${v.sourceIndex}`,
        branch_id: ctx.branchId,
        voucher_type: mappedType!,
        voucher_date: date!,
        narration: v.narration,
        reference_number: v.voucherNumber,
        lines,
      },
    };
  });
}
