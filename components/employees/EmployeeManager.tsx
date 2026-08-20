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

// Mirrors app_private.is_valid_pan exactly.
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function EmployeeManager({
  companyId,
  employees,
}: {
  companyId: string;
  employees: Employee[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pan, setPan] = useState("");
  const [uan, setUan] = useState("");
  const [esiNumber, setEsiNumber] = useState("");
  const [dateOfJoining, setDateOfJoining] = useState("");
  const [basic, setBasic] = useState("0");
  const [hra, setHra] = useState("0");
  const [specialAllowance, setSpecialAllowance] = useState("0");
  const [otherAllowance, setOtherAllowance] = useState("0");
  const [pfApplicable, setPfApplicable] = useState(true);
  const [pfWageCeilingApplies, setPfWageCeilingApplies] = useState(true);
  const [esiApplicable, setEsiApplicable] = useState(true);
  const [professionalTax, setProfessionalTax] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panLooksValid = pan.length === 0 || PAN_PATTERN.test(pan);

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
                <th className="px-4 py-2.5 text-right font-medium">Current gross</th>
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-ink-faint">
                    No employees yet. Add one on the right.
                  </td>
                </tr>
              )}
              {employees.map((emp) => (
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
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                    {emp.current_gross != null ? (
                      formatINR(emp.current_gross)
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New employee</h2>
        <p className="mt-1 text-xs text-ink-faint">
          Creates the employee and their starting salary structure together,
          effective from the date of joining. Editing a salary later needs a
          new structure row — not yet a form here.
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
              PF applicable (12%/12% on basic)
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
    </div>
  );
}
