import { describe, expect, it } from "vitest";
import {
  CIN_PATTERN,
  IEC_PATTERN,
  PAN_PATTERN,
  TAN_PATTERN,
  UDYAM_PATTERN,
  panHolderTypeWarning,
} from "@/lib/companies/fieldPatterns";
import { friendlyCompanyError } from "@/lib/companies/friendlyError";
import type { PostgrestError } from "@supabase/supabase-js";

/**
 * These patterns exist to say a public.companies CHECK constraint in the
 * preparer's own words BEFORE the round trip. Their whole value is in agreeing
 * with the constraint they mirror — a pattern stricter than the database
 * rejects a value Postgres would have taken, and a looser one lets a raw
 * constraint name reach the screen (commit 7080e88's bug, on a different
 * form).
 *
 * Every expectation below is written against the live constraint definition,
 * read from pg_constraint on the LEKHA database (project msgzicwfdoxaswgmevyg)
 * after 1360 was applied, not from the migration text.
 */
describe("company identifier patterns mirror the companies CHECK constraints", () => {
  it("PAN_PATTERN matches app_private.is_valid_pan, via companies_pan_check", () => {
    // '^[A-Z]{5}[0-9]{4}[A-Z]$'
    expect(PAN_PATTERN.test("ABCCB7890L")).toBe(true); // Bharat Industries, live
    expect(PAN_PATTERN.test("ABCCN3456P")).toBe(true); // Nexgen Softwares, live
    expect(PAN_PATTERN.test("ABCCB7890")).toBe(false); // too short
    expect(PAN_PATTERN.test("ABCC1B7890L")).toBe(false); // digit in the letters
    expect(PAN_PATTERN.test("abccb7890l")).toBe(false); // lower case
  });

  it("TAN_PATTERN matches app_private.is_valid_tan, via companies_tan_check", () => {
    // '^[A-Z]{4}[0-9]{5}[A-Z]$' — four letters, not five. That one-character
    // difference from a PAN is the whole reason both patterns exist.
    expect(TAN_PATTERN.test("AHMB67890F")).toBe(true); // Bharat Industries, live
    expect(TAN_PATTERN.test("MUMN56789E")).toBe(true); // Nexgen Softwares, live
    expect(TAN_PATTERN.test("AHMB6789F")).toBe(false); // too short
    expect(PAN_PATTERN.test("AHMB67890F")).toBe(false); // and not a PAN
  });

  it("IEC_PATTERN matches app_private.is_valid_iec — the PAN shape, because an IEC *is* the PAN", () => {
    // '^[A-Z]{5}[0-9]{4}[A-Z]$' — identical to the PAN validator by design,
    // since DGFT harmonised IEC with PAN in 2017. Kept as its own named export
    // so a future divergence has somewhere to land.
    expect(IEC_PATTERN.test("ABCCB7890L")).toBe(true);
    expect(IEC_PATTERN.source).toBe(PAN_PATTERN.source);
    // Legacy pre-2017 IECs were 10 digits. The database has always refused
    // them and this pattern must agree, or the form would accept a value the
    // constraint then rejects.
    expect(IEC_PATTERN.test("0388012345")).toBe(false);
  });

  it("CIN_PATTERN matches app_private.is_valid_cin, via companies_cin_check (1360)", () => {
    // '^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$'
    // Both live values, confirmed against the database's own validator:
    expect(CIN_PATTERN.test("L74999MH2010PLC205678")).toBe(true);
    expect(CIN_PATTERN.test("U72900MH2019PTC330045")).toBe(true);
    // An OPC's class code is OPC — not enumerated in the pattern, so any three
    // letters pass. That is deliberate: MCA extends the class list, and a
    // stale allowlist here would reject a real CIN.
    expect(CIN_PATTERN.test("U72900MH2019OPC330045")).toBe(true);
    expect(CIN_PATTERN.test("U74999DL2015NPL123456")).toBe(true);

    expect(CIN_PATTERN.test("U72900MH2019PTC33004")).toBe(false); // 20 characters
    expect(CIN_PATTERN.test("U72900MH2019PTC3300456")).toBe(false); // 22
    expect(CIN_PATTERN.test("X72900MH2019PTC330045")).toBe(false); // not L or U
    expect(CIN_PATTERN.test("U7290AMH2019PTC330045")).toBe(false); // letter in the NIC code
    expect(CIN_PATTERN.test("U729001H2019PTC330045")).toBe(false); // digit in the state
    expect(CIN_PATTERN.test("u72900mh2019ptc330045")).toBe(false); // lower case
    // An LLPIN is not a CIN, and must not be launderable into the column.
    expect(CIN_PATTERN.test("AAB-1234")).toBe(false);
  });

  it("UDYAM_PATTERN matches app_private.is_valid_udyam, via companies_udyam_number_check", () => {
    expect(UDYAM_PATTERN.test("UDYAM-MH-26-0001234")).toBe(true);
    expect(UDYAM_PATTERN.test("UDYAM-MH-26-1234")).toBe(false);
  });
});

/**
 * The holder-type check app_private.is_valid_pan's own migration comment
 * (0001) hands to the application layer: "Type consistency against the
 * company's entity_type is checked at the application layer, not here — a
 * mismatch is a warning worth surfacing, not a reason to reject the row."
 */
describe("panHolderTypeWarning", () => {
  it("says nothing when the 4th character fits the entity type", () => {
    expect(panHolderTypeWarning("pvt_ltd", "ABCCN3456P")).toBeNull(); // C, a company
    expect(panHolderTypeWarning("ltd", "ABCCB7890L")).toBeNull();
    expect(panHolderTypeWarning("opc", "ABCCR6789O")).toBeNull();
    expect(panHolderTypeWarning("huf", "ABCHA4567F")).toBeNull(); // H
    expect(panHolderTypeWarning("partnership", "ABCFV5678E")).toBeNull(); // F
    expect(panHolderTypeWarning("llp", "ABCFK2345L")).toBeNull(); // F
    expect(panHolderTypeWarning("proprietorship", "ABCPS1234D")).toBeNull(); // P
    expect(panHolderTypeWarning("trust", "ABCTS5678C")).toBeNull(); // T
  });

  it("flags a real mismatch, in words, and never as a refusal", () => {
    // A proprietorship's individual PAN typed against a company.
    const warning = panHolderTypeWarning("pvt_ltd", "ABCPS1234D");
    expect(warning).toBeTruthy();
    expect(warning).toContain("P");
    expect(warning).toContain("an individual");
    expect(warning).toContain("a company's PAN (4th character C)");
    // The wording has to make clear the save still happens — the database does
    // not enforce this, and neither does the form.
    expect(warning).toContain("will still save it");
  });

  it("holds no opinion on societies and AOP/BOIs, which are genuinely varied", () => {
    // Allotted A, B, T or even L depending on how they were registered. Live
    // data has both on 'A'. An expectation tight enough to be useful would
    // fire on somebody's correct card, so there is deliberately no entry.
    expect(panHolderTypeWarning("society", "ABCAK9012S")).toBeNull();
    expect(panHolderTypeWarning("aop_boi", "ABCAR8901W")).toBeNull();
    expect(panHolderTypeWarning("society", "ABCPK9012S")).toBeNull();
    // And nothing at all for an entity type it has never heard of.
    expect(panHolderTypeWarning("cooperative", "ABCPS1234D")).toBeNull();
  });

  it("stays quiet while the box is still being typed into", () => {
    expect(panHolderTypeWarning("pvt_ltd", "")).toBeNull();
    expect(panHolderTypeWarning("pvt_ltd", "ABCP")).toBeNull();
    expect(panHolderTypeWarning("pvt_ltd", "ABCPS1234")).toBeNull();
  });
});

const pgError = (message: string): PostgrestError =>
  ({ message, details: "", hint: "", code: "23514", name: "PostgrestError" }) as PostgrestError;

describe("friendlyCompanyError", () => {
  it("turns each companies constraint name into something a preparer can act on", () => {
    const cases: Array<[string, string]> = [
      ["companies_pan_check", "AAAAA9999A"],
      ["companies_tan_check", "AAAA99999A"],
      ["companies_iec_check", "DGFT"],
      ["companies_cin_check", "21 characters"],
      ["companies_udyam_number_check", "UDYAM-XX-00-0000000"],
      ["companies_upi_vpa_check", "okhdfcbank"],
      ["companies_compliance_requires_pan", "books-only"],
    ];
    for (const [constraint, expected] of cases) {
      const out = friendlyCompanyError(
        pgError(`new row for relation "companies" violates check constraint "${constraint}"`)
      );
      expect(out, `${constraint} was not translated`).not.toContain(constraint);
      expect(out, `${constraint} lost the detail that makes it actionable`).toContain(expected);
    }
  });

  it("passes the PAN/GSTIN guard trigger's own message through untouched", () => {
    // app_private.enforce_company_pan_matches_registrations (1360) raises a
    // plain-English sentence that already names the offending GSTIN. Rewriting
    // or swallowing it would lose the one detail the user needs.
    // Copied verbatim from what the live database actually raised when the
    // guard was exercised against Sharma Textiles (07ABCPS1234D1Z3).
    const raised =
      "GST registration 07ABCPS1234D1Z3 is already on file for this company, and a GSTIN " +
      "carries its holder's PAN inside it. Changing the company PAN to ABCCN3456P would leave " +
      "the two contradicting each other — correct or remove that registration first.";
    expect(friendlyCompanyError(pgError(raised))).toBe(raised);
  });

  it("never swallows an unrecognised error into a generic apology", () => {
    expect(friendlyCompanyError(pgError("could not serialize access due to concurrent update"))).toBe(
      "could not serialize access due to concurrent update"
    );
  });
});
