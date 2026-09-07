import { createClient } from "@/lib/supabase/server";
import { BranchManager } from "@/components/branches/BranchManager";

export default async function BranchesPage({
  params,
}: PageProps<"/[companyId]/branches">) {
  const { companyId } = await params;
  const supabase = await createClient();

  // Same isAdmin derivation as the Modules settings page: branches_write's
  // RLS clause (and both RPCs, independently) already hard-gate writes to
  // app_private.is_company_admin — this mirrors that at the UI layer so a
  // non-admin sees disabled controls with a reason, rather than a raw RLS
  // rejection after filling in a form.
  const [{ data: membership }, { data: branches }, { data: states }] = await Promise.all([
    supabase.from("company_members").select("role").eq("company_id", companyId),
    supabase
      .from("branches")
      .select(
        "id, code, name, state_code, address_line1, address_line2, city, pincode, is_head_office, is_active, gst_registration_id, gst_registrations(gstin)"
      )
      .eq("company_id", companyId)
      .order("is_head_office", { ascending: false })
      .order("code"),
    supabase
      .from("ref_states")
      .select("code, name")
      .eq("is_active", true)
      .order("code"),
  ]);

  const isAdmin = (membership?.[0]?.role ?? null) === "admin";

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Branches</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Every location this company operates from, beyond the head office
        created with the company itself. A branch&apos;s code and state feed
        its voucher numbering and GST registration, so both lock once set —
        only the address can change afterwards.
        {!isAdmin && " You can view this, but only an admin can add or edit a branch."}
      </p>

      <BranchManager
        companyId={companyId}
        branches={branches ?? []}
        states={states ?? []}
        isAdmin={isAdmin}
      />
    </main>
  );
}
