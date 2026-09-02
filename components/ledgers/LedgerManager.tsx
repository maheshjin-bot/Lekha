"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { friendlyLedgerError } from "@/lib/ledgers/friendlyError";
import {
  EMAIL_PATTERN,
  GSTIN_PATTERN,
  PAN_PATTERN,
  PINCODE_PATTERN,
  UDYAM_PATTERN,
  blankOrMatches,
  forbidsGstin,
  needsGstin,
  panFromGstin,
  stateFromGstin,
} from "@/lib/ledgers/fieldPatterns";

type Ledger = {
  id: string;
  name: string;
  group_id: string;
  opening_balance_amount: number;
  opening_balance_type: string;
  is_active: boolean;
  pan: string | null;
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

// UDYAM_PATTERN, PAN_PATTERN, GSTIN_PATTERN, PINCODE_PATTERN and
// GST_TYPES_NEEDING_GSTIN used to be declared here AND, separately, in
// QuickAddLedgerModal.tsx — two hand-maintained copies of the same CHECK
// constraints, which is how the two forms drifted apart on their field set.
// They now live in lib/ledgers/fieldPatterns.ts; see that file's header.

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
  // Address, town and PIN. Collected here since 1 Sep 2026 — this form had
  // never asked for any of the three, while QuickAddLedgerModal (the popup the
  // invoice and voucher screens open) had collected all three for months. The
  // consequence was not cosmetic: build_einvoice_json (0230) refuses outright
  // with 'Buyer (%) is missing a required address field (address, city or PIN
  // code)', so every B2B customer created on THIS screen was permanently
  // ineligible for an e-invoice with nothing on the page to say why.
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [pincode, setPincode] = useState("");
  // Who to ring, and on what terms. Also never collected here before.
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  // credit_days had NO setter anywhere in the app, on any screen, while
  // get_overdue_receivables (0031) and get_bill_wise_outstanding both compute
  // a due date as voucher_date + coalesce(ledgers.credit_days, 30). So every
  // party in every company has silently been on 30-day terms, and a customer
  // genuinely on 15 or 60 days was reported overdue on the wrong date with no
  // way to correct it. Confirmed live: two readers, both with that fallback,
  // zero writers.
  const [creditDays, setCreditDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? "—";
  const sectionRate = (code: string | null) =>
    tdsSections.find((s) => s.section_code === code)?.rate_percent;
  const udyamLooksValid = blankOrMatches(UDYAM_PATTERN, udyam);
  const panLooksValid = blankOrMatches(PAN_PATTERN, pan);
  const gstinLooksValid = blankOrMatches(GSTIN_PATTERN, gstin);
  const pincodeLooksValid = blankOrMatches(PINCODE_PATTERN, pincode);
  const emailLooksValid = blankOrMatches(EMAIL_PATTERN, email);
  // smallint, and negative credit terms are not a thing. An empty box means
  // "not stated", which is what leaves the readers on their 30-day fallback.
  const creditDaysLooksValid =
    creditDays.trim().length === 0 || /^[0-9]{1,4}$/.test(creditDays.trim());
  // "" here means "Regular / not set" in this screen's own dropdown, which is
  // stored as null and stays permissive — so only an explicit registered type
  // demands a number.
  const gstinRequired = needsGstin(gstRegType);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    // ledgers_pincode_check said in words before the round trip, the same way
    // QuickAddLedgerModal already does — otherwise a mistyped PIN comes back
    // as a constraint name, which is the exact failure commit 7080e88 fixed
    // for GSTIN on this form.
    if (!pincodeLooksValid) {
      setError("A PIN code is six digits and cannot start with a zero.");
      return;
    }
    if (!emailLooksValid) {
      setError("That doesn't look like an email address.");
      return;
    }
    if (!creditDaysLooksValid) {
      setError("Credit days is a whole number of days — leave it blank if the party has no agreed terms.");
      return;
    }

    setBusy(true);
    setError(null);

    const { error } = await createClient().from("ledgers").insert({
      company_id: companyId,
      group_id: groupId,
      name: name.trim(),
      opening_balance_amount: Number(opening) || 0,
      opening_balance_type: openingType,
      pan: pan.trim() || null,
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
      // The three fields build_einvoice_json (0230) hard-blocks on. Nothing
      // cross-validates them — an address is an address — so they are plain
      // trimmed text, exactly as QuickAddLedgerModal writes them.
      address: address.trim() || null,
      city: city.trim() || null,
      pincode: pincode.trim() || null,
      contact_person: contactPerson.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      // Left null rather than defaulted to 30 here on purpose: null is what
      // the readers' own coalesce(..., 30) means by "no agreed terms", and
      // writing 30 would turn a blank box into an assertion nobody made.
      credit_days: creditDays.trim() ? Number(creditDays.trim()) : null,
      // ledgers_gstin_matches_state (0735) requires state_code to be the
      // GSTIN's own first two characters. This screen has never had a State
      // control, so the number is the only place it can come from — deriving
      // it here is what stops a GSTIN entered on this screen being refused.
      ...(stateFromGstin(gstin.trim()) ? { state_code: stateFromGstin(gstin.trim()) } : {}),
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
    setAddress("");
    setCity("");
    setPincode("");
    setContactPerson("");
    setPhone("");
    setEmail("");
    setCreditDays("");
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
                      4 +
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

          <div className="rounded-md border border-border p-3">
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  Address{" "}
                  <span className="font-normal text-ink-faint">optional</span>
                </span>
                <input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Building, street"
                  className={field}
                />
              </label>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">Town / city</span>
                  <input
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    className={field}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">PIN code</span>
                  <input
                    value={pincode}
                    onChange={(e) =>
                      setPincode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))
                    }
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="400001"
                    className={
                      field +
                      " w-28 font-mono" +
                      (pincodeLooksValid ? "" : " border-error focus-visible:border-error")
                    }
                  />
                </label>
              </div>
              {pincode.length > 0 && !pincodeLooksValid ? (
                <span className="text-xs text-warning">
                  Six digits, and it cannot start with a zero.
                </span>
              ) : (
                <span className="text-xs text-ink-faint">
                  An e-invoice payload is built from the buyer&rsquo;s own
                  address — without all three of these it cannot be generated
                  for this party at all.
                </span>
              )}

              <label className="mt-1 flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Contact person</span>
                <input
                  value={contactPerson}
                  onChange={(e) => setContactPerson(e.target.value)}
                  className={field}
                />
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">Phone</span>
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    inputMode="tel"
                    className={field}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">Email</span>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    inputMode="email"
                    className={
                      field + (emailLooksValid ? "" : " border-error focus-visible:border-error")
                    }
                  />
                </label>
              </div>
              {email.length > 0 && !emailLooksValid && (
                <span className="text-xs text-warning">
                  That is not a usable address.
                </span>
              )}

              <label className="mt-1 flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">
                  Credit days{" "}
                  <span className="text-ink-faint">
                    — blank means no agreed terms
                  </span>
                </span>
                <input
                  value={creditDays}
                  onChange={(e) =>
                    setCreditDays(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))
                  }
                  inputMode="numeric"
                  placeholder="30"
                  className={
                    field +
                    " w-28 text-right tabular-nums" +
                    (creditDaysLooksValid ? "" : " border-error focus-visible:border-error")
                  }
                />
              </label>
              <span className="text-xs text-ink-faint">
                What the overdue-receivables and bill-wise outstanding reports
                measure this party&rsquo;s invoices against. Left blank they
                assume 30 days — which is what every party has silently been
                on, because until now there was nowhere to say otherwise.
              </span>
            </div>
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
                    if (forbidsGstin(next)) setGstin("");
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
              {!forbidsGstin(gstRegType) && (
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
                      const derivedPan = panFromGstin(next);
                      if (derivedPan) setPan(derivedPan);
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
