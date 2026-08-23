import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { PostPayrollButton } from "@/components/employees/PostPayrollButton";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Payroll runs on the calendar month, same principle as every other
 * statutory-adjacent report in this app. `month` is "YYYY-MM"; defaults to
 * the current calendar month. */
function monthBounds(month?: string): { periodMonth: string; label: string; ym: string } {
  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  let y = ty;
  let m = tm;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    [y, m] = month.split("-").map(Number);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const periodMonth = `${y}-${pad(m)}-01`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { periodMonth, label, ym: `${y}-${pad(m)}` };
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function PayrollRegisterPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/payroll-register">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const { periodMonth, label, ym } = monthBounds(monthParam);

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);

  if (!payrollOn) {
    return (
      <ReportShell title="Payroll register" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">Not turned on for this company</p>
          <p className="mt-1">
            Turn on Payroll first —{" "}
            <Link href={`/${companyId}/settings/modules`} className="underline">
              Settings → Modules
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const [{ data: rows }, { data: posting }, { data: branch }, { data: tdsRows }] = await Promise.all([
    supabase.rpc("get_payroll_run", {
      p_company_id: companyId,
      p_period_month: periodMonth,
    }),
    supabase
      .from("payroll_postings")
      .select("voucher_id, posted_at")
      .eq("company_id", companyId)
      .eq("period_month", periodMonth)
      .maybeSingle(),
    supabase
      .from("branches")
      .select("id")
      .eq("company_id", companyId)
      .order("is_head_office", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.rpc("get_salary_tds_estimate", {
      p_company_id: companyId,
      p_period_month: periodMonth,
    }),
  ]);

  const runs = rows ?? [];
  const tdsEstimates = tdsRows ?? [];
  const totalMonthlyTds = tdsEstimates.reduce((n, r) => n + Number(r.monthly_tds), 0);
  const totals = runs.reduce(
    (acc, r) => ({
      gross: acc.gross + Number(r.gross_pay),
      pfWage: acc.pfWage + Number(r.pf_wage),
      pfEmployee: acc.pfEmployee + Number(r.pf_employee),
      pfEmployer: acc.pfEmployer + Number(r.pf_employer),
      edli: acc.edli + Number(r.edli_employer),
      esiEmployee: acc.esiEmployee + Number(r.esi_employee),
      esiEmployer: acc.esiEmployer + Number(r.esi_employer),
      pt: acc.pt + Number(r.professional_tax),
      tds: acc.tds + Number(r.tds),
      net: acc.net + Number(r.net_pay),
    }),
    {
      gross: 0, pfWage: 0, pfEmployee: 0, pfEmployer: 0, edli: 0,
      esiEmployee: 0, esiEmployer: 0, pt: 0, tds: 0, net: 0,
    }
  );

  // EPF administrative charges (A/c 2) are levied on the ESTABLISHMENT, not
  // per employee — 0.50% of total EPF wages, minimum ₹500 a month — so they
  // have no per-employee column to sit in. Mirrored from post_payroll_run so
  // the register shows the same employer cost the posting will book.
  const adminCharges = totals.pfWage > 0 ? Math.max(Math.round(totals.pfWage * 0.005 * 100) / 100, 500) : 0;
  const prorated = runs.filter((r) => Number(r.days_paid) < Number(r.days_in_month));

  const base = `/${companyId}/reports/payroll-register`;

  return (
    <ReportShell
      title="Payroll register"
      period={posting ? `${label} · posted to the books` : `${label} · computed, not posted to the books`}
      status={{
        label: `${formatINR(totals.net, { showZero: true })} net pay`,
        tone: "ok",
      }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border p-4 text-sm">
        <div className="flex items-center gap-2">
          <Link
            href={`${base}?month=${shiftMonth(ym, -1)}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link
            href={`${base}?month=${shiftMonth(ym, 1)}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            Next →
          </Link>
        </div>
        {posting ? (
          <div className="text-right text-xs text-ink-faint">
            Posted {posting.posted_at?.slice(0, 10)} —{" "}
            <Link href={`/${companyId}/vouchers/${posting.voucher_id}`} className="underline">
              view voucher
            </Link>
          </div>
        ) : (
          runs.length > 0 &&
          branch?.id && (
            <PostPayrollButton
              companyId={companyId}
              branchId={branch.id}
              periodMonth={periodMonth}
              monthLabel={label}
            />
          )
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Employee</th>
              <th className={th + " text-right"}>Days</th>
              <th className={th + " text-right"}>Gross</th>
              <th className={th + " text-right"}>PF wage</th>
              <th className={th + " text-right"}>PF (Emp.)</th>
              <th className={th + " text-right"}>PF (Empr.)</th>
              <th className={th + " text-right"}>EDLI</th>
              <th className={th + " text-right"}>ESI (Emp.)</th>
              <th className={th + " text-right"}>ESI (Empr.)</th>
              <th className={th + " text-right"}>PT</th>
              <th className={th + " text-right"}>TDS</th>
              <th className={th + " text-right"}>Net pay</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-10 text-center text-ink-faint">
                  No employee had an active salary structure this month.
                </td>
              </tr>
            )}
            {runs.map((r) => {
              const partMonth = Number(r.days_paid) < Number(r.days_in_month);
              return (
                <tr key={r.employee_id} className="border-b border-border last:border-0">
                  <td className={td}>{r.employee_name}</td>
                  <td className={num}>
                    {r.days_paid}/{r.days_in_month}
                    {partMonth && <div className="text-xs text-ink-faint">part month</div>}
                  </td>
                  <td className={num}>{formatINR(Number(r.gross_pay), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.pf_wage), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.pf_employee), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.pf_employer), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.edli_employer), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.esi_employee), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.esi_employer), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.professional_tax), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.tds), { showZero: true })}</td>
                  <td className={num + " font-medium"}>{formatINR(Number(r.net_pay), { showZero: true })}</td>
                </tr>
              );
            })}
            {runs.length > 0 && (
              <tr className="bg-bg font-semibold">
                <td className={td}>Total</td>
                <td className={num}>—</td>
                <td className={num}>{formatINR(totals.gross, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.pfWage, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.pfEmployee, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.pfEmployer, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.edli, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.esiEmployee, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.esiEmployer, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.pt, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.tds, { showZero: true })}</td>
                <td className={num}>{formatINR(totals.net, { showZero: true })}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {runs.length > 0 && (
        <div className="border-t border-border px-4 py-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-ink">
              EPF administrative charges (A/c 2) — establishment-level
            </span>
            <span className="font-mono font-medium tabular-nums">
              {formatINR(adminCharges, { showZero: true })}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            0.50% of {formatINR(totals.pfWage, { showZero: true })} total EPF wages
            {adminCharges > totals.pfWage * 0.005 && ", raised to the ₹500 monthly minimum"}.
            Levied on the establishment, not per employee, so it has no column above — but it is
            part of employer cost and is posted with the PF liability.
          </p>
        </div>
      )}

      <div className="border-b border-t border-border p-4">
        <h2 className="font-semibold">Sec 192 — how the TDS above was worked out</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          This is the basis for the TDS column in the register above, which{" "}
          <strong className="font-medium text-ink">is</strong> deducted from net pay and posted to
          TDS Payable (Salary). Annualised gross (this month × 12) less the ₹75,000 standard
          deduction, taxed at new-regime slab rates (Sec 115BAC, which is the default regime — an
          employee must opt out of it), with the same rebate/surcharge/cess logic as the Income tax
          report. Deducting on this basis is what Sec 192 requires when no declaration has been
          made, and not deducting at all is a Sec 201(1) default — but it remains an estimate: it
          ignores HRA exemption, Chapter VI-A declarations (80C/80D/80CCD), other income the
          employee has declared, and tax already withheld by a previous employer this year. For
          anyone with real deductions it will over-withhold until this app can record their
          declaration. Two guards are applied: the deduction is never more than the month can bear
          after PF, ESI and PT, and it is not reduced for a mid-year joiner (the projection still
          assumes twelve full months).
        </p>
      </div>
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Employee</th>
            <th className={th + " text-right"}>Annualised gross</th>
            <th className={th + " text-right"}>Taxable salary income</th>
            <th className={th + " text-right"}>Annual tax</th>
            <th className={th + " text-right"}>Monthly TDS estimate</th>
          </tr>
        </thead>
        <tbody>
          {tdsEstimates.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-ink-faint">
                No employee had an active salary structure this month.
              </td>
            </tr>
          )}
          {tdsEstimates.map((r) => (
            <tr key={r.employee_id} className="border-b border-border last:border-0">
              <td className={td}>{r.employee_name}</td>
              <td className={num}>{formatINR(Number(r.annual_projected_gross), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.taxable_salary_income), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.annual_tax), { showZero: true })}</td>
              <td className={num + " font-medium"}>{formatINR(Number(r.monthly_tds), { showZero: true })}</td>
            </tr>
          ))}
          {tdsEstimates.length > 0 && (
            <tr className="bg-bg font-semibold">
              <td className={td} colSpan={4}>
                Total monthly TDS estimate
              </td>
              <td className={num}>{formatINR(totalMonthlyTds, { showZero: true })}</td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        PF: 12%/12% of PF wage, which is <strong className="font-medium text-ink">basic + DA</strong>{" "}
        capped at ₹15,000 unless an employee&rsquo;s structure waives the ceiling. EDLI (A/c 21) adds
        a further 0.50% of PF wage to employer cost, capped at ₹75 per member; EPF administrative
        charges (A/c 2) are shown separately above because they are levied on the establishment, not
        per employee. A/c 22 is nil and has been since April 2017. ESI: 0.75%/3.25% of gross, and
        eligibility is tested against the <em>full month&rsquo;s</em> wage rate rather than
        part-month pay, so a high earner joining late in the month does not become ESI-eligible by
        accident. Professional tax is whatever was entered on the employee&rsquo;s own salary
        structure — not computed from a state slab table, since PT varies by state and several
        states don&rsquo;t levy it at all; it is a fixed monthly amount, so it is not prorated.{" "}
        {prorated.length > 0 ? (
          <>
            {prorated.length === 1 ? "One employee is" : `${prorated.length} employees are`} paid for
            part of this month only — pay is prorated by days in employment, and the PF wage ceiling
            is prorated with it.{" "}
          </>
        ) : (
          <>
            Pay is prorated by days in employment for mid-month joiners and leavers.{" "}
          </>
        )}
        Attendance and loss-of-pay days are <em>not</em> tracked — proration reflects only the
        joining and leaving dates on record.{" "}
        {posting ? (
          <>
            Posted as a single journal voucher (Dr Salary Expense + Employer PF Contribution
            including EDLI and admin charges + Employer ESI Contribution, Cr PF/ESI/Professional Tax
            Payable + TDS Payable (Salary) + Salaries Payable) — one aggregate liability ledger, not
            one per employee. A correction needs a manual reversing entry; there is no unpost action.
          </>
        ) : (
          <>
            Not yet posted — nothing here has touched a ledger. Posting creates one journal voucher
            for the whole month&rsquo;s totals, not a line per employee.
          </>
        )}
      </p>
    </ReportShell>
  );
}
