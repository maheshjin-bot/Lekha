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

/**
 * GST returns run on the calendar month, never the company's own financial
 * year — same principle as every other statutory report in this app
 * (compliance calendar, tax depreciation, income tax, GST registers).
 * `month` is "YYYY-MM"; defaults to the current calendar month.
 */
function monthBounds(month?: string): { from: string; to: string; label: string; ym: string } {
  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  let y = ty;
  let m = tm;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    [y, m] = month.split("-").map(Number);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const from = `${y}-${pad(m)}-01`;
  // Day 0 of next month = last day of this month.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${pad(m)}-${pad(lastDay)}`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { from, to, label, ym: `${y}-${pad(m)}` };
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type IsdRow = {
  recipient_registration_id: string;
  recipient_gstin: string;
  recipient_state: string;
  same_state: boolean;
  recipient_turnover: number;
  turnover_ratio: number;
  distributed_cgst: number;
  distributed_sgst: number;
  distributed_igst: number;
  distributed_cess: number;
  distributed_total: number;
};

type IsdRegistration = {
  id: string;
  gstin: string;
  state_code: string;
  registration_type: string;
};

function DistributionTable({ rows }: { rows: IsdRow[] }) {
  const totals = rows.reduce(
    (acc, r) => ({
      turnover: acc.turnover + Number(r.recipient_turnover),
      ratio: acc.ratio + Number(r.turnover_ratio),
      cgst: acc.cgst + Number(r.distributed_cgst),
      sgst: acc.sgst + Number(r.distributed_sgst),
      igst: acc.igst + Number(r.distributed_igst),
      cess: acc.cess + Number(r.distributed_cess),
      total: acc.total + Number(r.distributed_total),
    }),
    { turnover: 0, ratio: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 }
  );
  const empty = rows.length === 0 || totals.total === 0;

  return (
    <table className="w-full min-w-[840px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>GSTIN</th>
          <th className={th}>State</th>
          <th className={th + " text-right"}>Turnover</th>
          <th className={th + " text-right"}>Ratio</th>
          <th className={th + " text-right"}>CGST</th>
          <th className={th + " text-right"}>SGST</th>
          <th className={th + " text-right"}>IGST</th>
          <th className={th + " text-right"}>Cess</th>
          <th className={th + " text-right"}>Total</th>
        </tr>
      </thead>
      <tbody>
        {empty && (
          <tr>
            <td colSpan={9} className="px-4 py-10 text-center text-ink-faint">
              {rows.length === 0
                ? "No other GST registrations to distribute to. Add recipient registrations under Registrations."
                : "Nothing to distribute this month — no input tax credit posted to the ISD registration for this period."}
            </td>
          </tr>
        )}
        {!empty &&
          rows.map((r) => (
            <tr key={r.recipient_registration_id} className="border-b border-border last:border-0">
              <td className={td + " font-mono text-xs"}>{r.recipient_gstin}</td>
              <td className={td + " text-ink-soft"}>
                {r.recipient_state} · {r.same_state ? "Same state" : "Cross-state"}
              </td>
              <td className={num}>{formatINR(Number(r.recipient_turnover), { showZero: true })}</td>
              <td className={num}>{(Number(r.turnover_ratio) * 100).toFixed(2)}%</td>
              <td className={num}>{formatINR(Number(r.distributed_cgst), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.distributed_sgst), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.distributed_igst), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.distributed_cess), { showZero: true })}</td>
              <td className={num + " font-medium"}>
                {formatINR(Number(r.distributed_total), { showZero: true })}
              </td>
            </tr>
          ))}
        {!empty && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={2}>
              Total
            </td>
            <td className={num}>{formatINR(totals.turnover, { showZero: true })}</td>
            <td className={num}>{(totals.ratio * 100).toFixed(2)}%</td>
            <td className={num}>{formatINR(totals.cgst, { showZero: true })}</td>
            <td className={num}>{formatINR(totals.sgst, { showZero: true })}</td>
            <td className={num}>{formatINR(totals.igst, { showZero: true })}</td>
            <td className={num}>{formatINR(totals.cess, { showZero: true })}</td>
            <td className={num}>{formatINR(totals.total, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default async function IsdDistributionPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/isd-distribution">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const isdParam = typeof sp.isd === "string" ? sp.isd : undefined;
  const { from, to, label, ym } = monthBounds(monthParam);

  const [{ data: modules }, { data: registrations }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase
      .from("gst_registrations")
      .select("id, gstin, state_code, registration_type")
      .eq("company_id", companyId)
      .order("gstin"),
  ]);

  const isdModuleOn = (modules ?? []).some((m) => m.code === "gst_isd" && m.active);

  if (!isdModuleOn) {
    return (
      <ReportShell title="ISD distribution" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">Not turned on for this company</p>
          <p className="mt-1">
            Input Service Distributor (GSTR-6 / Rule 39) is a separate
            module from GST itself.{" "}
            <Link href={`/${companyId}/settings/modules`} className="underline">
              Turn it on in Settings → Modules
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const isdRegistrations = ((registrations ?? []) as IsdRegistration[]).filter(
    (r) => r.registration_type === "isd"
  );

  if (isdRegistrations.length === 0) {
    return (
      <ReportShell title="ISD distribution" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">No ISD registration on this company</p>
          <p className="mt-1">
            This report distributes from a GST registration of type Input
            Service Distributor — add one first, with registration type ISD
            —{" "}
            <Link href={`/${companyId}/registrations`} className="underline">
              Registrations
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const activeIsd = isdRegistrations.find((r) => r.id === isdParam) ?? isdRegistrations[0];

  const { data: rows } = await supabase.rpc("get_isd_distribution", {
    p_company_id: companyId,
    p_isd_registration_id: activeIsd.id,
    p_period_start: from,
    p_period_end: to,
  });

  const distribution = (rows ?? []) as IsdRow[];
  const totalDistributed = distribution.reduce((n, r) => n + Number(r.distributed_total), 0);

  const base = `/${companyId}/reports/isd-distribution`;
  const isdQuery = `&isd=${activeIsd.id}`;

  return (
    <ReportShell
      title="ISD distribution"
      period={`${label} · GSTR-6 distribution prep, not a filing`}
      status={{
        label: `${formatINR(totalDistributed, { showZero: true })} distributed`,
        tone: "ok",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`${base}?month=${shiftMonth(ym, -1)}${isdQuery}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link
            href={`${base}?month=${shiftMonth(ym, 1)}${isdQuery}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            Next →
          </Link>
        </div>

        {isdRegistrations.length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            {isdRegistrations.map((r) => (
              <Link
                key={r.id}
                href={`${base}?month=${ym}&isd=${r.id}`}
                className={
                  "rounded-md border px-2.5 py-1 font-mono text-xs " +
                  (activeIsd.id === r.id
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border-strong hover:bg-surface-2")
                }
              >
                {r.gstin}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="border-b border-border p-4">
        <h2 className="font-semibold">
          Distributing from {activeIsd.gstin} ({activeIsd.state_code})
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Input tax credit posted under this ISD registration during the
          period, split pro-rata by turnover across every other GST
          registration on this PAN.
        </p>
      </div>
      <DistributionTable rows={distribution} />

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Rule 39 split: each recipient&rsquo;s share is its turnover in the
        preceding April&ndash;March financial year over the combined turnover
        of every recipient in that year, falling back to an equal split only
        when none of them has any turnover on record for that year at all —
        not recipient-by-recipient, which would misread a genuinely
        zero-turnover branch as excluded rather than sharing equally. A
        recipient that is itself new, with no history in the preceding FY,
        reads as zero turnover for its own share regardless — correct only
        when every recipient is in the same position and the equal-split
        fallback applies. CGST/SGST is distributed as CGST/SGST to a
        recipient in the same state as this ISD registration and converted
        to IGST for one in a different state; IGST and cess are always
        distributed as-is, unaffected by location. This is the GSTR-6 split
        calculation only — it does not post the ITC transfer journal entries
        (do that by hand, for now) and does not file anything anywhere;
        LEKHA has no GSTN API access.
      </p>
    </ReportShell>
  );
}
