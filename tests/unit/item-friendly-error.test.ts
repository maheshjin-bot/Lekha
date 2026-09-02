import { describe, expect, it } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";
import { friendlyItemError } from "@/components/items/itemFields";

/**
 * The value of this mapping is entirely in the constraint names being the REAL
 * ones. A mapping keyed on a name that no longer exists silently stops firing
 * and the raw Postgres text reaches the screen again — the regression the
 * ledgers and registrations helpers were both written to fix.
 *
 * Every name asserted below was copied from `pg_constraint` on the live LEKHA
 * database (project msgzicwfdoxaswgmevyg), not from the migration files:
 *
 *   select conname from pg_constraint where conrelid = 'public.items'::regclass;
 *
 *     items_hsn_sac_check                    items_opening_value_with_quantity
 *     items_non_taxable_has_no_rate          items_batch_tracking_needs_stock
 *     items_itc_clause_matches_eligibility   items_service_has_no_stock
 *     items_name_check                       items_uom_fkey
 *     items_opening_quantity_check           items_default_tcs_section_fkey
 *     items_opening_value_check
 *
 * The two unique INDEXES are not constraints and so are not in that list —
 * items_company_name_idx and items_company_code_idx (0013:81-82) surface as
 * error code 23505, which is why the code is matched rather than a name.
 */
const err = (message: string, code = "23514"): PostgrestError =>
  ({ message, code, details: "", hint: "", name: "PostgrestError" }) as PostgrestError;

describe("friendlyItemError maps the real items constraints", () => {
  it("explains a bad HSN instead of quoting the check constraint", () => {
    const msg = friendlyItemError(
      err('new row for relation "items" violates check constraint "items_hsn_sac_check"'),
      "Red Chilli Powder 500g Pouch"
    );
    expect(msg).toContain("4 to 8 digits");
    expect(msg).not.toContain("items_hsn_sac_check");
  });

  it("names the item on a duplicate name, and the code on a duplicate code", () => {
    expect(
      friendlyItemError(
        err('duplicate key value violates unique constraint "items_company_name_idx"', "23505"),
        "Turmeric Powder 500g Pouch"
      )
    ).toContain('"Turmeric Powder 500g Pouch"');

    expect(
      friendlyItemError(
        err('duplicate key value violates unique constraint "items_company_code_idx"', "23505"),
        "Turmeric Powder 500g Pouch"
      )
    ).toContain("code");
  });

  it("explains a rate on a non-taxable supply", () => {
    const msg = friendlyItemError(
      err('violates check constraint "items_non_taxable_has_no_rate"'),
      "Fresh Milk"
    );
    expect(msg).toContain("nil-rated, exempt or non-GST");
    expect(msg).not.toContain("items_non_taxable_has_no_rate");
  });

  it("explains an opening quantity with no value", () => {
    expect(
      friendlyItemError(err('violates check constraint "items_opening_value_with_quantity"'), "X")
    ).toContain("costed at nothing");
  });

  it("explains batch tracking on something that holds no stock", () => {
    const msg = friendlyItemError(
      err('violates check constraint "items_batch_tracking_needs_stock"'),
      "Grinding & Milling Charges"
    );
    expect(msg).toContain("goods item that maintains stock");
    expect(msg).not.toContain("items_batch_tracking_needs_stock");
  });

  it("explains a half-set ITC block", () => {
    expect(
      friendlyItemError(err('violates check constraint "items_itc_clause_matches_eligibility"'), "X")
    ).toContain("Sec 17(5) clause");
  });

  it("passes protect_item_master_fields' own P0001 messages through untouched", () => {
    // These are raised by the trigger in migration 1370, already written for a
    // human and already naming the count and the way out. Re-wording them here
    // would only let the two copies drift.
    const raw =
      'Cannot turn batch/serial tracking off for "Raw Turmeric Fingers": 1 stock line allocation(s) covering 2000.000 KGS are already recorded against its batches.';
    expect(friendlyItemError(err(raw, "P0001"), "Raw Turmeric Fingers")).toBe(raw);

    const admin =
      "Only an admin can change an item's opening quantity or opening value — it is this item's share of the balance sheet on day one, the same as a ledger's opening balance.";
    expect(friendlyItemError(err(admin, "P0001"), "X")).toBe(admin);
  });

  it("falls through verbatim rather than swallowing an error it does not know", () => {
    const unknown = 'relation "items_future_column" does not exist';
    expect(friendlyItemError(err(unknown, "42P01"), "X")).toBe(unknown);
  });
});
