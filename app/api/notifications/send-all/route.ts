import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { dispatchPendingForCompany } from "@/lib/notifications/dispatchPending";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/send-all
 *
 * The "true one-click action even after days of accumulation" the 0167
 * migration's header describes: drains the pending-email queue for EVERY
 * company the signed-in user actively administers, not just the one they
 * happen to be looking at. Discovers the company list via
 * get_pending_notification_summary (0167, "my companies with pending
 * notifications right now"), then calls the exact same
 * dispatchPendingForCompany helper app/api/notifications/send uses, once
 * per company, sequentially (typically a handful of companies for a real
 * admin — see this feature's session report for real numbers off this
 * project's own data).
 *
 * Same "no RESEND_API_KEY -> everything comes back skipped, nothing marked
 * failed" behaviour as the single-company route — this endpoint does not
 * change what counts as configured, only how many companies one request
 * covers.
 */

type SummaryRow = { company_id: string; company_name: string; pending_count: number };

export async function POST() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: summary, error: summaryError } = await callRpc<Record<string, never>, SummaryRow[]>(
    supabase,
    "get_pending_notification_summary",
    {}
  );

  if (summaryError) {
    return NextResponse.json({ error: summaryError.message }, { status: 403 });
  }

  const companies = summary ?? [];
  const perCompany: Array<{ companyId: string; companyName: string; sent: number; failed: number; skipped: number; error?: string }> = [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const company of companies) {
    const result = await dispatchPendingForCompany(supabase, company.company_id);
    if ("error" in result) {
      perCompany.push({ companyId: company.company_id, companyName: company.company_name, sent: 0, failed: 0, skipped: 0, error: result.error });
      continue;
    }
    sent += result.sent;
    failed += result.failed;
    skipped += result.skipped;
    perCompany.push({ companyId: company.company_id, companyName: company.company_name, ...result });
  }

  return NextResponse.json({
    companies: perCompany,
    sent,
    failed,
    skipped,
    configured: Boolean(process.env.RESEND_API_KEY),
  });
}
