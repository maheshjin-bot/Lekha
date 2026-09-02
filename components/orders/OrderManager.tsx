"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td, num } from "@/components/ui/Table";

type Order = {
  id: string;
  order_type: string;
  order_reference: string | null;
  order_date: string;
  expected_date: string | null;
  party_name: string | null;
  notes: string | null;
  status: string;
  fulfilled_voucher_id: string | null;
  fulfilled_voucher_number: string | null;
  fulfilled_note: string | null;
  total_amount: number;
  item_count: number;
};

type Item = { id: string; name: string; uom: string; sale_rate: number | null; purchase_rate: number | null };
type Ledger = { id: string; name: string };
type Branch = { id: string; code: string; name: string };
/** A voucher this order could be linked to as the one that fulfilled it. */
type Voucher = {
  id: string;
  voucher_number: string;
  voucher_date: string;
  voucher_type: string;
  total_amount: number;
};

type DraftLine = { description: string; item_id: string; quantity: string; uom: string; rate: string };

const STATUS_TONE: Record<string, "neutral" | "accent" | "ok" | "warn" | "bad"> = {
  draft: "neutral",
  confirmed: "accent",
  fulfilled: "ok",
  cancelled: "bad",
};

function emptyLine(): DraftLine {
  return { description: "", item_id: "", quantity: "1", uom: "NOS", rate: "0" };
}

export function OrderManager({
  companyId,
  orders,
  items,
  ledgers,
  branches,
  vouchers,
  orderType,
}: {
  companyId: string;
  orders: Order[];
  items: Item[];
  ledgers: Ledger[];
  branches: Branch[];
  vouchers: Voucher[];
  orderType: "sales" | "purchase";
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const [partyLedgerId, setPartyLedgerId] = useState("");
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const [fulfillNoteFor, setFulfillNoteFor] = useState<string | null>(null);
  const [fulfillNote, setFulfillNote] = useState("");

  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [linkVoucherId, setLinkVoucherId] = useState("");

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function pickItem(i: number, itemId: string) {
    const item = items.find((it) => it.id === itemId);
    const rate = orderType === "sales" ? item?.sale_rate : item?.purchase_rate;
    updateLine(i, {
      item_id: itemId,
      description: item?.name ?? "",
      uom: item?.uom ?? "NOS",
      rate: rate != null ? String(rate) : "0",
    });
  }

  const lineTotal = (l: DraftLine) => (Number(l.quantity) || 0) * (Number(l.rate) || 0);
  const grandTotal = lines.reduce((n, l) => n + lineTotal(l), 0);

  async function createOrder(e: React.FormEvent) {
    e.preventDefault();
    const validLines = lines.filter((l) => l.description.trim() && Number(l.quantity) > 0);
    if (validLines.length === 0) {
      toast.error("Add at least one line.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("create_order", {
      p_company_id: companyId,
      p_branch_id: branches[0]?.id,
      p_order_type: orderType,
      p_party_ledger_id: partyLedgerId || undefined,
      p_order_date: orderDate,
      p_expected_date: expectedDate || undefined,
      p_order_reference: reference.trim() || undefined,
      p_notes: notes.trim() || undefined,
      p_items: validLines.map((l, i) => ({
        item_id: l.item_id || null,
        description: l.description.trim(),
        quantity: Number(l.quantity),
        uom: l.uom,
        rate: Number(l.rate) || 0,
        amount: lineTotal(l),
        line_order: i,
      })),
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`${orderType === "sales" ? "Sales" : "Purchase"} order created`);
    setLines([emptyLine()]);
    setReference("");
    setNotes("");
    setPartyLedgerId("");
    setShowForm(false);
    router.refresh();
  }

  async function advance(orderId: string, newStatus: string, note?: string) {
    setBusy(true);
    const { error } = await createClient().rpc("advance_order_status", {
      p_company_id: companyId,
      p_order_id: orderId,
      p_new_status: newStatus,
      p_fulfilled_note: note ?? undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Order ${newStatus}`);
    setFulfillNoteFor(null);
    setFulfillNote("");
    router.refresh();
  }

  /**
   * Points an order at the voucher that actually fulfilled it —
   * mark_order_converted (migration 0061). Deliberately a MANUAL link, not an
   * automation: 0061's own header settles that an order's quoted price, terms
   * or item mix commonly differ from what ships, so nothing here creates,
   * pre-fills or drives a voucher. It records, after the fact, which
   * separately-raised voucher answered which order — which is what makes
   * get_orders.fulfilled_voucher_number resolve and the "Fulfilled via"
   * column show a real document instead of free text.
   *
   * Status is untouched on purpose, for the same reason 0061 kept the two
   * functions apart: being fulfilled and having a voucher on file are two
   * facts a business learns at two different moments.
   */
  async function linkVoucher(orderId: string) {
    if (!linkVoucherId) {
      toast.error("Pick the voucher that fulfilled this order.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("mark_order_converted", {
      p_company_id: companyId,
      p_order_id: orderId,
      p_voucher_id: linkVoucherId,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Voucher linked to this order");
    setLinkFor(null);
    setLinkVoucherId("");
    router.refresh();
  }

  const voucherLabel = (v: Voucher) =>
    `${v.voucher_number} · ${v.voucher_date} · ${formatINR(v.total_amount, { showZero: true })}`;

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : `New ${orderType === "sales" ? "sales" : "purchase"} order`}
        </button>
      </div>

      {showForm && (
        <form onSubmit={createOrder} className="flex flex-col gap-4 rounded-[14px] border border-border bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{orderType === "sales" ? "Customer" : "Supplier"}</span>
              <select value={partyLedgerId} onChange={(e) => setPartyLedgerId(e.target.value)} className={field}>
                <option value="">— none —</option>
                {ledgers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Their reference</span>
              <input value={reference} onChange={(e) => setReference(e.target.value)} className={field} placeholder="Their PO number" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Date</span>
              <input required type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Expected by</span>
              <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} className={field} />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Lines</span>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] items-center gap-2">
                <select
                  value={l.item_id}
                  onChange={(e) => (e.target.value ? pickItem(i, e.target.value) : updateLine(i, { item_id: "" }))}
                  className={field}
                >
                  <option value="">Type description below…</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name}
                    </option>
                  ))}
                </select>
                <input
                  value={l.description}
                  onChange={(e) => updateLine(i, { description: e.target.value })}
                  placeholder="Description"
                  className={field}
                />
                <input
                  type="number"
                  min={0}
                  step="0.001"
                  value={l.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  className={field}
                />
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={l.rate}
                  onChange={(e) => updateLine(i, { rate: e.target.value })}
                  className={field}
                />
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-xs text-error underline underline-offset-2"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
              className="w-fit text-xs text-accent underline underline-offset-2"
            >
              + Add line
            </button>
            <p className="text-right text-sm font-semibold">Total: {formatINR(grandTotal, { showZero: true })}</p>
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
            Save order
          </button>
        </form>
      )}

      <TableContainer>
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Status</th>
              <th className={th}>{orderType === "sales" ? "Customer" : "Supplier"}</th>
              <th className={th}>Reference</th>
              <th className={th}>Date</th>
              <th className={th}>Expected</th>
              <th className={th + " text-right"}>Items</th>
              <th className={th + " text-right"}>Amount</th>
              <th className={th}>Fulfilled via</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-ink-faint">
                  No {orderType} orders yet.
                </td>
              </tr>
            )}
            {orders.map((o) => (
              // Fragment, keyed: the fulfil and link panels below are sibling
              // <tr>s of the order's own row, so the key belongs on the
              // wrapper React actually gets back from the map, not on the
              // first row inside it.
              <Fragment key={o.id}>
                <tr className="border-b border-border last:border-0">
                  <td className={td}>
                    <Badge tone={STATUS_TONE[o.status] ?? "neutral"}>{o.status}</Badge>
                  </td>
                  <td className={td}>{o.party_name ?? "—"}</td>
                  <td className={td + " font-mono text-xs"}>{o.order_reference ?? "—"}</td>
                  <td className={td + " whitespace-nowrap"}>{o.order_date}</td>
                  <td className={td + " whitespace-nowrap"}>{o.expected_date ?? "—"}</td>
                  <td className={num}>{o.item_count}</td>
                  <td className={num}>{formatINR(Number(o.total_amount), { showZero: true })}</td>
                  {/* A linked voucher and a fulfilment note are two different
                      facts and both can be on file, so the note is no longer
                      merely a fallback for a link that never got written —
                      it shows underneath the one that did. */}
                  <td className={td + " text-xs text-ink-soft"}>
                    {o.fulfilled_voucher_id && o.fulfilled_voucher_number ? (
                      <Link
                        href={`/${companyId}/vouchers/${o.fulfilled_voucher_id}`}
                        className="font-mono text-accent underline underline-offset-2"
                      >
                        {o.fulfilled_voucher_number}
                      </Link>
                    ) : o.fulfilled_note ? null : (
                      "—"
                    )}
                    {o.fulfilled_note && (
                      <span className="block text-ink-faint">{o.fulfilled_note}</span>
                    )}
                  </td>
                  <td className={td}>
                    {o.status === "draft" && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => advance(o.id, "confirmed")}
                          className="text-xs text-accent underline underline-offset-2 disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => advance(o.id, "cancelled")}
                          className="text-xs text-error underline underline-offset-2 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {o.status === "confirmed" && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setFulfillNoteFor(fulfillNoteFor === o.id ? null : o.id)}
                          className="text-xs text-accent underline underline-offset-2"
                        >
                          Fulfil
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => advance(o.id, "cancelled")}
                          className="text-xs text-error underline underline-offset-2 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {/* Available on a confirmed order as well as a fulfilled
                        one: the voucher may be raised before anyone gets
                        round to moving the order's status, and the link does
                        not depend on the status (nor change it). */}
                    {(o.status === "confirmed" || o.status === "fulfilled") && (
                      <button
                        type="button"
                        onClick={() => {
                          setLinkFor(linkFor === o.id ? null : o.id);
                          setLinkVoucherId(o.fulfilled_voucher_id ?? "");
                        }}
                        className="mt-1 block text-xs text-accent underline underline-offset-2"
                      >
                        {o.fulfilled_voucher_id ? "Change linked voucher" : "Link voucher"}
                      </button>
                    )}
                  </td>
                </tr>
                {linkFor === o.id && (
                  <tr className="border-b border-border bg-bg">
                    <td colSpan={9} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="flex min-w-[18rem] flex-1 flex-col gap-1">
                          <span className="text-xs font-medium">
                            Which voucher fulfilled this order?{" "}
                            <span className="font-normal text-ink-faint">
                              — raise it on the invoice screen as normal, then point the order at it here
                            </span>
                          </span>
                          <select
                            value={linkVoucherId}
                            onChange={(e) => setLinkVoucherId(e.target.value)}
                            className={field}
                          >
                            <option value="">Select…</option>
                            {vouchers.map((v) => (
                              <option key={v.id} value={v.id}>
                                {voucherLabel(v)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => linkVoucher(o.id)}
                          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                        >
                          Link this voucher
                        </button>
                      </div>
                      <p className="mt-2 max-w-3xl text-xs text-ink-faint">
                        {vouchers.length === 0
                          ? `No ${orderType === "sales" ? "sales invoice or outward delivery challan" : "purchase bill"} exists in this company yet — raise one first, then come back.`
                          : `The ${vouchers.length} most recent ${
                              orderType === "sales"
                                ? "sales invoices and outward delivery challans"
                                : "purchase bills"
                            } in this company, newest first. Linking changes nothing in the ledger and does not move the order's status. You can repoint the link at a different voucher later, but there is no way to clear it once set.`}
                      </p>
                    </td>
                  </tr>
                )}
                {fulfillNoteFor === o.id && (
                  <tr className="border-b border-border bg-bg">
                    <td colSpan={9} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="flex flex-1 flex-col gap-1">
                          <span className="text-xs font-medium">
                            How was it fulfilled? <span className="font-normal text-ink-faint">— free text; to point at a real voucher use “Link voucher”</span>
                          </span>
                          <input value={fulfillNote} onChange={(e) => setFulfillNote(e.target.value)} className={field} />
                        </label>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => advance(o.id, "fulfilled", fulfillNote)}
                          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                        >
                          Mark fulfilled
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </TableContainer>
    </div>
  );
}
