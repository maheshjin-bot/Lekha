import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 31 March of the calendar April-March accounting year containing today's
 * local date — same rule get_tax_depreciation_blocks, get_deferred_tax_
 * reconciliation and now get_statutory_bonus_computation all use, and for
 * the same reason: the underlying functions call get_income_tax_computation
 * and get_tax_depreciation_blocks, which always run the calendar year.
 */
function currentFyEnd(): string {
  const today = todayLocal();
  const [y, m] = today.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return `${startYear + 1}-03-31`;
}

function isFyEnd(date: string): boolean {
  return /^\d{4}-03-31$/.test(date);
}

function shiftFyEnd(fyEnd: string, deltaYears: number): string {
  const year = Number(fyEnd.slice(0, 4)) + deltaYears;
  return `${year}-03-31`;
}

function formatDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

type EmployeeRow = {
  employee_id: string;
  employee_name: string;
  date_of_joining: string;
  date_of_leaving: string | null;
  days_employed_in_fy: number;
  full_year_employment: boolean;
  monthly_wage_rate: number | null;
  eligible: boolean;
  ineligibility_reason: string | null;
  annual_salary_wage_earned: number;
  annual_calculation_wage: number;
  minimum_bonus: number | null;
  minimum_bonus_floor_applied: boolean;
  maximum_bonus_at_20pct: number | null;
};

type SurplusRow = {
  fy_start: string;
  fy_end: string;
  entity_type: string;
  headcount_this_fy: number;
  act_applicable_by_headcount: boolean;
  eligible_employee_count: number;
  total_annual_calculation_wage: number;
  total_minimum_bonus: number;
  total_maximum_bonus_at_20pct: number;
  surplus_computable: boolean;
  book_profit: number | null;
  book_depreciation_addback: number | null;
  tax_depreciation_deduction: number | null;
  estimated_direct_tax: number | null;
  available_surplus_approx: number | null;
  allocable_surplus_percent: number | null;
  allocable_surplus_approx: number | null;
  surplus_covers_minimum_bonus: boolean | null;
  affordable_bonus_percent_approx: number | null;
  note: string;
};

export default async function StatutoryBonusPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/statutory-bonus">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const fyEnd = typeof sp.fy_end === "string" && isFyEnd(sp.fy_end) ? sp.fy_end : currentFyEnd();
  const fyStart = `${Number(fyEnd.slice(0, 4)) - 1}-04-01`;
  const label = `${Number(fyEnd.slice(0, 4)) - 1}-${fyEnd.slice(2, 4)}`;

  const [{ data: empRows, error: empError }, { data: surplusRows }] = await Promise.all([
    supabase.rpc("get_statutory_bonus_computation", { p_company_id: companyId, p_fy_end: fyEnd }),
    supabase.rpc("get_statutory_bonus_surplus_estimate", { p_company_id: companyId, p_fy_end: fyEnd }),
  ]);

  const employees = (empRows ?? []) as EmployeeRow[];
  const surplus = (surplusRows?.[0] ?? null) as SurplusRow | null;
  const eligible = employees.filter((e) => e.eligible);
  const ineligible = employees.filter((e) => !e.eligible);

  const period = `FY ${label} · ${fyStart} to ${fyEnd} · calendar April-March accounting year`;

  return (
    <ReportShell
      title="Statutory bonus"
      period={period}
      status={
        empError
          ? { label: "Query failed", tone: "bad" }
          : surplus?.act_applicable_by_headcount
            ? { label: "Establishment covered (20+ employees)", tone: "warn" }
            : { label: `Below 20-employee threshold (${surplus?.headcount_this_fy ?? 0} this FY)`, tone: "ok" }
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 text-sm print:hidden">
        <div className="flex gap-2">
          <a
            href={`?fy_end=${shiftFyEnd(fyEnd, -1)}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            ← FY {Number(label.slice(0, 4)) - 1}-{String(Number(label.slice(0, 4)) % 100).padStart(2, "0")}
          </a>
          <a
            href={`?fy_end=${shiftFyEnd(fyEnd, 1)}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            FY {Number(label.slice(0, 4)) + 1}-{String((Number(label.slice(0, 4)) + 2) % 100).padStart(2, "0")} →
          </a>
        </div>
        <span className="text-xs text-ink-faint">Year ending {formatDate(fyEnd)}</span>
      </div>

      <div className="border-b border-border bg-warning-soft px-4 py-3 text-xs text-ink">
        Statutory bonus is now governed by the <strong>Code on Wages 2019</strong> (Chapter IV, Sec
        26-36), which repealed and replaced the Payment of Bonus Act, 1965 with effect from 21 Nov
        2025 — the section numbers below are the current Code&rsquo;s, not the old Act&rsquo;s.
        Minimum bonus figures on this report are computed with full confidence from this
        app&rsquo;s own employee and salary data. The allocable-surplus section further down is an
        <strong> approximation</strong>, clearly marked — see its own note.
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4">
        {[
          { label: "Employed this FY", value: String(surplus?.headcount_this_fy ?? 0) },
          { label: "Eligible for bonus", value: String(surplus?.eligible_employee_count ?? 0) },
          {
            label: "Minimum bonus owed (exact)",
            value: formatINR(Number(surplus?.total_minimum_bonus ?? 0), { showZero: true }),
          },
          {
            label: "Absolute max at 20% (Sec 26(3))",
            value: formatINR(Number(surplus?.total_maximum_bonus_at_20pct ?? 0), { showZero: true }),
          },
        ].map((k) => (
          <div key={k.label} className="bg-surface p-4">
            <div className="text-xs text-ink-faint">{k.label}</div>
            <div className="mt-1 text-lg font-semibold text-ink">{k.value}</div>
          </div>
        ))}
      </div>

      <div className="px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">
          Eligible employees — minimum bonus (Sec 26/27)
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Wage = basic + dearness allowance only (Sec 2(y)) — HRA, other allowances, overtime and
          employer PF are excluded, per the Code&rsquo;s own definition. Calculation wage is capped
          at Rs 7,000/month (Sec 26(2)) unless a higher minimum wage applies for the scheduled
          employment, which LEKHA does not track (same gap as Professional Tax slabs). Eligibility
          tests the actual monthly rate against Rs 21,000 and requires at least 30 days employed in
          the year (a proxy for &ldquo;worked&rdquo; — no attendance data exists).
        </p>
      </div>
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Employee</th>
            <th className={th + " text-right"}>Days employed</th>
            <th className={th + " text-right"}>Monthly rate</th>
            <th className={th + " text-right"}>Calc. wage (annual)</th>
            <th className={th + " text-right"}>Minimum bonus</th>
            <th className={th + " text-right"}>Max at 20%</th>
          </tr>
        </thead>
        <tbody>
          {eligible.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-ink-faint">
                No employee is eligible for statutory bonus this year.
              </td>
            </tr>
          )}
          {eligible.map((e) => (
            <tr key={e.employee_id} className="border-b border-border last:border-0">
              <td className={td}>
                {e.employee_name}
                {!e.full_year_employment && (
                  <div className="mt-0.5 text-xs text-ink-faint">
                    Partial year — Rs 100 floor not applicable (Sec 27)
                  </div>
                )}
                {e.minimum_bonus_floor_applied && (
                  <div className="mt-0.5 text-xs text-ink-faint">Rs 100 floor applied</div>
                )}
              </td>
              <td className={num}>{e.days_employed_in_fy}</td>
              <td className={num}>{formatINR(Number(e.monthly_wage_rate ?? 0), { showZero: true })}</td>
              <td className={num}>{formatINR(e.annual_calculation_wage, { showZero: true })}</td>
              <td className={num + " font-medium"}>
                {formatINR(Number(e.minimum_bonus ?? 0), { showZero: true })}
              </td>
              <td className={num}>{formatINR(Number(e.maximum_bonus_at_20pct ?? 0), { showZero: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {ineligible.length > 0 && (
        <>
          <div className="border-t border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Not eligible this year</h2>
          </div>
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Employee</th>
                <th className={th}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {ineligible.map((e) => (
                <tr key={e.employee_id} className="border-b border-border last:border-0">
                  <td className={td}>{e.employee_name}</td>
                  <td className={td + " text-ink-soft"}>{e.ineligibility_reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">
          Allocable surplus — approximate (Sec 31-35)
        </h2>
      </div>
      {!surplus || !surplus.surplus_computable ? (
        <p className="px-4 py-6 text-sm text-ink-faint">
          {surplus?.note ??
            "Company not found or the underlying income tax computation is not applicable to this entity type."}
        </p>
      ) : (
        <>
          <table className="w-full min-w-[600px] text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className={td}>Book profit for the year</td>
                <td className={num}>{formatINR(Number(surplus.book_profit), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>+ Book depreciation added back</td>
                <td className={num}>
                  {formatINR(Number(surplus.book_depreciation_addback), { showZero: true })}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>− Tax depreciation (Sec 34(a))</td>
                <td className={num}>
                  {formatINR(Number(surplus.tax_depreciation_deduction), { showZero: true })}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>− Estimated direct tax (Sec 34(c)/35, approx.)</td>
                <td className={num}>{formatINR(Number(surplus.estimated_direct_tax), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " font-medium"}>= Available surplus (approx.)</td>
                <td className={num + " font-medium"}>
                  {formatINR(Number(surplus.available_surplus_approx), { showZero: true })}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>× Allocable surplus % (Sec 31 — non-banking establishment)</td>
                <td className={num}>{surplus.allocable_surplus_percent}%</td>
              </tr>
              <tr>
                <td className={td + " font-medium"}>= Allocable surplus (approx.)</td>
                <td className={num + " font-medium"}>
                  {formatINR(Number(surplus.allocable_surplus_approx), { showZero: true })}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="border-t border-border p-4">
            <Badge tone={surplus.surplus_covers_minimum_bonus ? "ok" : "warn"}>
              {surplus.surplus_covers_minimum_bonus
                ? `Approximate surplus covers the minimum bonus — affordable rate up to ${surplus.affordable_bonus_percent_approx}% (still capped at 20%)`
                : "Approximate surplus falls short of the minimum bonus — minimum is still owed regardless (Sec 26(1)); a real shortfall would ordinarily draw on Sec 36 set-on carried forward from prior years, which this app cannot compute (see note below)"}
            </Badge>
          </div>
        </>
      )}
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">{surplus?.note}</p>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Report-only — nothing here posts a voucher. If the minimum bonus is accrued but not yet
        paid, journal it yourself and flag that ledger&rsquo;s Sec 43B category as
        &ldquo;Bonus or commission&rdquo; from the Ledgers page, so it is picked up by the tax audit
        report&rsquo;s Clause 26 — that machinery already exists and needed no change for this
        report. Not modelled: Sec 29 disqualification (dismissal for fraud/violence/theft/
        sabotage/sexual-harassment conviction — no termination-reason data exists), Sec 26(6)-(9)
        new-establishment relief (no incorporation date on file for any company), and every Sec 34
        gross-profit adjustment unrelated to depreciation or direct tax.
      </p>
    </ReportShell>
  );
}
