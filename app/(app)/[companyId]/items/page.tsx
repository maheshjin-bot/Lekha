import { createClient } from "@/lib/supabase/server";
import { ItemManager } from "@/components/items/ItemManager";
import type { ItemEditContext } from "@/components/items/itemFields";

export default async function ItemsPage({
  params,
}: PageProps<"/[companyId]/items">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [
    { data: items },
    { data: uoms },
    { data: tcsSections },
    { data: uomConversions },
    { data: editContexts },
    { data: membership },
    { data: modules },
  ] = await Promise.all([
    supabase
      .from("items")
      // Every column the edit panel can write is selected here — a field that
      // is editable but not loaded would silently save its default back over
      // whatever was there.
      .select(
        "id, code, name, item_type, hsn_sac, uom, category, maintain_stock, opening_quantity, opening_value, sale_rate, purchase_rate, reorder_level, gst_rate_percent, cess_rate_percent, supply_nature, itc_eligibility, itc_blocked_clause, default_tcs_section, is_rcm_applicable, batch_tracking, is_active"
      )
      .eq("company_id", companyId)
      // Inactive items stay in this list on purpose: this is the master, the
      // only screen from which one can be brought back.
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
    // get_item_edit_context is new (migration 1370) and
    // types/database.types.ts — owned by the integration pass, not regenerated
    // by this task against a shared database — doesn't know it yet, hence the
    // disabled rule. Purely a compile-time typing gap; the row shape is
    // verified live against the function's own return table.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    supabase.rpc("get_item_edit_context" as any, { p_company_id: companyId }),
    // Opening quantity/value are admin-only in the database
    // (protect_item_master_fields, 1370, mirroring
    // protect_ledger_financial_fields). Read the role so the field looks
    // locked rather than failing on save. company_members_read restricts this
    // to the caller's own row.
    supabase.from("company_members").select("role").eq("company_id", companyId),
    // batch_tracking is only worth offering when the module that surfaces
    // /batches, Reports → Stock expiry and the batch half of stock
    // verification is actually switched on for this company.
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
  ]);

  const isAdmin = (membership?.[0]?.role ?? null) === "admin";
  const batchModuleActive =
    (modules ?? []).some((m) => m.code === "batch_serial" && m.active) ?? false;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Items</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Goods carry an HSN and move stock; services carry a SAC and do not. The
        unit comes from the notified UQC list, because a GST return will not
        accept anything else. Edit an item to correct its HSN, rate or opening,
        to switch batch or serial tracking on, or to retire it from the pickers
        without losing its history.
      </p>
      <ItemManager
        companyId={companyId}
        items={items ?? []}
        uoms={uoms ?? []}
        tcsSections={tcsSections ?? []}
        uomConversions={uomConversions ?? []}
        editContexts={(editContexts ?? []) as unknown as ItemEditContext[]}
        isAdmin={isAdmin}
        batchModuleActive={batchModuleActive}
      />
    </main>
  );
}
