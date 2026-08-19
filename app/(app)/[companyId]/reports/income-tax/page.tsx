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
        <p className="px-4 py-12 text-center text-zinc-500">
          Company not found.
        </p>
      </ReportShell>
    );
  }

  if (!result.applicable) {
    return (
      <ReportShell title="Income tax computation" period={period}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-300">
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
  const taxableIncome = Number(result.taxable_income);
  const taxBeforeRebate = Number(result.tax_before_rebate);
  const rebate87a = Number(result.rebate_87a);
  const taxAfterRebate = Number(result.tax_after_rebate);
  const surcharge = Number(result.surcharge);
  const cess = Number(result.cess);
  const totalTax = Number(result.total_tax);

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
        <p className="border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
          Regime: {result.regime_used}
        </p>
      )}

      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left dark:border-zinc-800">
            <th className={th}>Component</th>
            <th className={th + " text-right"}>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
            <td className={td}>Book profit</td>
            <td className={num}>{formatINR(bookProfit, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
            <td className={td}>+ Book depreciation added back</td>
            <td className={num}>{formatINR(bookDepAddback, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
            <td className={td}>+ MSME dues disallowed (Sec 43B(h))</td>
            <td className={num}>{formatINR(msmeAddback, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
            <td className={td}>− Tax depreciation</td>
            <td className={num}>{formatINR(taxDep, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/40">
            <td className={td + " font-semibold"}>Taxable income</td>
            <td className={num + " font-semibold"}>
              {formatINR(taxableIncome, { showZero: true })}
            </td>
          </tr>
          <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
            <td className={td}>Tax before rebate</td>
            <td className={num}>{formatINR(taxBeforeRebate, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
            <td className={td}>− Sec 87A rebate</td>
            <td className={num}>{formatINR(rebate87a, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
            <td className={td}>Tax after rebate</td>
            <td className={num}>{formatINR(taxAfterRebate, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
            <td className={td}>+ Surcharge</td>
            <td className={num}>{formatINR(surcharge, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-zinc-200 last:border-0 dark:border-zinc-800">
            <td className={td}>+ Cess (4%)</td>
            <td className={num}>{formatINR(cess, { showZero: true })}</td>
          </tr>
          <tr className="bg-emerald-50 dark:bg-emerald-950/20">
            <td className={td + " text-base font-bold"}>Total tax</td>
            <td className={num + " text-base font-bold"}>
              {formatINR(totalTax, { showZero: true })}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500 dark:border-zinc-800">
        {result.note}
      </p>
      <p className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500 dark:border-zinc-800">
        This is a PGBP-bridge estimate — the walk from book profit to taxable
        business income and the resulting tax — governed by the Income-tax
        Act 1961 as amended (AY 2026-27), not the Income-tax Act 2025, which
        only governs income earned from 1 April 2026 onward. It excludes Sec
        40(a)/40A(3) TDS and cash-payment disallowances, general Sec 43B
        (non-MSME) dues such as unpaid GST/PF/ESI/bonus, the Sec 40(b)
        partner remuneration cap, and marginal relief at the Sec 87A rebate
        and surcharge thresholds. Treat this as a starting estimate, not a
        filed-return number.
      </p>
    </ReportShell>
  );
}
