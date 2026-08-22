import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ITC-04 files half-yearly (AATO > 5cr) or annually (AATO <= 5cr) — never
// monthly, unlike every other statutory report in this app. Rather than
// compute AATO to auto-pick a frequency (a real figure this report doesn't
// otherwise need), this offers the three periods a filer could actually
// need and lets them pick: H1 (Apr-Sep), H2 (Oct-Mar), or the full year.
function halfYearBounds(fyStartYear: number) {
  return {
    h1: { from: `${fyStartYear}-04-01`, to: `${fyStartYear}-09-30`, label: `1 Apr ${fyStartYear} – 30 Sep ${fyStartYear}` },
    h2: {
      from: `${fyStartYear}-10-01`,
      to: `${fyStartYear + 1}-03-31`,
      label: `1 Oct ${fyStartYear} – 31 Mar ${fyStartYear + 1}`,
    },
    full: {
      from: `${fyStartYear}-04-01`,
      to: `${fyStartYear + 1}-03-31`,
      label: `1 Apr ${fyStartYear} – 31 Mar ${fyStartYear + 1}`,
    },
  };
}

export default async function Itc04PrepPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/itc-04-prep">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  // FY starts 1 April — if we're Jan-Mar, the FY started last calendar year.
  const currentFyStartYear = tm >= 4 ? ty : ty - 1;
  const bounds = halfYearBounds(currentFyStartYear);

  const period = sp.period === "h2" ? "h2" : sp.period === "full" ? "full" : "h1";
  const { from, to, label } = bounds[period];

  const [{ data: table4 }, { data: table5a }] = await Promise.all([
    supabase.rpc("get_itc04_table4", { p_company_id: companyId, p_from: from, p_to: to }),
    supabase.rpc("get_itc04_table5a", { p_company_id: companyId, p_from: from, p_to: to }),
  ]);

  const t4 = table4 ?? [];
  const t5a = table5a ?? [];
  const missingGstin = new Set([...t4, ...t5a].filter((r) => !r.job_worker_gstin).map((r) => r.job_worker_name));

  return (
    <ReportShell title="ITC-04 prep" period={label}>
      <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2.5 text-sm print:hidden">
        {(["h1", "h2", "full"] as const).map((p) => (
          <Link
            key={p}
            href={`?period=${p}`}
            className={
              "rounded-md border px-2.5 py-1 " +
              (period === p
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            {p === "h1" ? "H1 (Apr–Sep)" : p === "h2" ? "H2 (Oct–Mar)" : "Full year"}
          </Link>
        ))}
      </div>

      <div className="px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Table 4 — sent for job work</h2>
      </div>
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Challan</th>
            <th className={th}>Job worker</th>
            <th className={th}>GSTIN</th>
            <th className={th}>Item</th>
            <th className={th}>HSN</th>
            <th className={th}>Nature of job work</th>
            <th className={th + " text-right"}>Quantity</th>
          </tr>
        </thead>
        <tbody>
          {t4.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-ink-faint">
                No challans dispatched in this period.
              </td>
            </tr>
          )}
          {t4.map((r) => (
            <tr key={r.challan_id} className="border-b border-border last:border-0">
              <td className={td}>
                {r.challan_number}
                <div className="text-xs text-ink-faint">{r.challan_date}</div>
              </td>
              <td className={td}>{r.job_worker_name}</td>
              <td className={td + " font-mono text-xs"}>{r.job_worker_gstin ?? "—"}</td>
              <td className={td}>{r.item_name}</td>
              <td className={td + " font-mono text-xs"}>{r.hsn_sac ?? "—"}</td>
              <td className={td}>{r.nature_of_job_work ?? "—"}</td>
              <td className={num}>
                {formatINR(Number(r.quantity_sent), { showZero: true })} {r.uom}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">
          Table 5A — received back (same job worker) &amp; losses
        </h2>
      </div>
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Original challan</th>
            <th className={th}>Return date</th>
            <th className={th}>Job worker</th>
            <th className={th}>Item returned</th>
            <th className={th + " text-right"}>Received</th>
            <th className={th + " text-right"}>Loss/waste</th>
          </tr>
        </thead>
        <tbody>
          {t5a.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-ink-faint">
                No returns or losses recorded in this period.
              </td>
            </tr>
          )}
          {t5a.map((r) => (
            <tr key={r.return_id} className="border-b border-border last:border-0">
              <td className={td}>
                {r.original_challan_number}
                <div className="text-xs text-ink-faint">Sent {r.original_challan_date}</div>
              </td>
              <td className={td}>{r.return_date}</td>
              <td className={td}>{r.job_worker_name}</td>
              <td className={td}>
                {r.returned_item_name}
                <div className="text-xs text-ink-faint">{r.hsn_sac}</div>
              </td>
              <td className={num}>
                {formatINR(Number(r.quantity_received), { showZero: true })} {r.uom}
              </td>
              <td className={num}>
                {formatINR(Number(r.quantity_loss_or_waste), { showZero: true })} {r.uom}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {missingGstin.size > 0 && (
        <div className="border-t border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          No GSTIN on file for: {Array.from(missingGstin).join(", ")}. Add it under Ledgers before
          filing — ITC-04 requires the job worker&rsquo;s GSTIN for a registered job worker.
        </div>
      )}
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Prep data in ITC-04&rsquo;s own Table 4 / Table 5A shape, sourced from Job work&rsquo;s
        challan and return records — not a validated match to the GST portal&rsquo;s offline
        utility upload format, which needs its own template file. Use this as a checklist to key
        into that utility, not as a ready-to-upload file. Scoped to Table 4 and 5A only: Table 5B
        (goods returned by a <em>different</em> job worker than the one they were sent to) and
        Table 5C (goods supplied onward directly from the job worker&rsquo;s premises, never
        returned) aren&rsquo;t tracked by this app and aren&rsquo;t covered here.
      </p>
    </ReportShell>
  );
}
