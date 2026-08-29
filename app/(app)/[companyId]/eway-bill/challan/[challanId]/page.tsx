import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DeliveryChallanEwbForm } from "@/components/eway-bill/DeliveryChallanEwbForm";

/**
 * The delivery-challan counterpart to /eway-bill/[voucherId] (0190) — a
 * dedicated addendum entry point for the "reasons other than supply" and
 * branch-transfer movements Rule 138 also covers (0113's delivery_challans),
 * which 0190 itself named as a real, deliberately deferred gap. Never
 * touches delivery_challans' own core posting logic.
 */
export default async function EwayBillChallanPage({
  params,
}: PageProps<"/[companyId]/eway-bill/challan/[challanId]">) {
  const { companyId, challanId } = await params;
  const supabase = await createClient();

  // delivery_challans (0113) is already in the generated types — no cast
  // needed. get_delivery_challan_ewb_requirement, build_delivery_challan_
  // ewb_json and delivery_challan_ewb_details are brand new (migration
  // 0500) — not yet in the generated database types (owned by the
  // integration pass), hence the disabled rule below each, same convention
  // as EinvoiceDetailForm.tsx's einvoice_details.
  const { data: challan } = await supabase
    .from("delivery_challans")
    .select("id, purpose, challan_date, voucher_id")
    .eq("id", challanId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!challan) notFound();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select("voucher_number, place_of_supply")
    .eq("id", challan.voucher_id)
    .maybeSingle();

  const { data: requirement } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    .rpc("get_delivery_challan_ewb_requirement" as any, { p_challan_id: challanId })
    .maybeSingle<{ consignment_value: number; threshold_amount: number; is_ewb_required: boolean }>();

  const { data: existing } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    .from("delivery_challan_ewb_details" as any)
    .select(
      "id, to_state_code, to_pincode, transporter_id, transporter_name, vehicle_number, transport_mode, transport_doc_number, transport_doc_date, approx_distance_km, ewb_number, ewb_generated_date, ewb_valid_until, status"
    )
    .eq("challan_id", challanId)
    .maybeSingle();

  const { data: states } = await supabase.from("ref_states").select("code, name").order("name");

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
          <Link href={`/${companyId}/eway-bill`} className="text-accent underline underline-offset-4">
            e-Way Bill
          </Link>
          {" / "}
          {voucher?.voucher_number ?? challan.id}
        </p>
        <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">
          {voucher?.voucher_number ?? "Delivery challan"}
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          {challan.challan_date} · {challan.purpose.replace(/_/g, " ")}
        </p>
      </header>

      <DeliveryChallanEwbForm
        companyId={companyId}
        challanId={challanId}
        consignmentValue={requirement ? Number(requirement.consignment_value) : 0}
        thresholdAmount={requirement ? Number(requirement.threshold_amount) : 50000}
        isEwbRequired={requirement?.is_ewb_required ?? false}
        existing={existing as never}
        states={states ?? []}
        toStateResolved={Boolean(voucher?.place_of_supply)}
      />
    </main>
  );
}
