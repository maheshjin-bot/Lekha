import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { LedgerPicker } from "@/components/reports/LedgerPicker";

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

  const period = defaultPeriod(company?.financial_year_start_month ?? 4, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  const ledgerId =
    typeof sp.ledger === "string" ? sp.ledger : (ledgers?.[0]?.id ?? null);
  const ledgerName = ledgers?.find((l) => l.id === ledgerId)?.name;

  const { data: rows } = ledgerId
    ? await supabase.rpc("get_ledger_statement", {
        p_company_id: companyId,
        p_ledger_id: ledgerId,
        p_from: period.from,
        p_to: period.to,
      })
    : { data: [] };

  const lines = rows ?? [];
  const closing = lines.length ? Number(lines[lines.length - 1].running_balance) : 0;

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
        period={period.label}
        status={
          lines.length
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
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-ink-faint">
                  {ledgerId
                    ? "No entries for this ledger in the period."
                    : "Create a ledger first."}
                </td>
              </tr>
            )}
            {lines.map((r, i) => (
              <tr
                key={`${r.voucher_id}-${i}`}
                className="border-b border-border last:border-0"
              >
                <td className={td + " whitespace-nowrap tabular-nums"}>{r.voucher_date}</td>
                <td className={td + " whitespace-nowrap font-mono text-xs"}>
                  {r.voucher_number}
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
              </tr>
            ))}
          </tbody>
        </table>
      </ReportShell>
    </>
  );
}
