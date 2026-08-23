import { VoucherTypeList } from "@/components/reports/VoucherTypeList";

export default async function SalesInvoicesPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/sales-invoices">) {
  const { companyId } = await params;
  const sp = await searchParams;

  return (
    <VoucherTypeList
      companyId={companyId}
      basePath={`/${companyId}/reports/sales-invoices`}
      title="Sales Invoices"
      description="Every sales invoice in the period — view, edit or delete any one directly."
      lockedTypes={["sales"]}
      searchParams={{
        from: typeof sp.from === "string" ? sp.from : undefined,
        to: typeof sp.to === "string" ? sp.to : undefined,
      }}
    />
  );
}
