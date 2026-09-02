import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, th, td, num } from "@/components/reports/ReportShell";
import { EquityCarriedNote, OpeningBalanceGap } from "@/components/reports/OpeningBalanceGap";
import type { OpeningGapRow } from "@/lib/reports/openingBalanceGap";

export default async function TrialBalancePage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/trial-balance">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month")
    .eq("id", companyId)
    .maybeSingle();

  const period = defaultPeriod(company?.financial_year_start_month ?? 4, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  const { data: rows, error } = await supabase.rpc("get_trial_balance", {
    p_company_id: companyId,
    p_from: period.from,
    p_to: period.to,
  });

  const totals = (rows ?? []).reduce(
    (acc, r) => ({
      dr: acc.dr + Number(r.period_debit ?? 0),
      cr: acc.cr + Number(r.period_credit ?? 0),
      cdr: acc.cdr + Number(r.closing_debit ?? 0),
      ccr: acc.ccr + Number(r.closing_credit ?? 0),
    }),
    { dr: 0, cr: 0, cdr: 0, ccr: 0 }
  );

  const tallied = Math.abs(totals.cdr - totals.ccr) < 0.005;

  // Why the difference, and what to do about it (0755 / 1350). Until now this
  // page printed a bare "Out by ₹X" and stopped there, even though
  // get_unbalanced_opening_balances has been able to name the contributing
  // ledgers since August — it had no caller anywhere in the app.
  //
  // The trial balance is the cleanest place to make the claim: closing debits
  // minus closing credits equals the sum of every ledger's opening balance
  // whenever the period columns themselves net out, so an exact match against
  // company_total_imbalance proves the difference is opening balances and
  // nothing else. The Opening Balance Equity lookup runs either way — a
  // balanced company with a figure sitting on that ledger has its own thing to
  // say (EquityCarriedNote), and it is one indexed row.
  const [{ data: gapRows }, { data: equity }, { data: membership }, { count: voucherCount }] =
    await Promise.all([
      tallied
        ? Promise.resolve({ data: null })
        : supabase.rpc("get_unbalanced_opening_balances", { p_company_id: companyId }),
      supabase
        .from("ledgers")
        .select("id, opening_balance_amount, opening_balance_type")
        .eq("company_id", companyId)
        .ilike("name", "opening balance equity")
        .maybeSingle(),
      tallied
        ? Promise.resolve({ data: null })
        : supabase.from("company_members").select("role").eq("company_id", companyId),
      tallied
        ? Promise.resolve({ count: null })
        : supabase
            .from("vouchers")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .eq("is_deleted", false),
    ]);

  const isAdmin = (membership?.[0]?.role ?? null) === "admin";

  return (
    <ReportShell
      title="Trial Balance"
      period={period.label}
      status={{
        label: tallied
          ? "Tallied"
          : `Out by ${formatINR(Math.abs(totals.cdr - totals.ccr), { showZero: true })}`,
        tone: tallied ? "ok" : "bad",
      }}
    >
      {error && (
        <p className="m-4 rounded-lg bg-error-soft px-3 py-2 text-sm text-error">
          {error.message}
        </p>
      )}
      {!tallied && (
        <OpeningBalanceGap
          companyId={companyId}
          statement="Trial Balance"
          reportGap={totals.cdr - totals.ccr}
          rows={(gapRows ?? []) as OpeningGapRow[]}
          equity={equity ?? null}
          isAdmin={isAdmin}
          voucherCount={voucherCount ?? 0}
        />
      )}
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr>
            <th className={th}>Ledger</th>
            <th className={th}>Group</th>
            <th className={th + " text-right"}>Debit</th>
            <th className={th + " text-right"}>Credit</th>
            <th className={th + " text-right"}>Closing Dr</th>
            <th className={th + " text-right"}>Closing Cr</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-12 text-center text-ink-faint">
                Nothing posted in this period.
              </td>
            </tr>
          )}
          {(rows ?? []).map((r) => (
            <tr key={r.ledger_id}>
              <td className={td + " font-medium"}>{r.ledger_name}</td>
              <td className={td + " text-ink-soft"}>{r.group_name}</td>
              <td className={num}>{formatINR(Number(r.period_debit))}</td>
              <td className={num}>{formatINR(Number(r.period_credit))}</td>
              <td className={num}>{formatINR(Number(r.closing_debit))}</td>
              <td className={num}>{formatINR(Number(r.closing_credit))}</td>
            </tr>
          ))}
        </tbody>
        {(rows ?? []).length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5" colSpan={2}>
                Total
              </td>
              <td className={num}>{formatINR(totals.dr, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.cr, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.cdr, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.ccr, { showZero: true })}</td>
            </tr>
          </tfoot>
        )}
      </table>
      {tallied && <EquityCarriedNote companyId={companyId} equity={equity ?? null} />}
    </ReportShell>
  );
}
