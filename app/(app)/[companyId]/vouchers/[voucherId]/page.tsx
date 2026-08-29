import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { VoucherDetailView } from "@/components/vouchers/VoucherDetailView";
import { isInvoiceType } from "@/lib/utils/voucher";

export default async function VoucherDetailPage({
  params,
}: PageProps<"/[companyId]/vouchers/[voucherId]">) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select(
      "id, voucher_number, voucher_type, voucher_date, narration, reference_number, total_amount, financial_year_label, txn_currency, exchange_rate, branch_id, approval_status, created_by, is_deleted"
    )
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!voucher) notFound();

  const isInvoice = isInvoiceType(voucher.voucher_type);

  const [{ data: entries }, { data: branch }, { data: user }, { data: membership }, { data: items }] =
    await Promise.all([
      supabase
        .from("voucher_entries")
        .select("id, debit_amount, credit_amount, narration, line_order, ledgers(name)")
        .eq("voucher_id", voucherId)
        .order("line_order"),
      supabase
        .from("branches")
        .select("code, name")
        .eq("id", voucher.branch_id)
        .maybeSingle(),
      supabase.auth.getUser().then((r) => ({ data: r.data.user })),
      supabase
        .from("company_members")
        .select("role")
        .eq("company_id", companyId)
        .then((r) => ({ data: r.data })),
      // Invoices carry item lines alongside their ledger entries — shown as
      // its own table, since "what was sold" and "how it posted" are both
      // real information and neither substitutes for the other.
      isInvoice
        ? supabase
            .from("voucher_items")
            .select("item_id, quantity, uom, rate, amount, hsn_sac, description, line_order, items(name)")
            .eq("voucher_id", voucherId)
            .order("line_order")
        : Promise.resolve({ data: null }),
    ]);

  // Maker-checker: only an admin who didn't create this voucher can approve
  // it — the RPC (0028) enforces this server-side too, this just decides
  // what to show. company_members RLS already scopes rows to the caller's
  // own membership, so a single-row select for "my role here" needs no
  // extra user_id filter.
  const myRole = membership?.[0]?.role ?? null;
  const isCreator = user?.id === voucher.created_by;
  const isPending = voucher.approval_status === "pending";
  const canApprove = isPending && myRole === "admin" && !isCreator;
  const disabledReason = !isPending
    ? undefined
    : isCreator
      ? "You created this voucher — a different admin must approve it."
      : myRole !== "admin"
        ? "Only a company admin can approve vouchers."
        : undefined;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href={`/${companyId}/reports/daybook`}
        className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink print:hidden"
      >
        ← Daybook
      </Link>

      <VoucherDetailView
        companyId={companyId}
        voucherId={voucherId}
        voucherNumber={voucher.voucher_number}
        voucherType={voucher.voucher_type}
        voucherDate={voucher.voucher_date}
        branchLabel={branch ? `${branch.code} ${branch.name}` : null}
        totalAmount={Number(voucher.total_amount)}
        txnCurrency={voucher.txn_currency}
        exchangeRate={voucher.exchange_rate}
        narration={voucher.narration}
        referenceNumber={voucher.reference_number}
        financialYearLabel={voucher.financial_year_label}
        isPending={isPending}
        isDeleted={voucher.is_deleted}
        canApprove={canApprove}
        disabledReason={disabledReason}
        lines={entries ?? []}
        items={items ?? undefined}
      />
    </main>
  );
}
