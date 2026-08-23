"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function MfaChallengeForm({
  factorId,
  factorName,
  next,
}: {
  factorId: string;
  factorName: string;
  next: string;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId,
    });
    if (challengeError) {
      setBusy(false);
      setError(challengeError.message);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    setBusy(false);

    if (verifyError) {
      // Clock drift on the phone is a commoner cause than a typo, and it is
      // invisible unless someone says so.
      setError(
        `${verifyError.message}. If the code looks right, check your phone's clock is set automatically — TOTP codes depend on it.`
      );
      setCode("");
      return;
    }

    router.replace(next);
    router.refresh();
  }

  async function onSignOut() {
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Enter your code
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          Open {factorName} and enter the six-digit code it is showing.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Six-digit code</span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-lg tracking-widest focus:border-accent focus:outline-none"
          />
        </label>

        {error && <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-ink">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>

      <p className="mt-6 text-xs text-ink-faint">
        Lost the device with your authenticator on it? There is no self-service recovery here — an
        administrator of the Supabase project has to remove the factor from your account, after
        which you can sign in and set it up again.{" "}
        <button type="button" onClick={onSignOut} className="underline hover:text-ink">
          Sign out
        </button>
        .
      </p>
    </>
  );
}
