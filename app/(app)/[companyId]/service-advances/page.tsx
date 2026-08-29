import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ServiceAdvanceManager } from "@/components/service-advances/ServiceAdvanceManager";

export default async function ServiceAdvancesPage({
  params,
}: PageProps<"/[companyId]/service-advances">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);

  if (!gstOn) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Service advances</h1>
        <div className="mt-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">GST is not on for this company</p>
          <p className="mt-1">
            Add a GST registration first —{" "}
            <Link href={`/${companyId}/registrations`} className="underline">
              Registrations
            </Link>
            .
          </p>
        </div>
      </main>
    );
  }

  // 0500's own new RPCs — not yet in the generated database.types.ts (same
  // "cast after the integration pass regenerates types" situation every
  // recent report page is in). See caveats_for_integration in the final report.
  const [{ data: taggableVouchers }, { data: advances }, { data: salesVouchers }, { data: states }] = await Promise.all([
    supabase.rpc("get_taggable_receipt_vouchers", { p_company_id: companyId }),
    supabase.rpc("get_service_advance_receipts", { p_company_id: companyId, p_status_filter: undefined }),
    supabase
      .from("vouchers")
      .select("id, voucher_number, voucher_date, party_ledger_id")
      .eq("company_id", companyId)
      .eq("voucher_type", "sales")
      .eq("is_deleted", false)
      .order("voucher_date", { ascending: false })
      .limit(500),
    supabase.from("ref_states").select("code, name").order("name"),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Service advances</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Advances received against a customer, for a service not yet invoiced, are GST-liable the moment
          they arrive (Sec 13(2)) — unlike advances for goods, which have been exempt from this since
          Notification 66/2017-Central Tax. Tag the specific amount here to record that liability (grossed
          up per Rule 50) and feed GSTR-1 Table 11A. When the real invoice is raised, mark it adjusted — a
          manual link, never auto-matched — and it moves into Table 11B instead.
        </p>
      </header>

      <ServiceAdvanceManager
        companyId={companyId}
        taggableVouchers={(taggableVouchers ?? []) as never}
        advances={(advances ?? []) as never}
        salesVouchers={salesVouchers ?? []}
        states={states ?? []}
      />
    </main>
  );
}
