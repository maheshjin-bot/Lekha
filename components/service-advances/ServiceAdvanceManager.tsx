"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td, num } from "@/components/ui/Table";

type TaggableVoucher = {
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  party_ledger_id: string;
  party_name: string;
  received_amount: number;
  already_tagged_amount: number;
  available_amount: number;
};

type Advance = {
  id: string;
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  party_ledger_id: string;
  party_name: string;
  advance_amount: number;
  gst_rate_percent: number;
  rate_not_determinable: boolean;
  cess_rate_percent: number;
  place_of_supply: string;
  place_of_supply_name: string | null;
  taxable_value: number;
  gst_amount: number;
  cess_amount: number;
  status: "outstanding" | "adjusted";
  adjusted_voucher_id: string | null;
  adjusted_voucher_number: string | null;
  adjusted_voucher_date: string | null;
  adjusted_note: string | null;
  adjusted_at: string | null;
  notes: string | null;
  created_at: string;
};

type SalesVoucher = { id: string; voucher_number: string; voucher_date: string; party_ledger_id: string | null };
type StateRow = { code: string; name: string };

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

export function ServiceAdvanceManager({
  companyId,
  taggableVouchers,
  advances,
  salesVouchers,
  states,
}: {
  companyId: string;
  taggableVouchers: TaggableVoucher[];
  advances: Advance[];
  salesVouchers: SalesVoucher[];
  states: StateRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [tab, setTab] = useState<"outstanding" | "adjusted">("outstanding");

  const [voucherId, setVoucherId] = useState("");
  const [amount, setAmount] = useState("");
  const [gstRate, setGstRate] = useState("18");
  const [rateUnknown, setRateUnknown] = useState(false);
  const [cessRate, setCessRate] = useState("0");
  const [pos, setPos] = useState("");
  const [notes, setNotes] = useState("");

  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustVoucherId, setAdjustVoucherId] = useState("");
  const [adjustNote, setAdjustNote] = useState("");

  const selectedVoucher = taggableVouchers.find((v) => v.voucher_id === voucherId);

  const rows = useMemo(() => advances.filter((a) => a.status === tab), [advances, tab]);
  const outstandingTotal = useMemo(
    () => advances.filter((a) => a.status === "outstanding").reduce((n, a) => n + a.gst_amount + a.cess_amount, 0),
    [advances]
  );

  async function tagAdvance(e: React.FormEvent) {
    e.preventDefault();
    if (!voucherId) {
      toast.error("Pick a receipt voucher.");
      return;
    }
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      toast.error("Enter the advance amount.");
      return;
    }
    if (!pos) {
      toast.error("Pick the place of supply.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("create_service_advance_receipt", {
      p_company_id: companyId,
      p_voucher_id: voucherId,
      p_advance_amount: amt,
      p_gst_rate_percent: rateUnknown ? 18 : Number(gstRate) || 0,
      p_place_of_supply: pos,
      p_cess_rate_percent: Number(cessRate) || 0,
      p_rate_not_determinable: rateUnknown,
      p_notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Advance tagged — GST liability recorded");
    setVoucherId("");
    setAmount("");
    setGstRate("18");
    setRateUnknown(false);
    setCessRate("0");
    setPos("");
    setNotes("");
    setShowForm(false);
    router.refresh();
  }

  async function markAdjusted(advanceId: string) {
    if (!adjustVoucherId) {
      toast.error("Pick the invoice this advance was adjusted against.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("mark_service_advance_adjusted", {
      p_company_id: companyId,
      p_advance_id: advanceId,
      p_adjusted_voucher_id: adjustVoucherId,
      p_adjusted_note: adjustNote.trim() || undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Marked adjusted");
    setAdjustingId(null);
    setAdjustVoucherId("");
    setAdjustNote("");
    router.refresh();
  }

  async function unmarkAdjusted(advanceId: string) {
    setBusy(true);
    const { error } = await createClient().rpc("unmark_service_advance_adjusted", {
      p_company_id: companyId,
      p_advance_id: advanceId,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reverted to outstanding");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2 text-sm">
          <button
            type="button"
            onClick={() => setTab("outstanding")}
            className={
              "rounded-md border px-2.5 py-1 " +
              (tab === "outstanding" ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
            }
          >
            Outstanding ({advances.filter((a) => a.status === "outstanding").length})
          </button>
          <button
            type="button"
            onClick={() => setTab("adjusted")}
            className={
              "rounded-md border px-2.5 py-1 " +
              (tab === "adjusted" ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
            }
          >
            Adjusted ({advances.filter((a) => a.status === "adjusted").length})
          </button>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm text-ink-soft">
            Outstanding GST liability: <span className="font-semibold text-ink">{formatINR(outstandingTotal, { showZero: true })}</span>
          </p>
          <button
            type="button"
            onClick={() => setShowForm((s) => !s)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
          >
            {showForm ? "Cancel" : "Tag a new advance"}
          </button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={tagAdvance} className="flex flex-col gap-4 rounded-[14px] border border-border bg-surface p-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Receipt voucher</span>
            <select value={voucherId} onChange={(e) => setVoucherId(e.target.value)} className={field}>
              <option value="">— pick a receipt with an untagged amount —</option>
              {taggableVouchers.map((v) => (
                <option key={v.voucher_id} value={v.voucher_id}>
                  {v.voucher_number} · {v.voucher_date} · {v.party_name} · untagged {formatINR(v.available_amount, { showZero: true })}
                </option>
              ))}
            </select>
            {taggableVouchers.length === 0 && (
              <span className="text-xs text-ink-faint">
                No receipt voucher currently has an untagged amount against a customer ledger.
              </span>
            )}
          </label>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Advance amount (₹, inclusive of GST)</span>
              <input
                type="number"
                min={0}
                step="0.01"
                max={selectedVoucher?.available_amount}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={field}
                placeholder={selectedVoucher ? String(selectedVoucher.available_amount) : undefined}
              />
              {selectedVoucher && (
                <span className="text-xs text-ink-faint">
                  Up to {formatINR(selectedVoucher.available_amount, { showZero: true })} untagged on this voucher.
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">GST rate %</span>
              <input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={rateUnknown ? "18" : gstRate}
                disabled={rateUnknown}
                onChange={(e) => setGstRate(e.target.value)}
                className={field + " disabled:opacity-60"}
              />
              <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                <input type="checkbox" checked={rateUnknown} onChange={(e) => setRateUnknown(e.target.checked)} />
                Rate not known yet — use Rule 50&rsquo;s 18% default
              </label>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Cess rate % (if any)</span>
              <input type="number" min={0} step="0.01" value={cessRate} onChange={(e) => setCessRate(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Place of supply</span>
              <select value={pos} onChange={(e) => setPos(e.target.value)} className={field}>
                <option value="">— select state —</option>
                {states.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={field} />
          </label>

          <button
            type="submit"
            disabled={busy}
            className="w-fit rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Tag advance
          </button>
        </form>
      )}

      <TableContainer>
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Receipt</th>
              <th className={th}>Customer</th>
              <th className={th + " text-right"}>Advance (incl. tax)</th>
              <th className={th + " text-right"}>Taxable value</th>
              <th className={th + " text-right"}>Rate</th>
              <th className={th}>POS</th>
              <th className={th + " text-right"}>GST + Cess due</th>
              <th className={th}>{tab === "adjusted" ? "Adjusted against" : "Action"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-ink-faint">
                  {tab === "outstanding" ? "No outstanding service advances." : "Nothing has been adjusted yet."}
                </td>
              </tr>
            )}
            {rows.map((a) => (
              <>
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className={td + " font-mono text-xs"}>
                    {a.voucher_number}
                    <div className="text-ink-faint">{a.voucher_date}</div>
                  </td>
                  <td className={td}>{a.party_name}</td>
                  <td className={num}>{formatINR(a.advance_amount, { showZero: true })}</td>
                  <td className={num}>{formatINR(a.taxable_value, { showZero: true })}</td>
                  <td className={num}>
                    {Number(a.gst_rate_percent)}%{a.cess_rate_percent > 0 ? ` +${Number(a.cess_rate_percent)}% cess` : ""}
                    {a.rate_not_determinable && (
                      <div>
                        <Badge tone="warn">Rule 50 default</Badge>
                      </div>
                    )}
                  </td>
                  <td className={td}>{a.place_of_supply_name ?? a.place_of_supply}</td>
                  <td className={num + " font-medium"}>{formatINR(a.gst_amount + a.cess_amount, { showZero: true })}</td>
                  <td className={td}>
                    {tab === "outstanding" ? (
                      <button
                        type="button"
                        onClick={() => setAdjustingId(adjustingId === a.id ? null : a.id)}
                        className="text-xs text-accent underline underline-offset-2"
                      >
                        Mark adjusted
                      </button>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <span className="text-xs">
                          {a.adjusted_voucher_number} · {a.adjusted_voucher_date}
                        </span>
                        {a.adjusted_note && <span className="text-xs text-ink-faint">{a.adjusted_note}</span>}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => unmarkAdjusted(a.id)}
                          className="w-fit text-xs text-error underline underline-offset-2 disabled:opacity-50"
                        >
                          Revert to outstanding
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
                {adjustingId === a.id && (
                  <tr className="border-b border-border bg-bg">
                    <td colSpan={8} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="flex flex-1 min-w-[240px] flex-col gap-1">
                          <span className="text-xs font-medium">Invoice raised for {a.party_name}</span>
                          <select value={adjustVoucherId} onChange={(e) => setAdjustVoucherId(e.target.value)} className={field}>
                            <option value="">— pick the sales invoice —</option>
                            {salesVouchers
                              .filter((sv) => sv.party_ledger_id === a.party_ledger_id)
                              .map((sv) => (
                                <option key={sv.id} value={sv.id}>
                                  {sv.voucher_number} · {sv.voucher_date}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className="flex flex-1 min-w-[200px] flex-col gap-1">
                          <span className="text-xs font-medium">Note (optional)</span>
                          <input value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} className={field} />
                        </label>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => markAdjusted(a.id)}
                          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                        >
                          Confirm
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </TableContainer>
    </div>
  );
}
