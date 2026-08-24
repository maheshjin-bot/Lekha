import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { NotificationsManager, type NotificationRow } from "@/components/notifications/NotificationsManager";

/**
 * /notifications — the persistent record get_needs_attention (dashboard-
 * only, pull-only) never had. See 0122_email_notifications.sql's header for
 * the full design. No nav-rail link points here yet: components/nav/
 * NavRail.tsx is concurrent, in-flight work in this shared tree this task
 * must not touch (see AGENTS.md's file list) — this page is reachable
 * directly, and the dashboard's header links to it. Wiring a permanent rail
 * entry is a one-line follow-up once NavRail.tsx next changes hands; see
 * caveats_for_integration in this session's report.
 */
export default async function NotificationsPage({
  params,
}: PageProps<"/[companyId]/notifications">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;

  const [{ data: membership }, { data: rows }] = await Promise.all([
    userId
      ? supabase
          .from("company_members")
          .select("role")
          .eq("company_id", companyId)
          .eq("user_id", userId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("notifications")
      .select("id, category, subject, body_summary, status, sent_at, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const isAdmin = membership?.role === "admin";
  // "notifications" (0122) predates the next regeneration of
  // types/database.types.ts (a file this task must not touch — see
  // AGENTS.md), so supabase-js falls back to its untyped-relation overload
  // here, same as every other brand-new table in this shared tree right
  // now (digital_signature_certificates, exim_shipment_details, etc.).
  const notifications = (rows ?? []) as unknown as NotificationRow[];

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href={`/${companyId}`} className="text-sm text-ink-faint transition-colors hover:text-ink">
        ← Overview
      </Link>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
        Notifications
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        A record of what &ldquo;Needs your attention&rdquo; has surfaced — and, once an
        operator sets RESEND_API_KEY, what has actually been emailed.
        {!isAdmin && " You see only what's addressed to you; a company admin sees everything."}
      </p>

      <div className="mt-6">
        <NotificationsManager companyId={companyId} isAdmin={isAdmin} notifications={notifications} />
      </div>
    </main>
  );
}
