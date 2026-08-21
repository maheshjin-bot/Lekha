import { createClient } from "@/lib/supabase/server";
import { BatchManager } from "@/components/batches/BatchManager";

export default async function BatchesPage({
  params,
}: PageProps<"/[companyId]/batches">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: lines }, { data: summary }, { data: items }] = await Promise.all([
    supabase.rpc("get_unallocated_stock_lines", { p_company_id: companyId }),
    supabase.rpc("get_batch_stock_summary", { p_company_id: companyId }),
    supabase
      .from("items")
      .select("id, name, uom, batch_tracking")
      .eq("company_id", companyId)
      .neq("batch_tracking", "none")
      .order("name"),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Batches &amp; serials
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          A physical quantity and expiry ledger, tracked separately from the books.
          Tag stock lines with a batch or serial after the fact — nothing here changes
          any amount, ledger or date. Turn tracking on for an item in Items first.
        </p>
      </header>

      <BatchManager
        companyId={companyId}
        unallocatedLines={(lines ?? []) as never}
        batchSummary={(summary ?? []) as never}
        trackedItems={items ?? []}
      />

      <p className="mt-8 text-xs text-ink-faint">
        This is a quantity ledger, not a valuation engine — stock is still costed by
        moving weighted average across the whole item (see Reports → Stock summary);
        batches here don&rsquo;t change that figure. Incoming (purchase/receipt) lines
        can be tagged accurately after receipt. Outgoing (sale/issue) lines are
        necessarily tagged after the fact too, since billing itself doesn&rsquo;t offer a
        batch picker — the &ldquo;unallocated&rdquo; rows above are shown honestly rather
        than hidden, so a partially-tagged ledger never reads as a complete one. See the
        expiry view at Reports → Stock expiry.
      </p>
    </main>
  );
}
