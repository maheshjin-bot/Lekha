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

/** GST returns run on the calendar month — same convention as gst-registers / gstr1-summary. */
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

/** 1 Apr → 31 Mar — the window Rule 42(2)'s own annual true-up recomputes over. */
function fyBounds(fyStartYear: number): { from: string; to: string; label: string } {
  return {
    from: `${fyStartYear}-04-01`,
    to: `${fyStartYear + 1}-03-31`,
    label: `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")} (1 Apr ${fyStartYear} – 31 Mar ${fyStartYear + 1})`,
  };
}

type Result = {
  total_input_tax: number;
  blocked_itc: number;
  eligible_itc: number;
  exempt_linked_itc: number;
  common_credit: number;
  common_credit_cgst: number;
  common_credit_sgst: number;
  common_credit_igst: number;
  common_credit_cess: number;
  exempt_turnover: number;
  total_turnover: number;
  exempt_turnover_ratio: number;
  d1_reversal: number;
  d2_reversal: number;
  total_reversal: number;
  reversal_cgst: number;
  reversal_sgst: number;
  reversal_igst: number;
  reversal_cess: number;
  net_common_credit_retained: number;
};

export default async function CommonCreditApportionmentPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/common-credit-apportionment">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  const currentFyStartYear = tm >= 4 ? ty : ty - 1;

  const mode = sp.mode === "fy" ? "fy" : "month";
  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const fyParam =
    typeof sp.fy === "string" && /^\d{4}$/.test(sp.fy) ? Number(sp.fy) : currentFyStartYear;

  const { from, to, label, ym } =
    mode === "fy"
      ? { ...fyBounds(fyParam), ym: "" }
      : monthBounds(monthParam);

  const { data, error } = await supabase.rpc("get_common_credit_apportionment", {
    p_company_id: companyId,
    p_period_start: from,
    p_period_end: to,
  });

  const r = (Array.isArray(data) ? data[0] : data) as Result | undefined;
  const base = `/${companyId}/reports/common-credit-apportionment`;

  const totalReversal = Number(r?.total_reversal ?? 0);
  const hasCommonCredit = Number(r?.common_credit ?? 0) > 0;
  const hasExempt = Number(r?.exempt_turnover ?? 0) > 0;

  return (
    <ReportShell
      title="Common-credit apportionment (Rule 42)"
      period={`${mode === "fy" ? label : `${label} · provisional monthly figure`} · CGST Rule 42 — not a filing`}
      status={
        error
          ? { label: "Could not compute", tone: "bad" }
          : !hasCommonCredit
            ? { label: "No common credit this period", tone: "ok" }
            : { label: `${formatINR(totalReversal, { showZero: true })} reversal due`, tone: hasExempt ? "warn" : "ok" }
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 print:hidden">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`${base}?mode=month`}
            className={
              "rounded-md border px-2.5 py-1 " +
              (mode === "month" ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
            }
          >
            Monthly (provisional)
          </Link>
          <Link
            href={`${base}?mode=fy&fy=${currentFyStartYear}`}
            className={
              "rounded-md border px-2.5 py-1 " +
              (mode === "fy" ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
            }
          >
            Full year (annual true-up)
          </Link>
        </div>

        {mode === "month" ? (
          <div className="flex items-center gap-2 text-sm">
            <Link href={`${base}?mode=month&month=${shiftMonth(ym, -1)}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
              ← Prev
            </Link>
            <span className="px-2 font-medium">{label}</span>
            <Link href={`${base}?mode=month&month=${shiftMonth(ym, 1)}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
              Next →
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <Link href={`${base}?mode=fy&fy=${fyParam - 1}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
              ← Prev
            </Link>
            <span className="px-2 font-medium">{label}</span>
            <Link href={`${base}?mode=fy&fy=${fyParam + 1}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
              Next →
            </Link>
          </div>
        )}
      </div>

      {error && (
        <div className="m-4 rounded-md bg-error-soft px-4 py-3 text-sm text-error">
          Could not compute this report: {error.message}
        </div>
      )}

      {!error && r && (
        <>
          <div className="grid gap-px border-b border-border bg-border sm:grid-cols-4">
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Common credit (C2)</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(Number(r.common_credit), { showZero: true })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Exempt turnover ratio (E/F)</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {(Number(r.exempt_turnover_ratio) * 100).toFixed(2)}%
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Reversal due (D1 + D2)</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-warning">
                {formatINR(totalReversal, { showZero: true })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Common credit retained (C3)</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(Number(r.net_common_credit_retained), { showZero: true })}
              </div>
            </div>
          </div>

          <div className="border-b border-border p-4">
            <h2 className="font-semibold">Where the period&rsquo;s input tax went (T → C2)</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Total input tax on purchases and debit notes, split into what is blocked outright
              (Sec 17(5)), what is directly attributable to exempt-nature purchases, and what is
              left as the common pool this report apportions.
            </p>
          </div>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Line</th>
                <th className={th + " text-right"}>CGST</th>
                <th className={th + " text-right"}>SGST</th>
                <th className={th + " text-right"}>IGST</th>
                <th className={th + " text-right"}>Cess</th>
                <th className={th + " text-right"}>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className={td}>Total input tax (T)</td>
                <td className={num} colSpan={4}></td>
                <td className={num}>{formatINR(Number(r.total_input_tax), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border text-ink-faint">
                <td className={td}>&minus; Blocked, Sec 17(5) (T3)</td>
                <td className={num} colSpan={4}></td>
                <td className={num}>({formatINR(Number(r.blocked_itc), { showZero: true })})</td>
              </tr>
              <tr className="border-b border-border text-ink-faint">
                <td className={td}>&minus; Directly exempt-linked (T2)</td>
                <td className={num} colSpan={4}></td>
                <td className={num}>({formatINR(Number(r.exempt_linked_itc), { showZero: true })})</td>
              </tr>
              <tr className="border-b border-border bg-bg font-semibold">
                <td className={td}>= Common credit (C2)</td>
                <td className={num}>{formatINR(Number(r.common_credit_cgst), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.common_credit_sgst), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.common_credit_igst), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.common_credit_cess), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(r.common_credit), { showZero: true })}</td>
              </tr>
            </tbody>
          </table>

          <div className="border-b border-border p-4">
            <h2 className="font-semibold">Exempt-turnover ratio and reversal (D1, D2)</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              D1 reverses the common pool in proportion to exempt turnover; D2 is Rule 42(1)(j)&rsquo;s
              flat 5% deemed non-business use, applicable to every registered person &mdash; not a
              banking/NBFC-specific figure (that is the separate Rule 38 election, not built here).
            </p>
          </div>
          <table className="w-full min-w-[560px] text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className={td}>Exempt turnover (E) &mdash; nil-rated / exempt / non-GST sales</td>
                <td className={num}>{formatINR(Number(r.exempt_turnover), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Total turnover (F)</td>
                <td className={num}>{formatINR(Number(r.total_turnover), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Ratio E/F</td>
                <td className={num}>{(Number(r.exempt_turnover_ratio) * 100).toFixed(4)}%</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>D1 = (E/F) &times; C2</td>
                <td className={num}>{formatINR(Number(r.d1_reversal), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>D2 = 5% &times; C2</td>
                <td className={num}>{formatINR(Number(r.d2_reversal), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border bg-bg font-semibold">
                <td className={td}>Total reversal (D1 + D2)</td>
                <td className={num}>{formatINR(totalReversal, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " text-ink-faint"}>&nbsp;&nbsp;&mdash; CGST</td>
                <td className={num + " text-ink-faint"}>{formatINR(Number(r.reversal_cgst), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " text-ink-faint"}>&nbsp;&nbsp;&mdash; SGST</td>
                <td className={num + " text-ink-faint"}>{formatINR(Number(r.reversal_sgst), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " text-ink-faint"}>&nbsp;&nbsp;&mdash; IGST</td>
                <td className={num + " text-ink-faint"}>{formatINR(Number(r.reversal_igst), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " text-ink-faint"}>&nbsp;&nbsp;&mdash; Cess</td>
                <td className={num + " text-ink-faint"}>{formatINR(Number(r.reversal_cess), { showZero: true })}</td>
              </tr>
              <tr>
                <td className={td + " font-medium"}>Common credit retained (C3 = C2 &minus; reversal)</td>
                <td className={num + " font-medium"}>{formatINR(Number(r.net_common_credit_retained), { showZero: true })}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      <div className="space-y-2 border-t border-border px-4 py-3 text-xs text-ink-faint">
        <p>
          <strong>Two-stage mechanic.</strong> Rule 42 runs monthly, provisionally, against that
          month&rsquo;s own turnover, then is recomputed once for the whole financial year (Rule
          42(2)) using the year&rsquo;s actual E and F &mdash; not the sum of twelve monthly figures.
          Any shortfall against what was reversed monthly must be added to output tax liability,
          with interest under Sec 50(1), by the due date of the <strong>September</strong> return
          following the financial year &mdash; a different, earlier deadline than Sec 16(4)&rsquo;s
          30 November cut-off for availing fresh credit. Use &ldquo;Monthly&rdquo; above to see one
          month&rsquo;s provisional figure, &ldquo;Full year&rdquo; to run the annual true-up; this
          app does not track what was already reversed month by month, so comparing the two is a
          manual step.
        </p>
        <p>
          <strong>What &ldquo;directly attributable&rdquo; means here.</strong> This schema has no
          field recording which output stream a specific purchase served. T2 (excluded from the
          common pool as exempt-linked) is approximated from the <em>purchased item&rsquo;s own</em>{" "}
          supply_nature — the trading/resale case, buying a nil-rated or exempt good to resell as
          such. Because a non-taxable item can never carry a GST rate (items_non_taxable_has_no_rate),
          this bucket reads &#8377;0 whenever nothing was ever taxed going in, which is correct, not
          a bug. It cannot see the classic Rule 42 scenario of a <em>taxable</em> input (packing
          material, freight, common raw material) consumed to make a <em>different</em>, exempt
          finished good — that credit lands in the common pool instead of being excluded outright,
          and is only partially reversed via the D1 ratio rather than reversed in full. Treat the
          reversal figure above as a conservative floor, not an invoice-level-precise number.
        </p>
        <p>
          <strong>Company-level, not per-registration.</strong> Rule 42&rsquo;s own &ldquo;F&rdquo;
          is technically total turnover <em>in the State</em>. This report computes across the
          whole company; a business holding more than one GST registration should treat this as a
          starting point and re-run the arithmetic per GSTIN by hand.
        </p>
        <p>
          <strong>Rule 43 (capital goods) is not built.</strong> Only Rule 42 (inputs and input
          services) is computed here. This is a report only — nothing here has been journalled as
          a reversal.
        </p>
      </div>
    </ReportShell>
  );
}
