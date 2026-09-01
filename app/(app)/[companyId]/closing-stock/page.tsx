import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { PostClosingStockButton } from "@/components/stock/PostClosingStockButton";

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

export default async function ClosingStockPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/closing-stock">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const asAt = typeof sp.as_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_at)
    ? sp.as_at
    : todayLocal();

  const [{ data: stockRows }, { data: branch }, { data: ledgerRow }] = await Promise.all([
    supabase.rpc("get_stock_summary", {
      p_company_id: companyId,
      p_as_at: asAt,
      p_godown_id: undefined,
    }),
    supabase
      .from("branches")
      .select("id")
      .eq("company_id", companyId)
      .order("is_head_office", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // What the inventory ledger already carries at this date, read the
    // same way every statement reads a closing balance.
    supabase.rpc("get_balance_sheet", { p_company_id: companyId, p_as_at: asAt }),
  ]);

  const rows = stockRows ?? [];
  const valuation = rows.reduce((n, r) => n + Number(r.closing_value), 0);
  // Filter by ledger_role, exactly as post_closing_stock resolves it (1200).
  // This used to filter on the GROUP name while the posting matched a LEDGER
  // name, so the two could disagree about what the books carry — the screen
  // showing "9,84,000.00 to post" beside a button answering "there is no
  // movement to post" was that disagreement, and it left no way out.
  const carried = (ledgerRow ?? [])
    .filter((r) => r.ledger_role === "stock")
    .reduce((n, r) => n + Number(r.amount), 0);
  const delta = Math.round((valuation - carried) * 100) / 100;

  return (
    <ReportShell
      title="Closing stock"
      period={`As at ${formatDate(asAt)}`}
      status={{
        label: delta === 0 ? "Books are up to date" : `${formatINR(Math.abs(delta))} to post`,
        tone: delta === 0 ? "ok" : "warn",
      }}
    >
      <div className="grid gap-px border-b border-border bg-border sm:grid-cols-3">
        <div className="bg-surface px-4 py-3">
          <div className="text-xs text-ink-faint">Stock is worth</div>
          <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
            {formatINR(valuation, { showZero: true })}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">per the stock valuation</div>
        </div>
        <div className="bg-surface px-4 py-3">
          <div className="text-xs text-ink-faint">Books carry</div>
          <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
            {formatINR(carried, { showZero: true })}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">Stock-in-Hand ledger</div>
        </div>
        <div className="bg-surface px-4 py-3">
          <div className="text-xs text-ink-faint">Difference</div>
          <div
            className={
              "mt-0.5 font-mono text-lg tabular-nums " +
              (delta === 0 ? "text-ink-faint" : "text-ink")
            }
          >
            {delta === 0 ? "—" : formatINR(delta, { showZero: true })}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">
            {delta === 0 ? "nothing to post" : delta > 0 ? "to bring onto the books" : "to release"}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <form className="flex items-center gap-2 text-sm" action="">
          <label htmlFor="as_at" className="text-ink-soft">
            As at
          </label>
          <input
            type="date"
            id="as_at"
            name="as_at"
            defaultValue={asAt}
            className="rounded-md border border-border-strong bg-surface px-2 py-1"
          />
          <button
            type="submit"
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            Show
          </button>
        </form>
        {delta !== 0 && branch?.id && (
          <PostClosingStockButton
            companyId={companyId}
            branchId={branch.id}
            asAt={asAt}
            asAtLabel={formatDate(asAt)}
            delta={delta}
          />
        )}
      </div>

      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Item</th>
            <th className={th + " text-right"}>Closing qty</th>
            <th className={th + " text-right"}>Rate</th>
            <th className={th + " text-right"}>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-10 text-center text-ink-faint">
                Nothing in stock at this date.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.item_id} className="border-b border-border last:border-0">
              <td className={td}>{r.item_name}</td>
              <td className={num}>
                {formatINR(Number(r.closing_quantity), { showZero: true })} {r.uom}
              </td>
              <td className={num}>{formatINR(Number(r.average_rate), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.closing_value), { showZero: true })}</td>
            </tr>
          ))}
          {rows.length > 0 && (
            <tr className="bg-bg font-semibold">
              <td className={td} colSpan={3}>
                Total
              </td>
              <td className={num}>{formatINR(valuation, { showZero: true })}</td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Posting writes one journal dated{" "}
        {formatDate(asAt)}: <strong className="font-medium text-ink">Dr Stock-in-Hand</strong>,{" "}
        <strong className="font-medium text-ink">Cr Changes in Inventories</strong> — the second
        being a Direct Expenses contra, not an income ledger, so booking stock reduces cost of goods
        sold instead of inflating sales. Until it is posted, the balance sheet shows no inventory at
        all and gross profit is sales less <em>purchases</em> rather than less cost of goods sold.
      </p>
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Only the difference is posted, so this is safe to run again as trading continues — each run
        books the movement since the last one, and running it twice with nothing in between is
        refused rather than doubled. Run it as often as the books need it: monthly for a bank
        statement, or once at year end. This is the periodic method — purchases are expensed as they
        happen and stock is brought on at a chosen date; it does not capitalise each purchase or
        post cost of goods sold per sale. Valuation follows{" "}
        <Link href={`/${companyId}/reports/stock`} className="underline">
          the stock report
        </Link>
        , at weighted average cost.
      </p>
    </ReportShell>
  );
}
