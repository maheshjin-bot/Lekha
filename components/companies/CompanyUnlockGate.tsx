"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";

/**
 * Rendered by app/(app)/[companyId]/layout.tsx in place of the nav rail and
 * page content whenever a company has a password set and this browser
 * hasn't unlocked it yet (no co_unlock_<id> cookie) — so the protected data
 * never reaches the client at all, not just visually hidden behind this.
 */
export function CompanyUnlockGate({
  companyId,
  companyName,
}: {
  companyId: string;
  companyName: string;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/companies/${companyId}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = await res.json().catch(() => null);

    if (!res.ok || !body?.ok) {
      setError(body?.error ?? "Incorrect password");
      setBusy(false);
      return;
    }

    // The unlock cookie is now set — re-run the layout's server check.
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="mb-10 flex flex-col items-center text-center">
        <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Lock size={18} />
        </span>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          {companyName}
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          This company is password protected. Enter its password to open it.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Company password</span>
          <input
            type="password"
            required
            autoComplete="off"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>

      <Link
        href="/companies"
        className="mt-6 text-center text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
      >
        Back to companies
      </Link>
    </main>
  );
}
