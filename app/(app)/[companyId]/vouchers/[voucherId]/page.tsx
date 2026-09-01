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

  type VoucherRow = {
    id: string;
    voucher_number: string;
    voucher_type: string;
    voucher_date: string;
    narration: string | null;
    reference_number: string | null;
    total_amount: number;
    financial_year_label: string;
    txn_currency: string;
    exchange_rate: number;
    branch_id: string;
    approval_status: string;
    created_by: string | null;
    is_deleted: boolean;
  };
  const BASE_COLUMNS =
    "id, voucher_number, voucher_type, voucher_date, narration, reference_number, total_amount, financial_year_label, txn_currency, exchange_rate, branch_id, approval_status, created_by, is_deleted";

  // self_approved (migration 1030) may not exist yet on whatever database
  // this is pointed at — this repo is applied to asynchronously by whoever
  // next has a live connector, not necessarily by the session that wrote
  // the migration. Selecting a column Postgres doesn't have errors the
  // WHOLE query (PostgREST doesn't partially fail), which — with the error
  // silently discarded, as this query originally did — turned into every
  // voucher on the page 404ing, not just this one field coming back empty.
  // Try the enriched select first; fall back to the base columns the
  // instant it errors, so this page works against either schema and
  // upgrades itself automatically once 1030 is actually live, no code
  // change needed then.
  let voucher: VoucherRow | null = null;
  let selfApproved = false;

  const enriched = await supabase
    .from("vouchers")
    .select(`${BASE_COLUMNS}, self_approved`)
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!enriched.error && enriched.data) {
    const { self_approved, ...rest } = enriched.data;
    voucher = rest as VoucherRow;
    selfApproved = Boolean(self_approved);
  } else {
    const base = await supabase
      .from("vouchers")
      .select(BASE_COLUMNS)
      .eq("id", voucherId)
      .eq("company_id", companyId)
      .maybeSingle();
    voucher = base.data as VoucherRow | null;
  }

  if (!voucher) notFound();

  const isInvoice = isInvoiceType(voucher.voucher_type);

  // Needed before the Promise.all below, not inside it — company_members_read
  // (0003) is `is_company_member(company_id)`, which lets any active member
  // read every member row for the company, not just their own; without an
  // explicit `.eq("user_id", user.id)` the row returned for "my role here"
  // could belong to a co-worker instead of the signed-in user.
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  const [{ data: entries }, { data: branch }, { data: membership }, { data: activeAdmins }, { data: items }] =
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
      user
        ? supabase
            .from("company_members")
            .select("role")
            .eq("company_id", companyId)
            .eq("user_id", user.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // How many active admins this company has RIGHT NOW — the same live
      // count approve_voucher (1030) recomputes on every call.
      supabase
        .from("company_members")
        .select("id")
        .eq("company_id", companyId)
        .eq("role", "admin")
        .eq("status", "active"),
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
  // what to show. EXCEPTION (1030): a company with fewer than 2 active
  // admins has no possible second checker, so its sole admin may approve
  // their own voucher — recomputed live from company_members here, exactly
  // as the RPC recomputes it on every call.
  const myRole = membership?.role ?? null;
  const isAdmin = myRole === "admin";
  const isCreator = user?.id === voucher.created_by;
  const isPending = voucher.approval_status === "pending";
  const activeAdminCount = activeAdmins?.length ?? 0;
  const soloSelfApprove = isPending && isAdmin && isCreator && activeAdminCount < 2;
  const canApprove = isPending && isAdmin && (!isCreator || soloSelfApprove);
  const disabledReason = !isPending
    ? undefined
    : isCreator && !soloSelfApprove
      ? "You created this voucher — a different admin must approve it."
      : !isAdmin
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
        soloAdminApproval={soloSelfApprove}
        isSelfApproved={selfApproved}
        lines={entries ?? []}
        items={items ?? undefined}
      />
    </main>
  );
}
