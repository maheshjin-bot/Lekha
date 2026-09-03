"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { friendlyLedgerError } from "@/lib/ledgers/friendlyError";

type Ledger = {
  id: string;
  name: string;
  group_id: string;
  opening_balance_amount: number;
  opening_balance_type: string;
  is_active: boolean;
  pan: string | null;
  tan: string | null;
  is_tds_deductee: boolean;
  default_tds_section: string | null;
  udyam_number: string | null;
  msme_category: string | null;
  msme_payment_days: number | null;
  is_partner_remuneration: boolean;
  is_related_party: boolean;
  relationship_type: string | null;
  is_loan_or_deposit: boolean;
  sec43b_category: string | null;
  gst_registration_type: string | null;
};

type Group = {
  id: string;
  name: string;
  nature: string;
  ledger_role: string;
  parent_group_id: string | null;
};

type TdsSection = { section_code: string; description: string; rate_percent: number };

type StateOption = { code: string; name: string };

// Mirrors app_private.is_valid_udyam exactly.
const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
// Mirrors app_private.is_valid_pan exactly.
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// Mirrors app_private.is_valid_tan exactly (0148) — 4 letters, 5 digits, 1
// letter, a fixed real TAN format, distinct from PAN's shape above. This is
// the deductor identity a 26AS/AIS row is keyed on (Reports > TDS credit
// match) — without it here, a customer's TAN can never be recorded at all.
const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

// The shape half of app_private.is_valid_gstin. The check digit stays the
// database's job — a drifting second copy would reject numbers it accepts.
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/*
 * A GSTIN's first two characters ARE the state code (and 3-12 are the PAN) —
 * the same derivation QuickAddLedgerModal uses, and the reason
 * ledgers_gstin_matches_state (0735) can be a CHECK rather than a prompt.
 */
const stateFromGstin = (g: string) => (GSTIN_PATTERN.test(g) ? g.slice(0, 2) : "");

// Registration types that mean "this party holds a GSTIN", mirroring
// ledgers_registered_has_gstin (0735).
const GST_TYPES_NEEDING_GSTIN = [
  "regular",
  "composition",
  "sez",
  "sez_developer",
  "uin",
  "deemed_export",
];

// Short labels for the sec43b_category check-constraint values.
const SEC43B_LABEL: Record<string, string> = {
  statutory_dues: "Tax/duty/cess/fee",
  employee_welfare_fund: "PF/gratuity fund",
  bonus_commission: "Bonus/commission",
  specified_interest: "Bank/PFI interest",
  leave_encashment: "Leave encashment",
};

// Mirrors ledgers_gst_registration_type_check exactly (0006, extended in
// meaning but not in values by 0087). 'regular' is left out of the dropdown
// on purpose — a GSTIN attached to the ledger already sets it automatically
// (enforce_ledger_gst_identity, 0006), and offering it here would invite
// someone to pick it for a party that has no GSTIN at all.
const GST_REG_TYPE_LABEL: Record<string, string> = {
  regular: "Regular",
  composition: "Composition",
  unregistered: "Unregistered",
  sez: "SEZ unit",
  sez_developer: "SEZ developer",
  overseas: "Overseas (export)",
  uin: "UIN holder",
  deemed_export: "Deemed export (Sec 147)",
};
const GST_REG_TYPE_OPTIONS = [
  "composition",
  "unregistered",
  "sez",
  "sez_developer",
  "overseas",
  "uin",
  "deemed_export",
];

// Mirrors ledgers_relationship_type_check exactly (0105). AS 18 / Ind AS 24's
// own relationship categories — see that migration's header for why this
// rides the pre-existing Sec 40A(2)(b) is_related_party flag rather than a
// separate one, and the coverage gap that reuse leaves.
const RELATIONSHIP_TYPE_LABEL: Record<string, string> = {
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

export function LedgerManager({
  companyId,
  initialLedgers,
  groups,
  tdsSections,
  tdsOn,
  msmeOn,
  partnerRemunerationOn,
  relatedPartyOn,
  loanTrackingOn,
  sec43bOn,
  gstOn,
}: {
  companyId: string;
  initialLedgers: Ledger[];
  groups: Group[];
  tdsSections: TdsSection[];
  tdsOn: boolean;
  msmeOn: boolean;
  partnerRemunerationOn: boolean;
  relatedPartyOn: boolean;
  loanTrackingOn: boolean;
  sec43bOn: boolean;
  gstOn: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  // Sub-groups are where ledgers normally live; the eight primary groups are
  // structural. Default to the first sub-group so the common case is one click.
  const [groupId, setGroupId] = useState(
    groups.find((g) => g.parent_group_id)?.id ?? groups[0]?.id ?? ""
  );
  const [opening, setOpening] = useState("0");
  const [openingType, setOpeningType] = useState<"debit" | "credit">("debit");
  const [pan, setPan] = useState("");
  const [tan, setTan] = useState("");
  const [isTdsDeductee, setIsTdsDeductee] = useState(false);
  const [tdsSection, setTdsSection] = useState("");
  const [isMsme, setIsMsme] = useState(false);
  const [udyam, setUdyam] = useState("");
  const [msmeCategory, setMsmeCategory] = useState("");
  const [msmePaymentDays, setMsmePaymentDays] = useState("");
  const [isPartnerRemuneration, setIsPartnerRemuneration] = useState(false);
  const [isRelatedParty, setIsRelatedParty] = useState(false);
  const [relationshipType, setRelationshipType] = useState("");
  const [isLoanOrDeposit, setIsLoanOrDeposit] = useState(false);
  const [sec43bCategory, setSec43bCategory] = useState("");
  const [gstRegType, setGstRegType] = useState("");
  const [gstin, setGstin] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [states, setStates] = useState<StateOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * ref_states is fetched here rather than threaded down from the page. This
   * component's page already hands down five other lists and is owned by a
   * different concern; QuickAddLedgerModal reads the same table the same way
   * for the same reason. Forty rows, once per mount.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from("ref_states")
        .select("code, name")
        .order("name");
      if (!cancelled) setStates(data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * WHY THIS SCREEN HAS A STATE FIELD AT ALL.
   *
   * A pilot preparer created a customer here and then could not invoice it.
   * create_invoice resolves the place of supply from the party's state_code
   * when the caller passes none, and raises
   *   'Cannot determine place of supply: <uuid> has no state on file …'
   * when there is none. This screen had no State control, so every party born
   * on it was born without one — thirteen such party ledgers exist live across
   * four companies as this is written. The quick-add popup inside the invoice
   * form has always captured state; the main master screen did not, which is
   * the whole defect: the deliberate, unhurried way of creating a party was
   * the one that produced an unusable party.
   *
   * The GSTIN, when there is one, remains the source of truth — see
   * gstinState below. This control is what answers the far more common case
   * of a party with no GSTIN at all (an unregistered buyer, a consumer, an
   * SEZ party being set up before its number is to hand), for which nothing on
   * this page could previously state a state.
   */
  const gstinState = stateFromGstin(gstin);
  // ledgers_gstin_matches_state (0735) is an equality, not a preference: with
  // a well-formed GSTIN on the form the state is DERIVED, not chosen, and the
  // control is disabled rather than left to be edited into a refusal.
  const effectiveStateCode = gstinState || stateCode;

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? "—";
  const sectionRate = (code: string | null) =>
    tdsSections.find((s) => s.section_code === code)?.rate_percent;
  const udyamLooksValid = udyam.length === 0 || UDYAM_PATTERN.test(udyam);
  const panLooksValid = pan.length === 0 || PAN_PATTERN.test(pan);
  const tanLooksValid = tan.length === 0 || TAN_PATTERN.test(tan);
  const gstinLooksValid = gstin.length === 0 || GSTIN_PATTERN.test(gstin);
  // "" here means "Regular / not set" in this screen's own dropdown, which is
  // stored as null and stays permissive — so only an explicit registered type
  // demands a number.
  const gstinRequired = GST_TYPES_NEEDING_GSTIN.includes(gstRegType);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient().from("ledgers").insert({
      company_id: companyId,
      group_id: groupId,
      name: name.trim(),
      opening_balance_amount: Number(opening) || 0,
      opening_balance_type: openingType,
      pan: pan.trim() || null,
      tan: tan.trim() || null,
      is_tds_deductee: isTdsDeductee,
      default_tds_section: isTdsDeductee ? tdsSection || null : null,
      udyam_number: isMsme ? udyam.trim() || null : null,
      msme_category: isMsme ? msmeCategory || null : null,
      msme_payment_days: isMsme && msmePaymentDays ? Number(msmePaymentDays) : null,
      is_partner_remuneration: isPartnerRemuneration,
      is_related_party: isRelatedParty,
      relationship_type: isRelatedParty ? relationshipType || null : null,
      is_loan_or_deposit: isLoanOrDeposit,
      sec43b_category: sec43bCategory || null,
      gst_registration_type: gstRegType || null,
      gstin: gstin.trim() || null,
      // ledgers_gstin_matches_state (0735) requires state_code to be the
      // GSTIN's own first two characters when there is a GSTIN. When there
      // isn't, the State control below is the only place it can come from —
      // and without it the party cannot be invoiced at all. See the
      // effectiveStateCode comment above.
      state_code: effectiveStateCode || null,
    });

    if (error) {
      // See lib/ledgers/friendlyError.ts's own header: this used to be a
      // bare `setError(error.message)`, which surfaced Postgres's raw
      // constraint-violation text verbatim (e.g. a mistyped GSTIN's check
      // digit). Found live (wave 7, 1 Sep 2026).
      setError(friendlyLedgerError(error, name.trim()));
      setBusy(false);
      return;
    }

    setName("");
    setOpening("0");
    setPan("");
    setTan("");
    setIsTdsDeductee(false);
    setTdsSection("");
    setIsMsme(false);
    setUdyam("");
    setMsmeCategory("");
    setMsmePaymentDays("");
    setIsPartnerRemuneration(false);
    setIsRelatedParty(false);
    setRelationshipType("");
    setIsLoanOrDeposit(false);
    setSec43bCategory("");
    setGstRegType("");
    setGstin("");
    setStateCode("");
    setBusy(false);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Ledger</th>
                <th className="px-4 py-2.5 font-medium">Group</th>
                <th className="px-4 py-2.5 font-medium">PAN</th>
                <th className="px-4 py-2.5 font-medium">TAN</th>
                {tdsOn && <th className="px-4 py-2.5 font-medium">TDS</th>}
                {msmeOn && <th className="px-4 py-2.5 font-medium">MSME</th>}
                {partnerRemunerationOn && <th className="px-4 py-2.5 font-medium">Sec 40(b)</th>}
                {relatedPartyOn && <th className="px-4 py-2.5 font-medium">Related party</th>}
                {loanTrackingOn && <th className="px-4 py-2.5 font-medium">Loan/deposit</th>}
                {sec43bOn && <th className="px-4 py-2.5 font-medium">Sec 43B</th>}
                {gstOn && <th className="px-4 py-2.5 font-medium">GST type</th>}
                <th className="px-4 py-2.5 text-right font-medium">Opening</th>
              </tr>
            </thead>
            <tbody>
              {initialLedgers.length === 0 && (
                <tr>
                  <td
                    colSpan={
                      5 +
                      (tdsOn ? 1 : 0) +
                      (msmeOn ? 1 : 0) +
                      (partnerRemunerationOn ? 1 : 0) +
                      (relatedPartyOn ? 1 : 0) +
                      (loanTrackingOn ? 1 : 0) +
                      (sec43bOn ? 1 : 0) +
                      (gstOn ? 1 : 0)
                    }
                    className="px-4 py-10 text-center text-ink-faint"
                  >
                    No ledgers yet. Create one on the right.
                  </td>
                </tr>
              )}
              {initialLedgers.map((l) => (
                <tr
                  key={l.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-2.5 font-medium">{l.name}</td>
                  <td className="px-4 py-2.5 text-ink-soft">
                    {groupName(l.group_id)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-soft">
                    {l.pan ?? <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-soft">
                    {l.tan ?? <span className="text-ink-faint">—</span>}
                  </td>
                  {tdsOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.is_tds_deductee ? (
                        <span className="font-mono text-xs">
                          {l.default_tds_section ?? "—"}
                          {sectionRate(l.default_tds_section) != null && (
                            <span className="ml-1 text-ink-faint">
                              {sectionRate(l.default_tds_section)}%
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  )}
                  {msmeOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.udyam_number ? (
                        <span className="text-xs capitalize">
                          {l.msme_category ?? "MSME"}
                          <span className="ml-1 text-ink-faint">
                            {l.msme_payment_days ?? 15}d
                          </span>
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  )}
                  {partnerRemunerationOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.is_partner_remuneration ? (
                        <span className="text-xs">Remuneration</span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  )}
                  {relatedPartyOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.is_related_party ? (
                        <span className="text-xs">
                          {l.relationship_type
                            ? RELATIONSHIP_TYPE_LABEL[l.relationship_type] ?? l.relationship_type
                            : "Sec 40A(2)(b)"}
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  )}
                  {loanTrackingOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.is_loan_or_deposit ? (
                        <span className="text-xs">Sec 269SS/T</span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  )}
                  {sec43bOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.sec43b_category ? (
                        <span className="text-xs">{SEC43B_LABEL[l.sec43b_category] ?? l.sec43b_category}</span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  )}
                  {gstOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.gst_registration_type && l.gst_registration_type !== "regular" ? (
                        <span className="text-xs">
                          {GST_REG_TYPE_LABEL[l.gst_registration_type] ?? l.gst_registration_type}
                        </span>
                      ) : (
                        <span className="text-ink-faint">
                          {l.gst_registration_type === "regular" ? "Regular" : "—"}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                    {l.opening_balance_amount > 0 ? (
                      <>
                        {formatINR(l.opening_balance_amount)}
                        <span className="ml-1.5 text-[10px] uppercase text-ink-faint">
                          {l.opening_balance_type === "debit" ? "Dr" : "Cr"}
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New ledger</h2>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              PAN{" "}
              <span className="font-normal text-ink-faint">
                optional — sets the TCS no-PAN rate, shown on GST documents
              </span>
            </span>
            <input
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              maxLength={10}
              placeholder="AAAAA0000A"
              className={field + " font-mono uppercase"}
            />
            {pan.length > 0 && !panLooksValid && (
              <span className="text-xs text-warning">
                That doesn&rsquo;t match the PAN format (5 letters, 4 digits,
                1 letter).
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              TAN{" "}
              <span className="font-normal text-ink-faint">
                optional — the deductor identity a customer&rsquo;s Form
                26AS/AIS row is matched against on Reports &rsaquo; TDS
                credit match
              </span>
            </span>
            <input
              value={tan}
              onChange={(e) => setTan(e.target.value.toUpperCase())}
              maxLength={10}
              placeholder="ABCD12345E"
              className={field + " font-mono uppercase"}
            />
            {tan.length > 0 && !tanLooksValid && (
              <span className="text-xs text-warning">
                That doesn&rsquo;t match the TAN format (4 letters, 5 digits,
                1 letter).
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              State{" "}
              <span className="font-normal text-ink-faint">
                {gstOn ? "place of supply for invoices to this party" : "optional"}
              </span>
            </span>
            <select
              value={effectiveStateCode}
              disabled={gstinState !== ""}
              onChange={(e) => setStateCode(e.target.value)}
              className={field + (gstinState ? " opacity-60" : "")}
            >
              <option value="">Not stated</option>
              {states.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-faint">
              {gstinState
                ? "Taken from the GSTIN below — its first two characters are the State."
                : gstOn
                  ? "Leave this unset and an invoice to this party cannot work out whether to charge CGST+SGST or IGST, and refuses to save."
                  : "Only used to decide the place of supply on a GST invoice."}
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Group</span>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className={field}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.parent_group_id ? "  " : ""}
                  {g.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-faint">
              Missing the group you need?{" "}
              <Link href={`/${companyId}/account-groups`} className="underline">
                Add one to the chart of accounts
              </Link>
              .
            </span>
          </label>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Opening balance</span>
              <input
                inputMode="decimal"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                className={field + " text-right tabular-nums"}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Side</span>
              <select
                value={openingType}
                onChange={(e) => setOpeningType(e.target.value as "debit" | "credit")}
                className={field}
              >
                <option value="debit">Dr</option>
                <option value="credit">Cr</option>
              </select>
            </label>
          </div>

          {tdsOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isTdsDeductee}
                  onChange={(e) => {
                    setIsTdsDeductee(e.target.checked);
                    if (!e.target.checked) setTdsSection("");
                  }}
                />
                TDS deductee
              </label>
              {isTdsDeductee && (
                <label className="mt-2 flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">
                    Default section — a starting point offered when this ledger
                    is used in a voucher; the threshold is yours to check, not
                    checked automatically
                  </span>
                  <select
                    value={tdsSection}
                    onChange={(e) => setTdsSection(e.target.value)}
                    className={field}
                  >
                    <option value="">Not set</option>
                    {tdsSections.map((s) => (
                      <option key={s.section_code} value={s.section_code}>
                        {s.section_code} — {s.rate_percent}%
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {/* Lower/nil deduction certificates (Sec 197) are a real but
                  uncommon case — left to a future edit surface rather than
                  crowding the create form; ledgers.ldc_* columns already
                  support it, this form just doesn't set them yet. */}
            </div>
          )}

          {msmeOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isMsme}
                  onChange={(e) => {
                    setIsMsme(e.target.checked);
                    if (!e.target.checked) {
                      setUdyam("");
                      setMsmeCategory("");
                      setMsmePaymentDays("");
                    }
                  }}
                />
                MSME supplier (Sec 43B(h))
              </label>
              {isMsme && (
                <div className="mt-2 flex flex-col gap-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-ink-faint">Udyam number</span>
                    <input
                      value={udyam}
                      onChange={(e) => setUdyam(e.target.value.toUpperCase())}
                      placeholder="UDYAM-XX-00-0000000"
                      className={field + " font-mono uppercase"}
                    />
                    {udyam.length > 0 && !udyamLooksValid && (
                      <span className="text-xs text-warning">
                        That doesn&rsquo;t match the Udyam number format.
                      </span>
                    )}
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-ink-faint">Category</span>
                      <select
                        value={msmeCategory}
                        onChange={(e) => setMsmeCategory(e.target.value)}
                        className={field}
                      >
                        <option value="">Not set</option>
                        <option value="micro">Micro</option>
                        <option value="small">Small</option>
                        <option value="medium">Medium</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-ink-faint">
                        Payment deadline (days)
                      </span>
                      <input
                        inputMode="numeric"
                        value={msmePaymentDays}
                        onChange={(e) => setMsmePaymentDays(e.target.value)}
                        placeholder="15"
                        className={field}
                      />
                    </label>
                  </div>
                  <span className="text-xs text-ink-faint">
                    45 days only applies with a written agreement — leave this
                    blank to use the safer 15-day default.
                  </span>
                </div>
              )}
            </div>
          )}

          {partnerRemunerationOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isPartnerRemuneration}
                  onChange={(e) => setIsPartnerRemuneration(e.target.checked)}
                />
                Partner remuneration (Sec 40(b))
              </label>
              <span className="mt-1 block text-xs text-ink-faint">
                Salary/bonus/commission paid to a working partner — the
                income tax report tests what&rsquo;s posted here against the
                slab ceiling and flags any excess.
              </span>
            </div>
          )}

          {relatedPartyOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isRelatedParty}
                  onChange={(e) => {
                    setIsRelatedParty(e.target.checked);
                    if (!e.target.checked) setRelationshipType("");
                  }}
                />
                Related / specified person (Sec 40A(2)(b) and AS 18)
              </label>
              <span className="mt-1 block text-xs text-ink-faint">
                A director, partner, their relative, or an entity in which
                the assessee/director/partner has a substantial interest —
                the tax audit report lists actual payments made to this
                ledger under Form 3CD clause 23, and the AS 18 related-party
                note (Reports &rsaquo; Notes to accounts) rolls up its
                transactions and closing balance. The two tests are not
                identical (AS 18 also reaches key management personnel with
                no shareholding) — tick this for either reason.
              </span>
              {isRelatedParty && (
                <label className="mt-2 flex flex-col gap-1.5">
                  <span className="text-sm font-medium">AS 18 relationship</span>
                  <select
                    value={relationshipType}
                    onChange={(e) => setRelationshipType(e.target.value)}
                    className={field}
                  >
                    <option value="">Not classified</option>
                    {Object.entries(RELATIONSHIP_TYPE_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          {loanTrackingOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isLoanOrDeposit}
                  onChange={(e) => setIsLoanOrDeposit(e.target.checked)}
                />
                Loan/deposit ledger (Sec 269SS/269T)
              </label>
              <span className="mt-1 block text-xs text-ink-faint">
                One ledger per lender or depositor — the tax audit report
                flags any cash acceptance or repayment on this ledger once
                the outstanding balance from this person reaches
                ₹20,000, since both sections require an account-payee
                cheque, draft or electronic mode above that limit.
              </span>
            </div>
          )}

          {sec43bOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Sec 43B category</span>
                <select
                  value={sec43bCategory}
                  onChange={(e) => setSec43bCategory(e.target.value)}
                  className={field}
                >
                  <option value="">Not applicable</option>
                  <option value="statutory_dues">Tax, duty, cess or fee</option>
                  <option value="employee_welfare_fund">PF/superannuation/gratuity fund</option>
                  <option value="bonus_commission">Bonus or commission</option>
                  <option value="specified_interest">Interest — bank/PFI/NBFC loan only</option>
                  <option value="leave_encashment">Leave encashment</option>
                </select>
              </label>
              <span className="mt-1 block text-xs text-ink-faint">
                Deductible only when actually paid, not merely accrued — the
                tax audit report lists this ledger&rsquo;s outstanding
                balance at year end as a candidate disallowance under Form
                3CD clause 26. Don&rsquo;t use &ldquo;Interest&rdquo; for a
                director or other unspecified lender — Sec 43B only reaches
                interest owed to a bank, PFI or NBFC.
              </span>
            </div>
          )}

          {gstOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">GST registration type</span>
                <select
                  value={gstRegType}
                  onChange={(e) => {
                    const next = e.target.value;
                    setGstRegType(next);
                    // Keeps ledgers_unregistered_has_no_gstin (0735)
                    // satisfiable without the preparer having to know it.
                    if (next === "unregistered" || next === "overseas") setGstin("");
                  }}
                  className={field}
                >
                  <option value="">Regular / not set</option>
                  {GST_REG_TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {GST_REG_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              {gstRegType !== "unregistered" && gstRegType !== "overseas" && (
                <label className="mt-3 flex flex-col gap-1.5">
                  <span className="text-sm font-medium">
                    GSTIN{" "}
                    <span className="font-normal text-ink-faint">
                      {gstinRequired ? "required" : "optional"}
                    </span>
                  </span>
                  <input
                    value={gstin}
                    onChange={(e) => {
                      const next = e.target.value.toUpperCase().slice(0, 15);
                      setGstin(next);
                      // State and PAN are substrings of the GSTIN; filling
                      // them from it is what satisfies
                      // ledgers_gstin_matches_state / _matches_pan (0735)
                      // rather than asking twice and risking a refusal.
                      // Written through to stateCode as well as derived, so
                      // that clearing the GSTIN again leaves the State the
                      // number had already established rather than blanking
                      // the party back to un-invoiceable.
                      if (GSTIN_PATTERN.test(next)) {
                        setPan(next.slice(2, 12));
                        setStateCode(next.slice(0, 2));
                      }
                    }}
                    maxLength={15}
                    placeholder="07AAAAA0000A1Z5"
                    className={field + " font-mono uppercase"}
                  />
                  {gstin.length > 0 && !gstinLooksValid ? (
                    <span className="text-xs text-warning">
                      A GSTIN is 15 characters: 2-digit state, 10-character
                      PAN, then 3 more.
                    </span>
                  ) : (
                    <span className="text-xs text-ink-faint">
                      Fills in state and PAN automatically. Without it a
                      registered party&rsquo;s invoices land in the B2C tables
                      of GSTR-1 instead of B2B, and an e-invoice cannot be
                      generated at all.
                    </span>
                  )}
                </label>
              )}

              <span className="mt-1 block text-xs text-ink-faint">
                Only needed for a party that isn&rsquo;t an ordinary
                registered/unregistered domestic buyer or seller. A sale to
                &ldquo;Overseas&rdquo; or an SEZ party is zero-rated
                automatically when this company&rsquo;s GST registration has
                an active LUT on file (set on the Registrations page) — full
                IGST is charged instead when it doesn&rsquo;t.
                &ldquo;Deemed export&rdquo; is taxed normally; only its
                refund eligibility differs, so nothing here changes the tax.
              </span>
            </div>
          )}

          {error && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add ledger"}
          </button>
        </form>
      </section>
    </div>
  );
}
