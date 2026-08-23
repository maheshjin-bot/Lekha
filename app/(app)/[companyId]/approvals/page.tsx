import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { ApproveVoucherButton } from "@/components/vouchers/ApproveVoucherButton";

const TYPE_LABEL: Record<string, string> = {
  receipt: "Receipt",
  payment: "Payment",
  contra: "Contra",
  journal: "Journal",
  sales: "Sales",
  purchase: "Purchase",
  credit_note: "Credit note",
  debit_note: "Debit note",
  branch_transfer: "Branch transfer",
  stock_journal: "Stock journal",
};

/**
 * Every voucher created after 0028 starts life here — a non-gating audit
 * queue, not a hold: nothing on this list is blocked from affecting the
 * books, it's just waiting for a second pair of eyes. Maker-checker means
 * the creator's own row shows why they can't clear it themselves, rather
 * than just being hidden — the artifact's restraint principle is about what
 * moves, not about hiding state.
 */
export default async function ApprovalsPage({
  params,
}: PageProps<"/[companyId]/approvals">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: vouchers }, { data: user }, { data: membership }] = await Promise.all([
    supabase
      .from("vouchers")
      .select("id, voucher_number, voucher_type, voucher_date, total_amount, created_by")
      .eq("company_id", companyId)
      .eq("is_deleted", false)
      .eq("approval_status", "pending")
      .order("voucher_date", { ascending: false }),
    supabase.auth.getUser().then((r) => ({ data: r.data.user })),
    supabase
      .from("company_members")
      .select("role")
      .eq("company_id", companyId)
      .then((r) => ({ data: r.data })),
  ]);

  const myRole = membership?.[0]?.role ?? null;
  const isAdmin = myRole === "admin";
  const rows = vouchers ?? [];

  // created_by's profile name, in one batched lookup rather than N.
  const creatorIds = [...new Set(rows.map((v) => v.created_by).filter(Boolean))] as string[];
  const { data: profiles } = creatorIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", creatorIds)
    : { data: [] as { id: string; full_name: string | null }[] };
  const creatorName = (id: string | null) =>
    (id && profiles?.find((p) => p.id === id)?.full_name) || "—";

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Approvals
      </h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        {rows.length} voucher{rows.length === 1 ? "" : "s"} waiting on a second admin to
        confirm.
      </p>

      <div className="mt-6">
        {rows.length === 0 ? (
          <EmptyState>Nothing pending — every voucher here has been reviewed.</EmptyState>
        ) : (
          <TableContainer>
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr>
                  <th className={th}>Voucher</th>
                  <th className={th}>Type</th>
                  <th className={th}>Date</th>
                  <th className={th}>Created by</th>
                  <th className={th + " text-right"}>Amount</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const isCreator = user?.id === v.created_by;
                  const canApprove = isAdmin && !isCreator;
                  return (
                    <tr key={v.id}>
                      <td className={td + " font-mono text-xs"}>
                        <Link
                          href={`/${companyId}/vouchers/${v.id}`}
                          className="text-accent underline underline-offset-4"
                        >
                          {v.voucher_number}
                        </Link>
                      </td>
                      <td className={td}>{TYPE_LABEL[v.voucher_type] ?? v.voucher_type}</td>
                      <td className={td + " font-mono tabular-nums"}>{v.voucher_date}</td>
                      <td className={td + " text-ink-soft"}>{creatorName(v.created_by)}</td>
                      <td className={num}>{formatINR(Number(v.total_amount))}</td>
                      <td className={td + " text-right"}>
                        <ApproveVoucherButton
                          companyId={companyId}
                          voucherId={v.id}
                          canApprove={canApprove}
                          disabledReason={
                            isCreator
                              ? "You created this voucher — a different admin must approve it."
                              : "Only a company admin can approve vouchers."
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableContainer>
        )}
      </div>
    </main>
  );
}
