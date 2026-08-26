/**
 * ITR-3 / ITR-5 / ITR-6 JSON prep builder.
 * ============================================================================
 * WHAT THIS IS. Builds a JSON document shaped exactly like the file the
 * Income Tax Department's own offline utility produces/imports — for a
 * user to download, open in that utility themselves, review, complete the
 * schedules this app has no source data for, and file. This module never
 * submits anything anywhere; there is no e-filing portal integration, ERI
 * licence, DSC, or Aadhaar-OTP/EVC authentication here or anywhere in this
 * app, and there could not be a lawful one without all three.
 *
 * TARGET SCHEMA — CONFIRMED LIVE, NOT ASSUMED. The ITR JSON schema is
 * published PER ASSESSMENT YEAR on incometax.gov.in and genuinely changes
 * shape year to year (see e.g. ITR-6's AY2026-27 schema requiring BOTH a
 * Companies-Act-format and an Ind-AS-format balance sheet, a structural
 * split that did not always exist). This module targets AY 2026-27 (FY
 * 2025-26, 1 Apr 2025 - 31 Mar 2026) specifically:
 *   - lib/itr/gov-schemas/itr3.schema.json  <- ITR-3_2026_Main_V1.1.json
 *     https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-07/ITR-3_2026_Main_V1.1.json
 *   - lib/itr/gov-schemas/itr5.schema.json  <- ITR-5_2026_Main_V1.1.json
 *     https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-08/ITR-5_2026_Main_V1.1.json
 *   - lib/itr/gov-schemas/itr6.schema.json  <- ITR-6_2026_Main_V1.0.json
 *     https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-08/ITR-6_2026_Main_V1.0.json
 * All three downloaded directly (curl) during this task, 26 Aug 2026 — not
 * paraphrased from a blog post. Each is a real JSON-Schema (draft-04)
 * document with `"description": "Schema for ITR-3, AY 2026-27"` etc, and its
 * own `definitions.Form_ITR{n}.properties.AssessmentYear.enum` pinned to
 * `["2026"]` — i.e. these files are STRUCTURALLY INCAPABLE of describing an
 * AY 2027-28 return, because the government has not published that schema
 * yet (by the same cadence, it will not exist until well after FY 2026-27
 * itself ends — ITR-3's AY2026-27 utility, for a year that ended 31 Mar
 * 2026, was released 18 Jun 2026, over two months later). This builder is
 * therefore deliberately restricted to FY 2025-26 — see FIXED_PERIOD below —
 * and will need a fresh schema vendor-drop plus a bumped period the next
 * time this feature is touched, exactly like the FEMA-window pattern in
 * migration 0119.
 *
 * ENTITY-TYPE -> FORM MAPPING. Not guessed: `ref_entity_types.itr_form`
 * (migration 0002) already encodes this per entity type and is exposed
 * through `get_company_profile`. Confirmed live during this task:
 *   proprietorship/huf -> ITR-3; partnership/llp/aop_boi/society -> ITR-5;
 *   opc/pvt_ltd/ltd -> ITR-6; trust -> ITR-7.
 * Only the first three map onto something this module builds. `trust` maps
 * to ITR-7 (registration/exemption-driven schedules — voluntary
 * contributions, application of income, Sec 11-13 particulars — that this
 * schema has no source data for at all, a completely different shape from
 * ITR-3/5/6) and is refused outright by the page, not force-mapped onto the
 * nearest of the three supported forms.
 *
 * HOW EVERY OTHER FIELD IS BUILT. See lib/itr/schema-utils.ts's own header
 * for the generic-skeleton-plus-overlay design and why it beats hand-typing
 * a fixed object shape. In short: `buildMinimalInstance` walks the REAL
 * vendored schema and creates a value for every key the schema itself
 * declares REQUIRED (recursively) — satisfying the file's own structural
 * demands by construction — and this module supplies an `overlay` map of
 * dot-paths to real, sourced LEKHA figures that pre-empt the generic filler
 * wherever a real figure exists. Every overlaid path is recorded in
 * `populated` (shown itemised in the UI and hand-verified in this task's own
 * report); everything else in the required skeleton is a genuine zero/blank
 * structural placeholder, and the schedules this module never even attempts
 * (dozens of them — capital gains, foreign assets, salary/house-property
 * heads, every Chapter VI-A deduction schedule, ESOP, VDA, transfer pricing…)
 * are listed by name in `DEFERRED_SCHEDULES` below, the same
 * named-gap discipline this codebase already uses for GSTR-9 Table
 * 15/18/19 and ITC-04 Table 5B/5C.
 */

import itr3Schema from "./gov-schemas/itr3.schema.json";
import itr5Schema from "./gov-schemas/itr5.schema.json";
import itr6Schema from "./gov-schemas/itr6.schema.json";
import {
  buildMinimalInstance,
  collectMissingRequiredPaths,
  setAtPath,
  type JsonSchemaDefs,
} from "./schema-utils";
import { gstStateCodeToItrStateCode } from "./state-codes";
import type { DeferredSchedule, ItrBuildResult, PopulatedField, SupportedItrForm } from "./types";

/** This builder covers exactly FY 2025-26 (AY 2026-27) — see header. */
export const FIXED_PERIOD = { fyStart: "2025-04-01", fyEnd: "2026-03-31", fyLabel: "2025-26", ay: "2026-27" } as const;

export interface CompanyInfoInput {
  id: string;
  name: string;
  legal_name: string | null;
  entity_type: string;
  pan: string | null;
  cin: string | null;
  incorporation_date: string | null;
  company_tax_regime: string | null;
  statutory_audit_rule: string | null;
}

export interface BalanceSheetRow {
  side: "assets" | "liabilities";
  nature: string;
  group_name: string;
  ledger_name: string;
  ledger_role: string;
  amount: number;
}

export interface ProfitLossRow {
  section: string;
  nature: string;
  group_name: string;
  ledger_name: string;
  ledger_role: string;
  amount: number;
}

export interface TaxComputationRow {
  applicable: boolean;
  note: string | null;
  business_income: number;
  short_term_capital_gain: number;
  short_term_capital_loss: number;
  gross_total_income: number;
  taxable_income: number;
  tax_before_rebate: number;
  rebate_87a: number;
  tax_after_rebate: number;
  surcharge: number;
  cess: number;
  total_tax: number;
  advance_tax_paid: number;
  self_assessment_tax_paid: number;
  tds_tcs_credit: number;
  net_tax_payable: number;
}

export interface TaxAuditRow {
  audit_required: boolean;
  turnover: number;
}

export interface HeadOfficeAddress {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  pincode: string | null;
  state_code: string | null; // ref_states / GST numbering
}

export interface BuildItrJsonInput {
  form: SupportedItrForm;
  company: CompanyInfoInput;
  balanceSheet: BalanceSheetRow[];
  profitLoss: ProfitLossRow[];
  taxComputation: TaxComputationRow | null;
  taxAudit: TaxAuditRow | null;
  headOffice: HeadOfficeAddress | null;
}

const FORM_CONFIG: Record<
  SupportedItrForm,
  {
    schema: JsonSchemaDefs;
    rootDef: "ITR3" | "ITR5" | "ITR6";
    personalKey: "PersonalInfo" | "OrgFirmInfo";
    genInfo2Key: "PartA_GEN2" | "PartA_GEN2For6";
    bsShape: "individual" | "company";
    bsKey: "PARTA_BS" | "PARTA_BSFor6FrmAY13";
    bpKey: "ITR3ScheduleBP" | "CorpScheduleBP";
    dueDateNonAudit: string;
    dueDateAudit: string;
  }
> = {
  "ITR-3": {
    schema: (itr3Schema as { definitions: JsonSchemaDefs }).definitions,
    rootDef: "ITR3",
    personalKey: "PersonalInfo",
    genInfo2Key: "PartA_GEN2",
    bsShape: "individual",
    bsKey: "PARTA_BS",
    bpKey: "ITR3ScheduleBP",
    dueDateNonAudit: "2026-08-31",
    dueDateAudit: "2026-10-31",
  },
  "ITR-5": {
    schema: (itr5Schema as { definitions: JsonSchemaDefs }).definitions,
    rootDef: "ITR5",
    personalKey: "OrgFirmInfo",
    genInfo2Key: "PartA_GEN2",
    bsShape: "individual",
    bsKey: "PARTA_BS",
    bpKey: "CorpScheduleBP",
    dueDateNonAudit: "2026-08-31",
    dueDateAudit: "2026-10-31",
  },
  "ITR-6": {
    schema: (itr6Schema as { definitions: JsonSchemaDefs }).definitions,
    rootDef: "ITR6",
    personalKey: "OrgFirmInfo",
    genInfo2Key: "PartA_GEN2For6",
    bsShape: "company",
    bsKey: "PARTA_BSFor6FrmAY13",
    bpKey: "CorpScheduleBP",
    dueDateNonAudit: "2026-10-31", // companies never get the no-audit date — see ITR-6 schema's own enum
    dueDateAudit: "2026-10-31",
  },
};

/** Everything this builder deliberately never attempts, with why — shown
 * verbatim in the UI. Applies across all three forms; a handful of extra,
 * ITR-6-specific rows are added by buildItrJson itself (Ind-AS). */
const COMMON_DEFERRED: DeferredSchedule[] = [
  {
    schedule: "Capital gains (ScheduleCG / Schedule112A / Schedule115AD)",
    reason:
      "LEKHA has no securities/property register — get_income_tax_computation only nets Sec 50 short-term gain on depreciable business assets (already folded into the Income summary below), never long-term or listed-security gains.",
  },
  {
    schedule: "Salary (ScheduleS) and House Property (ScheduleHP)",
    reason: "LEKHA is a business-accounting ledger, not a payslip or tenancy register — it holds no source data for either head.",
  },
  {
    schedule: "Chapter VI-A deductions (Schedule 80C/80D/80DD/80U/80E/80EE/80EEA/80EEB/80G/80GGA/80GGC/80-IA/80-IB/80-IC/80TTA…)",
    reason:
      "get_income_tax_computation does not model any Chapter VI-A deduction (confirmed live in its own source) — nothing here to source these schedules from.",
  },
  {
    schedule: "Foreign assets / foreign source income (ScheduleFA, ScheduleFSI, ScheduleTR1)",
    reason: "LEKHA tracks foreign-currency vouchers (see /forex) but not the assessee's own foreign asset holdings.",
  },
  {
    schedule: "AMT / MAT (ScheduleAMT, ScheduleAMTC, ScheduleMAT, ScheduleMATC)",
    reason: "Not computed by get_income_tax_computation; AMT/MAT liability depends on Chapter VI-A/10AA claims this app does not model, so it is never triggered here.",
  },
  {
    schedule: "Interest under Sec 234A/234B/234C and late fee under 234F",
    reason: "get_income_tax_computation's own note says explicitly this is not computed. Left at 0 in IntrstPay, not estimated.",
  },
  {
    schedule: "Virtual digital assets (ScheduleVDA), race-horse income, ESOP (ScheduleESOP), transfer pricing (ScheduleTPSA)",
    reason: "No source data anywhere in this app for any of these.",
  },
  {
    schedule: "Manufacturing Account / Trading Account (as separate schedules)",
    reason:
      "Optional in the schema, not required. Their combined effect (gross profit) is carried into PARTA_PL.CreditsToPL.GrossProfitTrnsfFrmTrdAcc instead of being itemised into the schema's own Trading Account line items.",
  },
  {
    schedule: "Every granular expense-category line in PARTA_PL.DebitsToPL (Freight, Power & Fuel, Rent, Insurance, Travel, …)",
    reason:
      "LEKHA's chart of accounts is not mapped to the government's own expense taxonomy. Only the buckets LEKHA's account_groups.ledger_role already carries natively are populated (employee_benefits, finance_costs, depreciation_amortisation, other_expenses, tax_expense — see the ledger_role check constraint on account_groups); everything else in DebitsToPL is left at 0.",
  },
  {
    schedule: "ITR3ScheduleBP / CorpScheduleBP's own ICDS and Sec 36/37/40/40A/43B adjustment fields",
    reason:
      "Only ProfBfrTaxPL (book profit per P&L) is populated. The dozens of intermediate disallowance/addition fields the real schedule wants are left at 0 — they do NOT cross-foot to the Income summary figure below, which instead comes straight from get_income_tax_computation's own (different, simpler) addback logic. Reconciling the schedule's own arithmetic is a manual step in the offline utility, not something this builder attempts.",
  },
  {
    schedule: "ScheduleCYLA / ScheduleBFLA (ITR-3 only) inter-head and brought-forward loss set-off",
    reason:
      "get_income_tax_computation computes only THIS year's numbers and does not track losses brought forward from a prior year (confirmed live in its own source: no prior-year loss table is read). Both schedules are present (required by the schema) with this year's business/capital-gain income only; BroughtFwdLossesSetoff is 0.",
  },
];

const IND_AS_DEFERRED: DeferredSchedule = {
  schedule: "PARTA_BSIndAS / PARTA_PLIndAS (ITR-6 only)",
  reason:
    "LEKHA's statement_format for every company entity type is 'schedule_iii' (plain Companies Act format) — it has no Ind-AS-specific ledger classification (e.g. fair-value-through-P&L splits) to source an Ind-AS balance sheet/P&L from. Left as the generic zero-filled skeleton; leave these blank in the utility unless this company is actually Ind-AS mandated.",
};

function sum(rows: { amount: number }[]): number {
  return rows.reduce((a, r) => a + Number(r.amount || 0), 0);
}
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
const todayIso = () => new Date().toISOString().slice(0, 10);

function looksLikePan(v: string | null | undefined): v is string {
  return !!v && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v);
}

export function buildItrJson(input: BuildItrJsonInput): ItrBuildResult {
  const cfg = FORM_CONFIG[input.form];
  const R = cfg.rootDef;
  const overlay: Record<string, unknown> = {};
  const populated: PopulatedField[] = [];
  const warnings: string[] = [];

  function put(path: string, label: string, value: unknown, source: string) {
    overlay[path] = value;
    populated.push({ path, label, value, source });
  }

  // For genuinely useful data that sits on an OPTIONAL schema key (PinCode,
  // RoadOrStreet — neither is in Address's own `required` list, so
  // buildMinimalInstance's overlay lookup never asks for them and an
  // `overlay[...]` assignment for them would silently do nothing): queued
  // here and setAtPath-patched onto the finished object after the required
  // skeleton is built, near the bottom of this function.
  const postPatch: PopulatedField[] = [];

  // ---- CreationInfo -------------------------------------------------------
  put(`${R}.CreationInfo.SWVersionNo`, "Software version", "1.0", "LEKHA");
  put(
    `${R}.CreationInfo.SWCreatedBy`,
    "Software vendor code",
    "SW00000000",
    "placeholder — the Income Tax Department issues SW-prefixed vendor codes only to registered ERI/software vendors; LEKHA is not registered as one"
  );
  overlay[`${R}.CreationInfo.JSONCreatedBy`] = "SW00000000";
  put(`${R}.CreationInfo.JSONCreationDate`, "JSON created on", todayIso(), "generated now");
  put(`${R}.CreationInfo.Digest`, "Digest", "-", "placeholder — the offline utility recomputes this itself on save");

  // ---- Form_ITR{n} ----------------------------------------------------------
  put(`${R}.Form_${R}.FormName`, "Form", input.form, "ref_entity_types.itr_form (via get_company_profile)");
  overlay[`${R}.Form_${R}.Description`] = `Income Tax Return - ${input.form}`;
  put(`${R}.Form_${R}.AssessmentYear`, "Assessment year", "2026", `AY ${FIXED_PERIOD.ay} — fixed, see module header`);
  overlay[`${R}.Form_${R}.SchemaVer`] = "Ver1.0";
  overlay[`${R}.Form_${R}.FormVer`] = "Ver1.0";

  // ---- PartA_GEN1 -----------------------------------------------------------
  const isIndividualForm = input.form === "ITR-3";
  const legalOrTradeName = input.company.legal_name?.trim() || input.company.name;
  const nameLabel = `${R}.PartA_GEN1.${cfg.personalKey}.AssesseeName.SurNameOrOrgName`;
  if (isIndividualForm) {
    put(
      nameLabel,
      "Assessee name (placeholder)",
      legalOrTradeName,
      "companies.name/legal_name — NOT a real source: LEKHA has no field anywhere for the proprietor's/karta's own personal legal name, only the business/trade name"
    );
    warnings.push(
      `ITR-3's assessee name must be the individual's own PAN-registered name, not a business name. LEKHA only stores the business/trade name ("${legalOrTradeName}") — it is used here as a structural placeholder only. Replace it with the actual proprietor's/karta's name before filing.`
    );
  } else {
    put(nameLabel, "Assessee name", legalOrTradeName, "companies.legal_name / companies.name");
  }

  const pan = input.company.pan;
  const panPath = `${R}.PartA_GEN1.${cfg.personalKey}.PAN`;
  if (looksLikePan(pan)) {
    put(panPath, "PAN", pan, "companies.pan");
  } else {
    put(panPath, "PAN (placeholder)", "AAAAA0000A", "placeholder — no PAN on file for this company");
    warnings.push("No PAN on file for this company — a placeholder PAN (AAAAA0000A) was written in; the offline utility will reject this until you enter the real PAN.");
  }

  const stateResult = gstStateCodeToItrStateCode(input.headOffice?.state_code ?? null);
  if (stateResult.approximate) {
    warnings.push(
      `The registered address state (ITR code ${stateResult.itrCode}) is a best-effort approximation — see lib/itr/state-codes.ts for why this specific GST state code has no clean ITR State Master match.`
    );
  }
  const addrPrefix = `${R}.PartA_GEN1.${cfg.personalKey}.Address`;
  const hasRealAddress = !!(input.headOffice?.address_line1 || input.headOffice?.city);
  if (hasRealAddress) {
    put(`${addrPrefix}.ResidenceNo`, "Address line 1", input.headOffice!.address_line1 || "NA", "branches (head office)");
    if (input.headOffice!.address_line2) {
      postPatch.push({ path: `${addrPrefix}.RoadOrStreet`, label: "Address line 2", value: input.headOffice!.address_line2, source: "branches (head office) — optional field, patched in after the required skeleton" });
    }
    put(`${addrPrefix}.CityOrTownOrDistrict`, "City", input.headOffice!.city || "NA", "branches (head office)");
    put(`${addrPrefix}.LocalityOrArea`, "Locality", input.headOffice!.city || "NA", "branches (head office)");
    if (input.headOffice!.pincode) {
      postPatch.push({ path: `${addrPrefix}.PinCode`, label: "PIN code", value: Number(input.headOffice!.pincode), source: "branches (head office) — optional field, patched in after the required skeleton" });
    }
  } else {
    overlay[`${addrPrefix}.ResidenceNo`] = "NA";
    overlay[`${addrPrefix}.LocalityOrArea`] = "NA";
    overlay[`${addrPrefix}.CityOrTownOrDistrict`] = "NA";
    warnings.push("No street/city address on file for this company's head office (branches.address_line1/city are blank for every seeded company) — Address fields are written as \"NA\" placeholders.");
  }
  put(`${addrPrefix}.StateCode`, "State", stateResult.itrCode, "branches/gst_registrations state_code, translated via lib/itr/state-codes.ts");
  overlay[`${addrPrefix}.CountryCode`] = "91";
  overlay[`${addrPrefix}.CountryCodeMobile`] = 91;
  overlay[`${addrPrefix}.MobileNo`] = 0;
  overlay[`${addrPrefix}.EmailAddress`] = "not-provided@example.com";
  warnings.push("Mobile number and email were not supplied — fill them into the \"Additional filing details\" panel before downloading, or complete them in the offline utility.");

  if (isIndividualForm) {
    put(
      `${R}.PartA_GEN1.${cfg.personalKey}.DOB`,
      "Date of birth (placeholder)",
      input.company.incorporation_date || FIXED_PERIOD.fyStart,
      "companies.incorporation_date — NOT the proprietor's/karta's real date of birth, which LEKHA does not store anywhere"
    );
    warnings.push("DOB is filled with the business's own incorporation/commencement date as a structural placeholder — it is not the actual individual's date of birth. Replace it before filing.");
    overlay[`${R}.PartA_GEN1.${cfg.personalKey}.Status`] = input.company.entity_type === "huf" ? "H" : "I";
    if (input.company.incorporation_date) {
      put(`${R}.PartA_GEN1.${cfg.personalKey}.DateofBusCommencement`, "Business commencement date", input.company.incorporation_date, "companies.incorporation_date");
    }
  } else {
    if (input.company.incorporation_date) {
      put(`${R}.PartA_GEN1.${cfg.personalKey}.DateOFFormOrIncorp`, "Date of formation / incorporation", input.company.incorporation_date, "companies.incorporation_date");
    }
    const statusCode =
      input.form === "ITR-6"
        ? input.company.entity_type === "ltd"
          ? "6" // public company
          : "7" // private company (pvt_ltd, opc)
        : input.company.entity_type === "llp" || input.company.entity_type === "partnership"
          ? "1" // Firm (LLPs and partnerships share code 1 in ITR-5's own enum — see FilingStatus research)
          : input.company.entity_type === "society"
            ? "2" // Local Authority — the closest of ITR-5's 4 codes to a cooperative/society; approximation, flagged
            : "14"; // AOP/BOI
    put(
      `${R}.PartA_GEN1.${cfg.personalKey}.StatusOrCompanyType`,
      "Status / company type",
      statusCode,
      `ref_entity_types (entity_type = ${input.company.entity_type})`
    );
    if (input.company.entity_type === "society") {
      warnings.push("ITR-5's StatusOrCompanyType has no dedicated \"Co-operative Society\" code among its 4 values (Firm/Local Authority/AOP-BOI/Artificial Juridical Person) — \"Local Authority\" (2) was picked as the closest available; verify against the specific society's own registration before filing.");
    }
    if (input.form === "ITR-6") overlay[`${R}.PartA_GEN1.${cfg.personalKey}.DomesticCompFlg`] = "Y";
  }

  const filingPrefix = `${R}.PartA_GEN1.FilingStatus`;
  overlay[`${filingPrefix}.ForeignExchangeFlag`] = "N";
  overlay[`${filingPrefix}.FiiFpiFlag`] = "N";
  if (input.form === "ITR-3" || input.form === "ITR-5") overlay[`${filingPrefix}.HeldUnlistedEqShrPrYrFlg`] = "N";
  overlay[`${filingPrefix}.ResidentialStatus`] = "RES";
  const dueDate = input.taxAudit?.audit_required ? cfg.dueDateAudit : cfg.dueDateNonAudit;
  put(`${filingPrefix}.ItrFilingDueDate`, "Filing due date", dueDate, "get_tax_audit_applicability.audit_required, matched to this form's own due-date enum");
  if (input.form === "ITR-3") {
    overlay[`${filingPrefix}.ReturnFileSec`] = 11; // 139(1), on/before due date
    overlay[`${filingPrefix}.IncFrmBusOrProf`] = "Y";
  } else {
    overlay[`${filingPrefix}.ReturnFileSec.IncomeTaxSec`] = 11;
    if (input.form === "ITR-5") {
      overlay[`${filingPrefix}.BusinessTrustFlag`] = "N";
      overlay[`${filingPrefix}.InvstmntFundRefrdSec115UB`] = "N";
      overlay[`${filingPrefix}.StartUpDPIITFlag`] = "N";
      overlay[`${filingPrefix}.InterMinisterialCertFlag`] = "N";
      overlay[`${filingPrefix}.ifMSME`] = "N";
    } else {
      overlay[`${filingPrefix}.FinancialStmtFlag`] = "Y";
      overlay[`${filingPrefix}.UnderLiquidation`] = "N";
      overlay[`${filingPrefix}.Sec581AFlag`] = "N";
      overlay[`${filingPrefix}.StartUpDPIITFlag`] = "N";
      overlay[`${filingPrefix}.ifMSME`] = "N";
    }
  }

  // ---- PartA_GEN2(.For6).AuditInfo -------------------------------------------
  const auditPrefix = `${R}.PartA_GEN2${input.form === "ITR-6" ? "For6" : ""}.AuditInfo`;
  const auditRequired = !!input.taxAudit?.audit_required;
  overlay[`${auditPrefix}.LiableSec44AAflg`] = (input.taxAudit?.turnover ?? 0) > 0 ? "Y" : "N";
  overlay[`${auditPrefix}.IncDclrdUs`] = "N";
  put(`${auditPrefix}.LiableSec44ABflg`, "Tax audit required (Sec 44AB)", auditRequired ? "Y" : "N", "get_tax_audit_applicability");
  overlay[`${auditPrefix}.LiableSec92Eflg`] = "N";
  overlay[`${auditPrefix}.AccountAuditFlag`] = input.company.statutory_audit_rule === "always" ? "Y" : "N";
  if (auditRequired) {
    warnings.push("Tax audit (Sec 44AB) applies per get_tax_audit_applicability — this builder does not fill in the auditor's name/PAN/membership number/UDIN/report date (no such register exists in LEKHA). Use the \"Additional filing details\" panel to add them, or complete them in the offline utility.");
  }

  // ---- Balance sheet ----------------------------------------------------
  const bs = input.balanceSheet;
  const byNature = (nat: string) => bs.filter((r) => r.nature === nat);
  const byNatureRole = (nat: string, role: string) => bs.filter((r) => r.nature === nat && r.ledger_role === role);

  if (cfg.bsShape === "individual") {
    const P = `${R}.${cfg.bsKey}`;
    const propCap = sum(byNature("capital")) + sum(byNature("share_capital"));
    const resr = sum(byNature("reserves_surplus"));
    // LEKHA's account_groups.ledger_role does not distinguish secured from
    // unsecured borrowings (both long_term_borrowing-nature groups carry
    // ledger_role='other' in practice — confirmed live) — folded into
    // Unsecured Loans as the conservative default, and long_term_provision /
    // generic non_current_liability (no dedicated FundSrc slot in this
    // simplified individual/firm schedule) folded in alongside it.
    const loanFunds = sum(byNature("long_term_borrowing")) + sum(byNature("long_term_provision")) + sum(byNature("non_current_liability"));
    const deferredTaxLiab = sum(byNature("deferred_tax"));
    put(`${P}.FundSrc.PropFund.PropCap`, "Capital", round2(propCap), "get_balance_sheet (nature=capital/share_capital)");
    overlay[`${P}.FundSrc.PropFund.ResrNSurp.OthResr`] = round2(resr);
    overlay[`${P}.FundSrc.PropFund.ResrNSurp.TotResrNSurp`] = round2(resr);
    overlay[`${P}.FundSrc.PropFund.TotPropFund`] = round2(propCap + resr);
    overlay[`${P}.FundSrc.LoanFunds.UnsecrLoan.FrmOthrs`] = round2(loanFunds);
    overlay[`${P}.FundSrc.LoanFunds.UnsecrLoan.TotUnSecrLoan`] = round2(loanFunds);
    overlay[`${P}.FundSrc.LoanFunds.TotLoanFund`] = round2(loanFunds);
    if (loanFunds !== 0) {
      warnings.push("LEKHA does not distinguish secured from unsecured borrowings at the chart-of-accounts level — all long-term borrowings (and long-term provisions, which this simplified schedule has no separate slot for) are placed under Unsecured Loans. Reclassify in the utility if any loan is actually secured.");
    }
    overlay[`${P}.FundSrc.DeferredTax`] = round2(deferredTaxLiab);
    overlay[`${P}.FundSrc.Advances.TotalAdvances`] = 0;
    const totFundSrc = propCap + resr + loanFunds + deferredTaxLiab;
    put(`${P}.FundSrc.TotFundSrc`, "Total Sources of Funds", round2(totFundSrc), "get_balance_sheet, liabilities side total");

    const tangibleRows = byNatureRole("fixed_asset", "tangible_fixed_asset").concat(byNatureRole("fixed_asset", "intangible_fixed_asset"));
    const accDepRows = tangibleRows.filter((r) => r.ledger_name === "Accumulated Depreciation");
    const grossBlock = sum(tangibleRows) - sum(accDepRows); // exclude the contra from "gross"
    const depreciation = -sum(accDepRows); // contra is stored as a negative amount; express as a positive accumulated-depreciation figure
    const netBlock = grossBlock - depreciation;
    const cwip = sum(byNatureRole("fixed_asset", "capital_work_in_progress"));
    overlay[`${P}.FundApply.FixedAsset.GrossBlock`] = round2(grossBlock);
    overlay[`${P}.FundApply.FixedAsset.Depreciation`] = round2(depreciation);
    overlay[`${P}.FundApply.FixedAsset.NetBlock`] = round2(netBlock);
    overlay[`${P}.FundApply.FixedAsset.CapWrkProg`] = round2(cwip);
    put(`${P}.FundApply.FixedAsset.TotFixedAsset`, "Net fixed assets", round2(netBlock + cwip), "get_balance_sheet (ledger_role=tangible/intangible/capital_work_in_progress fixed asset, contra-netted)");

    const investments = sum(byNatureRole("fixed_asset", "investment"));
    overlay[`${P}.FundApply.Investments.LongTermInv.GovOthSecUnQoted`] = round2(investments);
    overlay[`${P}.FundApply.Investments.LongTermInv.TotLongTermInv`] = round2(investments);
    overlay[`${P}.FundApply.Investments.TotInvestments`] = round2(investments);
    if (investments !== 0) {
      warnings.push("Investments are LEKHA's single 'investment' ledger_role bucket, placed under Long-term/Other-unquoted as a generic default — this schedule wants a quoted/unquoted/equity/preference/debenture split LEKHA does not track.");
    }

    const inventories = sum(byNatureRole("current_asset", "stock"));
    const debtors = sum(byNatureRole("current_asset", "debtor"));
    const cashBank = sum(byNatureRole("current_asset", "cash_bank"));
    const loanAdv = sum(byNatureRole("current_asset", "loan"));
    const knownCurrentAssetRoles = new Set(["stock", "debtor", "cash_bank", "loan"]);
    const otherCurrAsset = sum(byNature("current_asset").filter((r) => !knownCurrentAssetRoles.has(r.ledger_role)));
    put(`${P}.FundApply.CurrAssetLoanAdv.CurrAsset.Inventories`, "Inventories (closing stock)", round2(inventories), "get_balance_sheet (ledger_role=stock)");
    put(`${P}.FundApply.CurrAssetLoanAdv.CurrAsset.SndryDebtors`, "Sundry debtors", round2(debtors), "get_balance_sheet (ledger_role=debtor)");
    put(`${P}.FundApply.CurrAssetLoanAdv.CurrAsset.CashOrBankBal`, "Cash & bank balances", round2(cashBank), "get_balance_sheet (ledger_role=cash_bank)");
    overlay[`${P}.FundApply.CurrAssetLoanAdv.CurrAsset.OthCurrAsset`] = round2(otherCurrAsset);
    const totCurrAsset = inventories + debtors + cashBank + otherCurrAsset;
    overlay[`${P}.FundApply.CurrAssetLoanAdv.CurrAsset.TotCurrAsset`] = round2(totCurrAsset);
    overlay[`${P}.FundApply.CurrAssetLoanAdv.LoanAdv.AdvRecoverable`] = round2(loanAdv);
    overlay[`${P}.FundApply.CurrAssetLoanAdv.LoanAdv.TotLoanAdv`] = round2(loanAdv);
    overlay[`${P}.FundApply.CurrAssetLoanAdv.TotCurrAssetLoanAdv`] = round2(totCurrAsset + loanAdv);

    const provisions = sum(byNatureRole("current_liability", "provision"));
    const currLiab = sum(byNature("current_liability")) - provisions;
    overlay[`${P}.FundApply.CurrAssetLoanAdv.CurrLiabilitiesProv.CurrLiabilities`] = round2(currLiab);
    overlay[`${P}.FundApply.CurrAssetLoanAdv.CurrLiabilitiesProv.Provisions`] = round2(provisions);
    overlay[`${P}.FundApply.CurrAssetLoanAdv.CurrLiabilitiesProv.TotCurrLiabilitiesProvision`] = round2(currLiab + provisions);
    const netCurrAsset = totCurrAsset + loanAdv - (currLiab + provisions);
    put(`${P}.FundApply.CurrAssetLoanAdv.NetCurrAsset`, "Net current assets", round2(netCurrAsset), "get_balance_sheet");
    overlay[`${P}.FundApply.MiscAdjust.MiscExpndr`] = 0;
    overlay[`${P}.FundApply.MiscAdjust.DefTaxAsset`] = 0;
    overlay[`${P}.FundApply.MiscAdjust.AccumaltedLosses`] = 0;
    overlay[`${P}.FundApply.MiscAdjust.TotMiscAdjust`] = 0;
    const totFundApply = netBlock + cwip + investments + netCurrAsset;
    put(`${P}.FundApply.TotFundApply`, "Total Application of Funds", round2(totFundApply), "get_balance_sheet, assets side total");
  } else {
    // Company (ITR-6) shape — EquityAndLiablities / Assets, the same
    // Schedule III Division I categories LEKHA's own account_groups.nature
    // already carries natively for every company entity type.
    const P = `${R}.${cfg.bsKey}`;
    // Every seeded company in this database still carries its real equity
    // balance under the pre-Schedule-III-split 'capital' nature group
    // ("Capital Account") — the dedicated 'share_capital' group 0037 seeds
    // alongside it exists but holds zero ledgers everywhere (confirmed
    // live: `select c.name, g.nature, count(l.id) from account_groups g
    // join ledgers l on l.group_id=g.id ... group by nature` — every
    // ltd/pvt_ltd/opc company's only populated equity ledger sits under
    // nature='capital'). Summing 'share_capital' alone would silently show
    // Rs 0 share capital for every company that has ever actually posted
    // to Capital Account — caught by hand-verifying Bharat Industries
    // Limited's real balance sheet before trusting this mapping.
    const shareCapital = sum(byNature("share_capital")) + sum(byNature("capital"));
    const resr = sum(byNature("reserves_surplus"));
    put(`${P}.EquityAndLiablities.ShareHolderFund.ShareCapital`, "Share capital", round2(shareCapital), "get_balance_sheet (nature=share_capital, folded with nature=capital — see comment above)");
    overlay[`${P}.EquityAndLiablities.ShareHolderFund.ResrNSurp`] = round2(resr);
    overlay[`${P}.EquityAndLiablities.ShareHolderFund.MoneyRecvdAgainstShares`] = 0;
    const shFund = shareCapital + resr;
    overlay[`${P}.EquityAndLiablities.ShareHolderFund.TotShareHolderFund`] = round2(shFund);
    overlay[`${P}.EquityAndLiablities.ShareAppMoneyAllot.PendingLtOneYr`] = 0;
    overlay[`${P}.EquityAndLiablities.ShareAppMoneyAllot.PendingMtOneYr`] = 0;
    overlay[`${P}.EquityAndLiablities.ShareAppMoneyAllot.Total`] = 0;

    const longTermBorrow = sum(byNature("long_term_borrowing"));
    const deferredTaxLiab = sum(byNature("deferred_tax"));
    const longTermProv = sum(byNature("long_term_provision"));
    const otherNonCurrLiab = sum(byNature("non_current_liability"));
    overlay[`${P}.EquityAndLiablities.NonCurrLiabilities.LongTermBorrowings`] = round2(longTermBorrow);
    overlay[`${P}.EquityAndLiablities.NonCurrLiabilities.NetDefferedTaxLiability`] = round2(deferredTaxLiab);
    overlay[`${P}.EquityAndLiablities.NonCurrLiabilities.OthLongTermLiablities`] = round2(otherNonCurrLiab);
    overlay[`${P}.EquityAndLiablities.NonCurrLiabilities.LongTermProvisions`] = round2(longTermProv);
    const nonCurrLiab = longTermBorrow + deferredTaxLiab + otherNonCurrLiab + longTermProv;
    overlay[`${P}.EquityAndLiablities.NonCurrLiabilities.TotalNonCurrLiabilites`] = round2(nonCurrLiab);

    const provisions = sum(byNatureRole("current_liability", "provision"));
    const creditors = sum(byNature("current_liability")) - provisions;
    overlay[`${P}.EquityAndLiablities.CurrentLiabilities.ShortTrmBorrowings`] = 0;
    put(`${P}.EquityAndLiablities.CurrentLiabilities.TradePayables`, "Trade payables", round2(creditors), "get_balance_sheet (nature=current_liability, ex-provisions)");
    overlay[`${P}.EquityAndLiablities.CurrentLiabilities.OthCurrLiabilities`] = 0;
    overlay[`${P}.EquityAndLiablities.CurrentLiabilities.ShortTermProv`] = round2(provisions);
    const currLiab = creditors + provisions;
    overlay[`${P}.EquityAndLiablities.CurrentLiabilities.TotCurrLiabilitiesProvision`] = round2(currLiab);
    const totEquityLiab = shFund + nonCurrLiab + currLiab;
    put(`${P}.EquityAndLiablities.TotEquityAndLiabilities`, "Total Equity and Liabilities", round2(totEquityLiab), "get_balance_sheet, liabilities side total");

    // Unlike the individual/firm shape above, ITR-6's FixedAsset field here
    // is a single NET figure (no separate Gross Block/Depreciation split
    // required) — summing tangibleRows as-is already nets the Accumulated
    // Depreciation contra correctly, no separate isolation needed.
    const tangibleRows = byNatureRole("fixed_asset", "tangible_fixed_asset").concat(byNatureRole("fixed_asset", "intangible_fixed_asset"));
    const netFixed = sum(tangibleRows) + sum(byNatureRole("fixed_asset", "capital_work_in_progress"));
    const investments = sum(byNatureRole("fixed_asset", "investment"));
    put(`${P}.Assets.NonCurrAssets.FixedAsset`, "Net fixed assets", round2(netFixed), "get_balance_sheet (ledger_role=tangible/intangible/capital_work_in_progress, net of accumulated depreciation)");
    overlay[`${P}.Assets.NonCurrAssets.NonCurrInvstmnts`] = round2(investments);
    overlay[`${P}.Assets.NonCurrAssets.NetDeferredTaxAssets`] = 0;
    overlay[`${P}.Assets.NonCurrAssets.LongTrmLoanAdv`] = 0;
    overlay[`${P}.Assets.NonCurrAssets.OthNonCurrAssets`] = 0;
    const totNonCurrAssets = netFixed + investments;
    overlay[`${P}.Assets.NonCurrAssets.TotNonCurrAssets`] = round2(totNonCurrAssets);

    const inventories = sum(byNatureRole("current_asset", "stock"));
    const debtors = sum(byNatureRole("current_asset", "debtor"));
    const cashBank = sum(byNatureRole("current_asset", "cash_bank"));
    const loanAdv = sum(byNatureRole("current_asset", "loan"));
    const knownRoles = new Set(["stock", "debtor", "cash_bank", "loan"]);
    const otherCurr = sum(byNature("current_asset").filter((r) => !knownRoles.has(r.ledger_role)));
    overlay[`${P}.Assets.CurrentAssets.CurrInvstmnts`] = 0;
    put(`${P}.Assets.CurrentAssets.Inventories`, "Inventories", round2(inventories), "get_balance_sheet (ledger_role=stock)");
    put(`${P}.Assets.CurrentAssets.TradeReceivables`, "Trade receivables", round2(debtors), "get_balance_sheet (ledger_role=debtor)");
    put(`${P}.Assets.CurrentAssets.CashNCashEquivalents`, "Cash & cash equivalents", round2(cashBank), "get_balance_sheet (ledger_role=cash_bank)");
    overlay[`${P}.Assets.CurrentAssets.TotShortTermLoanAdv`] = round2(loanAdv);
    overlay[`${P}.Assets.CurrentAssets.OtherCurrAssets`] = round2(otherCurr);
    const totCurrAssets = inventories + debtors + cashBank + loanAdv + otherCurr;
    overlay[`${P}.Assets.CurrentAssets.TotCurrAssets`] = round2(totCurrAssets);
    const totalAssets = totNonCurrAssets + totCurrAssets;
    put(`${R}.${cfg.bsKey}.TotalAssets`, "Total assets", round2(totalAssets), "get_balance_sheet, assets side total");
  }

  // ---- Profit & Loss (PARTA_PL, shared shape across all three forms) ----
  const pl = input.profitLoss;
  const tradingIncome = sum(pl.filter((r) => r.section === "trading" && r.nature === "direct_income"));
  const tradingExpense = sum(pl.filter((r) => r.section === "trading" && r.nature === "direct_expense"));
  const grossProfit = tradingIncome - tradingExpense;
  const otherIncome = sum(pl.filter((r) => r.nature === "indirect_income"));
  const totCredits = grossProfit + otherIncome;
  const employeeCost = sum(pl.filter((r) => r.ledger_role === "employee_benefits"));
  const financeCost = sum(pl.filter((r) => r.ledger_role === "finance_costs"));
  const depAmort = sum(pl.filter((r) => r.ledger_role === "depreciation_amortisation"));
  const otherExpenses = sum(pl.filter((r) => r.ledger_role === "other_expenses"));
  const taxExpense = sum(pl.filter((r) => r.ledger_role === "tax_expense"));
  const pbidta = totCredits - employeeCost - otherExpenses;
  const pbt = pbidta - financeCost - depAmort;
  const pat = pbt - taxExpense;

  const PL = `${R}.PARTA_PL`;
  put(`${PL}.CreditsToPL.GrossProfitTrnsfFrmTrdAcc`, "Gross profit (trading)", round2(grossProfit), "get_profit_and_loss (trading section: direct income - direct expense)");
  overlay[`${PL}.CreditsToPL.OthIncome.MiscOthIncome`] = round2(otherIncome);
  overlay[`${PL}.CreditsToPL.OthIncome.TotOthIncome`] = round2(otherIncome);
  put(`${PL}.CreditsToPL.TotCreditsToPL`, "Total credits to P&L", round2(totCredits), "get_profit_and_loss");
  const zeroDebits = [
    "Freight", "ConsumptionOfStores", "PowerFuel", "RentExpdr", "RepairsBldg", "RepairMach",
    "StaffWelfareExp", "Entertainment", "Hospitality", "Conference", "SalePromoExp", "Advertisement",
    "HotelBoardLodge", "TravelExp", "ForeignTravelExp", "ConveyanceExp", "TelephoneExp", "GuestHouseExp",
    "ClubExp", "FestivalCelebExp", "Scholarship", "Gift", "Donation", "AuditFee", "ProvForBadDoubtDebt", "OthProvisionsExpdr",
  ];
  for (const k of zeroDebits) overlay[`${PL}.DebitsToPL.${k}`] = 0;
  overlay[`${PL}.DebitsToPL.EmployeeComp.SalsWages`] = round2(employeeCost);
  for (const k of ["Bonus", "MedExpReimb", "LeaveEncash", "LeaveTravelBenft", "ContToSuperAnnFund", "ContToPF", "ContToGratFund", "ContToOthFund", "OthEmpBenftExpdr"]) {
    overlay[`${PL}.DebitsToPL.EmployeeComp.${k}`] = 0;
  }
  put(`${PL}.DebitsToPL.EmployeeComp.TotEmployeeComp`, "Employee cost", round2(employeeCost), "get_profit_and_loss (ledger_role=employee_benefits)");
  for (const g of ["MedInsur", "LifeInsur", "KeyManInsur", "OthInsur", "TotInsurances"]) overlay[`${PL}.DebitsToPL.Insurances.${g}`] = 0;
  for (const g of ["CommissionExpdrDtls", "RoyalityDtls", "ProfessionalConstDtls"]) {
    overlay[`${PL}.DebitsToPL.${g}.NonResOtherCompany`] = 0;
    overlay[`${PL}.DebitsToPL.${g}.Others`] = 0;
    overlay[`${PL}.DebitsToPL.${g}.Total`] = 0;
  }
  overlay[`${PL}.DebitsToPL.RatesTaxesPays.ExciseCustomsVAT`] = 0;
  put(`${PL}.DebitsToPL.OtherExpenses`, "Other expenses", round2(otherExpenses), "get_profit_and_loss (ledger_role=other_expenses)");
  for (const g of ["OthersPANNotAvlblDtlTotal", "OthersAmtLt1Lakh", "BadDebtAmtDtlsTotal", "BadDebt"]) overlay[`${PL}.DebitsToPL.BadDebtDtls.${g}`] = 0;
  put(`${PL}.DebitsToPL.PBIDTA`, "PBIDTA", round2(pbidta), "get_profit_and_loss (revenue - employee cost - other expenses)");
  overlay[`${PL}.DebitsToPL.InterestExpdrtDtls.NonResOtherCompany`] = 0;
  put(`${PL}.DebitsToPL.InterestExpdrtDtls.Others`, "Interest / finance cost", round2(financeCost), "get_profit_and_loss (ledger_role=finance_costs)");
  overlay[`${PL}.DebitsToPL.InterestExpdrtDtls.InterestExpdr`] = round2(financeCost);
  put(`${PL}.DebitsToPL.DepreciationAmort`, "Depreciation & amortisation", round2(depAmort), "get_profit_and_loss (ledger_role=depreciation_amortisation)");
  put(`${PL}.DebitsToPL.PBT`, "Profit before tax", round2(pbt), "get_profit_and_loss (PBIDTA - interest - depreciation)");

  put(`${PL}.TaxProvAppr.ProvForCurrTax`, "Provision for current tax", round2(taxExpense), "get_profit_and_loss (ledger_role=tax_expense)");
  overlay[`${PL}.TaxProvAppr.ProvDefTax`] = 0;
  put(`${PL}.TaxProvAppr.ProfitAfterTax`, "Profit after tax", round2(pat), "get_profit_and_loss");
  overlay[`${PL}.TaxProvAppr.BalBFPrevYr`] = 0;
  overlay[`${PL}.TaxProvAppr.AmtAvlAppr`] = round2(pat);
  overlay[`${PL}.TaxProvAppr.TrfToReserves`] = 0;
  overlay[`${PL}.TaxProvAppr.ProprietorAccBalTrf`] = isIndividualForm ? round2(pat) : 0;
  // Regular books are maintained (not the 44AD/ADA no-books-of-account
  // route) — the presumptive-scheme NoBooksOfAccPL block is genuinely all
  // zero, not a gap.
  for (const k of [
    "GrossReceipt", "GrsRcptAccPayeeOrBankMode", "GrsRcptOtherMode", "GrossProfit", "Expenses", "NetProfit",
    "GrossReceiptPrf", "GrsRcptAccPayeeOrBankModePrf", "GrsRcptOtherModePrf", "GrossProfitPrf", "ExpensesPrf", "NetProfitPrf", "TotBusinessProfession",
  ]) {
    overlay[`${PL}.NoBooksOfAccPL.${k}`] = 0;
  }
  overlay[`${PL}.TurnverFrmSpecActivity`] = 0;
  overlay[`${PL}.GrossProfit`] = 0;
  overlay[`${PL}.Expenditure`] = 0;
  overlay[`${PL}.NetIncomeFrmSpecActivity`] = 0;

  // ---- Business income schedule (only its book-profit anchor) -----------
  put(`${R}.${cfg.bpKey}.BusinessIncOthThanSpec.ProfBfrTaxPL`, "Book profit per P&L (schedule anchor)", round2(pbt), "get_profit_and_loss — see DEFERRED for why the rest of this schedule is not populated");

  // ---- Income & tax computation summary (PartB-TI / PartB_TTI) ----------
  const tc = input.taxComputation;
  const taxApplicable = !!tc?.applicable;
  if (!taxApplicable) {
    warnings.push(
      `get_income_tax_computation does not model this entity type's tax computation (${tc?.note ?? "AOP/BOI and trust taxation depends on member-share determinacy / Sec 11-13 registration status, neither tracked by this schema"}) — the Income (PartB-TI) and Tax computation (PartB_TTI) sections below are ZERO-FILLED PLACEHOLDERS ONLY. Compute and enter these figures manually.`
    );
  }
  const businessIncome = tc?.business_income ?? 0;
  const stcgNet = Math.max((tc?.short_term_capital_gain ?? 0) - (tc?.short_term_capital_loss ?? 0), 0);
  const gti = tc?.gross_total_income ?? 0;
  const totalIncome = tc?.taxable_income ?? 0;

  const TI = `${R}.PartB-TI`;
  overlay[`${TI}.Salaries`] = 0;
  overlay[`${TI}.IncomeFromHP`] = 0;
  put(`${TI}.ProfBusGain.ProfGainNoSpecBus`, "Income from business/profession", round2(businessIncome), "get_income_tax_computation.business_income");
  overlay[`${TI}.ProfBusGain.ProfGainSpecBus`] = 0;
  overlay[`${TI}.ProfBusGain.ProfGainSpecifiedBus`] = 0;
  overlay[`${TI}.ProfBusGain.ProfIncome115BBF`] = 0;
  overlay[`${TI}.ProfBusGain.TotProfBusGain`] = round2(businessIncome);
  for (const g of ["ShortTerm20Per", "ShortTerm30Per", "ShortTermSplRateDTAA"]) overlay[`${TI}.CapGain.ShortTerm.${g}`] = 0;
  put(`${TI}.CapGain.ShortTerm.ShortTermAppRate`, "Short-term capital gain (Sec 50, slab rate)", round2(stcgNet), "get_income_tax_computation.short_term_capital_gain - short_term_capital_loss");
  overlay[`${TI}.CapGain.ShortTerm.TotalShortTerm`] = round2(stcgNet);
  for (const g of ["LongTerm12_5Per", "LongTermSplRateDTAA"]) overlay[`${TI}.CapGain.LongTerm.${g}`] = 0;
  overlay[`${TI}.CapGain.LongTerm.TotalLongTerm`] = 0;
  overlay[`${TI}.CapGain.ShortTermLongTermTotal`] = round2(stcgNet);
  overlay[`${TI}.CapGain.CapGains30Per115BBH`] = 0;
  overlay[`${TI}.CapGain.TotalCapGains`] = round2(stcgNet);
  overlay[`${TI}.IncFromOS.OtherSrcThanOwnRaceHorse`] = 0;
  overlay[`${TI}.IncFromOS.IncChargblSplRate`] = 0;
  overlay[`${TI}.IncFromOS.FromOwnRaceHorse`] = 0;
  overlay[`${TI}.IncFromOS.TotIncFromOS`] = 0;
  const totalTI = businessIncome + stcgNet;
  put(`${TI}.TotalTI`, "Total of all heads (before loss set-off)", round2(totalTI), "get_income_tax_computation");
  overlay[`${TI}.CurrentYearLoss`] = 0;
  overlay[`${TI}.BalanceAfterSetoffLosses`] = round2(totalTI);
  overlay[`${TI}.BroughtFwdLossesSetoff`] = 0;
  put(`${TI}.GrossTotalIncome`, "Gross total income", round2(gti), "get_income_tax_computation.gross_total_income");
  overlay[`${TI}.IncChargeTaxSplRate111A112`] = 0;
  overlay[`${TI}.DeductionsUndSchVIADtl.PartBchapterVIA`] = 0;
  overlay[`${TI}.DeductionsUndSchVIADtl.PartCchapterVIA`] = 0;
  overlay[`${TI}.DeductionsUndSchVIADtl.TotDeductUndSchVIA`] = 0;
  overlay[`${TI}.DeductionsUnder10Aor10AA`] = 0;
  put(`${TI}.TotalIncome`, "Total income (taxable income)", round2(totalIncome), "get_income_tax_computation.taxable_income");
  overlay[`${TI}.IncChargeableTaxSplRates`] = 0;
  overlay[`${TI}.NetAgricultureIncomeOrOtherIncomeForRate`] = 0;
  overlay[`${TI}.AggregateIncome`] = round2(totalIncome);
  overlay[`${TI}.LossesOfCurrentYearCarriedFwd`] = round2(tc?.gross_total_income !== undefined ? Math.max(-gti, 0) : 0);
  overlay[`${TI}.DeemedIncomeUs115JC`] = 0;

  const taxBeforeRebate = tc?.tax_before_rebate ?? 0;
  const rebate = tc?.rebate_87a ?? 0;
  const taxAfterRebate = tc?.tax_after_rebate ?? 0;
  const surcharge = tc?.surcharge ?? 0;
  const cess = tc?.cess ?? 0;
  const totalTax = tc?.total_tax ?? 0;
  const advance = tc?.advance_tax_paid ?? 0;
  const selfAssessment = tc?.self_assessment_tax_paid ?? 0;
  const tdsCredit = tc?.tds_tcs_credit ?? 0;
  const netPayable = tc?.net_tax_payable ?? 0;

  const TTI = `${R}.PartB_TTI`;
  for (const g of ["TaxDeemedTISec115JC", "SurchargeOnAboveCrore", "EducationCess", "TotalTax"]) overlay[`${TTI}.ComputationOfTaxLiability.TaxPayableOnDeemedTI.${g}`] = 0;
  put(`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.TaxAtNormalRatesOnAggrInc`, "Tax at normal rates", round2(taxBeforeRebate), "get_income_tax_computation.tax_before_rebate");
  overlay[`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.TaxAtSpecialRates`] = 0;
  overlay[`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.RebateOnAgriInc`] = 0;
  overlay[`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.TaxPayableOnTotInc`] = round2(taxBeforeRebate);
  put(`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.Rebate87A`, "Rebate u/s 87A", round2(rebate), "get_income_tax_computation.rebate_87a");
  overlay[`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.TaxPayableOnRebate`] = round2(taxAfterRebate);
  overlay[`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.Surcharge25ofSI`] = 0;
  overlay[`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.SurchargeOnAboveCrore`] = round2(surcharge);
  overlay[`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.Surcharge25ofSIBeforeMarginal`] = 0;
  overlay[`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.SurchargeOnAboveCroreBeforeMarginal`] = round2(surcharge);
  put(`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.TotalSurcharge`, "Surcharge", round2(surcharge), "get_income_tax_computation.surcharge");
  put(`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.EducationCess`, "Health & education cess", round2(cess), "get_income_tax_computation.cess");
  put(`${TTI}.ComputationOfTaxLiability.TaxPayableOnTI.GrossTaxLiability`, "Gross tax liability", round2(totalTax), "get_income_tax_computation.total_tax");
  put(`${TTI}.ComputationOfTaxLiability.GrossTaxPayable`, "Gross tax payable", round2(totalTax), "get_income_tax_computation.total_tax");
  for (const g of ["TaxInc17", "TaxDeferred17", "TaxDeferredPayableCY"]) overlay[`${TTI}.ComputationOfTaxLiability.GrossTaxPay.${g}`] = 0;
  overlay[`${TTI}.ComputationOfTaxLiability.CreditUS115JD`] = 0;
  overlay[`${TTI}.ComputationOfTaxLiability.TaxPayAfterCreditUs115JD`] = round2(totalTax);
  overlay[`${TTI}.ComputationOfTaxLiability.TaxRelief.TotTaxRelief`] = 0;
  put(`${TTI}.ComputationOfTaxLiability.NetTaxLiability`, "Net tax liability", round2(totalTax), "get_income_tax_computation.total_tax");
  for (const g of ["IntrstPayUs234A", "IntrstPayUs234B", "IntrstPayUs234C", "LateFilingFee234F"]) overlay[`${TTI}.ComputationOfTaxLiability.IntrstPay.${g}`] = 0;
  put(`${TTI}.ComputationOfTaxLiability.AggregateTaxInterestLiability`, "Aggregate tax + interest liability", round2(totalTax), "get_income_tax_computation.total_tax (234A/B/C/F not computed — see DEFERRED)");

  const totalPaid = advance + selfAssessment + tdsCredit;
  overlay[`${TTI}.TaxPaid.TaxesPaid.TotalTaxesPaid`] = round2(totalPaid);
  put(`${TTI}.TaxPaid.TaxesPaid.TotalTaxesPaid`, "Taxes already paid (advance + self-assessment + TDS/TCS credit)", round2(totalPaid), "get_income_tax_computation");
  const balPayable = Math.max(netPayable, 0);
  const refundDue = Math.max(-netPayable, 0);
  overlay[`${TTI}.TaxPaid.BalTaxPayable`] = round2(balPayable);
  put(`${TTI}.Refund.RefundDue`, "Refund due", round2(refundDue), "get_income_tax_computation.net_tax_payable (negative = refund)");
  overlay[`${TTI}.Refund.BankAccountDtls.BankDtlsFlag`] = "N";
  overlay[`${TTI}.AssetOutIndiaFlag`] = "NO";
  if (balPayable > 0) {
    put(`${TTI}.TaxPaid.BalTaxPayable`, "Balance tax payable", round2(balPayable), "get_income_tax_computation.net_tax_payable");
  }
  warnings.push("Refund.BankAccountDtls.BankDtlsFlag is left \"N\" (no bank account details supplied) — the utility requires at least one validated bank account for any refund to actually be processed; add it in the utility.");

  // ---- Verification -------------------------------------------------------
  const verifName = looksLikePan(pan) ? legalOrTradeName : legalOrTradeName;
  put(`${R}.Verification.Declaration.AssesseeVerName`, "Verifier name (placeholder)", verifName, "companies.legal_name/name — see the same identity caveat as AssesseeName above");
  overlay[`${R}.Verification.Declaration.FatherName`] = "NA";
  overlay[`${R}.Verification.Declaration.AssesseeVerPAN`] = looksLikePan(pan) ? pan : "AAAAA0000A";
  overlay[`${R}.Verification.Capacity`] = input.company.entity_type === "proprietorship" ? "S" : input.company.entity_type === "huf" ? "K" : "R";
  overlay[`${R}.Verification.Date`] = todayIso();
  overlay[`${R}.Verification.Place`] = "NA";

  // ---- Build ---------------------------------------------------------------
  const { value } = buildMinimalInstance(cfg.schema, cfg.rootDef, (path) => overlay[path]);
  // Optional-but-real fields (see postPatch's own declaration above) go on
  // AFTER the required skeleton — they sit on keys buildMinimalInstance
  // never visits at all, since it only walks `required` chains.
  for (const p of postPatch) {
    setAtPath(value as Record<string, unknown>, p.path.slice(cfg.rootDef.length + 1), p.value);
    populated.push(p);
  }
  const json = { ITR: { [cfg.rootDef]: value } };

  const missing = collectMissingRequiredPaths(cfg.schema, cfg.rootDef, value);
  const deferred = [...COMMON_DEFERRED];
  if (input.form === "ITR-6") deferred.push(IND_AS_DEFERRED);

  return {
    json,
    populated,
    deferred,
    warnings,
    structuralCheck: { requiredPathCount: countTouched(cfg.schema, cfg.rootDef, value), missing },
  };
}

function countTouched(defs: JsonSchemaDefs, rootDef: string, value: unknown): number {
  // Re-derive the same count buildMinimalInstance already computed, purely
  // by walking the finished object against the schema's own required lists
  // — an independent recount rather than trusting the builder's own tally.
  let n = 0;
  function walk(defName: string, v: unknown) {
    const node = defs[defName];
    if (!node) return;
    const obj = (v ?? {}) as Record<string, unknown>;
    for (const key of node.required ?? []) {
      n++;
      const propSchema = node.properties?.[key];
      const ref = propSchema?.$ref?.split("/").pop();
      if (ref) walk(ref, obj[key]);
    }
  }
  walk(rootDef, value);
  return n;
}

export { setAtPath };
