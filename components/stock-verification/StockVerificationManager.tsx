"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Button } from "@/components/ui/Button";
import { Input, Select, Label, Textarea } from "@/components/ui/Input";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableContainer, th, td, num } from "@/components/ui/Table";

type Item = { id: string; name: string; uom: string; batch_tracking: string };
type Godown = { id: string; code: string; name: string; branch_id: string; is_default: boolean };
type Batch = { id: string; item_id: string; batch_no: string; expiry_date: string | null };

type HistoryRow = {
  verification_id: string;
  item_id: string;
  item_name: string;
  uom: string;
  godown_id: string;
  godown_name: string;
  batch_id: string | null;
  batch_no: string | null;
  verification_date: string;
  book_quantity: number;
  physical_quantity: number;
  variance_quantity: number;
  average_rate: number;
  variance_value: number;
  adjustment_voucher_id: string | null;
  adjustment_voucher_number: string | null;
  notes: string | null;
  created_at: string;
};

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function StockVerificationManager({
  companyId,
  items,
  godowns,
  batches,
  history,
}: {
  companyId: string;
  items: Item[];
  godowns: Godown[];
  batches: Batch[];
  history: HistoryRow[];
}) {
  const router = useRouter();
  const [itemId, setItemId] = useState("");
  const [godownId, setGodownId] = useState(godowns.find((g) => g.is_default)?.id ?? godowns[0]?.id ?? "");
  const [batchId, setBatchId] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [physicalQty, setPhysicalQty] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const [preview, setPreview] = useState<{ bookQuantity: number; averageRate: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const selectedItem = items.find((i) => i.id === itemId);
  const itemBatches = batches.filter((b) => b.item_id === itemId);
  const showBatch = !!selectedItem && selectedItem.batch_tracking !== "none" && itemBatches.length > 0;

  // Batch pick is reset directly in the item selector's own onChange below
  // (not in an effect — React's own guidance is that adjusting one piece of
  // state in response to another changing belongs in the event handler that
  // changed it, not a useEffect that would trigger an extra cascading render).

  // Live book-quantity/rate preview — reuses get_stock_summary (whole item)
  // or get_batch_stock_summary (batch-scoped), the exact same reads
  // record_stock_verification itself does server-side on submit. This is
  // UX sugar only: the server call recomputes both figures fresh and is
  // the actual source of truth, never trusting what was previewed here.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!itemId || !godownId) {
        setPreview(null);
        return;
      }
      setPreviewLoading(true);
      const supabase = createClient();
      try {
        if (batchId) {
          const [{ data: batchRows }, { data: rateRows }] = await Promise.all([
            supabase.rpc("get_batch_stock_summary", {
              p_company_id: companyId,
              p_as_at: date,
              p_godown_id: godownId,
            }),
            supabase.rpc("get_stock_summary", {
              p_company_id: companyId,
              p_as_at: date,
              p_godown_id: godownId,
            }),
          ]);
          const b = (batchRows ?? []).find((r) => r.batch_id === batchId);
          const r = (rateRows ?? []).find((r) => r.item_id === itemId);
          if (!cancelled) {
            setPreview({
              bookQuantity: Number(b?.quantity_on_hand ?? 0),
              averageRate: Number(r?.average_rate ?? 0),
            });
          }
        } else {
          const { data } = await supabase.rpc("get_stock_summary", {
            p_company_id: companyId,
            p_as_at: date,
            p_godown_id: godownId,
          });
          const r = (data ?? []).find((r) => r.item_id === itemId);
          if (!cancelled) {
            setPreview({
              bookQuantity: Number(r?.closing_quantity ?? 0),
              averageRate: Number(r?.average_rate ?? 0),
            });
          }
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, itemId, godownId, batchId, date]);

  const previewVariance =
    preview && physicalQty !== "" ? Number(physicalQty) - preview.bookQuantity : null;

  async function submit() {
    if (!itemId || !godownId || physicalQty === "") {
      toast.error("Pick an item, a godown, and enter the physical count.");
      return;
    }
    if (Number(physicalQty) < 0) {
      toast.error("A physical count cannot be negative.");
      return;
    }
    const godown = godowns.find((g) => g.id === godownId);
    if (!godown) {
      toast.error("Selected godown is invalid.");
      return;
    }
    setBusy(true);
    // record_stock_verification (0165) is not yet in the generated
    // database.types.ts — same reason and shape as reports/gst-refunds and
    // reports/balance-sheet's "as unknown as" on the result below: that
    // file is owned by the integration pass' regeneration, not this task.
    const { data, error } = await createClient().rpc("record_stock_verification", {
      p_company_id: companyId,
      p_branch_id: godown.branch_id,
      p_item_id: itemId,
      p_godown_id: godownId,
      p_verification_date: date,
      p_physical_quantity: Number(physicalQty),
      p_batch_id: batchId || undefined,
      p_notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const result = (Array.isArray(data) ? data[0] : data) as unknown as {
      variance_quantity: number;
      adjustment_voucher_id: string | null;
    } | null;
    const variance = Number(result?.variance_quantity ?? 0);
    if (variance === 0) {
      toast.success("Count recorded — matches the books exactly, no adjustment needed.");
    } else if (variance > 0) {
      toast.success(`Excess of ${variance} posted as a stock adjustment.`);
    } else {
      toast.success(`Shortage of ${Math.abs(variance)} written off as a stock adjustment.`);
    }
    setPhysicalQty("");
    setNotes("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <h2 className="font-display text-lg font-semibold tracking-tight">Record a count</h2>

          {godowns.length === 0 ? (
            <EmptyState>No godown configured, so stock cannot be verified.</EmptyState>
          ) : items.length === 0 ? (
            <EmptyState>No stock-maintained items yet — add one in Items first.</EmptyState>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <label className="flex flex-col gap-1.5">
                  <Label>Item</Label>
                  <Select
                    value={itemId}
                    onChange={(e) => {
                      const nextItemId = e.target.value;
                      setItemId(nextItemId);
                      const stillValid = batches.some((b) => b.item_id === nextItemId && b.id === batchId);
                      if (batchId && !stillValid) setBatchId("");
                    }}
                  >
                    <option value="">— select —</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <Label>Godown</Label>
                  <Select value={godownId} onChange={(e) => setGodownId(e.target.value)}>
                    {godowns.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.code} — {g.name}
                      </option>
                    ))}
                  </Select>
                </label>
                {showBatch && (
                  <label className="flex flex-col gap-1.5">
                    <Label>Batch (optional)</Label>
                    <Select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
                      <option value="">Whole item, no batch</option>
                      {itemBatches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.batch_no}
                          {b.expiry_date ? ` (exp. ${b.expiry_date})` : ""}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                <label className="flex flex-col gap-1.5">
                  <Label>Verification date</Label>
                  <Input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} />
                </label>
              </div>

              {itemId && godownId && (
                <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border-strong bg-surface-2 px-4 py-3 text-sm">
                  <span className="text-ink-soft">
                    Book quantity{batchId ? " (this batch)" : ""}:
                  </span>
                  <span className="font-mono tabular-nums font-medium">
                    {previewLoading
                      ? "…"
                      : preview
                        ? `${preview.bookQuantity.toLocaleString("en-IN")} ${selectedItem?.uom ?? ""}`
                        : "—"}
                  </span>
                  <span className="text-ink-soft">Rate:</span>
                  <span className="font-mono tabular-nums font-medium">
                    {previewLoading || !preview ? "—" : formatINR(preview.averageRate)}
                  </span>
                  {previewVariance !== null && previewVariance !== 0 && (
                    <span
                      className={
                        "ml-auto rounded-md px-2 py-0.5 text-xs font-semibold " +
                        (previewVariance > 0
                          ? "bg-success-soft text-success"
                          : "bg-error-soft text-error")
                      }
                    >
                      {previewVariance > 0 ? "Excess" : "Shortage"} of{" "}
                      {Math.abs(previewVariance).toLocaleString("en-IN")} {selectedItem?.uom}
                    </span>
                  )}
                  {previewVariance === 0 && (
                    <span className="ml-auto rounded-md bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">
                      Matches the books
                    </span>
                  )}
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <label className="flex flex-col gap-1.5">
                  <Label>Physical count</Label>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={physicalQty}
                    onChange={(e) => setPhysicalQty(e.target.value)}
                    placeholder="Counted quantity"
                  />
                </label>
                <label className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
                  <Label>Notes (optional)</Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Who counted, any explanation for the variance…"
                    className="min-h-[42px]"
                  />
                </label>
              </div>

              <div className="flex justify-end">
                <Button onClick={submit} busy={busy} busyLabel="Recording…">
                  {previewVariance ? "Record & post adjustment" : "Record count"}
                </Button>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold tracking-tight">Verification history</h2>
        {history.length === 0 ? (
          <EmptyState>No physical stock verifications recorded yet.</EmptyState>
        ) : (
          <TableContainer>
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className={th}>Date</th>
                  <th className={th}>Item</th>
                  <th className={th}>Godown</th>
                  <th className={th}>Batch</th>
                  <th className={th + " text-right"}>Book</th>
                  <th className={th + " text-right"}>Physical</th>
                  <th className={th + " text-right"}>Variance</th>
                  <th className={th + " text-right"}>Value</th>
                  <th className={th}>Adjustment</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.verification_id} className="border-b border-border last:border-0">
                    <td className={td}>{h.verification_date}</td>
                    <td className={td + " font-medium"}>{h.item_name}</td>
                    <td className={td + " text-ink-soft"}>{h.godown_name}</td>
                    <td className={td + " text-ink-soft"}>{h.batch_no ?? "—"}</td>
                    <td className={num}>
                      {Number(h.book_quantity).toLocaleString("en-IN")} {h.uom}
                    </td>
                    <td className={num}>
                      {Number(h.physical_quantity).toLocaleString("en-IN")} {h.uom}
                    </td>
                    <td
                      className={
                        num +
                        (Number(h.variance_quantity) > 0
                          ? " text-success"
                          : Number(h.variance_quantity) < 0
                            ? " text-error"
                            : "")
                      }
                    >
                      {Number(h.variance_quantity) > 0 ? "+" : ""}
                      {Number(h.variance_quantity).toLocaleString("en-IN")}
                    </td>
                    <td className={num}>{formatINR(Number(h.variance_value))}</td>
                    <td className={td}>
                      {h.adjustment_voucher_number ?? (
                        <span className="text-xs text-ink-faint">No variance</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )}
      </div>

      <p className="text-xs text-ink-faint">
        A shortage or excess posts as a stock journal voucher with a
        self-cancelling &ldquo;Stock Verification Adjustment&rdquo; entry —
        same convention as Job Work and Manufacturing — so it carries a real
        quantity movement and total value for audit trail without touching
        any real P&amp;L or balance sheet ledger. See Reports → Stock Ageing
        for how long what remains has actually been sitting there.
      </p>
    </div>
  );
}
