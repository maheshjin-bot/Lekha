import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

type Row = {
  ledger_id: string;
  ledger_name: string;
  nature: string;
  budgeted: number;
  actual: number;
  variance: number;
  variance_percent: number | null;
};

const NATURE_LABEL: Record<string, string> = {
  direct_income: "Direct income",
  indirect_income: "Other income",
  direct_expense: "Direct expense",
  indirect_expense: "Overheads",
};

export default async function BudgetVariancePage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/budget-variance">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: profile }, { data: budgets }] = await Promise.all([
    supabase.rpc("get_company_profile", { p_company_id: companyId }),
    supabase
      .from("budgets")
      .select("id, name, fy_start, fy_end, is_active")
      .eq("company_id", companyId)
      .order("fy_start", { ascending: false }),
  ]);

  const requestedId = typeof sp.budget === "string" ? sp.budget : undefined;
  const budget =
    (budgets ?? []).find((b) => b.id === requestedId) ??
    (budgets ?? []).find((b) => b.is_active) ??
    (budgets ?? [])[0] ??
    null;

  const period = defaultPeriod(profile?.[0]?.financial_year_start_month ?? 4, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  if (!budget) {
    return (
      <ReportShell title="Budget variance" period={period.label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">No budget set up yet</p>
          <p className="mt-1">
            Create one at{" "}
            <Link href={`/${companyId}/budgets`} className="underline">
              Budgets
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const { data } = await supabase.rpc("get_budget_variance", {
    p_company_id: companyId,
    p_budget_id: budget.id,
    p_from: period.from,
    p_to: period.to,
  });

  const rows = (data ?? []) as Row[];
  const bySection = new Map<string, Row[]>();
  for (const r of rows) {
    const list = bySection.get(r.nature) ?? [];
    list.push(r);
    bySection.set(r.nature, list);
  }

  const totals = rows.reduce(
    (a, r) => ({
      budgeted: a.budgeted + Number(r.budgeted),
      actual: a.actual + Number(r.actual),
      variance: a.variance + Number(r.variance),
    }),
    { budgeted: 0, actual: 0, variance: 0 }
  );

  // "Over budget" only correctly describes an expense that overspent — for an
  // income line, an unfavourable variance is a shortfall against target, the
  // opposite direction of wrong. "Unfavourable" is the one word that is
  // accurate for both, so that is what the status badge says.
  const unfavourable = rows.filter(
    (r) =>
      Number(r.budgeted) > 0 &&
      ((r.nature.includes("expense") && Number(r.variance) > 0) ||
        (r.nature.includes("income") && Number(r.variance) < 0))
  ).length;

  return (
    <ReportShell
      title="Budget variance"
      period={`${period.label} · ${budget.name}`}
      status={{
        label: unfavourable === 0 ? "Within budget" : `${unfavourable} unfavourable`,
        tone: unfavourable === 0 ? "ok" : "warn",
      }}
    >
      {(budgets ?? []).length > 1 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4 text-sm">
          {(budgets ?? []).map((b) => (
            <a
              key={b.id}
              href={`?budget=${b.id}`}
              className={
                "rounded-md border px-2.5 py-1 " +
                (b.id === budget.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-strong hover:bg-surface-2")
              }
            >
              {b.name}
            </a>
          ))}
        </div>
      )}

      {[...bySection.entries()].map(([nature, natureRows]) => (
        <div key={nature}>
          <div className="border-b border-t border-border bg-bg px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-faint first:border-t-0">
            {NATURE_LABEL[nature] ?? nature}
          </div>
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Ledger</th>
                <th className={th + " text-right"}>Budgeted</th>
                <th className={th + " text-right"}>Actual</th>
                <th className={th + " text-right"}>Variance</th>
                <th className={th + " text-right"}>%</th>
              </tr>
            </thead>
            <tbody>
              {natureRows.map((r) => {
                const isExpense = r.nature.includes("expense");
                const overspent = isExpense ? Number(r.variance) > 0 : Number(r.variance) < 0;
                return (
                  <tr key={r.ledger_id} className="border-b border-border last:border-0">
                    <td className={td}>{r.ledger_name}</td>
                    <td className={num}>{formatINR(Number(r.budgeted), { showZero: true })}</td>
                    <td className={num}>{formatINR(Number(r.actual), { showZero: true })}</td>
                    <td className={num}>
                      <span className={overspent ? "text-error" : "text-success"}>
                        {formatINR(Number(r.variance), { showZero: true })}
                      </span>
                    </td>
                    <td className={num + " text-ink-faint"}>
                      {r.variance_percent === null ? "—" : `${r.variance_percent}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {rows.length === 0 && (
        <p className="px-4 py-10 text-center text-ink-faint">
          No budgeted or actual profit &amp; loss activity in this period.
        </p>
      )}

      {rows.length > 0 && (
        <div className="border-t border-border p-4">
          <table className="w-full max-w-md text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className={td}>Total budgeted</td>
                <td className={num}>{formatINR(totals.budgeted, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Total actual</td>
                <td className={num}>{formatINR(totals.actual, { showZero: true })}</td>
              </tr>
              <tr className="bg-accent-soft">
                <td className={td + " font-bold"}>Total variance</td>
                <td className={num + " font-bold"}>{formatINR(totals.variance, { showZero: true })}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Compares {budget.name} against actual postings for the period shown. A ledger
        budgeted but never posted, or posted but never budgeted, still appears here rather
        than being dropped from either side. Variance is actual minus budgeted — positive
        on an expense line means overspend; positive on an income line means you beat the
        plan. Only profit &amp; loss ledgers are budgetable; nothing here plans capital
        expenditure or balance-sheet movements.
      </p>
    </ReportShell>
  );
}
