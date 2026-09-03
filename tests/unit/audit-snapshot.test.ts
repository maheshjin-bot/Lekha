/**
 * The audit-trail reader's pure logic — get_audit_trail (1580) now returns
 * before/after snapshots instead of throwing them away, and this is the code
 * that turns a snapshot into something a reviewer can read.
 *
 * Fixture shapes are taken from what app_private.audit_voucher_lines() and
 * app_private.audit_change() actually write, confirmed live against Sharma
 * Textiles' invoice HO/SAL/2026-27/00023 while building 1580 (see that
 * migration's own header for the dry run this was checked against).
 */
import { describe, expect, it } from "vitest";
import {
  displayLines,
  fieldChanges,
  fieldLabel,
  formatValue,
  isLineSet,
  mergeLineSetEvents,
  operationLabel,
  snapshotFields,
  voucherIdOf,
  type AuditEntry,
} from "@/lib/audit/snapshot";

const VOUCHER_ID = "fd7d45fe-95bb-4562-a8d8-8c98d861ec9c";

function baseEntry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    table_name: "voucher_items",
    record_id: VOUCHER_ID,
    operation: "DELETE",
    changed_fields: null,
    derived_note: null,
    changed_by: "5d0be511-d7f6-4d2d-9793-925d2bd96fda",
    changed_by_name: "tester@lekha.test",
    changed_at: "2026-09-02T12:44:22.86519+00:00",
    before_data: null,
    after_data: null,
    ...overrides,
  };
}

const oldLineSet = {
  line_count: 2,
  lines: [
    {
      id: "1bedcec5-8d1c-4349-aa1a-42043c999ad2",
      item_id: "64c9327b-37a3-41bf-bde9-a6cbe0aa87d0",
      item_name: "Cotton Shirting 40s Grey (0865 staged capture)",
      quantity: 120,
      rate: 250,
      amount: 30000,
      discount_percent: 0,
      hsn_sac: "5208",
      line_order: 0,
    },
    {
      id: "f118a097-eab7-48f3-b8ad-027c94858661",
      item_id: "9e99856c-3141-4652-8a87-bd6d8b01dec6",
      item_name: "Finished Widget",
      quantity: 2,
      rate: 8000,
      amount: 16000,
      discount_percent: 0,
      hsn_sac: "8479",
      line_order: 1,
    },
  ],
};

// update_invoice re-inserts one line per statement, so the INSERT side of a
// two-line edit arrives as two separate audit_log rows sharing one
// changed_at — line_order 1 written first in this fixture, exactly the order
// it came back in the live dry run.
const newLineRow1 = {
  line_count: 1,
  lines: [
    {
      id: "5dd89474-2ac3-4e8b-9ad5-db1c7a84d3e4",
      item_id: "9e99856c-3141-4652-8a87-bd6d8b01dec6",
      item_name: "Finished Widget",
      quantity: 2,
      rate: 8000,
      amount: 16000,
      discount_percent: 0,
      hsn_sac: "8479",
      line_order: 1,
    },
  ],
};

const newLineRow0 = {
  line_count: 1,
  lines: [
    {
      id: "c9908e34-5ae9-43cb-9113-96de9dc0d5dd",
      item_id: "64c9327b-37a3-41bf-bde9-a6cbe0aa87d0",
      item_name: "Cotton Shirting 40s Grey (0865 staged capture)",
      quantity: 130,
      rate: 250,
      amount: 32500,
      discount_percent: 0,
      hsn_sac: "5208",
      line_order: 0,
    },
  ],
};

describe("isLineSet", () => {
  it("recognises a snapshot written by audit_voucher_lines", () => {
    expect(isLineSet(oldLineSet)).toBe(true);
  });

  it("rejects an ordinary row snapshot", () => {
    expect(isLineSet({ id: "x", name: "Acme" })).toBe(false);
  });

  it("rejects null, arrays and primitives", () => {
    expect(isLineSet(null)).toBe(false);
    expect(isLineSet([1, 2, 3])).toBe(false);
    expect(isLineSet("lines")).toBe(false);
  });
});

describe("mergeLineSetEvents", () => {
  it("folds the DELETE (1 row) and the two per-line INSERTs (2 rows) of one update_invoice edit into two events", () => {
    const rows: AuditEntry[] = [
      baseEntry({ id: "a1", operation: "DELETE", before_data: oldLineSet, after_data: null }),
      baseEntry({ id: "a2", operation: "INSERT", before_data: null, after_data: newLineRow1 }),
      baseEntry({ id: "a3", operation: "INSERT", before_data: null, after_data: newLineRow0 }),
    ];

    const events = mergeLineSetEvents(rows);

    expect(events).toHaveLength(2);

    const del = events.find((e) => e.operation === "DELETE")!;
    expect(del.entryCount).toBe(1);
    expect(displayLines(del.before_data)).toHaveLength(2);

    const ins = events.find((e) => e.operation === "INSERT")!;
    expect(ins.entryCount).toBe(2);
    const lines = displayLines(ins.after_data);
    expect(lines).toHaveLength(2);
    // Sorted by line_order regardless of the order the underlying rows
    // arrived in — row1 (line_order 1) came before row0 (line_order 0).
    expect(lines.map((l) => l.item)).toEqual(["Cotton Shirting 40s Grey (0865 staged capture)", "Finished Widget"]);
  });

  it("does not merge two ordinary row-level rows sharing a timestamp", () => {
    // e.g. a voucher header UPDATE and its recalculated total in the same
    // transaction — merging those would hide one of the two changes.
    const rows: AuditEntry[] = [
      baseEntry({
        id: "b1",
        table_name: "vouchers",
        operation: "UPDATE",
        changed_fields: ["narration"],
        before_data: { narration: "old" },
        after_data: { narration: "new" },
      }),
      baseEntry({
        id: "b2",
        table_name: "vouchers",
        operation: "UPDATE",
        changed_fields: ["total_amount"],
        before_data: { total_amount: 100 },
        after_data: { total_amount: 200 },
      }),
    ];

    const events = mergeLineSetEvents(rows);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.entryCount === 1)).toBe(true);
  });

  it("keeps line-set events from different vouchers separate even at the same timestamp", () => {
    const rows: AuditEntry[] = [
      baseEntry({ id: "c1", record_id: "voucher-a", operation: "INSERT", after_data: newLineRow0 }),
      baseEntry({ id: "c2", record_id: "voucher-b", operation: "INSERT", after_data: newLineRow1 }),
    ];
    const events = mergeLineSetEvents(rows);
    expect(events).toHaveLength(2);
  });

  it("is a no-op on an empty list", () => {
    expect(mergeLineSetEvents([])).toEqual([]);
  });
});

describe("displayLines", () => {
  it("reads quantity, rate, amount, discount and HSN off each line, sorted by line_order", () => {
    const lines = displayLines(oldLineSet);
    expect(lines).toEqual([
      { order: "1", item: "Cotton Shirting 40s Grey (0865 staged capture)", quantity: "120", rate: "250", discount: "0", amount: "30000", hsn: "5208" },
      { order: "2", item: "Finished Widget", quantity: "2", rate: "8000", amount: "16000", discount: "0", hsn: "8479" },
    ]);
  });

  it("returns an empty list for a snapshot with no lines array", () => {
    expect(displayLines({ id: "x" })).toEqual([]);
    expect(displayLines(null)).toEqual([]);
  });
});

describe("fieldChanges", () => {
  it("pairs each changed field with its before and after value", () => {
    const entry = baseEntry({
      table_name: "ledgers",
      operation: "UPDATE",
      changed_fields: ["name", "credit_limit"],
      before_data: { name: "Old Traders", credit_limit: 50000 },
      after_data: { name: "New Traders", credit_limit: 75000 },
    });
    expect(fieldChanges(entry)).toEqual([
      { field: "name", label: "Name", before: "Old Traders", after: "New Traders" },
      { field: "credit_limit", label: "Credit limit", before: "50000", after: "75000" },
    ]);
  });

  it("drops bookkeeping columns (id, company_id, timestamps, who) even if the database reported them changed", () => {
    const entry = baseEntry({
      operation: "UPDATE",
      changed_fields: ["name", "updated_at", "updated_by", "id", "company_id", "created_at", "created_by"],
      before_data: { name: "A" },
      after_data: { name: "B" },
    });
    expect(fieldChanges(entry).map((c) => c.field)).toEqual(["name"]);
  });

  it("still reports a redacted field as changed, without a readable value", () => {
    // Redaction happens server-side in app_private.audit_redact before this
    // ever runs — the reader only ever sees the already-redacted string. The
    // point under test is that changed_fields is not suppressed just because
    // the values look identical after redaction.
    const entry = baseEntry({
      table_name: "companies",
      operation: "UPDATE",
      changed_fields: ["password_hash"],
      before_data: { password_hash: "[redacted]" },
      after_data: { password_hash: "[redacted]" },
    });
    expect(fieldChanges(entry)).toEqual([
      { field: "password_hash", label: "Company password", before: "[redacted]", after: "[redacted]" },
    ]);
  });

  it("returns an empty list when nothing of substance changed", () => {
    expect(fieldChanges(baseEntry({ operation: "UPDATE", changed_fields: null }))).toEqual([]);
    expect(fieldChanges(baseEntry({ operation: "UPDATE", changed_fields: [] }))).toEqual([]);
  });
});

describe("snapshotFields", () => {
  it("lists an INSERT's own fields, dropping null/empty and bookkeeping columns", () => {
    const fields = snapshotFields({
      id: "x",
      company_id: "y",
      name: "Acme Traders",
      gstin: "07AAAAA0000A1Z5",
      credit_limit: null,
      notes: "",
    });
    expect(fields.map((f) => f.field)).toEqual(["name", "gstin"]);
    expect(fields[1]).toEqual({ field: "gstin", label: "GSTIN", before: "", after: "07AAAAA0000A1Z5" });
  });
});

describe("fieldLabel", () => {
  it("uses a hand-written label for known abbreviations", () => {
    expect(fieldLabel("gstin")).toBe("GSTIN");
    expect(fieldLabel("hsn_sac")).toBe("HSN/SAC");
    expect(fieldLabel("pan")).toBe("PAN");
  });

  it("title-cases an unknown snake_case column", () => {
    expect(fieldLabel("opening_balance_amount")).toBe("Opening balance amount");
  });
});

describe("formatValue", () => {
  it("renders null, undefined and empty string as an em dash", () => {
    expect(formatValue(null)).toBe("—");
    expect(formatValue(undefined)).toBe("—");
    expect(formatValue("")).toBe("—");
  });

  it("renders booleans as Yes/No", () => {
    expect(formatValue(true)).toBe("Yes");
    expect(formatValue(false)).toBe("No");
  });

  it("passes numbers and strings through as text", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue("Acme")).toBe("Acme");
  });
});

describe("voucherIdOf", () => {
  it("is the record_id for a vouchers-table entry", () => {
    const entry = baseEntry({ table_name: "vouchers", record_id: VOUCHER_ID });
    expect(voucherIdOf(entry)).toBe(VOUCHER_ID);
  });

  it("is the record_id for a line-set entry (voucher_items), not a line id", () => {
    const entry = baseEntry({
      table_name: "voucher_items",
      record_id: VOUCHER_ID,
      before_data: oldLineSet,
    });
    expect(voucherIdOf(entry)).toBe(VOUCHER_ID);
  });

  it("is read out of the snapshot's own voucher_id for a row-level voucher_entries entry", () => {
    const entry = baseEntry({
      table_name: "voucher_entries",
      record_id: "entry-row-id",
      operation: "UPDATE",
      before_data: { voucher_id: VOUCHER_ID, debit_amount: 100 },
      after_data: { voucher_id: VOUCHER_ID, debit_amount: 200 },
    });
    expect(voucherIdOf(entry)).toBe(VOUCHER_ID);
  });

  it("is null for a table with no voucher at all", () => {
    const entry = baseEntry({
      table_name: "ledgers",
      record_id: "ledger-id",
      before_data: { name: "Acme" },
    });
    expect(voucherIdOf(entry)).toBeNull();
  });
});

describe("operationLabel", () => {
  it("counts lines for a line-set DELETE and INSERT", () => {
    expect(operationLabel(baseEntry({ operation: "DELETE", before_data: oldLineSet }))).toBe("2 lines removed");
    expect(operationLabel(baseEntry({ operation: "INSERT", after_data: newLineRow1 }))).toBe("1 line written");
  });

  it("falls back to the raw operation for an ordinary row", () => {
    expect(operationLabel(baseEntry({ table_name: "ledgers", operation: "UPDATE", before_data: { name: "A" }, after_data: { name: "B" } }))).toBe(
      "UPDATE"
    );
  });
});
