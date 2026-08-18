import { createClient } from "@/lib/supabase/server";
import { LedgerManager } from "@/components/ledgers/LedgerManager";

export default async function LedgersPage({
  params,
}: PageProps<"/[companyId]/ledgers">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: ledgers }, { data: groups }, { data: tdsSections }, { data: modules }] =
    await Promise.all([
      supabase
        .from("ledgers")
        .select(
          "id, name, group_id, opening_balance_amount, opening_balance_type, is_active, is_tds_deductee, default_tds_section"
        )
        .eq("company_id", companyId)
        .order("name"),
      supabase
        .from("account_groups")
        .select("id, name, nature, ledger_role, parent_group_id")
        .eq("company_id", companyId)
        .order("sort_order"),
      supabase
        .from("ref_tds_sections")
        .select("section_code, description, rate_percent")
        .eq("is_active", true)
        .order("sort_order"),
      supabase.rpc("get_company_modules", { p_company_id: companyId }),
    ]);

  const tdsOn = (modules ?? []).some((m) => m.code === "tds" && m.active);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Ledgers</h1>
      <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
        Every posting lands in a ledger, and every ledger belongs to a group.
        The group decides how it appears in the statements.
      </p>
      <LedgerManager
        companyId={companyId}
        initialLedgers={ledgers ?? []}
        groups={groups ?? []}
        tdsSections={tdsSections ?? []}
        tdsOn={tdsOn}
      />
    </main>
  );
}
