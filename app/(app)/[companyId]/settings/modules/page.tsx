import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ModuleManager } from "@/components/settings/ModuleManager";

export default async function ModulesSettingsPage({
  params,
}: PageProps<"/[companyId]/settings/modules">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: modules }, { data: membership }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase.from("company_members").select("role").eq("company_id", companyId),
  ]);

  const isAdmin = (membership?.[0]?.role ?? null) === "admin";

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link
        href={`/${companyId}/settings`}
        className="text-sm text-ink-faint transition-colors hover:text-ink"
      >
        ← Settings
      </Link>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
        Modules
      </h1>
      <p className="mt-1.5 max-w-xl text-sm text-ink-soft">
        What this company runs, grouped by who controls it. Core is always
        on; conditional follows your registrations and entity type; optional
        is yours to turn on or off.
        {!isAdmin && " You can view this, but only an admin can change it."}
      </p>

      <ModuleManager companyId={companyId} modules={modules ?? []} isAdmin={isAdmin} />
    </main>
  );
}
