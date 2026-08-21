import { createClient } from "@/lib/supabase/server";
import { BudgetManager } from "@/components/budgets/BudgetManager";

export default async function BudgetsPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/budgets">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: budgets } = await supabase
    .from("budgets")
    .select("id, name, fy_start, fy_end, is_active")
    .eq("company_id", companyId)
    .order("fy_start", { ascending: false });

  const requestedId = typeof sp.budget === "string" ? sp.budget : undefined;
  const selectedBudget =
    (budgets ?? []).find((b) => b.id === requestedId) ??
    (budgets ?? []).find((b) => b.is_active) ??
    (budgets ?? [])[0] ??
    null;

  // Every P&L ledger of the company — the grid's rows. A ledger not yet
  // budgeted still appears, with empty cells, so setting a first-time figure
  // is the same action as revising one.
  const { data: ledgers } = await supabase
    .from("ledgers")
    .select("id, name, group_id, account_groups!inner(nature)")
    .eq("company_id", companyId)
    .in("account_groups.nature", [
      "direct_income",
      "indirect_income",
      "direct_expense",
      "indirect_expense",
    ])
    .order("name");

  const ledgerRows = (ledgers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    nature: (l as unknown as { account_groups: { nature: string } }).account_groups.nature,
  }));

  let initialLines: Record<string, Record<string, number>> = {};
  if (selectedBudget) {
    const { data: existingLines } = await supabase
      .from("budget_lines")
      .select("ledger_id, period_month, amount")
      .eq("budget_id", selectedBudget.id);

    initialLines = (existingLines ?? []).reduce(
      (acc, row) => {
        acc[row.ledger_id] = acc[row.ledger_id] ?? {};
        acc[row.ledger_id][row.period_month] = Number(row.amount);
        return acc;
      },
      {} as Record<string, Record<string, number>>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Budgets
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Plan a monthly figure per profit &amp; loss ledger, then compare it against what
          actually posted at Reports → Budget variance.
        </p>
      </header>

      <BudgetManager
        companyId={companyId}
        budgets={budgets ?? []}
        ledgers={ledgerRows}
        selectedBudget={selectedBudget}
        initialLines={initialLines}
      />
    </main>
  );
}
