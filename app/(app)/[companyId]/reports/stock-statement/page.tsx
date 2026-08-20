import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td } from "@/components/reports/ReportShell";
import { NewFacilityForm } from "@/components/banking/NewFacilityForm";

export default async function StockStatementPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/stock-statement">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: company }, { data: modules }] = await Promise.all([
    supabase
      .from("companies")
      .select("financial_year_start_month")
      .eq("id", companyId)
      .maybeSingle(),
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
  ]);

  const today = defaultPeriod(company?.financial_year_start_month ?? 4).to;
  const stockStatementOn = (modules ?? []).some(
    (m) => m.code === "stock_statement" && m.active
  );

  if (!stockStatementOn) {
    return (
      <ReportShell title="Stock statement" period={`As at ${today}`}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">Not turned on for this company</p>
          <p className="mt-1">
            Stock statement depends on the Banking and Inventory modules
            being enabled first.{" "}
            <Link href={`/${companyId}/settings/modules`} className="underline">
              Turn them on in Settings → Modules
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const facilityParam = typeof sp.facility === "string" ? sp.facility : undefined;

  const [{ data: facilities }, { data: rows }] = await Promise.all([
    supabase
      .from("banking_facilities")
      .select("id, bank_name, facility_type, sanctioned_limit")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("created_at"),
    supabase.rpc("get_drawing_power", {
      p_company_id: companyId,
      p_as_at: today,
      p_facility_id: facilityParam || undefined,
    }),
  ]);

  const dp = rows?.[0] ?? null;
  const activeFacilities = facilities ?? [];

  if (!dp) {
    return (
      <ReportShell title="Stock statement" period={`As at ${today}`}>
        <p className="px-4 py-12 text-center text-ink-faint">Company not found.</p>
      </ReportShell>
    );
  }

  const closingStock = Number(dp.closing_stock_value);
  const creditors = Number(dp.sundry_creditors);
  const paidStock = Number(dp.paid_stock);
  const stockMargin = Number(dp.stock_margin_percent);
  const dpStock = Number(dp.dp_from_stock);
  const totalDebtors = Number(dp.total_debtors);
  const ineligibleDebtors = Number(dp.ineligible_debtors);
  const eligibleDebtors = Number(dp.eligible_debtors);
  const debtorMargin = Number(dp.debtor_margin_percent);
  const dpDebtors = Number(dp.dp_from_debtors);
  const totalDp = Number(dp.total_drawing_power);
  const sanctionedLimit = Number(dp.sanctioned_limit ?? 0);
  const usableLimit = sanctionedLimit > 0 ? Math.min(totalDp, sanctionedLimit) : totalDp;
  const base = `/${companyId}/reports/stock-statement`;

  return (
    <ReportShell
      title="Stock statement"
      period={
        dp.bank_name
          ? `As at ${today} · ${dp.bank_name}`
          : `As at ${today} · monthly submission for a bank CC/OD facility`
      }
      status={{
        label: `${formatINR(totalDp, { showZero: true })} drawing power`,
        tone: "ok",
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
        {activeFacilities.length > 1 &&
          activeFacilities.map((f) => (
            <Link
              key={f.id}
              href={`${base}?facility=${f.id}`}
              className={
                "rounded-md border px-2.5 py-1 text-sm " +
                (dp.facility_id === f.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-strong hover:bg-surface-2")
              }
            >
              {f.bank_name}
            </Link>
          ))}
        <NewFacilityForm companyId={companyId} />
      </div>

      <table className="w-full text-sm">
        <tbody>
          <tr className="border-b border-border bg-bg">
            <td className={td + " font-semibold"} colSpan={2}>
              Stock
            </td>
          </tr>
          <tr className="border-b border-border">
            <td className={td}>Closing stock value</td>
            <td className={num}>{formatINR(closingStock, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border">
            <td className={td}>− Sundry creditors</td>
            <td className={num}>{formatINR(creditors, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border">
            <td className={td + " font-medium"}>= Paid stock</td>
            <td className={num + " font-medium"}>{formatINR(paidStock, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border">
            <td className={td}>− Margin ({stockMargin}%)</td>
            <td className={num}>
              {formatINR(paidStock - dpStock, { showZero: true })}
            </td>
          </tr>
          <tr className="border-b border-border bg-success-soft">
            <td className={td + " font-semibold"}>Drawing power from stock</td>
            <td className={num + " font-semibold"}>{formatINR(dpStock, { showZero: true })}</td>
          </tr>

          <tr className="border-b border-border bg-bg">
            <td className={td + " font-semibold"} colSpan={2}>
              Debtors
            </td>
          </tr>
          <tr className="border-b border-border">
            <td className={td}>Total sundry debtors</td>
            <td className={num}>{formatINR(totalDebtors, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border">
            <td className={td}>
              − Older than {dp.debtor_eligibility_days} days (ineligible)
            </td>
            <td className={num}>{formatINR(ineligibleDebtors, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border">
            <td className={td + " font-medium"}>= Eligible debtors</td>
            <td className={num + " font-medium"}>{formatINR(eligibleDebtors, { showZero: true })}</td>
          </tr>
          <tr className="border-b border-border">
            <td className={td}>− Margin ({debtorMargin}%)</td>
            <td className={num}>
              {formatINR(eligibleDebtors - dpDebtors, { showZero: true })}
            </td>
          </tr>
          <tr className="border-b border-border bg-success-soft">
            <td className={td + " font-semibold"}>Drawing power from debtors</td>
            <td className={num + " font-semibold"}>{formatINR(dpDebtors, { showZero: true })}</td>
          </tr>

          <tr className="bg-accent-soft">
            <td className={td + " text-base font-bold"}>Total drawing power</td>
            <td className={num + " text-base font-bold"}>{formatINR(totalDp, { showZero: true })}</td>
          </tr>
          {sanctionedLimit > 0 && (
            <>
              <tr className="border-b border-border">
                <td className={td}>Sanctioned limit</td>
                <td className={num}>{formatINR(sanctionedLimit, { showZero: true })}</td>
              </tr>
              <tr className="bg-bg">
                <td className={td + " text-base font-bold"}>Usable (lower of the two)</td>
                <td className={num + " text-base font-bold"}>{formatINR(usableLimit, { showZero: true })}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Margins and the debtor eligibility window ({dp.debtor_eligibility_days}{" "}
        days) are set per facility above and default to typical figures (25%
        stock, 40% debtors, 90 days) — confirm both against your actual
        sanction letter. Debtor ageing is inferred (receipts applied to the
        oldest invoice first), not bill-wise allocated — see the Outstanding
        report for the same caveat. Excludes stock the bank would separately
        reject as obsolete, uninsured, or at an unapproved location, and
        debtors disputed or otherwise ineligible by the bank&rsquo;s own
        judgement — neither is something ledger data alone can answer.
        {sanctionedLimit === 0 &&
          " Enter a sanctioned limit on the facility to see it compared against drawing power directly."}
      </p>
    </ReportShell>
  );
}
