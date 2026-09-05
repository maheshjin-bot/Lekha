"use client";

import { Copy } from "lucide-react";
import { formatINR } from "@/lib/utils/currency";
import { cn } from "@/lib/utils/cn";
import type { GridCellProps } from "@/components/ui/EntryGrid";

/**
 * accounting-invoice mode's own line grid (Recon's contract B3a) — a
 * standalone port of InvoiceForm.tsx's item-lines table/cards for the
 * credit_note/debit_note case: service lines billed direct to an income or
 * expense ledger, no stock movement, per migration 1480 (invoice service
 * lines).
 *
 * SCOPE. This file owns ONLY the grid — given `lines` and a handful of
 * mutation callbacks, it lets the preparer edit lines. It is never a second
 * source of truth for money: taxable/tax/tcs/grandTotal all stay a useMemo
 * the SHELL (VoucherScreen, not built by this task) computes directly over
 * the `lines` array it owns, exactly as InvoiceForm computes its own totals
 * today — see this file's own `lineAmounts` export, which the shell reuses
 * so its totals memo can never disagree with what is shown per line here.
 *
 * WHY NOT SHARED WITH ItemInvoiceGrid.tsx. Recon's own B3a recommends ONE
 * parameterized component for both item-invoice and accounting-invoice,
 * since the two are 100% identical except for which items the picker offers
 * — but that file is owned by a different task in this wave (per the
 * cross-reference map, nothing outside the four route pages may be assumed;
 * grid ownership here is scoped to this one file only). This component is
 * therefore a standalone, independently-declared twin, matching the
 * project's own established convention: no two of InvoiceForm.tsx,
 * VoucherForm.tsx, QuickBilling.tsx and CaptureReviewForm.tsx import a
 * shared `Line`/`Item` type from one another either — each re-declares the
 * shape it needs and matches it by hand. If ItemInvoiceGrid.tsx is later
 * unified with this file, that is a deliberate follow-up, not implied here.
 *
 * WHICH ITEMS APPEAR. Migration 1480 did not add a new field to filter on —
 * a charge line and a stock line are both just an `item_id` on the same
 * `p_items` array (see this file's `buildAccountingItemsPayload`, byte-
 * identical to InvoiceForm's `items_payload` builder). The distinction is
 * purely which items the CALLER offers in the picker: per Recon B3a/B1a,
 * the shell pre-filters `items` to non-stock items (item_type='service', or
 * a non-stock-maintaining 'goods' item) before handing them to this
 * component — this file does not re-filter `items` itself, so a shell that
 * deliberately widens the list (e.g. to let a credit note carry a genuine
 * stock return) is free to.
 */

/** Byte-identical mirror of InvoiceForm.tsx's own Item type (lines 33-51). */
export type Item = {
  id: string;
  name: string;
  uom: string;
  sale_rate: number | null;
  purchase_rate: number | null;
  gst_rate_percent: number;
  default_tcs_section: string | null;
  // An item that does not maintain stock is billed as a CHARGE LINE —
  // freight, processing, installation and the like — which carries its SAC,
  // rate, amount and GST onto the invoice and into both GST registers, and
  // moves no inventory. The database derives voucher_items.moves_stock from
  // the item master itself (app_private.enforce_stock_item, 1480), so
  // nothing in the submitted payload has to carry it.
  item_type: string;
  maintain_stock: boolean;
  hsn_sac: string | null;
};

/** Same predicate app_private.enforce_stock_item applies server-side. */
function movesStock(item: Item) {
  return item.item_type === "goods" && item.maintain_stock;
}

/** Names a charge line in the picker itself — same copy as InvoiceForm's
 * own itemOptionLabel, so a preparer sees the same words whichever mode
 * they are in. */
function itemOptionLabel(item: Item) {
  if (movesStock(item)) return item.name;
  return `${item.name} — ${item.item_type === "service" ? "service" : "no stock"}`;
}

/** What a charge line is, shown on the line itself — Rule 46(g)/(k) CGST
 * Rules require an SAC and a taxable value for a service exactly as for
 * goods; quantity/UQC is the only goods-only particular (Rule 46(i)), which
 * is why the Qty column below still asks for one (see the caption above the
 * grid) rather than hiding it. */
function ChargeLineNote({ item }: { item: Item }) {
  return (
    <p className="mt-1 text-[11px] text-ink-faint">
      Charge line · {item.hsn_sac ? `SAC ${item.hsn_sac}` : "no SAC on the item master"} · moves no
      stock
    </p>
  );
}

/** Byte-identical mirror of InvoiceForm.tsx's own Line type. */
export type ItemLine = {
  itemId: string;
  quantity: string;
  rate: string;
  discountPercent: string;
  description: string;
};

/**
 * Quantity defaults to "1", never blank — migration 1480 widened which
 * items may appear on this line, but create_invoice's own guard
 * (`if v_qty is null or v_qty <= 0 then raise exception …`) is unconditional
 * on item_type. A charge line's quantity is usually 1 and rarely touched
 * again, but it is a real, mandatory field, never an omitted one.
 */
export const emptyAccountingLine = (): ItemLine => ({
  itemId: "",
  quantity: "1",
  rate: "",
  discountPercent: "",
  description: "",
});

/**
 * Mirrors create_invoice/update_invoice's own per-line formula exactly
 * (migration 0147, unchanged by 1480): gross = round(qty * rate, 2);
 * discount = round(gross * discPct / 100, 2); net = gross - discount.
 * Exported so the shell's own totals memo (taxable/tax/tcs/grandTotal —
 * B3's governing rule that a grid mode never becomes a second source of
 * truth for money) can share this exact math instead of re-deriving it.
 */
export function lineAmounts(quantity: string, rate: string, discountPercent: string) {
  const qty = Number(quantity) || 0;
  const r = Number(rate) || 0;
  const discPct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const gross = Math.round(qty * r * 100) / 100;
  const discount = Math.round(((gross * discPct) / 100) * 100) / 100;
  const net = Math.round((gross - discount) * 100) / 100;
  return { gross, discount, net };
}

/**
 * Lines actually filled in — the SAME predicate InvoiceForm's
 * `filledLines()` applies, exported so the shell's validateForm()/
 * saveInvoice() equivalents can share it rather than silently drifting from
 * what this grid considers "a real line".
 */
export function filledAccountingLines(lines: ItemLine[]): ItemLine[] {
  return lines.filter((l) => l.itemId && Number(l.quantity) > 0);
}

/**
 * The exact p_items payload create_invoice/update_invoice expect —
 * byte-identical to InvoiceForm.tsx lines 823-829. Migration 1480 added NO
 * new client-sendable field: moves_stock is never part of this payload, the
 * server trigger derives it from the item master when the caller omits it.
 * Exported so the shell's own submit path never has to re-type this.
 */
export function buildAccountingItemsPayload(lines: ItemLine[]) {
  return filledAccountingLines(lines).map((l) => ({
    item_id: l.itemId,
    quantity: Number(l.quantity),
    rate: Number(l.rate) || 0,
    discount_percent: Number(l.discountPercent) || 0,
    description: l.description.trim() || null,
  }));
}

export type AccountingInvoiceGridProps = {
  lines: ItemLine[];
  /**
   * Reports the mutated line back up — nothing else. Internally this
   * component runs the SAME rate-prefill logic InvoiceForm's own `update()`
   * applies (an item pick with a still-blank rate is filled from the price
   * list, falling back to the item master's sale_rate/purchase_rate — never
   * overwriting something already typed) and hands the shell the fully-
   * resolved patch; the shell's own `onChange` can therefore stay a plain
   * `setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))`
   * with no business logic of its own, matching the parity B3a's contract
   * draws between this prop and InvoiceForm's `update()`.
   */
  onChange: (index: number, patch: Partial<ItemLine>) => void;
  onAddRow: () => void;
  onDuplicateRow: (index: number) => void;
  onRemoveRow: (index: number) => void;
  /** Pre-filtered by the shell to the items this mode should offer — see
   * this file's own header comment. Rendered as given, not re-filtered. */
  items: Item[];
  /** Rate-prefill priority (sale_rate vs purchase_rate) when an item is
   * picked onto a still-blank rate. */
  isSale: boolean;
  /** Shows/hides the GST% column. */
  gstOn: boolean;
  /** The company's default price list, as of the invoice's own date — a
   * shell-owned function (needs `date` and `isSale`, both shell state),
   * consulted ahead of the item master's flat rate on an item pick. */
  priceListRate: (itemId: string) => number | undefined;
  /** Opens QuickAddItemModal for the given line index. The modal itself
   * stays shell-owned (mounted once at the top level, not per-grid) —
   * this is only the trigger. */
  onNewItem: (lineIndex: number) => void;
  /** From the shell's own `useGridNav({ rowCount: lines.length, colCount: 4,
   * onAddRow, onDuplicateRow, onRemoveRow })` instance — itemId=0,
   * quantity=1, rate=2, discountPercent=3, matching this grid's desktop
   * `<table>` column order below. */
  getCellProps: (row: number, col: number) => GridCellProps;
  /** P7.2's "show discount column" screen preference, shell-resolved and
   * passed down — see ItemInvoiceGrid.tsx's identical prop comment for why
   * this hides a column, never the underlying field. Defaults true. */
  showDiscountColumn?: boolean;
};

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";
const cell =
  "w-full rounded border border-transparent bg-transparent px-2 py-1.5 outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

export function AccountingInvoiceGrid({
  lines,
  onChange,
  onAddRow,
  onDuplicateRow,
  onRemoveRow,
  items,
  isSale,
  gstOn,
  priceListRate,
  onNewItem,
  getCellProps,
  showDiscountColumn = true,
}: AccountingInvoiceGridProps) {
  /**
   * = InvoiceForm's own `update()` (see the `onChange` prop's own comment
   * above for why the prefill logic lives here rather than in the shell).
   */
  function handleChange(i: number, patch: Partial<ItemLine>) {
    const current = lines[i];
    const next = { ...patch };
    if (patch.itemId && !current.rate) {
      const it = items.find((x) => x.id === patch.itemId);
      const suggested = priceListRate(patch.itemId) ?? (isSale ? it?.sale_rate : it?.purchase_rate);
      if (suggested) next.rate = String(suggested);
    }
    onChange(i, next);
  }

  return (
    <>
      {/* Migration 1480's own consequence for this screen, said once up
          front rather than only where a preparer might trip on it: a
          charge line still needs a quantity greater than zero —
          create_invoice's guard is unconditional on item_type — so this
          column stays required even though most charge lines never touch
          it after the default of 1. */}
      <p className="mt-4 text-xs text-ink-faint">
        Non-stock items only — freight, processing, installation and the like, billed direct to an
        income or expense ledger. Quantity still defaults to 1 and stays required, even though a
        charge line moves no stock.
      </p>

      {/* Two renderings of the same `lines` state: stacked cards below sm:,
          the table from sm: up — same responsive split as InvoiceForm's
          own item-lines grid. */}
      <div className="mt-3 flex flex-col gap-3 sm:hidden">
        {lines.map((line, i) => {
          const item = items.find((x) => x.id === line.itemId);
          const { gross, discount, net } = lineAmounts(line.quantity, line.rate, line.discountPercent);
          return (
            <div key={i} className="rounded-lg border border-border bg-surface p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                  Line {i + 1}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onDuplicateRow(i)}
                    aria-label={`Duplicate line ${i + 1}`}
                    className="rounded px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-soft"
                  >
                    Duplicate
                  </button>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onRemoveRow(i)}
                      className="rounded px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-soft"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-2.5">
                <div className="flex items-end gap-1.5">
                  <label className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-xs text-ink-faint">Item</span>
                    <select
                      aria-label={`Item on line ${i + 1}`}
                      value={line.itemId}
                      onChange={(e) => handleChange(i, { itemId: e.target.value })}
                      className={field}
                    >
                      <option value="">Select an item…</option>
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {itemOptionLabel(it)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => onNewItem(i)}
                    aria-label={`New item for line ${i + 1}`}
                    className="shrink-0 rounded-lg border border-border-strong px-2.5 py-2 text-xs text-accent"
                  >
                    + New
                  </button>
                </div>
                {item && !movesStock(item) && <ChargeLineNote item={item} />}
                <div className={showDiscountColumn ? "grid grid-cols-3 gap-2.5" : "grid grid-cols-2 gap-2.5"}>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-ink-faint">Qty {item ? `(${item.uom})` : ""}</span>
                    <input
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => handleChange(i, { quantity: e.target.value })}
                      className={field + " text-right tabular-nums"}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-ink-faint">Rate</span>
                    <input
                      inputMode="decimal"
                      value={line.rate}
                      onChange={(e) => handleChange(i, { rate: e.target.value })}
                      className={field + " text-right tabular-nums"}
                    />
                  </label>
                  {showDiscountColumn && (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-ink-faint">Disc %</span>
                      <input
                        inputMode="decimal"
                        value={line.discountPercent}
                        placeholder="0"
                        onChange={(e) => handleChange(i, { discountPercent: e.target.value })}
                        className={field + " text-right tabular-nums"}
                      />
                    </label>
                  )}
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-ink-faint">
                    Description <span className="font-normal">optional</span>
                  </span>
                  <input
                    value={line.description}
                    onChange={(e) => handleChange(i, { description: e.target.value })}
                    className={field}
                  />
                </label>
              </div>
              <div className="mt-2.5 flex items-center justify-between border-t border-border pt-2 text-sm">
                {gstOn && (
                  <span className="text-xs text-ink-faint">
                    GST {item ? `${item.gst_rate_percent}%` : "—"}
                  </span>
                )}
                <span className="ml-auto tabular-nums font-mono font-medium">
                  {formatINR(net)}
                  {discount > 0 && (
                    <span className="block text-right text-[11px] font-sans font-normal text-ink-faint">
                      {formatINR(gross)} − {formatINR(discount)} disc.
                    </span>
                  )}
                </span>
              </div>
            </div>
          );
        })}

        <button
          type="button"
          onClick={onAddRow}
          className="self-start rounded px-2 py-1 text-xs text-accent underline underline-offset-4"
        >
          Add line
        </button>
      </div>

      <div className="mt-3 hidden overflow-x-auto rounded-lg border border-border bg-surface sm:block">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-3 py-2.5 font-medium">Item</th>
              <th className="w-24 px-3 py-2.5 text-right font-medium">Qty</th>
              <th className="w-16 px-3 py-2.5 font-medium">Unit</th>
              <th className="w-28 px-3 py-2.5 text-right font-medium">Rate</th>
              {showDiscountColumn && <th className="w-20 px-3 py-2.5 text-right font-medium">Disc %</th>}
              {gstOn && <th className="w-16 px-3 py-2.5 text-right font-medium">GST</th>}
              <th className="w-32 px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const item = items.find((x) => x.id === line.itemId);
              const { gross, discount, net } = lineAmounts(line.quantity, line.rate, line.discountPercent);
              return (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <select
                        {...getCellProps(i, 0)}
                        aria-label={`Item on line ${i + 1}`}
                        value={line.itemId}
                        onChange={(e) => handleChange(i, { itemId: e.target.value })}
                        className={cell}
                      >
                        <option value="">Select an item…</option>
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>
                            {itemOptionLabel(it)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => onNewItem(i)}
                        aria-label={`New item for line ${i + 1}`}
                        title="Create an item without leaving this invoice"
                        className="shrink-0 rounded px-1.5 py-1 text-xs text-accent underline underline-offset-4"
                      >
                        + New
                      </button>
                    </div>
                    {item && !movesStock(item) && <ChargeLineNote item={item} />}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      {...getCellProps(i, 1)}
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => handleChange(i, { quantity: e.target.value })}
                      className={cell + " text-right tabular-nums"}
                    />
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-faint">{item?.uom ?? "—"}</td>
                  <td className="px-3 py-2">
                    <input
                      {...getCellProps(i, 2)}
                      inputMode="decimal"
                      value={line.rate}
                      onChange={(e) => handleChange(i, { rate: e.target.value })}
                      className={cell + " text-right tabular-nums"}
                    />
                  </td>
                  {showDiscountColumn && (
                    <td className="px-3 py-2">
                      <input
                        {...getCellProps(i, 3)}
                        inputMode="decimal"
                        value={line.discountPercent}
                        placeholder="0"
                        onChange={(e) => handleChange(i, { discountPercent: e.target.value })}
                        className={cell + " text-right tabular-nums"}
                      />
                    </td>
                  )}
                  {gstOn && (
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-ink-faint font-mono">
                      {item ? `${item.gst_rate_percent}%` : "—"}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right tabular-nums font-mono">
                    {formatINR(net)}
                    {discount > 0 && (
                      <span className="block text-[11px] font-sans text-ink-faint">
                        {formatINR(gross)} − {formatINR(discount)} disc.
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => onDuplicateRow(i)}
                        aria-label={`Duplicate line ${i + 1}`}
                        title="Ctrl+D"
                        className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-soft"
                      >
                        <Copy size={13} aria-hidden="true" />
                      </button>
                      {lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() => onRemoveRow(i)}
                          aria-label={`Remove line ${i + 1}`}
                          className={cn(
                            "rounded px-1.5 py-0.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-soft"
                          )}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-bg">
              <td className="px-3 py-2.5" colSpan={4 + (gstOn ? 1 : 0) + (showDiscountColumn ? 1 : 0)}>
                <button
                  type="button"
                  onClick={onAddRow}
                  className="rounded px-2 py-1 text-xs text-accent underline underline-offset-4"
                >
                  Add line
                </button>
              </td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
