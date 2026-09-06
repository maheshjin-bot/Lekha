"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";

// ============================================================================
// 1380 — identity correction and an exit that doesn't require a full
// settlement. Ported from a larger commit that also carried a salary-revision
// RPC and UI; that half is deliberately NOT here — EmployeeManager.tsx
// already has its own "Pay rise or correction" section (shipped separately,
// b02ff82, guarded by the live 1471 trigger), and duplicating it here would
// give this screen two competing ways to change the same rows. See 1380's
// own migration header for the full reasoning.
// ============================================================================

export type EditableEmployee = {
  id: string;
  name: string;
  pan: string | null;
  uan: string | null;
  esi_number: string | null;
  date_of_joining: string;
  date_of_leaving: string | null;
  is_active: boolean;
  branch_id: string | null;
};

// Mirrors app_private.is_valid_pan exactly, same as EmployeeManager's copy —
// duplicated rather than shared, the same call this codebase already made
// for lib/ledgers/friendlyError.ts (extract only once two components drift).
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// The local wall-clock date, as YYYY-MM-DD — the same helper (and the same
// reason: never toISOString(), see lib/utils/period.ts) already duplicated
// into components/stock-verification/StockVerificationManager.tsx.
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Plain English for the constraints an identity edit can actually hit. */
function friendlyEmployeeError(message: string): string {
  if (message.includes("employees_pan_check")) {
    return "That doesn't look like a valid PAN (format AAAAA9999A) — re-check it against the card. A wrong PAN here breaks Form 24Q and Form 16.";
  }
  if (message.includes("employees_name_check")) {
    return "An employee needs a name.";
  }
  if (message.includes("employees_branch_id_company_id_fkey")) {
    return "That establishment doesn't belong to this company — pick one from the list.";
  }
  return message;
}

/**
 * Everything that can be changed about an existing employee, in one
 * expandable panel: their identity and statutory numbers, and their leaving
 * date. Until 1380 neither existed — employees were create-only, which is
 * why reports/pf-ecr and reports/esi-mc could tell a user to "add it under
 * Employees" for a missing UAN or IP number and be wrong: there was no edit
 * screen to add it on.
 */
export function EmployeeEditRow({
  companyId,
  employee,
  branches,
  fnfExitDate,
  onDone,
}: {
  companyId: string;
  employee: EditableEmployee;
  branches: { id: string; code: string; name: string; state_code: string | null }[];
  /** employee_exit_settlements.exit_date, if a full-and-final settlement already owns this employee's exit. */
  fnfExitDate: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const supabase = createClient();
  const today = todayLocal();

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  // --- identity -------------------------------------------------------------
  const [name, setName] = useState(employee.name);
  const [pan, setPan] = useState(employee.pan ?? "");
  const [uan, setUan] = useState(employee.uan ?? "");
  const [esiNumber, setEsiNumber] = useState(employee.esi_number ?? "");
  const [branchId, setBranchId] = useState(employee.branch_id ?? "");
  const [idBusy, setIdBusy] = useState(false);
  const [idError, setIdError] = useState<string | null>(null);
  const [idSaved, setIdSaved] = useState(false);

  const panLooksValid = pan.trim().length === 0 || PAN_PATTERN.test(pan.trim());

  async function onSaveIdentity(e: React.FormEvent) {
    e.preventDefault();
    if (!panLooksValid) {
      setIdError("That doesn't match the PAN format (5 letters, 4 digits, 1 letter).");
      return;
    }
    setIdBusy(true);
    setIdError(null);
    setIdSaved(false);

    // A plain UPDATE: employees_write RLS (0043) already restricts this to a
    // company admin and employees_pan_check already validates the PAN, so
    // 1380 deliberately did not wrap these five columns in an RPC — an admin
    // who could call one could make the same write directly.
    //
    // `.select("id")` is load-bearing, not decoration. PostgREST reports an
    // UPDATE that RLS filtered to zero rows as a plain success — without
    // asking for the affected row back, a non-admin would be shown "Saved"
    // over a write that never happened.
    const { data, error } = await supabase
      .from("employees")
      .update({
        name: name.trim(),
        pan: pan.trim() || null,
        uan: uan.trim() || null,
        esi_number: esiNumber.trim() || null,
        branch_id: branchId || null,
      })
      .eq("id", employee.id)
      .select("id");

    setIdBusy(false);
    if (error) {
      setIdError(friendlyEmployeeError(error.message));
      return;
    }
    if (!data || data.length === 0) {
      setIdError("Only a company admin can edit an employee. Nothing was saved.");
      return;
    }

    setIdSaved(true);
    router.refresh();
  }

  // --- leaving date -----------------------------------------------------
  const [leaveDate, setLeaveDate] = useState(employee.date_of_leaving ?? "");
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  async function submitLeaving(value: string | null) {
    setLeaveBusy(true);
    setLeaveError(null);

    const { error } = await callRpc(supabase, "set_employee_leaving_date", {
      p_employee_id: employee.id,
      p_date_of_leaving: value,
    });

    setLeaveBusy(false);
    if (error) {
      setLeaveError(error.message);
      return;
    }

    router.refresh();
  }

  const sectionTitle = "text-sm font-semibold text-ink";
  const hint = "mt-1 text-xs text-ink-faint";

  return (
    <div className="flex flex-col gap-6 px-4 py-5">
      {/* -------------------------------------------------- identity ------- */}
      <section>
        <h3 className={sectionTitle}>Identity &amp; statutory numbers</h3>
        <p className={hint}>
          EPFO&rsquo;s ECR rejects a member row with no UAN and ESIC&rsquo;s MC
          upload needs the IP number, so these are the fields the PF and ESI
          reports send you here to fix.
        </p>
        <form onSubmit={onSaveIdentity} className="mt-3 flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Name</span>
              <input required value={name} onChange={(e) => setName(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                PAN <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input
                value={pan}
                onChange={(e) => setPan(e.target.value.toUpperCase())}
                maxLength={10}
                placeholder="AAAAA0000A"
                className={
                  field +
                  " font-mono uppercase" +
                  (panLooksValid ? "" : " border-error focus-visible:border-error")
                }
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                UAN <span className="font-normal text-ink-faint">EPFO, 12 digits</span>
              </span>
              <input value={uan} onChange={(e) => setUan(e.target.value)} className={field + " font-mono"} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                ESI / IP number{" "}
                <span className="font-normal text-ink-faint">ESIC, 10 digits</span>
              </span>
              <input
                value={esiNumber}
                onChange={(e) => setEsiNumber(e.target.value)}
                className={field + " font-mono"}
              />
            </label>
            {branches.length > 1 && (
              <label className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-sm font-medium">
                  Establishment{" "}
                  <span className="font-normal text-ink-faint">
                    professional tax is a State levy, so this decides which State
                  </span>
                </span>
                <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field}>
                  <option value="">Head office</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                      {b.state_code ? ` — State ${b.state_code}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="text-xs text-ink-faint">
            Date of joining is not editable here — it re-dates every past
            payroll month at once and drives gratuity tenure and bonus
            eligibility. A wrong joining date needs the employee re-created.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={idBusy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {idBusy ? "Saving…" : "Save details"}
            </button>
            {idSaved && !idError && <p className="text-xs text-success">Saved.</p>}
            {idError && <p className="text-xs text-error">{idError}</p>}
          </div>
        </form>
      </section>

      {/* --------------------------------------------------- leaving ------- */}
      <section className="border-t border-border pt-5">
        <h3 className={sectionTitle}>Leaving date</h3>

        {fnfExitDate ? (
          <>
            <p className={hint}>
              A full-and-final settlement is finalized for this employee at{" "}
              <span className="font-mono">{fnfExitDate}</span>, and its gratuity
              and leave encashment were computed on that date. The settlement
              owns the date from here — changing it in two places would leave
              those figures silently wrong.
            </p>
            <Link
              href={`/${companyId}/fnf-settlement`}
              className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
            >
              Change it on the Full &amp; Final screen →
            </Link>
          </>
        ) : (
          <>
            <p className={hint}>
              Records that the employee has left, so payroll, leave accrual and
              professional tax stop from that date. It settles nothing —
              gratuity, leave encashment and net dues are computed on the{" "}
              <Link
                href={`/${companyId}/fnf-settlement`}
                className="font-medium text-accent hover:underline"
              >
                Full &amp; Final screen
              </Link>
              , which is still where an exit gets paid out.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Last working day</span>
                <input
                  type="date"
                  value={leaveDate}
                  min={employee.date_of_joining}
                  max={today}
                  onChange={(e) => setLeaveDate(e.target.value)}
                  className={field + " font-mono"}
                />
              </label>
              <button
                type="button"
                disabled={leaveBusy || !leaveDate}
                onClick={() => submitLeaving(leaveDate)}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {leaveBusy ? "Saving…" : employee.date_of_leaving ? "Update leaving date" : "Mark as left"}
              </button>
              {employee.date_of_leaving && (
                <button
                  type="button"
                  disabled={leaveBusy}
                  onClick={() => {
                    setLeaveDate("");
                    submitLeaving(null);
                  }}
                  className="rounded-lg border border-border-strong px-4 py-2 text-sm text-ink-soft hover:bg-surface-2 disabled:opacity-50"
                >
                  Recorded in error — clear it
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-ink-faint">
              Only up to today. A future last working day cannot be recorded
              yet: the employee still counts as employed for the months in
              between, and the monthly TDS estimate depends on that.
            </p>
            {leaveError && <p className="mt-2 text-xs text-error">{leaveError}</p>}
          </>
        )}
      </section>

      <div>
        <button
          type="button"
          onClick={onDone}
          className="text-xs font-medium text-ink-faint hover:underline"
        >
          Close
        </button>
      </div>
    </div>
  );
}
