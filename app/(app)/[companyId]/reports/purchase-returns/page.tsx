import { VoucherTypeList } from "@/components/reports/VoucherTypeList";

export default async function PurchaseReturnsPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/purchase-returns">) {
  const { companyId } = await params;
  const sp = await searchParams;

  return (
    <VoucherTypeList
      companyId={companyId}
      basePath={`/${companyId}/reports/purchase-returns`}
      title="Purchase Returns"
      description="Debit notes issued against purchase bills in the period."
      lockedTypes={["debit_note"]}
      searchParams={{
        from: typeof sp.from === "string" ? sp.from : undefined,
        to: typeof sp.to === "string" ? sp.to : undefined,
      }}
    />
  );
}
