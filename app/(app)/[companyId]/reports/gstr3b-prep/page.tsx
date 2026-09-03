import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** GST returns run on the calendar month — same convention as gst-registers / gstr1-summary. */
function monthBounds(month?: string): { from: string; to: string; label: string; ym: string } {
  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  let y = ty;
  let m = tm;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    [y, m] = month.split("-").map(Number);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const from = `${y}-${pad(m)}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${pad(m)}-${pad(lastDay)}`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { from, to, label, ym: `${y}-${pad(m)}` };
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type Table4 = {
  a1_import_of_goods: number;
  a2_import_of_services: number;
  a3_inward_rcm: number;
  a3_rcm_memo_liability_accrued: number;
  a4_isd: number;
  a5_all_other_itc: number;
  a5_all_other_itc_cgst: number;
  a5_all_other_itc_sgst: number;
  a5_all_other_itc_igst: number;
  a5_all_other_itc_cess: number;
  a_total: number;
  b1_sec17_5_blocked: number;
  b1_rule42_reversal: number;
  b1_rule42_reversal_cgst: number;
  b1_rule42_reversal_sgst: number;
  b1_rule42_reversal_igst: number;
  b1_rule42_reversal_cess: number;
  b1_total: number;
  b2_others_rule37: number;
  b_total: number;
  c_net_itc_available: number;
  d1_reclaimed_itc: number;
  d2_ineligible_16_4_and_pos: number;
  exempt_turnover_ratio: number;
  note: string;
};

type Table61Row = {
  tax_head: "igst" | "cgst" | "sgst" | "cess";
  tax_payable: number;
  itc_igst_utilised: number;
  itc_cgst_utilised: number;
  itc_sgst_utilised: number;
  itc_cess_utilised: number;
  itc_total_utilised: number;
  tds_tcs_credit: number;
  cash_tax_payable: number;
  interest_payable: number;
  late_fee_payable: number;
  // 1410 — the reconciliation behind the two numbers above. tax_payable is
  // now THIS period's own output tax; anything left unpaid from an earlier
  // return shows in output_brought_forward and is never re-reported here.
  // The credit pool is the electronic-credit-ledger balance brought forward
  // plus this period's NET ITC, so it agrees with Table 4(C) above instead
  // of quietly spending the gross figure.
  output_brought_forward: number;
  itc_opening: number;
  itc_period_gross: number;
  itc_period_reversal: number;
  itc_available: number;
  itc_balance_carried_forward: number;
  note: string;
};

type Table51Row = {
  tax_head: "igst" | "cgst" | "sgst" | "cess";
  cash_tax_payable: number;
  filing_frequency: string;
  qrmp_category: string | null;
  return_period_start: string;
  return_period_end: string;
  due_date: string;
  matched_payment_count: number;
  matched_payment_total: number;
  settlement_date: string | null;
  is_provisional: boolean;
  days_late: number;
  interest_rate_percent: number;
  interest_amount: number;
  is_nil_return_proxy: boolean;
  late_fee_rate_per_day: number;
  turnover_preceding_fy: number;
  late_fee_cap: number;
  late_fee_amount: number | null;
  note: string;
};

const HEAD_LABEL: Record<string, string> = {
  igst: "Integrated tax (IGST)",
  cgst: "Central tax (CGST)",
  sgst: "State/UT tax (SGST/UTGST)",
  cess: "Cess",
};

export default async function Gstr3bPrepPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/gstr3b-prep">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const { from, to, label, ym } = monthBounds(monthParam);
  const regParam = typeof sp.reg === "string" ? sp.reg : undefined;

  const [{ data: modules }, { data: registrations }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase
      .from("gst_registrations")
      .select("id, gstin, state_code")
      .eq("company_id", companyId)
      .order("gstin"),
  ]);

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);

  if (!gstOn) {
    return (
      <ReportShell title="GSTR-3B prep" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">GST is not on for this company</p>
          <p className="mt-1">
            Add a GST registration first —{" "}
            <Link href={`/${companyId}/registrations`} className="underline">
              Registrations
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const regs = registrations ?? [];
  const regId = regParam && regs.some((r) => r.id === regParam) ? regParam : regs[0]?.id;

  if (!regId) {
    return (
      <ReportShell title="GSTR-3B prep" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">No GST registration yet</p>
          <p className="mt-1">
            GSTR-3B is filed per registration — add one at{" "}
            <Link href={`/${companyId}/registrations`} className="underline">
              Registrations
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const [
    { data: t4Rows, error: t4Error },
    { data: t61Rows, error: t61Error },
    { data: t51Rows, error: t51Error },
  ] = await Promise.all([
    supabase.rpc("get_gstr3b_table4", {
      p_company_id: companyId,
      p_gst_registration_id: regId,
      p_period_start: from,
      p_period_end: to,
    }),
    supabase.rpc("get_gstr3b_table6_1", {
      p_company_id: companyId,
      p_gst_registration_id: regId,
      p_period_start: from,
      p_period_end: to,
    }),
    supabase.rpc("get_gstr3b_table5_1", {
      p_company_id: companyId,
      p_gst_registration_id: regId,
      p_period_start: from,
      p_period_end: to,
    }),
  ]);

  const t4 = (Array.isArray(t4Rows) ? t4Rows[0] : t4Rows) as Table4 | undefined;
  // `as unknown as` — 1410 added the reconciliation columns and the generated
  // database.types.ts still describes the pre-1410 shape until the
  // integration pass regenerates it, same situation as reports/balance-sheet
  // after 0089.
  const t61 = (t61Rows ?? []) as unknown as Table61Row[];
  const t51 = (t51Rows ?? []) as Table51Row[];
  const base = `/${companyId}/reports/gstr3b-prep`;
  const error = t4Error ?? t61Error ?? t51Error;

  const totalCashPayable = t61.reduce((n, r) => n + Number(r.cash_tax_payable), 0);
  const totalTaxPayable = t61.reduce((n, r) => n + Number(r.tax_payable), 0);

  return (
    <ReportShell
      title="GSTR-3B prep"
      period={`${label} · GST return period, due 20th of the following month for a monthly filer — not a filing`}
      status={
        error
          ? { label: "Could not compute", tone: "bad" }
          : { label: `${formatINR(totalCashPayable, { showZero: true })} to pay in cash`, tone: totalCashPayable > 0 ? "warn" : "ok" }
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 print:hidden">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`${base}?month=${shiftMonth(ym, -1)}&reg=${regId}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link href={`${base}?month=${shiftMonth(ym, 1)}&reg=${regId}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            Next →
          </Link>
        </div>

        {regs.length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            {regs.map((r) => (
              <Link
                key={r.id}
                href={`${base}?month=${ym}&reg=${r.id}`}
                className={
                  "rounded-md border px-2.5 py-1 font-mono text-xs " +
                  (regId === r.id ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
                }
              >
                {r.gstin}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="border-b border-border bg-bg px-4 py-3 text-xs text-ink-faint">
        <strong className="text-ink">Tables 3.1 and 3.2 are not shown here.</strong> Outward
        supplies and inter-State supplies to unregistered persons/composition dealers/UIN holders
        are portal-auto-populated from GSTR-1 and locked for edit once GSTR-1 is filed for the
        period — there is nothing for LEKHA to prepare there. This screen covers Table 4 (ITC),
        Table 5.1 (interest and late fee) and Table 6.1 (payment of tax) — the tables a filer
        actually needs source figures for.
      </div>

      {error && (
        <div className="m-4 rounded-md bg-error-soft px-4 py-3 text-sm text-error">
          {error.message}
        </div>
      )}

      {!error && t4 && (
        <>
          <div className="border-b border-border p-4">
            <h2 className="font-semibold">Table 4 — Eligible ITC</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Current (post-July-2022) GSTR-3B format per CBIC Circular 170/02/2022-GST: Sec 17(5)
              blocked credit is reported in 4(B)(1), not 4(D).
            </p>
          </div>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Row</th>
                <th className={th}>Description</th>
                <th className={th + " text-right"}>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border bg-bg text-xs font-semibold uppercase tracking-wide text-ink-faint">
                <td className={td} colSpan={3}>4(A) ITC Available</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " font-mono text-xs"}>A(1)</td>
                <td className={td}>Import of goods</td>
                <td className={num}>{formatINR(t4.a1_import_of_goods, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " font-mono text-xs"}>A(2)</td>
                <td className={td}>Import of services</td>
                <td className={num}>{formatINR(t4.a2_import_of_services, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " font-mono text-xs"}>A(3)</td>
                <td className={td}>
                  Inward supplies liable to reverse charge
                  <div className="mt-0.5 text-xs text-ink-faint">
                    Always 0 by design — RCM tax is never posted as same-period ITC (Sec 49(4)).
                    Self-assessed RCM liability accrued this period, for reference only, not part of
                    any ITC total:{" "}
                    <strong>{formatINR(t4.a3_rcm_memo_liability_accrued, { showZero: true })}</strong>
                  </div>
                </td>
                <td className={num}>{formatINR(t4.a3_inward_rcm, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " font-mono text-xs"}>A(4)</td>
                <td className={td}>Inward supplies from ISD</td>
                <td className={num}>{formatINR(t4.a4_isd, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " font-mono text-xs"}>A(5)</td>
                <td className={td}>
                  All other ITC
                  <div className="mt-0.5 text-xs text-ink-faint">
                    CGST {formatINR(t4.a5_all_other_itc_cgst, { showZero: true })} · SGST{" "}
                    {formatINR(t4.a5_all_other_itc_sgst, { showZero: true })} · IGST{" "}
                    {formatINR(t4.a5_all_other_itc_igst, { showZero: true })} · Cess{" "}
                    {formatINR(t4.a5_all_other_itc_cess, { showZero: true })}
                  </div>
                </td>
                <td className={num}>{formatINR(t4.a5_all_other_itc, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border bg-bg font-semibold">
                <td className={td} colSpan={2}>Total ITC Available (A)</td>
                <td className={num}>{formatINR(t4.a_total, { showZero: true })}</td>
              </tr>

              <tr className="border-b border-border bg-bg text-xs font-semibold uppercase tracking-wide text-ink-faint">
                <td className={td} colSpan={3}>4(B) ITC Reversed</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " font-mono text-xs"}>B(1)</td>
                <td className={td}>
                  As per Rule 42/43 and Sec 17(5)
                  <div className="mt-0.5 text-xs text-ink-faint">
                    Sec 17(5) blocked {formatINR(t4.b1_sec17_5_blocked, { showZero: true })} + Rule
                    42 reversal {formatINR(t4.b1_rule42_reversal, { showZero: true })} (CGST{" "}
                    {formatINR(t4.b1_rule42_reversal_cgst, { showZero: true })}, SGST{" "}
                    {formatINR(t4.b1_rule42_reversal_sgst, { showZero: true })}, IGST{" "}
                    {formatINR(t4.b1_rule42_reversal_igst, { showZero: true })}, Cess{" "}
                    {formatINR(t4.b1_rule42_reversal_cess, { showZero: true })}). Rule 43 (capital
                    goods) is not included — not built anywhere in this app.
                  </div>
                </td>
                <td className={num}>{formatINR(t4.b1_total, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td + " font-mono text-xs"}>B(2)</td>
                <td className={td}>
                  Others
                  <div className="mt-0.5 text-xs text-ink-faint">
                    Rule 37 (180-day non-payment) reversals newly triggered this period.
                  </div>
                </td>
                <td className={num}>{formatINR(t4.b2_others_rule37, { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border bg-bg font-semibold">
                <td className={td} colSpan={2}>Total ITC Reversed (B)</td>
                <td className={num}>{formatINR(t4.b_total, { showZero: true })}</td>
              </tr>

              <tr className="border-b border-border bg-accent-soft font-semibold">
                <td className={td} colSpan={2}>4(C) Net ITC Available (A &minus; B)</td>
                <td className={num}>{formatINR(t4.c_net_itc_available, { showZero: true })}</td>
              </tr>

              <tr className="border-b border-border bg-bg text-xs font-semibold uppercase tracking-wide text-ink-faint">
                <td className={td} colSpan={3}>4(D) Other ITC (informational — not part of C)</td>
              </tr>
              <tr className="border-b border-border text-ink-faint">
                <td className={td + " font-mono text-xs"}>D(1)</td>
                <td className={td}>ITC reclaimed which was reversed under B(2) earlier — not tracked</td>
                <td className={num}>{formatINR(t4.d1_reclaimed_itc, { showZero: true })}</td>
              </tr>
              <tr className="text-ink-faint">
                <td className={td + " font-mono text-xs"}>D(2)</td>
                <td className={td}>Ineligible ITC under Sec 16(4) / place-of-supply — not tracked</td>
                <td className={num}>{formatINR(t4.d2_ineligible_16_4_and_pos, { showZero: true })}</td>
              </tr>
            </tbody>
          </table>
          <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">{t4.note}</p>

          <div className="border-b border-t border-border p-4">
            <h2 className="font-semibold">Table 6.1 — Payment of tax</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              <strong className="text-ink">Tax payable is this period&rsquo;s own output tax</strong> —
              {" "}
              {from} to {to}, net of this period&rsquo;s credit notes, with GST set-off clearing
              journals excluded so the figures do not change depending on whether you have posted the
              set-off yet. An earlier return&rsquo;s unpaid liability is shown separately below and is
              never re-reported here. Credit is drawn from the electronic credit ledger: the balance
              brought forward plus Table 4(C) net ITC above, i.e. after the whole of 4(B). Set-off
              order is Sec 49/49A/49B and Rule 88A, the same cascade as{" "}
              <Link href={`/${companyId}/reports/gst-setoff?as_at=${to}&reg=${regId}`} className="underline">
                GST set-off
              </Link>
              , which is a different report on purpose: that one clears the control ledgers as they
              stand today, this one prepares one return period.
            </p>
          </div>
          <table className="w-full min-w-[840px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Head</th>
                <th className={th + " text-right"}>Tax payable</th>
                <th className={th + " text-right"}>IGST used</th>
                <th className={th + " text-right"}>CGST used</th>
                <th className={th + " text-right"}>SGST used</th>
                <th className={th + " text-right"}>Cess used</th>
                <th className={th + " text-right"}>TDS/TCS credit</th>
                <th className={th + " text-right"}>Paid in cash</th>
                <th className={th + " text-right"}>Interest</th>
                <th className={th + " text-right"}>Late fee</th>
              </tr>
            </thead>
            <tbody>
              {t61.map((r) => (
                <tr key={r.tax_head} className="border-b border-border last:border-0">
                  <td className={td + " font-medium"}>{HEAD_LABEL[r.tax_head]}</td>
                  <td className={num}>{formatINR(r.tax_payable, { showZero: true })}</td>
                  <td className={num}>{formatINR(r.itc_igst_utilised, { showZero: true })}</td>
                  <td className={num}>{formatINR(r.itc_cgst_utilised, { showZero: true })}</td>
                  <td className={num}>{formatINR(r.itc_sgst_utilised, { showZero: true })}</td>
                  <td className={num}>{formatINR(r.itc_cess_utilised, { showZero: true })}</td>
                  <td className={num + " text-ink-faint"}>{formatINR(r.tds_tcs_credit, { showZero: true })}</td>
                  <td className={num + (r.cash_tax_payable > 0 ? " font-semibold text-warning" : "")}>
                    {formatINR(r.cash_tax_payable, { showZero: true })}
                  </td>
                  <td className={num + " text-ink-faint"}>{formatINR(r.interest_payable, { showZero: true })}</td>
                  <td className={num + " text-ink-faint"}>{formatINR(r.late_fee_payable, { showZero: true })}</td>
                </tr>
              ))}
              <tr className="bg-bg font-semibold">
                <td className={td}>Total</td>
                <td className={num}>{formatINR(totalTaxPayable, { showZero: true })}</td>
                <td className={num} colSpan={4}></td>
                <td className={num}></td>
                <td className={num}>{formatINR(totalCashPayable, { showZero: true })}</td>
                <td className={num} colSpan={2}></td>
              </tr>
            </tbody>
          </table>

          <div className="border-b border-t border-border p-4">
            <h3 className="text-sm font-semibold">Where the credit came from</h3>
            <p className="mt-0.5 text-xs text-ink-faint">
              The electronic credit ledger behind the &ldquo;used&rdquo; columns above. Available =
              brought forward + this period&rsquo;s gross ITC &minus; this period&rsquo;s 4(B)
              reversal. The four reversal figures always add up to Table 4&rsquo;s own B total
              ({formatINR(t4.b_total, { showZero: true })}) — Rule 42 and Rule 37 split per head from
              their own sources, Sec 17(5) blocked credit apportioned by this period&rsquo;s ITC mix
              because this schema holds no per-head split for it.
            </p>
          </div>
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Head</th>
                <th className={th + " text-right"}>Credit b/f</th>
                <th className={th + " text-right"}>ITC this period</th>
                <th className={th + " text-right"}>Less 4(B) reversal</th>
                <th className={th + " text-right"}>Available</th>
                <th className={th + " text-right"}>Used</th>
                <th className={th + " text-right"}>Credit c/f</th>
                <th className={th + " text-right"}>Output b/f (earlier return)</th>
              </tr>
            </thead>
            <tbody>
              {t61.map((r) => (
                <tr key={r.tax_head} className="border-b border-border last:border-0">
                  <td className={td + " font-medium"}>{HEAD_LABEL[r.tax_head]}</td>
                  <td className={num}>{formatINR(r.itc_opening, { showZero: true })}</td>
                  <td className={num}>{formatINR(r.itc_period_gross, { showZero: true })}</td>
                  <td className={num + (r.itc_period_reversal > 0 ? " text-warning" : "")}>
                    {formatINR(r.itc_period_reversal, { showZero: true })}
                  </td>
                  <td className={num + " font-medium"}>{formatINR(r.itc_available, { showZero: true })}</td>
                  <td className={num}>{formatINR(r.itc_total_utilised, { showZero: true })}</td>
                  <td className={num}>{formatINR(r.itc_balance_carried_forward, { showZero: true })}</td>
                  <td className={num + (r.output_brought_forward > 0 ? " font-semibold text-warning" : " text-ink-faint")}>
                    {formatINR(r.output_brought_forward, { showZero: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {t61.some((r) => r.output_brought_forward > 0) && (
            <p className="border-t border-border px-4 py-3 text-xs text-warning">
              {formatINR(
                t61.reduce((n, r) => n + Number(r.output_brought_forward), 0),
                { showZero: true }
              )}{" "}
              of output tax was still sitting uncleared in the control ledgers when this period
              began. It belongs to an EARLIER return and is deliberately not added to the figures
              above — re-reporting it here would pay the same tax twice. Clear it by posting that
              period&rsquo;s GST set-off dated inside that period, on{" "}
              <Link href={`/${companyId}/reports/gst-setoff`} className="underline">
                GST set-off
              </Link>
              .
            </p>
          )}
          {t61.some((r) => r.tax_payable < 0) && (
            <p className="border-t border-border px-4 py-3 text-xs text-warning">
              A negative tax payable means this period&rsquo;s credit notes outran its sales for that
              head. It is shown as it stands and consumes no credit. GSTN will not accept a negative
              liability — the excess has to be carried into a later period&rsquo;s GSTR-1, which
              LEKHA does not do for you.
            </p>
          )}
          {t61[0]?.note && (
            <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">{t61[0].note}</p>
          )}

          <div className="border-b border-t border-border p-4">
            <h2 className="font-semibold">Table 5.1 — Interest and late fee</h2>
            {t51.length > 0 && (
              <p className="mt-0.5 text-xs text-ink-faint">
                Sec 50(1) interest (18% p.a., daily basis, on the net cash liability) and Sec 47(1)
                late fee (₹50/day, ₹20/day for a nil-return proxy, turnover-capped), for the return
                period {t51[0].return_period_start} to {t51[0].return_period_end} (
                {t51[0].filing_frequency === "qrmp"
                  ? `QRMP, Category ${t51[0].qrmp_category}`
                  : "monthly filer"}
                ), due {t51[0].due_date}
                {t51[0].return_period_start !== from || t51[0].return_period_end !== to ? (
                  <>
                    {" "}
                    — this registration files quarterly, so the actual return period differs from
                    the calendar month selected above.
                  </>
                ) : null}
                . Matched against{" "}
                <Link href={`/${companyId}/tax-payments`} className="underline">
                  tax payments
                </Link>{" "}
                tagged with this exact period.
              </p>
            )}
          </div>
          {t51.length > 0 && (
            <>
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className={th}>Head</th>
                    <th className={th + " text-right"}>Cash tax payable</th>
                    <th className={th}>Settlement date</th>
                    <th className={th + " text-right"}>Days late</th>
                    <th className={th + " text-right"}>Interest (a)</th>
                    <th className={th + " text-right"}>Late fee (b)</th>
                  </tr>
                </thead>
                <tbody>
                  {t51.map((r) => (
                    <tr key={r.tax_head} className="border-b border-border last:border-0">
                      <td className={td + " font-medium"}>{HEAD_LABEL[r.tax_head]}</td>
                      <td className={num}>{formatINR(r.cash_tax_payable, { showZero: true })}</td>
                      <td className={td}>
                        {r.settlement_date ?? "—"}
                        {r.is_provisional && (
                          <div className="text-xs text-warning">provisional, as if paid today</div>
                        )}
                        {!r.is_provisional && r.matched_payment_count > 1 && (
                          <div className="text-xs text-ink-faint">
                            {r.matched_payment_count} challans, latest date used
                          </div>
                        )}
                      </td>
                      <td className={num}>{r.days_late}</td>
                      <td className={num + (r.interest_amount > 0 ? " font-semibold text-warning" : "")}>
                        {formatINR(r.interest_amount, { showZero: true })}
                      </td>
                      <td className={num + ((r.late_fee_amount ?? 0) > 0 ? " font-semibold text-warning" : "")}>
                        {r.late_fee_amount === null ? "—" : formatINR(r.late_fee_amount, { showZero: true })}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-bg font-semibold">
                    <td className={td}>Total</td>
                    <td className={num}>
                      {formatINR(t51.reduce((n, r) => n + Number(r.cash_tax_payable), 0), { showZero: true })}
                    </td>
                    <td className={td} colSpan={2}></td>
                    <td className={num}>
                      {formatINR(t51.reduce((n, r) => n + Number(r.interest_amount), 0), { showZero: true })}
                    </td>
                    <td className={num}>
                      {formatINR(
                        t51.reduce((n, r) => n + Number(r.late_fee_amount ?? 0), 0),
                        { showZero: true }
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="border-t border-border px-4 py-3 text-xs text-ink-faint">
                {t51[0].matched_payment_count > 0 ? (
                  <p>
                    {t51[0].matched_payment_count} challan(s) tagged to this period, totalling{" "}
                    {formatINR(t51[0].matched_payment_total, { showZero: true })}
                    {Math.abs(t51[0].matched_payment_total - t51.reduce((n, r) => n + Number(r.cash_tax_payable), 0)) > 1 && (
                      <> — this differs from the computed net cash liability above; interest and late fee are based on the computed liability, not the challan total.</>
                    )}
                    .
                  </p>
                ) : (
                  <p>
                    No challan is tagged to this exact period yet on{" "}
                    <Link href={`/${companyId}/tax-payments`} className="underline">
                      Tax payments
                    </Link>
                    {t51.some((r) => r.cash_tax_payable > 0) &&
                      " — the figures above are provisional, computed as if paid today, and will keep growing until a challan is recorded and tagged."}
                  </p>
                )}
                <p className="mt-2">
                  {t51[0].is_nil_return_proxy
                    ? "Treated as a NIL return for the late-fee rate (no outward supply, no ITC claimed, no RCM liability accrued this period, by proxy — Table 3.1/3.2 are not built here, see note below)."
                    : `Turnover in the preceding financial year (this registration only): ${formatINR(t51[0].turnover_preceding_fy, { showZero: true })}, late-fee cap ${formatINR(t51[0].late_fee_cap, { showZero: true })}.`}
                </p>
                <p className="mt-2">{t51[0].note}</p>
              </div>
            </>
          )}
        </>
      )}
    </ReportShell>
  );
}
