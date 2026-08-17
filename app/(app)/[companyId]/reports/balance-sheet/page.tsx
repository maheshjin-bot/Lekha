import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

const NATURE_LABEL: Record<string, string> = {
  capital: "Capital Account",
  current_liability: "Current Liabilities",
  current_asset: "Current Assets",
  fixed_asset: "Fixed Assets",
};

export default async function BalanceSheetPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/balance-sheet">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month")
    .eq("id", companyId)
    .maybeSingle();

  const period = defaultPeriod(company?.financial_year_start_month ?? 4, {
    to: typeof sp.as_at === "string" ? sp.as_at : undefined,
  });

  const [{ data: rows }, { data: pl }] = await Promise.all([
    supabase.rpc("get_balance_sheet", {
      p_company_id: companyId,
      p_as_at: period.to,
    }),
    supabase.rpc("get_profit_and_loss", {
      p_company_id: companyId,
      p_from: period.from,
      p_to: period.to,
    }),
  ]);

  const all = rows ?? [];
  const plRows = pl ?? [];
  const sumNature = (n: string[]) =>
    plRows.filter((r) => n.includes(r.nature)).reduce((t, r) => t + Number(r.amount), 0);

  // The period's profit belongs on the liabilities side — it is owed to the
  // proprietor. Without it the two sides cannot agree, because income and
  // expense ledgers are not carried on the balance sheet itself.
  const profit =
    sumNature(["direct_income", "indirect_income"]) -
    sumNature(["direct_expense", "indirect_expense"]);

  const side = (s: string) => all.filter((r) => r.side === s);
  const total = (s: string) =>
    side(s).reduce((n, r) => n + Number(r.amount), 0) + (s === "liabilities" ? profit : 0);

  const difference = total("assets") - total("liabilities");
  const balanced = Math.abs(difference) < 0.005;

  // Named sideKey, not key: React reserves `key` as the list identity and
  // never forwards it as a prop, so it would arrive undefined.
  const Side = ({ label, sideKey }: { label: string; sideKey: "assets" | "liabilities" }) => {
    const items = side(sideKey);
    const byNature = [...new Set(items.map((r) => r.nature))];
    return (
      <div className="min-w-0">
        <table className="w-full min-w-[280px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left dark:border-zinc-800">
              <th className={th}>{label}</th>
              <th className={th + " text-right"}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {byNature.map((nature) => (
              <tr key={nature} className="align-top">
                <td className={td} colSpan={2}>
                  <div className="font-semibold">{NATURE_LABEL[nature] ?? nature}</div>
                  <table className="mt-1 w-full">
                    <tbody>
                      {items
                        .filter((r) => r.nature === nature)
                        .map((r, i) => (
                          <tr key={i}>
                            <td className="py-0.5 pl-4 text-zinc-700 dark:text-zinc-300">
                              {r.ledger_name}
                            </td>
                            <td className="py-0.5 text-right tabular-nums">
                              {formatINR(Number(r.amount))}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </td>
              </tr>
            ))}
            {sideKey === "liabilities" && profit !== 0 && (
              <tr>
                <td className={td + " font-semibold"}>
                  {profit >= 0 ? "Profit for the period" : "Loss for the period"}
                </td>
                <td className={num + " font-semibold"}>
                  {formatINR(Math.abs(profit), { showZero: true })}
                </td>
              </tr>
            )}
            {items.length === 0 && profit === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-zinc-500">
                  Nothing to show.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50">
              <td className="px-4 py-2.5 font-semibold">Total</td>
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                {formatINR(total(sideKey), { showZero: true })}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  };

  return (
    <ReportShell
      title="Balance Sheet"
      period={`As at ${period.label.split(" to ").pop()}`}
      status={{
        label: balanced
          ? "Balanced"
          : `Out by ${formatINR(Math.abs(difference), { showZero: true })}`,
        tone: balanced ? "ok" : "bad",
      }}
    >
      <div className="grid divide-y divide-zinc-200 md:grid-cols-2 md:divide-x md:divide-y-0 dark:divide-zinc-800">
        <Side label="Liabilities" sideKey="liabilities" />
        <Side label="Assets" sideKey="assets" />
      </div>
    </ReportShell>
  );
}
