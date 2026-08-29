"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";

/**
 * Add/list/delete for employee_perquisites (migration 0650) — a sibling to
 * EmployeeManager.tsx, not a change to it (this batch's off-limits-file
 * rule). "employee_perquisites" is queried via the `as any` escape hatch
 * (grep components/sbo/SBOManager.tsx for the same idiom) because the table
 * is newer than types/database.types.ts, which this batch does not
 * regenerate.
 */

type ValuedRow = {
  perquisite_id: string;
  perquisite_type: "accommodation" | "car" | "other";
  months_applicable: number;
  accommodation_ownership: "employer_owned" | "employer_leased" | null;
  city_population_tier: "above_40_lakh" | "15_to_40_lakh" | "below_15_lakh" | null;
  car_cc_class: "up_to_1600cc_or_ev" | "above_1600cc" | null;
  car_usage: "official" | "personal" | "mixed" | null;
  running_cost_borne_by: "employer" | "employee" | null;
  driver_provided: boolean;
  other_perquisite_description: string | null;
  amount_recovered_from_employee: number;
  rule_salary_base: number;
  taxable_value: number;
  computation_note: string | null;
};

const field =
  "field rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent";

const TIER_LABEL: Record<string, string> = {
  above_40_lakh: "> 40 lakh (2011 census)",
  "15_to_40_lakh": "15–40 lakh",
  below_15_lakh: "< 15 lakh",
};

const CC_LABEL: Record<string, string> = {
  up_to_1600cc_or_ev: "≤ 1.6L or EV",
  above_1600cc: "> 1.6L",
};

function rowDescription(r: ValuedRow): string {
  if (r.perquisite_type === "accommodation") {
    const own = r.accommodation_ownership === "employer_owned" ? "Employer-owned" : "Employer-leased";
    return `${own}, ${TIER_LABEL[r.city_population_tier ?? ""] ?? "—"}`;
  }
  if (r.perquisite_type === "car") {
    const cc = CC_LABEL[r.car_cc_class ?? ""] ?? "—";
    const usage = r.car_usage ?? "—";
    const bearer = r.running_cost_borne_by ? `, ${r.running_cost_borne_by} bears running cost` : "";
    const driver = r.driver_provided ? ", driver" : "";
    return `${cc}, ${usage} use${bearer}${driver}`;
  }
  return r.other_perquisite_description ?? "Other benefit";
}

export function EmployeePerquisitesManager({
  companyId,
  employeeId,
  employeeName,
  financialYearLabel,
  rows,
}: {
  companyId: string;
  employeeId: string;
  employeeName: string;
  financialYearLabel: string;
  rows: ValuedRow[];
}) {
  const router = useRouter();

  const [perquisiteType, setPerquisiteType] = useState<"accommodation" | "car" | "other">("accommodation");
  const [monthsApplicable, setMonthsApplicable] = useState("12");
  const [amountRecovered, setAmountRecovered] = useState("0");

  const [accommodationOwnership, setAccommodationOwnership] = useState<"employer_owned" | "employer_leased">(
    "employer_owned"
  );
  const [cityPopulationTier, setCityPopulationTier] = useState<"above_40_lakh" | "15_to_40_lakh" | "below_15_lakh">(
    "above_40_lakh"
  );
  const [leaseRent, setLeaseRent] = useState("0");

  const [carCcClass, setCarCcClass] = useState<"up_to_1600cc_or_ev" | "above_1600cc">("up_to_1600cc_or_ev");
  const [carUsage, setCarUsage] = useState<"official" | "personal" | "mixed">("mixed");
  const [runningCostBorneBy, setRunningCostBorneBy] = useState<"employer" | "employee">("employer");
  const [driverProvided, setDriverProvided] = useState(false);
  const [carIsHired, setCarIsHired] = useState(false);
  const [carActualCostOrHire, setCarActualCostOrHire] = useState("0");
  const [actualRunningCost, setActualRunningCost] = useState("0");
  const [driverSalary, setDriverSalary] = useState("0");

  const [otherDescription, setOtherDescription] = useState("");
  const [otherCost, setOtherCost] = useState("0");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const base = {
      company_id: companyId,
      employee_id: employeeId,
      financial_year_label: financialYearLabel,
      perquisite_type: perquisiteType,
      months_applicable: Number(monthsApplicable) || 12,
      amount_recovered_from_employee: Number(amountRecovered) || 0,
    };

    const payload =
      perquisiteType === "accommodation"
        ? {
            ...base,
            accommodation_ownership: accommodationOwnership,
            city_population_tier: cityPopulationTier,
            lease_rent_paid_by_employer:
              accommodationOwnership === "employer_leased" ? Number(leaseRent) || 0 : 0,
          }
        : perquisiteType === "car"
          ? {
              ...base,
              car_cc_class: carCcClass,
              car_usage: carUsage,
              running_cost_borne_by: carUsage === "mixed" ? runningCostBorneBy : null,
              driver_provided: driverProvided,
              car_is_hired: carUsage === "personal" ? carIsHired : false,
              car_actual_cost_or_hire_charges: carUsage === "personal" ? Number(carActualCostOrHire) || 0 : 0,
              actual_running_maintenance_cost: carUsage === "personal" ? Number(actualRunningCost) || 0 : 0,
              driver_salary_paid_by_employer: carUsage === "personal" ? Number(driverSalary) || 0 : 0,
            }
          : {
              ...base,
              other_perquisite_description: otherDescription.trim() || null,
              other_cost_to_employer: Number(otherCost) || 0,
            };

    const supabase = createClient();
    // payload's shape is a discriminated union (accommodation/car/other each
    // carry a different subset of fields) that TypeScript can't line up
    // against the generated Insert type's single flat shape — cast narrowed
    // to `never` rather than `any`, matching the established idiom elsewhere
    // in this codebase (e.g. GstTdsTcsSufferedManager.tsx's own insert).
    const { error: insertError } = await supabase.from("employee_perquisites").insert(payload as never);

    if (insertError) {
      setError(insertError.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    setOtherDescription("");
    router.refresh();
  }

  async function onDelete(id: string) {
    if (!window.confirm("Remove this perquisite row?")) return;
    const supabase = createClient();
    await supabase.from("employee_perquisites").delete().eq("id", id).eq("company_id", companyId);
    router.refresh();
  }

  return (
    <div className="mt-6 space-y-6">
      <div>
        <h2 className="font-semibold text-ink">
          Recorded for {employeeName || "this employee"}, FY {financialYearLabel}
        </h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-faint">No perquisites recorded for this employee/year yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-left">
                  <th className="px-3 py-2 font-medium text-ink-faint">Type</th>
                  <th className="px-3 py-2 font-medium text-ink-faint">Detail</th>
                  <th className="px-3 py-2 font-medium text-ink-faint">Months</th>
                  <th className="px-3 py-2 text-right font-medium text-ink-faint">Taxable value</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.perquisite_id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      <Badge tone="neutral">{r.perquisite_type}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div>{rowDescription(r)}</div>
                      {r.computation_note && (
                        <div className="mt-0.5 text-xs text-ink-faint">{r.computation_note}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{r.months_applicable}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatINR(r.taxable_value, { showZero: true })}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onDelete(r.perquisite_id)}
                        className="text-xs text-error hover:underline"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="rounded-lg border border-border bg-surface p-4">
        <h2 className="font-semibold text-ink">Record a perquisite</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-ink-faint">Type</label>
            <select
              value={perquisiteType}
              onChange={(e) => setPerquisiteType(e.target.value as typeof perquisiteType)}
              className={field}
            >
              <option value="accommodation">Accommodation</option>
              <option value="car">Company car</option>
              <option value="other">Other benefit</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-ink-faint">
              Months applicable this FY
            </label>
            <input
              type="number"
              min={1}
              max={12}
              value={monthsApplicable}
              onChange={(e) => setMonthsApplicable(e.target.value)}
              className={field}
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-ink-faint">
              Amount recovered from employee
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={amountRecovered}
              onChange={(e) => setAmountRecovered(e.target.value)}
              className={field}
            />
          </div>
        </div>

        {perquisiteType === "accommodation" && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-ink-faint">Ownership</label>
              <select
                value={accommodationOwnership}
                onChange={(e) => setAccommodationOwnership(e.target.value as typeof accommodationOwnership)}
                className={field}
              >
                <option value="employer_owned">Employer-owned</option>
                <option value="employer_leased">Employer-leased / rented</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-ink-faint">
                City population tier (2011 census)
              </label>
              <select
                value={cityPopulationTier}
                onChange={(e) => setCityPopulationTier(e.target.value as typeof cityPopulationTier)}
                className={field}
              >
                <option value="above_40_lakh">Above 40 lakh (e.g. Mumbai, Delhi, Bengaluru)</option>
                <option value="15_to_40_lakh">15–40 lakh</option>
                <option value="below_15_lakh">Below 15 lakh</option>
              </select>
              <p className="mt-1 text-[11px] text-ink-faint">
                Classify the city yourself — this app has no city/population lookup.
              </p>
            </div>
            {accommodationOwnership === "employer_leased" && (
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-ink-faint">
                  Annual lease rent paid by employer
                </label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={leaseRent}
                  onChange={(e) => setLeaseRent(e.target.value)}
                  className={field}
                />
              </div>
            )}
          </div>
        )}

        {perquisiteType === "car" && (
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-ink-faint">Engine class</label>
                <select
                  value={carCcClass}
                  onChange={(e) => setCarCcClass(e.target.value as typeof carCcClass)}
                  className={field}
                >
                  <option value="up_to_1600cc_or_ev">≤ 1.6 litre, or electric</option>
                  <option value="above_1600cc">Above 1.6 litre</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-ink-faint">Usage</label>
                <select value={carUsage} onChange={(e) => setCarUsage(e.target.value as typeof carUsage)} className={field}>
                  <option value="mixed">Partly official, partly personal</option>
                  <option value="personal">Wholly personal</option>
                  <option value="official">Wholly official (documented)</option>
                </select>
              </div>
              <div className="flex items-end gap-2 pb-2">
                <input
                  id="driver"
                  type="checkbox"
                  checked={driverProvided}
                  onChange={(e) => setDriverProvided(e.target.checked)}
                />
                <label htmlFor="driver" className="text-sm text-ink">
                  Driver provided
                </label>
              </div>
            </div>

            {carUsage === "mixed" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-[11px] uppercase tracking-wide text-ink-faint">
                    Running &amp; maintenance cost borne by
                  </label>
                  <select
                    value={runningCostBorneBy}
                    onChange={(e) => setRunningCostBorneBy(e.target.value as typeof runningCostBorneBy)}
                    className={field}
                  >
                    <option value="employer">Employer</option>
                    <option value="employee">Employee</option>
                  </select>
                </div>
              </div>
            )}

            {carUsage === "personal" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <input
                    id="hired"
                    type="checkbox"
                    checked={carIsHired}
                    onChange={(e) => setCarIsHired(e.target.checked)}
                  />
                  <label htmlFor="hired" className="text-sm text-ink">
                    Car is hired, not owned by the employer
                  </label>
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wide text-ink-faint">
                    {carIsHired ? "Annual hire charges paid" : "Car's actual cost (for 10% p.a. wear-and-tear)"}
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={carActualCostOrHire}
                    onChange={(e) => setCarActualCostOrHire(e.target.value)}
                    className={field}
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wide text-ink-faint">
                    Annual running/maintenance cost borne by employer
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={actualRunningCost}
                    onChange={(e) => setActualRunningCost(e.target.value)}
                    className={field}
                  />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wide text-ink-faint">
                    Annual driver salary paid by employer
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={driverSalary}
                    onChange={(e) => setDriverSalary(e.target.value)}
                    className={field}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {perquisiteType === "other" && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-ink-faint">Description</label>
              <input
                type="text"
                value={otherDescription}
                onChange={(e) => setOtherDescription(e.target.value)}
                placeholder="e.g. club membership"
                className={field}
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-ink-faint">Cost to employer</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={otherCost}
                onChange={(e) => setOtherCost(e.target.value)}
                className={field}
              />
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-error">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Add perquisite"}
        </button>
      </form>
    </div>
  );
}
