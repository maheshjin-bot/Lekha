"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";

export type PendingSummaryRow = {
  company_id: string;
  company_name: string;
  pending_count: number;
};

/**
 * The cross-company "one click" the 0167 migration's header describes:
 * every company the signed-in user administers that has at least one
 * pending email notification (get_pending_notification_summary), drained
 * in a single POST to /api/notifications/send-all instead of visiting each
 * company's own /notifications page and clicking "Send pending emails"
 * once per company.
 */
export function SendAllPendingButton({ summary }: { summary: PendingSummaryRow[] }) {
  const router = useRouter();
  const [sending, setSending] = useState(false);

  if (summary.length === 0) {
    return null;
  }

  const totalPending = summary.reduce((n, row) => n + row.pending_count, 0);

  async function sendAll() {
    setSending(true);
    try {
      const res = await fetch("/api/notifications/send-all", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? `Send failed (HTTP ${res.status}).`);
        return;
      }
      if (!body.configured) {
        toast.message(
          "RESEND_API_KEY is not set — nothing was actually emailed. Visit a company's Notifications page to see what would have been sent."
        );
      } else {
        toast.success(`${body.sent} sent, ${body.failed} failed across ${summary.length} compan${summary.length === 1 ? "y" : "ies"}.`);
      }
      router.refresh();
    } catch {
      toast.error("Could not reach the send endpoint.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3">
      <p className="text-sm text-ink-soft">
        <span className="font-medium text-ink">{totalPending} pending notification{totalPending === 1 ? "" : "s"}</span>{" "}
        across {summary.length} compan{summary.length === 1 ? "y" : "ies"} you administer, not yet emailed.
      </p>
      <Button type="button" size="sm" onClick={sendAll} busy={sending} busyLabel="Sending…">
        Send pending emails across all companies
      </Button>
    </div>
  );
}
