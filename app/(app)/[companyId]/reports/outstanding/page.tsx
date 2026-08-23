import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

export default async function OutstandingPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/outstanding">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const role = sp.role === "creditor" ? "creditor" : "debtor";
  const supabase = await createClient();

  const { data: rows } = await supabase.rpc("get_party_outstanding", {
    p_company_id: companyId,
    p_role: role,
  });

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
      <div className="border-b border-border px-4 py-2.5 text-sm print:hidden">
        <a
          href={`?role=debtor`}
          className={role === "debtor" ? "font-semibold" : "text-ink-soft underline underline-offset-4 "}
        >
          Receivables
        </a>
        <span className="mx-3 text-ink-faint">|</span>
        <a
          href={`?role=creditor`}
          className={role === "creditor" ? "font-semibold" : "text-ink-soft underline underline-offset-4 "}
        >
          Payables
        </a>
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
            <tr
              key={r.ledger_id}
              className="border-b border-border last:border-0"
            >
              <td className={td + " font-medium"}>
                {r.ledger_name}
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
        Ageing is inferred: receipts are applied to the oldest invoices first,
        not matched to the invoices they actually settle. Bill-wise allocation
        comes later — worth knowing before this number goes to a lender.
      </p>
    </ReportShell>
  );
}
