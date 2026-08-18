"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

export function CompanySettingsForm({
  companyId,
  pan,
  tan,
}: {
  companyId: string;
  pan: string | null;
  tan: string | null;
}) {
  const router = useRouter();
  const [tanInput, setTanInput] = useState(tan ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Structural pre-check only — app_private.is_valid_tan on the companies.tan
  // check constraint is the real gate; this just catches an obvious typo
  // before the round trip, same pattern as the GSTIN check in
  // RegistrationManager.
  const looksValid = tanInput.length === 0 || TAN_PATTERN.test(tanInput);

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
    </div>
  );
}
