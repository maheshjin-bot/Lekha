import { createClient } from "@/lib/supabase/server";
import { QuickBilling } from "@/components/pos/QuickBilling";

export default async function PosPage({
  params,
}: PageProps<"/[companyId]/pos">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: items }, { data: branches }, { data: cashLedgerId }] = await Promise.all([
    supabase
      .from("items")
      .select("id, name, code, uom, sale_rate, gst_rate_percent")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("branches")
      .select("id, code, name, state_code")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false }),
    // Idempotent — creates the walk-in "Cash Sales" ledger on first visit,
    // reuses it on every visit after. See migration 0066 for why this can't
    // just assume a ledger already exists.
    supabase.rpc("ensure_cash_sales_ledger", { p_company_id: companyId }),
  ]);

  const branch = branches?.[0] ?? null;

  const [{ data: godowns }, { data: salesLedgers }] = await Promise.all([
    branch
      ? supabase
          .from("godowns")
          .select("id, name, is_default")
          .eq("company_id", companyId)
          .eq("branch_id", branch.id)
          .eq("is_active", true)
          .order("is_default", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; name: string; is_default: boolean }[] }),
    supabase
      .from("ledgers")
      .select("id, name, account_groups!inner(ledger_role)")
      .eq("company_id", companyId)
      .eq("account_groups.ledger_role", "income")
      .order("name"),
  ]);

  const salesLedger =
    salesLedgers?.find((l) => l.name === "Sales Account") ?? salesLedgers?.[0] ?? null;
  const godown = godowns?.[0] ?? null;

  const today = new Date().toISOString().slice(0, 10);
  const { data: todaySales } =
    cashLedgerId && companyId
      ? await supabase
          .from("vouchers")
          .select("id, voucher_number, total_amount, created_at")
          .eq("company_id", companyId)
          .eq("voucher_type", "sales")
          .eq("party_ledger_id", cashLedgerId as string)
          .eq("voucher_date", today)
          .eq("is_deleted", false)
          .order("created_at", { ascending: false })
      : { data: [] };

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Quick billing
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Counter sale — search or tap an item, take payment, done. Posts as an ordinary
          sales invoice against a walk-in &ldquo;Cash Sales&rdquo; party; GST and TCS (if
          active) are computed the same way a full invoice computes them.
        </p>
      </header>

      <QuickBilling
        companyId={companyId}
        items={items ?? []}
        branch={branch}
        godown={godown}
        salesLedgerId={salesLedger?.id ?? null}
        cashLedgerId={(cashLedgerId as string | null) ?? null}
        todaySales={(todaySales ?? []) as { id: string; voucher_number: string; total_amount: number; created_at: string }[]}
      />
    </main>
  );
}
