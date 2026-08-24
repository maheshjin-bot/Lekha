"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { formatINR } from "@/lib/utils/currency";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";

type Employee = {
  id: string;
  name: string;
  date_of_joining: string;
  date_of_leaving: string | null;
  is_active: boolean;
};

type Settlement = {
  id: string;
  employee_id: string;
  employee_name: string;
  exit_date: string;
  exit_reason: string;
  unpaid_salary_amount: number;
  leave_encashment_days: number;
  leave_encashment_amount: number;
  gratuity_eligible: boolean;
  gratuity_amount: number;
  bonus_amount: number;
  recoveries_amount: number;
  net_payable: number;
  finalized_at: string;
};

type Preview = {
  employee_id: string;
  employee_name: string;
  date_of_joining: string;
  leave_balance_days: number;
  leave_daily_wage: number;
  leave_encashment_amount: number;
  gratuity_eligible: boolean;
  gratuity_ineligibility_reason: string | null;
  gratuity_completed_years: number;
  gratuity_amount: number;
  statutory_monthly_wage: number;
  exit_month_reference_gross: number;
  exit_month_already_posted: boolean;
};

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

const EXIT_REASONS = [
  { value: "resignation", label: "Resignation" },
  { value: "retirement", label: "Retirement" },
  { value: "termination", label: "Termination" },
  { value: "contract_expiry", label: "Contract expiry" },
  { value: "death", label: "Death (waives the 5-year gratuity test)" },
  { value: "disablement", label: "Disablement (waives the 5-year gratuity test)" },
];

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function FnfSettlementManager({
  companyId,
  employees,
  settlements,
}: {
  companyId: string;
  employees: Employee[];
  settlements: Settlement[];
}) {
  const router = useRouter();
  const settledIds = new Set(settlements.map((s) => s.employee_id));

  const [employeeId, setEmployeeId] = useState("");
  const [exitDate, setExitDate] = useState(todayLocal());
  const [exitReason, setExitReason] = useState("resignation");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [unpaidSalary, setUnpaidSalary] = useState("0");
  const [bonus, setBonus] = useState("0");
  const [recoveries, setRecoveries] = useState("0");
  const [notes, setNotes] = useState("");
  const [finalizeBusy, setFinalizeBusy] = useState(false);

  async function runPreview() {
    if (!employeeId || !exitDate) return;
    setPreviewBusy(true);
    setPreviewError(null);
    setPreview(null);
    const { data, error } = await callRpc<
      { p_company_id: string; p_employee_id: string; p_exit_date: string; p_exit_reason: string },
      Preview[]
    >(createClient(), "get_fnf_preview", {
      p_company_id: companyId,
      p_employee_id: employeeId,
      p_exit_date: exitDate,
      p_exit_reason: exitReason,
    });
    setPreviewBusy(false);
    if (error) {
      setPreviewError(error.message);
      return;
    }
    const row = data?.[0];
    if (!row) {
      setPreviewError("No data returned for this employee.");
      return;
    }
    setPreview({
      ...row,
      leave_balance_days: Number(row.leave_balance_days),
      leave_daily_wage: Number(row.leave_daily_wage),
      leave_encashment_amount: Number(row.leave_encashment_amount),
      gratuity_completed_years: Number(row.gratuity_completed_years),
      gratuity_amount: Number(row.gratuity_amount),
      statutory_monthly_wage: Number(row.statutory_monthly_wage),
      exit_month_reference_gross: Number(row.exit_month_reference_gross),
    });
  }

  const netPreview =
    preview != null
      ? (Number(unpaidSalary) || 0) +
        preview.leave_encashment_amount +
        preview.gratuity_amount +
        (Number(bonus) || 0) -
        (Number(recoveries) || 0)
      : null;

  async function finalize() {
    if (!preview) return;
    setFinalizeBusy(true);
    const { error } = await callRpc<
      {
        p_company_id: string;
        p_employee_id: string;
        p_exit_date: string;
        p_exit_reason: string;
        p_unpaid_salary_amount: number;
        p_bonus_amount: number;
        p_recoveries_amount: number;
        p_notes: string | null;
      },
      string
    >(createClient(), "record_fnf_settlement", {
      p_company_id: companyId,
      p_employee_id: employeeId,
      p_exit_date: exitDate,
      p_exit_reason: exitReason,
      p_unpaid_salary_amount: Number(unpaidSalary) || 0,
      p_bonus_amount: Number(bonus) || 0,
      p_recoveries_amount: Number(recoveries) || 0,
      p_notes: notes.trim() || null,
    });
    setFinalizeBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Settlement finalized — leave balance encashed, employee marked exited.");
    setPreview(null);
    setEmployeeId("");
    setNotes("");
    setUnpaidSalary("0");
    setBonus("0");
    setRecoveries("0");
    router.refresh();
  }

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New settlement</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Employee</span>
            <select
              value={employeeId}
              onChange={(e) => {
                setEmployeeId(e.target.value);
                setPreview(null);
              }}
              className={field}
            >
              <option value="">Select…</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                  {settledIds.has(emp.id) ? " — already settled" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Exit date</span>
            <input
              type="date"
              value={exitDate}
              onChange={(e) => {
                setExitDate(e.target.value);
                setPreview(null);
              }}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Exit reason</span>
            <select
              value={exitReason}
              onChange={(e) => {
                setExitReason(e.target.value);
                setPreview(null);
              }}
              className={field}
            >
              {EXIT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button
          type="button"
          onClick={runPreview}
          disabled={!employeeId || !exitDate || previewBusy}
          className="mt-3 rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold hover:bg-surface-2 disabled:opacity-50"
        >
          {previewBusy ? "Computing…" : "Preview"}
        </button>

        {previewError && (
          <p className="mt-3 rounded-md bg-error-soft px-3 py-2 text-sm text-error">{previewError}</p>
        )}

        {preview && (
          <div className="mt-5 border-t border-border pt-5">
            {settledIds.has(employeeId) && (
              <p className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
                This employee already has a finalized settlement. Finalizing again replaces it and
                re-does the leave encashment (it will not double-encash).
              </p>
            )}
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-border p-3">
                <dt className="text-xs text-ink-faint">Leave balance as of exit</dt>
                <dd className="mt-0.5 font-mono tabular-nums">
                  {preview.leave_balance_days.toFixed(2)} days ×{" "}
                  {formatINR(preview.leave_daily_wage, { showZero: true })}/day ={" "}
                  <strong>{formatINR(preview.leave_encashment_amount, { showZero: true })}</strong>
                </dd>
              </div>
              <div className="rounded-md border border-border p-3">
                <dt className="text-xs text-ink-faint">Gratuity (Sec 53)</dt>
                <dd className="mt-0.5">
                  {preview.gratuity_eligible ? (
                    <>
                      <span className="font-mono tabular-nums">
                        {preview.gratuity_completed_years} yrs ×{" "}
                        {formatINR(preview.statutory_monthly_wage, { showZero: true })}/mo ={" "}
                      </span>
                      <strong className="font-mono tabular-nums">
                        {formatINR(preview.gratuity_amount, { showZero: true })}
                      </strong>
                    </>
                  ) : (
                    <span className="text-ink-faint">
                      Not eligible — {preview.gratuity_ineligibility_reason}
                    </span>
                  )}
                </dd>
              </div>
            </dl>

            <p className="mt-3 text-xs text-ink-faint">
              Reference only — this employee&rsquo;s current gross is{" "}
              {formatINR(preview.exit_month_reference_gross, { showZero: true })}/month.{" "}
              {preview.exit_month_already_posted ? (
                <span className="text-warning">
                  Payroll for {exitDate.slice(0, 7)} is already posted — unpaid salary below is very
                  likely zero unless there is a separate shortfall.
                </span>
              ) : (
                <>Payroll for {exitDate.slice(0, 7)} has not been posted yet.</>
              )}{" "}
              Enter the real unpaid-salary figure below after checking the{" "}
              <a href={`/${companyId}/reports/payroll-register?month=${exitDate.slice(0, 7)}`} className="underline">
                payroll register
              </a>{" "}
              for that month.
            </p>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Unpaid salary</span>
                <input
                  inputMode="decimal"
                  value={unpaidSalary}
                  onChange={(e) => setUnpaidSalary(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Bonus</span>
                <input
                  inputMode="decimal"
                  value={bonus}
                  onChange={(e) => setBonus(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Recoveries (loans, notice shortfall, etc.)</span>
                <input
                  inputMode="decimal"
                  value={recoveries}
                  onChange={(e) => setRecoveries(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
            </div>

            <label className="mt-3 flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">Notes</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={field} />
            </label>

            <div className="mt-4 flex items-center justify-between rounded-md bg-bg px-4 py-3">
              <span className="font-semibold">Net payable</span>
              <span className="font-mono text-lg font-semibold tabular-nums">
                {formatINR(netPreview ?? 0, { showZero: true })}
              </span>
            </div>

            <button
              type="button"
              onClick={finalize}
              disabled={finalizeBusy}
              className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {finalizeBusy ? "Finalizing…" : "Finalize settlement"}
            </button>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg font-semibold tracking-tight">Finalized settlements</h2>
        <TableContainer className="mt-3">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Employee</th>
                <th className={th}>Exit date</th>
                <th className={th}>Reason</th>
                <th className={th + " text-right"}>Unpaid salary</th>
                <th className={th + " text-right"}>Leave encashment</th>
                <th className={th + " text-right"}>Gratuity</th>
                <th className={th + " text-right"}>Bonus</th>
                <th className={th + " text-right"}>Recoveries</th>
                <th className={th + " text-right"}>Net payable</th>
              </tr>
            </thead>
            <tbody>
              {settlements.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-ink-faint">
                    None yet.
                  </td>
                </tr>
              )}
              {settlements.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0">
                  <td className={td}>{s.employee_name}</td>
                  <td className={td + " text-ink-soft"}>{s.exit_date}</td>
                  <td className={td + " text-ink-soft"}>
                    {s.exit_reason}
                    {!s.gratuity_eligible && s.gratuity_amount === 0 && (
                      <div className="mt-0.5">
                        <Badge tone="neutral">Not gratuity-eligible</Badge>
                      </div>
                    )}
                  </td>
                  <td className={num}>{formatINR(s.unpaid_salary_amount, { showZero: true })}</td>
                  <td className={num}>
                    {formatINR(s.leave_encashment_amount, { showZero: true })}
                    <div className="text-xs text-ink-faint">{s.leave_encashment_days.toFixed(2)}d</div>
                  </td>
                  <td className={num}>{formatINR(s.gratuity_amount, { showZero: true })}</td>
                  <td className={num}>{formatINR(s.bonus_amount, { showZero: true })}</td>
                  <td className={num}>{formatINR(s.recoveries_amount, { showZero: true })}</td>
                  <td className={num + " font-medium"}>{formatINR(s.net_payable, { showZero: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      </section>
    </div>
  );
}
