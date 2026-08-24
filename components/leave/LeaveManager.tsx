"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";

type Employee = { id: string; name: string; is_active: boolean };

type Balance = {
  employee_id: string;
  employee_name: string;
  date_of_joining: string;
  accrued: number;
  availed: number;
  encashed: number;
  adjusted: number;
  balance: number;
  carry_forward_cap: number;
  excess_over_cap: number;
};

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

function fmtDays(n: number): string {
  return n.toFixed(2).replace(/\.00$/, "");
}

export function LeaveManager({
  companyId,
  accrualRate,
  carryForwardCap,
  employees,
  balances,
  asOf,
}: {
  companyId: string;
  accrualRate: number;
  carryForwardCap: number;
  employees: Employee[];
  balances: Balance[];
  asOf: string;
}) {
  const router = useRouter();

  const [rate, setRate] = useState(String(accrualRate));
  const [cap, setCap] = useState(String(carryForwardCap));
  const [settingsBusy, setSettingsBusy] = useState(false);

  const [asOfInput, setAsOfInput] = useState(asOf);

  const [accrualMonth, setAccrualMonth] = useState(asOf.slice(0, 7));
  const [accrualBusy, setAccrualBusy] = useState(false);

  const [txEmployeeId, setTxEmployeeId] = useState("");
  const [txType, setTxType] = useState<"availed" | "encashed" | "adjustment">("availed");
  const [txDays, setTxDays] = useState("1");
  const [txDate, setTxDate] = useState(asOf);
  const [txNotes, setTxNotes] = useState("");
  const [txBusy, setTxBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSettingsBusy(true);
    const { error } = await createClient()
      .from("companies")
      .update({
        leave_accrual_days_per_month: Number(rate) || 0,
        leave_carry_forward_cap_days: Number(cap) || 0,
      })
      .eq("id", companyId);
    setSettingsBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Leave settings saved");
    router.refresh();
  }

  async function runAccrual() {
    if (!/^\d{4}-\d{2}$/.test(accrualMonth)) {
      toast.error("Pick a month first");
      return;
    }
    setAccrualBusy(true);
    const { data, error } = await callRpc<
      { p_company_id: string; p_period_month: string },
      { accrual_employee_id: string; accrual_days_accrued: number }[]
    >(createClient(), "accrue_leave_for_month", {
      p_company_id: companyId,
      p_period_month: `${accrualMonth}-01`,
    });
    setAccrualBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const n = data?.length ?? 0;
    toast.success(
      n === 0
        ? "Nothing to accrue — every eligible employee already has this month's accrual"
        : `Accrued leave for ${n} employee${n === 1 ? "" : "s"}. Effective from the last day of the month.`
    );
    router.refresh();
  }

  async function recordTransaction(e: React.FormEvent) {
    e.preventDefault();
    if (!txEmployeeId) return;
    setTxBusy(true);
    setTxError(null);
    const { error } = await callRpc<
      {
        p_company_id: string;
        p_employee_id: string;
        p_entry_type: string;
        p_days: number;
        p_transaction_date: string;
        p_notes: string | null;
      },
      string
    >(createClient(), "record_leave_transaction", {
      p_company_id: companyId,
      p_employee_id: txEmployeeId,
      p_entry_type: txType,
      p_days: Number(txDays) || 0,
      p_transaction_date: txDate,
      p_notes: txNotes.trim() || null,
    });
    setTxBusy(false);
    if (error) {
      setTxError(error.message);
      return;
    }
    toast.success("Leave transaction recorded");
    setTxDays("1");
    setTxNotes("");
    router.refresh();
  }

  function goToAsOf(e: React.FormEvent) {
    e.preventDefault();
    router.push(`?as_of=${asOfInput}`);
  }

  return (
    <div className="mt-8 flex flex-col gap-8">
      {/* ---------------- Settings ---------------- */}
      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Accrual settings</h2>
        <p className="mt-1 max-w-2xl text-xs text-ink-faint">
          Default 1.25 days/month (= 15/year) approximates OSH Code 2020 Sec 32&rsquo;s 1-day-per-20-
          worked-days rate for a ~300 working-day year. The 30-day carry-forward cap is the Code&rsquo;s
          own figure — balance above it is flagged below as due for encashment, not auto-encashed.
        </p>
        <form onSubmit={saveSettings} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Accrual (days/month)</span>
            <input
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className={field + " w-36 text-right tabular-nums"}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Carry-forward cap (days)</span>
            <input
              inputMode="decimal"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className={field + " w-40 text-right tabular-nums"}
            />
          </label>
          <button
            type="submit"
            disabled={settingsBusy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {settingsBusy ? "Saving…" : "Save"}
          </button>
        </form>
      </section>

      {/* ---------------- Monthly accrual run ---------------- */}
      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Run monthly accrual</h2>
        <p className="mt-1 max-w-2xl text-xs text-ink-faint">
          Credits one accrual row per active employee for the chosen month, prorated for a joining/
          leaving month. Effective from the last day of that month — same dating convention the
          payroll register already uses — so a month just accrued will not show in the balance below
          until the &ldquo;as of&rdquo; date reaches month-end. Safe to re-run: an employee already
          accrued for a month is silently skipped, never double-credited.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Month</span>
            <input
              type="month"
              value={accrualMonth}
              onChange={(e) => setAccrualMonth(e.target.value)}
              className={field}
            />
          </label>
          <button
            type="button"
            onClick={runAccrual}
            disabled={accrualBusy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {accrualBusy ? "Running…" : "Run accrual"}
          </button>
        </div>
      </section>

      {/* ---------------- Balances ---------------- */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">Balances</h2>
          <form onSubmit={goToAsOf} className="flex items-end gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">As of</span>
              <input
                type="date"
                value={asOfInput}
                onChange={(e) => setAsOfInput(e.target.value)}
                className={field}
              />
            </label>
            <button
              type="submit"
              className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:bg-surface-2"
            >
              Go
            </button>
          </form>
        </div>

        <TableContainer className="mt-3">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Employee</th>
                <th className={th + " text-right"}>Accrued</th>
                <th className={th + " text-right"}>Availed</th>
                <th className={th + " text-right"}>Encashed</th>
                <th className={th + " text-right"}>Adjusted</th>
                <th className={th + " text-right"}>Balance</th>
                <th className={th + " text-right"}>Cap</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {balances.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-ink-faint">
                    No employees yet.
                  </td>
                </tr>
              )}
              {balances.map((b) => (
                <tr key={b.employee_id} className="border-b border-border last:border-0">
                  <td className={td}>{b.employee_name}</td>
                  <td className={num}>{fmtDays(b.accrued)}</td>
                  <td className={num}>{fmtDays(b.availed)}</td>
                  <td className={num}>{fmtDays(b.encashed)}</td>
                  <td className={num}>{fmtDays(b.adjusted)}</td>
                  <td className={num + " font-medium"}>{fmtDays(b.balance)}</td>
                  <td className={num}>{fmtDays(b.carry_forward_cap)}</td>
                  <td className={td}>
                    {b.excess_over_cap > 0 ? (
                      <Badge tone="warn">{fmtDays(b.excess_over_cap)} above cap — encash</Badge>
                    ) : (
                      <span className="text-xs text-ink-faint">Within cap</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      </section>

      {/* ---------------- Record a transaction ---------------- */}
      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Record leave taken, encashment, or a correction</h2>
        <p className="mt-1 max-w-2xl text-xs text-ink-faint">
          Enter the number of days as a positive figure — availed/encashed are debited automatically.
          An encashment tied to an employee&rsquo;s exit is better recorded from{" "}
          <a href={`/${companyId}/fnf-settlement`} className="underline">
            full-and-final settlement
          </a>{" "}
          instead, which computes the payable amount and zeroes the balance together.
        </p>
        <form onSubmit={recordTransaction} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Employee</span>
            <select
              required
              value={txEmployeeId}
              onChange={(e) => setTxEmployeeId(e.target.value)}
              className={field}
            >
              <option value="">Select…</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Type</span>
            <select
              value={txType}
              onChange={(e) => setTxType(e.target.value as typeof txType)}
              className={field}
            >
              <option value="availed">Availed</option>
              <option value="encashed">Encashed</option>
              <option value="adjustment">Adjustment (correction)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">
              Days {txType === "adjustment" && "(negative to debit)"}
            </span>
            <input
              inputMode="decimal"
              value={txDays}
              onChange={(e) => setTxDays(e.target.value)}
              className={field + " text-right tabular-nums"}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Date</span>
            <input
              required
              type="date"
              value={txDate}
              onChange={(e) => setTxDate(e.target.value)}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Notes</span>
            <input value={txNotes} onChange={(e) => setTxNotes(e.target.value)} className={field} />
          </label>

          {txError && (
            <p className="sm:col-span-2 lg:col-span-5 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {txError}
            </p>
          )}

          <button
            type="submit"
            disabled={txBusy}
            className="lg:col-span-5 mt-1 w-fit rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {txBusy ? "Recording…" : "Record"}
          </button>
        </form>
      </section>
    </div>
  );
}
