"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsPan = complianceMode === "compliance";
  const passwordMismatch =
    protect && password.length > 0 && confirmPassword.length > 0 && password !== confirmPassword;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (protect) {
      if (password.length < 4) {
        setError("Company password must be at least 4 characters.");
        return;
      }
      if (password !== confirmPassword) {
        setError("Company password and confirmation don't match.");
        return;
      }
    }

    setBusy(true);

    const { data: companyId, error: createError } = await createClient().rpc("create_company", {
      p_name: name.trim(),
      p_entity_type: entityType,
      p_book_beginning_date: beginning,
      p_state_code: stateCode,
      p_compliance_mode: complianceMode,
      p_pan: pan.trim().toUpperCase() || undefined,
      p_financial_year_start_month: fyMonth,
    });

    if (createError) {
      setError(createError.message);
      setBusy(false);
      return;
    }

    // The company exists at this point even if the password step below
    // fails — creation itself is not rolled back, so a failure here is
    // surfaced as a toast rather than blocking navigation into the company.
    if (protect && companyId) {
      const { error: passwordError } = await createClient().rpc("set_company_password", {
        p_company_id: companyId,
        p_password: password,
      });
      if (passwordError) {
        toast.error(
          `Company created, but the password couldn't be set: ${passwordError.message}. Set it again from Settings.`
        );
      }
    }

    router.push(`/${companyId}`);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
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
                  ? "border-accent bg-accent-soft"
                  : "border-border-strong hover:bg-surface-2")
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
              <span className="mt-0.5 block text-xs text-ink-soft">
                {hint}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {needsPan && (
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            PAN <span className="font-normal text-ink-faint">— required in compliance mode</span>
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

      <div className="rounded-md border border-border-strong p-3 sm:col-span-2">
        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={protect}
            onChange={(e) => setProtect(e.target.checked)}
            className="h-4 w-4 rounded border-border-strong accent-accent"
          />
          <span className="text-sm font-medium">Protect this company with a password</span>
        </label>
        <p className="mt-1 ml-6 text-xs text-ink-faint">
          Asked once per browser session before opening this company —
          separate from your sign-in. Admins can change or remove it later
          from Settings.
        </p>

        {protect && (
          <div className="mt-3 ml-6 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Password</span>
              <input
                type="password"
                required
                minLength={4}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={field}
              />
            </label>
            {passwordMismatch && (
              <span className="text-xs text-warning sm:col-span-2">
                Passwords don&rsquo;t match.
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error sm:col-span-2">
          {error}
        </p>
      )}

      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create company"}
        </button>
      </div>
    </form>
  );
}
