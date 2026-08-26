import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { dispatchPendingForCompany } from "@/lib/notifications/dispatchPending";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/send  { companyId: string }
 *
 * The one place in the app that actually calls out to an email provider —
 * see supabase/migrations/0122_email_notifications.sql's header for why
 * this is a manually-triggered route rather than something the cron digest
 * calls automatically, and 0167_notifications_cross_company_dispatch.sql's
 * header for exactly why full unattended dispatch is still blocked (pg_net
 * is available on this Supabase project but not enabled, and this task is
 * explicitly not to enable it). The actual fetch/send/mark loop now lives
 * in lib/notifications/dispatchPending.ts (0167) — this route is just the
 * single-company entry point into it; app/api/notifications/send-all
 * (0167) is the cross-company one, sharing the same helper.
 *
 * No RESEND_API_KEY configured is NOT an error response — every attempted
 * send comes back `skipped`, the notifications stay 'pending' (not marked
 * failed — nothing was actually attempted), and the JSON body says so
 * plainly so the UI can show "email isn't configured yet" instead of a
 * scary failure count.
 */

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

  const result = await dispatchPendingForCompany(supabase, companyId);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 403 });
  }

  return NextResponse.json({ ...result, configured: Boolean(process.env.RESEND_API_KEY) });
}
