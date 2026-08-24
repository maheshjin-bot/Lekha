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

  const [{ data: t4Rows, error: t4Error }, { data: t61Rows, error: t61Error }] = await Promise.all([
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
  ]);

  const t4 = (Array.isArray(t4Rows) ? t4Rows[0] : t4Rows) as Table4 | undefined;
  const t61 = (t61Rows ?? []) as Table61Row[];
  const base = `/${companyId}/reports/gstr3b-prep`;
  const error = t4Error ?? t61Error;

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
        period — there is nothing for LEKHA to prepare there. This screen covers only Table 4 (ITC)
        and Table 6.1 (payment of tax), the two tables a filer actually needs source figures for.
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
              Reused directly from the GST set-off computation (Sec 49/49A/49B, Rule 88A) — same
              figures as{" "}
              <Link href={`/${companyId}/reports/gst-setoff?as_at=${to}&reg=${regId}`} className="underline">
                GST set-off
              </Link>
              , cumulative since the last set-off posting as at {to}, not strictly bounded to this
              calendar month unless set-off was last posted at the start of it.
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

          <div className="border-t border-border p-4">
            <h2 className="font-semibold">Table 5.1 — Interest and late fee: not computed</h2>
            <p className="mt-1 text-xs text-ink-faint">
              Sec 50(1) interest (18% p.a., on the net tax actually paid through the cash ledger —
              proviso inserted by the Finance Act 2019, retrospective from 1 July 2017 per
              Notification 16/2021-CT) and Sec 47(1) late fee (₹50/day standard, ₹20/day for a NIL
              return, turnover-capped) both need each GST challan matched to the SPECIFIC return
              period it settles, checked against that period&rsquo;s own due date (20th of the
              following month for a monthly filer — QRMP&rsquo;s 22nd/24th dates are not modelled,
              LEKHA has no QRMP election flag). <Link href={`/${companyId}/tax-payments`} className="underline">Tax payments</Link>{" "}
              records a payment date and financial year for a GST challan, but not which month or
              quarter&rsquo;s liability it settles — so a payment cannot be matched to a due date
              reliably, and a guessed match would be presented with false confidence. Shipped as an
              explicit gap rather than an approximate number; see the underlying migration for what
              schema change would make this reliably computable.
            </p>
          </div>
        </>
      )}
    </ReportShell>
  );
}
