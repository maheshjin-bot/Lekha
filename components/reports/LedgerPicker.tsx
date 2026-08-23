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
        className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
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
