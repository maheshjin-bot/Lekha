"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { Badge } from "@/components/ui/Badge";

type Signer = {
  id: string;
  signer_name: string;
  signer_email: string;
  sign_order: number;
  status: "pending" | "signed" | "declined";
  access_token: string | null;
  token_last_used_at: string | null;
};

const STATUS_BADGE: Record<Signer["status"], { tone: "neutral" | "warn" | "ok" | "bad"; label: string }> = {
  pending: { tone: "warn", label: "Pending" },
  signed: { tone: "ok", label: "Signed" },
  declined: { tone: "bad", label: "Declined" },
};

/**
 * A minimal, additive companion to SignatureRequestManager.tsx (this task
 * deliberately does not edit that file — see 0575 migration header): the
 * one place a company member can copy or regenerate a signer's public
 * /sign/[token] link. Not linked from SignatureRequestManager's own
 * RequestCard yet — reachable directly at this URL until a follow-up wires
 * a "Copy link" affordance into SignerRow itself.
 */
export function SignerLinksPanel({ signers }: { signers: Signer[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  function linkFor(token: string) {
    // Built client-side from window.location.origin rather than guessed
    // server-side from a header — this component only ever renders in the
    // browser (it's a client component), so this is always the real origin
    // the requester is looking at, no proxy/forwarded-header guessing.
    return `${window.location.origin}/sign/${token}`;
  }

  async function copyLink(token: string) {
    try {
      await navigator.clipboard.writeText(linkFor(token));
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy — copy it manually from the field below");
    }
  }

  async function regenerate(signerId: string) {
    setBusyId(signerId);
    const { error } = await callRpc(createClient(), "regenerate_signer_access_token", { p_signer_id: signerId });
    setBusyId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("New link generated — the old one no longer works");
    router.refresh();
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">#</th>
            <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Signer</th>
            <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Status</th>
            <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Link</th>
            <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Last opened</th>
          </tr>
        </thead>
        <tbody>
          {signers
            .slice()
            .sort((a, b) => a.sign_order - b.sign_order)
            .map((s) => (
              <tr key={s.id} className="border-b border-border last:border-0 align-top">
                <td className="px-4 py-2 font-mono text-xs text-ink-faint">{s.sign_order}</td>
                <td className="px-4 py-2">
                  <div className="text-sm text-ink">{s.signer_name}</div>
                  <div className="text-xs text-ink-faint">{s.signer_email}</div>
                </td>
                <td className="px-4 py-2">
                  <Badge tone={STATUS_BADGE[s.status].tone}>{STATUS_BADGE[s.status].label}</Badge>
                </td>
                <td className="px-4 py-2">
                  {s.access_token ? (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => copyLink(s.access_token!)}
                          className="text-xs text-accent underline underline-offset-2"
                        >
                          Copy link
                        </button>
                        <button
                          type="button"
                          disabled={busyId === s.id}
                          onClick={() => regenerate(s.id)}
                          className="text-xs text-ink-faint underline underline-offset-2 disabled:opacity-50"
                          title="Invalidates the old link and issues a new one"
                        >
                          Regenerate
                        </button>
                      </div>
                      <span className="max-w-xs truncate font-mono text-[11px] text-ink-faint">/sign/{s.access_token}</span>
                    </div>
                  ) : (
                    <span className="text-xs text-ink-faint">Not sent yet</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-ink-faint whitespace-nowrap">
                  {s.token_last_used_at ? new Date(s.token_last_used_at).toLocaleString() : "Never opened"}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
