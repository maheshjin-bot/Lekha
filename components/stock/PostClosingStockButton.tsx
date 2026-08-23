"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function PostClosingStockButton({
  companyId,
  branchId,
  asAt,
  asAtLabel,
  delta,
}: {
  companyId: string;
  branchId: string;
  asAt: string;
  asAtLabel: string;
  delta: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const increasing = delta > 0;

  async function onPost() {
    if (
      !confirm(
        `Post a journal dated ${asAtLabel} that ${
          increasing ? "brings stock onto" : "releases stock from"
        } the books by ₹${Math.abs(delta).toLocaleString("en-IN")}? Posted vouchers are not editable — a correction needs its own entry.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("post_closing_stock", {
      p_company_id: companyId,
      p_branch_id: branchId,
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
        {busy ? "Posting…" : "Post to books"}
      </button>
      {error && <p className="max-w-sm text-right text-xs text-error">{error}</p>}
    </div>
  );
}
