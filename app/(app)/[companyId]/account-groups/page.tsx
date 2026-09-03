import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AccountGroupManager } from "@/components/account-groups/AccountGroupManager";

/*
 * `params` is typed by hand rather than through the generated PageProps helper.
 * PageProps<"/[companyId]/account-groups"> resolves against .next/types, which
 * only learns about a route after `next dev` or `next build` has seen the file
 * — so on a fresh checkout of this branch the helper would not typecheck until
 * something regenerated it. The shape below is what the helper resolves to.
 */
export default async function AccountGroupsPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: groups }, { data: ledgers }] = await Promise.all([
    supabase
      .from("account_groups")
      .select("id, name, nature, normal_balance, ledger_role, parent_group_id, is_system, sort_order")
      .eq("company_id", companyId)
      .order("sort_order"),
    // Counted here rather than with a grouped query because PostgREST cannot
    // group without a view, and a company's ledger list is small enough that
    // one id column costs nothing.
    supabase.from("ledgers").select("group_id").eq("company_id", companyId),
  ]);

  const ledgerCounts: Record<string, number> = {};
  for (const l of ledgers ?? []) {
    ledgerCounts[l.group_id] = (ledgerCounts[l.group_id] ?? 0) + 1;
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Chart of accounts
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        The groups every ledger is filed under. A group decides which statement
        a ledger appears in and which sub-total it is added into — so this is
        the shape of your balance sheet and profit &amp; loss, not just a
        filing scheme.{" "}
        <Link href={`/${companyId}/ledgers`} className="underline">
          Ledgers live here →
        </Link>
      </p>
      <AccountGroupManager
        companyId={companyId}
        groups={groups ?? []}
        ledgerCounts={ledgerCounts}
      />
    </main>
  );
}
