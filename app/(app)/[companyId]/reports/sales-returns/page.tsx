import { VoucherTypeList } from "@/components/reports/VoucherTypeList";

export default async function SalesReturnsPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/sales-returns">) {
  const { companyId } = await params;
  const sp = await searchParams;

  return (
    <VoucherTypeList
      companyId={companyId}
      basePath={`/${companyId}/reports/sales-returns`}
      title="Sales Returns"
      description="Credit notes issued against sales invoices in the period."
      lockedTypes={["credit_note"]}
      einvoiceHubLink
      searchParams={{
        from: typeof sp.from === "string" ? sp.from : undefined,
        to: typeof sp.to === "string" ? sp.to : undefined,
      }}
    />
  );
}
