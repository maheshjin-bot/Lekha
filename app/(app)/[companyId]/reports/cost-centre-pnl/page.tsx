import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

type Row = {
  cost_centre_id: string | null;
  code: string | null;
  name: string;
  kind: string | null;
  income: number;
  expense: number;
  net: number;
  entry_count: number;
};

export default async function CostCentrePnlPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/cost-centre-pnl">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: profile } = await supabase.rpc("get_company_profile", {
    p_company_id: companyId,
  });
  const period = defaultPeriod(profile?.[0]?.financial_year_start_month ?? 4, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  const { data } = await supabase.rpc("get_cost_centre_pnl", {
    p_company_id: companyId,
    p_from: period.from,
    p_to: period.to,
  });

  const rows = (data ?? []) as Row[];
  const totals = rows.reduce(
    (a, r) => ({
      income: a.income + Number(r.income),
      expense: a.expense + Number(r.expense),
      net: a.net + Number(r.net),
      count: a.count + Number(r.entry_count),
    }),
    { income: 0, expense: 0, net: 0, count: 0 }
  );

  const unallocated = rows.find((r) => r.cost_centre_id === null);

  return (
    <ReportShell
      title="Cost centre P&L"
      period={period.label}
      status={{
        label: `${formatINR(totals.net, { showZero: true })} net`,
        tone: totals.net >= 0 ? "ok" : "warn",
      }}
    >
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Code</th>
            <th className={th}>Cost centre / project</th>
            <th className={th + " text-right"}>Lines</th>
            <th className={th + " text-right"}>Income</th>
            <th className={th + " text-right"}>Expense</th>
            <th className={th + " text-right"}>Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-ink-faint">
                No profit &amp; loss activity in this period.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr
              key={r.cost_centre_id ?? "unallocated"}
              className={
                "border-b border-border last:border-0 " +
                (r.cost_centre_id === null ? "bg-warning-soft" : "")
              }
            >
              <td className={td + " font-mono text-xs"}>{r.code ?? "—"}</td>
              <td className={td}>
                {r.name}{" "}
                {r.kind === "project" && (
                  <Badge tone="accent" className="ml-1">
                    Project
                  </Badge>
                )}
              </td>
              <td className={num + " text-ink-faint"}>{r.entry_count}</td>
              <td className={num}>{formatINR(Number(r.income), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.expense), { showZero: true })}</td>
              <td className={num + " font-medium"}>
                <span className={Number(r.net) < 0 ? "text-error" : "text-success"}>
                  {formatINR(Number(r.net), { showZero: true })}
                </span>
              </td>
            </tr>
          ))}
          {rows.length > 0 && (
            <tr className="bg-bg font-semibold">
              <td className={td} colSpan={2}>
                Total — ties to Profit &amp; Loss
              </td>
              <td className={num}>{totals.count}</td>
              <td className={num}>{formatINR(totals.income, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.expense, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.net, { showZero: true })}</td>
            </tr>
          )}
        </tbody>
      </table>

      {unallocated && Number(unallocated.entry_count) > 0 && (
        <div className="border-t border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          {unallocated.entry_count}{" "}
          {Number(unallocated.entry_count) === 1 ? "line is" : "lines are"} not allocated
          to any cost centre, carrying{" "}
          {formatINR(Number(unallocated.net), { showZero: true })} of net result. They are
          shown as their own row rather than dropped, so the rows above always sum to the
          company&rsquo;s own Profit &amp; Loss.{" "}
          <Link href={`/${companyId}/cost-centres`} className="underline">
            Allocate them
          </Link>
          .
        </div>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Profit &amp; loss split by cost centre or project. Only P&amp;L lines carry an
        allocation — balance-sheet accounts are excluded entirely, because a cost centre
        on a bank balance does not sum into anything meaningful. Allocation is a label on
        the voucher line, so this report can be re-cut at any time without touching a
        single figure in the books. Overheads are shown where they were actually posted:
        nothing here apportions shared costs across centres on a driver or percentage
        basis — that is a management-accounting judgement this app deliberately leaves to
        you.
      </p>
    </ReportShell>
  );
}
