import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { PostDepreciationButton } from "@/components/fixed-assets/PostDepreciationButton";

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

export default async function DepreciationPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/depreciation">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const asAt =
    typeof sp.as_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_at) ? sp.as_at : todayLocal();

  const [{ data: assets }, { data: recon }, { data: branch }] = await Promise.all([
    supabase.rpc("get_fixed_asset_register", { p_company_id: companyId, p_as_at: asAt }),
    supabase.rpc("get_fixed_asset_book_reconciliation", {
      p_company_id: companyId,
      p_as_at: asAt,
    }),
    supabase
      .from("branches")
      .select("id")
      .eq("company_id", companyId)
      .order("is_head_office", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const rows = (assets ?? []).filter((r) => !r.disposal_date || r.disposal_date > asAt);
  const r = recon?.[0];
  const registerAccum = Number(r?.register_accumulated ?? 0);
  const booksAccum = Number(r?.books_accumulated ?? 0);
  const delta = Math.round((registerAccum - booksAccum) * 100) / 100;
  const grossGap = Number(r?.gross_gap ?? 0);

  return (
    <ReportShell
      title="Depreciation"
      period={`As at ${formatDate(asAt)}`}
      status={{
        label: delta === 0 ? "Books are up to date" : `${formatINR(Math.abs(delta))} to post`,
        tone: delta === 0 ? "ok" : "warn",
      }}
    >
      <div className="grid gap-px border-b border-border bg-border sm:grid-cols-3">
        <div className="bg-surface px-4 py-3">
          <div className="text-xs text-ink-faint">Register says</div>
          <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
            {formatINR(registerAccum, { showZero: true })}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">accumulated depreciation</div>
        </div>
        <div className="bg-surface px-4 py-3">
          <div className="text-xs text-ink-faint">Books carry</div>
          <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
            {formatINR(booksAccum, { showZero: true })}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">Accumulated Depreciation ledger</div>
        </div>
        <div className="bg-surface px-4 py-3">
          <div className="text-xs text-ink-faint">To charge</div>
          <div
            className={
              "mt-0.5 font-mono text-lg tabular-nums " +
              (delta === 0 ? "text-ink-faint" : "text-ink")
            }
          >
            {delta === 0 ? "—" : formatINR(delta, { showZero: true })}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">
            {delta === 0 ? "nothing to post" : delta > 0 ? "not yet in the P&L" : "to release"}
          </div>
        </div>
      </div>

      {grossGap !== 0 && (
        <div className="border-b border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          <p className="font-medium">
            Asset purchases worth {formatINR(Math.abs(grossGap))} are not in the books.
          </p>
          <p className="mt-1">
            The register holds {formatINR(Number(r?.register_gross ?? 0))} of assets while the
            fixed-asset ledgers carry {formatINR(Number(r?.books_gross ?? 0))}. Posting depreciation
            here charges the expense correctly, but until each purchase is entered as its own
            voucher — Dr the asset ledger, Cr whatever paid for it — the balance sheet will show the
            accumulated depreciation without the asset it belongs to, i.e. a negative block. Only
            you know which account funded each asset, so this screen will not guess it.
          </p>
        </div>
      )}

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
          <PostDepreciationButton
            companyId={companyId}
            branchId={branch.id}
            asAt={asAt}
            asAtLabel={formatDate(asAt)}
            delta={delta}
          />
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Asset</th>
              <th className={th}>Method</th>
              <th className={th}>Put to use</th>
              <th className={th + " text-right"}>Gross</th>
              <th className={th + " text-right"}>Accumulated</th>
              <th className={th + " text-right"}>Net book value</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-faint">
                  No asset was held at this date.
                </td>
              </tr>
            )}
            {rows.map((a) => (
              <tr key={a.asset_id} className="border-b border-border last:border-0">
                <td className={td}>
                  {a.name}
                  {a.asset_code && <div className="text-xs text-ink-faint">{a.asset_code}</div>}
                </td>
                <td className={td}>{a.book_method}</td>
                <td className={td}>{a.put_to_use_date}</td>
                <td className={num}>{formatINR(Number(a.gross_value), { showZero: true })}</td>
                <td className={num}>
                  {formatINR(Number(a.accumulated_depreciation), { showZero: true })}
                </td>
                <td className={num + " font-medium"}>
                  {formatINR(Number(a.net_book_value), { showZero: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Posting writes one journal dated {formatDate(asAt)}:{" "}
        <strong className="font-medium text-ink">Dr Depreciation</strong>,{" "}
        <strong className="font-medium text-ink">Cr Accumulated Depreciation</strong> — the second
        being a contra that sits with the assets it reduces, so the balance sheet keeps showing gross
        cost less accumulated depreciation rather than silently writing the assets down. Until it is
        posted, the P&amp;L carries no depreciation at all and profit is overstated by the charge.
      </p>
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Only the movement since the last posting is charged, so this is safe to re-run — monthly,
        quarterly or once at year end all arrive at the same balance, and running it twice on one
        date is refused rather than doubled. This is the{" "}
        <strong className="font-medium text-ink">book</strong> charge (Companies Act, per each
        asset&rsquo;s own method). Depreciation under the Income-tax Act is computed separately on{" "}
        <Link href={`/${companyId}/reports/tax-depreciation`} className="underline">
          the tax depreciation report
        </Link>{" "}
        and is deliberately never posted — the two legitimately differ, and that difference is what a
        deferred tax working is made of.
      </p>
    </ReportShell>
  );
}
