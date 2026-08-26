import { createClient } from "@/lib/supabase/server";
import { StockVerificationManager } from "@/components/stock-verification/StockVerificationManager";

export default async function StockVerificationPage({
  params,
}: PageProps<"/[companyId]/stock-verification">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: modules }, { data: items }, { data: godowns }, { data: batches }] =
    await Promise.all([
      supabase.rpc("get_company_modules", { p_company_id: companyId }),
      supabase
        .from("items")
        .select("id, name, uom, batch_tracking")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .eq("maintain_stock", true)
        .eq("item_type", "goods")
        .order("name"),
      supabase
        .from("godowns")
        .select("id, code, name, branch_id, is_default")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("code"),
      supabase
        .from("item_batches")
        .select("id, item_id, batch_no, expiry_date")
        .eq("company_id", companyId)
        .order("batch_no"),
    ]);

  const inventoryOn = (modules ?? []).some((m) => m.code === "inventory" && m.active);

  // get_stock_verifications (0165) is not yet in the generated
  // database.types.ts — see StockVerificationManager for the fuller note;
  // that file is owned by the integration pass' regeneration, not this task.
  const { data: historyRows } = inventoryOn
    ? await supabase.rpc("get_stock_verifications", { p_company_id: companyId })
    : { data: null };

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Physical Stock Verification
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Count what is actually on the shelf, compare it to what the books
          say, and — only when they differ — post the shortage or excess as
          a stock adjustment, valued at the item&rsquo;s current
          weighted-average rate. A clean count (no variance) is still
          recorded: it is the audit fact that closes Form 3CD Clause 35
          &ldquo;shortage/excess&rdquo; for whatever was actually counted
          this year.
        </p>
      </header>

      {!inventoryOn ? (
        <p className="rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          Inventory is not active for this company. Turn it on in Settings →
          Modules to record stock verifications.
        </p>
      ) : (
        <StockVerificationManager
          companyId={companyId}
          items={items ?? []}
          godowns={godowns ?? []}
          batches={batches ?? []}
          history={(historyRows ?? []) as never}
        />
      )}
    </main>
  );
}
