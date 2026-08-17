"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function CreateCompanyForm({
  entityTypes,
  states,
}: {
  entityTypes: { code: string; name: string }[];
  states: { code: string; name: string }[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState("proprietorship");
  const [stateCode, setStateCode] = useState("27");
  const [complianceMode, setComplianceMode] = useState<"books_only" | "compliance">(
    "books_only"
  );
  const [pan, setPan] = useState("");
  const [fyMonth, setFyMonth] = useState(4);
  const [beginning, setBeginning] = useState(() => {
    const now = new Date();
    const year = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    return `${year}-04-01`;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsPan = complianceMode === "compliance";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { data, error } = await createClient().rpc("create_company", {
      p_name: name.trim(),
      p_entity_type: entityType,
      p_book_beginning_date: beginning,
      p_state_code: stateCode,
      p_compliance_mode: complianceMode,
      p_pan: pan.trim().toUpperCase() || undefined,
      p_financial_year_start_month: fyMonth,
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    router.push(`/${data}`);
    router.refresh();
  }

  const field =
    "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold">New company</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Creating a company seeds its chart of accounts and a Head Office branch,
        then resolves which modules apply. Nothing to configure afterwards.
      </p>

      <form onSubmit={onSubmit} className="mt-6 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-medium">Company name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Entity type</span>
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className={field}
          >
            {entityTypes.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Head office state</span>
          <select
            value={stateCode}
            onChange={(e) => setStateCode(e.target.value)}
            className={field}
          >
            {states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
          <legend className="mb-1.5 text-sm font-medium">Mode</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ["books_only", "Books only", "Vouchers, ledgers and the five financial reports."],
                ["compliance", "Books + compliance", "Adds GST, TDS, income tax and audit, per your registrations."],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={
                  "cursor-pointer rounded-md border p-3 text-sm transition " +
                  (complianceMode === value
                    ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40"
                    : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/60")
                }
              >
                <input
                  type="radio"
                  name="mode"
                  value={value}
                  checked={complianceMode === value}
                  onChange={() => setComplianceMode(value)}
                  className="sr-only"
                />
                <span className="block font-medium">{label}</span>
                <span className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-400">
                  {hint}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {needsPan && (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              PAN <span className="font-normal text-zinc-500">— required in compliance mode</span>
            </span>
            <input
              required
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              placeholder="AAAAA0000A"
              maxLength={10}
              className={field + " font-mono"}
            />
          </label>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Financial year starts</span>
          <select
            value={fyMonth}
            onChange={(e) => setFyMonth(Number(e.target.value))}
            className={field}
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Books begin</span>
          <input
            type="date"
            required
            value={beginning}
            onChange={(e) => setBeginning(e.target.value)}
            className={field}
          />
        </label>

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 sm:col-span-2 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
          >
            {busy ? "Creating…" : "Create company"}
          </button>
        </div>
      </form>
    </section>
  );
}
