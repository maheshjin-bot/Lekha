import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";
import { quarterBounds, financialYearLabel, todayLocal } from "@/components/reports/tdsReturnQuarters";

/**
 * Sec 201(1A)(ii) late-deposit interest, and Sec 234E late-filing fee, for
 * TDS/TCS — see migration 0130 for the full statutory research (both
 * sections' rates/cap confirmed live, unchanged by the Income-tax Act 2025's
 * renumbering to Sec 398(3) and Sec 427 respectively) and the two real gaps
 * it found and worked around:
 *
 *  1. tax_payments (0079) has a deposit date but NO deduction date and no
 *     structural link to which deduction(s) a challan settles — so late-
 *     deposit interest below is a FIFO date-ordered candidate allocation
 *     between TDS-Payable deduction events and challans, not a verified
 *     per-challan figure. Sec 201(1A)(i) late-DEDUCTION interest (1%) is not
 *     attempted at all: it needs two different dates per event and LEKHA's
 *     one-voucher-date-per-line model cannot represent that distinction,
 *     structurally, not just approximately.
 *
 *  2. Nothing in this schema records a TDS/TCS return's actual filing date —
 *     not tax_payments, not the tds-return-24q/26q/27q prep pages shipped
 *     earlier today (they generate nothing, they file nothing), and
 *     filing_register (0095) is a general free-text log this report does not
 *     attempt to match programmatically. So the Sec 234E section below takes
 *     a filing date from the preparer — real if known, hypothetical
 *     ("what if I file on X") otherwise — rather than silently returning 0.
 */

type InterestRow = {
  deduction_voucher_id: string;
  deduction_date: string;
  due_date: string;
  amount_matched: number;
  challan_id: string | null;
  deposit_date: string | null;
  status: "on_time" | "late" | "not_yet_deposited";
  months_delayed: number;
  interest_rate_percent: number;
  interest_amount: number;
};

type FeeRow = {
  quarter_label: string;
  quarter_start: string;
  quarter_end: string;
  due_date: string;
  filing_date: string;
  days_late: number;
  fee_before_cap: number;
  tds_deductible_for_quarter: number;
  fee_after_cap: number;
  cap_applied: boolean;
  note: string;
};

function statusBadge(status: InterestRow["status"]) {
  if (status === "on_time") return <Badge tone="ok">On time</Badge>;
  if (status === "late") return <Badge tone="bad">Late</Badge>;
  return <Badge tone="warn">Not yet deposited</Badge>;
}

export default async function TdsInterestAndFeesPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/tds-interest-and-fees">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const defaultBounds = quarterBounds();
  const fy =
    typeof sp.fy === "string" && /^\d{4}-\d{2}$/.test(sp.fy) ? sp.fy : financialYearLabel(defaultBounds.fyStart);
  const qParam = typeof sp.q === "string" ? parseInt(sp.q, 10) : defaultBounds.qNum;
  const quarter = [1, 2, 3, 4].includes(qParam) ? qParam : defaultBounds.qNum;
  const filed =
    typeof sp.filed === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.filed) ? sp.filed : todayLocal();

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const tdsOn = (modules ?? []).some((m) => m.code === "tds" && m.active);

  if (!tdsOn) {
    return (
      <ReportShell title="TDS/TCS interest and late fees" period={`FY ${fy}`}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">TDS is not on for this company</p>
          <p className="mt-1">
            TDS activates once a TAN is set —{" "}
            <Link href={`/${companyId}/settings`} className="underline">
              Settings
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const [{ data: interestRows, error: interestError }, { data: feeRows, error: feeError }] = await Promise.all([
    supabase.rpc("get_tds_late_deposit_interest", { p_company_id: companyId, p_financial_year_label: fy }),
    supabase.rpc("get_234e_late_fee", {
      p_company_id: companyId,
      p_financial_year_label: fy,
      p_quarter: quarter,
      p_actual_or_hypothetical_filing_date: filed,
    }),
  ]);

  const interest = (interestRows ?? []) as InterestRow[];
  const totalInterest = interest.reduce((n, r) => n + Number(r.interest_amount), 0);
  const lateCount = interest.filter((r) => r.status !== "on_time" && Number(r.interest_amount) > 0).length;

  const fee = ((feeRows ?? []) as FeeRow[])[0] ?? null;

  return (
    <ReportShell
      title="TDS/TCS interest and late fees"
      period={`FY ${fy} · Sec 201(1A)(ii) + Sec 234E — estimates for review, not a demand notice`}
      status={{
        label:
          totalInterest > 0 || (fee && fee.fee_after_cap > 0)
            ? `${formatINR(totalInterest + (fee?.fee_after_cap ?? 0), { showZero: true })} combined exposure shown below`
            : "no interest or fee shown for the selections below",
        tone: totalInterest > 0 || (fee && fee.fee_after_cap > 0) ? "warn" : "ok",
      }}
    >
      <form method="get" className="flex flex-wrap items-end gap-3 border-b border-border p-4 text-sm">
        <div>
          <label htmlFor="fy" className="block text-[11px] uppercase tracking-wide text-ink-faint">
            Financial year
          </label>
          <input
            id="fy"
            name="fy"
            type="text"
            defaultValue={fy}
            placeholder="2026-27"
            className="field w-28"
          />
        </div>
        <div>
          <label htmlFor="q" className="block text-[11px] uppercase tracking-wide text-ink-faint">
            Quarter (234E)
          </label>
          <select id="q" name="q" defaultValue={String(quarter)} className="field w-auto">
            <option value="1">Q1 (Apr-Jun)</option>
            <option value="2">Q2 (Jul-Sep)</option>
            <option value="3">Q3 (Oct-Dec)</option>
            <option value="4">Q4 (Jan-Mar)</option>
          </select>
        </div>
        <div>
          <label htmlFor="filed" className="block text-[11px] uppercase tracking-wide text-ink-faint">
            Filing date — actual or hypothetical
          </label>
          <input id="filed" name="filed" type="date" defaultValue={filed} className="field w-auto" />
        </div>
        <button type="submit" className="rounded-md border border-border-strong px-3 py-1.5 hover:bg-surface-2">
          Recalculate
        </button>
      </form>

      <div className="border-b border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Sec 201(1A)(ii) — interest on late deposit <Badge tone="neutral">1.5% / month</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every TDS-Payable deduction this financial year, FIFO-matched against tax_payments challans by date —
          LEKHA has no structural link recording which challan settles which deduction (OLTAS challan 281 does not
          capture this either), so this is a candidate allocation, not a verified one. A row with no matching challan
          yet is shown as &ldquo;not yet deposited,&rdquo; with interest run provisionally to today.
        </p>
      </div>
      {interestError && (
        <div className="border-b border-border bg-error-soft p-4 text-sm text-error">
          Could not load interest: {interestError.message}
        </div>
      )}
      <table className="w-full min-w-[960px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Deducted</th>
            <th className={th}>Due date</th>
            <th className={th}>Deposited</th>
            <th className={th}>Status</th>
            <th className={th + " text-right"}>Amount matched</th>
            <th className={th + " text-right"}>Months delayed</th>
            <th className={th + " text-right"}>Interest @ 1.5%</th>
          </tr>
        </thead>
        <tbody>
          {interest.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                No TDS deductions recorded for FY {fy}.
              </td>
            </tr>
          )}
          {interest.map((r, i) => (
            <tr key={`${r.deduction_voucher_id}-${r.challan_id ?? "unmatched"}-${i}`} className="border-b border-border last:border-0">
              <td className={td}>{r.deduction_date}</td>
              <td className={td}>{r.due_date}</td>
              <td className={td}>{r.deposit_date ?? "—"}</td>
              <td className={td}>{statusBadge(r.status)}</td>
              <td className={num}>{formatINR(Number(r.amount_matched), { showZero: true })}</td>
              <td className={num}>{r.months_delayed}</td>
              <td className={num}>{formatINR(Number(r.interest_amount), { showZero: true })}</td>
            </tr>
          ))}
          {interest.length > 0 && (
            <tr className="bg-bg font-semibold">
              <td className={td} colSpan={6}>
                Total interest — {lateCount} deduction{lateCount === 1 ? "" : "s"} late or still outstanding
              </td>
              <td className={num}>{formatINR(totalInterest, { showZero: true })}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Sec 234E — late-filing fee <Badge tone="neutral">Rs 200 / day, capped</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Nothing in this schema records when a TDS/TCS return was actually filed, so the filing date above is
          entered by you — real if you know it, hypothetical to see the exposure &ldquo;as if&rdquo; filed on that
          date. The fee is capped at the TDS actually deductible for the quarter shown (same total Annexure I shows
          on the 24Q/26Q/27Q prep pages).
        </p>
      </div>
      {feeError && (
        <div className="border-b border-border bg-error-soft p-4 text-sm text-error">
          Could not load the fee: {feeError.message}
        </div>
      )}
      {fee && (
        <table className="w-full min-w-[720px] text-sm">
          <tbody>
            <tr className="border-b border-border">
              <td className={td}>Quarter</td>
              <td className={td}>{fee.quarter_label}</td>
              <td className={td}>
                {fee.quarter_start} to {fee.quarter_end}
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className={td}>Statutory due date</td>
              <td className={td} colSpan={2}>
                {fee.due_date}
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className={td}>Filing date used</td>
              <td className={td} colSpan={2}>
                {fee.filing_date}
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className={td}>Days late</td>
              <td className={num} colSpan={2}>
                {fee.days_late}
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className={td}>Fee before cap (Rs 200/day)</td>
              <td className={num} colSpan={2}>
                {formatINR(Number(fee.fee_before_cap), { showZero: true })}
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className={td}>TDS deductible for the quarter (the cap)</td>
              <td className={num} colSpan={2}>
                {formatINR(Number(fee.tds_deductible_for_quarter), { showZero: true })}
              </td>
            </tr>
            <tr className="bg-bg font-semibold">
              <td className={td}>Fee payable</td>
              <td className={num} colSpan={2}>
                {formatINR(Number(fee.fee_after_cap), { showZero: true })}
                {fee.cap_applied && <Badge tone="warn" className="ml-2">capped</Badge>}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {fee && <p className="border-b border-border px-4 py-3 text-xs text-ink-faint">{fee.note}</p>}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Sec 201(1A)(ii) [Income-tax Act 1961; recodified as Sec 398(3)(a)(ii), Income-tax Act 2025 w.e.f. 1 Apr 2026]
        and Sec 234E [recodified as Sec 427] — both rates and the fee cap are unchanged across the recodification.
        This report does NOT compute Sec 201(1A)(i) late-deduction interest (1%): it needs the date a payment became
        deductible to differ from the date TDS was actually deducted, and every LEKHA voucher shares one date across
        all its lines, so that distinction cannot be represented, not merely estimated. Nor does it compute the
        separate, discretionary Sec 271H penalty (Rs 10,000-1,00,000). The late-deposit interest above is a
        FIFO date-ordered candidate match between deduction events and challans — review it against your own
        challan-to-deduction records before relying on the figure. Nothing here is filed or submitted anywhere.
      </p>
    </ReportShell>
  );
}
