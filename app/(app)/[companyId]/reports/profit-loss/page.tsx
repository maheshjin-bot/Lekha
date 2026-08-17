import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

export default async function ProfitLossPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/profit-loss">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month")
    .eq("id", companyId)
    .maybeSingle();

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
  // Net profit then carries that through the indirect items.
  const grossProfit = sum(["direct_income"]) - sum(["direct_expense"]);
  const netProfit = grossProfit + sum(["indirect_income"]) - sum(["indirect_expense"]);

  const section = (nature: string) => all.filter((r) => r.nature === nature);

  const Block = ({ label, nature }: { label: string; nature: string }) => {
    const items = section(nature);
    if (items.length === 0) return null;
    return (
      <>
        <tr className="bg-zinc-50 dark:bg-zinc-800/50">
          <td className={td + " font-semibold"} colSpan={2}>
            {label}
          </td>
          <td className={num + " font-semibold"}>
            {formatINR(items.reduce((n, r) => n + Number(r.amount), 0), { showZero: true })}
          </td>
        </tr>
        {items.map((r, i) => (
          <tr key={`${nature}-${i}`} className="border-b border-zinc-100 dark:border-zinc-800/60">
            <td className={td + " pl-8"}>{r.ledger_name}</td>
            <td className={td + " text-zinc-600 dark:text-zinc-400"}>{r.group_name}</td>
            <td className={num}>{formatINR(Number(r.amount))}</td>
          </tr>
        ))}
      </>
    );
  };

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
          <tr className="border-b border-zinc-200 text-left dark:border-zinc-800">
            <th className={th}>Particulars</th>
            <th className={th}>Group</th>
            <th className={th + " text-right"}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {all.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-12 text-center text-zinc-500">
                No income or expense posted in this period.
              </td>
            </tr>
          )}
          <Block label="Direct Income" nature="direct_income" />
          <Block label="Direct Expenses" nature="direct_expense" />
          {all.length > 0 && (
            <tr className="border-y-2 border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800">
              <td className={td + " font-semibold"} colSpan={2}>
                Gross Profit
              </td>
              <td className={num + " font-semibold"}>
                {formatINR(grossProfit, { showZero: true })}
              </td>
            </tr>
          )}
          <Block label="Indirect Income" nature="indirect_income" />
          <Block label="Indirect Expenses" nature="indirect_expense" />
        </tbody>
        {all.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50">
              <td className="px-4 py-3 font-semibold" colSpan={2}>
                {netProfit >= 0 ? "Net Profit" : "Net Loss"}
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums">
                {formatINR(Math.abs(netProfit), { showZero: true })}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </ReportShell>
  );
}
