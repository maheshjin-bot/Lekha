"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { formatINR } from "@/lib/utils/currency";
import type { CaptureExtraction } from "@/lib/capture/analyze";

type Company = { id: string; name: string };
type Branch = { id: string; code: string; name: string };

function asExtraction(raw: unknown): CaptureExtraction | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as CaptureExtraction;
}

/**
 * The company-picker half of /whatsapp-confirm/[token] (migration 0745).
 * "Claim & review" below calls the EXISTING claim_capture_draft RPC (0740) —
 * unmodified, no WhatsApp-specific claiming path — then sends the now-company-
 * scoped draft straight to /[companyId]/capture, the SAME review-and-post
 * screen the 'upload' source already uses. Nothing here ever calls
 * create_invoice directly; posting only ever happens from that screen.
 */
export function ConfirmWhatsAppDraftPanel({
  draftId,
  companies,
  suggestedCompanyId,
  suggestedCompanyName,
  extraction,
}: {
  draftId: string;
  companies: Company[];
  suggestedCompanyId: string | null;
  suggestedCompanyName: string | null;
  extraction: unknown;
}) {
  const router = useRouter();
  const ex = asExtraction(extraction);

  const [companyId, setCompanyId] = useState<string>(() =>
    suggestedCompanyId && companies.some((c) => c.id === suggestedCompanyId) ? suggestedCompanyId : ""
  );
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [busy, setBusy] = useState(false);

  // No branch fetch (and no setState) at all while no company is picked —
  // rendering below additionally guards on `companyId &&` so a stale
  // previous company's branch list can never be shown once the selection is
  // cleared, without needing a synchronous setState in the effect body.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    createClient()
      .from("branches")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false })
      .then(({ data }) => {
        if (cancelled) return;
        setBranches(data ?? []);
        setBranchId(data?.[0]?.id ?? "");
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function claim() {
    if (!companyId) {
      toast.error("Select a company first");
      return;
    }
    setBusy(true);
    // claim_capture_draft (0740) predates types/database.types.ts's next
    // regeneration in this session — same untyped-RPC escape hatch used
    // throughout this feature.
    const { data, error } = await callRpc<
      { p_draft_id: string; p_company_id: string; p_branch_id: string | null },
      Record<string, unknown>
    >(createClient(), "claim_capture_draft", {
      p_draft_id: draftId,
      p_company_id: companyId,
      p_branch_id: branchId || null,
    });
    setBusy(false);
    if (error || !data) {
      toast.error(error?.message ?? "Could not claim this draft.");
      return;
    }
    toast.success("Claimed — review and post it on the next screen.");
    router.push(`/${companyId}/capture`);
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-6 flex flex-col gap-5 rounded-[14px] border border-border bg-surface p-5">
      {ex && ex.configured && (
        <div className="rounded-md bg-surface-2 px-3 py-2 text-sm text-ink-soft">
          <p className="font-medium text-ink">{ex.vendor_name ?? "Vendor not read"}</p>
          {ex.total_amount != null && <p>Total on bill: {formatINR(ex.total_amount, { showZero: true })}</p>}
          <p className="mt-1 text-xs text-ink-faint">{ex.note}</p>
        </div>
      )}
      {ex && !ex.configured && (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          Vision capture wasn&rsquo;t configured when this bill arrived — you&rsquo;ll enter every field by hand
          after claiming it.
        </p>
      )}
      {!ex && (
        <p className="text-xs text-ink-faint">No extraction was recorded for this bill.</p>
      )}

      {suggestedCompanyName && (
        <p className="text-xs text-ink-faint">
          Suggested company, from a registered WhatsApp number: {suggestedCompanyName}. You can still pick a
          different one below.
        </p>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Company</span>
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={field}>
          <option value="">Select…</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {companyId && branches.length > 0 && (
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Branch</span>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <button
        type="button"
        disabled={busy || !companyId}
        onClick={claim}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Claiming…" : "Claim & review"}
      </button>
    </div>
  );
}
