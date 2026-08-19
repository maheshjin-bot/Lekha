import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

const NATURE_LABEL: Record<string, string> = {
  capital: "Capital Account",
  share_capital: "Share Capital",
  reserves_surplus: "Reserves and Surplus",
  current_liability: "Current Liabilities",
  non_current_liability: "Non-current Liabilities",
  long_term_borrowing: "Long-term Borrowings",
  deferred_tax: "Deferred Tax Liabilities (Net)",
  long_term_provision: "Long-term Provisions",
  current_asset: "Current Assets",
  fixed_asset: "Fixed Assets",
};

// Schedule III's own structural order — Share Capital and Reserves and
// Surplus (Shareholders' Funds) ahead of the four Non-current Liabilities
// lines ahead of Current Liabilities, non-current assets ahead of current
// assets — differs from the plain alphabetical order get_balance_sheet's
// ORDER BY nature happens to produce, so it is spelled out here rather than
// trusted to fall out of the RPC's row order. 'capital' and
// 'non_current_liability' are BOTH still real natures a ledger can carry
// (0037 added five siblings, it did not retire either) — 'capital' sits
// alongside Share Capital/Reserves and Surplus as a residual catch-all now
// that those two cover Shareholders' Funds' real line items;
// 'non_current_liability' IS itself Schedule III's fourth Non-current
// Liabilities line, "Other Long-term Liabilities" — see displayLabel.
const LIABILITY_ORDER = {
  simple: [
    "capital", "share_capital", "reserves_surplus",
    "non_current_liability", "long_term_borrowing", "deferred_tax", "long_term_provision",
    "current_liability",
  ],
  schedule_iii: [
    "share_capital", "reserves_surplus", "capital",
    "long_term_borrowing", "deferred_tax", "non_current_liability", "long_term_provision",
    "current_liability",
  ],
} as const;
const ASSET_ORDER = {
  simple: ["current_asset", "fixed_asset"],
  schedule_iii: ["fixed_asset", "current_asset"],
} as const;

// In schedule_iii mode, every heading in LIABILITY_ORDER prints unconditionally
// EXCEPT 'capital' — Share Capital and Reserves and Surplus now cover what
// 'capital' used to mean for a Schedule III company, so it only earns a row
// when something is actually still posted there (typically a pre-existing
// ledger from before 0037 that has not been moved). Every other heading here
// is a genuine Schedule III line item, not a legacy catch-all, so it keeps
// the original "always show, nil or not" behaviour.
const SCHEDULE_III_PRESENT_ONLY = new Set(["capital"]);

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

  // Display-only renaming for Schedule III — the same nature/account-group
  // data, just Schedule III's own line-item names. 'capital' only ever
  // shows as a leftover row (see SCHEDULE_III_PRESENT_ONLY above), so it is
  // labelled as exactly that rather than reusing "Shareholders' Funds",
  // which now belongs to the Share Capital + Reserves and Surplus pair.
  // 'non_current_liability' IS Schedule III's own "Other Long-term
  // Liabilities" line, not a fallback label for something else.
  const displayLabel = (nature: string): string => {
    if (scheduleIII) {
      if (nature === "capital") return "Other Shareholders' Funds";
      if (nature === "non_current_liability") return "Other Long-term Liabilities";
      if (nature === "fixed_asset") return "Non-current Assets";
    }
    return NATURE_LABEL[nature] ?? nature;
  };

  // Named sideKey, not key: React reserves `key` as the list identity and
  // never forwards it as a prop, so it would arrive undefined.
  // A plain function, not a component: it closes over the page's own
  // variables and is called inline as {renderSide(...)} rather than
  // rendered as <RenderSide />, so React never sees it as a component type
  // that gets torn down and rebuilt on every render.
  const renderSide = ({ label, sideKey }: { label: string; sideKey: "assets" | "liabilities" }) => {
    const items = side(sideKey);
    const format = scheduleIII ? "schedule_iii" : "simple";
    const order = sideKey === "liabilities" ? LIABILITY_ORDER[format] : ASSET_ORDER[format];
    // Schedule III always prints its real structural headings, nil or not —
    // Non-current Liabilities is the whole point of this feature, and
    // Shareholders' Funds / Non-current Assets should not silently vanish
    // just because nothing happens to be posted there yet. 'capital' is the
    // one exception even in schedule_iii mode — see SCHEDULE_III_PRESENT_ONLY
    // above. The simple format keeps its original fully data-driven
    // behaviour: a nature heading appears only when at least one ledger
    // under it carries a balance.
    const present = new Set(items.map((r) => r.nature));
    const byNature: readonly string[] = scheduleIII
      ? order.filter((n) => !SCHEDULE_III_PRESENT_ONLY.has(n) || present.has(n))
      : order.filter((n) => present.has(n));
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
        {renderSide({
          label: scheduleIII ? "Equity and Liabilities" : "Liabilities",
          sideKey: "liabilities",
        })}
        {renderSide({ label: "Assets", sideKey: "assets" })}
      </div>
      {scheduleIII && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          Shareholders&rsquo; Funds and Non-current Liabilities show Schedule
          III&rsquo;s own inner line items now. &ldquo;Other Long-term
          Liabilities&rdquo; is itself one of Schedule III&rsquo;s four real
          Non-current Liabilities lines, not a leftover bucket. &ldquo;Other
          Shareholders&rsquo; Funds&rdquo; is different: it only appears if
          something is still posted directly to the old &ldquo;Capital
          Account&rdquo; group from before this split existed — move those
          ledgers into Share Capital or Reserves and Surplus and that row
          disappears on its own. Still open: assets are not split into
          Tangible / Intangible / Capital Work-in-Progress / Investments, and
          the Profit &amp; Loss statement on this report page is still the
          simple format, not yet Schedule III&rsquo;s.
        </p>
      )}
    </ReportShell>
  );
}
