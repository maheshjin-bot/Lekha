"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";

type Ledger = {
  id: string;
  name: string;
  group_id: string;
  opening_balance_amount: number;
  opening_balance_type: string;
  is_active: boolean;
};

type Group = {
  id: string;
  name: string;
  nature: string;
  ledger_role: string;
  parent_group_id: string | null;
};

export function LedgerManager({
  companyId,
  initialLedgers,
  groups,
}: {
  companyId: string;
  initialLedgers: Ledger[];
  groups: Group[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  // Sub-groups are where ledgers normally live; the eight primary groups are
  // structural. Default to the first sub-group so the common case is one click.
  const [groupId, setGroupId] = useState(
    groups.find((g) => g.parent_group_id)?.id ?? groups[0]?.id ?? ""
  );
  const [opening, setOpening] = useState("0");
  const [openingType, setOpeningType] = useState<"debit" | "credit">("debit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? "—";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient().from("ledgers").insert({
      company_id: companyId,
      group_id: groupId,
      name: name.trim(),
      opening_balance_amount: Number(opening) || 0,
      opening_balance_type: openingType,
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    setName("");
    setOpening("0");
    setBusy(false);
    router.refresh();
  }

  const field =
    "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="px-4 py-2.5 font-medium">Ledger</th>
                <th className="px-4 py-2.5 font-medium">Group</th>
                <th className="px-4 py-2.5 text-right font-medium">Opening</th>
              </tr>
            </thead>
            <tbody>
              {initialLedgers.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-zinc-500">
                    No ledgers yet. Create one on the right.
                  </td>
                </tr>
              )}
              {initialLedgers.map((l) => (
                <tr
                  key={l.id}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
                >
                  <td className="px-4 py-2.5 font-medium">{l.name}</td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                    {groupName(l.group_id)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {l.opening_balance_amount > 0 ? (
                      <>
                        {formatINR(l.opening_balance_amount)}
                        <span className="ml-1.5 text-[10px] uppercase text-zinc-500">
                          {l.opening_balance_type === "debit" ? "Dr" : "Cr"}
                        </span>
                      </>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="font-semibold">New ledger</h2>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Group</span>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className={field}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.parent_group_id ? "  " : ""}
                  {g.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Opening balance</span>
              <input
                inputMode="decimal"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                className={field + " text-right tabular-nums"}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Side</span>
              <select
                value={openingType}
                onChange={(e) => setOpeningType(e.target.value as "debit" | "credit")}
                className={field}
              >
                <option value="debit">Dr</option>
                <option value="credit">Cr</option>
              </select>
            </label>
          </div>

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
          >
            {busy ? "Adding…" : "Add ledger"}
          </button>
        </form>
      </section>
    </div>
  );
}
