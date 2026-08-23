import { createClient } from "@/lib/supabase/server";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell } from "@/components/reports/ReportShell";
import { DaybookTable } from "@/components/reports/DaybookTable";

/**
 * The Daybook's own data, pre-scoped to one purpose — a dedicated Sales
 * Invoices / Purchase Bills / Sales Returns / Purchase Returns list is the
 * same get_daybook query with lockedTypes set, not a separate report. All
 * four pages under app/(app)/[companyId]/reports/ are thin callers of this.
 */
export async function VoucherTypeList({
  companyId,
  basePath,
  title,
  description,
  lockedTypes,
  searchParams,
}: {
  companyId: string;
  basePath: string;
  title: string;
  description: string;
  lockedTypes: string[];
  searchParams: { from?: string; to?: string };
}) {
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month")
    .eq("id", companyId)
    .maybeSingle();

  const period = defaultPeriod(company?.financial_year_start_month ?? 4, {
    from: searchParams.from,
    to: searchParams.to,
  });

  const { data: rows, error } = await supabase.rpc("get_daybook", {
    p_company_id: companyId,
    p_from: period.from,
    p_to: period.to,
  });

  return (
    <ReportShell title={title} period={period.label}>
      <p className="border-b border-border px-4 py-3 text-sm text-ink-soft print:hidden">
        {description}
      </p>
      {error && (
        <p className="m-4 rounded-lg bg-error-soft px-3 py-2 text-sm text-error">
          {error.message}
        </p>
      )}
      <DaybookTable
        companyId={companyId}
        rows={rows ?? []}
        from={period.from}
        to={period.to}
        financialYearStartMonth={company?.financial_year_start_month ?? 4}
        lockedTypes={lockedTypes}
        basePath={basePath}
      />
    </ReportShell>
  );
}
