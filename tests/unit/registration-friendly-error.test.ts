import { describe, expect, it } from "vitest";
import { friendlyRegistrationError } from "@/lib/registrations/friendlyError";

/**
 * The value of this mapping is entirely in the constraint names being the
 * REAL ones. A mapping keyed on a name that no longer exists silently stops
 * firing and the raw Postgres text reaches the screen again — the exact
 * regression the ledgers helper was written to fix.
 *
 * Every name asserted below was copied from `pg_constraint` on the live LEKHA
 * database (project msgzicwfdoxaswgmevyg), not from the migration files:
 *
 *   select conname from pg_constraint
 *    where conrelid = 'public.gst_registrations'::regclass;
 *
 *     gst_registrations_gstin_check
 *     gst_registrations_gstin_key
 *     gst_registrations_company_id_state_code_registration_type_key
 *     gst_registrations_period_valid
 *     gst_registrations_state_code_fkey
 *
 * Note the third one is TRUNCATED by Postgres' 63-byte identifier limit —
 * the natural name would be gst_registrations_company_id_state_code_
 * registration_type_key at 66 characters. Hard-coding the untruncated name
 * would have produced a mapping that never matched, which is precisely why
 * this is asserted against the live catalogue rather than derived from the
 * column list in 0005.
 */
describe("friendlyRegistrationError maps the real gst_registrations constraints", () => {
  it("explains a failed GSTIN check digit", () => {
    const msg = friendlyRegistrationError({
      message:
        'new row for relation "gst_registrations" violates check constraint "gst_registrations_gstin_check"',
    });
    expect(msg).toContain("check digit");
    expect(msg).not.toContain("gst_registrations_gstin_check");
  });

  it("names the GSTIN when it is already registered", () => {
    const msg = friendlyRegistrationError(
      {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "gst_registrations_gstin_key"',
      },
      "27ABCCN3456P1ZW"
    );
    expect(msg).toContain("27ABCCN3456P1ZW");
    expect(msg).toContain("already registered");
  });

  it("still works when no GSTIN is passed alongside the duplicate", () => {
    const msg = friendlyRegistrationError({
      code: "23505",
      message: 'duplicate key value violates unique constraint "gst_registrations_gstin_key"',
    });
    expect(msg).toContain("already registered");
    expect(msg).not.toContain("undefined");
  });

  it("explains one-registration-per-type-per-state, using the truncated constraint name", () => {
    const msg = friendlyRegistrationError({
      code: "23505",
      message:
        'duplicate key value violates unique constraint "gst_registrations_company_id_state_code_registration_type_key"',
    });
    expect(msg).toContain("one per state per type");
    // The generic 23505 fallback must not win over the specific mapping.
    expect(msg).not.toBe("That registration already exists.");
  });

  it("explains the period constraint in plain English", () => {
    const msg = friendlyRegistrationError({
      message:
        'new row for relation "gst_registrations" violates check constraint "gst_registrations_period_valid"',
    });
    expect(msg).toContain("surrender date");
    expect(msg).not.toContain("gst_registrations_period_valid");
  });

  it("explains a branch in the wrong state", () => {
    const msg = friendlyRegistrationError({
      message:
        'insert or update on table "branches" violates foreign key constraint "branches_gst_registration_id_fkey"',
    });
    expect(msg).toContain("state");
    expect(msg).not.toContain("_fkey");
  });

  it("passes update_gst_registration's own plain-English exceptions straight through", () => {
    // 1390 raises these itself, already readable — re-wording them here would
    // lose the voucher number and the dates they name.
    const raised =
      "GSTIN 27ABCCN3456P1ZW was still being used to post vouchers after 31 Aug 2026 — HO/REC/2026-27/00002 is dated 01 Sep 2026.";
    expect(friendlyRegistrationError({ message: raised })).toBe(raised);

    const adminOnly = "Only a company admin can edit a GST registration";
    expect(friendlyRegistrationError({ message: adminOnly })).toBe(adminOnly);
  });

  it("falls back to the raw message rather than swallowing an unknown error", () => {
    const msg = friendlyRegistrationError({ message: "connection terminated unexpectedly" });
    expect(msg).toBe("connection terminated unexpectedly");
  });

  it("has something to say even with no message at all", () => {
    expect(friendlyRegistrationError({})).toBe("The registration could not be saved.");
  });
});
