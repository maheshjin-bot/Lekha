import { createClient } from "@/lib/supabase/server";
import {
  DiscountAgreementManager,
  type DiscountAgreement,
  type DiscountAgreementLink,
  type LinkableLedger,
  type LinkableVoucher,
  type LinkableVoucherItem,
} from "@/components/discount-agreements/DiscountAgreementManager";

export default async function DiscountAgreementsPage({
  params,
}: PageProps<"/[companyId]/discount-agreements">) {
  const { companyId } = await params;
  const supabase = await createClient();

  // discount_agreements / discount_agreement_links are brand new (0431) —
  // types/database.types.ts (off-limits to this task, owned by the
  // integration pass' regeneration) doesn't know about them yet, hence the
  // `as any` on .from() and `as unknown as` on the results below — the same
  // escape hatch already used by components/sbo/SBOManager.tsx and this
  // session's other new-table screens. RLS and the runtime shape are both
  // verified live (see the structured report).
  const [
    { data: agreements },
    { data: links },
    { data: ledgers },
    { data: vouchers },
    { data: discountedItems },
  ] = await Promise.all([
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .from("discount_agreements" as any)
      .select("id, party_ledger_id, terms, standard_discount_percent, agreed_date, is_active")
      .eq("company_id", companyId)
      .order("is_active", { ascending: false })
      .order("agreed_date", { ascending: false }),
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .from("discount_agreement_links" as any)
      .select("id, agreement_id, voucher_id, voucher_item_id, original_invoice_voucher_id, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false }),
    supabase
      .from("ledgers")
      .select("id, name, ledger_role, party_type")
      .eq("company_id", companyId)
      // Real seeded data (confirmed live) mostly leaves ledger_role null on
      // customer ledgers and relies on party_type instead — InvoiceForm's
      // own picker filters on ledger_role alone (roles: ["debtor",
      // "cash_bank"]), which this query also honours, OR'd with party_type
      // so a party a discount agreement actually exists for isn't silently
      // missing from this picker.
      .or("ledger_role.in.(debtor,cash_bank),party_type.in.(customer,both)")
      .order("name"),
    supabase
      .from("vouchers")
      .select("id, voucher_number, voucher_date, voucher_type, party_ledger_id, total_amount")
      .eq("company_id", companyId)
      .eq("is_deleted", false)
      .in("voucher_type", ["sales", "credit_note"])
      .order("voucher_date", { ascending: false })
      .limit(500),
    supabase
      .from("voucher_items")
      .select("id, voucher_id, discount_percent, discount_amount, amount, items(name), description")
      .eq("company_id", companyId)
      .gt("discount_percent", 0)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Discount agreements</h1>
      <p className="mt-1.5 max-w-3xl text-sm text-ink-soft">
        Sec 15(3)(b) CGST Act lets a <em>post-supply</em> discount be excluded from taxable value
        only if it traces to a written understanding agreed at or before the original sale,
        specifically linked to the invoice(s) it covers. Record that understanding here, then link
        it — at the time a credit note or a discounted invoice line is entered — to the specific
        agreement it comes from. Linking is always a manual pick, never automatic matching.
      </p>
      <p className="mt-1 max-w-3xl text-xs text-ink-faint">
        See the{" "}
        <a
          href={`/${companyId}/reports/discount-agreement-coverage`}
          className="text-accent underline underline-offset-4"
        >
          coverage report
        </a>{" "}
        for which discounts already given are, and are not, backed by a link recorded here.
      </p>

      <DiscountAgreementManager
        companyId={companyId}
        agreements={(agreements ?? []) as unknown as DiscountAgreement[]}
        links={(links ?? []) as unknown as DiscountAgreementLink[]}
        ledgers={(ledgers ?? []) as LinkableLedger[]}
        vouchers={(vouchers ?? []) as unknown as LinkableVoucher[]}
        discountedItems={
          ((discountedItems ?? []) as unknown as Array<{
            id: string;
            voucher_id: string;
            discount_percent: number;
            discount_amount: number;
            amount: number;
            description: string | null;
            items: { name: string } | null;
          }>).map((r) => ({
            id: r.id,
            voucher_id: r.voucher_id,
            discount_percent: Number(r.discount_percent),
            discount_amount: Number(r.discount_amount),
            amount: Number(r.amount),
            item_name: r.items?.name ?? r.description ?? "Line item",
          })) as LinkableVoucherItem[]
        }
      />
    </main>
  );
}
