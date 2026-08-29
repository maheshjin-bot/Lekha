import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

/**
 * Form 16 Part B (Form 130 Part C from FY 2026-27 — see migration 0205's own
 * header for the full statutory research) — the employer-prepared salary and
 * tax computation annexure for one employee, one financial year.
 *
 * Deliberately NOT Part A, Form 16A, or Form 27D: those are TRACES-generated
 * documents carrying TRACES' own digital signature, and this app has no
 * TRACES access — a look-alike would not be a valid certificate. This page
 * is the OTHER half: the computation the employer itself is responsible for,
 * fully derivable from data this app already owns (get_payroll_run, 0075;
 * employee_tax_declarations, 0093).
 */

const field =
  "field rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent";

type EmployeeOption = { id: string; name: string; pan: string | null };

type Form16PartBRow = {
  employee_id: string;
  employee_name: string;
  pan: string | null;
  financial_year_label: string;
  period_from: string;
  period_to: string;
  is_fy_complete: boolean;
  form_label: string;
  months_with_payroll_data: number;
  basic_total: number;
  dearness_allowance_total: number;
  hra_total: number;
  special_allowance_total: number;
  other_allowance_total: number;
  gross_salary: number;
  perquisites_value: number;
  professional_tax_total: number;
  declaration_exists: boolean;
  declared_regime: "old" | "new" | null;
  regime_used: "old" | "new";
  declaration_date: string | null;
  hra_exemption_claimed: number;
  deduction_80c_claimed: number;
  deduction_80c_allowed: number;
  deduction_80d_claimed: number;
  deduction_80d_allowed: number;
  home_loan_interest_24b_claimed: number;
  home_loan_interest_24b_allowed: number;
  previous_employer_income: number;
  previous_employer_tds_deducted: number;
  old_income_chargeable_salary: number;
  old_gross_total_income: number;
  old_chapter_via_deductions: number;
  old_taxable_income: number;
  old_tax_before_rebate: number;
  old_rebate_87a: number;
  old_surcharge: number;
  old_cess: number;
  old_net_tax_payable: number;
  new_income_chargeable_salary: number;
  new_taxable_income: number;
  new_tax_before_rebate: number;
  new_rebate_87a: number;
  new_surcharge: number;
  new_cess: number;
  new_net_tax_payable: number;
  net_tax_payable: number;
  tds_deposited_per_payroll_projection: number;
};

/** The FY label ("2026-27") containing today, book-year-independent — same
 * Apr-Mar grain employee_tax_declarations (0093) and get_form16_partb (0205)
 * both use. A tiny local copy rather than importing tdsReturnQuarters.ts's
 * own version, which is bundled with quarter/challan logic this page has no
 * use for. */
function currentFinancialYearLabel(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const fyStart = m >= 4 ? y : y - 1;
  return `${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`;
}

function RegimeCell({ value, highlight }: { value: number; highlight: boolean }) {
  return (
    <td className={num + (highlight ? " font-semibold text-accent" : "")}>
      {formatINR(value, { showZero: true })}
    </td>
  );
}

export default async function Form16PartBPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/form16-partb">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const fy =
    typeof sp.fy === "string" && /^\d{4}-\d{2}$/.test(sp.fy) ? sp.fy : currentFinancialYearLabel();

  const [{ data: modules }, { data: employeeRows }, { data: company }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase.from("employees").select("id, name, pan").eq("company_id", companyId).order("name"),
    supabase.from("companies").select("name, legal_name, pan, tan").eq("id", companyId).maybeSingle(),
  ]);

  const payrollOn = (modules ?? []).some((m) => m.code === "payroll" && m.active);
  const employees = (employeeRows ?? []) as EmployeeOption[];

  if (!payrollOn) {
    return (
      <ReportShell title="Form 16 Part B" period="—">
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">Payroll is not turned on for this company</p>
          <p className="mt-1">
            Turn it on first —{" "}
            <Link href={`/${companyId}/settings/modules`} className="underline">
              Settings → Modules
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  if (employees.length === 0) {
    return (
      <ReportShell title="Form 16 Part B" period="—">
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">No employees on file</p>
          <p className="mt-1">Add an employee before generating this certificate.</p>
        </div>
      </ReportShell>
    );
  }

  const selectedEmployeeId =
    typeof sp.emp === "string" && employees.some((e) => e.id === sp.emp) ? sp.emp : employees[0].id;

  const { data: rows } = await callRpc<
    { p_company_id: string; p_employee_id: string; p_financial_year_label: string },
    Form16PartBRow[]
  >(supabase, "get_form16_partb", {
    p_company_id: companyId,
    p_employee_id: selectedEmployeeId,
    p_financial_year_label: fy,
  });

  const r = (rows ?? [])[0] ?? null;
  const isOld = r?.regime_used === "old";

  return (
    <ReportShell
      title={r?.form_label ?? "Form 16 Part B"}
      period={`FY ${fy} · ${r?.period_from ?? ""} to ${r?.period_to ?? ""} · prep computation, not a signed certificate`}
      status={
        r
          ? {
              label: `${formatINR(r.net_tax_payable, { showZero: true })} net tax payable — ${r.regime_used} regime${!r.declaration_exists ? " (defaulted)" : ""}`,
              tone: r.is_fy_complete ? "ok" : "warn",
            }
          : undefined
      }
    >
      <form method="get" className="flex flex-wrap items-end gap-3 border-b border-border p-4 text-sm">
        <div>
          <label htmlFor="emp" className="block text-[11px] uppercase tracking-wide text-ink-faint">
            Employee
          </label>
          <select id="emp" name="emp" defaultValue={selectedEmployeeId} className={field}>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.pan ? ` (${e.pan})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="fy" className="block text-[11px] uppercase tracking-wide text-ink-faint">
            Financial year
          </label>
          <input id="fy" name="fy" type="text" defaultValue={fy} placeholder="2026-27" className={field + " w-28"} />
        </div>
        <button type="submit" className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:bg-surface-2">
          Go
        </button>
      </form>

      <div className="grid grid-cols-1 gap-3 border-b border-border p-4 text-sm sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Employer</div>
          <div className="font-medium">{company?.legal_name || company?.name || "—"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Employer PAN / TAN</div>
          <div className="font-mono">
            {company?.pan || <span className="text-error">not set</span>} /{" "}
            {company?.tan || <span className="text-error">not set</span>}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Employee</div>
          <div className="font-medium">{r?.employee_name ?? "—"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Employee PAN</div>
          <div className="font-mono">{r?.pan || <span className="text-error">not on file</span>}</div>
        </div>
      </div>

      {!r ? (
        <div className="border-b border-border bg-warning-soft p-4 text-sm text-warning">
          Nothing to show for this financial year label. Use the &ldquo;YYYY-YY&rdquo; shape (e.g. 2026-27).
        </div>
      ) : (
        <>
          {!r.is_fy_complete && (
            <div className="border-b border-border bg-warning-soft p-4 text-xs text-warning">
              FY {fy} is still in progress (ends {r.period_to}) — every figure below projects the employee&rsquo;s{" "}
              <strong className="font-medium">current</strong> salary structure across all 12 months, the same
              steady-state simplification get_salary_tds_estimate (0049) already uses. Treat this as a working
              estimate; issue the real certificate only once the FY has actually ended and every month&rsquo;s payroll
              is posted.
            </div>
          )}

          {!r.declaration_exists && (
            <div className="border-b border-border bg-warning-soft p-4 text-xs text-warning">
              No Sec 115BAC(1A) declaration on file for this employee for FY {fy} — defaulting to the{" "}
              <strong className="font-medium">new regime</strong> under CBDT Circular 4/2023 (silence is not neutral;
              it is itself the fact that sets the default). No Chapter VI-A deductions are applied. The old-regime
              column below is still shown as a what-if comparison.
            </div>
          )}

          <div className="border-b border-t border-border p-4">
            <h2 className="font-semibold">Gross salary — {r.months_with_payroll_data} of 12 months on payroll</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Summed from get_payroll_run (0075) across every month of the FY, not a flat 12x projection — a mid-year
              joiner, leaver or salary revision is reflected exactly as payroll actually paid it.
            </p>
          </div>
          <table className="w-full min-w-[640px] text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className={td}>Basic</td>
                <td className={num}>{formatINR(r.basic_total, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Dearness allowance</td>
                <td className={num}>{formatINR(r.dearness_allowance_total, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>House rent allowance</td>
                <td className={num}>{formatINR(r.hra_total, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Special allowance</td>
                <td className={num}>{formatINR(r.special_allowance_total, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Other allowance</td>
                <td className={num}>{formatINR(r.other_allowance_total, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>
                  Value of perquisites u/s 17(2)
                  <div className="text-xs font-normal text-ink-faint">
                    From accommodation/company-car/other rows recorded at{" "}
                    <Link href={`/${companyId}/employees/perquisites?emp=${selectedEmployeeId}&fy=${fy}`} className="underline">
                      Employees → Perquisites
                    </Link>{" "}
                    (Rule 15/old Rule 3, migration 0650). Still not folded into gross salary or the tax computed
                    below — see that page&rsquo;s own note. ESOP and any perquisite type not recorded there is not
                    captured; 0 there means &ldquo;not recorded,&rdquo; not a confirmed absence.
                  </div>
                </td>
                <td className={num}>{formatINR(r.perquisites_value, { showZero: true })}</td>
              </tr>
              <tr className="bg-bg font-semibold">
                <td className={td}>Gross salary</td>
                <td className={num}>{formatINR(r.gross_salary, { showZero: true })}</td>
              </tr>
            </tbody>
          </table>

          <div className="border-b border-t border-border p-4">
            <h2 className="font-semibold">Sec 115BAC(1A) declaration on file</h2>
            <p className="mt-0.5 text-xs text-ink-faint">employee_tax_declarations (0093), FY {fy}.</p>
          </div>
          <table className="w-full min-w-[720px] text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className={td}>Regime declared</td>
                <td className={td}>
                  {r.declared_regime ? (
                    <Badge tone={r.declared_regime === "old" ? "warn" : "neutral"}>{r.declared_regime}</Badge>
                  ) : (
                    <span className="text-xs text-ink-faint">not declared → new (default)</span>
                  )}
                  {r.declaration_date && <span className="ml-2 text-xs text-ink-faint">on {r.declaration_date}</span>}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>HRA exemption claimed (u/s 10(13A), old regime only)</td>
                <td className={num}>{formatINR(r.hra_exemption_claimed, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>
                  80C claimed / allowed
                  <div className="text-xs font-normal text-ink-faint">Capped at ₹1,50,000.</div>
                </td>
                <td className={num}>
                  {formatINR(r.deduction_80c_claimed, { showZero: true })} /{" "}
                  {formatINR(r.deduction_80c_allowed, { showZero: true })}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>
                  80D claimed / allowed
                  <div className="text-xs font-normal text-ink-faint">
                    Capped at ₹1,00,000 — the outer bound across every age combination. The exact age-based cap
                    (₹25,000/₹50,000 each way) cannot be applied: employees has no date-of-birth field, so this app
                    cannot tell a senior citizen from anyone else.
                  </div>
                </td>
                <td className={num}>
                  {formatINR(r.deduction_80d_claimed, { showZero: true })} /{" "}
                  {formatINR(r.deduction_80d_allowed, { showZero: true })}
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>
                  Home loan interest u/s 24(b), claimed / allowed as a set-off against salary
                  <div className="text-xs font-normal text-ink-faint">
                    Sec 71(3A) caps how much house-property LOSS can be set off against salary this year at
                    ₹2,00,000, for every property type alike — not the self-occupied-only cap on the deduction
                    itself. Any excess is not carried forward (this app has no multi-year loss ledger for
                    individuals).
                  </div>
                </td>
                <td className={num}>
                  {formatINR(r.home_loan_interest_24b_claimed, { showZero: true })} /{" "}
                  {formatINR(r.home_loan_interest_24b_allowed, { showZero: true })}
                </td>
              </tr>
              {(r.previous_employer_income > 0 || r.previous_employer_tds_deducted > 0) && (
                <tr className="border-b border-border">
                  <td className={td}>Sec 192(2) — previous employer income / TDS this FY</td>
                  <td className={num}>
                    {formatINR(r.previous_employer_income, { showZero: true })} /{" "}
                    {formatINR(r.previous_employer_tds_deducted, { showZero: true })}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="border-b border-t border-border p-4">
            <h2 className="font-semibold">Tax computed — both regimes, side by side</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              The highlighted column is the regime that actually governs this certificate (
              <strong className="font-medium">{r.regime_used}</strong>
              {!r.declaration_exists ? ", defaulted" : ", as declared"}); the other is shown for comparison only.
            </p>
          </div>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}></th>
                <th className={th + " text-right" + (!isOld ? " text-ink-faint" : "")}>Old regime</th>
                <th className={th + " text-right" + (isOld ? " text-ink-faint" : "")}>New regime</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className={td}>Deduction u/s 16(iii) — professional tax (old regime only)</td>
                <RegimeCell value={r.professional_tax_total} highlight={isOld} />
                <RegimeCell value={0} highlight={!isOld} />
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Standard deduction u/s 16(ia)</td>
                <RegimeCell value={50000} highlight={isOld} />
                <RegimeCell value={75000} highlight={!isOld} />
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Income chargeable under the head &ldquo;Salaries&rdquo;</td>
                <RegimeCell value={r.old_income_chargeable_salary} highlight={isOld} />
                <RegimeCell value={r.new_income_chargeable_salary} highlight={!isOld} />
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Gross total income (after house-property set-off, old regime)</td>
                <RegimeCell value={r.old_gross_total_income} highlight={isOld} />
                <RegimeCell value={r.new_taxable_income} highlight={!isOld} />
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Chapter VI-A deductions (80C + 80D, old regime only)</td>
                <RegimeCell value={r.old_chapter_via_deductions} highlight={isOld} />
                <RegimeCell value={0} highlight={!isOld} />
              </tr>
              <tr className="bg-bg font-semibold">
                <td className={td}>Total taxable income</td>
                <RegimeCell value={r.old_taxable_income} highlight={isOld} />
                <RegimeCell value={r.new_taxable_income} highlight={!isOld} />
              </tr>
              <tr className="border-b border-t border-border">
                <td className={td}>Tax on total income</td>
                <RegimeCell value={r.old_tax_before_rebate} highlight={isOld} />
                <RegimeCell value={r.new_tax_before_rebate} highlight={!isOld} />
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Less: rebate u/s 87A</td>
                <RegimeCell value={r.old_rebate_87a} highlight={isOld} />
                <RegimeCell value={r.new_rebate_87a} highlight={!isOld} />
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Add: surcharge</td>
                <RegimeCell value={r.old_surcharge} highlight={isOld} />
                <RegimeCell value={r.new_surcharge} highlight={!isOld} />
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Add: health &amp; education cess @ 4%</td>
                <RegimeCell value={r.old_cess} highlight={isOld} />
                <RegimeCell value={r.new_cess} highlight={!isOld} />
              </tr>
              <tr className="bg-bg font-semibold">
                <td className={td}>Net tax payable</td>
                <RegimeCell value={r.old_net_tax_payable} highlight={isOld} />
                <RegimeCell value={r.new_net_tax_payable} highlight={!isOld} />
              </tr>
            </tbody>
          </table>

          <div className="border-t border-border p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-accent-soft px-4 py-3">
              <span className="font-medium">
                Net tax payable ({r.regime_used} regime{!r.declaration_exists ? ", defaulted" : ""})
              </span>
              <span className="font-display text-lg font-semibold text-accent">
                {formatINR(r.net_tax_payable, { showZero: true })}
              </span>
            </div>
            <p className="mt-3 text-xs text-ink-faint">
              TDS deposited per payroll postings this FY (get_payroll_run&apos;s own Sec 192 running estimate — since
              migration 0430, computed on the SAME regime as the declaration above, with regime-correct slabs,
              standard deduction, rebate and surcharge, but still WITHOUT HRA exemption, Chapter VI-A deductions or
              Sec 192(2) previous-employer netting, which remain this page&rsquo;s job alone):{" "}
              <strong className="font-medium text-ink">
                {formatINR(r.tds_deposited_per_payroll_projection, { showZero: true })}
              </strong>
              . This is <strong className="font-medium">not</strong> netted against the net tax payable figure above
              — even on the same regime the two are computed on different bases (no HRA/80C/80D/24(b) in the running
              estimate) and will not reconcile to a clean balance. Any shortfall or excess is settled at ITR-filing
              time or by a manual employer true-up before FY-end.
            </p>
          </div>

          <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
            This is Part B (Form 130&rsquo;s Part C from FY 2026-27) only — the employer&rsquo;s own computation.
            Part A, Form 16A and Form 27D are TRACES-generated documents carrying TRACES&rsquo; own digital
            signature; LEKHA has no TRACES access and does not attempt a look-alike. Statutory bonus and any exit
            gratuity/leave encashment paid this FY are <strong className="font-medium">not</strong> included in
            gross salary above — neither posts through get_payroll_run. An employee who has since left AND been
            deactivated will show zero months here even for months they were genuinely paid, a limitation inherited
            from get_payroll_run itself. Old-regime slabs assume a non-senior citizen (employees has no
            date-of-birth field). Nothing here is signed, filed, or submitted anywhere.
          </p>
        </>
      )}
    </ReportShell>
  );
}
