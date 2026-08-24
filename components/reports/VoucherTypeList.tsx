import Link from "next/link";
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
  eximHubLink,
}: {
  companyId: string;
  basePath: string;
  title: string;
  description: string;
  lockedTypes: string[];
  searchParams: { from?: string; to?: string };
  /** Additive link to the EXIM shipments hub (0119) — set only on the
   * Sales/Purchase Invoices lists, the entry point for a per-voucher
   * shipping-bill/BOE/BRC addendum. Never shown on the Returns lists
   * (credit/debit notes aren't sales/purchase vouchers, so EXIM details
   * can't attach to them). */
  eximHubLink?: boolean;
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
      <p className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3 text-sm text-ink-soft print:hidden">
        <span>{description}</span>
        {eximHubLink && (
          <Link href={`/${companyId}/exim`} className="text-accent underline underline-offset-4">
            EXIM shipments →
          </Link>
        )}
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
