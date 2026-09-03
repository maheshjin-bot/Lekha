import { createClient } from "@/lib/supabase/server";
import { QuickBilling } from "@/components/pos/QuickBilling";
import {
  buildNumbering,
  type NumberingSettingsRow,
} from "@/lib/numbering/voucher-numbering";

export default async function PosPage({
  params,
}: PageProps<"/[companyId]/pos">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: items }, { data: branches }, { data: cashLedgerId }, { data: priceListItemsRaw }] =
    await Promise.all([
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
      // The company's DEFAULT price list (0147) — same query
      // app/(app)/[companyId]/invoices/new/page.tsx already runs, so a
      // counter sale suggests the same rate a full invoice would for the
      // same item on the same day, instead of always falling back to the
      // item master's flat sale_rate. Every row, unfiltered by date here;
      // QuickBilling itself filters by today's date client-side, the same
      // division of work InvoiceForm uses for the invoice's own date.
      supabase
        .from("price_list_items")
        .select("item_id, price, effective_from, price_lists!inner(is_default)")
        .eq("company_id", companyId)
        .eq("price_lists.is_default", true),
    ]);

  const priceListItems = (priceListItemsRaw ?? []).map((p) => ({
    item_id: p.item_id,
    price: Number(p.price),
    effective_from: p.effective_from,
  }));

  const branch = branches?.[0] ?? null;

  const [{ data: godowns }, { data: revenueLedgerRows }] = await Promise.all([
    branch
      ? supabase
          .from("godowns")
          .select("id, name, is_default")
          .eq("company_id", companyId)
          .eq("branch_id", branch.id)
          .eq("is_active", true)
          .order("is_default", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; name: string; is_default: boolean }[] }),
    // WHICH LEDGER THE TILL CREDITS — migration 1501.
    //
    // This used to be `salesLedgers.find(l => l.name === "Sales Account")
    // ?? salesLedgers[0]` over a query ordered by name, and for any company
    // whose preparer named their own revenue ledgers the find missed and the
    // fallback silently took the alphabetically-first income ledger. In the
    // pilot that was "Discount Received", so a month of counter takings was
    // booked as indirect income. Matching a ledger by an English name is the
    // bug, not the fix — the lesson migration 1200 already paid for.
    //
    // The RPC binds by effective ledger_role instead, returns every income
    // ledger with revenue-from-operations first, and marks the one quick
    // billing would credit: the branch's stored choice, or the single
    // direct-income ledger when there is exactly one, or NOTHING when it is
    // genuinely ambiguous — in which case the operator picks and the till
    // refuses to post until they have.
    branch
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_pos_revenue_ledger_options postdates types/database.types.ts, which this task does not regenerate. Same escape hatch as the numbering call below.
        supabase.rpc("get_pos_revenue_ledger_options" as any, {
          p_company_id: companyId,
          p_branch_id: branch.id,
        })
      : Promise.resolve({ data: null }),
  ]);

  const revenueLedgers = ((revenueLedgerRows ?? []) as unknown as {
    ledger_id: string;
    ledger_name: string;
    group_name: string;
    is_revenue: boolean;
    is_selected: boolean;
  }[]).map((r) => ({
    id: r.ledger_id,
    name: r.ledger_name,
    groupName: r.group_name,
    isRevenue: r.is_revenue,
  }));

  const salesLedgerId =
    ((revenueLedgerRows ?? []) as unknown as { ledger_id: string; is_selected: boolean }[]).find(
      (r) => r.is_selected
    )?.ledger_id ?? null;
  const godown = godowns?.[0] ?? null;

  // The sales voucher type's numbering policy (migration 0725), for THIS
  // branch. Quick billing bills from exactly one branch — `branch` above is
  // branches[0] — so unlike InvoiceForm's page this needs one call, not one
  // per branch, and passes a single TypeNumbering rather than a by-branch map.
  //
  // Why a POS needs this at all: the mode only ever decides whether a SUPPLIED
  // number is ACCEPTED. It never forces a caller to supply one. So a company
  // that set its sales numbering to manual — meaning "we number our own sales
  // documents" — was silently getting app-generated numbers for every counter
  // sale, and one on named series always drew the default series with no way
  // to pick another. Neither was a crash, which is why it went unnoticed.
  //
  // Same `as any` escape hatch, for the same reason, as
  // app/(app)/[companyId]/invoices/new/page.tsx: get_voucher_numbering_settings
  // postdates types/database.types.ts, which this task does not regenerate.
  const { data: numberingRows } = branch
    ? await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        .rpc("get_voucher_numbering_settings" as any, {
          p_company_id: companyId,
          p_branch_id: branch.id,
        })
    : { data: null };
  const salesNumbering = buildNumbering(
    (numberingRows ?? []) as unknown as NumberingSettingsRow[]
  ).sales;

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
        salesLedgers={revenueLedgers}
        salesLedgerId={salesLedgerId}
        cashLedgerId={(cashLedgerId as string | null) ?? null}
        todaySales={(todaySales ?? []) as { id: string; voucher_number: string; total_amount: number; created_at: string }[]}
        priceListItems={priceListItems}
        numbering={salesNumbering}
      />
    </main>
  );
}
