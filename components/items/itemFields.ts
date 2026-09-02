// Shared vocabulary for the item master, lifted out of ItemManager.tsx when
// ItemEditPanel.tsx arrived and needed the identical lists. Deliberately a
// plain module with no "use client": both importers are client components, and
// a "use client" file's exports become server-boundary proxies if a server
// component ever touches them.
//
// The friendly-error mapper at the bottom is the item-master twin of
// lib/ledgers/friendlyError.ts (wave 7, 1 Sep 2026) — same lesson, same shape:
// a mistyped HSN surfacing as `new row for relation "items" violates check
// constraint "items_hsn_sac_check"` is not an error message, it is a stack
// trace shown to an accountant. It lives here rather than under lib/ only so
// that this task touches nothing outside components/items.

import type { PostgrestError } from "@supabase/supabase-js";

// The rates actually notified for goods and services — not every percentage
// in between, so a typo like 12.5 does not sit unnoticed on an invoice.
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

// Four legally distinct categories that a zero rate used to collapse into one.
// Zero-rated (export/SEZ) is deliberately absent: it is a property of the
// transaction, not of the item — the same goods are taxable domestically.
export const SUPPLY_NATURES = [
  { value: "taxable", label: "Taxable", hint: "Attracts GST at the rate below" },
  { value: "nil_rated", label: "Nil-rated", hint: "Taxable under GST, tariff rate 0% — no ITC" },
  { value: "exempt", label: "Exempt", hint: "Exempted by notification (Sec 11) — no ITC" },
  { value: "non_gst", label: "Non-GST", hint: "Outside GST — petrol, diesel, alcohol" },
];

// Sec 17(5) blocks ITC on these however genuine the business purpose. The
// clause is stored alongside the flag so an auditor can be told which limb
// applies, not merely that something does.
export const ITC_BLOCK_CLAUSES = [
  { value: "17(5)(a)", label: "17(5)(a) — Motor vehicles (13 seats or fewer)" },
  { value: "17(5)(aa)", label: "17(5)(aa) — Vessels and aircraft" },
  { value: "17(5)(ab)", label: "17(5)(ab) — Insurance, servicing, repair of the above" },
  { value: "17(5)(b)", label: "17(5)(b) — Food, catering, club, insurance, travel benefits" },
  { value: "17(5)(c)", label: "17(5)(c) — Works contract for immovable property" },
  { value: "17(5)(d)", label: "17(5)(d) — Construction on own account" },
  { value: "17(5)(e)", label: "17(5)(e) — Supplies taxed under composition" },
  { value: "17(5)(f)", label: "17(5)(f) — Supplies to a non-resident taxable person" },
  { value: "17(5)(fa)", label: "17(5)(fa) — CSR expenditure" },
  { value: "17(5)(g)", label: "17(5)(g) — Personal consumption" },
  { value: "17(5)(h)", label: "17(5)(h) — Gifts, free samples, goods lost or written off" },
  { value: "17(5)(i)", label: "17(5)(i) — Tax paid under Sec 74, 129 or 130" },
];

export const BATCH_TRACKING_MODES = [
  {
    value: "none",
    label: "Not tracked",
    hint: "Stock is a single pooled quantity — no lot or serial numbers.",
  },
  {
    value: "batch",
    label: "Batch / lot",
    hint: "Quantities grouped under a batch or lot number, with optional manufacture and expiry dates.",
  },
  {
    value: "serial",
    label: "Serial",
    hint: "One row per physical unit — every allocation is exactly one unit.",
  },
];

/**
 * Per-item facts from get_item_edit_context (1370). The counts decide which
 * fields the form may offer at all; the same questions are asked again by
 * app_private.protect_item_master_fields, which is the real gate — this is
 * only here so a locked field looks locked instead of failing on save.
 */
export type ItemEditContext = {
  item_id: string;
  stock_line_count: number;
  uom_conversion_count: number;
  batch_master_count: number;
  batch_allocation_count: number;
  non_unit_allocation_count: number;
  unallocated_line_count: number;
  closing_quantity: number;
};

export const EMPTY_ITEM_EDIT_CONTEXT: Omit<ItemEditContext, "item_id"> = {
  stock_line_count: 0,
  uom_conversion_count: 0,
  batch_master_count: 0,
  batch_allocation_count: 0,
  non_unit_allocation_count: 0,
  unallocated_line_count: 0,
  closing_quantity: 0,
};

/**
 * Turns a raw Postgres error from a direct `items` insert/update into a plain
 * English message.
 *
 * The P0001 messages raised by app_private.protect_item_master_fields (1370)
 * are already written for a human and name the count and the way out, so they
 * pass through untouched — re-wording them here would only let the two drift.
 * Anything unrecognised also falls through verbatim rather than being
 * swallowed into a generic "something went wrong" that hides what to fix.
 */
export function friendlyItemError(error: PostgrestError, itemName: string): string {
  const message = error.message ?? "";

  if (error.code === "23505") {
    if (message.includes("items_company_code_idx")) {
      return "Another item in this company already uses that code.";
    }
    return `This company already has an item called "${itemName}".`;
  }
  if (message.includes("items_hsn_sac_check")) {
    return "An HSN/SAC must be 4 to 8 digits, numbers only — e-invoicing needs at least 6. Leave it blank rather than entering a partial code.";
  }
  if (message.includes("items_non_taxable_has_no_rate")) {
    return "A nil-rated, exempt or non-GST item cannot carry a GST or cess rate — set the supply nature back to Taxable, or clear the rates.";
  }
  if (message.includes("items_opening_value_with_quantity")) {
    return "An opening quantity needs an opening value above zero, or the first issue would be costed at nothing.";
  }
  if (message.includes("items_opening_quantity_check") || message.includes("items_opening_value_check")) {
    return "Opening quantity and opening value cannot be negative.";
  }
  if (message.includes("items_batch_tracking_needs_stock")) {
    return "Only a goods item that maintains stock can be batch or serial tracked — a service has no physical units to track.";
  }
  if (message.includes("items_itc_clause_matches_eligibility")) {
    return "An ITC block needs a Sec 17(5) clause and a clause needs a block — set both or neither.";
  }
  if (message.includes("items_service_has_no_stock")) {
    return "A service cannot hold stock or an opening quantity.";
  }
  if (message.includes("items_name_check")) {
    return "An item needs a name.";
  }
  if (message.includes("items_uom_fkey")) {
    return "That unit is not one the GST system issues as a UQC — pick one from the list.";
  }
  if (message.includes("items_default_tcs_section_fkey")) {
    return "That TCS section is not one this app knows — pick one from the list.";
  }
  return message;
}
