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

  const [{ data: appRows }, { data: clauseRows }, { data: modules }] = await Promise.all([
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
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
  ]);

  const inventoryOn = (modules ?? []).some((m) => m.code === "inventory" && m.active);
  const { data: stockRows } = inventoryOn
    ? await supabase.rpc("get_quantitative_stock_details", {
        p_company_id: companyId,
        p_fy_start: from,
        p_fy_end: to,
      })
    : { data: null };
  const stockDetails = stockRows ?? [];

  const { data: cashPaymentRows } = await supabase.rpc("get_sec40a3_cash_payments", {
    p_company_id: companyId,
    p_fy_start: from,
    p_fy_end: to,
  });
  const cashPayments = cashPaymentRows ?? [];

  const { data: relatedPartyRows } = await supabase.rpc("get_related_party_payments", {
    p_company_id: companyId,
    p_fy_start: from,
    p_fy_end: to,
  });
  const relatedPartyPayments = relatedPartyRows ?? [];

  const [{ data: loanReceiptRows }, { data: loanRepaymentRows }] = await Promise.all([
    supabase.rpc("get_sec269ss_loan_receipts", {
      p_company_id: companyId,
      p_fy_start: from,
      p_fy_end: to,
    }),
    supabase.rpc("get_sec269t_loan_repayments", {
      p_company_id: companyId,
      p_fy_start: from,
      p_fy_end: to,
    }),
  ]);
  const loanReceipts = loanReceiptRows ?? [];
  const loanRepayments = loanRepaymentRows ?? [];

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

      {inventoryOn && (
        <>
          <div className="border-b border-t border-border p-4">
            <h2 className="font-semibold">Clause 35 — quantitative details (trading concern)</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Opening, purchases, sales and closing quantity per item —
              purchase and sales returns netted against their own side, not
              lumped into a raw increase/decrease. Principal items (over 10%
              of total purchase or sales value for the year) are marked;
              every item with any movement is still listed underneath.
              Shortage/excess is not shown — LEKHA has no physical
              stock-take feature to compare the book figure against.
            </p>
          </div>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Item</th>
                <th className={th}>UOM</th>
                <th className={th + " text-right"}>Opening</th>
                <th className={th + " text-right"}>Purchases</th>
                <th className={th + " text-right"}>Sales</th>
                <th className={th + " text-right"}>Closing</th>
              </tr>
            </thead>
            <tbody>
              {stockDetails.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-faint">
                    No stock movement this year.
                  </td>
                </tr>
              )}
              {stockDetails.map((s) => (
                <tr key={s.item_id} className="border-b border-border last:border-0">
                  <td className={td}>
                    {s.item_name}
                    {s.is_principal_item && (
                      <span className="ml-1.5 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                        Principal
                      </span>
                    )}
                  </td>
                  <td className={td + " text-ink-soft"}>{s.uom}</td>
                  <td className={num}>{Number(s.opening_quantity).toLocaleString("en-IN")}</td>
                  <td className={num}>{Number(s.purchases_quantity).toLocaleString("en-IN")}</td>
                  <td className={num}>{Number(s.sales_quantity).toLocaleString("en-IN")}</td>
                  <td className={num + " font-medium"}>
                    {Number(s.closing_quantity).toLocaleString("en-IN")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="border-b border-t border-border p-4">
        <h2 className="font-semibold">Clause 21(d) — Sec 40A(3) cash-payment candidates</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Cash paid to one payee in one day, aggregated across every voucher
          that day, wherever it exceeds ₹10,000. These are candidates for
          your review, not a computed disallowance — LEKHA cannot evaluate
          Rule 6DD (payment to government, no banking facility, agricultural
          produce and several more) or apply the ₹35,000 transporter-specific
          limit, since nothing here identifies which payees are transporters.
          A row below may turn out to be fully exempt on review.
        </p>
      </div>
      <table className="w-full min-w-[600px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Payee</th>
            <th className={th}>Date</th>
            <th className={th + " text-right"}>Payments</th>
            <th className={th + " text-right"}>Cash paid</th>
          </tr>
        </thead>
        <tbody>
          {cashPayments.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-ink-faint">
                No cash payment crossed ₹10,000 to one payee on one day this year.
              </td>
            </tr>
          )}
          {cashPayments.map((c, i) => (
            <tr key={`${c.payee_ledger_id}-${c.payment_date}-${i}`} className="border-b border-border last:border-0">
              <td className={td}>{c.payee_name}</td>
              <td className={td}>{c.payment_date}</td>
              <td className={num}>{c.payment_count}</td>
              <td className={num + " font-medium text-warning"}>
                {formatINR(Number(c.cash_amount), { showZero: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-b border-t border-border p-4">
        <h2 className="font-semibold">Clause 23 — payments to Sec 40A(2)(b) specified persons</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Actual payments made this year to ledgers flagged as a specified
          person (director, partner, their relative, or an entity in which
          the assessee/director/partner has a substantial interest) —
          amounts merely debited or outstanding, not yet paid, are excluded,
          per the clause&rsquo;s own scope. Whether a payment is excessive
          or unreasonable is not evaluated here — that is the assessing
          officer&rsquo;s call. Flag a ledger as a specified person from the
          ledger&rsquo;s own form on the Ledgers page.
        </p>
      </div>
      <table className="w-full min-w-[600px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Payee</th>
            <th className={th}>PAN</th>
            <th className={th + " text-right"}>Amount paid</th>
          </tr>
        </thead>
        <tbody>
          {relatedPartyPayments.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-8 text-center text-ink-faint">
                No payment to a flagged specified person this year.
              </td>
            </tr>
          )}
          {relatedPartyPayments.map((r) => (
            <tr key={r.ledger_id} className="border-b border-border last:border-0">
              <td className={td}>{r.ledger_name}</td>
              <td className={td + " text-ink-soft"}>{r.pan ?? "—"}</td>
              <td className={num + " font-medium"}>
                {formatINR(Number(r.amount_paid), { showZero: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-b border-t border-border p-4">
        <h2 className="font-semibold">Clause 31 — Sec 269SS/269T cash loan/deposit candidates</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Cash accepted or repaid on a ledger flagged as a loan/deposit,
          wherever the outstanding balance from that lender reaches
          ₹20,000 — both sections test the aggregate held from one person,
          not just the single transaction. Candidates for your review, not
          a computed penalty: LEKHA cannot identify a &ldquo;specified
          sum&rdquo; property-transfer advance, and treats every bank-mode
          movement as compliant since it cannot tell an account-payee
          instrument from a bearer one. Flag a ledger as a loan/deposit
          from the ledger&rsquo;s own form on the Ledgers page.
        </p>
      </div>
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Lender</th>
            <th className={th}>Date</th>
            <th className={th}>Direction</th>
            <th className={th + " text-right"}>Amount</th>
            <th className={th + " text-right"}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {loanReceipts.length === 0 && loanRepayments.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-ink-faint">
                No cash acceptance or repayment crossed ₹20,000 outstanding this year.
              </td>
            </tr>
          )}
          {loanReceipts.map((r, i) => (
            <tr key={`ss-${r.ledger_id}-${i}`} className="border-b border-border last:border-0">
              <td className={td}>{r.ledger_name}</td>
              <td className={td}>{r.receipt_date}</td>
              <td className={td + " text-ink-soft"}>Accepted (269SS)</td>
              <td className={num + " font-medium text-warning"}>
                {formatINR(Number(r.amount_received), { showZero: true })}
              </td>
              <td className={num}>{formatINR(Number(r.balance_after), { showZero: true })}</td>
            </tr>
          ))}
          {loanRepayments.map((r, i) => (
            <tr key={`t-${r.ledger_id}-${i}`} className="border-b border-border last:border-0">
              <td className={td}>{r.ledger_name}</td>
              <td className={td}>{r.repayment_date}</td>
              <td className={td + " text-ink-soft"}>Repaid (269T)</td>
              <td className={num + " font-medium text-warning"}>
                {formatINR(Number(r.amount_repaid), { showZero: true })}
              </td>
              <td className={num}>{formatINR(Number(r.balance_before), { showZero: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        {inventoryOn ? "Ten" : "Nine"} of Form 3CD&rsquo;s roughly 44
        clauses are auto-filled above (13(a), 14(a), 18, 21(c), 21(d), 23,
        26, 31, 34(a){inventoryOn ? ", 35" : ""}) — the ones LEKHA already
        computes elsewhere in this app. Every other clause — general
        (non-MSME) Sec 43B items, and clause 44&rsquo;s break-up of
        expenditure by supplier GST-registration status among them —
        needs data this schema does not hold at the right grain and must
        be prepared manually. Clause 44 specifically needs every expense
        posting classified by its supplier&rsquo;s GST-registration status,
        but most expense postings in this app never carry a supplier GSTIN
        at all — only formal GST purchase invoices do — so LEKHA cannot
        classify the bulk of a company&rsquo;s expenditure with any
        confidence. The Sec 44AB(e) presumptive-scheme opt-out trigger
        (44AD/44ADA) is also not evaluated; see the applicability note
        above. Governed by the Income-tax Act 1961 as amended (AY 2026-27),
        not the Income-tax Act 2025, which only governs income earned from
        1 April 2026 onward. Treat this as a working draft for your tax
        auditor, not a filed report.
      </p>
    </ReportShell>
  );
}
