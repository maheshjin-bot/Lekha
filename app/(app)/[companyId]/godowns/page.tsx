import { createClient } from "@/lib/supabase/server";
import { GodownManager } from "@/components/godowns/GodownManager";

export default async function GodownsPage({
  params,
}: PageProps<"/[companyId]/godowns">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: godowns }, { data: branches }] = await Promise.all([
    supabase
      .from("godowns")
      .select("id, code, name, address, branch_id, is_default, is_active")
      .eq("company_id", companyId)
      .order("code"),
    supabase
      .from("branches")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false }),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Godowns</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Stock locations sit under a branch, so stock can be reported per
        facility — a lender finances the stock at named locations, not the
        company total.
      </p>
      <GodownManager
        companyId={companyId}
        godowns={godowns ?? []}
        branches={branches ?? []}
      />
    </main>
  );
}
