import { createClient } from "@/lib/supabase/server";
import { ManufacturingManager } from "@/components/manufacturing/ManufacturingManager";

export default async function ManufacturingPage({
  params,
}: PageProps<"/[companyId]/manufacturing">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: boms }, { data: items }, { data: branches }, { data: godowns }] = await Promise.all([
    supabase.rpc("get_boms", { p_company_id: companyId }),
    supabase
      .from("items")
      .select("id, name, uom")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("maintain_stock", true)
      .order("name"),
    supabase.from("branches").select("id, code, name").eq("company_id", companyId).eq("is_active", true),
    supabase.from("godowns").select("id, name, is_default").eq("company_id", companyId).eq("is_active", true),
  ]);

  const bomIds = (boms ?? []).map((b) => b.bom_id);
  const { data: components } =
    bomIds.length > 0
      ? await supabase
          .from("bom_components")
          .select("id, bom_id, component_item_id, quantity, items(name, uom)")
          .in("bom_id", bomIds)
          .order("line_order")
      : { data: [] };

  const componentRows = (components ?? []).map((c) => ({
    id: c.id,
    bom_id: c.bom_id,
    component_item_id: c.component_item_id,
    quantity: c.quantity,
    item_name: (c.items as unknown as { name: string; uom: string } | null)?.name ?? "",
    uom: (c.items as unknown as { name: string; uom: string } | null)?.uom ?? "",
  }));

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Manufacturing
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          One recipe per output item. A production run consumes every component at its
          current weighted-average rate and receives the finished item at that cost — an
          internal stock transformation, not a supply, so it posts no P&amp;L impact.
        </p>
      </header>

      <ManufacturingManager
        companyId={companyId}
        boms={(boms ?? []) as never}
        components={componentRows}
        items={items ?? []}
        branches={branches ?? []}
        godowns={godowns ?? []}
      />
    </main>
  );
}
