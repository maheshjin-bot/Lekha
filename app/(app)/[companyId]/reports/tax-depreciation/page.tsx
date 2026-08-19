import { Fragment } from "react";
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
 * statutory block-of-assets WDV depreciation under the Income-tax Act
 * always runs on the calendar year, exactly like get_compliance_calendar
 * (migration 0024) already established for this codebase. A company on a
 * July book year still gets an April–March tax block here.
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

export default async function TaxDepreciationPage({
  params,
}: PageProps<"/[companyId]/reports/tax-depreciation">) {
  const { companyId } = await params;
  const supabase = await createClient();
  const { from, to, label } = taxYearBounds();

  const { data: rows } = await supabase.rpc("get_tax_depreciation_blocks", {
    p_company_id: companyId,
    p_fy_start: from,
    p_fy_end: to,
  });

  const blocks = rows ?? [];
  const totalDepreciation = blocks.reduce((n, b) => n + Number(b.depreciation_for_year), 0);
  const capitalEventBlocks = blocks.filter(
    (b) => b.short_term_capital_gain != null || b.short_term_capital_loss != null
  );

  return (
    <ReportShell
      title="Tax depreciation"
      period={`FY ${label} · ${from} to ${to} · calendar April–March tax year, not this company's book year`}
      status={
        capitalEventBlocks.length > 0
          ? {
              label: `${capitalEventBlocks.length} block${capitalEventBlocks.length === 1 ? "" : "s"} need capital gains treatment`,
              tone: "warn",
            }
          : {
              label: `${formatINR(totalDepreciation, { showZero: true })} depreciation for the year`,
              tone: "ok",
            }
      }
    >
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left dark:border-zinc-800">
            <th className={th}>Block</th>
            <th className={th + " text-right"}>Rate</th>
            <th className={th + " text-right"}>Opening WDV</th>
            <th className={th + " text-right"}>Additions</th>
            <th className={th + " text-right"}>Disposals</th>
            <th className={th + " text-right"}>Depreciation for year</th>
            <th className={th + " text-right"}>Closing WDV</th>
          </tr>
        </thead>
        <tbody>
          {blocks.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-zinc-500">
                No tax blocks with activity in FY {label}.
              </td>
            </tr>
          )}
          {blocks.map((b) => {
            const gain = b.short_term_capital_gain != null ? Number(b.short_term_capital_gain) : null;
            const loss = b.short_term_capital_loss != null ? Number(b.short_term_capital_loss) : null;
            const flagged = gain != null || loss != null;

            return (
              <Fragment key={b.block_code}>
                <tr
                  className={
                    "border-b border-zinc-100 last:border-0 dark:border-zinc-800/60 " +
                    (flagged ? "bg-amber-50 dark:bg-amber-950/20" : "")
                  }
                >
                  <td className={td + " font-medium"}>
                    {b.block_description}
                    <div className="font-mono text-xs text-zinc-500">{b.block_code}</div>
                  </td>
                  <td className={num}>{Number(b.rate_percent)}%</td>
                  <td className={num}>{formatINR(Number(b.opening_wdv))}</td>
                  <td className={num}>{formatINR(Number(b.additions))}</td>
                  <td className={num}>{formatINR(Number(b.disposals))}</td>
                  <td className={num}>{formatINR(Number(b.depreciation_for_year))}</td>
                  <td className={num + " font-medium"}>{formatINR(Number(b.closing_wdv))}</td>
                </tr>
                {flagged && (
                  <tr className="border-b border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/20">
                    <td colSpan={7} className="px-4 py-2.5 text-xs text-amber-900 dark:text-amber-300">
                      <span className="font-semibold">Sec 50 capital gains, not depreciation</span>{" "}
                      — this block{" "}
                      {b.block_ceased
                        ? "ceased to exist (no assets left in it)"
                        : "was disposed for more than its written-down value"}{" "}
                      during the year.
                      {gain != null &&
                        ` Short-term capital gain of ${formatINR(gain, { showZero: true })} applies.`}
                      {loss != null &&
                        ` Short-term capital loss of ${formatINR(loss, { showZero: true })} applies.`}{" "}
                      Treat this separately in the capital gains computation — it is not part of
                      ordinary block depreciation and is excluded from the total above.
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      <p className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500 dark:border-zinc-800">
        This is TAX depreciation — block-of-assets WDV under the Income-tax
        Act, always computed on the calendar April–March year regardless of
        this company&rsquo;s own financial year setting. It is a separate
        computation from the book depreciation shown on the Fixed assets
        register: the categories, methods and rates differ by design, and the
        two are not reconcilable line by line. Additional depreciation for new
        manufacturing plant &mdash; Sec 33(8)&ndash;(9) of the Income-tax Act
        2025 (old Act&rsquo;s Sec 32(1)(iia); unrelated to the old Act&rsquo;s
        own long-obsolete Sec 33 &ldquo;development rebate&rdquo;) &mdash; is
        not yet computed by this report. A deliberate v1 scope cut, not an
        oversight; claim it separately until it is added.
      </p>
    </ReportShell>
  );
}
