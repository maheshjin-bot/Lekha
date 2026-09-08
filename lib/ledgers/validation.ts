/**
 * Shared client-side mirrors of the ledgers table's own CHECK constraints
 * and value sets — extracted so LedgerManager.tsx's "New ledger" form and
 * LedgerEditForm.tsx's edit form (1900) read from exactly one copy of each
 * pattern/label map, rather than risking the same drift
 * lib/ledgers/friendlyError.ts's own header describes.
 *
 * Every pattern here is a client-side CONVENIENCE ONLY — the database's own
 * `app_private.is_valid_*` functions and CHECK constraints are the real,
 * authoritative validation. A drifting client copy would reject numbers the
 * database accepts, or vice versa — see friendlyError.ts for what happens
 * when the client is wrong and the server has to say so instead.
 */

// Mirrors app_private.is_valid_udyam exactly.
export const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
// Mirrors app_private.is_valid_pan exactly.
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// Mirrors app_private.is_valid_tan exactly (0148) — 4 letters, 5 digits, 1
// letter, a fixed real TAN format, distinct from PAN's shape above.
export const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

// The shape half of app_private.is_valid_gstin. The check digit stays the
// database's job — a drifting second copy would reject numbers it accepts.
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * A GSTIN's first two characters ARE the state code (and 3-12 are the PAN).
 */
export const stateFromGstin = (g: string) => (GSTIN_PATTERN.test(g) ? g.slice(0, 2) : "");

// ledgers_pincode_check / ledgers_email_check.
export const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;
export const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Registration types that mean "this party holds a GSTIN", mirroring
// ledgers_registered_has_gstin (0735).
export const GST_TYPES_NEEDING_GSTIN = [
  "regular",
  "composition",
  "sez",
  "sez_developer",
  "uin",
  "deemed_export",
];

// Short labels for the sec43b_category check-constraint values.
export const SEC43B_LABEL: Record<string, string> = {
  statutory_dues: "Tax/duty/cess/fee",
  employee_welfare_fund: "PF/gratuity fund",
  bonus_commission: "Bonus/commission",
  specified_interest: "Bank/PFI interest",
  leave_encashment: "Leave encashment",
};

// Mirrors ledgers_gst_registration_type_check exactly (0006, extended in
// meaning but not in values by 0087). 'regular' is left out of the dropdown
// on purpose — a GSTIN attached to the ledger already sets it automatically
// (enforce_ledger_gst_identity, 0006).
export const GST_REG_TYPE_LABEL: Record<string, string> = {
  regular: "Regular",
  composition: "Composition",
  unregistered: "Unregistered",
  sez: "SEZ unit",
  sez_developer: "SEZ developer",
  overseas: "Overseas (export)",
  uin: "UIN holder",
  deemed_export: "Deemed export (Sec 147)",
};
export const GST_REG_TYPE_OPTIONS = [
  "composition",
  "unregistered",
  "sez",
  "sez_developer",
  "overseas",
  "uin",
  "deemed_export",
];

// Mirrors ledgers_relationship_type_check exactly (0105). AS 18 / Ind AS 24's
// own relationship categories.
export const RELATIONSHIP_TYPE_LABEL: Record<string, string> = {
  holding_company: "Holding company",
  subsidiary_or_fellow_subsidiary: "Subsidiary / fellow subsidiary",
  associate_or_joint_venture: "Associate / joint venture",
  individual_with_control_or_significant_influence: "Individual with control / significant influence",
  relative_of_such_individual: "Relative of such individual",
  key_management_personnel: "Key management personnel",
  relative_of_kmp: "Relative of KMP",
  enterprise_influenced_by_kmp_or_relative: "Enterprise influenced by KMP or relative",
  other: "Other related party",
};

// Mirrors ledgers_party_type_check exactly (0006).
export const PARTY_TYPE_LABEL: Record<string, string> = {
  customer: "Customer",
  supplier: "Supplier",
  both: "Both",
  employee: "Employee",
  bank: "Bank",
  government: "Government",
  related_party: "Related party",
  other: "Other",
  job_worker: "Job worker",
};

/**
 * The 8 system-managed ledgers update_ledger (1900, ex-1330/1332) refuses to
 * rename — found by exact name every time the feature behind it posts,
 * rather than by id. Kept here too so LedgerEditForm can disable the Name
 * field and explain why BEFORE a round trip to the server, matching the
 * RPC's own guard rather than just reacting to its error.
 */
export const NAME_LOCKED_LEDGERS = [
  "Opening Balance Equity",
  "Exchange Gain/Loss",
  "Job Work Movement",
  "Manufacturing Clearing",
  "Delivery Challan Movement",
  "Stock Verification Adjustment",
  "Deferred Tax Expense",
  "Deferred Tax Liabilities (Net)",
];
