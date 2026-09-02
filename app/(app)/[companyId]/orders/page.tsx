import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { OrderManager } from "@/components/orders/OrderManager";

export default async function OrdersPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/orders">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const orderType: "sales" | "purchase" = sp.type === "purchase" ? "purchase" : "sales";
  const ledgerRole = orderType === "sales" ? "debtor" : "creditor";

  // The voucher types that can actually FULFIL an order, which is a narrower
  // set than mark_order_converted itself accepts (it takes any voucher of the
  // company). A sale is fulfilled by the invoice, or by the delivery challan
  // the goods moved out on ahead of it under Rule 55(4); a purchase order by
  // the supplier's bill. Money vouchers are not fulfilment — a receipt against
  // a sales order settles the invoice, it does not deliver the goods.
  const fulfilmentTypes =
    orderType === "sales" ? ["sales", "delivery_challan_out"] : ["purchase"];

  const [{ data: orders }, { data: items }, { data: ledgers }, { data: branches }, { data: vouchers }] = await Promise.all([
    supabase.rpc("get_orders", { p_company_id: companyId, p_order_type: orderType }),
    supabase
      .from("items")
      .select("id, name, uom, sale_rate, purchase_rate")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("ledgers")
      .select("id, name, account_groups!inner(ledger_role)")
      .eq("company_id", companyId)
      .eq("account_groups.ledger_role", ledgerRole)
      .order("name"),
    supabase.from("branches").select("id, code, name").eq("company_id", companyId).eq("is_active", true),
    // Candidates for the "Fulfilled via" link. Capped and most-recent-first
    // because an order is linked to a voucher raised around the same time —
    // the screen says so, so a preparer hunting an older one knows why it is
    // not on offer rather than assuming the link is broken.
    supabase
      .from("vouchers")
      .select("id, voucher_number, voucher_date, voucher_type, total_amount")
      .eq("company_id", companyId)
      .eq("is_deleted", false)
      .in("voucher_type", fulfilmentTypes)
      .order("voucher_date", { ascending: false })
      .limit(200),
  ]);

  const ledgerRows = (ledgers ?? []).map((l) => ({ id: l.id, name: l.name }));

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          {orderType === "sales" ? "Sales orders" : "Purchase orders"}
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          A quotation or commitment — nothing here touches the ledger. Once you raise the
          actual invoice separately, mark the order fulfilled and link that voucher to it.
        </p>
        <div className="mt-3 flex gap-2 text-sm">
          <Link
            href="?type=sales"
            className={
              "rounded-md border px-2.5 py-1 " +
              (orderType === "sales"
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            Sales
          </Link>
          <Link
            href="?type=purchase"
            className={
              "rounded-md border px-2.5 py-1 " +
              (orderType === "purchase"
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            Purchase
          </Link>
        </div>
      </header>

      <OrderManager
        companyId={companyId}
        orders={orders ?? []}
        items={items ?? []}
        ledgers={ledgerRows}
        branches={branches ?? []}
        vouchers={(vouchers ?? []).map((v) => ({
          id: v.id,
          voucher_number: v.voucher_number,
          voucher_date: v.voucher_date,
          voucher_type: v.voucher_type,
          total_amount: Number(v.total_amount),
        }))}
        orderType={orderType}
      />
    </main>
  );
}
