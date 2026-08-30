import { createClient } from "@/lib/supabase/client";

/**
 * Everything public.create_invoice looks up FOR ITSELF, read back before the
 * preview does its arithmetic — and read from the same tables, with the same
 * predicates, on the same voucher date.
 *
 * ============================================================================
 * WHY THE PREVIEW DOES NOT REUSE THE REVIEW SCREEN'S OWN PROPS
 * ============================================================================
 * The review screen is handed items, ledgers, branches and a `gstOn` flag by
 * its page, and every one of them is a slightly different question from the one
 * create_invoice asks:
 *
 *   gstOn — the page computes it from get_company_modules with NO DATE.
 *   create_invoice asks app_private.module_active(company, 'gst', VOUCHER
 *   DATE). A bill dated before the company's GST module took effect, or after
 *   it lapsed, posts with no tax at all while the screen still says GST is on.
 *
 *   the branch's state — the page reads branches.gst_registration_id ->
 *   gst_registrations.state_code with no date filter. create_invoice calls
 *   app_private.branch_registration(branch, VOUCHER DATE), which additionally
 *   requires registered_from <= date <= registered_to, and RAISES when nothing
 *   matches. A preview built from the prop would compute a confident tax split
 *   for a post that is about to be refused.
 *
 *   the item — the page selects gst_rate_percent but NOT cess_rate_percent and
 *   NOT is_rcm_applicable, and both change the entries: cess adds a fifth tax
 *   ledger, and a reverse-charge line moves the tax off the supplier's bill
 *   entirely and onto RCM Payable with its own matching debit.
 *
 *   the party — the page selects state, PAN and GSTIN but not
 *   gst_registration_type, which is what decides between an ordinary domestic
 *   split and export / SEZ / deemed-export treatment.
 *
 *   the tax ledgers — nothing on the screen knows them at all. They are
 *   resolved by app_private.tax_ledger from public.tax_ledger_map, and naming
 *   the actual ledger ("Input IGST (27)") is most of what makes the previewed
 *   double entry worth reading.
 *
 * All of it is ordinary SELECT traffic under the reviewer's own RLS — six
 * reads, once, when the preview opens. NOTHING here writes, and nothing here
 * calls an RPC.
 */

export type PreviewItemFacts = {
  id: string;
  name: string;
  uom: string | null;
  hsnSac: string | null;
  gstRatePercent: number | string | null;
  cessRatePercent: number | string | null;
  defaultTcsSection: string | null;
  isRcmApplicable: boolean | null;
};

export type PreviewTcsSection = {
  ratePercent: number | string | null;
  noPanRatePercent: number | string | null;
  thresholdRupees: number | string | null;
};

export type PreviewRegistration = {
  id: string;
  stateCode: string | null;
  gstin: string | null;
  /**
   * Three-valued on purpose. create_invoice assigns
   *   `lut_number is not null and date >= lut_valid_from and (…)`
   * which is NULL — not false — when a registration carries an LUT number but
   * no valid-from date, and create_invoice's `sez and not v_lut_active` branch
   * is then not taken either. Collapsing it to false here would put a preview
   * on screen that charges IGST on an SEZ supply the post will not charge.
   */
  lutActive: boolean | null;
};

export type PreviewFacts = {
  /** module_active(company, 'gst', voucher date). */
  gstModuleActive: boolean;
  /** module_active(company, 'tcs', voucher date) — the prefix rule is the model's. */
  tcsModuleActive: boolean;
  /** branch_registration(branch, voucher date). Null means create_invoice raises. */
  registration: PreviewRegistration | null;
  /** True when a registration IS attached but its period excludes this date. */
  registrationOutOfPeriod: boolean;
  partyStateCode: string | null;
  partyPan: string | null;
  partyRegistrationType: string | null;
  items: Record<string, PreviewItemFacts>;
  /** purpose -> ledger NAME, from tax_ledger_map for this registration. */
  taxLedgers: Record<string, string>;
  tcsSections: Record<string, PreviewTcsSection>;
};

/** ISO YYYY-MM-DD compares lexicographically, which is why these are plain. */
function onOrAfter(date: string, from: string | null): boolean {
  return from == null ? false : date >= from;
}
function onOrBefore(date: string, to: string | null): boolean {
  return to == null ? true : date <= to;
}

/**
 * app_private.module_active, mirrored: a 'core'-tier module is always on, and
 * anything else needs a licensed company_modules row covering the date.
 */
function moduleActive(
  code: string,
  date: string,
  tiers: Map<string, string>,
  rows: { module_code: string; licensed: boolean; effective_from: string; effective_to: string | null }[]
): boolean {
  if (tiers.get(code) === "core") return true;
  return rows.some(
    (r) =>
      r.module_code === code &&
      r.licensed &&
      onOrAfter(date, r.effective_from) &&
      onOrBefore(date, r.effective_to)
  );
}

export async function loadPreviewFacts(args: {
  companyId: string;
  branchId: string;
  voucherDate: string;
  partyLedgerId: string;
  itemIds: string[];
}): Promise<{ facts: PreviewFacts | null; error: string | null }> {
  const supabase = createClient();
  const { companyId, branchId, voucherDate, partyLedgerId, itemIds } = args;

  const [modulesRes, tiersRes, branchRes, partyRes, itemsRes, mapRes, tcsRes] = await Promise.all([
    supabase
      .from("company_modules")
      .select("module_code, licensed, effective_from, effective_to")
      .eq("company_id", companyId)
      .in("module_code", ["gst", "tcs"]),
    supabase.from("ref_modules").select("code, tier").in("code", ["gst", "tcs"]),
    supabase
      .from("branches")
      .select(
        "gst_registration_id, gst_registrations(id, state_code, gstin, registered_from, registered_to, lut_number, lut_valid_from, lut_valid_to)"
      )
      .eq("id", branchId)
      .maybeSingle(),
    // Skipped when no party is chosen yet. `.eq("id", "")` is a 400 from
    // PostgREST (invalid uuid), which would surface as "the facts could not be
    // read" over the top of the far more useful "no supplier is selected".
    partyLedgerId
      ? supabase
          .from("ledgers")
          .select("state_code, pan, gst_registration_type")
          .eq("id", partyLedgerId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    itemIds.length
      ? supabase
          .from("items")
          .select(
            "id, name, uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable"
          )
          .in("id", itemIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("tax_ledger_map")
      .select("purpose, gst_registration_id, ledgers(name)")
      .eq("company_id", companyId),
    supabase
      .from("ref_tcs_sections")
      .select("section_code, rate_percent, no_pan_rate_percent, threshold_rupees")
      .eq("is_active", true),
  ]);

  const firstError =
    modulesRes.error ??
    tiersRes.error ??
    branchRes.error ??
    partyRes.error ??
    itemsRes.error ??
    mapRes.error ??
    tcsRes.error;
  if (firstError) {
    // Deliberately no partial preview. Half the facts produce a confident
    // double entry that happens to be wrong, which is the one outcome this
    // whole component exists to prevent.
    return { facts: null, error: firstError.message };
  }

  const tiers = new Map((tiersRes.data ?? []).map((r) => [r.code, r.tier]));
  const moduleRows = modulesRes.data ?? [];

  const attached = branchRes.data?.gst_registrations ?? null;
  const inPeriod =
    attached != null &&
    onOrAfter(voucherDate, attached.registered_from) &&
    onOrBefore(voucherDate, attached.registered_to);

  const registration: PreviewRegistration | null =
    attached && inPeriod
      ? {
          id: attached.id,
          stateCode: attached.state_code,
          gstin: attached.gstin,
          lutActive:
            attached.lut_number == null
              ? false
              : attached.lut_valid_from == null
                ? null
                : voucherDate >= attached.lut_valid_from &&
                  onOrBefore(voucherDate, attached.lut_valid_to),
        }
      : null;

  const items: Record<string, PreviewItemFacts> = {};
  for (const row of itemsRes.data ?? []) {
    items[row.id] = {
      id: row.id,
      name: row.name,
      uom: row.uom,
      hsnSac: row.hsn_sac,
      gstRatePercent: row.gst_rate_percent,
      cessRatePercent: row.cess_rate_percent,
      defaultTcsSection: row.default_tcs_section,
      isRcmApplicable: row.is_rcm_applicable,
    };
  }

  /**
   * app_private.tax_ledger matches on `gst_registration_id is not distinct
   * from` whatever it is handed, and create_invoice hands it two different
   * things: the resolved registration for every GST purpose, and NULL for
   * output_tcs, which is company-wide because a TAN is. So the scope is
   * decided per purpose here, exactly as the caller decides it — not by
   * accepting whichever row happens to come back last, which would pick the
   * wrong ledger the day a purpose exists at both scopes.
   */
  const COMPANY_WIDE = new Set(["output_tcs", "tds_payable", "tds_receivable"]);
  const taxLedgers: Record<string, string> = {};
  for (const row of mapRes.data ?? []) {
    const name = row.ledgers?.name;
    if (!name) continue;
    const wantedScope = COMPANY_WIDE.has(row.purpose) ? null : (registration?.id ?? null);
    if ((row.gst_registration_id ?? null) === wantedScope) taxLedgers[row.purpose] = name;
  }

  const tcsSections: Record<string, PreviewTcsSection> = {};
  for (const row of tcsRes.data ?? []) {
    tcsSections[row.section_code] = {
      ratePercent: row.rate_percent,
      noPanRatePercent: row.no_pan_rate_percent,
      thresholdRupees: row.threshold_rupees,
    };
  }

  return {
    facts: {
      gstModuleActive: moduleActive("gst", voucherDate, tiers, moduleRows),
      tcsModuleActive: moduleActive("tcs", voucherDate, tiers, moduleRows),
      registration,
      registrationOutOfPeriod: attached != null && !inPeriod,
      partyStateCode: partyRes.data?.state_code ?? null,
      partyPan: partyRes.data?.pan ?? null,
      partyRegistrationType: partyRes.data?.gst_registration_type ?? null,
      items,
      taxLedgers,
      tcsSections,
    },
    error: null,
  };
}
