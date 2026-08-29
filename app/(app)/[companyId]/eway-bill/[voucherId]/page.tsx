import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { EwbDetailsForm } from "@/components/eway-bill/EwbDetailsForm";

/**
 * The addendum entry point: capture ship-to/transporter details for ONE
 * already-posted sales voucher, build its EWB-01 JSON, and record the real
 * e-Way Bill number once generated elsewhere. Deliberately its own route —
 * never a change to InvoiceForm/create_invoice (see 0190 migration header).
 */
export default async function EwayBillVoucherPage({
  params,
}: PageProps<"/[companyId]/eway-bill/[voucherId]">) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select("id, voucher_number, voucher_date, voucher_type, total_amount, party_ledger_id, is_deleted")
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!voucher) notFound();

  const partyName = voucher.party_ledger_id
    ? (
        await supabase.from("ledgers").select("name").eq("id", voucher.party_ledger_id).maybeSingle()
      ).data?.name ?? null
    : null;

  const { data: requirement } = await supabase
    .rpc("get_ewb_requirement", { p_voucher_id: voucherId })
    .maybeSingle();

  const { data: existing } = await supabase
    .from("ewb_details")
    .select(
      "id, transporter_id, transporter_name, vehicle_number, transport_mode, transport_doc_number, transport_doc_date, approx_distance_km, ewb_number, ewb_generated_date, ewb_valid_until, status"
    )
    .eq("voucher_id", voucherId)
    .maybeSingle();

  // The ship-to no longer lives on ewb_details. Migration 0805 moved it to
  // public.voucher_ship_to — an invoice-level fact (CGST Rule 46(o)) that
  // exists whether or not the consignment needs an e-Way Bill — precisely so
  // that the printed invoice and this payload cannot state two different
  // delivery addresses. This screen now READS it; it is entered on the
  // invoice. voucher_ship_to is not in the generated database types (owned by
  // the integration pass), hence the disabled rule, same convention as
  // ewb_vehicle_updates below.
  const { data: shipTo } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    .from("voucher_ship_to" as any)
    .select(
      "ship_to_name, ship_to_address, ship_to_city, ship_to_state_code, ship_to_pincode, ship_to_gstin"
    )
    .eq("voucher_id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle<{
      ship_to_name: string;
      ship_to_address: string;
      ship_to_city: string | null;
      ship_to_state_code: string;
      ship_to_pincode: string | null;
      ship_to_gstin: string | null;
    }>();

  const { data: states } = await supabase.from("ref_states").select("code, name").order("name");

  // Multi-vehicle Part-B history (0500) — oldest first, only meaningful once
  // a capture row exists to hang updates off. ewb_vehicle_updates is brand
  // new (migration 0500) — not yet in the generated database types (owned
  // by the integration pass), hence the disabled rule below, same
  // convention as EinvoiceDetailForm.tsx's einvoice_details.
  const { data: vehicleHistory } = existing
    ? await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        .from("ewb_vehicle_updates" as any)
        .select("id, vehicle_number, reason_code, reason, updated_at")
        .eq("ewb_detail_id", existing.id)
        .order("updated_at", { ascending: true })
    : { data: [] };

  const eligible = voucher.voucher_type === "sales";

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
          <Link href={`/${companyId}/eway-bill`} className="text-accent underline underline-offset-4">
            e-Way Bill
          </Link>
          {" / "}
          {voucher.voucher_number}
        </p>
        <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">
          {voucher.voucher_number}
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          {voucher.voucher_date} · {partyName ?? "—"} · {formatINR(Number(voucher.total_amount))}
          {voucher.is_deleted && <span className="ml-2 font-medium text-error">This voucher is deleted.</span>}
        </p>
      </header>

      {!eligible ? (
        <p className="rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          e-Way Bill details only attach to a sales voucher in this app. {voucher.voucher_number} is a{" "}
          {voucher.voucher_type.replace(/_/g, " ")} voucher.
        </p>
      ) : (
        <EwbDetailsForm
          companyId={companyId}
          voucherId={voucherId}
          consignmentValue={requirement ? Number(requirement.consignment_value) : 0}
          thresholdAmount={requirement ? Number(requirement.threshold_amount) : 50000}
          isEwbRequired={requirement?.is_ewb_required ?? false}
          existing={existing as never}
          shipTo={shipTo ?? null}
          states={states ?? []}
          vehicleHistory={(vehicleHistory ?? []) as never}
        />
      )}
    </main>
  );
}
