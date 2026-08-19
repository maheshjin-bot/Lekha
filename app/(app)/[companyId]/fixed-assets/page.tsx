import { createClient } from "@/lib/supabase/server";
import { FixedAssetManager } from "@/components/fixed-assets/FixedAssetManager";

export default async function FixedAssetsPage({
  params,
}: PageProps<"/[companyId]/fixed-assets">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: categories }, { data: blocks }, { data: register }] = await Promise.all([
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
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Fixed assets</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Book depreciation, one asset at a time. The Schedule II category sets
        the useful life used here; the Income-tax block sets the WDV rate used
        on the tax depreciation report — the two run independently.
      </p>
      <FixedAssetManager
        companyId={companyId}
        assets={register ?? []}
        categories={categories ?? []}
        blocks={blocks ?? []}
      />
    </main>
  );
}
