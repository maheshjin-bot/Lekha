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
 * The calendar April-March tax year containing today's local date.
 * Deliberately ignores the company's own financial_year_start_month — Sec
 * 44AB and Form 3CD always run on the calendar year, exactly like the tax
 * depreciation and income tax computation reports already established for
 * this codebase.
 */
function taxYearBounds(): { from: string; to: string; label: string } {
  const today = todayLocal();
  const [y, m] = today.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return {
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
  };
}

const REPORT_FORM_LABEL: Record<string, string> = {
  "3ca": "Form 3CA — accounts already audited under another law (e.g. Companies Act)",
  "3cb": "Form 3CB — no other statutory audit; the tax auditor audits the accounts directly",
  "3ca_or_3cb":
    "Form 3CA or 3CB — depends on whether this LLP was also audited under the LLP Act 2008 (a separate turnover/contribution threshold LEKHA does not track). Confirm which applies.",
};

export default async function TaxAuditPage({
  params,
}: PageProps<"/[companyId]/reports/tax-audit">) {
  const { companyId } = await params;
  const supabase = await createClient();
  const { from, to, label } = taxYearBounds();

  const [{ data: appRows }, { data: clauseRows }] = await Promise.all([
    supabase.rpc("get_tax_audit_applicability", {
      p_company_id: companyId,
      p_fy_start: from,
      p_fy_end: to,
    }),
    supabase.rpc("get_form_3cd_particulars", {
      p_company_id: companyId,
      p_fy_start: from,
      p_fy_end: to,
    }),
  ]);

  const result = appRows?.[0] ?? null;
  const clauses = clauseRows ?? [];
  const period = `FY ${label} · ${from} to ${to} · calendar April–March tax year, not this company's book year`;

  if (!result) {
    return (
      <ReportShell title="Tax audit" period={period}>
        <p className="px-4 py-12 text-center text-ink-faint">Company not found.</p>
      </ReportShell>
    );
  }

  const turnover = Number(result.turnover);
  const cashReceiptPct = Number(result.cash_receipt_percent);
  const cashPaymentPct = Number(result.cash_payment_percent);
  const threshold = Number(result.threshold_used);
  const auditRequired = Boolean(result.audit_required);

  return (
    <ReportShell
      title="Tax audit"
      period={period}
      status={{
        label: auditRequired ? "Tax audit required (Sec 44AB)" : "No tax audit required",
        tone: auditRequired ? "warn" : "ok",
      }}
    >
      <div className="border-b border-border p-4">
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b border-border last:border-0">
              <td className={td}>Turnover this year</td>
              <td className={num}>{formatINR(turnover, { showZero: true })}</td>
            </tr>
            <tr className="border-b border-border last:border-0">
              <td className={td}>Cash receipts</td>
              <td className={num}>
                {cashReceiptPct}% of total receipts
              </td>
            </tr>
            <tr className="border-b border-border last:border-0">
              <td className={td}>Cash payments</td>
              <td className={num}>
                {cashPaymentPct}% of total payments
              </td>
            </tr>
            <tr className="border-b border-border last:border-0">
              <td className={td}>Threshold applied</td>
              <td className={num}>{formatINR(threshold, { showZero: true })}</td>
            </tr>
            <tr className="border-b border-border last:border-0">
              <td className={td}>Report form</td>
              <td className={td + " text-right"}>
                {REPORT_FORM_LABEL[result.report_form as string] ?? result.report_form}
              </td>
            </tr>
            <tr>
              <td className={td}>Report due date</td>
              <td className={num}>{result.due_date}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-xs text-ink-faint">{result.reason}</p>
      </div>

      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Clause</th>
            <th className={th}>Particular</th>
            <th className={th + " text-right"}>Value</th>
          </tr>
        </thead>
        <tbody>
          {clauses.map((c, i) => (
            <tr key={`${c.clause}-${i}`} className="border-b border-border last:border-0 align-top">
              <td className={td + " whitespace-nowrap font-mono text-xs"}>{c.clause}</td>
              <td className={td}>
                {c.title}
                <div className="mt-0.5 text-xs text-ink-faint">{c.source_note}</div>
              </td>
              <td className={num + " font-medium"}>
                {c.value_type === "amount"
                  ? formatINR(Number(c.value_numeric ?? 0), { showZero: true })
                  : c.value_text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Six of Form 3CD&rsquo;s roughly 44 clauses are auto-filled above (13(a),
        14(a), 18, 21(c), 26, 34(a)) — the ones LEKHA already computes
        elsewhere in this app. Every other clause — the related-party
        register, loans/deposits under Sec 269SS/269T, Sec 40A(3) cash-payment
        disallowance, general (non-MSME) Sec 43B items, quantitative stock
        reconciliation, and the clause 44 GST-turnover reconciliation among
        them — needs data this schema does not hold at the right grain and
        must be prepared manually. The Sec 44AB(e) presumptive-scheme
        opt-out trigger (44AD/44ADA) is also not evaluated; see the
        applicability note above. Governed by the Income-tax Act 1961 as
        amended (AY 2026-27), not the Income-tax Act 2025, which only
        governs income earned from 1 April 2026 onward. Treat this as a
        working draft for your tax auditor, not a filed report.
      </p>
    </ReportShell>
  );
}
