import { createClient } from "@/lib/supabase/server";
import { PriceListManager } from "@/components/price-lists/PriceListManager";

export default async function PriceListsPage({
  params,
}: PageProps<"/[companyId]/price-lists">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: priceLists }, { data: priceListItems }, { data: items }] = await Promise.all([
    supabase
      .from("price_lists")
      .select("id, name, is_default, is_active")
      .eq("company_id", companyId)
      .order("is_default", { ascending: false })
      .order("name"),
    supabase
      .from("price_list_items")
      .select("id, price_list_id, item_id, price, effective_from")
      .eq("company_id", companyId)
      .order("effective_from", { ascending: false }),
    supabase
      .from("items")
      .select("id, name, uom")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Price lists</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        A simple rate per item, effective from a date — the default list is what
        the invoice line-item screen suggests when you pick an item, always still
        editable on the line itself.
      </p>
      <PriceListManager
        companyId={companyId}
        items={
          (items ?? []).map((i) => ({ id: i.id, name: i.name, uom: i.uom }))
        }
        priceLists={priceLists ?? []}
        priceListItems={
          (priceListItems ?? []).map((p) => ({
            id: p.id,
            price_list_id: p.price_list_id,
            item_id: p.item_id,
            price: Number(p.price),
            effective_from: p.effective_from,
          }))
        }
      />
    </main>
  );
}
