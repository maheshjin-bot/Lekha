import { createClient } from "@/lib/supabase/server";
import { LedgerManager } from "@/components/ledgers/LedgerManager";

export default async function LedgersPage({
  params,
}: PageProps<"/[companyId]/ledgers">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: ledgers }, { data: groups }] = await Promise.all([
    supabase
      .from("ledgers")
      .select("id, name, group_id, opening_balance_amount, opening_balance_type, is_active")
      .eq("company_id", companyId)
      .order("name"),
    supabase
      .from("account_groups")
      .select("id, name, nature, ledger_role, parent_group_id")
      .eq("company_id", companyId)
      .order("sort_order"),
  ]);

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
      />
    </main>
  );
}
