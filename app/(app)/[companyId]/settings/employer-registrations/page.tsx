import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { EmployerRegistrationsForm } from "@/components/companies/EmployerRegistrationsForm";

export default async function EmployerRegistrationsPage({
  params,
}: PageProps<"/[companyId]/settings/employer-registrations">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: company }, { data: branches }] = await Promise.all([
    supabase
      .from("companies")
      .select("pf_establishment_code, esi_employer_code, lin, shops_establishment_reg")
      .eq("id", companyId)
      .single(),
    supabase
      .from("branches")
      .select(
        "id, code, name, state_code, pt_registration_number, pt_enrolment_number, lwf_establishment_code"
      )
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false }),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Employer registrations
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        The numbers a payroll filing has to quote. Payroll can compute a PF liability to the rupee
        and still not produce an ECR, because an ECR has to say which establishment it is for.
      </p>

      <div className="mt-8">
        <EmployerRegistrationsForm
          companyId={companyId}
          company={
            company ?? {
              pf_establishment_code: null,
              esi_employer_code: null,
              lin: null,
              shops_establishment_reg: null,
            }
          }
          branches={branches ?? []}
        />
      </div>

      <p className="mt-8 text-xs text-ink-faint">
        Nothing here is mandatory — a business that has not registered for PF has no code to enter.
        Only the ESI code is format-checked, at 17 digits once separators are removed, because that
        length is firm. The PF establishment code is not: office code lengths differ by region and
        the separators are written inconsistently, so any pattern tight enough to be useful would
        reject somebody&rsquo;s real code. PT, LWF and Shops &amp; Establishment formats are set by
        each State separately, for the same reason.
      </p>
      <p className="mt-3 text-xs text-ink-faint">
        GST registrations are separate and live under{" "}
        <Link href={`/${companyId}/registrations`} className="underline">
          Registrations
        </Link>
        . PAN, TAN and the tax regime are under{" "}
        <Link href={`/${companyId}/settings`} className="underline">
          Settings
        </Link>
        .
      </p>
    </main>
  );
}
