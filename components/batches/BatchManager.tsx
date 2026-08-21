"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";

type UnallocatedLine = {
  voucher_item_id: string;
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  item_id: string;
  item_name: string;
  uom: string;
  direction: "in" | "out";
  godown_id: string | null;
  godown_name: string | null;
  line_quantity: number;
  allocated_quantity: number;
  unallocated_quantity: number;
};

type BatchSummaryRow = {
  batch_id: string;
  item_id: string;
  item_name: string;
  uom: string;
  batch_no: string;
  mfg_date: string | null;
  expiry_date: string | null;
  days_to_expiry: number | null;
  quantity_in: number;
  quantity_out: number;
  quantity_on_hand: number;
};

type TrackedItem = { id: string; name: string; uom: string; batch_tracking: string };

function AllocateRow({
  companyId,
  line,
  onDone,
}: {
  companyId: string;
  line: UnallocatedLine;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [batchNo, setBatchNo] = useState("");
  const [mfgDate, setMfgDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [quantity, setQuantity] = useState(String(line.unallocated_quantity));
  const [busy, setBusy] = useState(false);

  async function allocate() {
    if (!batchNo.trim()) {
      toast.error("Enter a batch or serial number.");
      return;
    }
    const qty = Number(quantity);
    if (!(qty > 0)) {
      toast.error("Quantity must be greater than zero.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { data: batchId, error: batchError } = await supabase.rpc("upsert_item_batch", {
      p_company_id: companyId,
      p_item_id: line.item_id,
      p_batch_no: batchNo.trim(),
      p_mfg_date: mfgDate || undefined,
      p_expiry_date: expiryDate || undefined,
    });
    if (batchError) {
      setBusy(false);
      toast.error(batchError.message);
      return;
    }
    const { error: allocError } = await supabase.rpc("allocate_voucher_item_to_batch", {
      p_company_id: companyId,
      p_voucher_item_id: line.voucher_item_id,
      p_batch_id: batchId,
      p_quantity: qty,
    });
    setBusy(false);
    if (allocError) {
      toast.error(allocError.message);
      return;
    }
    toast.success(`Allocated ${qty} ${line.uom} to batch ${batchNo.trim()}`);
    setOpen(false);
    setBatchNo("");
    setMfgDate("");
    setExpiryDate("");
    onDone();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium text-ink hover:bg-accent-soft"
      >
        Allocate
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        placeholder="Batch/serial no."
        value={batchNo}
        onChange={(e) => setBatchNo(e.target.value)}
        className="h-8 w-28 px-2 py-1 text-xs"
      />
      <input
        type="date"
        value={mfgDate}
        onChange={(e) => setMfgDate(e.target.value)}
        title="Mfg date (optional)"
        className="h-8 w-32 rounded-md border border-border-strong bg-surface px-1.5 text-xs"
      />
      <input
        type="date"
        value={expiryDate}
        onChange={(e) => setExpiryDate(e.target.value)}
        title="Expiry date (optional)"
        className="h-8 w-32 rounded-md border border-border-strong bg-surface px-1.5 text-xs"
      />
      <input
        type="number"
        min={0}
        step="any"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        className="h-8 w-20 rounded-md border border-border-strong bg-surface px-2 text-right font-mono text-xs tabular-nums"
      />
      <Button type="button" size="sm" onClick={allocate} busy={busy} busyLabel="Saving…">
        Save
      </Button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-xs text-ink-faint hover:text-ink"
      >
        Cancel
      </button>
    </div>
  );
}

export function BatchManager({
  companyId,
  unallocatedLines,
  batchSummary,
  trackedItems,
}: {
  companyId: string;
  unallocatedLines: UnallocatedLine[];
  batchSummary: BatchSummaryRow[];
  trackedItems: TrackedItem[];
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-8">
      {trackedItems.length === 0 && (
        <div className="rounded-[14px] border border-dashed border-border-strong bg-surface px-5 py-8 text-center text-sm text-ink-faint">
          No item has batch or serial tracking turned on yet. Open an item under Items
          and set its Batch tracking field to &ldquo;Batch&rdquo; or &ldquo;Serial&rdquo;.
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Needs a batch or serial</h2>
          <span className="text-xs text-ink-faint">
            {unallocatedLines.length} line{unallocatedLines.length === 1 ? "" : "s"}
          </span>
        </div>
        {unallocatedLines.length === 0 ? (
          <EmptyState>
            {trackedItems.length === 0
              ? "Turn tracking on for an item to see its stock lines here."
              : "Every stock line on a tracked item is fully allocated to a batch or serial."}
          </EmptyState>
        ) : (
          <TableContainer>
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr>
                  <th className={th}>Voucher</th>
                  <th className={th}>Item</th>
                  <th className={th}>In/Out</th>
                  <th className={th + " text-right"}>Line qty</th>
                  <th className={th + " text-right"}>Remaining</th>
                  <th className={th}>Allocate</th>
                </tr>
              </thead>
              <tbody>
                {unallocatedLines.map((l) => (
                  <tr key={l.voucher_item_id}>
                    <td className={td}>
                      <div>{l.voucher_number}</div>
                      <div className="text-xs text-ink-faint">{l.voucher_date}</div>
                    </td>
                    <td className={td}>{l.item_name}</td>
                    <td className={td}>
                      <Badge tone={l.direction === "in" ? "ok" : "accent"}>
                        {l.direction === "in" ? "In" : "Out"}
                      </Badge>
                    </td>
                    <td className={num}>
                      {formatINR(l.line_quantity, { showZero: true })} {l.uom}
                    </td>
                    <td className={num + " font-medium text-warning"}>
                      {formatINR(l.unallocated_quantity, { showZero: true })} {l.uom}
                    </td>
                    <td className={td}>
                      <AllocateRow companyId={companyId} line={l} onDone={() => router.refresh()} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )}
        {unallocatedLines.some((l) => l.direction === "out") && (
          <p className="mt-2 text-xs text-ink-faint">
            &ldquo;Out&rdquo; lines are sale/issue lines being tagged after the fact —
            billing itself doesn&rsquo;t offer a batch picker, so this is the honest
            record of what hasn&rsquo;t been reconciled to a specific batch yet.
          </p>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-ink">Batch balances</h2>
        {batchSummary.length === 0 ? (
          <EmptyState>No batches have any stock allocated yet.</EmptyState>
        ) : (
          <TableContainer>
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr>
                  <th className={th}>Item</th>
                  <th className={th}>Batch / serial</th>
                  <th className={th}>Expiry</th>
                  <th className={th + " text-right"}>On hand</th>
                </tr>
              </thead>
              <tbody>
                {batchSummary.map((b) => (
                  <tr key={b.batch_id}>
                    <td className={td}>{b.item_name}</td>
                    <td className={td + " font-mono text-xs"}>{b.batch_no}</td>
                    <td className={td}>
                      {b.expiry_date ? (
                        <span
                          className={
                            b.days_to_expiry != null && b.days_to_expiry < 0
                              ? "text-error"
                              : b.days_to_expiry != null && b.days_to_expiry <= 30
                                ? "text-warning"
                                : "text-ink"
                          }
                        >
                          {b.expiry_date}
                          {b.days_to_expiry != null &&
                            (b.days_to_expiry < 0
                              ? ` · expired ${Math.abs(b.days_to_expiry)}d ago`
                              : ` · ${b.days_to_expiry}d left`)}
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className={num}>
                      {formatINR(b.quantity_on_hand, { showZero: true })} {b.uom}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )}
      </div>
    </div>
  );
}
