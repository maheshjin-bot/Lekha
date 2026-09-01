import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { formatINR } from "@/lib/utils/currency";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { ApproveVoucherButton } from "@/components/vouchers/ApproveVoucherButton";

type PendingApproval = {
  id: string;
  voucher_number: string;
  voucher_type: string;
  voucher_date: string;
  total_amount: number;
  created_by: string | null;
  creator_name: string | null;
};

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

  // Needed up front (not inside the Promise.all below) because the
  // membership lookup has to filter on it — company_members_read (0003) is
  // `is_company_member(company_id)`, which lets any active member read every
  // member row for the company, not just their own; without an explicit
  // `.eq("user_id", user.id)` the very first row returned could belong to a
  // co-worker, not the signed-in user.
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  // get_pending_approvals (1040) may not exist yet on whatever database this
  // is pointed at, the same reason /vouchers/[voucherId] guards self_approved
  // (1030) — this repo is applied to asynchronously, not necessarily by the
  // session that wrote the migration. callRpc doesn't throw on a missing
  // function; it returns {data: null, error}, and this page originally
  // discarded that error and did `rows = vouchers ?? []` — which silently
  // turned "the RPC doesn't exist yet" into "0 vouchers waiting," a false
  // all-clear on a compliance-relevant queue, worse than an outright error.
  // Fall back to the pre-1040 direct vouchers+profiles read (creator name
  // shows "—" via the same null-full_name gap 1040 fixes) the instant the
  // RPC errors, so this page is honest about what's actually pending either
  // way, and upgrades itself automatically once 1040 is live.
  const rpcResult = await callRpc<{ p_company_id: string }, PendingApproval[]>(
    supabase,
    "get_pending_approvals",
    { p_company_id: companyId }
  );
  async function fetchPendingApprovalsDirect(): Promise<{ data: PendingApproval[] }> {
    const { data: pending } = await supabase
      .from("vouchers")
      .select("id, voucher_number, voucher_type, voucher_date, total_amount, created_by")
      .eq("company_id", companyId)
      .eq("approval_status", "pending")
      .eq("is_deleted", false);
    const rows = pending ?? [];
    // Two steps, not an embedded profiles(full_name) select: vouchers has no
    // FK straight to profiles that PostgREST's relationship inference can
    // resolve unambiguously, the same reason 1040's own RPC does the join in
    // SQL instead. Fine here — one extra round trip on a page that's never
    // more than a handful of rows.
    const creatorIds = [...new Set(rows.map((v) => v.created_by).filter((id): id is string => !!id))];
    const { data: profiles } = creatorIds.length
      ? await supabase.from("profiles").select("id, full_name").in("id", creatorIds)
      : { data: [] as { id: string; full_name: string | null }[] };
    const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
    return {
      data: rows.map((v) => ({ ...v, creator_name: (v.created_by && nameById.get(v.created_by)) ?? null })),
    };
  }

  const pendingApprovalsQuery = rpcResult.error ? fetchPendingApprovalsDirect() : Promise.resolve(rpcResult);

  const [{ data: vouchers }, { data: membership }, { data: activeAdmins }] = await Promise.all([
    pendingApprovalsQuery,
    user
      ? supabase
          .from("company_members")
          .select("role")
          .eq("company_id", companyId)
          .eq("user_id", user.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // How many active admins this company has RIGHT NOW — the same live
    // count approve_voucher (1030) itself recomputes on every call. Fewer
    // than 2 means the signed-in admin, if they created a voucher, has no
    // possible second checker and may approve their own.
    supabase
      .from("company_members")
      .select("id")
      .eq("company_id", companyId)
      .eq("role", "admin")
      .eq("status", "active"),
  ]);

  const myRole = membership?.role ?? null;
  const isAdmin = myRole === "admin";
  const rows = vouchers ?? [];
  const activeAdminCount = activeAdmins?.length ?? 0;
  // Mirrors 1030's own exception exactly: a solo admin (fewer than 2 active
  // admins company-wide) may approve a voucher they created themselves.
  // Recomputed on every page load, same as the RPC recomputes it on every
  // approval — the moment a 2nd admin is active this goes false again.
  const soloAdminCompany = isAdmin && activeAdminCount < 2;
  const creatorName = (name: string | null) => name || "—";

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Approvals
      </h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        {rows.length} voucher{rows.length === 1 ? "" : "s"} waiting on a second admin to
        confirm.
      </p>

      {soloAdminCompany && (
        <p className="mt-3 rounded-lg border border-border-strong bg-accent-soft/40 px-3 py-2 text-xs text-ink-soft">
          You&rsquo;re the only admin on this company, so self-approval is allowed on vouchers
          you created yourself — each one is recorded as a solo self-approval, not a normal
          two-person one.{" "}
          <Link
            href={`/${companyId}/settings/team`}
            className="text-accent underline underline-offset-4"
          >
            Invite a second admin
          </Link>{" "}
          to restore the two-person check.
        </p>
      )}

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
                  const soloSelfApprove = soloAdminCompany && isCreator;
                  const canApprove = isAdmin && (!isCreator || soloSelfApprove);
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
                      <td className={td + " text-ink-soft"}>{creatorName(v.creator_name)}</td>
                      <td className={num}>{formatINR(Number(v.total_amount))}</td>
                      <td className={td + " text-right"}>
                        <ApproveVoucherButton
                          companyId={companyId}
                          voucherId={v.id}
                          canApprove={canApprove}
                          soloAdminApproval={soloSelfApprove}
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
