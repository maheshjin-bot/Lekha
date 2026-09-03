"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";

type Employee = {
  id: string;
  name: string;
  pan: string | null;
  uan: string | null;
  esi_number: string | null;
  date_of_joining: string;
  date_of_leaving: string | null;
  is_active: boolean;
  current_basic: number | null;
  current_gross: number | null;
};

type TaxDeclaration = {
  employee_id: string;
  financial_year_label: string;
  regime: "old" | "new";
};

type SalaryStructure = {
  id: string;
  employee_id: string;
  /** ISO date. Compared lexicographically throughout — ISO dates sort correctly. */
  effective_from: string;
  basic: number;
  dearness_allowance: number;
  hra: number;
  special_allowance: number;
  other_allowance: number;
  pf_applicable: boolean;
  pf_wage_ceiling_applies: boolean;
  esi_applicable: boolean;
  professional_tax_monthly: number;
};

// First day of the month after this one, as an ISO date.
function nextMonthStart(iso: string) {
  const [y, m] = iso.split("-").map(Number);
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

// Mirrors app_private.is_valid_pan exactly.
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// Mirrors employee_tax_declarations_financial_year_label_check exactly.
const FY_LABEL_PATTERN = /^\d{4}-\d{2}$/;

export function EmployeeManager({
  companyId,
  employees,
  branches,
  taxDeclarations,
  currentFinancialYearLabel,
  structures,
  postedMonths,
}: {
  companyId: string;
  employees: Employee[];
  taxDeclarations: TaxDeclaration[];
  currentFinancialYearLabel: string;
  branches: { id: string; code: string; name: string; state_code: string | null }[];
  /** Every salary structure row for the company, newest effective date first. */
  structures: SalaryStructure[];
  /** payroll_postings.period_month — the months already in the ledger. */
  postedMonths: string[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pan, setPan] = useState("");
  const [uan, setUan] = useState("");
  const [esiNumber, setEsiNumber] = useState("");
  const [dateOfJoining, setDateOfJoining] = useState("");
  const [branchId, setBranchId] = useState("");
  const [basic, setBasic] = useState("0");
  const [dearnessAllowance, setDearnessAllowance] = useState("0");
  const [hra, setHra] = useState("0");
  const [specialAllowance, setSpecialAllowance] = useState("0");
  const [otherAllowance, setOtherAllowance] = useState("0");
  const [pfApplicable, setPfApplicable] = useState(true);
  const [pfWageCeilingApplies, setPfWageCeilingApplies] = useState(true);
  const [esiApplicable, setEsiApplicable] = useState(true);
  const [professionalTax, setProfessionalTax] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sec 115BAC(1A) regime declaration — a separate form from the one above,
  // scoped to an EXISTING employee rather than the one being created, since
  // a declaration under CBDT Circular 4/2023 is sought every financial year,
  // not just at hire.
  const [decEmployeeId, setDecEmployeeId] = useState("");
  const [decFinancialYear, setDecFinancialYear] = useState(currentFinancialYearLabel);
  const [decRegime, setDecRegime] = useState<"old" | "new">("new");
  const [decDate, setDecDate] = useState("");
  const [decDeduction80c, setDecDeduction80c] = useState("0");
  const [decDeduction80d, setDecDeduction80d] = useState("0");
  const [decHraExemption, setDecHraExemption] = useState("0");
  const [decHomeLoanInterest, setDecHomeLoanInterest] = useState("0");
  const [decPrevIncome, setDecPrevIncome] = useState("0");
  const [decPrevTds, setDecPrevTds] = useState("0");
  const [decNotes, setDecNotes] = useState("");
  const [decBusy, setDecBusy] = useState(false);
  const [decError, setDecError] = useState<string | null>(null);
  const [decSaved, setDecSaved] = useState(false);

  /*
   * ==========================================================================
   * SALARY REVISIONS — the third form on this page
   * ==========================================================================
   * No employee in this application had ever been given a pay rise, because
   * there was no way to give one: this screen created an employee and their
   * opening structure together and then said so out loud ("Editing a salary
   * later needs a new structure row — not yet a form here"). Every employee at
   * every company in the database had exactly one structure row. A mistyped
   * starting salary was equally permanent.
   *
   * The mechanism was designed for and never exposed. get_payroll_run's
   * `latest_structure` CTE takes the newest row with effective_from <= the
   * payroll month's first day, which is an effective-dated history: a second
   * row IS a pay rise. So this form writes a second row, and invents nothing.
   *
   * TWO OPERATIONS, NOT ONE. They answer different questions and have
   * different rules:
   *
   *   REVISE   a new row from a future month. What the pay becomes.
   *   CORRECT  the existing row, in place. What the pay always was — a typo.
   *
   * A correction is the only answer to "I typed 62,500 and meant 65,200",
   * because a revision would leave the wrong figure standing for every month
   * before it. It is also the more dangerous of the two, which is why it is
   * withdrawn the moment the row it would change is one a posted payroll month
   * depends on.
   *
   * EFFECTIVE DATES ARE MONTH STARTS, and the control below only offers month
   * starts. `effective_from <= period start` means a row dated the 15th and a
   * row dated the 1st of the following month behave identically, so a date
   * picker that accepted the 15th would be offering a distinction the payroll
   * engine cannot honour — and a preparer would reasonably read a mid-month
   * rise as being pro-rated, which it is not.
   */
  const structuresByEmployee = new Map<string, SalaryStructure[]>();
  for (const s of structures) {
    const list = structuresByEmployee.get(s.employee_id) ?? [];
    list.push(s);
    structuresByEmployee.set(s.employee_id, list);
  }
  // The page orders newest-first, but do not rely on a caller's ordering for
  // something this consequential.
  for (const list of structuresByEmployee.values()) {
    list.sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  }

  const latestPostedMonth =
    postedMonths.length > 0 ? postedMonths.slice().sort().at(-1)! : null;

  // The earliest month a REVISION may take effect from: the month after the
  // last one that has been posted. Mirrors migration 1471's own arithmetic; the
  // database is still the authority, this is just so the form does not offer a
  // date it knows will be refused.
  const earliestRevisionMonth = latestPostedMonth
    ? nextMonthStart(latestPostedMonth)
    : null;

  /*
   * A salary is locked once it was in force during — or before — a month that
   * has been posted. The same one-line rule as
   * app_private.salary_structure_locked_by_payroll (1471), deliberately coarser
   * than get_payroll_run's own row selection so that the two cannot drift: this
   * screen must never offer a correction the database will refuse.
   */
  const isLocked = (s: SalaryStructure) =>
    earliestRevisionMonth !== null && s.effective_from < earliestRevisionMonth;

  const [revEmployeeId, setRevEmployeeId] = useState("");
  const [revMode, setRevMode] = useState<"revise" | "correct">("revise");
  const [revEffectiveFrom, setRevEffectiveFrom] = useState("");
  const [revBasic, setRevBasic] = useState("");
  const [revDa, setRevDa] = useState("");
  const [revHra, setRevHra] = useState("");
  const [revSpecial, setRevSpecial] = useState("");
  const [revOther, setRevOther] = useState("");
  const [revPf, setRevPf] = useState(true);
  const [revPfCeiling, setRevPfCeiling] = useState(true);
  const [revEsi, setRevEsi] = useState(true);
  const [revPt, setRevPt] = useState("");
  const [revBusy, setRevBusy] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);
  const [revSaved, setRevSaved] = useState<string | null>(null);

  const revCurrent = revEmployeeId
    ? (structuresByEmployee.get(revEmployeeId)?.[0] ?? null)
    : null;
  const revCurrentLocked = revCurrent ? isLocked(revCurrent) : false;
  const revEmployee = employees.find((e) => e.id === revEmployeeId) ?? null;

  /*
   * Seeding the form from the selected employee's current structure — during
   * render, not in an effect, and keyed on the selection. Same pattern (and
   * same reason) as QuickAddLedgerModal's prefill seeding: an effect would
   * paint the form empty for a frame, and the project's
   * react-hooks/set-state-in-effect rule refuses it outright.
   *
   * The key includes the current row's identity, so that after a revision is
   * saved and the page refreshes, the form reseeds from the NEW current
   * structure instead of leaving the old figures on screen next to a message
   * saying they have changed. `revSaved` is deliberately not cleared here —
   * that would wipe the confirmation in the same render that produced it; it
   * is cleared when the preparer picks a different employee.
   */
  const seedKey = revEmployeeId
    ? `${revEmployeeId}|${revCurrent?.id ?? "none"}|${revCurrent?.effective_from ?? ""}`
    : "";
  const [seededFor, setSeededFor] = useState("");
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    const c = revCurrent;
    setRevBasic(c ? String(c.basic) : "0");
    setRevDa(c ? String(c.dearness_allowance) : "0");
    setRevHra(c ? String(c.hra) : "0");
    setRevSpecial(c ? String(c.special_allowance) : "0");
    setRevOther(c ? String(c.other_allowance) : "0");
    setRevPf(c ? c.pf_applicable : true);
    setRevPfCeiling(c ? c.pf_wage_ceiling_applies : true);
    setRevEsi(c ? c.esi_applicable : true);
    setRevPt(c ? String(c.professional_tax_monthly) : "0");
    setRevEffectiveFrom("");
    setRevMode("revise");
    setRevError(null);
  }

  // Month starts on offer for a revision: from the earliest allowed month (or
  // the month after the current structure begins) out to twelve months ahead.
  const revMonthOptions: string[] = (() => {
    if (!revCurrent) return [];
    const floor = [
      earliestRevisionMonth ?? "",
      nextMonthStart(revCurrent.effective_from.slice(0, 7) + "-01"),
    ]
      .filter(Boolean)
      .sort()
      .at(-1)!;
    const out: string[] = [];
    let m = floor;
    for (let i = 0; i < 24; i++) {
      out.push(m);
      m = nextMonthStart(m);
    }
    return out;
  })();

  const effectiveRevMonth =
    revEffectiveFrom && revMonthOptions.includes(revEffectiveFrom)
      ? revEffectiveFrom
      : (revMonthOptions[0] ?? "");

  const revGross =
    (Number(revBasic) || 0) +
    (Number(revDa) || 0) +
    (Number(revHra) || 0) +
    (Number(revSpecial) || 0) +
    (Number(revOther) || 0);
  const revCurrentGross = revCurrent
    ? revCurrent.basic +
      revCurrent.dearness_allowance +
      revCurrent.hra +
      revCurrent.special_allowance +
      revCurrent.other_allowance
    : 0;

  async function onSubmitRevision(e: React.FormEvent) {
    e.preventDefault();
    if (!revCurrent || !revEmployee) return;
    setRevBusy(true);
    setRevError(null);
    setRevSaved(null);

    const supabase = createClient();
    const values = {
      basic: Number(revBasic) || 0,
      dearness_allowance: Number(revDa) || 0,
      hra: Number(revHra) || 0,
      special_allowance: Number(revSpecial) || 0,
      other_allowance: Number(revOther) || 0,
      pf_applicable: revPf,
      pf_wage_ceiling_applies: revPfCeiling,
      esi_applicable: revEsi,
      professional_tax_monthly: Number(revPt) || 0,
    };

    const { error: revErr } =
      revMode === "correct"
        ? await supabase
            .from("employee_salary_structures")
            .update(values)
            .eq("id", revCurrent.id)
        : await supabase.from("employee_salary_structures").insert({
            employee_id: revEmployeeId,
            company_id: companyId,
            effective_from: effectiveRevMonth,
            ...values,
          });

    if (revErr) {
      // 1471 raises with an errcode and a sentence written to be read; 23505 is
      // the unique (employee_id, effective_from) key.
      setRevError(
        revErr.code === "23505"
          ? `${revEmployee.name} already has a salary effective from that month.`
          : revErr.message
      );
      setRevBusy(false);
      return;
    }

    setRevSaved(
      revMode === "correct"
        ? `Corrected ${revEmployee.name}'s salary effective ${revCurrent.effective_from}.`
        : `${revEmployee.name} moves to ${formatINR(revGross)} a month from ${effectiveRevMonth}.`
    );
    setRevBusy(false);
    router.refresh();
  }

  const panLooksValid = pan.length === 0 || PAN_PATTERN.test(pan);
  const decFyLooksValid = decFinancialYear.length === 0 || FY_LABEL_PATTERN.test(decFinancialYear);

  // Declaration for the CURRENT financial year, keyed by employee — drives
  // the "Regime" badge in the table below. Re-submitting the form for the
  // same employee/year upserts over it rather than erroring.
  const declarationByEmployee = new Map(
    taxDeclarations
      .filter((d) => d.financial_year_label === currentFinancialYearLabel)
      .map((d) => [d.employee_id, d])
  );

  async function onSubmitDeclaration(e: React.FormEvent) {
    e.preventDefault();
    if (!decEmployeeId) return;
    setDecBusy(true);
    setDecError(null);
    setDecSaved(false);

    const supabase = createClient();

    const { error: decErr } = await supabase.from("employee_tax_declarations").upsert(
      {
        employee_id: decEmployeeId,
        company_id: companyId,
        financial_year_label: decFinancialYear,
        regime: decRegime,
        declaration_date: decDate,
        // The new regime does not recognise these deductions at all — zeroed
        // out rather than left at whatever the form happened to hold, so a
        // regime switch back to 'new' can't leave stale old-regime figures
        // behind (the DB CHECK would reject it anyway; this just avoids the
        // round trip).
        deduction_80c: decRegime === "old" ? Number(decDeduction80c) || 0 : 0,
        deduction_80d: decRegime === "old" ? Number(decDeduction80d) || 0 : 0,
        hra_exemption_claimed: decRegime === "old" ? Number(decHraExemption) || 0 : 0,
        home_loan_interest_24b: decRegime === "old" ? Number(decHomeLoanInterest) || 0 : 0,
        previous_employer_income: Number(decPrevIncome) || 0,
        previous_employer_tds_deducted: Number(decPrevTds) || 0,
        notes: decNotes.trim() || null,
      },
      { onConflict: "employee_id,financial_year_label" }
    );

    if (decErr) {
      setDecError(decErr.message);
      setDecBusy(false);
      return;
    }

    setDecBusy(false);
    setDecSaved(true);
    router.refresh();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createClient();

    const { data: employee, error: employeeError } = await supabase
      .from("employees")
      .insert({
        company_id: companyId,
        name: name.trim(),
        pan: pan.trim() || null,
        uan: uan.trim() || null,
        esi_number: esiNumber.trim() || null,
        date_of_joining: dateOfJoining,
        // Null is a legitimate answer for a single-location business; payroll
        // reads it as the head office.
        branch_id: branchId || null,
      })
      .select("id")
      .single();

    if (employeeError || !employee) {
      setError(employeeError?.message ?? "Could not create employee.");
      setBusy(false);
      return;
    }

    const { error: structureError } = await supabase.from("employee_salary_structures").insert({
      employee_id: employee.id,
      company_id: companyId,
      effective_from: dateOfJoining,
      basic: Number(basic) || 0,
      dearness_allowance: Number(dearnessAllowance) || 0,
      hra: Number(hra) || 0,
      special_allowance: Number(specialAllowance) || 0,
      other_allowance: Number(otherAllowance) || 0,
      pf_applicable: pfApplicable,
      pf_wage_ceiling_applies: pfWageCeilingApplies,
      esi_applicable: esiApplicable,
      professional_tax_monthly: Number(professionalTax) || 0,
    });

    if (structureError) {
      setError(
        `Employee created, but the salary structure failed: ${structureError.message}. Add it separately.`
      );
      setBusy(false);
      router.refresh();
      return;
    }

    setName("");
    setPan("");
    setUan("");
    setEsiNumber("");
    setDateOfJoining("");
    setBasic("0");
    setHra("0");
    setSpecialAllowance("0");
    setOtherAllowance("0");
    setPfApplicable(true);
    setPfWageCeilingApplies(true);
    setEsiApplicable(true);
    setProfessionalTax("0");
    setBusy(false);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Employee</th>
                <th className="px-4 py-2.5 font-medium">PAN</th>
                <th className="px-4 py-2.5 font-medium">Joined</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">
                  Regime {currentFinancialYearLabel}
                </th>
                <th className="px-4 py-2.5 text-right font-medium">Current gross</th>
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-ink-faint">
                    No employees yet. Add one on the right.
                  </td>
                </tr>
              )}
              {employees.map((emp) => {
                const declared = declarationByEmployee.get(emp.id);
                return (
                <tr key={emp.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 font-medium">{emp.name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-soft">
                    {emp.pan ?? <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-ink-soft">{emp.date_of_joining}</td>
                  <td className="px-4 py-2.5 text-ink-soft">
                    {!emp.is_active || emp.date_of_leaving ? (
                      <span className="text-xs text-ink-faint">
                        Left{emp.date_of_leaving ? ` ${emp.date_of_leaving}` : ""}
                      </span>
                    ) : (
                      <span className="text-xs text-success">Active</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-ink-soft">
                    {declared ? (
                      <span className={declared.regime === "old" ? "text-xs text-warning" : "text-xs text-ink-soft"}>
                        {declared.regime === "old" ? "Old (declared)" : "New (declared)"}
                      </span>
                    ) : (
                      <span className="text-xs text-ink-faint">Not declared — defaults to new</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                    {emp.current_gross != null ? (
                      formatINR(emp.current_gross)
                    ) : (
                      <span className="text-ink-faint">—</span>
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
        <h2 className="font-semibold">New employee</h2>
        <p className="mt-1 text-xs text-ink-faint">
          Creates the employee and their starting salary structure together,
          effective from the date of joining. A later rise or a corrected
          figure goes through &ldquo;Pay rise or correction&rdquo; below.
        </p>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
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
              className={field + " font-mono uppercase"}
            />
            {pan.length > 0 && !panLooksValid && (
              <span className="text-xs text-warning">
                That doesn&rsquo;t match the PAN format (5 letters, 4 digits, 1 letter).
              </span>
            )}
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                UAN <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input value={uan} onChange={(e) => setUan(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                ESI no. <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input value={esiNumber} onChange={(e) => setEsiNumber(e.target.value)} className={field} />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Date of joining</span>
            <input
              required
              type="date"
              value={dateOfJoining}
              onChange={(e) => setDateOfJoining(e.target.value)}
              className={field}
            />
          </label>

          {branches.length > 1 && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Establishment{" "}
                <span className="font-normal text-ink-faint">
                  professional tax is a State levy, so this decides which State
                </span>
              </span>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className={field}
              >
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

          <div className="rounded-md border border-border p-3">
            <span className="text-sm font-medium">Salary structure</span>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Basic</span>
                <input
                  inputMode="decimal"
                  value={basic}
                  onChange={(e) => setBasic(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Dearness allowance</span>
                <input
                  inputMode="decimal"
                  value={dearnessAllowance}
                  onChange={(e) => setDearnessAllowance(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">HRA</span>
                <input
                  inputMode="decimal"
                  value={hra}
                  onChange={(e) => setHra(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Special allowance</span>
                <input
                  inputMode="decimal"
                  value={specialAllowance}
                  onChange={(e) => setSpecialAllowance(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Other allowance</span>
                <input
                  inputMode="decimal"
                  value={otherAllowance}
                  onChange={(e) => setOtherAllowance(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
            </div>

            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={pfApplicable}
                onChange={(e) => setPfApplicable(e.target.checked)}
              />
              PF applicable (12%/12% on basic + DA)
            </label>
            {pfApplicable && (
              <label className="mt-1.5 flex items-center gap-2 pl-6 text-sm">
                <input
                  type="checkbox"
                  checked={pfWageCeilingApplies}
                  onChange={(e) => setPfWageCeilingApplies(e.target.checked)}
                />
                Cap PF wage at ₹15,000
              </label>
            )}
            <label className="mt-1.5 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={esiApplicable}
                onChange={(e) => setEsiApplicable(e.target.checked)}
              />
              ESI applicable (0.75%/3.25%, only while gross ≤ ₹21,000)
            </label>

            <label className="mt-3 flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">
                Professional tax (₹/month) — state-specific, enter directly
              </span>
              <input
                inputMode="decimal"
                value={professionalTax}
                onChange={(e) => setProfessionalTax(e.target.value)}
                className={field + " text-right tabular-nums"}
              />
            </label>
          </div>

          {error && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add employee"}
          </button>
        </form>
      </section>

      <section className="min-w-0 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Pay rise or correction</h2>
        <p className="mt-1 max-w-2xl text-xs text-ink-faint">
          A salary is effective-dated: a rise is a second salary from a later
          month, not an edit to the old one, so every month before it keeps
          paying what it actually paid. A typo is the other case — that is a
          correction to the existing figures, and it is only available while no
          posted payroll month depends on them.
        </p>
        <form onSubmit={onSubmitRevision} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Employee</span>
            <select
              required
              value={revEmployeeId}
              onChange={(e) => {
                setRevEmployeeId(e.target.value);
                setRevSaved(null);
              }}
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

          {revEmployeeId && !revCurrent && (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
              This employee has no salary structure at all, which should not
              happen — one is written when the employee is created. Adding a
              first structure is not something this form does.
            </p>
          )}

          {revCurrent && (
            <>
              <div className="rounded-md border border-border bg-surface-2/40 p-3 text-sm">
                <p className="text-ink-soft">
                  Currently{" "}
                  <strong className="font-semibold text-ink tabular-nums">
                    {formatINR(revCurrentGross)}
                  </strong>{" "}
                  a month (basic {formatINR(revCurrent.basic)}), effective from{" "}
                  <strong className="font-medium text-ink">
                    {revCurrent.effective_from}
                  </strong>
                  .
                </p>
                {revCurrentLocked && (
                  <p className="mt-1.5 text-xs text-ink-faint">
                    Posted payroll depends on these figures, so they can no
                    longer be corrected — only superseded from a later month.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">What is this?</span>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="revmode"
                    className="mt-1"
                    checked={revMode === "revise"}
                    onChange={() => setRevMode("revise")}
                  />
                  <span>
                    A pay rise or cut
                    <span className="block text-xs text-ink-faint">
                      Keeps the history. Applies from the month you choose
                      onward.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="revmode"
                    className="mt-1"
                    disabled={revCurrentLocked}
                    checked={revMode === "correct"}
                    onChange={() => setRevMode("correct")}
                  />
                  <span className={revCurrentLocked ? "text-ink-faint" : undefined}>
                    A correction to the figures above
                    <span className="block text-xs text-ink-faint">
                      {revCurrentLocked
                        ? `Not available — a posted payroll month uses this salary.`
                        : `Rewrites the salary effective ${revCurrent.effective_from}, as if it had always been this.`}
                    </span>
                  </span>
                </label>
              </div>

              {revMode === "revise" && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Effective from</span>
                  <select
                    value={effectiveRevMonth}
                    onChange={(e) => setRevEffectiveFrom(e.target.value)}
                    className={field}
                  >
                    {revMonthOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-ink-faint">
                    Whole months only — payroll reads the salary in force on the
                    first of the month, so a mid-month date would change nothing
                    until the month after it.
                    {latestPostedMonth
                      ? ` Payroll is posted up to ${latestPostedMonth}, so nothing earlier than ${earliestRevisionMonth} can be offered.`
                      : ""}
                  </span>
                </label>
              )}

              <div className="rounded-md border border-border p-3">
                <span className="text-sm font-medium">
                  {revMode === "correct" ? "Corrected figures" : "New salary"}
                </span>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-ink-faint">Basic</span>
                    <input
                      inputMode="decimal"
                      value={revBasic}
                      onChange={(e) => setRevBasic(e.target.value)}
                      className={field + " text-right tabular-nums"}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-ink-faint">Dearness allowance</span>
                    <input
                      inputMode="decimal"
                      value={revDa}
                      onChange={(e) => setRevDa(e.target.value)}
                      className={field + " text-right tabular-nums"}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-ink-faint">HRA</span>
                    <input
                      inputMode="decimal"
                      value={revHra}
                      onChange={(e) => setRevHra(e.target.value)}
                      className={field + " text-right tabular-nums"}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-ink-faint">Special allowance</span>
                    <input
                      inputMode="decimal"
                      value={revSpecial}
                      onChange={(e) => setRevSpecial(e.target.value)}
                      className={field + " text-right tabular-nums"}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-ink-faint">Other allowance</span>
                    <input
                      inputMode="decimal"
                      value={revOther}
                      onChange={(e) => setRevOther(e.target.value)}
                      className={field + " text-right tabular-nums"}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-ink-faint">Professional tax (₹/month)</span>
                    <input
                      inputMode="decimal"
                      value={revPt}
                      onChange={(e) => setRevPt(e.target.value)}
                      className={field + " text-right tabular-nums"}
                    />
                  </label>
                </div>

                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={revPf}
                    onChange={(e) => setRevPf(e.target.checked)}
                  />
                  PF applicable (12%/12% on basic + DA)
                </label>
                {revPf && (
                  <label className="mt-1.5 flex items-center gap-2 pl-6 text-sm">
                    <input
                      type="checkbox"
                      checked={revPfCeiling}
                      onChange={(e) => setRevPfCeiling(e.target.checked)}
                    />
                    Cap PF wage at ₹15,000
                  </label>
                )}
                <label className="mt-1.5 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={revEsi}
                    onChange={(e) => setRevEsi(e.target.checked)}
                  />
                  ESI applicable (0.75%/3.25%, only while gross ≤ ₹21,000)
                </label>

                <p className="mt-3 text-sm text-ink-soft">
                  Monthly gross{" "}
                  <strong className="font-semibold tabular-nums text-ink">
                    {formatINR(revGross)}
                  </strong>
                  {revGross !== revCurrentGross && (
                    <span className="ml-1.5 text-xs text-ink-faint">
                      {revGross > revCurrentGross ? "up" : "down"}{" "}
                      {formatINR(Math.abs(revGross - revCurrentGross))} from{" "}
                      {formatINR(revCurrentGross)}
                    </span>
                  )}
                </p>
                {revPf && !revPfCeiling && revGross > revCurrentGross && (
                  <p className="mt-1 text-xs text-ink-faint">
                    The ₹15,000 PF wage cap is off for this employee, so the
                    employer&rsquo;s PF cost rises with the basic.
                  </p>
                )}
              </div>

              {revError && (
                <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
                  {revError}
                </p>
              )}
              {revSaved && !revError && (
                <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
                  {revSaved}
                </p>
              )}

              <button
                type="submit"
                disabled={revBusy || (revMode === "revise" && !effectiveRevMonth)}
                className="mt-1 self-start rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {revBusy
                  ? "Saving…"
                  : revMode === "correct"
                    ? "Correct this salary"
                    : "Record the revision"}
              </button>
            </>
          )}
        </form>
      </section>

      <section className="min-w-0 rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Tax declaration — Sec 115BAC(1A)</h2>
        <p className="mt-1 max-w-2xl text-xs text-ink-faint">
          New regime is the default under Sec 115BAC(1A); an employee who wants
          the old regime has to declare it to the employer, in writing, each
          financial year (CBDT Circular 4/2023). This records that fact and,
          if old regime, the deduction figures the employee is claiming. It
          does not compute old-regime tax anywhere yet — the payroll TDS
          estimate still projects on a pure new-regime basis until that
          computation is built.
        </p>
        <form onSubmit={onSubmitDeclaration} className="mt-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Employee</span>
              <select
                required
                value={decEmployeeId}
                onChange={(e) => setDecEmployeeId(e.target.value)}
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
              <span className="text-sm font-medium">Financial year</span>
              <input
                required
                value={decFinancialYear}
                onChange={(e) => setDecFinancialYear(e.target.value)}
                placeholder="2026-27"
                className={field}
              />
              {decFinancialYear.length > 0 && !decFyLooksValid && (
                <span className="text-xs text-warning">Format is YYYY-YY, e.g. 2026-27.</span>
              )}
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Regime declared</span>
              <select
                value={decRegime}
                onChange={(e) => setDecRegime(e.target.value as "old" | "new")}
                className={field}
              >
                <option value="new">New (Sec 115BAC default)</option>
                <option value="old">Old (opted out)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Declaration date</span>
              <input
                required
                type="date"
                value={decDate}
                onChange={(e) => setDecDate(e.target.value)}
                className={field}
              />
            </label>
          </div>

          {decRegime === "old" && (
            <div className="rounded-md border border-border p-3">
              <span className="text-sm font-medium">Old-regime deductions claimed</span>
              <p className="mt-0.5 text-xs text-ink-faint">
                The claimed amount, entered directly — not the underlying
                receipts. No statutory cap is enforced here (80D varies by
                age, Sec 24(b) has no cap on a let-out property); check the
                employee&rsquo;s own eligibility before relying on this figure.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">Sec 80C</span>
                  <input
                    inputMode="decimal"
                    value={decDeduction80c}
                    onChange={(e) => setDecDeduction80c(e.target.value)}
                    className={field + " text-right tabular-nums"}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">Sec 80D</span>
                  <input
                    inputMode="decimal"
                    value={decDeduction80d}
                    onChange={(e) => setDecDeduction80d(e.target.value)}
                    className={field + " text-right tabular-nums"}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">HRA exemption claimed</span>
                  <input
                    inputMode="decimal"
                    value={decHraExemption}
                    onChange={(e) => setDecHraExemption(e.target.value)}
                    className={field + " text-right tabular-nums"}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">Home loan interest — Sec 24(b)</span>
                  <input
                    inputMode="decimal"
                    value={decHomeLoanInterest}
                    onChange={(e) => setDecHomeLoanInterest(e.target.value)}
                    className={field + " text-right tabular-nums"}
                  />
                </label>
              </div>
            </div>
          )}

          <div className="rounded-md border border-border p-3">
            <span className="text-sm font-medium">
              Previous employer this year{" "}
              <span className="font-normal text-ink-faint">Sec 192(2), mid-year joiners only</span>
            </span>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Income reported</span>
                <input
                  inputMode="decimal"
                  value={decPrevIncome}
                  onChange={(e) => setDecPrevIncome(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">TDS already deducted</span>
                <input
                  inputMode="decimal"
                  value={decPrevTds}
                  onChange={(e) => setDecPrevTds(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
            </div>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Notes <span className="font-normal text-ink-faint">optional</span>
            </span>
            <textarea
              value={decNotes}
              onChange={(e) => setDecNotes(e.target.value)}
              rows={2}
              className={field}
            />
          </label>

          {decError && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{decError}</p>
          )}
          {decSaved && !decError && (
            <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
              Declaration saved.
            </p>
          )}

          <button
            type="submit"
            disabled={decBusy || !decEmployeeId || !decFyLooksValid}
            className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {decBusy ? "Saving…" : "Save declaration"}
          </button>
        </form>
      </section>
    </div>
  );
}
