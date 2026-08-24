import { createClient } from "@/lib/supabase/server";
import { DeliveryChallanManager } from "@/components/delivery-challans/DeliveryChallanManager";

export default async function DeliveryChallansPage({
  params,
}: PageProps<"/[companyId]/delivery-challans">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: challans }, { data: items }, { data: ledgers }, { data: branches }, { data: godowns }] =
    await Promise.all([
      supabase.rpc("get_delivery_challans", { p_company_id: companyId }),
      supabase
        .from("items")
        .select("id, name, uom, gst_rate_percent")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .eq("maintain_stock", true)
        .order("name"),
      supabase
        .from("ledgers")
        .select("id, name, account_groups!inner(ledger_role)")
        .eq("company_id", companyId)
        .in("account_groups.ledger_role", ["debtor", "creditor"])
        .order("name"),
      supabase.from("branches").select("id, code, name").eq("company_id", companyId).eq("is_active", true),
      supabase.from("godowns").select("id, name, is_default, branch_id").eq("company_id", companyId).eq("is_active", true),
    ]);

  const ledgerRows = (ledgers ?? []).map((l) => ({ id: l.id, name: l.name }));

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Delivery challans
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Rule 55 CGST Rules — goods moved without a tax invoice: sent on approval or
          sale-or-return, SKD/CKD consignments, transfer between your own branches (same
          GST registration only), exhibition, or repair. A real stock movement, but not a
          supply, so it posts no P&amp;L or party-ledger impact. Record receipt against
          each challan to track it from dispatch to full or partial acknowledgment.
        </p>
      </header>

      <DeliveryChallanManager
        companyId={companyId}
        challans={(challans ?? []) as never}
        items={items ?? []}
        ledgers={ledgerRows}
        branches={branches ?? []}
        godowns={godowns ?? []}
      />
    </main>
  );
}
