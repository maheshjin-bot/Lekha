import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod, periodRangeLabel } from "@/lib/utils/period";
import { readContext } from "@/lib/nav/context";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { LedgerPicker } from "@/components/reports/LedgerPicker";
import { DrillHeadCell, DrillRow } from "@/components/reports/DrillLink";

export default async function LedgerStatementPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/ledger-statement">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: company }, { data: ledgers }] = await Promise.all([
    supabase
      .from("companies")
      .select("financial_year_start_month")
      .eq("id", companyId)
      .maybeSingle(),
    supabase
      .from("ledgers")
      .select("id, name")
      .eq("company_id", companyId)
      .order("name"),
  ]);

  // Same swap as the Trial Balance: readContext resolves the identical
  // dates the inline defaultPeriod() call used to, and additionally reads
  // the branch — which matters here specifically because this page is the
  // Trial Balance's drill target, so the two must agree on the period and
  // the branch or the statement will not add up to the figure clicked.
  const ctx = readContext(companyId, sp, company?.financial_year_start_month);

  // fyStart is the first day of the financial year, so its month is the
  // company's FY start month, already normalised by readContext.
  const startMonth = Number(ctx.fyStart.slice(5, 7));
  const bare = defaultPeriod(startMonth);
  const periodLabel =
    ctx.from === bare.from && ctx.to === bare.to
      ? bare.label
      : periodRangeLabel(ctx.from, ctx.to);

  const { data: branch } = ctx.branchId
    ? await supabase
        .from("branches")
        .select("name")
        .eq("id", ctx.branchId)
        .eq("company_id", companyId)
        .maybeSingle()
    : { data: null };
  const branchLabel = ctx.branchId ? ` · ${branch?.name ?? "Unknown branch"}` : "";

  const ledgerId =
    typeof sp.ledger === "string" ? sp.ledger : (ledgers?.[0]?.id ?? null);
  const ledgerName = ledgers?.find((l) => l.id === ledgerId)?.name;

  const [{ data: rows }, { data: openingBalance, error: openingError }] = await Promise.all([
    ledgerId
      ? supabase.rpc("get_ledger_statement", {
          p_company_id: companyId,
          p_ledger_id: ledgerId,
          p_from: ctx.from,
          p_to: ctx.to,
          // `?? undefined` because the generated arg type is
          // `p_branch_id?: string`; omitting it takes the function's own
          // `default null`, i.e. all branches.
          p_branch_id: ctx.branchId ?? undefined,
        })
      : Promise.resolve({ data: [] }),
    ledgerId
      ? supabase.rpc("get_ledger_opening_balance", {
          p_company_id: companyId,
          p_ledger_id: ledgerId,
          p_before: ctx.from,
          // Must carry the same branch as the statement above. Both RPCs go
          // through app_private.ledger_opening_signed, which takes a branch;
          // a branch-filtered list of lines under a company-wide opening
          // balance would produce a closing figure that belongs to neither.
          p_branch_id: ctx.branchId ?? undefined,
        })
      : Promise.resolve({ data: null, error: null }),
  ]);

  const lines = rows ?? [];
  // When the period has real transactions, the last row's own running
  // balance already has the opening baked in and is authoritative. When it
  // has none, fall back to the opening balance itself (a ledger's true
  // balance doesn't reset to zero just because nothing moved this period —
  // see 1270's header) rather than assuming zero.
  const closing = lines.length
    ? Number(lines[lines.length - 1].running_balance)
    : !openingError && openingBalance !== null
      ? Number(openingBalance)
      : 0;
  const hasBalance = lines.length > 0 || (!openingError && openingBalance !== null);

  return (
    <>
      <div className="mx-auto max-w-5xl px-6 pt-10 print:hidden">
        <LedgerPicker
          companyId={companyId}
          ledgers={ledgers ?? []}
          selected={ledgerId}
        />
      </div>
      <ReportShell
        title={ledgerName ? `Ledger — ${ledgerName}` : "Ledger Statement"}
        period={periodLabel + branchLabel}
        status={
          hasBalance
            ? {
                label: `Closing ${formatINR(Math.abs(closing), { showZero: true })} ${closing >= 0 ? "Dr" : "Cr"}`,
                tone: "ok",
              }
            : undefined
        }
      >
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Date</th>
              <th className={th}>Number</th>
              <th className={th}>Particulars</th>
              <th className={th + " text-right"}>Debit</th>
              <th className={th + " text-right"}>Credit</th>
              <th className={th + " text-right"}>Balance</th>
              <DrillHeadCell />
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-ink-faint">
                  {!ledgerId
                    ? "Create a ledger first."
                    : hasBalance && closing !== 0
                      ? `No entries for this ledger in the period — balance brought forward is ${formatINR(Math.abs(closing), { showZero: true })} ${closing >= 0 ? "Dr" : "Cr"}.`
                      : "No entries for this ledger in the period."}
                </td>
              </tr>
            )}
            {lines.map((r, i) => {
              // The last link in the chain: Trial Balance → this statement →
              // the voucher itself, which is where "why is this figure what
              // it is" is finally answerable.
              const voucherHref = `/${companyId}/vouchers/${r.voucher_id}`;

              return (
                <DrillRow
                  key={`${r.voucher_id}-${i}`}
                  href={voucherHref}
                  // Deliberately NO carry/params here, unlike the Trial
                  // Balance's rows. A voucher is not a period: the voucher
                  // page reads no from/to/branch, so forwarding them would
                  // put query keys on a URL that ignores them — and that URL
                  // gets copied and shared. Going back to the statement's own
                  // period needs nothing from us either; the browser's history
                  // entry already holds the full statement URL.
                  label={r.voucher_number}
                  className="border-b border-border last:border-0"
                >
                  <td className={td + " whitespace-nowrap tabular-nums"}>{r.voucher_date}</td>
                  <td className={td + " whitespace-nowrap font-mono text-xs"}>
                    {/* Wider click target than the chevron, per DrillLink's
                        obligation (D) — the voucher number is the row's
                        identity, so it is what a reader aims at. Same URL by
                        construction; hover-only underline so a long statement
                        does not become a wall of links. */}
                    <Link
                      href={voucherHref}
                      className="rounded-sm underline-offset-4 outline-none hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/30"
                    >
                      {r.voucher_number}
                    </Link>
                  </td>
                  <td className={td + " text-ink-soft "}>
                    {r.contra_ledgers ?? r.narration ?? "—"}
                  </td>
                  <td className={num}>{formatINR(Number(r.debit_amount))}</td>
                  <td className={num}>{formatINR(Number(r.credit_amount))}</td>
                  <td className={num + " font-medium"}>
                    {formatINR(Math.abs(Number(r.running_balance)), { showZero: true })}
                    <span className="ml-1 text-[10px] uppercase text-ink-faint">
                      {Number(r.running_balance) >= 0 ? "Dr" : "Cr"}
                    </span>
                  </td>
                </DrillRow>
              );
            })}
          </tbody>
        </table>
      </ReportShell>
    </>
  );
}
