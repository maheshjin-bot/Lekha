"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function PostPayrollButton({
  companyId,
  branchId,
  periodMonth,
  monthLabel,
}: {
  companyId: string;
  branchId: string;
  periodMonth: string;
  monthLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPost() {
    if (!confirm(`Post payroll for ${monthLabel} as a journal voucher? This can't be undone from here — a correction would need a manual reversing entry.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("post_payroll_run", {
      p_company_id: companyId,
      p_branch_id: branchId,
      p_period_month: periodMonth,
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
      {error && <p className="max-w-xs text-right text-xs text-error">{error}</p>}
    </div>
  );
}
