import { createClient } from "@/lib/supabase/server";
import { ItemManager } from "@/components/items/ItemManager";

export default async function ItemsPage({
  params,
}: PageProps<"/[companyId]/items">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: items }, { data: uoms }, { data: tcsSections }, { data: uomConversions }, { data: usageRows }, { data: godowns }] =
    await Promise.all([
      supabase
        .from("items")
        .select(
          "id, code, name, item_type, hsn_sac, uom, maintain_stock, opening_quantity, opening_value, opening_godown_id, sale_rate, purchase_rate, gst_rate_percent, cess_rate_percent, supply_nature, itc_blocked_clause, default_tcs_section, is_rcm_applicable, is_active, batch_tracking"
        )
        .eq("company_id", companyId)
        .order("name"),
      supabase.from("ref_uom").select("code, name").order("name"),
      supabase
        .from("ref_tcs_sections")
        .select("section_code, description, rate_percent")
        .eq("is_active", true)
        .order("sort_order"),
      // Alternate-unit conversions (0121) — additive to the item master, one
      // company-wide fetch filtered client-side per item in ItemManager.
      supabase
        .from("item_uom_conversions")
        .select("id, item_id, alternate_uom, conversion_factor, is_purchase_uom, is_sales_uom")
        .eq("company_id", companyId)
        .order("alternate_uom"),
      // 1840: which items already carry voucher history. item_type,
      // maintain_stock and uom are refused on these by the DB itself
      // (app_private.protect_item_master_fields) — fetched here only so the
      // edit form can disable them up front instead of the preparer hitting
      // that refusal after filling in the rest of the form.
      supabase.from("voucher_items").select("item_id").eq("company_id", companyId),
      // 2210: only needed to ask "which godown?" when opening stock is being
      // entered on a NEW item and there's more than one to choose from —
      // see ItemManager's create form.
      supabase.from("godowns").select("id, name, is_default").eq("company_id", companyId).eq("is_active", true).order("is_default", { ascending: false }),
    ]);

  const usedItemIds = Array.from(new Set((usageRows ?? []).map((r) => r.item_id)));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Items</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Goods carry an HSN and move stock; services carry a SAC and do not. The
        unit comes from the notified UQC list, because a GST return will not
        accept anything else.
      </p>
      <ItemManager
        companyId={companyId}
        items={items ?? []}
        uoms={uoms ?? []}
        tcsSections={tcsSections ?? []}
        uomConversions={uomConversions ?? []}
        usedItemIds={usedItemIds}
        godowns={godowns ?? []}
      />
    </main>
  );
}
