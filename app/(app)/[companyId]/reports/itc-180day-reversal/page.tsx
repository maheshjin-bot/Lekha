import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

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

type Row = {
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  party_name: string;
  invoice_value: number;
  outstanding_amount: number;
  itc_cgst: number;
  itc_sgst: number;
  itc_igst: number;
  itc_cess: number;
  itc_total: number;
  days_overdue: number;
  reversal_itc: number;
  interest_amount: number;
  total_reversal_due: number;
};

export default async function Itc180DayReversalPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/itc-180day-reversal">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const asAt =
    typeof sp.as_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_at) ? sp.as_at : todayLocal();

  const { data: rows, error } = await supabase.rpc("get_itc_180day_reversal", {
    p_company_id: companyId,
    p_as_at: asAt,
  });

  const invoices = (rows ?? []) as Row[];
  const sum = (k: keyof Row) => invoices.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  const totalDue = sum("total_reversal_due");

  return (
    <ReportShell
      title="ITC 180-day reversal"
      period={`As at ${formatDate(asAt)} · Rule 37 / second proviso to Sec 16(2) — not a filing`}
      status={
        error
          ? { label: "Could not compute", tone: "bad" }
          : invoices.length === 0
            ? { label: "Nothing to reverse", tone: "ok" }
            : { label: `${formatINR(totalDue, { showZero: true })} reversal + interest due`, tone: "warn" }
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 print:hidden">
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
          <button type="submit" className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            Show
          </button>
        </form>
      </div>

      <table className="w-full min-w-[980px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Invoice</th>
            <th className={th}>Supplier</th>
            <th className={th + " text-right"}>Invoice value</th>
            <th className={th + " text-right"}>Outstanding</th>
            <th className={th + " text-right"}>Days overdue</th>
            <th className={th + " text-right"}>ITC availed</th>
            <th className={th + " text-right"}>Reversal (ITC)</th>
            <th className={th + " text-right"}>Interest @18%</th>
            <th className={th + " text-right"}>Total due</th>
          </tr>
        </thead>
        <tbody>
          {!error && invoices.length === 0 && (
            <tr>
              <td colSpan={9} className="px-4 py-12 text-center text-ink-faint">
                No purchase invoice is both unpaid and more than 180 days old as at this date.
              </td>
            </tr>
          )}
          {error && (
            <tr>
              <td colSpan={9} className="px-4 py-12 text-center text-danger">
                Could not compute this report: {error.message}
              </td>
            </tr>
          )}
          {invoices.map((r) => (
            <tr key={r.voucher_id} className="border-b border-border last:border-0">
              <td className={td}>
                {r.voucher_number}
                <div className="text-xs text-ink-faint">{r.voucher_date}</div>
              </td>
              <td className={td}>{r.party_name}</td>
              <td className={num}>{formatINR(Number(r.invoice_value))}</td>
              <td className={num + " font-medium"}>{formatINR(Number(r.outstanding_amount))}</td>
              <td className={num + " font-semibold text-warning"}>{r.days_overdue}</td>
              <td className={num}>
                {formatINR(Number(r.itc_total))}
                <div className="text-xs font-normal text-ink-faint">
                  {Number(r.itc_igst) > 0
                    ? `IGST ${formatINR(Number(r.itc_igst), { showZero: true })}`
                    : `C ${formatINR(Number(r.itc_cgst), { showZero: true })} + S ${formatINR(Number(r.itc_sgst), { showZero: true })}`}
                  {Number(r.itc_cess) > 0 ? ` + Cess ${formatINR(Number(r.itc_cess), { showZero: true })}` : ""}
                </div>
              </td>
              <td className={num + " font-medium"}>{formatINR(Number(r.reversal_itc))}</td>
              <td className={num}>{formatINR(Number(r.interest_amount))}</td>
              <td className={num + " font-semibold text-warning"}>{formatINR(Number(r.total_reversal_due))}</td>
            </tr>
          ))}
        </tbody>
        {invoices.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5" colSpan={5}>
                Total
              </td>
              <td className={num}>{formatINR(sum("itc_total"), { showZero: true })}</td>
              <td className={num}>{formatINR(sum("reversal_itc"), { showZero: true })}</td>
              <td className={num}>{formatINR(sum("interest_amount"), { showZero: true })}</td>
              <td className={num}>{formatINR(totalDue, { showZero: true })}</td>
            </tr>
          </tfoot>
        )}
      </table>

      <div className="space-y-2 border-t border-border px-4 py-3 text-xs text-ink-faint">
        <p>
          Reversal is <strong>proportionate</strong> to the amount still unpaid on each invoice, not the whole
          invoice&rsquo;s ITC (Notification 26/2022-CT). &ldquo;Outstanding&rdquo; is inferred the same way{" "}
          <a href={`/${companyId}/reports/outstanding?role=creditor`} className="underline underline-offset-4">
            Payables
          </a>{" "}
          infers it — payments applied to the oldest charge on the supplier&rsquo;s ledger first, not matched
          bill-wise to the invoice they actually settle.
        </p>
        <p>
          Interest is charged at 18% p.a. under Sec 50(1), computed from each invoice&rsquo;s own date (the date
          this app records ITC as availed) to the date above. The rule that fixed this explicitly (the old Rule
          37(3)) was omitted on 1 Oct 2022; some practitioners read the amended rule as starting interest only
          from day 181 instead. This report follows the more conservative, more commonly recommended position —
          interest from the date of availment — so treat the interest figure as a considered estimate, not a
          settled number, until this ambiguity is resolved by the department or the courts.
        </p>
        <p>
          Cannot exclude purchases made under reverse charge, which Rule 37 itself carves out — this app does not
          record which purchase invoices are on RCM, so any such invoice here overstates the true reversal
          exposure. This is a report, not a posting: nothing here has been journalled as a reversal.
        </p>
      </div>
    </ReportShell>
  );
}
