import Link from "next/link";
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
        // legal_name / trade_name / registered_to have existed on this table
        // since 0005 and were never once fetched here, which is half of why
        // nothing could write them — see migration 1390.
        .select(
          "id, gstin, state_code, registration_type, filing_frequency, registered_from, registered_to, is_active, legal_name, trade_name, lut_number, lut_valid_from, lut_valid_to, lut_arn"
        )
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
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">GST registrations</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
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

      {/* The only entry point to the repair screen: components/nav/NavRail.tsx
          is owned by a concurrent session and must not be edited here, and
          /registrations is where the tax-ledger map is created in the first
          place. Same arrangement as the Error log card on /settings — the
          integration pass should add a proper nav entry. */}
      <Link
        href={`/${companyId}/registrations/tax-ledgers`}
        className="mt-6 flex items-center justify-between rounded-lg border border-border bg-surface p-5 transition-colors hover:bg-surface-2"
      >
        <span>
          <span className="block font-semibold text-ink">Tax ledgers</span>
          <span className="mt-0.5 block text-sm text-ink-soft">
            Which ledger each GST amount posts to, per GSTIN — and a repair for when
            one is missing, which is what stops an invoice saving at all.
          </span>
        </span>
        <span aria-hidden className="text-ink-faint">→</span>
      </Link>
    </main>
  );
}
