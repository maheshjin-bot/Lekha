"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const field =
  "rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none";

type Factor = {
  id: string;
  friendly_name?: string;
  factor_type: string;
  status: string;
  created_at: string;
};

type Enrolling = {
  factorId: string;
  qrCode: string;
  secret: string;
};

export function MfaManager({ initialFactors }: { initialFactors: Factor[] }) {
  const router = useRouter();
  // Supplied by the server component, so there is no mount-time fetch and no
  // empty first render. After any change we just refresh the route and the
  // server sends a fresh list down.
  const factors = initialFactors;
  const [enrolling, setEnrolling] = useState<Enrolling | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onEnrol() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { data, error } = await createClient().auth.mfa.enroll({
      factorType: "totp",
      friendlyName: name.trim() || `Authenticator ${new Date().toISOString().slice(0, 10)}`,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setEnrolling({
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    });
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!enrolling) return;
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: enrolling.factorId,
    });
    if (challengeError) {
      setBusy(false);
      setError(challengeError.message);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: enrolling.factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    setBusy(false);

    if (verifyError) {
      // The commonest cause by far is clock drift on the phone, not a typo.
      setError(
        `${verifyError.message}. If the code looks right, check your phone's clock is set automatically — TOTP codes depend on it.`
      );
      return;
    }

    setEnrolling(null);
    setCode("");
    setName("");
    setNotice("Two-factor authentication is on. You will be asked for a code at each sign-in.");
    // The session is now aal2; the server guard needs to see that.
    router.refresh();
  }

  async function onCancelEnrol() {
    if (!enrolling) return;
    // An unverified factor left behind would sit in the list forever and,
    // worse, count towards nextLevel — locking the user out of an app they
    // never finished setting up.
    await createClient().auth.mfa.unenroll({ factorId: enrolling.factorId });
    setEnrolling(null);
    setCode("");
    setError(null);
  }

  async function onRemove(factor: Factor) {
    if (
      !confirm(
        `Remove ${factor.friendly_name || "this authenticator"}? Sign-in will stop asking for a code, which lowers the protection on this account.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.mfa.unenroll({ factorId: factor.id });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setNotice("Authenticator removed.");
    router.refresh();
  }

  const verified = factors.filter((f) => f.status === "verified");

  return (
    <div className="p-4">
      {error && (
        <p className="mb-3 rounded-md bg-error-soft px-3 py-2 text-sm text-ink">{error}</p>
      )}
      {notice && (
        <p className="mb-3 rounded-md bg-success-soft px-3 py-2 text-sm text-ink">{notice}</p>
      )}

      {verified.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {verified.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2"
            >
              <span className="text-sm">
                {f.friendly_name || "Authenticator"}
                <span className="ml-2 rounded bg-success-soft px-1.5 py-0.5 text-xs">Active</span>
                <span className="block text-xs text-ink-faint">
                  Added {f.created_at?.slice(0, 10)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => onRemove(f)}
                disabled={busy}
                className="text-xs text-ink-faint underline hover:text-error disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {verified.length === 0 && !enrolling && (
        <p className="mb-3 text-sm text-ink-soft">
          Two-factor authentication is off. A password alone is all that stands between anyone who
          has it and this company&rsquo;s PANs, TANs and salary records.
        </p>
      )}

      {!enrolling && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Name this device (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Work phone"
              className={field}
            />
          </label>
          <button
            type="button"
            onClick={onEnrol}
            disabled={busy}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Starting…" : verified.length > 0 ? "Add another" : "Turn on two-factor"}
          </button>
        </div>
      )}

      {enrolling && (
        <form onSubmit={onVerify} className="flex flex-col gap-3">
          <p className="text-sm text-ink-soft">
            Scan this with an authenticator app — Google Authenticator, Authy, 1Password, whichever
            you already use — then enter the six-digit code it shows.
          </p>
          {/* qr_code is raw SVG; the SDK documents prepending this data-URI prefix. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:image/svg+xml;utf-8,${enrolling.qrCode}`}
            alt="Two-factor setup QR code"
            className="h-44 w-44 rounded-md border border-border bg-white p-2"
          />
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">
              Can&rsquo;t scan? Enter this key into the app instead
            </span>
            <input readOnly value={enrolling.secret} className={field + " font-mono text-xs"} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Six-digit code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={field + " w-40 font-mono tracking-widest"}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Checking…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={onCancelEnrol}
              disabled={busy}
              className="text-sm text-ink-faint underline hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
