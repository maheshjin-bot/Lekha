import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

const NATURE_LABEL: Record<string, string> = {
  capital: "Capital Account",
  current_liability: "Current Liabilities",
  non_current_liability: "Non-current Liabilities",
  current_asset: "Current Assets",
  fixed_asset: "Fixed Assets",
};

// Schedule III's own structural order — capital ahead of non-current
// liabilities ahead of current liabilities, non-current assets ahead of
// current assets — differs from the plain alphabetical order
// get_balance_sheet's ORDER BY nature happens to produce, so it is spelled
// out here rather than trusted to fall out of the RPC's row order. The
// simple-format arrays exist only to make that explicit and are (by
// construction) the same order the RPC already returns.
const LIABILITY_ORDER = {
  simple: ["capital", "current_liability"],
  schedule_iii: ["capital", "non_current_liability", "current_liability"],
} as const;
const ASSET_ORDER = {
  simple: ["current_asset", "fixed_asset"],
  schedule_iii: ["fixed_asset", "current_asset"],
} as const;

export default async function BalanceSheetPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/balance-sheet">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  // Same RPC the Overview page (app/(app)/[companyId]/page.tsx) already uses
  // for entity-type-driven display: one call resolves the company against
  // its ref_entity_types rule row, so statement_format and
  // financial_year_start_month come back together instead of two queries
  // disagreeing about which company they mean.
  const { data: profile } = await supabase.rpc("get_company_profile", {
    p_company_id: companyId,
  });
  const company = profile?.[0];
  // Fail safe to 'simple' on any lookup miss — a report page must render,
  // never crash, over a profile it couldn't resolve.
  const scheduleIII = company?.statement_format === "schedule_iii";

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

  // capital -> "Shareholders' Funds", fixed_asset -> "Non-current Assets" in
  // Schedule III — display-only renaming of the same nature/account-group;
  // NATURE_LABEL (and the underlying data) are untouched.
  const displayLabel = (nature: string): string => {
    if (scheduleIII) {
      if (nature === "capital") return "Shareholders' Funds";
      if (nature === "fixed_asset") return "Non-current Assets";
    }
    return NATURE_LABEL[nature] ?? nature;
  };

  // Named sideKey, not key: React reserves `key` as the list identity and
  // never forwards it as a prop, so it would arrive undefined.
  const Side = ({ label, sideKey }: { label: string; sideKey: "assets" | "liabilities" }) => {
    const items = side(sideKey);
    const format = scheduleIII ? "schedule_iii" : "simple";
    const order = sideKey === "liabilities" ? LIABILITY_ORDER[format] : ASSET_ORDER[format];
    // Schedule III always prints its structural headings, nil or not —
    // Non-current Liabilities is the whole point of this feature, and
    // Shareholders' Funds / Non-current Assets should not silently vanish
    // just because nothing happens to be posted there yet. The simple format
    // keeps its original data-driven behaviour: a nature heading appears
    // only when at least one ledger under it carries a balance.
    const present = new Set(items.map((r) => r.nature));
    const byNature: readonly string[] = scheduleIII ? order : order.filter((n) => present.has(n));
    return (
      <div className="min-w-0">
        <table className="w-full min-w-[280px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>{label}</th>
              <th className={th + " text-right"}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {byNature.map((nature) => {
              const natureItems = items.filter((r) => r.nature === nature);
              const natureTotal = natureItems.reduce((n, r) => n + Number(r.amount), 0);
              return (
                <tr key={nature} className="align-top">
                  <td className={td} colSpan={2}>
                    {scheduleIII ? (
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-semibold">{displayLabel(nature)}</span>
                        <span className="shrink-0 font-mono text-xs tabular-nums text-ink-faint">
                          {formatINR(natureTotal, { showZero: true })}
                        </span>
                      </div>
                    ) : (
                      <div className="font-semibold">{displayLabel(nature)}</div>
                    )}
                    <table className="mt-1 w-full">
                      <tbody>
                        {natureItems.map((r, i) => (
                          <tr key={i}>
                            <td className="py-0.5 pl-4 text-ink-soft">
                              {r.ledger_name}
                            </td>
                            <td className="py-0.5 text-right tabular-nums font-mono">
                              {formatINR(Number(r.amount))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              );
            })}
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
            {!scheduleIII && items.length === 0 && profit === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-ink-faint">
                  Nothing to show.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg">
              <td className="px-4 py-2.5 font-semibold">Total</td>
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums font-mono">
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
      <div className="grid divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
        <Side label={scheduleIII ? "Equity and Liabilities" : "Liabilities"} sideKey="liabilities" />
        <Side label="Assets" sideKey="assets" />
      </div>
      {scheduleIII && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          This shows Schedule III&rsquo;s outer structure only. Shareholders&rsquo;
          Funds is not split into Share Capital vs Reserves and Surplus,
          Non-current Liabilities is not split into Long-term Borrowings /
          Deferred Tax Liabilities / Long-term Provisions, and assets are not
          split into Tangible / Intangible / Capital Work-in-Progress /
          Investments. The Profit &amp; Loss statement on this report page is
          still the simple format, not yet Schedule III&rsquo;s.
        </p>
      )}
    </ReportShell>
  );
}
