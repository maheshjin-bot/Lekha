"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
// Mirrors app_private.is_valid_udyam exactly.
const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;

export function CompanySettingsForm({
  companyId,
  pan,
  tan,
  udyamNumber,
  udyamCategory,
}: {
  companyId: string;
  pan: string | null;
  tan: string | null;
  udyamNumber: string | null;
  udyamCategory: string | null;
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

  const field =
    "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="font-semibold">Identifiers</h2>

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-sm font-medium">PAN</span>
          <p className="rounded-md bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {pan ?? "Not set"}
          </p>
        </div>

        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              TAN{" "}
              <span className="font-normal text-zinc-500">
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
            <span className="text-xs text-amber-800 dark:text-amber-300">
              That doesn&rsquo;t match the TAN format (4 letters, 5 digits, 1
              letter).
            </span>
          )}

          {error && (
            <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}
          {saved && !error && (
            <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              Saved.
              {tanInput ? " TDS is now on for this company." : ""}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-3 self-start rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="font-semibold">Udyam (MSME) registration</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
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
            <span className="text-xs text-amber-800 dark:text-amber-300">
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
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
              {udyamError}
            </p>
          )}
          {udyamSaved && !udyamError && (
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              Saved.
            </p>
          )}

          <button
            type="submit"
            disabled={udyamBusy}
            className="mt-1 self-start rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
          >
            {udyamBusy ? "Saving…" : "Save"}
          </button>
        </form>
      </section>
    </div>
  );
}
