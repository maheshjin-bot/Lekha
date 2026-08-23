import { createClient } from "@/lib/supabase/server";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell } from "@/components/reports/ReportShell";
import { DaybookTable } from "@/components/reports/DaybookTable";

export default async function DaybookPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/daybook">) {
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

  const { data: rows, error } = await supabase.rpc("get_daybook", {
    p_company_id: companyId,
    p_from: period.from,
    p_to: period.to,
  });

  return (
    <ReportShell title="Daybook" period={period.label}>
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
      />
    </ReportShell>
  );
}
