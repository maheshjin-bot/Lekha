"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

/**
 * Two-step inline confirm, matching this app's established pattern for a
 * destructive action (FixedAssetManager's dispose row, YearEndPanel's reopen
 * section) rather than a modal — there isn't one anywhere else in the app,
 * so this doesn't introduce a second pattern for the same job.
 *
 * A soft delete (vouchers.is_deleted) — every balance-computing function
 * already filters on it, so nothing else needs updating. The RPC itself
 * (delete_voucher) still enforces the real guards: a locked period or a
 * bank-reconciled entry blocks it server-side, this is just the button.
 */
export function DeleteVoucherButton({
  companyId,
  voucherId,
  redirectTo,
  className,
}: {
  companyId: string;
  voucherId: string;
  /** Navigate here after a successful delete instead of refreshing in place — use on the voucher's own detail page, where there's nothing left to show. */
  redirectTo?: string;
  className?: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function doDelete() {
    setBusy(true);
    const { error } = await createClient().rpc("delete_voucher", {
      p_company_id: companyId,
      p_voucher_id: voucherId,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      setConfirming(false);
      return;
    }
    toast.success("Voucher deleted");
    if (redirectTo) router.push(redirectTo);
    router.refresh();
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={"text-xs text-error underline underline-offset-4 " + (className ?? "")}
      >
        Delete
      </button>
    );
  }

  return (
    <span className={"inline-flex items-center gap-1.5 whitespace-nowrap text-xs " + (className ?? "")}>
      <span className="text-ink-faint">Delete?</span>
      <button
        type="button"
        onClick={doDelete}
        disabled={busy}
        className="font-semibold text-error underline underline-offset-4 disabled:opacity-50"
      >
        {busy ? "…" : "Confirm"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="text-ink-faint underline underline-offset-4"
      >
        Cancel
      </button>
    </span>
  );
}
