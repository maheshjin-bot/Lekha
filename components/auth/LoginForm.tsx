"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * The interactive half of the sign-in screen. Split out of app/(auth)/login/
 * page.tsx (which now reads and sanitises `?next=` server-side, the same
 * split /verify already uses for MfaChallengeForm) so this stays a plain
 * client form that just does what it's told: sign in or up, then go to
 * `next`. Previously this pushed a hardcoded "/companies" no matter what —
 * meaning AppLayout's own `?next=` (stamped for every unauthenticated
 * redirect, /verify included) was silently dropped on the one page that
 * exists specifically to send people back where they were headed. That
 * broke the invite-accept flow in exactly the case it matters most: a new
 * colleague with no account yet, who has to pass through sign-up here
 * before /invite/[token] can ever run.
 */
export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const supabase = createClient();
    const { data, error } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    // Sign-up with email confirmation on returns a user but no session.
    if (!data.session) {
      setNotice("Check your email to confirm the address, then sign in.");
      setBusy(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  return (
    <>
      <div className="mb-10">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">LEKHA</h1>
        <p className="mt-2 text-sm text-ink-soft">
          Accounting and statutory compliance for Indian businesses.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Password</span>
          <input
            type="password"
            required
            minLength={6}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
          />
        </label>

        {error && (
          <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
            {notice}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
          setNotice(null);
        }}
        className="mt-6 text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
      >
        {mode === "signin"
          ? "No account yet? Create one"
          : "Already have an account? Sign in"}
      </button>
    </>
  );
}
