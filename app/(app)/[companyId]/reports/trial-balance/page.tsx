import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";

export default async function TrialBalancePage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/trial-balance">) {
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

  const { data: rows, error } = await supabase.rpc("get_trial_balance", {
    p_company_id: companyId,
    p_from: period.from,
    p_to: period.to,
  });

  const totals = (rows ?? []).reduce(
    (acc, r) => ({
      dr: acc.dr + Number(r.period_debit ?? 0),
      cr: acc.cr + Number(r.period_credit ?? 0),
      cdr: acc.cdr + Number(r.closing_debit ?? 0),
      ccr: acc.ccr + Number(r.closing_credit ?? 0),
    }),
    { dr: 0, cr: 0, cdr: 0, ccr: 0 }
  );

  const tallied = Math.abs(totals.cdr - totals.ccr) < 0.005;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trial Balance</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {period.label}
          </p>
        </div>
        <span
          className={
            "rounded px-2.5 py-1 text-xs font-medium " +
            (tallied
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300")
          }
        >
          {tallied
            ? "Tallied"
            : `Out by ${formatINR(Math.abs(totals.cdr - totals.ccr), { showZero: true })}`}
        </span>
      </header>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error.message}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="px-4 py-2.5 text-left font-medium">Ledger</th>
              <th className="px-4 py-2.5 text-left font-medium">Group</th>
              <th className="px-4 py-2.5 text-right font-medium">Debit</th>
              <th className="px-4 py-2.5 text-right font-medium">Credit</th>
              <th className="px-4 py-2.5 text-right font-medium">Closing Dr</th>
              <th className="px-4 py-2.5 text-right font-medium">Closing Cr</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-zinc-500">
                  Nothing posted in this period.
                </td>
              </tr>
            )}
            {(rows ?? []).map((r) => (
              <tr
                key={r.ledger_id}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
              >
                <td className="px-4 py-2 font-medium">{r.ledger_name}</td>
                <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                  {r.group_name}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatINR(Number(r.period_debit))}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatINR(Number(r.period_credit))}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatINR(Number(r.closing_debit))}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatINR(Number(r.closing_credit))}
                </td>
              </tr>
            ))}
          </tbody>
          {(rows ?? []).length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold dark:border-zinc-700 dark:bg-zinc-800/50">
                <td className="px-4 py-2.5" colSpan={2}>
                  Total
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {formatINR(totals.dr, { showZero: true })}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {formatINR(totals.cr, { showZero: true })}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {formatINR(totals.cdr, { showZero: true })}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {formatINR(totals.ccr, { showZero: true })}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </main>
  );
}
