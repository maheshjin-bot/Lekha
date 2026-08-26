import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc } from "@/lib/supabase/rpc";
import { sendTransactionalEmail } from "@/lib/email/resend";

/**
 * The one place the real "fetch pending -> send via Resend -> record
 * outcome" loop is implemented for ONE company — factored out of
 * app/api/notifications/send/route.ts (0122) so app/api/notifications/
 * send-all/route.ts (0167) can reuse it verbatim instead of re-deriving the
 * same grouping/send/mark sequence. Behaviour is unchanged from the
 * pre-0167 single-company route: still get_pending_email_notifications ->
 * group by notification_id (one email per notification, several `to`
 * addresses for a company-wide row) -> sendTransactionalEmail ->
 * mark_notification_sent per attempted send. A `skipped` result (no
 * RESEND_API_KEY) still leaves the row 'pending' — nothing was attempted,
 * so nothing is recorded either.
 */

type PendingRow = { notification_id: string; to_email: string; subject: string; body_summary: string };

export interface DispatchResult {
  sent: number;
  failed: number;
  skipped: number;
}

export async function dispatchPendingForCompany(
  supabase: SupabaseClient,
  companyId: string
): Promise<DispatchResult | { error: string }> {
  const { data: pending, error: pendingError } = await callRpc<
    { p_company_id: string },
    PendingRow[]
  >(supabase, "get_pending_email_notifications", { p_company_id: companyId });

  if (pendingError) {
    // The RPC itself raises "Only a company admin can..." for a non-admin
    // caller — surfaced as-is rather than reworded, it is already clear.
    return { error: pendingError.message };
  }

  const rows = pending ?? [];
  if (rows.length === 0) {
    return { sent: 0, failed: 0, skipped: 0 };
  }

  // Group by notification_id: a company-wide (null-recipient) notification
  // resolves to one row per admin from get_pending_email_notifications, and
  // should still go out as a single email addressed to all of them.
  const byNotification = new Map<string, { to: string[]; subject: string; body: string }>();
  for (const row of rows) {
    const existing = byNotification.get(row.notification_id);
    if (existing) {
      existing.to.push(row.to_email);
    } else {
      byNotification.set(row.notification_id, {
        to: [row.to_email],
        subject: row.subject,
        body: row.body_summary,
      });
    }
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const [notificationId, group] of byNotification) {
    const result = await sendTransactionalEmail({
      to: group.to,
      subject: group.subject,
      text: group.body,
    });

    if (result.skipped) {
      skipped += 1;
      continue; // left 'pending' — nothing was attempted, so nothing to record.
    }

    if (result.ok) {
      sent += 1;
    } else {
      failed += 1;
    }

    const { error: markError } = await callRpc<
      { p_notification_id: string; p_success: boolean },
      null
    >(supabase, "mark_notification_sent", { p_notification_id: notificationId, p_success: result.ok });
    if (markError) {
      console.error(`[notifications] mark_notification_sent failed for ${notificationId}: ${markError.message}`);
    }
  }

  return { sent, failed, skipped };
}
