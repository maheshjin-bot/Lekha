import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { TeamManager, type TeamInvite, type TeamMember } from "@/components/settings/TeamManager";

export default async function TeamSettingsPage({
  params,
}: PageProps<"/[companyId]/settings/team">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: membership }, teamResult] = await Promise.all([
    supabase.from("company_members").select("role").eq("company_id", companyId),
    callRpc<{ p_company_id: string }, TeamMember[]>(supabase, "get_company_team", {
      p_company_id: companyId,
    }),
  ]);

  const isAdmin = (membership?.[0]?.role ?? null) === "admin";
  const members = teamResult.data ?? [];

  // company_invites_read (0003) is admin-only — a non-admin's select here
  // returns zero rows under RLS, so this is only worth issuing at all for an
  // admin, and rendering an "Invites" section with zero rows for a non-admin
  // would look like there simply are none rather than "you can't see them".
  const { data: invites } = isAdmin
    ? await supabase
        .from("company_invites")
        .select("id, email, role, status, created_at, expires_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
    : { data: [] as TeamInvite[] };

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link
        href={`/${companyId}/settings`}
        className="text-sm text-ink-faint transition-colors hover:text-ink"
      >
        ← Settings
      </Link>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">Team</h1>
      <p className="mt-1.5 max-w-xl text-sm text-ink-soft">
        Who has access to this company, and what they can do.
        {!isAdmin && " You can view this, but only an admin can invite or revoke."}
      </p>

      <div className="mt-6">
        <TeamManager
          companyId={companyId}
          isAdmin={isAdmin}
          members={members}
          invites={invites ?? []}
        />
      </div>
    </main>
  );
}
