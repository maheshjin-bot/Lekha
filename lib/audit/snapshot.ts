/**
 * Reading an audit_log entry.
 *
 * get_audit_trail returns the before/after snapshots the trigger captured
 * (1580 - until then the reader returned only the NAMES of the changed
 * fields and threw the values away). Turning a snapshot into something a
 * reviewer can read is all pure data work, so it lives here rather than in
 * the page: an audit trail nobody can read is the defect being fixed, and
 * this is the part of the fix worth testing.
 *
 * Redaction is NOT done here. It happens in app_private.audit_redact, on the
 * database side, before a snapshot ever leaves: credentials come back as
 * "[redacted]" and bank account numbers masked to their last four digits.
 * Doing it in the browser layer would mean the values had already been sent.
 */

export type AuditSnapshot = Record<string, unknown>;

/** One row as get_audit_trail returns it. */
export type AuditEntry = {
  id: string;
  table_name: string;
  record_id: string | null;
  operation: string;
  changed_fields: string[] | null;
  derived_note: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_at: string;
  before_data: unknown;
  after_data: unknown;
};

/** An entry after same-transaction line-set rows have been folded together. */
export type AuditEvent = AuditEntry & {
  /** How many audit_log rows this one displayed event was assembled from. */
  entryCount: number;
};

function asObject(value: unknown): AuditSnapshot | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AuditSnapshot)
    : null;
}

/**
 * A snapshot written by app_private.audit_voucher_lines(): a whole set of a
 * document's lines, rather than one row of a table.
 */
export function isLineSet(value: unknown): boolean {
  const obj = asObject(value);
  return obj !== null && Array.isArray(obj.lines);
}

function lineArray(value: unknown): AuditSnapshot[] {
  const obj = asObject(value);
  if (!obj || !Array.isArray(obj.lines)) return [];
  return obj.lines.filter((l): l is AuditSnapshot => asObject(l) !== null);
}

function lineOrder(line: AuditSnapshot): number {
  const raw = line.line_order;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Folds the audit_log rows that one transaction wrote for one document's
 * lines into one event per operation.
 *
 * Why this is needed: update_invoice deletes an invoice's lines in a single
 * statement (one audit row, all lines) but re-inserts them one line at a
 * time, inside `for v_item in select * from jsonb_array_elements(p_items)`.
 * Each of those is its own INSERT statement, so the statement-level trigger
 * fires once per line and an N-line edit writes 1 + N rows. Everything one
 * transaction wrote shares a changed_at (now() is the transaction timestamp)
 * and, for a given document, a record_id - so the pieces of one edit are
 * identifiable without guessing, and this puts them back together.
 *
 * Nothing is dropped and nothing in the log is rewritten: the entries stay
 * exactly as written, and only rows carrying a `lines` set are ever folded.
 * That restriction matters - two ordinary UPDATEs of the same row in one
 * transaction (the invoice header and its recalculated total, for instance)
 * share the same key too, and merging those would hide a change.
 */
export function mergeLineSetEvents(rows: readonly AuditEntry[]): AuditEvent[] {
  const events: AuditEvent[] = [];
  const byKey = new Map<string, AuditEvent>();

  for (const row of rows) {
    const mergeable = isLineSet(row.before_data) || isLineSet(row.after_data);
    if (!mergeable) {
      events.push({ ...row, entryCount: 1 });
      continue;
    }

    const keyParts = [row.changed_at, row.table_name, row.record_id ?? "", row.operation];
    const key = keyParts.join("");
    const existing = byKey.get(key);
    if (!existing) {
      const event: AuditEvent = { ...row, entryCount: 1 };
      byKey.set(key, event);
      events.push(event);
      continue;
    }

    existing.entryCount += 1;
    existing.before_data = combineLineSets(existing.before_data, row.before_data);
    existing.after_data = combineLineSets(existing.after_data, row.after_data);
  }

  return events;
}

function combineLineSets(a: unknown, b: unknown): unknown {
  if (!isLineSet(a)) return isLineSet(b) ? b : a;
  if (!isLineSet(b)) return a;
  const lines = [...lineArray(a), ...lineArray(b)].sort((x, y) => lineOrder(x) - lineOrder(y));
  return { line_count: lines.length, lines };
}

/** Columns that say nothing about what a person changed. */
const NOISE_FIELDS = new Set([
  "id",
  "company_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
]);

const FIELD_LABELS: Record<string, string> = {
  cin: "CIN",
  gstin: "GSTIN",
  gst_rate_percent: "GST rate %",
  cess_rate_percent: "Cess rate %",
  hsn_sac: "HSN/SAC",
  iec: "IEC",
  pan: "PAN",
  tan: "TAN",
  uan: "UAN",
  uom: "Unit",
  upi_vpa: "UPI ID",
  lut_number: "LUT number",
  ldc_number: "LDC number",
  password_hash: "Company password",
  bank_account_number: "Bank account number",
  print_bank_account_number: "Bank account number (print)",
  discount_percent: "Discount %",
  place_of_supply: "Place of supply",
  is_deleted: "Deleted",
  is_active: "Active",
  line_count: "Number of lines",
};

/** "opening_balance_amount" -> "Opening balance amount". */
export function fieldLabel(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  const words = field.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A snapshot value as a reviewer should see it. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type FieldChange = { field: string; label: string; before: string; after: string };

/**
 * The changed fields of an UPDATE, with their values either side.
 *
 * changed_fields comes from the database, computed against the UNREDACTED
 * snapshots - so a changed password or bank account is still reported as
 * changed even though its value is never shown.
 */
export function fieldChanges(entry: AuditEntry): FieldChange[] {
  const before = asObject(entry.before_data) ?? {};
  const after = asObject(entry.after_data) ?? {};
  return (entry.changed_fields ?? [])
    .filter((f) => !NOISE_FIELDS.has(f))
    .map((field) => ({
      field,
      label: fieldLabel(field),
      before: formatValue(before[field]),
      after: formatValue(after[field]),
    }));
}

/** The fields worth showing for an INSERT or a DELETE, most useful first. */
export function snapshotFields(snapshot: unknown): FieldChange[] {
  const obj = asObject(snapshot);
  if (!obj) return [];
  return Object.entries(obj)
    .filter(([key, value]) => !NOISE_FIELDS.has(key) && value !== null && value !== "")
    .map(([field, value]) => ({
      field,
      label: fieldLabel(field),
      before: "",
      after: formatValue(value),
    }));
}

export type DisplayLine = {
  order: string;
  item: string;
  quantity: string;
  rate: string;
  discount: string;
  amount: string;
  hsn: string;
};

/** A line set, as a table a reviewer can read. */
export function displayLines(snapshot: unknown): DisplayLine[] {
  return lineArray(snapshot)
    .slice()
    .sort((a, b) => lineOrder(a) - lineOrder(b))
    .map((line) => ({
      order: formatValue(
        typeof line.line_order === "number" ? line.line_order + 1 : line.line_order
      ),
      item: formatValue(line.item_name ?? line.description ?? line.item_id),
      quantity: formatValue(line.quantity),
      rate: formatValue(line.rate),
      discount: formatValue(line.discount_percent),
      amount: formatValue(line.amount),
      hsn: formatValue(line.hsn_sac),
    }));
}

/**
 * The voucher an entry belongs to, if it belongs to one - so the entry can
 * link to the document rather than showing a bare uuid.
 *
 * For `vouchers` and for a line table logged by audit_voucher_lines(),
 * record_id IS the voucher. For voucher_entries, logged row by row since
 * 0008, record_id is the individual line's own id and the voucher is inside
 * the snapshot.
 */
export function voucherIdOf(entry: AuditEntry): string | null {
  if (entry.table_name === "vouchers" || isLineSet(entry.before_data) || isLineSet(entry.after_data)) {
    return entry.record_id;
  }
  const snapshot = asObject(entry.after_data) ?? asObject(entry.before_data);
  const voucherId = snapshot?.voucher_id;
  return typeof voucherId === "string" ? voucherId : null;
}

/** How the entry should read in the "What changed" column heading position. */
export function operationLabel(entry: AuditEntry): string {
  const lines = isLineSet(entry.after_data)
    ? displayLines(entry.after_data).length
    : isLineSet(entry.before_data)
      ? displayLines(entry.before_data).length
      : null;

  if (lines === null) return entry.operation;
  const plural = lines === 1 ? "line" : "lines";
  if (entry.operation === "DELETE") return `${lines} ${plural} removed`;
  if (entry.operation === "INSERT") return `${lines} ${plural} written`;
  return `${lines} ${plural} amended`;
}
