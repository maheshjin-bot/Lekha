/**
 * The per-voucher-type numbering policy, as the two entry forms need it.
 *
 * Migration 0725 made voucher numbering configurable per company and per
 * voucher type — automatic (the app numbers it, exactly as it always did),
 * manual (the preparer types the number) or series (several named series with
 * independent counters, which CGST Rule 46(b) expressly permits). The settings
 * screen sets that policy; this module is what the entry forms read it through.
 *
 * Everything here is deliberately free of Supabase, React and Next imports so
 * that the same file can be shaped by a server component and validated inside a
 * "use client" form without dragging either side's runtime into the other.
 *
 * WHAT IS DELIBERATELY NOT HERE: any re-implementation of
 * app_private.resolve_number_prefix, Postgres lpad or app_private.fy_label.
 * components/settings/NumberingSettings.tsx already carries one hand-written
 * twin of those, and it needs it — it previews a prefix the user is still
 * typing, which no round trip can keep up with. The entry forms have no such
 * need: they only ever display a preview the database itself computed and
 * returned, so a second twin here would be pure drift risk for no gain.
 */

/** One row of public.get_voucher_numbering_settings (migration 0725). */
export type NumberingSettingsRow = {
  voucher_type: string;
  type_label: string;
  allows_manual: boolean;
  mode: string;
  branch_id: string;
  branch_code: string;
  financial_year_label: string;
  series_id: string | null;
  series_name: string;
  prefix: string;
  padding: number;
  is_default: boolean;
  is_active: boolean;
  next_number: number;
  preview_number: string;
  preview_length: number;
  rule46b_ok: boolean;
  /**
   * Migration 1160. False when the company has more than one branch and this
   * series' prefix carries no {BRANCH} token, so the series would issue the
   * same number in each of them. The entry forms do not act on this — a
   * series in that state still numbers correctly in the one branch that has
   * been using it, and next_voucher_number refuses the draw with its own
   * written message anywhere else — but the type describes the RPC's real
   * shape, and the settings screen renders both fields.
   */
  branch_scope_ok: boolean;
  branch_scope_note: string | null;
};

export type NumberingMode = "automatic" | "manual" | "series";

export type NumberingSeriesOption = {
  /**
   * Null for a voucher type that has never been raised: the read RPC returns
   * the Default series next_voucher_number WOULD provision on first use, with
   * a null id to mark it as not-yet-real. Sending no p_number_series_id in
   * that case is correct — the engine provisions exactly that row itself.
   */
  id: string | null;
  name: string;
  isDefault: boolean;
  /** The exact number the database would issue next, computed by the database. */
  previewNumber: string;
  previewLength: number;
  rule46bOk: boolean;
};

export type TypeNumbering = {
  mode: NumberingMode;
  allowsManual: boolean;
  /** The branch the previews below were resolved for — {BRANCH} is in most prefixes. */
  branchCode: string;
  /** The financial year the previews below belong to. */
  financialYearLabel: string;
  /** Active series only, default first. Empty unless mode is "series". */
  series: NumberingSeriesOption[];
};

/** voucher_type -> its policy. */
export type VoucherNumbering = Record<string, TypeNumbering>;

/** branch id -> that branch's view of the policy. See buildNumberingByBranch. */
export type VoucherNumberingByBranch = Record<string, VoucherNumbering>;

/**
 * CGST Rule 46(b): a document number is at most sixteen characters, drawn from
 * letters, digits, hyphen and slash. Mirrors app_private.is_rule46b_number and
 * app_private.assert_rule46b_number (0725) exactly — the database is still the
 * one that decides, this only buys the preparer a sentence they can act on
 * instead of a round trip that fails.
 */
export const RULE46B_MAX_LENGTH = 16;
export const RULE46B_CHARACTERS = /^[A-Za-z0-9/-]+$/;

/**
 * Collapses the read RPC's one-row-per-series shape into one entry per voucher
 * type. Retired series are dropped: next_voucher_number refuses an inactive
 * series outright, so offering one would be offering a guaranteed failure.
 *
 * Row order is preserved as the RPC returned it (default first, then by name),
 * so the picker's first option is the one that would be used anyway.
 */
export function buildNumbering(rows: NumberingSettingsRow[]): VoucherNumbering {
  const out: VoucherNumbering = {};
  for (const r of rows) {
    const mode: NumberingMode =
      r.mode === "manual" || r.mode === "series" ? r.mode : "automatic";
    const entry = (out[r.voucher_type] ??= {
      mode,
      allowsManual: r.allows_manual,
      branchCode: r.branch_code,
      financialYearLabel: r.financial_year_label,
      series: [],
    });
    if (!r.is_active) continue;
    entry.series.push({
      id: r.series_id,
      name: r.series_name,
      isDefault: r.is_default,
      previewNumber: r.preview_number,
      previewLength: r.preview_length,
      rule46bOk: r.rule46b_ok,
    });
  }
  return out;
}

/**
 * The same, keyed by branch.
 *
 * The mode and the series list are company-and-type scoped, so they are
 * identical across branches; the PREVIEW is not, because {BRANCH} is the
 * commonest token in a prefix and every branch keeps its own counter. Rather
 * than show a preview for one branch while the form is set to another, each
 * page asks the RPC once per branch and the form indexes by whichever branch
 * is selected.
 */
export function buildNumberingByBranch(
  perBranch: readonly (readonly [branchId: string, rows: NumberingSettingsRow[]])[]
): VoucherNumberingByBranch {
  const out: VoucherNumberingByBranch = {};
  for (const [branchId, rows] of perBranch) out[branchId] = buildNumbering(rows);
  return out;
}

/**
 * Validates a hand-typed number the way app_private.assert_rule46b_number
 * does, and returns the sentence to show, or null when it is fine.
 *
 * Trimmed first, exactly as the SQL does (btrim), so "  A/1 " and "A/1" are
 * the same number here and there.
 */
export function validateManualNumber(raw: string): string | null {
  const v = raw.trim();
  if (!v) {
    return "Type the voucher number — this voucher type is set to manual numbering.";
  }
  if (v.length > RULE46B_MAX_LENGTH) {
    return `“${v}” is ${v.length} characters. CGST Rule 46(b) allows at most ${RULE46B_MAX_LENGTH}.`;
  }
  if (!RULE46B_CHARACTERS.test(v)) {
    return "Use only letters, digits, hyphen (-) and slash (/). CGST Rule 46(b) allows nothing else in a document number.";
  }
  return null;
}

/**
 * Turns the one numbering failure that can still reach the client as a raw
 * Postgres error into a sentence.
 *
 * app_private.resolve_manual_voucher_number already checks for a duplicate and
 * refuses it in plain English, so this only fires in the narrow race where two
 * people type the same number at the same moment and the UNIQUE constraint on
 * public.vouchers — vouchers_company_id_branch_id_voucher_type_financial_year_l_key,
 * over (company_id, branch_id, voucher_type, financial_year_label,
 * voucher_number) — is the one that catches it. Every other message from the
 * numbering path is already written for a preparer and is passed through
 * untouched rather than second-guessed.
 */
export function friendlyNumberingError(message: string): string {
  if (
    /vouchers_company_id_branch_id_voucher_type_financial_year/i.test(message) ||
    /duplicate key value violates unique constraint/i.test(message)
  ) {
    return "That number is already used for this voucher type at this branch in this financial year. Every number must be unique within the year — pick another.";
  }
  return message;
}
