"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { TableContainer, th, td } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

export type NotificationRow = {
  id: string;
  category: string;
  subject: string;
  body_summary: string;
  status: string;
  sent_at: string | null;
  created_at: string;
};

const STATUS_TONE: Record<string, "ok" | "warn" | "bad"> = {
  sent: "ok",
  pending: "warn",
  failed: "bad",
};

/**
 * The "what would have been emailed" list — this exists specifically so the
 * feature is verifiable and useful even with no RESEND_API_KEY configured
 * (see 0122_email_notifications.sql's header). "Generate now" calls
 * create_notifications_from_needs_attention directly with the signed-in
 * admin's own session (RLS/the function's own admin check decide whether it
 * succeeds) — that RPC only ever creates rows for genuinely new,
 * undeduped issues, so clicking it twice in a row is expected to report 0
 * new the second time. "Send pending emails" goes through
 * /api/notifications/send because sending needs RESEND_API_KEY, a server-
 * only secret this client component must never see.
 */
export function NotificationsManager({
  companyId,
  isAdmin,
  notifications,
}: {
  companyId: string;
  isAdmin: boolean;
  notifications: NotificationRow[];
}) {
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);

  async function generateNow() {
    setGenerating(true);
    const { data, error } = await callRpc<{ p_company_id: string }, number>(
      createClient(),
      "create_notifications_from_needs_attention",
      { p_company_id: companyId }
    );
    setGenerating(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(data && data > 0 ? `${data} new notification${data === 1 ? "" : "s"} created.` : "Nothing new — already up to date.");
    router.refresh();
  }

  async function sendPending() {
    setSending(true);
    try {
      const res = await fetch("/api/notifications/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? `Send failed (HTTP ${res.status}).`);
        return;
      }
      if (!body.configured) {
        toast.message(
          "RESEND_API_KEY is not set — nothing was actually emailed. The notifications below are what would have been sent."
        );
      } else {
        toast.success(`${body.sent} sent, ${body.failed} failed.`);
      }
      router.refresh();
    } catch {
      toast.error("Could not reach the send endpoint.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {isAdmin && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={generateNow} busy={generating} busyLabel="Checking…">
            Generate now
          </Button>
          <Button type="button" size="sm" onClick={sendPending} busy={sending} busyLabel="Sending…">
            Send pending emails
          </Button>
        </div>
      )}

      {notifications.length === 0 ? (
        <EmptyState>
          Nothing here yet. {isAdmin ? "Click “Generate now” to pull today's needs-attention items in." : "Nothing has needed your attention recently."}
        </EmptyState>
      ) : (
        <TableContainer>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Category</th>
                <th className={th}>Notification</th>
                <th className={th}>Status</th>
                <th className={th}>Created</th>
              </tr>
            </thead>
            <tbody>
              {notifications.map((n) => (
                <tr key={n.id} className="border-b border-border last:border-0">
                  <td className={td}>
                    <Badge tone="neutral">{n.category}</Badge>
                  </td>
                  <td className={td}>
                    <div className="font-medium text-ink">{n.subject}</div>
                    <div className="mt-0.5 text-xs text-ink-faint">{n.body_summary}</div>
                  </td>
                  <td className={td}>
                    <Badge tone={STATUS_TONE[n.status] ?? "neutral"}>{n.status}</Badge>
                  </td>
                  <td className={td + " whitespace-nowrap text-ink-soft"}>
                    {n.created_at.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}
    </div>
  );
}
