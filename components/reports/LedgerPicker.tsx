"use client";

import { useRouter } from "next/navigation";

export function LedgerPicker({
  companyId,
  ledgers,
  selected,
}: {
  companyId: string;
  ledgers: { id: string; name: string }[];
  selected: string | null;
}) {
  const router = useRouter();

  if (ledgers.length === 0) return null;

  return (
    <label className="flex flex-wrap items-center gap-3">
      <span className="text-sm font-medium">Ledger</span>
      <select
        value={selected ?? ""}
        onChange={(e) =>
          router.push(
            `/${companyId}/reports/ledger-statement?ledger=${encodeURIComponent(e.target.value)}`
          )
        }
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:border-zinc-700 dark:bg-zinc-900"
      >
        {ledgers.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
