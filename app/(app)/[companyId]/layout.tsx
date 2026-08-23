import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { NavRail } from "@/components/nav/NavRail";
import { CompanyUnlockGate } from "@/components/companies/CompanyUnlockGate";

export default async function CompanyLayout({
  params,
  children,
}: LayoutProps<"/[companyId]">) {
  const { companyId } = await params;
  const supabase = await createClient();

  // RLS returns nothing for a company you are not a member of, so a missing
  // row and a forbidden one are the same 404 — which is the right answer:
  // "this company exists but is not yours" is itself information.
  const { data } = await supabase
    .from("companies")
    .select("id, name, password_protected")
    .eq("id", companyId)
    .maybeSingle();

  if (!data) notFound();

  // A password-protected company that this browser hasn't unlocked this
  // session shows only the unlock prompt — the nav rail and children (and
  // whatever they'd fetch) never render, so nothing sensitive reaches the
  // client ahead of the password. See app/api/companies/[companyId]/unlock.
  if (data.password_protected) {
    const unlocked = (await cookies()).get(`co_unlock_${companyId}`)?.value === "1";
    if (!unlocked) {
      return <CompanyUnlockGate companyId={companyId} companyName={data.name} />;
    }
  }

  // proxy.ts stamps the pathname on every request (originally so the auth
  // guard could remember where a signed-out visitor was headed) — the rail
  // reuses it to know which link to mark active, without needing a client
  // component to own the whole layout.
  const activePath = (await headers()).get("x-pathname") ?? `/${companyId}`;

  return (
    <div className="flex min-h-screen bg-bg">
      <NavRail companyId={companyId} companyName={data.name} activePath={activePath} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
