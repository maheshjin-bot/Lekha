"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select, Label } from "@/components/ui/Input";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";

type Purpose = "approval" | "sale_or_return" | "skd_ckd" | "branch_transfer" | "exhibition" | "repair" | "other";

const PURPOSE_LABEL: Record<Purpose, string> = {
  approval: "Sent on approval",
  sale_or_return: "Sale or return",
  skd_ckd: "SKD / CKD consignment",
  branch_transfer: "Branch transfer",
  exhibition: "Exhibition",
  repair: "Repair",
  other: "Other",
};

type Challan = {
  challan_id: string;
  challan_number: string;
  challan_date: string;
  purpose: Purpose;
  party_display: string;
  item_id: string;
  item_name: string;
  hsn_sac: string | null;
  uom: string;
  quantity_sent: number;
  quantity_received: number;
  quantity_outstanding: number;
  rate: number;
  taxable_value: number;
  gst_rate_percent: number | null;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  tax_amount: number;
  supply_type: string | null;
  vehicle_number: string | null;
  transporter_name: string | null;
  reason_for_movement: string | null;
  status: "open" | "partially_received" | "closed";
};

type Item = { id: string; name: string; uom: string; gst_rate_percent: number };
type Ledger = { id: string; name: string };
type Branch = { id: string; code: string; name: string };
type Godown = { id: string; name: string; is_default: boolean; branch_id: string };

const STATUS_TONE: Record<Challan["status"], "neutral" | "accent" | "ok"> = {
  open: "accent",
  partially_received: "accent",
  closed: "ok",
};

function NewChallanForm({
  companyId,
  items,
  ledgers,
  branches,
  godowns,
}: {
  companyId: string;
  items: Item[];
  ledgers: Ledger[];
  branches: Branch[];
  godowns: Godown[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [purpose, setPurpose] = useState<Purpose>("approval");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [destinationBranchId, setDestinationBranchId] = useState("");
  const [partyLedgerId, setPartyLedgerId] = useState("");
  const [partyName, setPartyName] = useState("");
  const [partyAddress, setPartyAddress] = useState("");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [rate, setRate] = useState("");
  const [gstRate, setGstRate] = useState("");
  const [godownId, setGodownId] = useState(godowns.find((g) => g.is_default)?.id ?? godowns[0]?.id ?? "");
  const [challanDate, setChallanDate] = useState(new Date().toISOString().slice(0, 10));
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [transporterName, setTransporterName] = useState("");
  const [reason, setReason] = useState("");

  const selectedItem = items.find((i) => i.id === itemId);
  const isBranchTransfer = purpose === "branch_transfer";
  const destinationOptions = branches.filter((b) => b.id !== branchId);

  function onItemChange(id: string) {
    setItemId(id);
    const it = items.find((i) => i.id === id);
    if (it) setGstRate(String(it.gst_rate_percent ?? ""));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId || !godownId || !branchId || !(Number(quantity) > 0)) {
      toast.error("Branch, item, godown and a positive quantity are all required.");
      return;
    }
    if (isBranchTransfer && !destinationBranchId) {
      toast.error("Pick the destination branch for a branch transfer.");
      return;
    }
    if (!isBranchTransfer && !partyLedgerId && !partyName.trim()) {
      toast.error("Pick a party ledger or enter a consignee name.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("create_delivery_challan", {
      p_company_id: companyId,
      p_branch_id: branchId,
      p_purpose: purpose,
      p_item_id: itemId,
      p_quantity: Number(quantity),
      p_uom: selectedItem?.uom ?? "NOS",
      p_godown_id: godownId,
      p_rate: Number(rate) || 0,
      p_challan_date: challanDate,
      p_party_ledger_id: isBranchTransfer ? undefined : partyLedgerId || undefined,
      p_destination_branch_id: isBranchTransfer ? destinationBranchId : undefined,
      p_party_name: isBranchTransfer ? undefined : partyName.trim() || undefined,
      p_party_address: isBranchTransfer ? undefined : partyAddress.trim() || undefined,
      p_gst_rate_percent: gstRate.trim() === "" ? undefined : Number(gstRate),
      p_vehicle_number: vehicleNumber.trim() || undefined,
      p_transporter_name: transporterName.trim() || undefined,
      p_reason_for_movement: reason.trim() || undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Challan created — stock moved out.");
    setDestinationBranchId("");
    setPartyLedgerId("");
    setPartyName("");
    setPartyAddress("");
    setItemId("");
    setQuantity("1");
    setRate("");
    setGstRate("");
    setVehicleNumber("");
    setTransporterName("");
    setReason("");
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setOpen((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {open ? "Cancel" : "New challan"}
        </button>
      </div>
      {open && (
        <form onSubmit={submit} className="flex flex-col gap-4 rounded-[14px] border border-border bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5">
              <Label>Purpose</Label>
              <Select value={purpose} onChange={(e) => { setPurpose(e.target.value as Purpose); setDestinationBranchId(""); setPartyLedgerId(""); setPartyName(""); }}>
                {(Object.keys(PURPOSE_LABEL) as Purpose[]).map((p) => (
                  <option key={p} value={p}>
                    {PURPOSE_LABEL[p]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Dispatching branch</Label>
              <Select value={branchId} onChange={(e) => { setBranchId(e.target.value); setDestinationBranchId(""); }}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </label>

            {isBranchTransfer ? (
              <label className="flex flex-col gap-1.5">
                <Label>Destination branch</Label>
                <Select value={destinationBranchId} onChange={(e) => setDestinationBranchId(e.target.value)}>
                  <option value="">— select —</option>
                  {destinationOptions.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : (
              <label className="flex flex-col gap-1.5">
                <Label>Party ledger (if one exists)</Label>
                <Select value={partyLedgerId} onChange={(e) => setPartyLedgerId(e.target.value)}>
                  <option value="">— none, use name below —</option>
                  {ledgers.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}

            <label className="flex flex-col gap-1.5">
              <Label>Item</Label>
              <Select value={itemId} onChange={(e) => onItemChange(e.target.value)}>
                <option value="">— select —</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            </label>

            {!isBranchTransfer && !partyLedgerId && (
              <>
                <label className="flex flex-col gap-1.5">
                  <Label>Consignee name</Label>
                  <Input value={partyName} onChange={(e) => setPartyName(e.target.value)} placeholder="e.g. India Trade Expo Committee" />
                </label>
                <label className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label>Consignee address</Label>
                  <Input value={partyAddress} onChange={(e) => setPartyAddress(e.target.value)} placeholder="Optional" />
                </label>
              </>
            )}

            <label className="flex flex-col gap-1.5">
              <Label>Quantity ({selectedItem?.uom ?? "—"})</Label>
              <Input type="number" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Rate (₹ per unit, for the challan value)</Label>
              <Input type="number" min={0} step="any" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0" />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>GST rate % (blank = no tax shown)</Label>
              <Input type="number" min={0} max={100} step="any" value={gstRate} onChange={(e) => setGstRate(e.target.value)} placeholder="e.g. 18, or leave blank" />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Godown</Label>
              <Select value={godownId} onChange={(e) => setGodownId(e.target.value)}>
                <option value="">— select —</option>
                {godowns.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Challan date</Label>
              <Input type="date" value={challanDate} onChange={(e) => setChallanDate(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Vehicle number</Label>
              <Input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} placeholder="Optional" />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Transporter</Label>
              <Input value={transporterName} onChange={(e) => setTransporterName(e.target.value)} placeholder="Optional" />
            </label>
            <label className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-4">
              <Label>Reason for movement (printed on the challan)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Display at Pragati Maidan trade fair, 12–18 Sep" />
            </label>
          </div>
          {purpose === "skd_ckd" && (
            <p className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-ink">
              Rule 55(5) requires a complete tax invoice for the full consignment value before (or with) the
              first shipment — this screen does not create or link that invoice. Issue it separately through
              the normal sales flow; use this challan only for the physical delivery paperwork on each
              part-shipment, referencing that invoice number.
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" busy={busy} busyLabel="Posting…">
              Create challan
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ReceiptRow({ companyId, c, onDone }: { companyId: string; c: Challan; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receivedDate, setReceivedDate] = useState(new Date().toISOString().slice(0, 10));
  const [receivedQty, setReceivedQty] = useState(String(c.quantity_outstanding));
  const [notes, setNotes] = useState("");

  async function submit() {
    const received = Number(receivedQty) || 0;
    if (received <= 0) {
      toast.error("Enter a received quantity greater than zero.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("create_delivery_challan_receipt", {
      p_company_id: companyId,
      p_challan_id: c.challan_id,
      p_received_date: receivedDate,
      p_quantity_received: received,
      p_notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Receipt recorded.");
    setOpen(false);
    onDone();
  }

  if (c.status === "closed") {
    return <span className="text-xs text-ink-faint">—</span>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium text-ink hover:bg-accent-soft"
      >
        Record receipt
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-2 p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} className="h-8 rounded-md border border-border-strong bg-surface px-2" />
        <input
          type="number"
          min={0}
          step="any"
          value={receivedQty}
          onChange={(e) => setReceivedQty(e.target.value)}
          placeholder="Received qty"
          className="h-8 w-24 rounded-md border border-border-strong bg-surface px-2"
        />
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          className="h-8 min-w-[140px] flex-1 rounded-md border border-border-strong bg-surface px-2"
        />
      </div>
      <p className="text-xs text-ink-faint">
        Still outstanding on this challan: {formatINR(c.quantity_outstanding, { showZero: true })} {c.uom}
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} busy={busy} busyLabel="Saving…">
          Confirm
        </Button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-faint hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function DeliveryChallanManager({
  companyId,
  challans,
  items,
  ledgers,
  branches,
  godowns,
}: {
  companyId: string;
  challans: Challan[];
  items: Item[];
  ledgers: Ledger[];
  branches: Branch[];
  godowns: Godown[];
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-6">
      <NewChallanForm companyId={companyId} items={items} ledgers={ledgers} branches={branches} godowns={godowns} />

      {challans.length === 0 ? (
        <EmptyState>No delivery challans yet.</EmptyState>
      ) : (
        <TableContainer>
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr>
                <th className={th}>Challan</th>
                <th className={th}>Purpose</th>
                <th className={th}>Party / destination</th>
                <th className={th}>Item</th>
                <th className={th + " text-right"}>Sent</th>
                <th className={th + " text-right"}>Outstanding</th>
                <th className={th + " text-right"}>Taxable value</th>
                <th className={th + " text-right"}>Tax</th>
                <th className={th}>Status</th>
                <th className={th}>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {challans.map((c) => (
                <tr key={c.challan_id}>
                  <td className={td}>
                    <div>{c.challan_number}</div>
                    <div className="text-xs text-ink-faint">{c.challan_date}</div>
                    {(c.vehicle_number || c.transporter_name) && (
                      <div className="text-xs text-ink-faint">
                        {[c.vehicle_number, c.transporter_name].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className={td}>{PURPOSE_LABEL[c.purpose]}</td>
                  <td className={td}>{c.party_display}</td>
                  <td className={td}>
                    {c.item_name}
                    {c.hsn_sac && <div className="text-xs text-ink-faint">HSN {c.hsn_sac}</div>}
                  </td>
                  <td className={num}>
                    {formatINR(c.quantity_sent, { showZero: true })} {c.uom}
                  </td>
                  <td className={num + (c.quantity_outstanding > 0 ? " font-medium text-warning" : "")}>
                    {formatINR(c.quantity_outstanding, { showZero: true })} {c.uom}
                  </td>
                  <td className={num}>₹{formatINR(c.taxable_value, { showZero: true })}</td>
                  <td className={num}>
                    {c.gst_rate_percent == null ? (
                      <span className="text-ink-faint">No tax</span>
                    ) : (
                      <>
                        ₹{formatINR(c.tax_amount, { showZero: true })}
                        <div className="text-xs text-ink-faint">
                          {c.gst_rate_percent}% {c.supply_type === "inter" ? "IGST" : c.supply_type === "intra" ? "CGST+SGST" : ""}
                        </div>
                      </>
                    )}
                  </td>
                  <td className={td}>
                    <Badge tone={STATUS_TONE[c.status]}>{c.status.replace("_", " ")}</Badge>
                  </td>
                  <td className={td}>
                    <ReceiptRow companyId={companyId} c={c} onDone={() => router.refresh()} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}

      <p className="text-xs text-ink-faint">
        A Rule 55 delivery challan replaces a tax invoice for goods that move without being
        sold yet — sending stock out is real (it leaves the godown), but no supply has
        happened, so nothing here touches your P&amp;L or a party&rsquo;s ledger balance.
        Recording a receipt is a proof-of-delivery acknowledgment, not a second stock
        movement — it does not bring goods back into a godown by itself. Branch transfer is
        only offered between branches on the same GST registration; a transfer between
        different registrations is a taxable supply and needs a real invoice instead.
      </p>
    </div>
  );
}
