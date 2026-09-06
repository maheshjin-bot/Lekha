import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { defaultPeriod } from "@/lib/utils/period";
import {
  AllocationManager,
  type AllocationRow,
  type Bill,
  type Settlement,
} from "@/components/allocations/AllocationManager";
import { AllocationWorklist } from "@/components/allocations/AllocationWorklist";

/**
 * Bill-by-bill allocation (1490/1491).
 *
 * Until this screen existed a receipt could not be pointed at the invoice it
 * settled, so every invoice raised in a year reported as unpaid until the
 * whole opening balance had been cleared first. This is where a person says
 * which document the money was actually for; whatever is left stays on
 * account and keeps being applied oldest-first, exactly as before.
 */
export default async function AllocationsPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/allocations">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const role: "debtor" | "creditor" = sp.role === "creditor" ? "creditor" : "debtor";
  // An as-at control, not just today. A receipt is often entered days after
  // the date it bears, and an AR desk reconciling a month-end needs to see the
  // position ON that date — the same reason every report here takes one.
  // defaultPeriod's `to` with no override is todayLocal() regardless of the
  // startMonth passed in — using it here, rather than a bare
  // `new Date().toISOString()`, is what keeps this page off the UTC+05:30
  // date bug period.ts's header documents: a bare toISOString() reads the
  // UTC calendar date, which is still yesterday between IST midnight and
  // 05:30 — see the same fix in reports/outstanding and reports/party-bills.
  const asAt =
    typeof sp.as_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_at)
      ? sp.as_at
      : defaultPeriod(4).to;
  // Worklist is the default: the dashboard's "N unallocated settlements"
  // alert links straight here with no query string at all, and the whole
  // point of following that link is to clear the backlog, not to browse a
  // table of everything including what is already done. `?mode=browse`
  // keeps the original browse-everything screen (AllocationManager) reachable
  // for anyone reconciling rather than clearing.
  const mode: "worklist" | "browse" = sp.mode === "browse" ? "browse" : "worklist";
  const supabase = await createClient();

  // get_unallocated_settlements / get_bill_wise_outstanding / voucher_allocations
  // are brand new (1490) and types/database.types.ts — owned by the
  // integration pass' regeneration, not by this task — does not know them yet.
  // Same `as any` + `as unknown as` escape hatch every other new-table screen
  // in this codebase uses; the runtime shapes are verified live.
  const [{ data: settlements }, { data: bills }, { data: allocations }] = await Promise.all([
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .rpc("get_unallocated_settlements" as any, {
        p_company_id: companyId,
        p_role: role,
        p_as_at: asAt,
        p_include_allocated: true,
      }),
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .rpc("get_bill_wise_outstanding" as any, {
        p_company_id: companyId,
        p_role: role,
        p_as_at: asAt,
      }),
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .from("voucher_allocations" as any)
      .select("settlement_voucher_id, bill_voucher_id, party_ledger_id, amount")
      .eq("company_id", companyId),
  ]);

  const toNum = <T,>(rows: T[], keys: (keyof T)[]) =>
    rows.map((r) => {
      const out = { ...r } as Record<string, unknown>;
      for (const k of keys) out[k as string] = Number(out[k as string] ?? 0);
      return out;
    });

  const settlementRows = toNum(
    (settlements ?? []) as unknown as Settlement[],
    ["settlement_amount", "allocated", "on_account"]
  ) as unknown as Settlement[];

  const billRows = toNum(
    (bills ?? []) as unknown as Bill[],
    ["bill_amount", "allocated", "fifo_applied", "outstanding", "allocatable", "days_overdue"]
  ) as unknown as Bill[];

  const allocationRows = toNum(
    (allocations ?? []) as unknown as AllocationRow[],
    ["amount"]
  ) as unknown as AllocationRow[];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Apply {role === "debtor" ? "receipts" : "payments"} to bills
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A ledger tells you what a party owes in total. An accounts-receivable system tells you{" "}
          <em>which</em> bills are unpaid. Point each receipt at the invoice or invoices it
          settles — in part or in full — and the outstanding report, the Schedule III ageing
          note, the MSME Sec 43B(h) position and the Rule 37 180-day ITC reversal all start
          reasoning about the right documents. Money you do not apply stays on account and is
          still set against the oldest balance first, so nothing you have already entered
          changes until you say so.
        </p>
      </header>

      <div className="mb-5 flex items-center gap-3 text-sm">
        <Link
          href={`?role=debtor`}
          className={
            role === "debtor"
              ? "font-semibold text-ink"
              : "text-ink-soft underline underline-offset-4"
          }
        >
          Customers
        </Link>
        <span className="text-ink-faint">|</span>
        <Link
          href={`?role=creditor`}
          className={
            role === "creditor"
              ? "font-semibold text-ink"
              : "text-ink-soft underline underline-offset-4"
          }
        >
          Suppliers
        </Link>
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

      <p className="mb-5 text-xs text-ink-faint">
        <Link
          href={`/${companyId}/reports/outstanding?role=${role}`}
          className="underline underline-offset-4"
        >
          Ageing report
        </Link>{" "}
        · a receipt dated after the as-at date is not counted, and neither is an allocation made
        from it — an invoice correctly still reads as open on a date the money had not yet arrived.
      </p>

      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
        <Link
          href={`?role=${role}&as_at=${asAt}`}
          className={
            mode === "worklist"
              ? "rounded-full bg-accent-soft px-3 py-1 font-semibold text-accent"
              : "rounded-full px-3 py-1 text-ink-soft hover:bg-surface-2"
          }
        >
          Worklist
        </Link>
        <Link
          href={`?role=${role}&as_at=${asAt}&mode=browse`}
          className={
            mode === "browse"
              ? "rounded-full bg-accent-soft px-3 py-1 font-semibold text-accent"
              : "rounded-full px-3 py-1 text-ink-soft hover:bg-surface-2"
          }
        >
          Browse all
        </Link>
        <span className="text-xs text-ink-faint">
          {mode === "worklist"
            ? "Oldest unallocated first, grouped by party — for clearing a backlog in one sitting."
            : "Every settlement and every bill, applied or not — for reconciling."}
        </span>
      </div>

      {mode === "worklist" ? (
        <AllocationWorklist
          key={`${role}-${asAt}`}
          companyId={companyId}
          role={role}
          asAt={asAt}
          settlements={settlementRows}
          bills={billRows}
          allocations={allocationRows}
        />
      ) : (
        <AllocationManager
          companyId={companyId}
          role={role}
          settlements={settlementRows}
          bills={billRows}
          allocations={allocationRows}
        />
      )}
    </main>
  );
}
