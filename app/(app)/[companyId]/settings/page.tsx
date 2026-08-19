import { createClient } from "@/lib/supabase/server";
import { CompanySettingsForm } from "@/components/companies/CompanySettingsForm";

export default async function SettingsPage({
  params,
}: PageProps<"/[companyId]/settings">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select(
      "id, name, pan, tan, udyam_number, udyam_category, entity_type, company_tax_regime, is_professional"
    )
    .eq("id", companyId)
    .maybeSingle();

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Settings</h1>
      <p className="mt-1.5 max-w-xl text-sm text-ink-soft">
        Admin only. PAN is shown for reference; editing it isn&rsquo;t
        supported here yet.
      </p>

      <CompanySettingsForm
        companyId={companyId}
        entityType={company?.entity_type ?? ""}
        pan={company?.pan ?? null}
        tan={company?.tan ?? null}
        udyamNumber={company?.udyam_number ?? null}
        udyamCategory={company?.udyam_category ?? null}
        companyTaxRegime={company?.company_tax_regime ?? "default_30"}
        isProfessional={company?.is_professional ?? false}
      />
    </main>
  );
}
