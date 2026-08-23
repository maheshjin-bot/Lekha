"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function PostDeferredTaxButton({
  companyId,
  branchId,
  fyEnd,
  fyEndLabel,
  movement,
}: {
  companyId: string;
  branchId: string;
  fyEnd: string;
  fyEndLabel: string;
  movement: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAsset = movement < 0;

  async function onPost() {
    if (
      !confirm(
        `Post a journal dated ${fyEndLabel} recognising a deferred tax ${
          isAsset ? "credit (asset increasing)" : "charge (liability increasing)"
        } of ₹${Math.abs(movement).toLocaleString("en-IN")}? Posted vouchers are not editable — a correction needs its own entry.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("post_deferred_tax", {
      p_company_id: companyId,
      p_branch_id: branchId,
      p_fy_end: fyEnd,
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
        {busy ? "Posting…" : "Post to books"}
      </button>
      {error && <p className="max-w-sm text-right text-xs text-error">{error}</p>}
    </div>
  );
}
