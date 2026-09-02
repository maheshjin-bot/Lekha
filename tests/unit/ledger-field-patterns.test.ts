import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PATTERN,
  EMAIL_PATTERN,
  GSTIN_PATTERN,
  GST_TYPES_FORBIDDING_GSTIN,
  GST_TYPES_NEEDING_GSTIN,
  IFSC_PATTERN,
  PAN_PATTERN,
  PINCODE_PATTERN,
  UDYAM_PATTERN,
  blankOrMatches,
  forbidsGstin,
  needsGstin,
  panFromGstin,
  stateFromGstin,
} from "@/lib/ledgers/fieldPatterns";

/**
 * These patterns exist to say a ledgers CHECK constraint in the preparer's own
 * words BEFORE the round trip. The value of that is entirely in their agreeing
 * with the constraint they mirror — a pattern stricter than the database
 * rejects a value Postgres would have taken, and a looser one lets a raw
 * constraint name reach the screen, which is the bug commit 7080e88 fixed.
 *
 * Each expectation below is written against the live constraint definition it
 * mirrors, copied from `pg_constraint` on the LEKHA database (project
 * msgzicwfdoxaswgmevyg) rather than from the migration files, since 0006's
 * ledgers table has been extended repeatedly since.
 */
describe("ledger field patterns mirror the ledgers CHECK constraints", () => {
  it("PAN_PATTERN matches app_private.is_valid_pan", () => {
    // select '^[A-Z]{5}[0-9]{4}[A-Z]$'
    expect(PAN_PATTERN.test("AAJFA1234K")).toBe(true);
    expect(PAN_PATTERN.test("ABCCB7890L")).toBe(true);
    expect(PAN_PATTERN.test("AAJFA1234")).toBe(false); // too short
    expect(PAN_PATTERN.test("aajfa1234k")).toBe(false); // lower case
    expect(PAN_PATTERN.test("AAJF1A234K")).toBe(false); // digit in the letters
  });

  it("GSTIN_PATTERN is the shape half of app_private.is_valid_gstin, and no more", () => {
    // 07AAJFA1234K1ZM is a genuinely well-formed Delhi GSTIN: its check digit
    // was computed by app_private.gstin_check_digit('07AAJFA1234K1Z').
    expect(GSTIN_PATTERN.test("07AAJFA1234K1ZM")).toBe(true);
    expect(GSTIN_PATTERN.test("24ABCCB7890L1Z8")).toBe(true);

    // The 14th character is a literal Z in the constraint's regex.
    expect(GSTIN_PATTERN.test("07AAJFA1234K1YM")).toBe(false);
    // The 13th is an entity code, 1-9 or A-Z — never 0.
    expect(GSTIN_PATTERN.test("07AAJFA1234K0ZM")).toBe(false);
    expect(GSTIN_PATTERN.test("07AAJFA1234K1Z")).toBe(false); // 14 characters

    // Deliberately NOT the check digit: the arithmetic stays in Postgres, so a
    // wrong last character must still pass the shape test here and be caught
    // by ledgers_gstin_check on the round trip. A pattern that "helpfully"
    // reimplemented it would drift and start rejecting valid numbers.
    expect(GSTIN_PATTERN.test("07AAJFA1234K1ZZ")).toBe(true);
  });

  it("UDYAM_PATTERN matches app_private.is_valid_udyam", () => {
    expect(UDYAM_PATTERN.test("UDYAM-GJ-22-0090672")).toBe(true);
    expect(UDYAM_PATTERN.test("UDYAM-GJ-22-009067")).toBe(false); // 6 digits
    expect(UDYAM_PATTERN.test("UDYAM-GJ-2-00906721")).toBe(false);
    expect(UDYAM_PATTERN.test("udyam-gj-22-0090672")).toBe(false);
  });

  it("PINCODE_PATTERN matches ledgers_pincode_check", () => {
    // '^[1-9][0-9]{5}$' — six digits, and a leading zero is refused.
    expect(PINCODE_PATTERN.test("400001")).toBe(true);
    expect(PINCODE_PATTERN.test("110001")).toBe(true);
    expect(PINCODE_PATTERN.test("040001")).toBe(false);
    expect(PINCODE_PATTERN.test("40001")).toBe(false);
    expect(PINCODE_PATTERN.test("4000011")).toBe(false);
  });

  it("EMAIL_PATTERN matches ledgers_email_check", () => {
    expect(EMAIL_PATTERN.test("books@ashokatraders.co.in")).toBe(true);
    expect(EMAIL_PATTERN.test("books@ashokatraders")).toBe(false);
    expect(EMAIL_PATTERN.test("ashokatraders.co.in")).toBe(false);
  });

  it("IFSC_PATTERN matches app_private.is_valid_ifsc", () => {
    // '^[A-Z]{4}0[A-Z0-9]{6}$' — the fifth character is always a literal 0.
    expect(IFSC_PATTERN.test("HDFC0003127")).toBe(true);
    expect(IFSC_PATTERN.test("SBIN0001234")).toBe(true);
    expect(IFSC_PATTERN.test("HDFC1003127")).toBe(false);
    expect(IFSC_PATTERN.test("HDFC000312")).toBe(false);
  });

  it("ACCOUNT_PATTERN matches ledgers_bank_account_number_check", () => {
    // '^[A-Za-z0-9]{5,34}$' — letters allowed, no spaces or dashes.
    expect(ACCOUNT_PATTERN.test("50100234567890")).toBe(true);
    expect(ACCOUNT_PATTERN.test("ABCD1")).toBe(true);
    expect(ACCOUNT_PATTERN.test("1234")).toBe(false);
    expect(ACCOUNT_PATTERN.test("5010 0234 5678")).toBe(false);
    expect(ACCOUNT_PATTERN.test("a".repeat(35))).toBe(false);
  });
});

describe("GST registration type predicates mirror 0735's two constraints", () => {
  it("needsGstin covers exactly ledgers_registered_has_gstin's list", () => {
    expect([...GST_TYPES_NEEDING_GSTIN]).toEqual([
      "regular",
      "composition",
      "sez",
      "sez_developer",
      "uin",
      "deemed_export",
    ]);
    for (const t of GST_TYPES_NEEDING_GSTIN) expect(needsGstin(t)).toBe(true);
  });

  it("forbidsGstin covers exactly ledgers_unregistered_has_no_gstin's list", () => {
    expect([...GST_TYPES_FORBIDDING_GSTIN]).toEqual(["unregistered", "overseas"]);
    for (const t of GST_TYPES_FORBIDDING_GSTIN) expect(forbidsGstin(t)).toBe(true);
  });

  it("the two lists are disjoint, and neither claims the empty 'not set' value", () => {
    for (const t of GST_TYPES_NEEDING_GSTIN) expect(forbidsGstin(t)).toBe(false);
    for (const t of GST_TYPES_FORBIDDING_GSTIN) expect(needsGstin(t)).toBe(false);
    // "" is how both forms spell "Regular / not set", stored as null and left
    // permissive — enforce_ledger_gst_identity (0006) fills in 'regular'
    // itself once a GSTIN is present.
    expect(needsGstin("")).toBe(false);
    expect(forbidsGstin("")).toBe(false);
  });
});

describe("deriving state and PAN from a GSTIN", () => {
  it("takes the state code and PAN out of a complete GSTIN", () => {
    expect(stateFromGstin("07AAJFA1234K1ZM")).toBe("07");
    expect(panFromGstin("07AAJFA1234K1ZM")).toBe("AAJFA1234K");
    // The derived PAN must itself be a valid PAN — that is what keeps
    // ledgers_gstin_matches_pan satisfiable.
    expect(PAN_PATTERN.test(panFromGstin("07AAJFA1234K1ZM"))).toBe(true);
  });

  it("derives nothing from a half-typed GSTIN", () => {
    // Guards a real hazard: slicing unconditionally would stamp a
    // two-character state over a good one on every keystroke, and would write
    // state_code from a number that ledgers_gstin_check is about to refuse.
    expect(stateFromGstin("07AAJ")).toBe("");
    expect(panFromGstin("07AAJ")).toBe("");
    expect(stateFromGstin("")).toBe("");
  });
});

describe("blankOrMatches", () => {
  it("does not nag about a field nobody has filled in yet", () => {
    expect(blankOrMatches(PINCODE_PATTERN, "")).toBe(true);
    expect(blankOrMatches(PINCODE_PATTERN, "   ")).toBe(true);
  });

  it("ignores surrounding whitespace, as every caller trims before writing", () => {
    expect(blankOrMatches(PINCODE_PATTERN, " 400001 ")).toBe(true);
    expect(blankOrMatches(PAN_PATTERN, " AAJFA1234K ")).toBe(true);
  });

  it("still refuses a genuinely bad value", () => {
    expect(blankOrMatches(PINCODE_PATTERN, "040001")).toBe(false);
    expect(blankOrMatches(IFSC_PATTERN, "HDFC1003127")).toBe(false);
  });
});
