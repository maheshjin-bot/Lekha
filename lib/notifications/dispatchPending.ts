import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc } from "@/lib/supabase/rpc";
import { sendTransactionalEmail } from "@/lib/email/resend";
import { logError } from "@/lib/errors/logError";

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
    //
    // Not logged durably. A permission refusal is the database doing its job
    // and telling the caller so, not an application failure; recording every
    // one of them would fill the owner's error log with rows that say
    // "someone without permission tried to send reminders", which is a
    // different feature (and one this app has an audit trail for).
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
      // So a failed send lands on THIS company's error-log screen rather than
      // as an unattributed row nobody can see. The transport does the
      // logging — it is the layer that knows the status code and the
      // provider's own wording. See lib/email/resend.ts.
      errorScope: { supabase, companyId },
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
      // This one IS worth a durable record, and is worse than it looks: the
      // email has already gone out at this point, so the notification stays
      // 'pending' and the next digest run will send it a second time. That is
      // a duplicate email landing in a customer's inbox, which the owner will
      // hear about and would otherwise have no way to explain.
      await logError({
        operation: "notification_dispatch",
        severity: "critical",
        message:
          "A reminder email was sent, but the app could not record that it went out — it may be sent again.",
        detail: `mark_notification_sent failed for notification ${notificationId}: ${markError.message}`,
        companyId,
        supabase,
        context: { notification_id: notificationId, delivered: result.ok },
      });
    }
  }

  return { sent, failed, skipped };
}
