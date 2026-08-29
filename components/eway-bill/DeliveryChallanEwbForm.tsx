"use client";

import { useState } from "react";
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
  to_state_code: string | null;
  to_pincode: string | null;
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

/** timestamptz -> value an <input type="datetime-local"> accepts, and back. */
function toLocalInput(v: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Create-or-edit for the ONE delivery_challan_ewb_details row a challan can
 * have (v1 scope — mirrors EwbDetailsForm/ewb_details, 0190/0500), plus the
 * "Build EWB JSON" action and manual real-EWB-number capture. No
 * bill-to/ship-to split — a Rule 55 challan has no invoice, just one
 * consignee, already identified on the challan itself. Never touches
 * delivery_challans' own core posting logic (create_delivery_challan/
 * create_delivery_challan_receipt).
 */
export function DeliveryChallanEwbForm({
  companyId,
  challanId,
  consignmentValue,
  thresholdAmount,
  isEwbRequired,
  existing,
  states,
  toStateResolved,
}: {
  companyId: string;
  challanId: string;
  consignmentValue: number;
  thresholdAmount: number;
  isEwbRequired: boolean;
  existing: Existing;
  states: { code: string; name: string }[];
  /** Whether the challan's own place_of_supply already resolved a to-state (ledger/destination branch) — if not, to_state_code below is required for a usable JSON. */
  toStateResolved: boolean;
}) {
  const router = useRouter();

  const [toStateCode, setToStateCode] = useState(existing?.to_state_code ?? "");
  const [toPincode, setToPincode] = useState(existing?.to_pincode ?? "");

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const supabase = createClient();
    const row = {
      company_id: companyId,
      challan_id: challanId,
      to_state_code: toStateCode || null,
      to_pincode: toPincode.trim() || null,
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

    // delivery_challan_ewb_details is brand new (migration 0500) — not yet
    // in the generated database types (owned by the integration pass),
    // hence the disabled rule below each, same convention as
    // EinvoiceDetailForm.tsx's einvoice_details.
    const { error } = existing
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        await supabase.from("delivery_challan_ewb_details" as any).update(row).eq("id", existing.id)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        await supabase.from("delivery_challan_ewb_details" as any).insert(row);

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
    // build_delivery_challan_ewb_json is brand new (migration 0500) — not
    // yet in the generated database types (owned by the integration pass).
    const { data, error } = await supabase.rpc(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      "build_delivery_challan_ewb_json" as any,
      { p_challan_id: challanId }
    );
    setBuilding(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setPayload(JSON.stringify(data, null, 2));
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
    a.download = `ewb-01-challan-${challanId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-[14px] border border-border bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Consignment value (Rule 138)</h2>
            <p className="mt-1 text-xs text-ink-faint">
              Quantity sent × rate, plus tax at the rate shown on the challan (zero when no tax is
              shown — the honest state for a same-GSTIN movement).
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
        <div>
          <h2 className="text-sm font-semibold text-ink">Destination state / PIN</h2>
          <p className="mt-1 text-xs text-ink-faint">
            {toStateResolved
              ? "The challan already resolved a destination state (from the party ledger or destination branch) — fill these in only to override it."
              : "This challan could not resolve a destination state on its own (a free-text consignee with no ledger) — fill this in so the EWB JSON has a usable toStateCode."}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <Label>Destination state</Label>
              <Select value={toStateCode} onChange={(e) => setToStateCode(e.target.value)}>
                <option value="">{toStateResolved ? "Use the challan's own" : "Not set"}</option>
                {states.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Destination PIN code</Label>
              <Input
                value={toPincode}
                onChange={(e) => setToPincode(e.target.value)}
                placeholder="6 digits"
                maxLength={6}
              />
            </label>
          </div>
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
            This app never calls the NIC e-Way Bill API. Generate the e-Way Bill on ewaybillgst.gov.in or
            your GSP using the JSON below, then paste the real number and validity here.
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

      <div className="rounded-[14px] border border-border bg-surface p-5 shadow-card">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">EWB-01 JSON payload</h2>
            <p className="mt-1 text-xs text-ink-faint">
              docType CHL (Delivery Challan), no invoice or tax involved unless a rate is shown on the
              challan itself. Save your changes first — this always builds from the last saved row.
            </p>
          </div>
          <Button type="button" variant="ghost" onClick={buildJson} busy={building} busyLabel="Building…">
            Build EWB JSON
          </Button>
        </div>

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
            This challan is under the ₹{thresholdAmount.toLocaleString("en-IN")} threshold — the JSON can
            still be built, but an e-Way Bill is not mandatory for it.
          </Alert>
        )}
      </div>
    </div>
  );
}
