import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

type Row = {
  batch_id: string;
  item_id: string;
  item_name: string;
  uom: string;
  batch_no: string;
  mfg_date: string | null;
  expiry_date: string | null;
  days_to_expiry: number | null;
  quantity_in: number;
  quantity_out: number;
  quantity_on_hand: number;
};

function urgency(days: number | null): { tone: "bad" | "warn" | "ok" | "neutral"; label: string } {
  if (days == null) return { tone: "neutral", label: "No expiry" };
  if (days < 0) return { tone: "bad", label: "Expired" };
  if (days <= 7) return { tone: "bad", label: `${days}d left` };
  if (days <= 30) return { tone: "warn", label: `${days}d left` };
  return { tone: "ok", label: `${days}d left` };
}

export default async function StockExpiryPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/stock-expiry">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: godowns } = await supabase
    .from("godowns")
    .select("id, code, name")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("code");

  const activeGodowns = godowns ?? [];
  const requestedGodownId = typeof sp.godown === "string" ? sp.godown : undefined;
  const selectedGodownId =
    requestedGodownId && activeGodowns.some((g) => g.id === requestedGodownId)
      ? requestedGodownId
      : null;
  const selectedGodown = activeGodowns.find((g) => g.id === selectedGodownId);
  const base = `/${companyId}/reports/stock-expiry`;

  const [{ data }, { data: unallocatedOut }] = await Promise.all([
    supabase.rpc("get_batch_stock_summary", {
      p_company_id: companyId,
      p_godown_id: selectedGodownId ?? undefined,
    }),
    supabase.rpc("get_unallocated_stock_lines", { p_company_id: companyId, p_direction: "out" }),
  ]);

  const allRows = (data ?? []) as Row[];
  // On hand only — a batch that's fully sold out has nothing left to expire.
  const rows = allRows
    .filter((r) => Number(r.quantity_on_hand) > 0.0005)
    .sort((a, b) => {
      if (a.expiry_date == null) return 1;
      if (b.expiry_date == null) return -1;
      return a.expiry_date.localeCompare(b.expiry_date);
    });

  const expiredCount = rows.filter((r) => (r.days_to_expiry ?? 999) < 0).length;
  const soonCount = rows.filter(
    (r) => r.days_to_expiry != null && r.days_to_expiry >= 0 && r.days_to_expiry <= 30
  ).length;

  // get_unallocated_stock_lines has no godown filter of its own, but it
  // already returns godown_id/godown_name per row (see 0067) — so the same
  // selectedGodownId narrows this footer client-side rather than needing
  // the RPC extended for a count that's advisory, not part of the tabulated
  // report above.
  const unallocatedOutAllRows = (unallocatedOut ?? []) as {
    unallocated_quantity: number;
    godown_id: string | null;
  }[];
  const unallocatedOutRows = selectedGodownId
    ? unallocatedOutAllRows.filter((r) => r.godown_id === selectedGodownId)
    : unallocatedOutAllRows;
  const unallocatedOutTotal = unallocatedOutRows.reduce(
    (n, r) => n + Number(r.unallocated_quantity),
    0
  );

  return (
    <ReportShell
      title="Stock expiry"
      period={
        `As at ${new Date().toISOString().slice(0, 10)}` +
        (selectedGodown ? ` · ${selectedGodown.name}` : "")
      }
      status={
        expiredCount > 0
          ? { label: `${expiredCount} expired`, tone: "bad" }
          : soonCount > 0
            ? { label: `${soonCount} expiring within 30 days`, tone: "warn" }
            : { label: "Nothing urgent", tone: "ok" }
      }
    >
      {activeGodowns.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
          <Link
            href={base}
            className={
              "rounded-md border px-2.5 py-1 text-sm " +
              (!selectedGodownId
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            All godowns
          </Link>
          {activeGodowns.map((g) => (
            <Link
              key={g.id}
              href={`${base}?godown=${g.id}`}
              className={
                "rounded-md border px-2.5 py-1 text-sm " +
                (selectedGodownId === g.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-strong hover:bg-surface-2")
              }
            >
              {g.code} — {g.name}
            </Link>
          ))}
        </div>
      )}
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Item</th>
            <th className={th}>Batch / serial</th>
            <th className={th}>Mfg date</th>
            <th className={th}>Expiry date</th>
            <th className={th}>Status</th>
            <th className={th + " text-right"}>On hand</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-ink-faint">
                {selectedGodown
                  ? `No batch-tracked stock currently on hand in ${selectedGodown.name}.`
                  : "No batch-tracked stock currently on hand."}
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const u = urgency(r.days_to_expiry);
            return (
              <tr
                key={r.batch_id}
                className={
                  "border-b border-border last:border-0 " +
                  (u.tone === "bad" ? "bg-error-soft/40" : u.tone === "warn" ? "bg-warning-soft/40" : "")
                }
              >
                <td className={td}>{r.item_name}</td>
                <td className={td + " font-mono text-xs"}>{r.batch_no}</td>
                <td className={td}>{r.mfg_date ?? "—"}</td>
                <td className={td}>{r.expiry_date ?? "—"}</td>
                <td className={td}>
                  <Badge tone={u.tone}>{u.label}</Badge>
                </td>
                <td className={num}>
                  {formatINR(Number(r.quantity_on_hand), { showZero: true })} {r.uom}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {unallocatedOutTotal > 0.0005 && (
        <div className="border-t border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          {unallocatedOutRows.length} sale/issue line
          {unallocatedOutRows.length === 1 ? " is" : "s are"} on batch-tracked items but
          not yet tagged to a specific batch — the &ldquo;on hand&rdquo; figures above are
          only as complete as the tagging behind them.{" "}
          <Link href={`/${companyId}/batches`} className="underline">
            Allocate them
          </Link>
          .
        </div>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        A physical quantity ledger, not a valuation report — figures here are quantities
        on hand per batch/serial, sourced from what has actually been tagged on the
        Batches &amp; serials workbench. Stock is still costed by moving weighted average
        across the whole item everywhere else in the app; this report doesn&rsquo;t change
        that.
      </p>
    </ReportShell>
  );
}
