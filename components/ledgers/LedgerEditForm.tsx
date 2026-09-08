"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { friendlyLedgerError } from "@/lib/ledgers/friendlyError";
import {
  UDYAM_PATTERN,
  PAN_PATTERN,
  TAN_PATTERN,
  GSTIN_PATTERN,
  stateFromGstin,
  PINCODE_PATTERN,
  EMAIL_PATTERN,
  GST_TYPES_NEEDING_GSTIN,
  GST_REG_TYPE_LABEL,
  GST_REG_TYPE_OPTIONS,
  RELATIONSHIP_TYPE_LABEL,
  PARTY_TYPE_LABEL,
  NAME_LOCKED_LEDGERS,
} from "@/lib/ledgers/validation";

/**
 * The edit-time twin of LedgerManager.tsx's "New ledger" form — a
 * deliberately separate component, same reasoning update_invoice gave for
 * not sharing a component with create_invoice: an edit screen carries real
 * locks (group, name) a create screen has no reason to think about, and a
 * shared component would need to thread those through as dead weight on
 * every new ledger. Recovered 1900 — see that migration's own header for
 * the fuller story of why this screen didn't exist in git until now.
 */

export type EditableLedger = {
  id: string;
  name: string;
  group_id: string;
  opening_balance_amount: number;
  opening_balance_type: string;
  is_active: boolean;
  pan: string | null;
  tan: string | null;
  state_code: string | null;
  gst_registration_type: string | null;
  gstin: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  notes: string | null;
  udyam_number: string | null;
  msme_category: string | null;
  msme_payment_days: number | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  is_tds_deductee: boolean;
  default_tds_section: string | null;
  is_partner_remuneration: boolean;
  is_related_party: boolean;
  relationship_type: string | null;
  is_loan_or_deposit: boolean;
  sec43b_category: string | null;
  party_type: string | null;
  credit_days: number | null;
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

export function LedgerEditForm({
  companyId,
  ledger,
  hasPostings,
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
  ledger: EditableLedger;
  hasPostings: boolean;
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

  const [name, setName] = useState(ledger.name);
  const [groupId, setGroupId] = useState(ledger.group_id);
  const [isActive, setIsActive] = useState(ledger.is_active);
  const [opening, setOpening] = useState(String(ledger.opening_balance_amount));
  const [openingType, setOpeningType] = useState<"debit" | "credit">(
    ledger.opening_balance_type === "credit" ? "credit" : "debit"
  );
  const [pan, setPan] = useState(ledger.pan ?? "");
  const [tan, setTan] = useState(ledger.tan ?? "");
  const [isTdsDeductee, setIsTdsDeductee] = useState(ledger.is_tds_deductee);
  const [tdsSection, setTdsSection] = useState(ledger.default_tds_section ?? "");
  const [isMsme, setIsMsme] = useState(!!ledger.udyam_number);
  const [udyam, setUdyam] = useState(ledger.udyam_number ?? "");
  const [msmeCategory, setMsmeCategory] = useState(ledger.msme_category ?? "");
  const [msmePaymentDays, setMsmePaymentDays] = useState(
    ledger.msme_payment_days != null ? String(ledger.msme_payment_days) : ""
  );
  const [isPartnerRemuneration, setIsPartnerRemuneration] = useState(ledger.is_partner_remuneration);
  const [isRelatedParty, setIsRelatedParty] = useState(ledger.is_related_party);
  const [relationshipType, setRelationshipType] = useState(ledger.relationship_type ?? "");
  const [isLoanOrDeposit, setIsLoanOrDeposit] = useState(ledger.is_loan_or_deposit);
  const [sec43bCategory, setSec43bCategory] = useState(ledger.sec43b_category ?? "");
  const [gstRegType, setGstRegType] = useState(ledger.gst_registration_type ?? "");
  const [gstin, setGstin] = useState(ledger.gstin ?? "");
  const [stateCode, setStateCode] = useState(ledger.state_code ?? "");
  const [states, setStates] = useState<StateOption[]>([]);
  const [address, setAddress] = useState(ledger.address ?? "");
  const [city, setCity] = useState(ledger.city ?? "");
  const [pincode, setPincode] = useState(ledger.pincode ?? "");
  const [contactPerson, setContactPerson] = useState(ledger.contact_person ?? "");
  const [phone, setPhone] = useState(ledger.phone ?? "");
  const [email, setEmail] = useState(ledger.email ?? "");
  const [creditDays, setCreditDays] = useState(
    ledger.credit_days != null ? String(ledger.credit_days) : ""
  );
  const [partyType, setPartyType] = useState(ledger.party_type ?? "");
  const [bankName, setBankName] = useState(ledger.bank_name ?? "");
  const [bankAccount, setBankAccount] = useState(ledger.bank_account_number ?? "");
  const [bankIfsc, setBankIfsc] = useState(ledger.bank_ifsc ?? "");
  const [notes, setNotes] = useState(ledger.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await createClient().from("ref_states").select("code, name").order("name");
      if (!cancelled) setStates(data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // update_ledger (1900) refuses to rename any of these 8 — see
  // lib/ledgers/validation.ts's own header. Checked against the ledger's
  // ORIGINAL name, not the live form value: the guard fires on any change
  // AWAY from one of these names, so once a ledger is born with one, the
  // field is locked for good rather than lockable-until-you-try.
  const nameLocked = NAME_LOCKED_LEDGERS.includes(ledger.name);
  // Group is locked once real postings exist, regardless of admin status —
  // see this project's own migration 1900 header for why a group change is
  // different in kind from any other field here.
  const groupLocked = hasPostings;

  const gstinState = stateFromGstin(gstin);
  const effectiveStateCode = gstinState || stateCode;

  const udyamLooksValid = udyam.length === 0 || UDYAM_PATTERN.test(udyam);
  const panLooksValid = pan.length === 0 || PAN_PATTERN.test(pan);
  const tanLooksValid = tan.length === 0 || TAN_PATTERN.test(tan);
  const gstinLooksValid = gstin.length === 0 || GSTIN_PATTERN.test(gstin);
  const pincodeLooksValid = pincode.length === 0 || PINCODE_PATTERN.test(pincode);
  const emailLooksValid = email.length === 0 || EMAIL_PATTERN.test(email);
  const creditDaysLooksValid =
    creditDays.trim().length === 0 || /^[0-9]{1,4}$/.test(creditDays.trim());
  const gstinRequired = GST_TYPES_NEEDING_GSTIN.includes(gstRegType);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
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

    // update_ledger's params with no SQL DEFAULT are typed required-and-
    // non-null by the generator even though the column itself is nullable
    // (Postgres happily accepts an explicit null for a required parameter —
    // required and non-nullable are different things). Routed through
    // callRpc to pass null honestly rather than casting past the type, the
    // same reasoning as ItemManager.tsx's own update_item call.
    const { error: rpcError } = await callRpc(createClient(), "update_ledger", {
      p_ledger_id: ledger.id,
      p_name: nameLocked ? ledger.name : name.trim(),
      p_group_id: groupLocked ? ledger.group_id : groupId,
      p_opening_balance_amount: Number(opening) || 0,
      p_opening_balance_type: openingType,
      p_is_active: isActive,
      p_pan: pan.trim() || null,
      p_tan: tan.trim() || null,
      p_state_code: effectiveStateCode || null,
      p_gst_registration_type: gstRegType || null,
      p_gstin: gstin.trim() || null,
      p_contact_person: contactPerson.trim() || null,
      p_phone: phone.trim() || null,
      p_email: email.trim() || null,
      p_address: address.trim() || null,
      p_city: city.trim() || null,
      p_pincode: pincode.trim() || null,
      p_notes: notes.trim() || null,
      p_udyam_number: isMsme ? udyam.trim() || null : null,
      p_msme_category: isMsme ? msmeCategory || null : null,
      p_msme_payment_days: isMsme && msmePaymentDays ? Number(msmePaymentDays) : null,
      p_bank_name: bankName.trim() || null,
      p_bank_account_number: bankAccount.trim() || null,
      p_bank_ifsc: bankIfsc.trim() || null,
      p_is_tds_deductee: isTdsDeductee,
      p_default_tds_section: isTdsDeductee ? tdsSection || null : null,
      p_is_partner_remuneration: isPartnerRemuneration,
      p_is_related_party: isRelatedParty,
      p_relationship_type: isRelatedParty ? relationshipType || null : null,
      p_is_loan_or_deposit: isLoanOrDeposit,
      p_sec43b_category: sec43bCategory || null,
      p_party_type: partyType || null,
      p_credit_days: creditDays.trim() ? Number(creditDays) : null,
    });

    if (rpcError) {
      setError(friendlyLedgerError(rpcError, name.trim()));
      setBusy(false);
      return;
    }

    setBusy(false);
    router.push(`/${companyId}/ledgers`);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";
  const fieldLocked = field + " opacity-60 cursor-not-allowed";

  return (
    <div className="mt-8 max-w-xl">
      <section className="rounded-lg border border-border bg-surface p-5">
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input
              required
              disabled={nameLocked}
              value={nameLocked ? ledger.name : name}
              onChange={(e) => setName(e.target.value)}
              className={nameLocked ? fieldLocked : field}
            />
            {nameLocked && (
              <span className="text-xs text-warning">
                &ldquo;{ledger.name}&rdquo; is a system-managed ledger other
                features find by this exact name every time they post to
                it — renaming it here would not fail, it would silently
                create a second ledger by the old name the next time that
                feature runs, splitting the balance across both. Leave the
                name as it is.
              </span>
            )}
          </label>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
          {!isActive && (
            <span className="text-xs text-ink-faint">
              An inactive ledger stays in every past report but no longer
              offers itself in a new voucher&rsquo;s party/ledger picker.
            </span>
          )}

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
                That doesn&rsquo;t match the PAN format (5 letters, 4 digits, 1 letter).
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
                That doesn&rsquo;t match the TAN format (4 letters, 5 digits, 1 letter).
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

          <div className="rounded-md border border-border p-3">
            <span className="text-sm font-medium">
              Address &amp; contact{" "}
              <span className="font-normal text-ink-faint">optional</span>
            </span>
            <p className="mt-0.5 text-xs text-ink-faint">
              An e-invoice cannot be generated for this party without an
              address, city or PIN code on file.
            </p>
            <div className="mt-2 flex flex-col gap-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Address</span>
                <input value={address} onChange={(e) => setAddress(e.target.value)} className={field} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">Town / city</span>
                  <input value={city} onChange={(e) => setCity(e.target.value)} className={field} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">PIN code</span>
                  <input
                    value={pincode}
                    onChange={(e) => setPincode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                    inputMode="numeric"
                    maxLength={6}
                    className={field + " font-mono"}
                  />
                  {pincode.length > 0 && !pincodeLooksValid && (
                    <span className="text-xs text-warning">Six digits, and it cannot start with a zero.</span>
                  )}
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">Contact person</span>
                  <input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} className={field} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">Phone</span>
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} className={field} />
                </label>
              </div>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Email</span>
                <input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" className={field} />
                {email.length > 0 && !emailLooksValid && (
                  <span className="text-xs text-warning">That is not a usable address.</span>
                )}
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">
                  Credit days{" "}
                  <span className="text-ink-faint">
                    — blank means no agreed terms; the overdue reports fall back to 30 days
                  </span>
                </span>
                <input
                  inputMode="numeric"
                  value={creditDays}
                  onChange={(e) => setCreditDays(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
                  placeholder="30"
                  className={
                    field + " w-28 text-right tabular-nums" + (creditDaysLooksValid ? "" : " border-error focus-visible:border-error")
                  }
                />
                {!creditDaysLooksValid && (
                  <span className="text-xs text-warning">A whole number of days — leave it blank for no agreed terms.</span>
                )}
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Party type</span>
                <select value={partyType} onChange={(e) => setPartyType(e.target.value)} className={field}>
                  <option value="">Not set</option>
                  {Object.entries(PARTY_TYPE_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="rounded-md border border-border p-3">
            <span className="text-sm font-medium">
              Bank details <span className="font-normal text-ink-faint">optional</span>
            </span>
            <div className="mt-2 flex flex-col gap-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Account number</span>
                <input value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} className={field + " font-mono"} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">Bank name</span>
                  <input value={bankName} onChange={(e) => setBankName(e.target.value)} className={field} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">IFSC</span>
                  <input
                    value={bankIfsc}
                    onChange={(e) => setBankIfsc(e.target.value.toUpperCase())}
                    maxLength={11}
                    className={field + " font-mono uppercase"}
                  />
                </label>
              </div>
            </div>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Group</span>
            <select
              value={groupLocked ? ledger.group_id : groupId}
              disabled={groupLocked}
              onChange={(e) => setGroupId(e.target.value)}
              className={groupLocked ? fieldLocked : field}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.parent_group_id ? "  " : ""}
                  {g.name}
                </option>
              ))}
            </select>
            {groupLocked ? (
              <span className="text-xs text-warning">
                This ledger has real posted transactions — its account
                group can no longer be changed here, since moving it would
                retroactively reclassify every one of them across every
                statement. Create a new ledger under the correct group
                instead.
              </span>
            ) : (
              <span className="text-xs text-ink-faint">
                Missing the group you need?{" "}
                <Link href={`/${companyId}/account-groups`} className="underline">
                  Add one to the chart of accounts
                </Link>
                .
              </span>
            )}
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
          {hasPostings && (
            <span className="text-xs text-ink-faint">
              This ledger already has real postings — changing the opening
              balance is still allowed (the Opening Balance Equity
              mechanism keeps the books balanced automatically), but check
              you mean it.
            </span>
          )}

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
                  <span className="text-xs text-ink-faint">Default section</span>
                  <select value={tdsSection} onChange={(e) => setTdsSection(e.target.value)} className={field}>
                    <option value="">Not set</option>
                    {tdsSections.map((s) => (
                      <option key={s.section_code} value={s.section_code}>
                        {s.section_code} — {s.rate_percent}%
                      </option>
                    ))}
                  </select>
                </label>
              )}
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
                      <span className="text-xs text-warning">That doesn&rsquo;t match the Udyam number format.</span>
                    )}
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-ink-faint">Category</span>
                      <select value={msmeCategory} onChange={(e) => setMsmeCategory(e.target.value)} className={field}>
                        <option value="">Not set</option>
                        <option value="micro">Micro</option>
                        <option value="small">Small</option>
                        <option value="medium">Medium</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-ink-faint">Payment deadline (days)</span>
                      <input
                        inputMode="numeric"
                        value={msmePaymentDays}
                        onChange={(e) => setMsmePaymentDays(e.target.value)}
                        placeholder="15"
                        className={field}
                      />
                    </label>
                  </div>
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
              {isRelatedParty && (
                <label className="mt-2 flex flex-col gap-1.5">
                  <span className="text-sm font-medium">AS 18 relationship</span>
                  <select value={relationshipType} onChange={(e) => setRelationshipType(e.target.value)} className={field}>
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
                <input type="checkbox" checked={isLoanOrDeposit} onChange={(e) => setIsLoanOrDeposit(e.target.checked)} />
                Loan/deposit ledger (Sec 269SS/269T)
              </label>
            </div>
          )}

          {sec43bOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Sec 43B category</span>
                <select value={sec43bCategory} onChange={(e) => setSec43bCategory(e.target.value)} className={field}>
                  <option value="">Not applicable</option>
                  <option value="statutory_dues">Tax, duty, cess or fee</option>
                  <option value="employee_welfare_fund">PF/superannuation/gratuity fund</option>
                  <option value="bonus_commission">Bonus or commission</option>
                  <option value="specified_interest">Interest — bank/PFI/NBFC loan only</option>
                  <option value="leave_encashment">Leave encashment</option>
                </select>
              </label>
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
                    GSTIN <span className="font-normal text-ink-faint">{gstinRequired ? "required" : "optional"}</span>
                  </span>
                  <input
                    value={gstin}
                    onChange={(e) => {
                      const next = e.target.value.toUpperCase().slice(0, 15);
                      setGstin(next);
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
                      A GSTIN is 15 characters: 2-digit state, 10-character PAN, then 3 more.
                    </span>
                  ) : (
                    <span className="text-xs text-ink-faint">
                      Fills in state and PAN automatically. Without it a
                      registered party&rsquo;s invoices land in the B2C
                      tables of GSTR-1 instead of B2B, and an e-invoice
                      cannot be generated at all.
                    </span>
                  )}
                </label>
              )}
            </div>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Notes <span className="font-normal text-ink-faint">optional, internal only</span>
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className={field}
            />
          </label>

          {error && <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>}

          <div className="mt-1 flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save changes"}
            </button>
            <Link
              href={`/${companyId}/ledgers`}
              className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-ink-soft hover:bg-surface-2"
            >
              Cancel
            </Link>
          </div>
        </form>
      </section>
    </div>
  );
}
