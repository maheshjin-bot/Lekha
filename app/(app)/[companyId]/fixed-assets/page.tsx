import { createClient } from "@/lib/supabase/server";
import { FixedAssetManager } from "@/components/fixed-assets/FixedAssetManager";

export default async function FixedAssetsPage({
  params,
}: PageProps<"/[companyId]/fixed-assets">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: categories }, { data: blocks }, { data: register }, { data: docs }] =
    await Promise.all([
      supabase
        .from("ref_depreciation_categories")
        .select("category_code, description, useful_life_years")
        .eq("is_active", true)
        .order("sort_order"),
      supabase
        .from("ref_depreciation_blocks_it")
        .select("block_code, description, rate_percent")
        .eq("is_active", true)
        .order("sort_order"),
      supabase.rpc("get_fixed_asset_register", { p_company_id: companyId }),
      // A purchase invoice, warranty card or insurance policy against a real
      // asset — DocumentAttachments (0060) was already built entity-generic
      // for exactly this call site; nothing wired it in until now.
      supabase
        .from("documents")
        .select("id, storage_path, file_name, mime_type, size_bytes, created_at, entity_id")
        .eq("company_id", companyId)
        .eq("entity_type", "fixed_asset"),
    ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Fixed assets</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Book depreciation, one asset at a time. The Schedule II category sets
        the useful life used here; the Income-tax block sets the WDV rate used
        on the tax depreciation report — the two run independently.
      </p>
      <FixedAssetManager
        companyId={companyId}
        assets={register ?? []}
        categories={categories ?? []}
        blocks={blocks ?? []}
        docs={docs ?? []}
      />
    </main>
  );
}
