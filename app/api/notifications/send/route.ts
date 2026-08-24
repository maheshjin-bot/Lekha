import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { sendTransactionalEmail } from "@/lib/email/resend";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/send  { companyId: string }
 *
 * The one place in the app that actually calls out to an email provider —
 * see supabase/migrations/0122_email_notifications.sql's header for why
 * this is a manually-triggered route rather than something the cron digest
 * calls automatically. Two Postgres RPCs do the real work of deciding WHO
 * to email and recording the outcome (get_pending_email_notifications,
 * mark_notification_sent) — both are SECURITY DEFINER but still gated by
 * "only a company admin", enforced in SQL, not duplicated here. This route
 * is a thin loop: fetch the pending list (as the signed-in user, via the
 * cookie-based server client — RLS/the RPC's own check decides whether that
 * succeeds), send each one through Resend, record the result.
 *
 * A single Resend call per notification (`to` accepts an array), not one
 * call per recipient — several admins on the same notification is one
 * email with several To: addresses, not several emails, which matters on
 * Resend's free tier's 100/day cap.
 *
 * No RESEND_API_KEY configured is NOT an error response — every attempted
 * send comes back `skipped`, the notifications stay 'pending' (not marked
 * failed — nothing was actually attempted), and the JSON body says so
 * plainly so the UI can show "email isn't configured yet" instead of a
 * scary failure count.
 */

type PendingRow = { notification_id: string; to_email: string; subject: string; body_summary: string };

export async function POST(request: Request) {
  let companyId: string | undefined;
  try {
    const body = await request.json();
    companyId = typeof body?.companyId === "string" ? body.companyId : undefined;
  } catch {
    // no body at all — companyId stays undefined, handled below
  }

  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: pending, error: pendingError } = await callRpc<
    { p_company_id: string },
    PendingRow[]
  >(supabase, "get_pending_email_notifications", { p_company_id: companyId });

  if (pendingError) {
    // The RPC itself raises "Only a company admin can..." for a non-admin
    // caller — surfaced as-is rather than reworded, it is already clear.
    return NextResponse.json({ error: pendingError.message }, { status: 403 });
  }

  const rows = pending ?? [];
  if (rows.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, skipped: 0, configured: Boolean(process.env.RESEND_API_KEY) });
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

  return NextResponse.json({ sent, failed, skipped, configured: Boolean(process.env.RESEND_API_KEY) });
}
