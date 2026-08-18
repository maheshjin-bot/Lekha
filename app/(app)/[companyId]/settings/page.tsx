import { createClient } from "@/lib/supabase/server";
import { CompanySettingsForm } from "@/components/companies/CompanySettingsForm";

export default async function SettingsPage({
  params,
}: PageProps<"/[companyId]/settings">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("id, name, pan, tan")
    .eq("id", companyId)
    .maybeSingle();

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1.5 max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
        Admin only. PAN is shown for reference; editing it isn&rsquo;t
        supported here yet.
      </p>

      <CompanySettingsForm
        companyId={companyId}
        pan={company?.pan ?? null}
        tan={company?.tan ?? null}
      />
    </main>
  );
}
