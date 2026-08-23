"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatINR } from "@/lib/utils/currency";
import { PERIOD_PRESETS, periodPreset, type PeriodPresetKey } from "@/lib/utils/period";
import { editHrefFor } from "@/lib/utils/voucher";
import { th, td, num } from "@/components/ui/Table";
import { Input, Select } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { DeleteVoucherButton } from "@/components/vouchers/DeleteVoucherButton";

const TYPE_LABEL: Record<string, string> = {
  receipt: "Receipt",
  payment: "Payment",
  contra: "Contra",
  journal: "Journal",
  sales: "Sales",
  purchase: "Purchase",
  credit_note: "Credit note",
  debit_note: "Debit note",
  branch_transfer: "Branch transfer",
  stock_journal: "Stock journal",
};

type Row = {
  voucher_id: string;
  voucher_date: string;
  voucher_type: string;
  voucher_number: string;
  narration: string | null;
  party_name: string | null;
  total_amount: number;
};

/**
 * Every voucher in the period, filterable by party/type/amount client-side
 * (get_daybook already returns both on every row, so no round trip is
 * needed) and by date range via presets or the two date inputs, both of
 * which navigate — the range itself decides what get_daybook fetches
 * server-side. Print/CSV/JPG (from ReportShell, wrapping this) export
 * exactly whatever's filtered, since they read the table that's actually on
 * screen.
 */
export function DaybookTable({
  companyId,
  rows,
  from,
  to,
  financialYearStartMonth,
  lockedTypes,
  basePath,
}: {
  companyId: string;
  rows: Row[];
  from: string;
  to: string;
  financialYearStartMonth: number;
  /** Restricts this list to specific voucher types and hides the Type
   * filter — used by the dedicated Sales/Purchase/Returns lists, which are
   * the Daybook's own data pre-scoped to one purpose rather than a separate
   * query. */
  lockedTypes?: string[];
  /** Where the date-range controls navigate — defaults to the Daybook's own
   * route so existing callers don't need to change. */
  basePath?: string;
}) {
  const router = useRouter();
  const [party, setParty] = useState("");
  const [type, setType] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");

  const scopedRows = useMemo(
    () => (lockedTypes ? rows.filter((r) => lockedTypes.includes(r.voucher_type)) : rows),
    [rows, lockedTypes]
  );

  const types = useMemo(
    () => [...new Set(scopedRows.map((r) => r.voucher_type))].sort(),
    [scopedRows]
  );

  const filtered = useMemo(() => {
    const partyNeedle = party.trim().toLowerCase();
    const min = minAmount.trim() ? Number(minAmount) : null;
    const max = maxAmount.trim() ? Number(maxAmount) : null;
    return scopedRows.filter((r) => {
      if (partyNeedle && !(r.party_name ?? "").toLowerCase().includes(partyNeedle)) return false;
      if (type && r.voucher_type !== type) return false;
      if (min !== null && !Number.isNaN(min) && Number(r.total_amount) < min) return false;
      if (max !== null && !Number.isNaN(max) && Number(r.total_amount) > max) return false;
      return true;
    });
  }, [scopedRows, party, type, minAmount, maxAmount]);

  const filteredTotal = filtered.reduce((n, r) => n + Number(r.total_amount ?? 0), 0);
  const filtersActive = party || type || minAmount || maxAmount;

  function navigateTo(nextFrom: string, nextTo: string) {
    router.push(`${basePath ?? `/${companyId}/reports/daybook`}?from=${nextFrom}&to=${nextTo}`);
  }

  function setDate(which: "from" | "to", value: string) {
    navigateTo(which === "from" ? value : from, which === "to" ? value : to);
  }

  function applyPreset(key: PeriodPresetKey) {
    const range = periodPreset(key, financialYearStartMonth);
    navigateTo(range.from, range.to);
  }

  return (
    <>
      <div className="flex flex-wrap items-end gap-3 p-4 pb-0 print:hidden">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-soft">Quick range</span>
          <Select
            value=""
            onChange={(e) => e.target.value && applyPreset(e.target.value as PeriodPresetKey)}
            className="w-[190px]"
          >
            <option value="">Particular date range…</option>
            {PERIOD_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-soft">From</span>
          <Input type="date" value={from} onChange={(e) => setDate("from", e.target.value)} className="w-[150px]" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-soft">To</span>
          <Input type="date" value={to} onChange={(e) => setDate("to", e.target.value)} className="w-[150px]" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-soft">Party</span>
          <Input
            type="text"
            placeholder="Search party…"
            value={party}
            onChange={(e) => setParty(e.target.value)}
            className="w-[170px]"
          />
        </label>
        {!lockedTypes && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-soft">Type</span>
            <Select value={type} onChange={(e) => setType(e.target.value)} className="w-[140px]">
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>
              ))}
            </Select>
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-soft">Min amount</span>
          <Input
            type="number"
            inputMode="decimal"
            placeholder="0"
            value={minAmount}
            onChange={(e) => setMinAmount(e.target.value)}
            className="w-[100px] text-right"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-soft">Max amount</span>
          <Input
            type="number"
            inputMode="decimal"
            placeholder="Any"
            value={maxAmount}
            onChange={(e) => setMaxAmount(e.target.value)}
            className="w-[100px] text-right"
          />
        </label>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setParty("");
              setType("");
              setMinAmount("");
              setMaxAmount("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <table className="mt-4 w-full min-w-[940px] text-sm">
        <thead>
          <tr>
            <th className={th}>Date</th>
            <th className={th}>Number</th>
            <th className={th}>Type</th>
            <th className={th}>Party</th>
            <th className={th}>Narration</th>
            <th className={th + " text-right"}>Amount</th>
            <th className={th + " print:hidden"}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-ink-faint">
                {scopedRows.length === 0 ? "None in this period." : "No vouchers match these filters."}
              </td>
            </tr>
          )}
          {filtered.map((r) => (
            <tr key={r.voucher_id}>
              <td className={td + " whitespace-nowrap font-mono tabular-nums"}>{r.voucher_date}</td>
              <td className={td + " whitespace-nowrap font-mono text-xs"}>{r.voucher_number}</td>
              <td className={td + " whitespace-nowrap"}>{TYPE_LABEL[r.voucher_type] ?? r.voucher_type}</td>
              <td className={td}>{r.party_name ?? <span className="text-ink-faint">—</span>}</td>
              <td className={td + " text-ink-soft"}>{r.narration ?? <span className="text-ink-faint">—</span>}</td>
              <td className={num}>{formatINR(Number(r.total_amount))}</td>
              <td className={td + " print:hidden"}>
                <div className="flex items-center gap-2.5 whitespace-nowrap text-xs">
                  <Link href={`/${companyId}/vouchers/${r.voucher_id}`} className="text-accent underline underline-offset-4">
                    View
                  </Link>
                  <Link href={editHrefFor(companyId, r.voucher_id, r.voucher_type)} className="text-accent underline underline-offset-4">
                    Edit
                  </Link>
                  <DeleteVoucherButton companyId={companyId} voucherId={r.voucher_id} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
        {filtered.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5" colSpan={5}>
                {filtered.length} voucher{filtered.length === 1 ? "" : "s"}
                {filtersActive && filtered.length !== scopedRows.length && (
                  <span className="ml-1 font-normal text-ink-faint">of {scopedRows.length}</span>
                )}
              </td>
              <td className={num}>{formatINR(filteredTotal, { showZero: true })}</td>
              <td className="print:hidden"></td>
            </tr>
          </tfoot>
        )}
      </table>
    </>
  );
}
