import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { Badge } from "@/components/ui/Badge";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
// Row-level drill-through to /reports/party-bills is not wired here: that
// screen depends on a table-link helper that is not part of this change (see
// the commit that pulled party-bills). This report still stands on its own —
// its own real fix is bill-wise allocation replacing the FIFO guess below,
// not navigation — and gets the drill-through back once party-bills ships.

export default async function OutstandingPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/outstanding">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const role = sp.role === "creditor" ? "creditor" : "debtor";
  // As-at, same control /allocations and /reports/party-bills already give a
  // preparer (1490) — this report used to always mean "as of right now" with
  // nothing on screen saying so. Carried into the per-party drill below so
  // the two screens can never disagree about which day's position is on
  // screen (party-bills defaults to today too, but a stale bookmark of this
  // page should not silently re-date what it drills into).
  // defaultPeriod's `to` with no override is exactly todayLocal() (see
  // lib/nav/context.ts's own comment to this effect) regardless of the
  // startMonth passed in — using it here, rather than a bare
  // `new Date().toISOString()`, is what keeps this page off the two real
  // UTC+05:30 date bugs period.ts's header documents (a period reading
  // yesterday between midnight and 05:30 IST, chief among them).
  const asAt =
    typeof sp.as_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_at)
      ? sp.as_at
      : defaultPeriod(4).to;
  const supabase = await createClient();

  const [{ data: rows }, { data: allocatedRows }] = await Promise.all([
    supabase.rpc("get_party_outstanding", {
      p_company_id: companyId,
      p_as_at: asAt,
      p_role: role,
    }),
    // Which parties have at least one bill someone has actually pointed a
    // receipt/payment at (1490), as opposed to every figure below coming
    // from the oldest-first FIFO guess. voucher_allocations is brand new and
    // not yet in database.types.ts — the same `as any` escape hatch the
    // sibling /allocations and /reports/party-bills pages already use for
    // this exact table.
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .from("voucher_allocations" as any)
      .select("party_ledger_id")
      .eq("company_id", companyId),
  ]);

  const explicitlyAllocated = new Set(
    ((allocatedRows ?? []) as unknown as { party_ledger_id: string }[]).map((r) => r.party_ledger_id)
  );

  const parties = rows ?? [];
  const sum = (k: keyof (typeof parties)[number]) =>
    parties.reduce((n, r) => n + Number(r[k] ?? 0), 0);

  const overdue = sum("days_over_90");
  const total = sum("outstanding");

  return (
    <ReportShell
      title={role === "debtor" ? "Receivables" : "Payables"}
      period={`Aged by invoice date · receipts applied oldest first`}
      status={
        overdue > 0
          ? { label: `${formatINR(overdue)} over 90 days`, tone: "warn" }
          : { label: formatINR(total, { showZero: true }), tone: "ok" }
      }
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-sm print:hidden">
        <a
          href={`?role=debtor&as_at=${asAt}`}
          className={role === "debtor" ? "font-semibold" : "text-ink-soft underline underline-offset-4 "}
        >
          Receivables
        </a>
        <span className="text-ink-faint">|</span>
        <a
          href={`?role=creditor&as_at=${asAt}`}
          className={role === "creditor" ? "font-semibold" : "text-ink-soft underline underline-offset-4 "}
        >
          Payables
        </a>
        <form method="get" className="ml-auto flex items-center gap-2">
          <input type="hidden" name="role" value={role} />
          <label htmlFor="as_at" className="text-xs text-ink-faint">
            As at
          </label>
          <input
            id="as_at"
            name="as_at"
            type="date"
            defaultValue={asAt}
            className="rounded-lg border border-border-strong bg-surface px-2 py-1 text-sm text-ink"
          />
          <button
            type="submit"
            className="rounded-lg border border-border-strong px-3 py-1 text-sm font-medium text-ink hover:bg-surface-2"
          >
            Show
          </button>
        </form>
      </div>

      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Party</th>
            <th className={th + " text-right"}>Not due</th>
            <th className={th + " text-right"}>0–30</th>
            <th className={th + " text-right"}>31–60</th>
            <th className={th + " text-right"}>61–90</th>
            <th className={th + " text-right"}>90+</th>
            <th className={th + " text-right"}>Total</th>
          </tr>
        </thead>
        <tbody>
          {parties.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-ink-faint">
                Nothing outstanding.
              </td>
            </tr>
          )}
          {parties.map((r) => (
            <tr key={r.ledger_id} className="border-b border-border last:border-0">
              <td className={td + " font-medium"}>
                {r.ledger_name}
                {/* Whether THIS party's number above is bill-wise fact or a
                    FIFO guess — the general note below explains the
                    difference once; this is which side of it a reader is
                    looking at. */}
                {explicitlyAllocated.has(r.ledger_id) && (
                  <Badge tone="accent" className="ml-2 normal-case">
                    Bill-wise
                  </Badge>
                )}
                {r.oldest_date && Number(r.days_over_90) > 0 && (
                  <span className="ml-2 text-xs font-normal text-warning">
                    oldest {r.oldest_date}
                  </span>
                )}
              </td>
              <td className={num}>{formatINR(Number(r.not_due))}</td>
              <td className={num}>{formatINR(Number(r.days_0_30))}</td>
              <td className={num}>{formatINR(Number(r.days_31_60))}</td>
              <td className={num}>{formatINR(Number(r.days_61_90))}</td>
              <td className={num + (Number(r.days_over_90) > 0 ? " font-semibold text-warning" : "")}>
                {formatINR(Number(r.days_over_90))}
              </td>
              <td className={num + " font-medium"}>{formatINR(Number(r.outstanding))}</td>
            </tr>
          ))}
        </tbody>
        {parties.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5">Total</td>
              <td className={num}>{formatINR(sum("not_due"), { showZero: true })}</td>
              <td className={num}>{formatINR(sum("days_0_30"), { showZero: true })}</td>
              <td className={num}>{formatINR(sum("days_31_60"), { showZero: true })}</td>
              <td className={num}>{formatINR(sum("days_61_90"), { showZero: true })}</td>
              <td className={num}>{formatINR(overdue, { showZero: true })}</td>
              <td className={num}>{formatINR(total, { showZero: true })}</td>
            </tr>
          </tfoot>
        )}
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Ageing is bill-wise fact wherever a receipt, payment or credit note has been explicitly
        pointed at the invoice it settles (marked <Badge tone="accent" className="normal-case">Bill-wise</Badge>{" "}
        above) — otherwise it is still the oldest-first FIFO fallback this report has always used,
        which assumes money was applied to the oldest invoice first without anyone actually saying
        so. Open a party to see the bill-by-bill split for it before this number goes to a lender.
      </p>
    </ReportShell>
  );
}
