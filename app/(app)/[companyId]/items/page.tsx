import { createClient } from "@/lib/supabase/server";
import { ItemManager } from "@/components/items/ItemManager";

export default async function ItemsPage({
  params,
}: PageProps<"/[companyId]/items">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: items }, { data: uoms }] = await Promise.all([
    supabase
      .from("items")
      .select(
        "id, code, name, item_type, hsn_sac, uom, maintain_stock, opening_quantity, opening_value, sale_rate, gst_rate_percent, is_active"
      )
      .eq("company_id", companyId)
      .order("name"),
    supabase.from("ref_uom").select("code, name").order("name"),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Items</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Goods carry an HSN and move stock; services carry a SAC and do not. The
        unit comes from the notified UQC list, because a GST return will not
        accept anything else.
      </p>
      <ItemManager companyId={companyId} items={items ?? []} uoms={uoms ?? []} />
    </main>
  );
}
