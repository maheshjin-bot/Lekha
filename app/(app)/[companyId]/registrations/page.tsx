import { createClient } from "@/lib/supabase/server";
import { RegistrationManager } from "@/components/registrations/RegistrationManager";

export default async function RegistrationsPage({
  params,
}: PageProps<"/[companyId]/registrations">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: registrations }, { data: branches }, { data: states }] =
    await Promise.all([
      supabase
        .from("gst_registrations")
        .select("id, gstin, state_code, registration_type, filing_frequency, registered_from, is_active")
        .eq("company_id", companyId)
        .order("registered_from"),
      supabase
        .from("branches")
        .select("id, code, name, state_code, gst_registration_id")
        .eq("company_id", companyId)
        .order("is_head_office", { ascending: false }),
      supabase.from("ref_states").select("code, name").order("name"),
    ]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">GST registrations</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        One GSTIN per state. Adding the first one turns GST on for this
        company — every invoice from an attached branch computes tax from
        here on.
      </p>

      <RegistrationManager
        companyId={companyId}
        registrations={registrations ?? []}
        branches={branches ?? []}
        states={states ?? []}
      />
    </main>
  );
}
