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
 */
export function ApproveVoucherButton({
  companyId,
  voucherId,
  canApprove,
  disabledReason,
}: {
  companyId: string;
  voucherId: string;
  canApprove: boolean;
  disabledReason?: string;
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
    toast.success("Voucher approved");
    router.refresh();
  }

  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      busy={busy}
      busyLabel="Approving…"
      disabled={!canApprove}
      title={!canApprove ? disabledReason : undefined}
      onClick={onApprove}
    >
      Approve
    </Button>
  );
}
