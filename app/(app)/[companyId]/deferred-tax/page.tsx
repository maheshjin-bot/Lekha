import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { PostDeferredTaxButton } from "@/components/fixed-assets/PostDeferredTaxButton";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * 31 March of the calendar April-March tax year containing today's local
 * date — same rule get_tax_depreciation_blocks and its report page already
 * use. Deferred tax is reconciled only as at a financial year end; see the
 * migration header (0091) for why an arbitrary interim date, unlike the
 * book-depreciation screen, is not something get_tax_depreciation_blocks can
 * answer correctly.
 */
function currentTaxYearEnd(): string {
  const today = todayLocal();
  const [y, m] = today.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return `${startYear + 1}-03-31`;
}

function isFyEnd(date: string): boolean {
  return /^\d{4}-03-31$/.test(date);
}

export default async function DeferredTaxPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/deferred-tax">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const fyEnd =
    typeof sp.fy_end === "string" && isFyEnd(sp.fy_end) ? sp.fy_end : currentTaxYearEnd();
  const fyStart = `${Number(fyEnd.slice(0, 4)) - 1}-04-01`;

  const [{ data: reconRows, error: reconError }, { data: branch }] = await Promise.all([
    supabase.rpc("get_deferred_tax_reconciliation", { p_company_id: companyId, p_fy_end: fyEnd }),
    supabase
      .from("branches")
      .select("id")
      .eq("company_id", companyId)
      .order("is_head_office", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const r = reconRows?.[0];
  const applicable = r?.applicable === true;
  const movement = Number(r?.movement_to_post ?? 0);
  const target = Number(r?.target_deferred_tax_liability ?? 0);
  const carried = Number(r?.ledger_carried ?? 0);
  const rate = Number(r?.effective_tax_rate ?? 0);
  const timingDiff = Number(r?.cumulative_timing_difference ?? 0);
  const taxDep = Number(r?.cumulative_tax_depreciation ?? 0);
  const bookDep = Number(r?.cumulative_book_depreciation ?? 0);
  const rounded = (n: number) => Math.round(n * 100) / 100;

  return (
    <ReportShell
      title="Deferred tax (AS 22 / Ind AS 12)"
      period={`FY ending ${formatDate(fyEnd)} · ${fyStart} to ${fyEnd}`}
      status={
        reconError
          ? { label: reconError.message, tone: "bad" }
          : !applicable
            ? { label: r?.note ?? "Not computed for this entity type", tone: "warn" }
            : {
                label: rounded(movement) === 0 ? "Up to date" : `${formatINR(Math.abs(movement))} to post`,
                tone: rounded(movement) === 0 ? "ok" : "warn",
              }
      }
    >
      {reconError && (
        <div className="border-b border-border bg-error-soft px-4 py-3 text-xs text-ink">
          {reconError.message}
        </div>
      )}

      {!reconError && !applicable && (
        <div className="border-b border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          {r?.note}
        </div>
      )}

      {!reconError && applicable && (
        <>
          <div className="grid gap-px border-b border-border bg-border sm:grid-cols-3">
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Tax depreciation to date</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(taxDep, { showZero: true })}
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">Income-tax Act blocks, life to date</div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Book depreciation to date</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(bookDep, { showZero: true })}
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">
                Actually posted to the Depreciation ledger — not the register
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Timing difference</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(timingDiff, { showZero: true })}
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">
                {timingDiff > 0 ? "tax ahead of books — a liability" : timingDiff < 0 ? "books ahead of tax — an asset" : "none"}
              </div>
            </div>
          </div>

          <div className="grid gap-px border-b border-border bg-border sm:grid-cols-4">
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Effective rate</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">{rate}%</div>
              <div className="mt-0.5 text-xs text-ink-faint">this FY&rsquo;s total tax ÷ taxable income</div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Target balance</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(Math.abs(target), { showZero: true })}
                <span className="ml-1 text-xs text-ink-faint">{target < 0 ? "asset (Dr)" : target > 0 ? "liability (Cr)" : ""}</span>
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">timing difference × rate</div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Ledger carries</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(Math.abs(carried), { showZero: true })}
                <span className="ml-1 text-xs text-ink-faint">{carried < 0 ? "asset (Dr)" : carried > 0 ? "liability (Cr)" : ""}</span>
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">Deferred Tax Liabilities (Net)</div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">To post</div>
              <div
                className={
                  "mt-0.5 font-mono text-lg tabular-nums " +
                  (rounded(movement) === 0 ? "text-ink-faint" : "text-ink")
                }
              >
                {rounded(movement) === 0 ? "—" : formatINR(Math.abs(movement), { showZero: true })}
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">
                {rounded(movement) === 0 ? "nothing to post" : movement > 0 ? "charge (Dr expense)" : "credit (Cr expense)"}
              </div>
            </div>
          </div>

          <div className="border-b border-border bg-surface-2 px-4 py-3 text-xs text-ink-soft">
            {r?.note}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <form className="flex items-center gap-2 text-sm" action="">
              <label htmlFor="fy_end" className="text-ink-soft">
                Financial year ending
              </label>
              <input
                type="date"
                id="fy_end"
                name="fy_end"
                defaultValue={fyEnd}
                className="rounded-md border border-border-strong bg-surface px-2 py-1"
              />
              <button
                type="submit"
                className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
              >
                Show
              </button>
            </form>
            {rounded(movement) !== 0 && branch?.id && (
              <PostDeferredTaxButton
                companyId={companyId}
                branchId={branch.id}
                fyEnd={fyEnd}
                fyEndLabel={formatDate(fyEnd)}
                movement={movement}
              />
            )}
          </div>
        </>
      )}

      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Line</th>
            <th className={th + " text-right"}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {!applicable && (
            <tr>
              <td colSpan={2} className="px-4 py-10 text-center text-ink-faint">
                Nothing to reconcile for this entity type or period.
              </td>
            </tr>
          )}
          {applicable && (
            <>
              <tr className="border-b border-border">
                <td className={td}>Cumulative tax depreciation claimed (Income-tax Act blocks)</td>
                <td className={num}>{formatINR(taxDep, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Cumulative book depreciation posted (Depreciation ledger)</td>
                <td className={num}>{formatINR(-bookDep, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border font-medium">
                <td className={td}>Cumulative timing difference</td>
                <td className={num}>{formatINR(timingDiff, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>× effective tax rate</td>
                <td className={num}>{rate}%</td>
              </tr>
              <tr className="border-b border-border font-medium">
                <td className={td}>= target Deferred Tax Liabilities (Net) balance</td>
                <td className={num}>{formatINR(target, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Ledger already carries</td>
                <td className={num}>{formatINR(carried, { showZero: true })}</td>
              </tr>
              <tr className="last:border-0 font-medium">
                <td className={td}>Movement to post</td>
                <td className={num}>
                  {rounded(movement) === 0 ? "—" : formatINR(movement, { showZero: true })}
                </td>
              </tr>
            </>
          )}
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Posting writes one journal dated {formatDate(fyEnd)}:{" "}
        <strong className="font-medium text-ink">Dr Deferred Tax Expense</strong> /{" "}
        <strong className="font-medium text-ink">Cr Deferred Tax Liabilities (Net)</strong> when
        the balance needs to grow, reversed when it needs to shrink — which includes the ledger
        crossing into a net deferred tax ASSET, carried as a debit in the same &ldquo;(Net)&rdquo;
        ledger rather than a second one, the same way Accumulated Depreciation stays one contra
        ledger through a disposal. Only the movement since the ledger&rsquo;s current balance is
        posted, so this is safe to re-run.
      </p>
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        This covers the <strong className="font-medium text-ink">depreciation</strong> timing
        difference only — tax depreciation (
        <a href={`/${companyId}/reports/tax-depreciation`} className="underline">
          the tax depreciation report
        </a>
        ) against book depreciation actually posted (
        <a href={`/${companyId}/depreciation`} className="underline">
          the depreciation screen
        </a>
        ), not book depreciation as the fixed asset register would compute it if nothing has been
        posted yet. Other timing differences — Sec 43B unpaid dues, provisions — are real sources
        of deferred tax this screen does not compute. The rate applied is this financial
        year&rsquo;s own effective rate (total tax ÷ taxable income) from the income tax
        computation, applied to the whole cumulative timing difference to date — the balance-
        sheet-date rate AS 22 and Ind AS 12 both call for, re-measuring the full balance whenever
        the rate changes rather than layering each year&rsquo;s rate separately. Because Deferred
        Tax Expense itself sits in the P&amp;L, posting it changes book profit fractionally,
        which can leave a sub-rupee residual to post again next time — re-run this screen after
        posting; a second post, if needed, converges the balance exactly.
      </p>
    </ReportShell>
  );
}
