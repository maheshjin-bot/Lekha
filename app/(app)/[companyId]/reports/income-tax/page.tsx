import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The calendar April-March tax year containing today's local date.
 * Deliberately ignores the company's own financial_year_start_month —
 * statutory income-tax computation always runs on the calendar year, exactly
 * like get_compliance_calendar (migration 0024) and get_tax_depreciation_
 * blocks (migration 0025) already established for this codebase. A company
 * on a July book year still gets an April–March tax year here.
 */
function taxYearBounds(): { from: string; to: string; label: string } {
  const today = todayLocal();
  const [y, m] = today.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return {
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
  };
}

export default async function IncomeTaxPage({
  params,
}: PageProps<"/[companyId]/reports/income-tax">) {
  const { companyId } = await params;
  const supabase = await createClient();
  const { from, to, label } = taxYearBounds();

  const { data: rows } = await supabase.rpc("get_income_tax_computation", {
    p_company_id: companyId,
    p_fy_start: from,
    p_fy_end: to,
  });

  const result = rows?.[0] ?? null;

  const period = `FY ${label} · ${from} to ${to} · calendar April–March tax year, not this company's book year`;

  if (!result) {
    return (
      <ReportShell title="Income tax computation" period={period}>
        <p className="px-4 py-12 text-center text-ink-faint">
          Company not found.
        </p>
      </ReportShell>
    );
  }

  if (!result.applicable) {
    return (
      <ReportShell title="Income tax computation" period={period}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">Not applicable to this entity type</p>
          <p className="mt-1">{result.note}</p>
        </div>
      </ReportShell>
    );
  }

  const bookProfit = Number(result.book_profit);
  const bookDepAddback = Number(result.book_depreciation_addback);
  const msmeAddback = Number(result.msme_disallowance_addback);
  const taxDep = Number(result.tax_depreciation_deduction);
  const remunerationDisallowed = Number(result.partner_remuneration_disallowed ?? 0);
  const bookDepRegister = Number(result.book_depreciation_per_register ?? 0);
  const businessIncome = Number(result.business_income ?? 0);
  const stcg = Number(result.short_term_capital_gain ?? 0);
  const stcl = Number(result.short_term_capital_loss ?? 0);
  const grossTotalIncome = Number(result.gross_total_income ?? 0);
  const businessLossCf = Number(result.business_loss_carried_forward ?? 0);
  const capitalLossCf = Number(result.capital_loss_carried_forward ?? 0);
  const taxableIncome = Number(result.taxable_income);
  const taxBeforeRebate = Number(result.tax_before_rebate);
  const rebate87a = Number(result.rebate_87a);
  const taxAfterRebate = Number(result.tax_after_rebate);
  const surcharge = Number(result.surcharge);
  const cess = Number(result.cess);
  const totalTax = Number(result.total_tax);
  const advanceTax = Number(result.advance_tax_paid ?? 0);
  const selfAssessmentTax = Number(result.self_assessment_tax_paid ?? 0);
  const tdsCredit = Number(result.tds_tcs_credit ?? 0);
  const netTaxPayable = Number(result.net_tax_payable ?? 0);

  return (
    <ReportShell
      title="Income tax computation"
      period={period}
      status={{
        label: `${formatINR(totalTax, { showZero: true })} total tax`,
        tone: "ok",
      }}
    >
      {result.regime_used && (
        <p className="border-b border-border px-4 py-2 text-xs text-ink-faint">
          Regime: {result.regime_used}
        </p>
      )}

      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Component</th>
            <th className={th + " text-right"}>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border last:border-0">
            <td className={td}>Book profit</td>
            <td className={num}>{formatINR(bookProfit, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>+ Book depreciation added back</td>
            <td className={num}>{formatINR(bookDepAddback, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>+ MSME dues disallowed (Sec 43B(h))</td>
            <td className={num}>{formatINR(msmeAddback, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>− Tax depreciation</td>
            <td className={num}>{formatINR(taxDep, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>+ Partner remuneration disallowed (Sec 40(b))</td>
            <td className={num}>{formatINR(remunerationDisallowed, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border bg-bg">
            <td className={td + " font-semibold"}>
              {businessIncome < 0 ? "Business loss" : "Business income"}
            </td>
            <td className={num + " font-semibold"}>
              {formatINR(businessIncome, { showZero: true })}
            </td>
          </tr>
          {(stcg !== 0 || stcl !== 0) && (
            <>
              <tr className="border-b border-border last:border-0">
                <td className={td}>+ Short-term capital gain (Sec 50)</td>
                <td className={num}>{formatINR(stcg, { showZero: true })}</td>
              </tr>
              {stcl !== 0 && (
                <tr className="border-b border-border last:border-0">
                  <td className={td}>
                    Short-term capital loss (Sec 50)
                    <div className="text-xs text-ink-faint">
                      Set off only against capital gains (Sec 74) — deliberately does not reduce
                      the business income above
                    </div>
                  </td>
                  <td className={num + " text-ink-faint"}>{formatINR(stcl, { showZero: true })}</td>
                </tr>
              )}
            </>
          )}
          <tr className="border-b border-border bg-bg">
            <td className={td + " font-semibold"}>
              {grossTotalIncome < 0 ? "Gross total loss" : "Gross total income"}
            </td>
            <td className={num + " font-semibold"}>
              {formatINR(grossTotalIncome, { showZero: true })}
            </td>
          </tr>
          <tr className="border-b border-border bg-bg">
            <td className={td + " font-semibold"}>Taxable income</td>
            <td className={num + " font-semibold"}>
              {formatINR(taxableIncome, { showZero: true })}
            </td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>Tax before rebate</td>
            <td className={num}>{formatINR(taxBeforeRebate, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>− Sec 87A rebate</td>
            <td className={num}>{formatINR(rebate87a, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>Tax after rebate</td>
            <td className={num}>{formatINR(taxAfterRebate, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>+ Surcharge</td>
            <td className={num}>{formatINR(surcharge, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>+ Cess (4%)</td>
            <td className={num}>{formatINR(cess, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border bg-bg">
            <td className={td + " font-semibold"}>Total tax</td>
            <td className={num + " font-semibold"}>
              {formatINR(totalTax, { showZero: true })}
            </td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>− Advance tax paid (minor head 100)</td>
            <td className={num}>{formatINR(advanceTax, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>− Self-assessment / regular assessment tax (300, 400)</td>
            <td className={num}>{formatINR(selfAssessmentTax, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border last:border-0">
            <td className={td}>
              − TDS/TCS deducted by others (Sec 199)
              <div className="text-xs text-ink-faint">
                Movement on TDS Receivable during this year — not its carried-forward balance
              </div>
            </td>
            <td className={num}>{formatINR(tdsCredit, { showZero: true })}</td>
          </tr>
          <tr className={netTaxPayable >= 0 ? "bg-success-soft" : "bg-accent-soft"}>
            <td className={td + " text-base font-bold"}>
              {netTaxPayable >= 0 ? "Net tax payable" : "Refund due"}
            </td>
            <td className={num + " text-base font-bold"}>
              {formatINR(Math.abs(netTaxPayable), { showZero: true })}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Advance tax and self-assessment come from challans recorded on{" "}
        <Link href={`/${companyId}/tax-payments`} className="underline">
          Tax payments
        </Link>
        . If the net figure looks too high, the challans are probably not entered yet — this report
        can only net what it has been told about. Interest under Sec 234A/234B/234C for late filing
        or short or deferred advance tax is <strong className="font-medium text-ink">not</strong>{" "}
        computed, so a genuine shortfall will cost more than the figure above.
      </p>

      {(businessLossCf > 0 || capitalLossCf > 0) && (
        <div className="border-t border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          <p className="font-medium">Losses available to carry forward</p>
          <ul className="mt-1 space-y-1">
            {businessLossCf > 0 && (
              <li>
                <strong className="font-medium">
                  Business loss {formatINR(businessLossCf)}
                </strong>{" "}
                — Sec 72, eight assessment years; unabsorbed depreciation carries forward
                indefinitely under Sec 32(2).
              </li>
            )}
            {capitalLossCf > 0 && (
              <li>
                <strong className="font-medium">
                  Short-term capital loss {formatINR(capitalLossCf)}
                </strong>{" "}
                — Sec 50 read with Sec 74: set off only against capital gains, eight assessment
                years. It has not reduced the business income above.
              </li>
            )}
          </ul>
          <p className="mt-1.5">
            LEKHA does not yet carry a loss into a later year&rsquo;s computation — record these
            figures yourself. They are shown here rather than discarded, which is what used to
            happen.
          </p>
        </div>
      )}

      {Math.abs(bookDepAddback - bookDepRegister) > 0.005 && (
        <div className="border-t border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          <p className="font-medium">The books are behind the fixed asset register.</p>
          <p className="mt-1">
            Depreciation actually posted for the year is{" "}
            {formatINR(bookDepAddback, { showZero: true })}, but the register computes{" "}
            {formatINR(bookDepRegister, { showZero: true })}. The add-back above uses what was
            posted, because that is what reduced book profit — adding back a charge that was never
            deducted would overstate taxable income by the difference. Post the charge on{" "}
            <Link href={`/${companyId}/depreciation`} className="underline">
              Depreciation
            </Link>{" "}
            to bring the two in line.
          </p>
        </div>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        {result.note}
      </p>
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        This is a PGBP-bridge estimate — the walk from book profit to taxable
        business income and the resulting tax — governed by the Income-tax
        Act 1961 as amended (AY 2026-27), not the Income-tax Act 2025, which
        only governs income earned from 1 April 2026 onward. It excludes Sec
        40(a)/40A(3) TDS and cash-payment disallowances, general Sec 43B
        (non-MSME) dues such as unpaid GST/PF/ESI/bonus, the separate Sec
        40(b) interest-on-capital cap (12% p.a. — needs partner capital
        balances this schema does not track; only the remuneration slab
        ceiling above is computed), and marginal relief at the Sec 87A
        rebate and surcharge thresholds. Treat this as a starting estimate,
        not a filed-return number.
      </p>
    </ReportShell>
  );
}
