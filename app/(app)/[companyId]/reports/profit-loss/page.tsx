import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

// Declared at module scope, not inside the page component: both the simple
// and schedule_iii layouts below reuse this for a different nature each, and
// a component re-created on every render (react-hooks/static-components)
// would multiply with each additional call site instead of staying fixed.
function Block({
  label,
  items,
}: {
  label: string;
  items: { ledger_name: string; group_name: string; amount: number }[];
}) {
  if (items.length === 0) return null;
  return (
    <>
      <tr className="bg-bg">
        <td className={td + " font-semibold"} colSpan={2}>
          {label}
        </td>
        <td className={num + " font-semibold"}>
          {formatINR(items.reduce((n, r) => n + Number(r.amount), 0), { showZero: true })}
        </td>
      </tr>
      {items.map((r, i) => (
        <tr key={i} className="border-b border-border">
          <td className={td + " pl-8"}>{r.ledger_name}</td>
          <td className={td + " text-ink-soft "}>{r.group_name}</td>
          <td className={num}>{formatINR(Number(r.amount))}</td>
        </tr>
      ))}
    </>
  );
}

export default async function ProfitLossPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/profit-loss">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  // Same RPC the Balance Sheet report now uses for entity-type-driven
  // display (app/(app)/[companyId]/reports/balance-sheet/page.tsx): one call
  // resolves the company against its ref_entity_types rule row, so
  // statement_format and financial_year_start_month come back together.
  const { data: profile } = await supabase.rpc("get_company_profile", {
    p_company_id: companyId,
  });
  const company = profile?.[0];
  // Fail safe to 'simple' on any lookup miss — a report page must render,
  // never crash, over a profile it couldn't resolve.
  const scheduleIII = company?.statement_format === "schedule_iii";

  const period = defaultPeriod(company?.financial_year_start_month ?? 4, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  const { data: rows } = await supabase.rpc("get_profit_and_loss", {
    p_company_id: companyId,
    p_from: period.from,
    p_to: period.to,
  });

  const all = rows ?? [];
  const sum = (natures: string[]) =>
    all.filter((r) => natures.includes(r.nature)).reduce((n, r) => n + Number(r.amount), 0);

  // Gross profit is the trading account: direct income less direct expense.
  // Net profit then carries that through the indirect items. Schedule III
  // has no "Gross Profit" concept (it is a trading-account idea, not a
  // Schedule III line item) but its own Total Income - Total Expenses lands
  // on exactly the same figure as netProfit — direct_income + indirect_income
  // - direct_expense - indirect_expense either way — so it is reused as
  // Profit Before Tax below rather than recomputed.
  const grossProfit = sum(["direct_income"]) - sum(["direct_expense"]);
  const netProfit = grossProfit + sum(["indirect_income"]) - sum(["indirect_expense"]);
  const totalIncome = sum(["direct_income", "indirect_income"]);
  const totalExpenses = sum(["direct_expense", "indirect_expense"]);

  const section = (nature: string) => all.filter((r) => r.nature === nature);

  return (
    <ReportShell
      title="Profit &amp; Loss"
      period={period.label}
      status={{
        label: netProfit >= 0 ? "Profit" : "Loss",
        tone: netProfit >= 0 ? "ok" : "bad",
      }}
    >
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Particulars</th>
            <th className={th}>Group</th>
            <th className={th + " text-right"}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {all.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-12 text-center text-ink-faint">
                No income or expense posted in this period.
              </td>
            </tr>
          )}
          {scheduleIII ? (
            <>
              {/* Schedule III's own ordering: both income blocks together
                  under Total Income, then both expense blocks together under
                  Total Expenses — direct_income/direct_expense are the same
                  underlying nature values as the simple format, only
                  relabelled and reordered for display. */}
              <Block label="Revenue from Operations" items={section("direct_income")} />
              <Block label="Other Income" items={section("indirect_income")} />
              {all.length > 0 && (
                <tr className="border-y-2 border-border-strong bg-surface-2">
                  <td className={td + " font-semibold"} colSpan={2}>
                    Total Income
                  </td>
                  <td className={num + " font-semibold"}>
                    {formatINR(totalIncome, { showZero: true })}
                  </td>
                </tr>
              )}
              <Block label="Direct Expenses" items={section("direct_expense")} />
              <Block label="Indirect Expenses" items={section("indirect_expense")} />
              {all.length > 0 && (
                <tr className="border-y-2 border-border-strong bg-surface-2">
                  <td className={td + " font-semibold"} colSpan={2}>
                    Total Expenses
                  </td>
                  <td className={num + " font-semibold"}>
                    {formatINR(totalExpenses, { showZero: true })}
                  </td>
                </tr>
              )}
            </>
          ) : (
            <>
              <Block label="Direct Income" items={section("direct_income")} />
              <Block label="Direct Expenses" items={section("direct_expense")} />
              {all.length > 0 && (
                <tr className="border-y-2 border-border-strong bg-surface-2">
                  <td className={td + " font-semibold"} colSpan={2}>
                    Gross Profit
                  </td>
                  <td className={num + " font-semibold"}>
                    {formatINR(grossProfit, { showZero: true })}
                  </td>
                </tr>
              )}
              <Block label="Indirect Income" items={section("indirect_income")} />
              <Block label="Indirect Expenses" items={section("indirect_expense")} />
            </>
          )}
        </tbody>
        {all.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg">
              <td className="px-4 py-3 font-semibold" colSpan={2}>
                {scheduleIII ? "Profit Before Tax" : netProfit >= 0 ? "Net Profit" : "Net Loss"}
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums font-mono">
                {scheduleIII
                  ? formatINR(netProfit, { showZero: true })
                  : formatINR(Math.abs(netProfit), { showZero: true })}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      {scheduleIII && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          This shows Schedule III&rsquo;s outer structure only. Expenses are
          not sub-classified into Cost of materials consumed, Purchases of
          stock-in-trade, Changes in inventories, Employee benefits expense,
          Finance costs, Depreciation and amortisation expense, or Other
          expenses — this schema only classifies Direct vs Indirect. Tax
          expense and Profit for the year (after tax) are not shown here; see
          the Income Tax report for a separate estimate.
        </p>
      )}
    </ReportShell>
  );
}
