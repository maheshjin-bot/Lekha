"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { Input, Label, Select } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { formatINR } from "@/lib/utils/currency";
import {
  blockingPostedMonth,
  monthLabel,
  nextMonthStart,
  revisionDateProblem,
  structureGross,
  structureInForceOn,
  type SalaryStructure,
} from "@/lib/employees/salaryStructures";

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

// Mirrors app_private.is_valid_pan exactly, same as EmployeeManager's copy.
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * Plain English for the constraints an identity edit can actually hit. Kept
 * beside its one caller rather than in lib/, which is the distinction
 * lib/ledgers/friendlyError.ts draws for itself: it was extracted only because
 * two components had drifting copies of the same mapping.
 */
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
 * Everything that can be changed about an existing employee, in one expandable
 * panel: their identity and statutory numbers, their salary (as a new
 * effective-dated row, never an edit of the old one), and their leaving date.
 *
 * Until 1380 none of this existed — employees were create-only, which is why
 * reports/pf-ecr and reports/esi-mc could tell a user to "add it under
 * Employees" for a missing UAN or IP number and be wrong.
 */
export function EmployeeEditRow({
  companyId,
  employee,
  structures,
  branches,
  fnfExitDate,
  postedMonths,
  today,
  onDone,
}: {
  companyId: string;
  employee: EditableEmployee;
  structures: SalaryStructure[];
  branches: { id: string; name: string; state_code: string | null }[];
  fnfExitDate: string | null;
  postedMonths: string[];
  today: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const supabase = createClient();

  const inForce = structureInForceOn(structures, today);
  const history = [...structures].sort((a, b) =>
    a.effective_from < b.effective_from ? 1 : -1
  );

  // --- identity -------------------------------------------------------------
  const [name, setName] = useState(employee.name);
  const [pan, setPan] = useState(employee.pan ?? "");
  const [uan, setUan] = useState(employee.uan ?? "");
  const [esiNumber, setEsiNumber] = useState(employee.esi_number ?? "");
  const [branchId, setBranchId] = useState(employee.branch_id ?? "");
  const [idBusy, setIdBusy] = useState(false);
  const [idError, setIdError] = useState<string | null>(null);

  const panLooksValid = pan.trim().length === 0 || PAN_PATTERN.test(pan.trim());

  async function onSaveIdentity(e: React.FormEvent) {
    e.preventDefault();
    if (!panLooksValid) {
      setIdError("That doesn't match the PAN format (5 letters, 4 digits, 1 letter).");
      return;
    }
    setIdBusy(true);
    setIdError(null);

    // A plain UPDATE: employees_write RLS (0043) already restricts this to a
    // company admin and employees_pan_check already validates the PAN, so 1380
    // deliberately did not wrap these five columns in an RPC.
    //
    // `.select("id")` is load-bearing, not decoration. PostgREST reports an
    // UPDATE that RLS filtered to zero rows as a plain success — without asking
    // for the affected row back, a non-admin would be shown "Saved" over a
    // write that never happened.
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

    toast.success("Employee details saved.");
    router.refresh();
  }

  // --- salary revision ------------------------------------------------------
  const [revMonth, setRevMonth] = useState("");
  const [revBasic, setRevBasic] = useState(String(inForce?.basic ?? 0));
  const [revDa, setRevDa] = useState(String(inForce?.dearness_allowance ?? 0));
  const [revHra, setRevHra] = useState(String(inForce?.hra ?? 0));
  const [revSpecial, setRevSpecial] = useState(String(inForce?.special_allowance ?? 0));
  const [revOther, setRevOther] = useState(String(inForce?.other_allowance ?? 0));
  const [revPf, setRevPf] = useState(inForce?.pf_applicable ?? true);
  const [revPfCeiling, setRevPfCeiling] = useState(inForce?.pf_wage_ceiling_applies ?? true);
  const [revEsi, setRevEsi] = useState(inForce?.esi_applicable ?? true);
  const [revPt, setRevPt] = useState(String(inForce?.professional_tax_monthly ?? 0));
  const [revBusy, setRevBusy] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);

  // <input type="month"> gives "2026-09"; the first of that month is the only
  // date record_salary_revision accepts for a revision, which is the whole
  // reason this is a month control and not a date one.
  const revEffectiveFrom = revMonth ? `${revMonth}-01` : "";
  const revDateProblem = revEffectiveFrom
    ? revisionDateProblem(revEffectiveFrom, employee.date_of_joining, employee.date_of_leaving)
    : null;
  const revPostedBlock = revEffectiveFrom
    ? blockingPostedMonth(postedMonths, revEffectiveFrom)
    : null;
  const revGross =
    (Number(revBasic) || 0) +
    (Number(revDa) || 0) +
    (Number(revHra) || 0) +
    (Number(revSpecial) || 0) +
    (Number(revOther) || 0);
  const revReplaces = revEffectiveFrom
    ? structures.some((s) => s.effective_from === revEffectiveFrom)
    : false;

  async function onSaveRevision(e: React.FormEvent) {
    e.preventDefault();
    if (!revEffectiveFrom || revDateProblem || revPostedBlock) return;
    setRevBusy(true);
    setRevError(null);

    const { error } = await callRpc(supabase, "record_salary_revision", {
      p_employee_id: employee.id,
      p_effective_from: revEffectiveFrom,
      p_basic: Number(revBasic) || 0,
      p_dearness_allowance: Number(revDa) || 0,
      p_hra: Number(revHra) || 0,
      p_special_allowance: Number(revSpecial) || 0,
      p_other_allowance: Number(revOther) || 0,
      p_pf_applicable: revPf,
      p_pf_wage_ceiling_applies: revPfCeiling,
      p_esi_applicable: revEsi,
      p_professional_tax_monthly: Number(revPt) || 0,
    });

    setRevBusy(false);
    if (error) {
      setRevError(error.message);
      return;
    }

    toast.success(
      `Salary ${revReplaces ? "corrected" : "revised"} from ${monthLabel(revEffectiveFrom)}. Earlier months keep the old salary.`
    );
    setRevMonth("");
    router.refresh();
  }

  // --- leaving date ---------------------------------------------------------
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

    toast.success(
      value
        ? "Leaving date recorded — payroll, leave and PT stop accruing from it."
        : "Leaving date cleared."
    );
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
            <label className="block">
              <Label>Name</Label>
              <Input required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block">
              <Label>
                PAN <span className="font-normal text-ink-faint">optional</span>
              </Label>
              <Input
                value={pan}
                onChange={(e) => setPan(e.target.value.toUpperCase())}
                maxLength={10}
                placeholder="AAAAA0000A"
                className={
                  "font-mono uppercase" +
                  (panLooksValid ? "" : " border-error focus-visible:border-error")
                }
              />
            </label>
            <label className="block">
              <Label>
                UAN <span className="font-normal text-ink-faint">EPFO, 12 digits</span>
              </Label>
              <Input
                value={uan}
                onChange={(e) => setUan(e.target.value)}
                className="font-mono"
              />
            </label>
            <label className="block">
              <Label>
                ESI / IP number{" "}
                <span className="font-normal text-ink-faint">ESIC, 10 digits</span>
              </Label>
              <Input
                value={esiNumber}
                onChange={(e) => setEsiNumber(e.target.value)}
                className="font-mono"
              />
            </label>
            {branches.length > 1 && (
              <label className="block sm:col-span-2">
                <Label>
                  Establishment{" "}
                  <span className="font-normal text-ink-faint">
                    professional tax is a State levy, so this decides which State
                  </span>
                </Label>
                <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  <option value="">Head office</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                      {b.state_code ? ` — State ${b.state_code}` : ""}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
          <p className="text-xs text-ink-faint">
            Date of joining is not editable here — it re-dates every past
            payroll month at once and drives gratuity tenure and bonus
            eligibility. A wrong joining date needs the employee re-created.
          </p>
          <div className="flex items-center gap-3">
            <Button type="submit" busy={idBusy} busyLabel="Saving…" size="sm">
              Save details
            </Button>
            {idError && <p className="text-xs text-error">{idError}</p>}
          </div>
        </form>
      </section>

      {/* ---------------------------------------------------- salary ------- */}
      <section className="border-t border-border pt-5">
        <h3 className={sectionTitle}>Salary</h3>
        <p className={hint}>
          A revision is recorded as a new row effective from a month — the
          earlier row is left exactly as it is, so last year&rsquo;s 24Q, Form
          16, PF and ESI keep computing on the salary that was actually in force
          then.
        </p>

        <div className="mt-3 overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[560px] text-xs">
            <thead>
              <tr className="border-b border-border text-left text-ink-faint">
                <th className="px-3 py-2 font-medium">Effective from</th>
                <th className="px-3 py-2 text-right font-medium">Basic</th>
                <th className="px-3 py-2 text-right font-medium">DA</th>
                <th className="px-3 py-2 text-right font-medium">HRA</th>
                <th className="px-3 py-2 text-right font-medium">Other</th>
                <th className="px-3 py-2 text-right font-medium">Gross</th>
                <th className="px-3 py-2 font-medium">PF / ESI / PT</th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => {
                const current = inForce?.effective_from === s.effective_from;
                return (
                  <tr key={s.effective_from} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-mono">{s.effective_from}</span>
                      {current && (
                        <Badge tone="accent" className="ml-2 align-middle">
                          In force
                        </Badge>
                      )}
                      {s.effective_from > today && (
                        <Badge tone="warn" className="ml-2 align-middle">
                          From {monthLabel(s.effective_from)}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatINR(Number(s.basic))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatINR(Number(s.dearness_allowance))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatINR(Number(s.hra))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatINR(
                        Number(s.special_allowance) + Number(s.other_allowance)
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">
                      {formatINR(structureGross(s))}
                    </td>
                    <td className="px-3 py-2 text-ink-soft">
                      {s.pf_applicable ? (s.pf_wage_ceiling_applies ? "PF capped" : "PF uncapped") : "No PF"}
                      {" · "}
                      {s.esi_applicable ? "ESI" : "No ESI"}
                      {" · "}
                      {formatINR(Number(s.professional_tax_monthly))}
                    </td>
                  </tr>
                );
              })}
              {history.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-ink-faint">
                    No salary structure on file — payroll cannot compute anything
                    for this employee until one exists.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form onSubmit={onSaveRevision} className="mt-4 flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <Label>Effective from</Label>
              <Input
                type="month"
                value={revMonth}
                onChange={(e) => setRevMonth(e.target.value)}
                className="font-mono"
              />
              <span className="mt-1 block text-[11px] text-ink-faint">
                A whole month at a time — payroll pays one rate per month.
              </span>
            </label>
            <label className="block">
              <Label>Basic</Label>
              <Input
                inputMode="decimal"
                value={revBasic}
                onChange={(e) => setRevBasic(e.target.value)}
                className="text-right tabular-nums"
              />
            </label>
            <label className="block">
              <Label>Dearness allowance</Label>
              <Input
                inputMode="decimal"
                value={revDa}
                onChange={(e) => setRevDa(e.target.value)}
                className="text-right tabular-nums"
              />
            </label>
            <label className="block">
              <Label>HRA</Label>
              <Input
                inputMode="decimal"
                value={revHra}
                onChange={(e) => setRevHra(e.target.value)}
                className="text-right tabular-nums"
              />
            </label>
            <label className="block">
              <Label>Special allowance</Label>
              <Input
                inputMode="decimal"
                value={revSpecial}
                onChange={(e) => setRevSpecial(e.target.value)}
                className="text-right tabular-nums"
              />
            </label>
            <label className="block">
              <Label>Other allowance</Label>
              <Input
                inputMode="decimal"
                value={revOther}
                onChange={(e) => setRevOther(e.target.value)}
                className="text-right tabular-nums"
              />
            </label>
            <label className="block">
              <Label>Professional tax (₹/month)</Label>
              <Input
                inputMode="decimal"
                value={revPt}
                onChange={(e) => setRevPt(e.target.value)}
                className="text-right tabular-nums"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={revPf} onChange={(e) => setRevPf(e.target.checked)} />
              PF applicable
            </label>
            {revPf && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={revPfCeiling}
                  onChange={(e) => setRevPfCeiling(e.target.checked)}
                />
                Cap PF wage at ₹15,000
              </label>
            )}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={revEsi}
                onChange={(e) => setRevEsi(e.target.checked)}
              />
              ESI applicable
            </label>
          </div>

          <p className="text-xs text-ink-soft">
            New gross{" "}
            <span className="font-mono font-semibold tabular-nums">{formatINR(revGross)}</span>
            {inForce && (
              <>
                {" "}
                against{" "}
                <span className="font-mono tabular-nums">
                  {formatINR(structureGross(inForce))}
                </span>{" "}
                in force now
              </>
            )}
            {revReplaces && revEffectiveFrom && (
              <>
                {" · "}
                <span className="text-warning">
                  replaces the structure already effective {revEffectiveFrom}
                </span>
              </>
            )}
          </p>

          {revDateProblem && <p className="text-xs text-error">{revDateProblem}</p>}
          {!revDateProblem && revPostedBlock && (
            <p className="text-xs text-error">
              Payroll for {monthLabel(revPostedBlock)} is already posted, paid and
              remitted. Re-rating it here would leave the PF, ESI, PT and 24Q
              figures disagreeing with the challans filed — pay the difference as
              arrears instead, or date the revision from{" "}
              {monthLabel(nextMonthStart(revPostedBlock))}.
            </p>
          )}
          {revError && <p className="text-xs text-error">{revError}</p>}

          <div>
            <Button
              type="submit"
              busy={revBusy}
              busyLabel="Recording…"
              size="sm"
              disabled={!revEffectiveFrom || !!revDateProblem || !!revPostedBlock}
            >
              {revReplaces ? "Correct this month's salary" : "Record revision"}
            </Button>
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
              professional tax stop from that date. It settles nothing — gratuity,
              leave encashment and net dues are computed on the{" "}
              <Link
                href={`/${companyId}/fnf-settlement`}
                className="font-medium text-accent hover:underline"
              >
                Full &amp; Final screen
              </Link>
              , which is still where an exit gets paid out.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="block">
                <Label>Last working day</Label>
                <Input
                  type="date"
                  value={leaveDate}
                  min={employee.date_of_joining}
                  max={today}
                  onChange={(e) => setLeaveDate(e.target.value)}
                  className="font-mono"
                />
              </label>
              <Button
                type="button"
                size="sm"
                busy={leaveBusy}
                busyLabel="Saving…"
                disabled={!leaveDate}
                onClick={() => submitLeaving(leaveDate)}
              >
                {employee.date_of_leaving ? "Update leaving date" : "Mark as left"}
              </Button>
              {employee.date_of_leaving && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  busy={leaveBusy}
                  busyLabel="Saving…"
                  onClick={() => {
                    setLeaveDate("");
                    submitLeaving(null);
                  }}
                >
                  Recorded in error — clear it
                </Button>
              )}
            </div>
            <p className="mt-2 text-xs text-ink-faint">
              Only up to today. A future last working day cannot be recorded yet:
              the employee still counts as employed for the months in between,
              and the monthly TDS estimate depends on that.
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
