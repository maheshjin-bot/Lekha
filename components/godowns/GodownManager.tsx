"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Godown = {
  id: string;
  code: string;
  name: string;
  address: string | null;
  branch_id: string;
  is_default: boolean;
  is_active: boolean;
};

export function GodownManager({
  companyId,
  godowns,
  branches,
}: {
  companyId: string;
  godowns: Godown[];
  branches: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const branchName = (id: string) => {
    const b = branches.find((x) => x.id === id);
    return b ? `${b.code} — ${b.name}` : "—";
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient().from("godowns").insert({
      company_id: companyId,
      branch_id: branchId,
      code: code.trim().toUpperCase(),
      name: name.trim(),
      address: address.trim() || null,
      // Only one default per branch, enforced by a partial unique index — so
      // never set it here. The first godown gets it at company creation.
      is_default: false,
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    setCode("");
    setName("");
    setAddress("");
    setBusy(false);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_300px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Code</th>
                <th className="px-4 py-2.5 font-medium">Godown</th>
                <th className="px-4 py-2.5 font-medium">Branch</th>
                <th className="px-4 py-2.5 font-medium">Address</th>
              </tr>
            </thead>
            <tbody>
              {godowns.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-ink-faint">
                    No godowns yet.
                  </td>
                </tr>
              )}
              {godowns.map((g) => (
                <tr
                  key={g.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-2.5 font-mono text-xs">{g.code}</td>
                  <td className="px-4 py-2.5 font-medium">
                    {g.name}
                    {g.is_default && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-soft">
                        Default
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-ink-soft">
                    {branchName(g.branch_id)}
                  </td>
                  <td className="px-4 py-2.5 text-ink-soft">
                    {g.address ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New godown</h2>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Code <span className="font-normal text-ink-faint">up to 6, A–Z and 0–9</span>
            </span>
            <input
              required
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              maxLength={6}
              className={field + " font-mono"}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Address <span className="font-normal text-ink-faint">optional</span>
            </span>
            <textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} className={field} />
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
            {busy ? "Adding…" : "Add godown"}
          </button>
        </form>
      </section>
    </div>
  );
}
