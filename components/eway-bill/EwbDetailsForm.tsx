"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Input, Select, Label } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { formatINR } from "@/lib/utils/currency";

type Existing = {
  id: string;
  transporter_id: string | null;
  transporter_name: string | null;
  vehicle_number: string | null;
  transport_mode: "road" | "rail" | "air" | "ship";
  transport_doc_number: string | null;
  transport_doc_date: string | null;
  approx_distance_km: number | null;
  ewb_number: string | null;
  ewb_generated_date: string | null;
  ewb_valid_until: string | null;
  status: "not_generated" | "generated" | "cancelled";
} | null;

/**
 * The invoice's own delivery address (public.voucher_ship_to, migration
 * 0805). READ here, never written: the ship-to used to be five nullable
 * columns on ewb_details, which meant one sales voucher could carry a
 * different delivery address on its printed invoice than in its EWB-01
 * payload. 0805 moved it to one invoice-level row, so this screen shows what
 * the invoice says and sends the preparer to the invoice to change it.
 */
type ShipTo = {
  ship_to_name: string;
  ship_to_address: string;
  ship_to_city: string | null;
  ship_to_state_code: string;
  ship_to_pincode: string | null;
  ship_to_gstin: string | null;
} | null;

type VehicleUpdate = {
  id: string;
  vehicle_number: string;
  reason_code: "breakdown" | "transhipment" | "other" | "first_time" | null;
  reason: string | null;
  updated_at: string;
};

const REASON_LABEL: Record<string, string> = {
  breakdown: "Vehicle broke down",
  transhipment: "Trans-shipped to another vehicle",
  first_time: "First vehicle",
  other: "Other",
};

/** timestamptz -> value an <input type="datetime-local"> accepts, and back. */
function toLocalInput(v: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Create-or-edit for the ONE ewb_details row a sales voucher can have (v1
 * scope — see 0190 migration header), plus the "Build EWB JSON" action and
 * the manual real-EWB-number capture fields. Never touches InvoiceForm/
 * create_invoice/VoucherForm — this is a pure addendum screen.
 */
export function EwbDetailsForm({
  companyId,
  voucherId,
  consignmentValue,
  thresholdAmount,
  isEwbRequired,
  existing,
  shipTo,
  states,
  vehicleHistory,
}: {
  companyId: string;
  voucherId: string;
  consignmentValue: number;
  thresholdAmount: number;
  isEwbRequired: boolean;
  existing: Existing;
  shipTo: ShipTo;
  states: { code: string; name: string }[];
  vehicleHistory: VehicleUpdate[];
}) {
  const router = useRouter();

  const [transporterId, setTransporterId] = useState(existing?.transporter_id ?? "");
  const [transporterName, setTransporterName] = useState(existing?.transporter_name ?? "");
  const [vehicleNumber, setVehicleNumber] = useState(existing?.vehicle_number ?? "");
  const [transportMode, setTransportMode] = useState(existing?.transport_mode ?? "road");
  const [transportDocNumber, setTransportDocNumber] = useState(existing?.transport_doc_number ?? "");
  const [transportDocDate, setTransportDocDate] = useState(existing?.transport_doc_date ?? "");
  const [approxDistanceKm, setApproxDistanceKm] = useState(
    existing?.approx_distance_km != null ? String(existing.approx_distance_km) : ""
  );

  const [ewbNumber, setEwbNumber] = useState(existing?.ewb_number ?? "");
  const [ewbGeneratedDate, setEwbGeneratedDate] = useState(toLocalInput(existing?.ewb_generated_date ?? null));
  const [ewbValidUntil, setEwbValidUntil] = useState(toLocalInput(existing?.ewb_valid_until ?? null));
  const [status, setStatus] = useState<"not_generated" | "generated" | "cancelled">(
    existing?.status ?? "not_generated"
  );

  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [payload, setPayload] = useState<string | null>(null);
  // 1310. build_ewb_json silently null'd fromAddr1/fromPlace/fromPincode
  // when the branch has no address on file, with nothing to tell the
  // preparer why — a real NIC submission would likely reject this exact
  // payload (the e-invoice build refuses outright for the identical gap;
  // this one still builds the JSON, but now says so via a new
  // meta.warnings array).
  const [payloadWarnings, setPayloadWarnings] = useState<string[]>([]);

  const [newVehicleNumber, setNewVehicleNumber] = useState("");
  const [newReasonCode, setNewReasonCode] = useState<"breakdown" | "transhipment" | "other">("transhipment");
  const [newReason, setNewReason] = useState("");
  const [addingVehicle, setAddingVehicle] = useState(false);

  async function addVehicleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!existing) return;
    setAddingVehicle(true);
    const supabase = createClient();
    // ewb_vehicle_updates is brand new (migration 0500) — not yet in the
    // generated database types (owned by the integration pass), hence the
    // disabled rule below, same convention as EinvoiceDetailForm.tsx's
    // einvoice_details.
    const { error } = await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .from("ewb_vehicle_updates" as any)
      .insert({
        company_id: companyId,
        ewb_detail_id: existing.id,
        vehicle_number: newVehicleNumber.trim(),
        reason_code: newReasonCode,
        reason: newReason.trim() || null,
      });
    setAddingVehicle(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Vehicle update recorded.");
    setNewVehicleNumber("");
    setNewReason("");
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const supabase = createClient();
    const row = {
      company_id: companyId,
      voucher_id: voucherId,
      transporter_id: transporterId.trim() || null,
      transporter_name: transporterName.trim() || null,
      vehicle_number: vehicleNumber.trim() || null,
      transport_mode: transportMode,
      transport_doc_number: transportDocNumber.trim() || null,
      transport_doc_date: transportDocDate || null,
      approx_distance_km: approxDistanceKm ? Number(approxDistanceKm) : null,
      ewb_number: ewbNumber.trim() || null,
      ewb_generated_date: ewbGeneratedDate ? new Date(ewbGeneratedDate).toISOString() : null,
      ewb_valid_until: ewbValidUntil ? new Date(ewbValidUntil).toISOString() : null,
      status,
    };

    const { error } = existing
      ? await supabase.from("ewb_details").update(row).eq("id", existing.id)
      : await supabase.from("ewb_details").insert(row);

    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(existing ? "e-Way Bill details updated." : "e-Way Bill details saved.");
    router.refresh();
  }

  async function buildJson() {
    setBuilding(true);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("build_ewb_json", { p_voucher_id: voucherId });
    setBuilding(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setPayload(JSON.stringify(data, null, 2));
    const warnings = (data as { meta?: { warnings?: string[] } })?.meta?.warnings;
    setPayloadWarnings(Array.isArray(warnings) ? warnings : []);
  }

  function copyJson() {
    if (!payload) return;
    navigator.clipboard.writeText(payload).then(
      () => toast.success("Copied to clipboard."),
      () => toast.error("Couldn't copy — select and copy manually.")
    );
  }

  function downloadJson() {
    if (!payload) return;
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ewb-01-${voucherId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-[14px] border border-border bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Consignment value (Rule 138 Explanation 2)</h2>
            <p className="mt-1 text-xs text-ink-faint">
              Taxable value of goods + actual posted CGST/SGST/IGST/cess — excludes TCS and, on a mixed
              invoice, the value of any exempt/nil-rated line.
            </p>
          </div>
          <div className="text-right">
            <div className="font-mono text-lg font-semibold tabular-nums text-ink">
              {formatINR(consignmentValue)}
            </div>
            <Badge tone={isEwbRequired ? "bad" : "ok"}>
              {isEwbRequired
                ? `Over the ${formatINR(thresholdAmount)} threshold — e-Way Bill required`
                : `Under the ${formatINR(thresholdAmount)} threshold`}
            </Badge>
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-6 rounded-[14px] border border-border bg-surface p-5 shadow-card">
        {/* Read-only. The delivery address is an INVOICE fact (CGST Rule
            46(o) — "address of delivery where the same is different from the
            place of supply") and since 0805 it is stored once, on the
            invoice, so a printed invoice and its EWB-01 payload cannot
            disagree about where the goods went. Entered on the invoice, shown
            here. */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">Ship-to</h2>
            <Link
              href={`/${companyId}/invoices/${voucherId}/edit`}
              className="text-xs text-accent underline underline-offset-4"
            >
              {shipTo ? "Change on the invoice" : "Add one on the invoice"}
            </Link>
          </div>
          {shipTo ? (
            <>
              <p className="mt-1 text-xs text-ink-faint">
                Taken from the invoice — the same address it prints. This is a &ldquo;Bill To &ndash;
                Ship To&rdquo; movement, EWB-01 transaction type 2.
              </p>
              <div className="mt-3 rounded-lg border border-border bg-bg px-4 py-3 text-sm text-ink">
                <div className="font-medium">{shipTo.ship_to_name}</div>
                <div className="mt-0.5 whitespace-pre-line text-ink-soft">{shipTo.ship_to_address}</div>
                <div className="mt-0.5 text-ink-soft">
                  {[
                    shipTo.ship_to_city,
                    states.find((st) => st.code === shipTo.ship_to_state_code)?.name ??
                      shipTo.ship_to_state_code,
                    shipTo.ship_to_pincode,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {shipTo.ship_to_gstin && (
                  <div className="mt-1 font-mono text-xs text-ink-faint">
                    GSTIN {shipTo.ship_to_gstin}
                  </div>
                )}
              </div>
              <p className="mt-2 text-xs text-ink-faint">
                The tax head does not follow this address. Under Sec 10(1)(b) IGST Act the place of
                supply of a bill-to/ship-to supply is the principal place of business of the party
                directing the delivery, so it stays with the billed party; this state feeds
                actToStateCode and the Rule 138 threshold only.
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-ink-faint">
              No separate delivery address on this invoice, so the goods go where the bill goes: the
              payload uses the party&rsquo;s own address and marks a Regular transaction. Record one on
              the invoice when the delivery address genuinely differs &mdash; that is a distinct EWB-01
              transaction type, not just a label.
            </p>
          )}
        </div>

        <div className="border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-ink">Transporter &amp; vehicle</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <Label>Transporter ID / GSTIN</Label>
              <Input
                value={transporterId}
                onChange={(e) => setTransporterId(e.target.value.toUpperCase())}
                placeholder="15-character Transporter ID or GSTIN"
                maxLength={15}
                className="font-mono uppercase"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Transporter name</Label>
              <Input value={transporterName} onChange={(e) => setTransporterName(e.target.value)} placeholder="Optional" />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Vehicle number</Label>
              <Input
                value={vehicleNumber}
                onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
                placeholder="e.g. MH12AB1234"
                className="font-mono uppercase"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Mode of transport</Label>
              <Select value={transportMode} onChange={(e) => setTransportMode(e.target.value as typeof transportMode)}>
                <option value="road">Road</option>
                <option value="rail">Rail</option>
                <option value="air">Air</option>
                <option value="ship">Ship</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Transport document number</Label>
              <Input value={transportDocNumber} onChange={(e) => setTransportDocNumber(e.target.value)} placeholder="LR/RR/airway bill no." />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Transport document date</Label>
              <Input type="date" value={transportDocDate} onChange={(e) => setTransportDocDate(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Approximate distance (km)</Label>
              <Input
                type="number"
                min={1}
                value={approxDistanceKm}
                onChange={(e) => setApproxDistanceKm(e.target.value)}
                placeholder="Portal auto-suggests from PIN codes; enter your own estimate"
              />
            </label>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-ink">Real e-Way Bill (record once generated elsewhere)</h2>
          <p className="mt-1 text-xs text-ink-faint">
            This app never calls the NIC e-Way Bill API. Generate the e-Way Bill on ewaybillgst.gov.in or your
            GSP using the JSON below, then paste the real number and validity here.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <Label>EWB number</Label>
              <Input
                value={ewbNumber}
                onChange={(e) => setEwbNumber(e.target.value.replace(/\D/g, ""))}
                placeholder="12 digits"
                maxLength={12}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Generated at</Label>
              <Input type="datetime-local" value={ewbGeneratedDate} onChange={(e) => setEwbGeneratedDate(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Valid until</Label>
              <Input type="datetime-local" value={ewbValidUntil} onChange={(e) => setEwbValidUntil(e.target.value)} />
            </label>
          </div>
          {ewbNumber.trim() && (
            <label className="mt-3 flex flex-col gap-1.5 sm:w-56">
              <Label>Status</Label>
              <Select value={status} onChange={(e) => setStatus(e.target.value as "generated" | "cancelled")}>
                <option value="generated">Generated</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </label>
          )}
        </div>

        <div className="flex justify-end">
          <Button type="submit" busy={busy} busyLabel="Saving…">
            {existing ? "Save changes" : "Save e-Way Bill details"}
          </Button>
        </div>
      </form>

      {existing && (
        <div className="rounded-[14px] border border-border bg-surface p-5 shadow-card">
          <h2 className="text-sm font-semibold text-ink">Vehicle history (multi-vehicle Part-B)</h2>
          <p className="mt-1 text-xs text-ink-faint">
            Record a vehicle CHANGE mid-journey (trans-shipment, breakdown) — the &ldquo;Vehicle
            number&rdquo; field above always stays the current one; every change is also kept here,
            oldest first.
          </p>

          {vehicleHistory.length > 0 && (
            <ol className="mt-3 flex flex-col gap-2 border-l-2 border-border pl-4">
              {vehicleHistory.map((v) => (
                <li key={v.id} className="text-sm">
                  <span className="font-mono font-medium text-ink">{v.vehicle_number}</span>
                  <span className="ml-2 text-xs text-ink-faint">
                    {new Date(v.updated_at).toLocaleString("en-IN")}
                    {v.reason_code && ` · ${REASON_LABEL[v.reason_code] ?? v.reason_code}`}
                  </span>
                  {v.reason && <div className="text-xs text-ink-faint">{v.reason}</div>}
                </li>
              ))}
            </ol>
          )}

          <form onSubmit={addVehicleUpdate} className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-4">
            <label className="flex flex-col gap-1.5">
              <Label>New vehicle number</Label>
              <Input
                value={newVehicleNumber}
                onChange={(e) => setNewVehicleNumber(e.target.value.toUpperCase())}
                placeholder="e.g. HR26XY7890"
                className="font-mono uppercase"
                required
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Reason</Label>
              <Select value={newReasonCode} onChange={(e) => setNewReasonCode(e.target.value as typeof newReasonCode)}>
                <option value="transhipment">Trans-shipment</option>
                <option value="breakdown">Vehicle broke down</option>
                <option value="other">Other</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <Label>Remarks (optional)</Label>
              <Input value={newReason} onChange={(e) => setNewReason(e.target.value)} placeholder="Optional detail" />
            </label>
            <div className="sm:col-span-4">
              <Button type="submit" variant="ghost" size="sm" busy={addingVehicle} busyLabel="Recording…">
                Record vehicle update
              </Button>
            </div>
          </form>
        </div>
      )}

      <div className="rounded-[14px] border border-border bg-surface p-5 shadow-card">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">EWB-01 JSON payload</h2>
            <p className="mt-1 text-xs text-ink-faint">
              Built from this voucher&rsquo;s own posted data plus whatever is saved above. Save your changes
              first — this always builds from the last saved row, not the unsaved form.
            </p>
          </div>
          <Button type="button" variant="ghost" onClick={buildJson} busy={building} busyLabel="Building…">
            Build EWB JSON
          </Button>
        </div>

        {payload && payloadWarnings.length > 0 && (
          <Alert tone="warning" className="mt-4">
            <ul className="list-disc space-y-1 pl-4">
              {payloadWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Alert>
        )}

        {payload && (
          <div className="mt-4">
            <div className="mb-2 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={copyJson}>
                Copy
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={downloadJson}>
                Download .json
              </Button>
            </div>
            <pre className="max-h-96 overflow-auto rounded-lg bg-surface-2 p-4 text-xs text-ink">{payload}</pre>
          </div>
        )}

        {!isEwbRequired && !payload && (
          <Alert tone="warning" className="mt-4">
            This voucher is under the ₹{thresholdAmount.toLocaleString("en-IN")} threshold — the JSON can still
            be built, but an e-Way Bill is not mandatory for it.
          </Alert>
        )}
      </div>
    </div>
  );
}
