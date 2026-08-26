/**
 * ITR-3/5/6 JSON prep builder — shared types.
 *
 * See lib/itr/build-itr-json.ts for the full design note (what this is, what
 * it deliberately is not, and the sources behind every mapping decision).
 */

export type SupportedItrForm = "ITR-3" | "ITR-5" | "ITR-6";

/** Every `ref_entity_types.itr_form` value this app knows about. Only three
 * of them are in scope here — 'ITR-7' (trust) is not, see build-itr-json.ts. */
export type AnyItrForm = SupportedItrForm | "ITR-7";

export function isSupportedItrForm(form: string | null | undefined): form is SupportedItrForm {
  return form === "ITR-3" || form === "ITR-5" || form === "ITR-6";
}

/** One row of the "what did we put where" manifest shown in the UI and used
 * for hand-verification — every leaf this builder actually overlaid with a
 * real, traceable LEKHA figure (as opposed to a zero/blank structural
 * placeholder the generic skeleton-filler produced). */
export interface PopulatedField {
  /** Dot-path into the generated JSON, e.g. "ITR3.PARTA_BS.FundApply.TotFundApply" */
  path: string;
  /** Plain-English label for the UI table. */
  label: string;
  /** The value actually written (already the final JSON-ready value). */
  value: unknown;
  /** Which LEKHA source it came from, e.g. "get_balance_sheet" or "get_income_tax_computation". */
  source: string;
}

/** One row of the "explicitly out of scope" list — a schedule or section
 * this builder does not attempt at all, and why. Shown in the UI verbatim. */
export interface DeferredSchedule {
  schedule: string;
  reason: string;
}

/** Optional, user-typed-in-browser details this app has no source data for
 * at all (auditor particulars, the verifying signatory, contact details).
 * Never persisted — merged into the JSON client-side just before download.
 * See components/itr/ItrDownloadPanel.tsx. */
export interface ItrManualOverrides {
  assesseeMobile?: string;
  assesseeEmail?: string;
  auditorName?: string;
  auditorPan?: string;
  auditorMembershipOrFirmRegNo?: string;
  auditReportDate?: string; // YYYY-MM-DD
  // UDIN is not captured as its own field anywhere in AuditInfo (checked
  // live against the vendored schema) — it is filed with Form 3CA/3CB
  // itself, a separate document from the ITR JSON, so there is no path
  // here to write one into even if the user supplied it.
  verifierName?: string;
  verifierFatherName?: string;
  verifierPan?: string;
  place?: string;
}

export interface ItrBuildResult {
  /** The generated document, shaped exactly as the real government schema's
   * own root: `{ "ITR": { "ITR3": {...} } }` (or ITR5/ITR6) — confirmed live
   * against the AY 2026-27 schema files, see build-itr-json.ts. */
  json: Record<string, unknown>;
  populated: PopulatedField[];
  deferred: DeferredSchedule[];
  /** Non-fatal notices surfaced in the UI (e.g. "tax computation not modelled
   * for this entity type"). Distinct from `deferred` — these are about DATA
   * QUALITY of a section that IS included, not about a section left out. */
  warnings: string[];
  /** Result of walking the real vendored schema and confirming every
   * required path the skeleton builder created is present in the final
   * object — this build's own structural self-check, not a full JSON-Schema
   * validation (enum/pattern conformance on real-data leaves is not
   * re-checked here). See lib/itr/schema-utils.ts#collectRequiredPaths. */
  structuralCheck: { requiredPathCount: number; missing: string[] };
}
