import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { cn } from "@/lib/utils/cn";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { DrillHeadCell, DrillRow } from "@/components/reports/DrillLink";

type Role = "debtor" | "creditor";

/**
 * One row of get_bill_wise_outstanding (1490). Kept as a local type rather
 * than imported from components/allocations/AllocationManager — that file is
 * another task's assignment in this same wave, and this report has no reason
 * to couple its shape to that screen's. The fields below are the RPC's exact
 * output columns, confirmed live via pg_get_function_result rather than
 * inferred, per this task's standing instruction not to guess a signature.
 */
type BillRow = {
  ledger_id: string;
  ledger_name: string;
  /** null on the opening-balance row — it is not a voucher and is never
   * individually allocatable, only ever caught by the FIFO fallback. */
  voucher_id: string | null;
  voucher_number: string | null;
  voucher_type: string | null;
  voucher_date: string;
  due_date: string;
  bill_amount: number;
  /** Explicit fact: what a receipt/payment/credit note was actually pointed
   * at this bill for, via voucher_allocations. */
  allocated: number;
  /** A guess: the oldest-first fallback's share of covering this bill,
   * because nobody has pointed anything at it yet. */
  fifo_applied: number;
  outstanding: number;
  allocatable: number;
  days_overdue: number;
};

/** One voucher_allocations row, joined by hand below rather than via a
 * PostgREST embed — the table carries two FKs to vouchers (settlement and
 * bill), and embedding through an ambiguous FK needs the constraint's
 * generated name, which this migration never assigned one to. Two plain
 * queries plus a JS join is the same trade the sibling /allocations page
 * already made for this exact table. */
type AllocationRow = {
  bill_voucher_id: string;
  settlement_voucher_id: string;
  amount: number;
};

type SettlementVoucher = {
  id: string;
  voucher_number: string;
  voucher_date: string;
};

/** Same boundaries get_party_outstanding's own not_due/0-30/31-60/61-90/90+
 * buckets use (0017), reproduced here per-bill instead of per-party.
 * days_overdue is already clamped at 0 by the RPC (greatest(0, ...)), so a
 * bill that has not yet fallen due and one that falls due today both read 0
 * and both land in "Not due" — the same resolution the party-level ageing
 * report already has, not a new loss of information. */
function ageBucket(daysOverdue: number): string {
  if (daysOverdue <= 0) return "Not due";
  if (daysOverdue <= 30) return "0–30";
  if (daysOverdue <= 60) return "31–60";
  if (daysOverdue <= 90) return "61–90";
  return "90+";
}

export default async function PartyBillsPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/party-bills">) {
  const { companyId } = await params;
  const sp = await searchParams;

  const requestedRole: Role = sp.role === "creditor" ? "creditor" : "debtor";
  const ledgerId = typeof sp.ledger === "string" && sp.ledger ? sp.ledger : null;
  // Same as-at control the /allocations screen already gives a preparer
  // (1490/1491) — a receipt entered days after its own date needs the
  // reader to be able to ask "unpaid AS AT which day", and this report and
  // that screen must agree on what that means or their numbers will not
  // tie out against each other.
  // See the identical comment on /reports/outstanding: defaultPeriod's `to`
  // with no override IS todayLocal() no matter what startMonth is passed
  // (the `to` fallback ignores it entirely), which is the one function this
  // codebase trusts to read "today" without the UTC+05:30 date bugs a bare
  // `new Date().toISOString()` reintroduces — see period.ts's own header.
  const asAt =
    typeof sp.as_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_at)
      ? sp.as_at
      : defaultPeriod(4).to;

  const supabase = await createClient();

  // The ledger named in the URL, with its OWN role — never trust ?role= for
  // which RPC role to call. A stale or hand-edited link (role=creditor on a
  // debtor's id) must still show that debtor's own bills, not silently query
  // the wrong side of get_bill_wise_outstanding and return nothing.
  const { data: selectedLedger } = ledgerId
    ? await supabase
        .from("ledgers")
        .select("id, name, account_groups(ledger_role)")
        .eq("company_id", companyId)
        .eq("id", ledgerId)
        .maybeSingle()
    : { data: null };

  const selectedRole = selectedLedger?.account_groups?.ledger_role;
  const role: Role = selectedRole === "creditor" ? "creditor" : selectedRole === "debtor" ? "debtor" : requestedRole;

  // The picker: every ledger of this role, so a preparer can reach this
  // report directly rather than only by drilling from Outstanding.
  const { data: parties } = await supabase
    .from("ledgers")
    .select("id, name, account_groups!inner(ledger_role)")
    .eq("company_id", companyId)
    .eq("account_groups.ledger_role", role)
    .order("name");

  // get_bill_wise_outstanding (1490) is brand new and database.types.ts —
  // owned by the integration pass' own regeneration, not by this task — does
  // not know it yet. Same `as any` escape hatch the sibling /allocations
  // page already uses for the identical RPC, for the identical reason.
  const { data: allBills } = ledgerId
    ? await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        .rpc("get_bill_wise_outstanding" as any, {
          p_company_id: companyId,
          p_role: role,
          p_as_at: asAt,
        })
    : { data: [] };

  // The RPC has no per-party filter (it returns the whole role's book), so
  // the single ledger this page is about is picked out here. Only OPEN bills
  // (outstanding > 0) — a bill settled to the last rupee is not what "every
  // open bill" asked for, and excluding it does not change the balance this
  // page ties out to, since a fully-settled bill contributes exactly 0 to
  // that sum either way.
  const bills = ((allBills ?? []) as unknown as BillRow[])
    .filter((b) => b.ledger_id === ledgerId && b.outstanding > 0)
    .map((b) => ({
      ...b,
      bill_amount: Number(b.bill_amount),
      allocated: Number(b.allocated),
      fifo_applied: Number(b.fifo_applied),
      outstanding: Number(b.outstanding),
      days_overdue: Number(b.days_overdue),
    }));

  // "Where allocations exist, show what settled it": for every bill here
  // that carries an explicit allocation, find the receipt(s)/payment(s) it
  // came from. Scoped to THIS party ledger as well as these bill ids — a
  // voucher can legitimately touch more than one party ledger (1490's own
  // header), so bill_voucher_id alone is not enough to know which of its
  // allocations belong to the party this page is about.
  const billIds = bills.filter((b) => b.voucher_id && b.allocated > 0).map((b) => b.voucher_id as string);

  const { data: allocRows } = billIds.length
    ? await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- voucher_allocations (1490) is not in database.types.ts yet
        .from("voucher_allocations" as any)
        .select("bill_voucher_id, settlement_voucher_id, amount")
        .eq("company_id", companyId)
        .eq("party_ledger_id", ledgerId)
        .in("bill_voucher_id", billIds)
    : { data: [] };

  const allocations = (allocRows ?? []) as unknown as AllocationRow[];
  const settlementIds = Array.from(new Set(allocations.map((a) => a.settlement_voucher_id)));

  const { data: settlementVouchers } = settlementIds.length
    ? await supabase
        .from("vouchers")
        .select("id, voucher_number, voucher_date")
        .eq("company_id", companyId)
        .in("id", settlementIds)
    : { data: [] };

  const settlementById = new Map(
    ((settlementVouchers ?? []) as SettlementVoucher[]).map((v) => [v.id, v])
  );

  // bill_voucher_id -> the settlements that were explicitly pointed at it.
  const settledByBill = new Map<string, { voucher_number: string; voucher_date: string; amount: number }[]>();
  for (const a of allocations) {
    const settlement = settlementById.get(a.settlement_voucher_id);
    if (!settlement) continue;
    const list = settledByBill.get(a.bill_voucher_id) ?? [];
    list.push({ voucher_number: settlement.voucher_number, voucher_date: settlement.voucher_date, amount: Number(a.amount) });
    settledByBill.set(a.bill_voucher_id, list);
  }

  const total = bills.reduce((n, b) => n + b.outstanding, 0);
  const overdue90 = bills.reduce((n, b) => (b.days_overdue > 90 ? n + b.outstanding : n), 0);
  const ledgerName = selectedLedger?.name;

  return (
    <>
      <div className="mx-auto max-w-5xl px-6 pt-10 print:hidden">
        <div className="mb-4 flex items-center gap-3 text-sm">
          <Link
            href={`?role=debtor&as_at=${asAt}`}
            className={role === "debtor" ? "font-semibold text-ink" : "text-ink-soft underline underline-offset-4"}
          >
            Receivables
          </Link>
          <span className="text-ink-faint">|</span>
          <Link
            href={`?role=creditor&as_at=${asAt}`}
            className={role === "creditor" ? "font-semibold text-ink" : "text-ink-soft underline underline-offset-4"}
          >
            Payables
          </Link>

          <form method="get" className="ml-auto flex flex-wrap items-center gap-2">
            <input type="hidden" name="role" value={role} />
            <label htmlFor="ledger" className="text-xs text-ink-faint">
              Party
            </label>
            <select
              id="ledger"
              name="ledger"
              defaultValue={ledgerId ?? ""}
              className="rounded-lg border border-border-strong bg-surface px-2 py-1 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
            >
              <option value="" disabled>
                Choose a party…
              </option>
              {(parties ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
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
      </div>

      <ReportShell
        title={ledgerName ? `${role === "debtor" ? "Receivable" : "Payable"} bills — ${ledgerName}` : "Party bills"}
        period={`As at ${asAt}`}
        status={
          !ledgerId
            ? undefined
            : overdue90 > 0
              ? { label: `${formatINR(overdue90)} over 90 days`, tone: "warn" }
              : { label: formatINR(total, { showZero: true }), tone: "ok" }
        }
      >
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Bill</th>
              <th className={th}>Due</th>
              <th className={th}>Age</th>
              <th className={th + " text-right"}>Original amount</th>
              <th className={th + " text-right"}>Allocated</th>
              <th className={th + " text-right"}>FIFO-inferred</th>
              <th className={th + " text-right"}>Balance</th>
              <DrillHeadCell />
            </tr>
          </thead>
          <tbody>
            {!ledgerId && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-ink-faint">
                  Choose a party above, or open one from the{" "}
                  <Link href={`/${companyId}/reports/outstanding?role=${role}`} className="underline underline-offset-4">
                    ageing report
                  </Link>
                  .
                </td>
              </tr>
            )}
            {ledgerId && bills.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-ink-faint">
                  Nothing outstanding for this party as at {asAt}.
                </td>
              </tr>
            )}
            {bills.map((b, i) => {
              const settlers = b.voucher_id ? settledByBill.get(b.voucher_id) : undefined;
              const isOpening = b.voucher_id === null;

              const billCell = (
                <td className={td}>
                  {isOpening ? (
                    <span className="text-ink-soft">Opening balance</span>
                  ) : (
                    <>
                      <span className="whitespace-nowrap font-mono text-xs">{b.voucher_number}</span>
                      <span className="ml-2 text-xs text-ink-faint">{b.voucher_date}</span>
                    </>
                  )}
                  {settlers && settlers.length > 0 && (
                    <div className="mt-0.5 text-xs text-ink-faint">
                      Settled by{" "}
                      {settlers
                        .map((s) => `${s.voucher_number} (${formatINR(s.amount, { showZero: true })})`)
                        .join(", ")}
                    </div>
                  )}
                </td>
              );

              const rest = (
                <>
                  <td className={td + " whitespace-nowrap"}>{b.due_date}</td>
                  <td className={td}>
                    <span
                      className={cn(
                        "text-xs",
                        b.days_overdue > 90 ? "font-semibold text-warning" : "text-ink-soft"
                      )}
                    >
                      {ageBucket(b.days_overdue)}
                    </span>
                  </td>
                  <td className={num}>{formatINR(b.bill_amount)}</td>
                  <td className={num}>{formatINR(b.allocated)}</td>
                  <td className={num + " text-ink-soft"}>
                    {b.fifo_applied > 0 ? formatINR(b.fifo_applied) : "—"}
                  </td>
                  <td className={num + " font-medium"}>{formatINR(b.outstanding)}</td>
                </>
              );

              // The opening balance has no voucher to open — 1490's own
              // header explains why (it is not a voucher and cannot carry a
              // sentinel id without putting a nullable column inside a
              // unique key). It is still listed, still counted in the
              // total, just not drillable.
              if (isOpening) {
                return (
                  <tr key={`opening-${i}`} className="border-b border-border last:border-0">
                    {billCell}
                    {rest}
                    <td className={cn(td, "w-px print:hidden")} />
                  </tr>
                );
              }

              return (
                <DrillRow
                  key={b.voucher_id}
                  href={`/${companyId}/vouchers/${b.voucher_id}`}
                  label={b.voucher_number ?? "voucher"}
                  className="border-b border-border last:border-0"
                >
                  {billCell}
                  {rest}
                </DrillRow>
              );
            })}
          </tbody>
          {ledgerId && bills.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border-strong bg-bg font-semibold">
                <td className="px-4 py-2.5" colSpan={6}>
                  Total
                </td>
                <td className={num}>{formatINR(total, { showZero: true })}</td>
                <td className="print:hidden" />
              </tr>
            </tfoot>
          )}
        </table>

        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          <strong className="text-ink-soft">Allocated</strong> is fact: someone pointed a receipt or
          payment at this exact bill. <strong className="text-ink-soft">FIFO-inferred</strong> is a
          guess — money left on account elsewhere, applied to the oldest open bill first because
          nobody has said otherwise. Point a receipt at a bill on the{" "}
          <Link href={`/${companyId}/allocations?role=${role}`} className="underline underline-offset-4">
            allocation screen
          </Link>{" "}
          to turn a guess into a fact.
        </p>
      </ReportShell>
    </>
  );
}
