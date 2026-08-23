"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
// Mirrors app_private.is_valid_udyam exactly.
const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;

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
  udyamNumber,
  udyamCategory,
  companyTaxRegime,
  isProfessional,
  stockMarginPercent,
  debtorMarginPercent,
  debtorEligibilityDays,
  passwordProtected,
}: {
  companyId: string;
  entityType: string;
  pan: string | null;
  tan: string | null;
  udyamNumber: string | null;
  udyamCategory: string | null;
  companyTaxRegime: string;
  isProfessional: boolean;
  stockMarginPercent: number;
  debtorMarginPercent: number;
  debtorEligibilityDays: number;
  passwordProtected: boolean;
}) {
  const router = useRouter();
  const [tanInput, setTanInput] = useState(tan ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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

  // Structural pre-check only — app_private.is_valid_tan on the companies.tan
  // check constraint is the real gate; this just catches an obvious typo
  // before the round trip, same pattern as the GSTIN check in
  // RegistrationManager.
  const looksValid = tanInput.length === 0 || TAN_PATTERN.test(tanInput);
  const udyamLooksValid = udyamInput.length === 0 || UDYAM_PATTERN.test(udyamInput);

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
      setError(error.message);
      return;
    }
    setSaved(true);
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
      setUdyamError(error.message);
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
      setTaxRegimeError(error.message);
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
      setProfessionalError(error.message);
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
      setDrawingPowerError(error.message);
      return;
    }
    setDrawingPowerSaved(true);
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

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-sm font-medium">PAN</span>
          <p className="rounded-md bg-bg px-3 py-2 font-mono text-sm text-ink-soft">
            {pan ?? "Not set"}
          </p>
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
