"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function PostGstSetoffButton({
  companyId,
  branchId,
  registrationId,
  asAt,
  asAtLabel,
  netPayable,
  totalToClear,
}: {
  companyId: string;
  branchId: string;
  registrationId: string;
  asAt: string;
  asAtLabel: string;
  netPayable: number;
  /** Sum of the output ledgers being zeroed — what the confirm dialog describes. */
  totalToClear: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPost() {
    const payableLine =
      netPayable > 0
        ? ` ₹${netPayable.toLocaleString("en-IN")} will move to GST Payable as net tax still owed.`
        : " Every output-tax rupee is fully covered by credit — nothing moves to GST Payable.";
    if (
      !confirm(
        `Post the GST set-off journal dated ${asAtLabel}? This clears ₹${totalToClear.toLocaleString(
          "en-IN"
        )} of output tax against input credit, in Sec 49A/Rule 88A order.${payableLine} Posted vouchers are not editable — a correction needs its own entry.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("post_gst_setoff", {
      p_company_id: companyId,
      p_branch_id: branchId,
      p_gst_registration_id: registrationId,
      p_as_at: asAt,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={onPost}
        className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Posting…" : "Post clearing journal"}
      </button>
      {error && <p className="max-w-sm text-right text-xs text-error">{error}</p>}
    </div>
  );
}
