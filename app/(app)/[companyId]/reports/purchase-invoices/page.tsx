import { VoucherTypeList } from "@/components/reports/VoucherTypeList";

export default async function PurchaseInvoicesPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/purchase-invoices">) {
  const { companyId } = await params;
  const sp = await searchParams;

  return (
    <VoucherTypeList
      companyId={companyId}
      basePath={`/${companyId}/reports/purchase-invoices`}
      title="Purchase Invoices"
      description="Every purchase bill in the period — view, edit or delete any one directly."
      lockedTypes={["purchase"]}
      searchParams={{
        from: typeof sp.from === "string" ? sp.from : undefined,
        to: typeof sp.to === "string" ? sp.to : undefined,
      }}
    />
  );
}
