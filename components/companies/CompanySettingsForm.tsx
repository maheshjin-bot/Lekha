"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { UPI_VPA_PATTERN } from "@/lib/utils/upi";
import {
  CIN_PATTERN,
  CIN_STRUCTURE_HINT,
  IEC_PATTERN,
  PAN_PATTERN,
  TAN_PATTERN,
  UDYAM_PATTERN,
  panHolderTypeWarning,
} from "@/lib/companies/fieldPatterns";
import { friendlyCompanyError } from "@/lib/companies/friendlyError";

// Also the three entity types ref_entity_types.roc_forms lists AOC-4 against,
// and so the three the AOC-4 XBRL screen accepts — which is why the CIN field
// below is gated on the same set. An LLP has an LLPIN, not a CIN.
const COMPANY_ENTITY_TYPES = new Set(["opc", "pvt_ltd", "ltd"]);
// Sec 44AB's flat Rs 50 lakh "profession" threshold only makes sense for
// entity types a sole-practitioner or professional-partnership structure
// could plausibly be — a pvt_ltd/ltd/opc is always business turnover-based
// for this purpose, same gating rationale as 0032's own migration comment.
const PROFESSIONAL_TOGGLE_ENTITY_TYPES = new Set([
  "proprietorship",
  "partnership",
  "llp",
  "huf",
]);

export function CompanySettingsForm({
  companyId,
  entityType,
  pan,
  tan,
  cin,
  iec,
  registeredGstins,
  udyamNumber,
  udyamCategory,
  companyTaxRegime,
  isProfessional,
  stockMarginPercent,
  debtorMarginPercent,
  debtorEligibilityDays,
  passwordProtected,
  upiVpa,
}: {
  companyId: string;
  entityType: string;
  pan: string | null;
  tan: string | null;
  cin: string | null;
  iec: string | null;
  registeredGstins: string[];
  udyamNumber: string | null;
  udyamCategory: string | null;
  companyTaxRegime: string;
  isProfessional: boolean;
  stockMarginPercent: number;
  debtorMarginPercent: number;
  debtorEligibilityDays: number;
  passwordProtected: boolean;
  upiVpa: string | null;
}) {
  const router = useRouter();
  const [tanInput, setTanInput] = useState(tan ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // PAN is the one identifier on this screen whose change is not routine, so
  // it gets the same two-step reveal as removing the company password rather
  // than sitting in an always-editable box: it is embedded in every GSTIN the
  // company holds, and it is the identity the ITR, every TDS return and every
  // Form 16 are filed under. First-time entry needs no confirmation — there
  // is nothing to break yet — so the reveal only guards a *change*.
  const [editingPan, setEditingPan] = useState(false);
  const [panInput, setPanInput] = useState(pan ?? "");
  const [panBusy, setPanBusy] = useState(false);
  const [panError, setPanError] = useState<string | null>(null);
  const [panSaved, setPanSaved] = useState(false);

  const [cinInput, setCinInput] = useState(cin ?? "");
  const [cinBusy, setCinBusy] = useState(false);
  const [cinError, setCinError] = useState<string | null>(null);
  const [cinSaved, setCinSaved] = useState(false);

  const [iecInput, setIecInput] = useState(iec ?? "");
  const [iecBusy, setIecBusy] = useState(false);
  const [iecError, setIecError] = useState<string | null>(null);
  const [iecSaved, setIecSaved] = useState(false);

  const [udyamInput, setUdyamInput] = useState(udyamNumber ?? "");
  const [udyamCategoryInput, setUdyamCategoryInput] = useState(udyamCategory ?? "");
  const [udyamBusy, setUdyamBusy] = useState(false);
  const [udyamError, setUdyamError] = useState<string | null>(null);
  const [udyamSaved, setUdyamSaved] = useState(false);

  const [taxRegimeInput, setTaxRegimeInput] = useState(companyTaxRegime);
  const [taxRegimeBusy, setTaxRegimeBusy] = useState(false);
  const [taxRegimeError, setTaxRegimeError] = useState<string | null>(null);
  const [taxRegimeSaved, setTaxRegimeSaved] = useState(false);

  const [professionalInput, setProfessionalInput] = useState(isProfessional);
  const [professionalBusy, setProfessionalBusy] = useState(false);
  const [professionalError, setProfessionalError] = useState<string | null>(null);
  const [professionalSaved, setProfessionalSaved] = useState(false);

  const [stockMarginInput, setStockMarginInput] = useState(String(stockMarginPercent));
  const [debtorMarginInput, setDebtorMarginInput] = useState(String(debtorMarginPercent));
  const [debtorEligibilityInput, setDebtorEligibilityInput] = useState(String(debtorEligibilityDays));
  const [drawingPowerBusy, setDrawingPowerBusy] = useState(false);
  const [drawingPowerError, setDrawingPowerError] = useState<string | null>(null);
  const [drawingPowerSaved, setDrawingPowerSaved] = useState(false);

  const [upiVpaInput, setUpiVpaInput] = useState(upiVpa ?? "");
  const [upiVpaBusy, setUpiVpaBusy] = useState(false);
  const [upiVpaError, setUpiVpaError] = useState<string | null>(null);
  const [upiVpaSaved, setUpiVpaSaved] = useState(false);

  const [isProtected, setIsProtected] = useState(passwordProtected);
  // Two-step reveal for both setting/changing and removing — same pattern as
  // FixedAssetManager's disposal flow, not a confirm() and not a modal.
  const [changingPassword, setChangingPassword] = useState(false);
  const [removingPassword, setRemovingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);

  // Structural pre-checks only — the CHECK constraints on public.companies are
  // the real gate; these just catch an obvious typo before the round trip,
  // same pattern as the GSTIN check in RegistrationManager. Anything they miss
  // comes back through friendlyCompanyError rather than as a constraint name.
  const looksValid = tanInput.length === 0 || TAN_PATTERN.test(tanInput);
  const udyamLooksValid = udyamInput.length === 0 || UDYAM_PATTERN.test(udyamInput);
  const upiVpaLooksValid = upiVpaInput.length === 0 || UPI_VPA_PATTERN.test(upiVpaInput);
  const panLooksValid = panInput.length === 0 || PAN_PATTERN.test(panInput);
  const cinLooksValid = cinInput.length === 0 || CIN_PATTERN.test(cinInput);
  const iecLooksValid = iecInput.length === 0 || IEC_PATTERN.test(iecInput);
  const panTypeWarning = panHolderTypeWarning(entityType, panInput);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    const { error } = await createClient()
      .from("companies")
      .update({ tan: tanInput.trim() || null })
      .eq("id", companyId);

    setBusy(false);
    if (error) {
      setError(friendlyCompanyError(error));
      return;
    }
    setSaved(true);
    router.refresh();
  }

  function startEditPan() {
    setPanInput(pan ?? "");
    setEditingPan(true);
    setPanError(null);
    setPanSaved(false);
  }

  async function onPanSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPanBusy(true);
    setPanError(null);
    setPanSaved(false);

    const { error } = await createClient()
      .from("companies")
      // Not `|| null`: clearing a PAN is refused outright in compliance mode
      // by companies_compliance_requires_pan, and blanking it by accident on a
      // books-only company would quietly close its statutory modules. An empty
      // box means "I didn't mean to change this", so send nothing.
      .update({ pan: panInput.trim().toUpperCase() || null })
      .eq("id", companyId);

    setPanBusy(false);
    if (error) {
      setPanError(friendlyCompanyError(error));
      return;
    }
    setPanSaved(true);
    setEditingPan(false);
    router.refresh();
  }

  async function onCinSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCinBusy(true);
    setCinError(null);
    setCinSaved(false);

    const { error } = await createClient()
      .from("companies")
      .update({ cin: cinInput.trim() || null })
      .eq("id", companyId);

    setCinBusy(false);
    if (error) {
      setCinError(friendlyCompanyError(error));
      return;
    }
    setCinSaved(true);
    router.refresh();
  }

  async function onIecSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIecBusy(true);
    setIecError(null);
    setIecSaved(false);

    const { error } = await createClient()
      .from("companies")
      .update({ iec: iecInput.trim() || null })
      .eq("id", companyId);

    setIecBusy(false);
    if (error) {
      setIecError(friendlyCompanyError(error));
      return;
    }
    setIecSaved(true);
    router.refresh();
  }

  async function onUdyamSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUdyamBusy(true);
    setUdyamError(null);
    setUdyamSaved(false);

    const { error } = await createClient()
      .from("companies")
      .update({
        udyam_number: udyamInput.trim() || null,
        udyam_category: udyamInput.trim() ? udyamCategoryInput || null : null,
      })
      .eq("id", companyId);

    setUdyamBusy(false);
    if (error) {
      setUdyamError(friendlyCompanyError(error));
      return;
    }
    setUdyamSaved(true);
    router.refresh();
  }

  async function onTaxRegimeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTaxRegimeBusy(true);
    setTaxRegimeError(null);
    setTaxRegimeSaved(false);

    const { error } = await createClient()
      .from("companies")
      .update({ company_tax_regime: taxRegimeInput })
      .eq("id", companyId);

    setTaxRegimeBusy(false);
    if (error) {
      setTaxRegimeError(friendlyCompanyError(error));
      return;
    }
    setTaxRegimeSaved(true);
    router.refresh();
  }

  async function onProfessionalSubmit(e: React.FormEvent) {
    e.preventDefault();
    setProfessionalBusy(true);
    setProfessionalError(null);
    setProfessionalSaved(false);

    const { error } = await createClient()
      .from("companies")
      .update({ is_professional: professionalInput })
      .eq("id", companyId);

    setProfessionalBusy(false);
    if (error) {
      setProfessionalError(friendlyCompanyError(error));
      return;
    }
    setProfessionalSaved(true);
    router.refresh();
  }

  async function onDrawingPowerSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDrawingPowerBusy(true);
    setDrawingPowerError(null);
    setDrawingPowerSaved(false);

    const { error } = await createClient()
      .from("companies")
      .update({
        stock_margin_percent: Number(stockMarginInput),
        debtor_margin_percent: Number(debtorMarginInput),
        debtor_eligibility_days: Number(debtorEligibilityInput),
      })
      .eq("id", companyId);

    setDrawingPowerBusy(false);
    if (error) {
      setDrawingPowerError(friendlyCompanyError(error));
      return;
    }
    setDrawingPowerSaved(true);
    router.refresh();
  }

  async function onUpiVpaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUpiVpaBusy(true);
    setUpiVpaError(null);
    setUpiVpaSaved(false);

    const { error } = await createClient()
      .from("companies")
      .update({ upi_vpa: upiVpaInput.trim() || null })
      .eq("id", companyId);

    setUpiVpaBusy(false);
    if (error) {
      setUpiVpaError(friendlyCompanyError(error));
      return;
    }
    setUpiVpaSaved(true);
    router.refresh();
  }

  function startChangePassword() {
    setChangingPassword(true);
    setRemovingPassword(false);
    setNewPassword("");
    setConfirmNewPassword("");
    setPasswordError(null);
    setPasswordSaved(false);
  }

  async function onPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSaved(false);

    if (newPassword.length < 4) {
      setPasswordError("Password must be at least 4 characters.");
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError("Password and confirmation don't match.");
      return;
    }

    setPasswordBusy(true);
    const { error } = await createClient().rpc("set_company_password", {
      p_company_id: companyId,
      p_password: newPassword,
    });
    setPasswordBusy(false);

    if (error) {
      setPasswordError(error.message);
      return;
    }
    setIsProtected(true);
    setChangingPassword(false);
    setNewPassword("");
    setConfirmNewPassword("");
    setPasswordSaved(true);
    router.refresh();
  }

  async function onRemovePassword() {
    setPasswordError(null);
    setPasswordBusy(true);
    // An empty string clears protection, same as null — see set_company_password.
    const { error } = await createClient().rpc("set_company_password", {
      p_company_id: companyId,
      p_password: "",
    });
    setPasswordBusy(false);

    if (error) {
      setPasswordError(error.message);
      return;
    }
    setIsProtected(false);
    setRemovingPassword(false);
    setPasswordSaved(true);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Identifiers</h2>
        <p className="mt-1 text-sm text-ink-soft">
          The income tax numbers this company files under. GST registrations
          are separate and live under Registrations, because one PAN can hold
          a GSTIN in every state it operates in.
        </p>

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            PAN{" "}
            <span className="font-normal text-ink-faint">
              the identity the ITR, every TDS return and every Form 16 are filed under
            </span>
          </span>

          {!editingPan ? (
            <div className="flex items-center justify-between gap-3">
              <p className="flex-1 rounded-md bg-bg px-3 py-2 font-mono text-sm text-ink-soft">
                {pan ?? "Not set"}
              </p>
              <button
                type="button"
                onClick={startEditPan}
                className="shrink-0 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                {pan ? "Change PAN" : "Set PAN"}
              </button>
            </div>
          ) : (
            <form onSubmit={onPanSubmit} className="flex flex-col gap-1.5">
              {pan && (
                <div className="mb-1 flex flex-col gap-1.5 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                  <p>
                    Changing a PAN is not routine. Correct a mistyped one by all
                    means — but a different PAN is a different legal entity, and
                    moving books between entities means a new company here, not
                    a new number on this one.
                  </p>
                  {registeredGstins.length > 0 && (
                    <p>
                      This company already holds{" "}
                      {registeredGstins.length === 1
                        ? "the GST registration"
                        : `${registeredGstins.length} GST registrations`}{" "}
                      <span className="font-mono">{registeredGstins.join(", ")}</span>. A
                      GSTIN has its holder&rsquo;s PAN embedded in characters 3
                      to 12, so LEKHA will refuse a PAN that contradicts{" "}
                      {registeredGstins.length === 1 ? "it" : "them"} — correct
                      or remove the registration first.
                    </p>
                  )}
                </div>
              )}

              <input
                value={panInput}
                onChange={(e) => setPanInput(e.target.value.toUpperCase())}
                maxLength={10}
                autoFocus
                placeholder="AAAAA9999A"
                className={field + " font-mono uppercase"}
              />
              {panInput.length > 0 && !panLooksValid && (
                <span className="text-xs text-warning">
                  That doesn&rsquo;t match the PAN format (5 letters, 4 digits, 1
                  letter).
                </span>
              )}
              {panTypeWarning && (
                <span className="text-xs text-ink-faint">{panTypeWarning}</span>
              )}

              {panError && (
                <p className="mt-2 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
                  {panError}
                </p>
              )}

              <div className="mt-3 flex gap-2">
                <button
                  type="submit"
                  disabled={panBusy}
                  className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {panBusy ? "Saving…" : "Save PAN"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingPan(false)}
                  className="self-start rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-2"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {panSaved && !editingPan && !panError && (
            <p className="mt-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success">
              PAN saved.
            </p>
          )}
        </div>

        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              TAN{" "}
              <span className="font-normal text-ink-faint">
                required for TDS — this is what turns the module on
              </span>
            </span>
            <input
              value={tanInput}
              onChange={(e) => setTanInput(e.target.value.toUpperCase())}
              maxLength={10}
              placeholder="ABCD12345E"
              className={field + " font-mono uppercase"}
            />
          </label>
          {tanInput.length > 0 && !looksValid && (
            <span className="text-xs text-warning">
              That doesn&rsquo;t match the TAN format (4 letters, 5 digits, 1
              letter).
            </span>
          )}

          {error && (
            <p className="mt-2 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}
          {saved && !error && (
            <p className="mt-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success">
              Saved.
              {tanInput ? " TDS is now on for this company." : ""}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-3 self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      </section>

      {COMPANY_ENTITY_TYPES.has(entityType) && (
        <section className="rounded-lg border border-border bg-surface p-5">
          <h2 className="font-semibold">Corporate Identity Number (CIN)</h2>
          <p className="mt-1 text-sm text-ink-soft">
            The 21-character number the Registrar of Companies allotted on
            incorporation — printed on the certificate of incorporation and on
            every MCA challan. LEKHA uses it as the entity identifier inside
            the AOC-4 XBRL instance documents, which is why neither the Balance
            Sheet nor the Profit &amp; Loss instance can be generated until it
            is on file.
          </p>
          <form onSubmit={onCinSubmit} className="mt-4 flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">CIN</span>
              <input
                value={cinInput}
                onChange={(e) => setCinInput(e.target.value.toUpperCase())}
                maxLength={21}
                placeholder="U72900MH2019PTC330045"
                className={field + " font-mono uppercase"}
              />
            </label>
            {cinInput.length > 0 && !cinLooksValid && (
              <span className="text-xs text-warning">
                That doesn&rsquo;t match the CIN format. {CIN_STRUCTURE_HINT}
              </span>
            )}

            {cinError && (
              <p className="mt-2 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
                {cinError}
              </p>
            )}
            {cinSaved && !cinError && (
              <p className="mt-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success">
                Saved.
                {cinInput ? " AOC-4 XBRL can now be generated for this company." : ""}
              </p>
            )}

            <button
              type="submit"
              disabled={cinBusy}
              className="mt-3 self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {cinBusy ? "Saving…" : "Save"}
            </button>
          </form>
          <p className="mt-3 text-xs text-ink-faint">
            Only a company has a CIN. An LLP&rsquo;s LLPIN, a partnership
            firm&rsquo;s registration number and a society&rsquo;s registration
            number are different identifiers and do not belong in this box —
            which is why it only appears for a Private Limited, Public Limited
            or One Person Company.
          </p>
        </section>
      )}

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Importer-Exporter Code (IEC)</h2>
        <p className="mt-1 text-sm text-ink-soft">
          DGFT&rsquo;s code, needed by anyone importing or exporting. Entering
          it is what switches on the Foreign currency and Export/import
          modules: both are conditional, so the Modules screen deliberately
          won&rsquo;t let you flip them by hand — they follow this number
          instead. Books stay in rupees either way; foreign currency is a
          property of a transaction, never of the ledger.
        </p>
        <form onSubmit={onIecSubmit} className="mt-4 flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">IEC</span>
            <input
              value={iecInput}
              onChange={(e) => setIecInput(e.target.value.toUpperCase())}
              maxLength={10}
              placeholder="AAAAA9999A"
              className={field + " font-mono uppercase"}
            />
          </label>
          {iecInput.length > 0 && !iecLooksValid && (
            <span className="text-xs text-warning">
              That doesn&rsquo;t match the IEC format. Since 2017 DGFT issues an
              IEC identical to the holder&rsquo;s PAN, so it has the same shape
              (5 letters, 4 digits, 1 letter).
            </span>
          )}
          {pan && iecInput.trim() !== pan && (
            <button
              type="button"
              onClick={() => setIecInput(pan)}
              className="self-start text-xs font-semibold text-accent underline underline-offset-2"
            >
              Use this company&rsquo;s PAN ({pan})
            </button>
          )}

          {iecError && (
            <p className="mt-2 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {iecError}
            </p>
          )}
          {iecSaved && !iecError && (
            <p className="mt-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success">
              {iecInput
                ? "Saved. Foreign currency and Export/import are now active — see Modules."
                : "Saved. Foreign currency and Export/import are switched off from today; the period they were active for stays on record."}
            </p>
          )}

          <button
            type="submit"
            disabled={iecBusy}
            className="mt-3 self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {iecBusy ? "Saving…" : "Save"}
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Company password</h2>
        <p className="mt-1 text-sm text-ink-soft">
          A Tally-style open-company gate — separate from your own sign-in.
          When set, opening this company asks for it once per browser
          session, whoever is signed in.
        </p>

        <div className="mt-4 flex items-center justify-between gap-4">
          <span
            className={
              "rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide " +
              (isProtected ? "bg-success-soft text-success" : "bg-surface-2 text-ink-soft")
            }
          >
            {isProtected ? "Protected" : "Not protected"}
          </span>

          {!changingPassword && !removingPassword && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={startChangePassword}
                className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                {isProtected ? "Change password" : "Set password"}
              </button>
              {isProtected && (
                <button
                  type="button"
                  onClick={() => setRemovingPassword(true)}
                  className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2"
                >
                  Remove
                </button>
              )}
            </div>
          )}
        </div>

        {removingPassword && (
          <div className="mt-4 flex items-center justify-between gap-4 rounded-md bg-warning-soft px-3 py-2">
            <span className="text-sm text-warning">
              Remove the password? Anyone with access to this company will be
              able to open it without one.
            </span>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={onRemovePassword}
                disabled={passwordBusy}
                className="rounded-lg bg-error px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {passwordBusy ? "Removing…" : "Confirm removal"}
              </button>
              <button
                type="button"
                onClick={() => setRemovingPassword(false)}
                className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-2"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {changingPassword && (
          <form onSubmit={onPasswordSubmit} className="mt-4 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">New password</span>
                <input
                  type="password"
                  required
                  minLength={4}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={field}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Confirm password</span>
                <input
                  type="password"
                  required
                  minLength={4}
                  autoComplete="new-password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  className={field}
                />
              </label>
            </div>

            {passwordError && (
              <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
                {passwordError}
              </p>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={passwordBusy}
                className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {passwordBusy ? "Saving…" : "Save password"}
              </button>
              <button
                type="button"
                onClick={() => setChangingPassword(false)}
                className="self-start rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-2"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {passwordSaved && !changingPassword && !removingPassword && !passwordError && (
          <p className="mt-3 rounded-md bg-success-soft px-3 py-2 text-sm text-success">
            Saved.
          </p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Udyam (MSME) registration</h2>
        <p className="mt-1 text-sm text-ink-soft">
          This company&rsquo;s own registration — separate from flagging which
          of your suppliers are MSMEs, which is set per-ledger.
        </p>
        <form onSubmit={onUdyamSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Udyam number</span>
            <input
              value={udyamInput}
              onChange={(e) => setUdyamInput(e.target.value.toUpperCase())}
              placeholder="UDYAM-XX-00-0000000"
              className={field + " font-mono uppercase"}
            />
          </label>
          {udyamInput.length > 0 && !udyamLooksValid && (
            <span className="text-xs text-warning">
              That doesn&rsquo;t match the Udyam number format.
            </span>
          )}

          {udyamInput && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Category</span>
              <select
                value={udyamCategoryInput}
                onChange={(e) => setUdyamCategoryInput(e.target.value)}
                className={field}
              >
                <option value="">Not set</option>
                <option value="micro">Micro</option>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
              </select>
            </label>
          )}

          {udyamError && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {udyamError}
            </p>
          )}
          {udyamSaved && !udyamError && (
            <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
              Saved.
            </p>
          )}

          <button
            type="submit"
            disabled={udyamBusy}
            className="mt-1 self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {udyamBusy ? "Saving…" : "Save"}
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">UPI payment QR</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Your own UPI ID (e.g. yourname@okhdfcbank). When set, a scannable
          payment QR appears on the printed copy of any unpaid sales
          invoice, pre-filled with the amount still outstanding on that
          invoice — no payment gateway involved, this is the same static
          upi://pay link any UPI app already understands.
        </p>
        <form onSubmit={onUpiVpaSubmit} className="mt-4 flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">UPI VPA</span>
            <input
              value={upiVpaInput}
              onChange={(e) => setUpiVpaInput(e.target.value.trim())}
              placeholder="yourname@okhdfcbank"
              className={field + " font-mono"}
            />
          </label>
          {upiVpaInput.length > 0 && !upiVpaLooksValid && (
            <span className="text-xs text-warning">
              That doesn&rsquo;t look like a UPI ID (expected something like
              name@bank).
            </span>
          )}

          {upiVpaError && (
            <p className="mt-2 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {upiVpaError}
            </p>
          )}
          {upiVpaSaved && !upiVpaError && (
            <p className="mt-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success">
              Saved.
            </p>
          )}

          <button
            type="submit"
            disabled={upiVpaBusy}
            className="mt-3 self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {upiVpaBusy ? "Saving…" : "Save"}
          </button>
        </form>
      </section>

      {COMPANY_ENTITY_TYPES.has(entityType) && (
        <section className="rounded-lg border border-border bg-surface p-5">
          <h2 className="font-semibold">Income tax regime</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Only relevant for companies — LEKHA cannot determine which rate
            applies to you; the default is the higher, safer rate.
          </p>
          <form onSubmit={onTaxRegimeSubmit} className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Regime</span>
              <select
                value={taxRegimeInput}
                onChange={(e) => setTaxRegimeInput(e.target.value)}
                className={field}
              >
                <option value="default_30">
                  Default (30%) — no concessional election
                </option>
                <option value="default_25">
                  Default (25%) — confirmed FY 2023-24 turnover ≤ ₹400 crore
                </option>
                <option value="115baa">
                  Sec 115BAA (22%) — irrevocable election, Form 10-IC
                </option>
                <option value="115bab">
                  Sec 115BAB (15%) — new manufacturing company, irrevocable,
                  Form 10-ID
                </option>
              </select>
            </label>

            {taxRegimeError && (
              <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
                {taxRegimeError}
              </p>
            )}
            {taxRegimeSaved && !taxRegimeError && (
              <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
                Saved.
              </p>
            )}

            <button
              type="submit"
              disabled={taxRegimeBusy}
              className="mt-1 self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {taxRegimeBusy ? "Saving…" : "Save"}
            </button>
          </form>
        </section>
      )}

      {PROFESSIONAL_TOGGLE_ENTITY_TYPES.has(entityType) && (
        <section className="rounded-lg border border-border bg-surface p-5">
          <h2 className="font-semibold">Tax audit — business or profession</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Decides which Sec 44AB turnover threshold applies on the Tax
            audit report: a flat ₹50 lakh for a specified profession (legal,
            medical, engineering, architectural, accountancy, technical
            consultancy, company secretary, IT and similar), or the
            turnover-based ₹1 crore/₹10 crore business threshold otherwise.
            LEKHA cannot infer this from your ledgers — most businesses
            should leave this off.
          </p>
          <form onSubmit={onProfessionalSubmit} className="mt-4 flex flex-col gap-3">
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={professionalInput}
                onChange={(e) => setProfessionalInput(e.target.checked)}
                className="h-4 w-4 rounded border-border-strong accent-accent"
              />
              <span className="text-sm font-medium">
                This company&rsquo;s income is from a specified profession
              </span>
            </label>

            {professionalError && (
              <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
                {professionalError}
              </p>
            )}
            {professionalSaved && !professionalError && (
              <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
                Saved.
              </p>
            )}

            <button
              type="submit"
              disabled={professionalBusy}
              className="mt-1 self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {professionalBusy ? "Saving…" : "Save"}
            </button>
          </form>
        </section>
      )}

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Bank facility (stock statement)</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Feeds the Stock statement report&rsquo;s drawing power calculation.
          Defaults to typical figures — confirm both margins and the debtor
          eligibility window against your own CC/OD sanction letter, since
          LEKHA cannot know what your bank actually agreed to.
        </p>
        <form onSubmit={onDrawingPowerSubmit} className="mt-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Stock margin %</span>
              <input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={stockMarginInput}
                onChange={(e) => setStockMarginInput(e.target.value)}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Debtor margin %</span>
              <input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={debtorMarginInput}
                onChange={(e) => setDebtorMarginInput(e.target.value)}
                className={field}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Debtor eligibility window{" "}
              <span className="font-normal text-ink-faint">
                debtors older than this are excluded from drawing power entirely
              </span>
            </span>
            <select
              value={debtorEligibilityInput}
              onChange={(e) => setDebtorEligibilityInput(e.target.value)}
              className={field}
            >
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
            </select>
          </label>

          {drawingPowerError && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {drawingPowerError}
            </p>
          )}
          {drawingPowerSaved && !drawingPowerError && (
            <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
              Saved.
            </p>
          )}

          <button
            type="submit"
            disabled={drawingPowerBusy}
            className="mt-1 self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {drawingPowerBusy ? "Saving…" : "Save"}
          </button>
        </form>
      </section>
    </div>
  );
}
