"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";

/**
 * Maker-checker: only a company admin who did not create this voucher can
 * approve it. The RPC itself enforces both rules server-side (0028) — the
 * disabled states here are guidance, not the actual gate.
 *
 * EXCEPTION (1030): a company with fewer than 2 active admins has no
 * possible second checker, so its sole admin may approve their own
 * vouchers. approve_voucher recomputes that live on every call — the caller
 * passes soloAdminApproval down purely so this button can say so up front,
 * rather than leaving a solo admin to discover it only after clicking a
 * button that looked disabled-for-good-reason.
 */
export function ApproveVoucherButton({
  companyId,
  voucherId,
  canApprove,
  disabledReason,
  soloAdminApproval = false,
}: {
  companyId: string;
  voucherId: string;
  canApprove: boolean;
  disabledReason?: string;
  soloAdminApproval?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onApprove() {
    setBusy(true);
    const { error } = await createClient().rpc("approve_voucher", {
      p_company_id: companyId,
      p_voucher_id: voucherId,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(
      soloAdminApproval ? "Self-approved — you're the only admin on this company" : "Voucher approved"
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button
        type="button"
        variant="primary"
        size="sm"
        busy={busy}
        busyLabel="Approving…"
        disabled={!canApprove}
        title={
          !canApprove
            ? disabledReason
            : soloAdminApproval
              ? "You're the only admin — self-approval is allowed until a second admin joins."
              : undefined
        }
        onClick={onApprove}
      >
        Approve
      </Button>
      {canApprove && soloAdminApproval && (
        <span className="text-[11px] text-ink-soft">Solo admin — self-approval</span>
      )}
    </div>
  );
}
