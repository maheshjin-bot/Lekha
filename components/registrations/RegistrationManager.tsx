"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Registration = {
  id: string;
  gstin: string;
  state_code: string;
  registration_type: string;
  filing_frequency: string;
  registered_from: string;
  is_active: boolean;
};

type Branch = {
  id: string;
  code: string;
  name: string;
  state_code: string;
  gst_registration_id: string | null;
};

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function RegistrationManager({
  companyId,
  registrations,
  branches,
  states,
}: {
  companyId: string;
  registrations: Registration[];
  branches: Branch[];
  states: { code: string; name: string }[];
}) {
  const router = useRouter();
  const stateName = (code: string) => states.find((s) => s.code === code)?.name ?? code;
  const [gstin, setGstin] = useState("");
  const [registeredFrom, setRegisteredFrom] = useState(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  const [branchId, setBranchId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Structural validity only — a well-formed but wrong GSTIN still reaches
  // the server, where the real checksum in app_private.is_valid_gstin decides.
  // This just saves a round trip on an obvious typo.
  const looksValid = GSTIN_PATTERN.test(gstin);

  // The state is literally the GSTIN's first two characters — no checksum
  // needed to read it — which is what lets the branch list narrow itself as
  // soon as the prefix is typed, before the rest of the number is even valid.
  const gstinState = gstin.length >= 2 ? gstin.slice(0, 2) : null;
  const eligibleBranches = branches.filter(
    (b) => !b.gst_registration_id && (gstinState === null || b.state_code === gstinState)
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient().rpc("add_gst_registration", {
      p_company_id: companyId,
      p_gstin: gstin,
      p_registered_from: registeredFrom,
      p_branch_id: branchId || undefined,
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    setGstin("");
    setBranchId("");
    setBusy(false);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_340px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">GSTIN</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Branch</th>
              </tr>
            </thead>
            <tbody>
              {registrations.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-ink-faint">
                    No registrations yet. GST stays off until one is added.
                  </td>
                </tr>
              )}
              {registrations.map((r) => {
                const attached = branches.find((b) => b.gst_registration_id === r.id);
                return (
                  <tr
                    key={r.id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-2.5 font-mono text-xs">{r.gstin}</td>
                    <td className="px-4 py-2.5">{stateName(r.state_code)}</td>
                    <td className="px-4 py-2.5 capitalize text-ink-soft">
                      {r.registration_type}
                    </td>
                    <td className="px-4 py-2.5">
                      {attached ? (
                        `${attached.code} — ${attached.name}`
                      ) : (
                        <span className="text-warning">
                          Not attached — cannot invoice yet
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New registration</h2>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">GSTIN</span>
            <input
              required
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              maxLength={15}
              placeholder="27AAPFU0939F1ZV"
              className={field + " font-mono"}
            />
            {gstin.length === 15 && !looksValid && (
              <span className="text-xs text-warning">
                That doesn&rsquo;t match the GSTIN format.
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Registered from</span>
            <input
              type="date"
              required
              value={registeredFrom}
              onChange={(e) => setRegisteredFrom(e.target.value)}
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Attach to branch <span className="font-normal text-ink-faint">optional now, required to invoice</span>
            </span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field}>
              <option value="">Not yet</option>
              {eligibleBranches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name} ({stateName(b.state_code)})
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-faint">
              {gstinState
                ? "Only unattached branches in this GSTIN's own state are listed — a branch elsewhere is refused by the database too."
                : "Start typing the GSTIN to narrow this to branches in its state."}
            </span>
          </label>

          {error && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add registration"}
          </button>
        </form>
      </section>
    </div>
  );
}
