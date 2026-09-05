"use client";

import type { GridCellProps } from "@/components/ui/EntryGrid";
import { formatINR } from "@/lib/utils/currency";

/**
 * The item-invoice line-items grid — a port of InvoiceForm.tsx's stock-item
 * table (qty/rate/unit/discount/GST-per-line) into a standalone component,
 * per the VoucherScreen recon's contract (B3a). This file owns ONLY the
 * lines themselves: given `lines` and a way to mutate them, it lets the user
 * add/edit/remove/duplicate rows. It never becomes a second source of truth
 * for money — the invoice-wide totals (taxable value, CGST/SGST/IGST, TCS,
 * grand total) need `supplyType`/`tcsSections`/the party's registration type
 * to compute, none of which this component receives, so they stay a
 * useMemo the SHELL (VoucherScreen) computes directly over the same `lines`
 * array and renders around this grid — see the recon's "governing decision"
 * under B3. This component's own per-line "Amount" cell is NOT one of those
 * totals: it is `lineAmounts()` applied to that one line's own three
 * fields, which needs nothing this grid wasn't already handed.
 *
 * STATE OWNERSHIP: `lines` lives in the shell (VoucherScreen), not here.
 * `onChange`/`onAddRow`/`onDuplicateRow`/`onRemoveRow` are the shell's own
 * setState callbacks, passed down so this grid's own buttons (Add line,
 * the per-row × ) can call them directly. `getCellProps` comes from a
 * SINGLE useGridNav instance the shell owns (its colCount has to change
 * between item-invoice's 4 columns and raw-voucher's 2 the instant Ctrl+H
 * switches mode — something only the shell can see), spread onto each
 * desktop cell exactly as InvoiceForm's own table already does; the mobile
 * cards below sm: were never wired to grid nav in InvoiceForm either, and
 * stay on plain onChange here for the same reason.
 *
 * QUANTITY STAYS MANDATORY for a non-stock (charge) line exactly as it is
 * for a stock line, even though 1480 legalised a non-stock item on this
 * same p_items array — create_invoice/update_invoice's own
 * `if v_qty is null or v_qty <= 0 then raise exception …` guard is
 * unconditional (see the recon's B4). This grid does not special-case
 * quantity by item type; `emptyItemLine()` below defaults it to "1" for
 * every new row, same as InvoiceForm's own `emptyLine()` always has.
 */

// Byte-identical to InvoiceForm.tsx's own item shape (B1a) — the item
// picker's options and the GST-rate/unit columns below read only these
// fields, so a caller (the shell) can hand this component either the full
// item master list (item-invoice) or a non-stock-only subset
// (accounting-invoice, migration 1480) without this file caring which.
export type Item = {
  id: string;
  name: string;
  uom: string;
  sale_rate: number | null;
  purchase_rate: number | null;
  gst_rate_percent: number;
  default_tcs_section: string | null;
  item_type: string;
  maintain_stock: boolean;
  hsn_sac: string | null;
};

/**
 * Whether a line on this item moves stock — the same predicate
 * app_private.enforce_stock_item applies server-side, and the reason a
 * service can be invoiced but still never reaches the stock ledger.
 * Exported so a caller that needs the same "any charge line on this
 * invoice?" check (InvoiceForm's own `hasChargeLine`, which the recon
 * recommends the shell keep next to the Godown field it annotates — see
 * this file's header) can apply the identical rule instead of restating it.
 */
export function movesStock(item: Item): boolean {
  return item.item_type === "goods" && item.maintain_stock;
}

/**
 * Names a charge line in the picker itself, so the difference is understood
 * before the choice is made rather than explained after it. Goods that
 * simply are not stock-tracked behave identically to a service on the
 * invoice, but calling them one would be wrong, so they say what they
 * actually are.
 */
export function itemOptionLabel(item: Item): string {
  if (movesStock(item)) return item.name;
  return `${item.name} — ${item.item_type === "service" ? "service" : "no stock"}`;
}

/**
 * What a charge line is, shown on the line itself. The SAC is here because
 * Rule 46(g) CGST Rules requires a code for services exactly as it does for
 * goods, and because a preparer who sees it blank on the invoice has to know
 * to go and put it on the item master — quantity, by contrast, is a goods-only
 * particular under Rule 46(i), which is why nothing here asks for one.
 */
function ChargeLineNote({ item }: { item: Item }) {
  return (
    <p className="mt-1 text-[11px] text-ink-faint">
      Charge line · {item.hsn_sac ? `SAC ${item.hsn_sac}` : "no SAC on the item master"} · moves no
      stock
    </p>
  );
}

export type ItemLine = {
  itemId: string;
  quantity: string;
  rate: string;
  discountPercent: string;
  description: string;
};

/** Every field a fresh row starts from — quantity defaults to "1" per this
 * file's own header note on why it is never blank. */
export function emptyItemLine(): ItemLine {
  return { itemId: "", quantity: "1", rate: "", discountPercent: "", description: "" };
}

/**
 * Mirrors create_invoice/update_invoice's own per-line formula exactly (0147):
 * gross = round(qty * rate, 2); discount = round(gross * discPct / 100, 2);
 * net = gross - discount. Exported so the shell's own totals memo (taxable
 * value, and the tax/TCS math layered on top of it) sums the SAME per-line
 * net this grid already shows, rather than a second formula that could drift
 * from it.
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

export type ItemInvoiceGridProps = {
  lines: ItemLine[];
  /** The shell's own by-index patch-merge setter — this grid never mutates
   * `lines` itself, only ever computes WHICH patch to send (see `update`
   * below, which is where InvoiceForm's own rate-prefill logic now lives). */
  onChange: (index: number, patch: Partial<ItemLine>) => void;
  onAddRow: () => void;
  /** Wired only into `getCellProps`' own Ctrl+D handling today — InvoiceForm
   * never rendered an explicit "Duplicate" button, so neither does this
   * grid; kept as a prop for shape-parity with RawVoucherGrid's identical
   * trio and in case a future UI adds the affordance. */
  onDuplicateRow: (index: number) => void;
  onRemoveRow: (index: number) => void;
  /** Pre-filtered by the caller when it isn't the full item master — e.g.
   * accounting-invoice mode offering only non-stock items (1480). This grid
   * renders whatever it is given and does not filter on its own. */
  items: Item[];
  /** Rate-prefill priority (sale_rate vs purchase_rate) and the Qty column's
   * "their PO/bill" framing already carried by the caller — see `update`. */
  isSale: boolean;
  /** Shows/hides the GST% column and the tfoot's column count. */
  gstOn: boolean;
  /** The company's default price list as of the invoice's own date — a
   * shell-owned function (needs `date`, which lives there) called only to
   * prefill a still-blank Rate the moment an item is picked. */
  priceListRate: (itemId: string) => number | undefined;
  /** Opens QuickAddItemModal for the given line — the modal itself stays
   * shell-owned (mounted once at the top level, not per-grid), matching how
   * InvoiceForm mounts its three popups outside the table. */
  onNewItem: (lineIndex: number) => void;
  /** From the shell's single useGridNav instance (rowCount=lines.length,
   * colCount=4: itemId=0, quantity=1, rate=2, discountPercent=3) — spread
   * onto the desktop table's cells only, exactly as InvoiceForm's own table
   * does; the mobile cards below sm: were never part of that grid. */
  getCellProps: (row: number, col: number) => GridCellProps;
  /** P7.2's "show discount column" screen preference (screen_key
   * "voucher-entry"), shell-resolved and passed down. Defaults true — a
   * discountPercent still lives on every line and still reaches
   * create_invoice/update_invoice's payload either way (this prop hides a
   * column, never a field); it only stops rendering the input/header/cell so
   * a company that never discounts doesn't have to look at an always-zero
   * column. useGridNav's own colCount stays 4 regardless — the shell owns
   * that hook and does not renumber columns when this is off. */
  showDiscountColumn?: boolean;
};

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";
const cell =
  "w-full rounded border border-transparent bg-transparent px-2 py-1.5 outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

export function ItemInvoiceGrid({
  lines,
  onChange,
  onAddRow,
  onRemoveRow,
  items,
  isSale,
  gstOn,
  priceListRate,
  onNewItem,
  getCellProps,
  showDiscountColumn = true,
}: ItemInvoiceGridProps) {
  /**
   * Byte-identical to InvoiceForm.tsx's own `update()` (lines 648-667):
   * prefill the rate when an item is picked and the rate is still blank —
   * never overwrite something already typed. The price list (if it has an
   * entry effective on this invoice's date) takes priority over the item
   * master's flat sale_rate/purchase_rate, since it is the more specific,
   * more recently-updated figure — still just a suggestion, still fully
   * editable either way. Computes the FULL patch and hands it to the
   * shell's dumb `onChange(i, patch)` setter, so the shell never has to
   * know this rule exists.
   */
  function update(i: number, patch: Partial<ItemLine>) {
    const current = lines[i];
    const next: Partial<ItemLine> = { ...patch };
    if (patch.itemId && current && !current.rate) {
      const it = items.find((x) => x.id === patch.itemId);
      const suggested = priceListRate(patch.itemId) ?? (isSale ? it?.sale_rate : it?.purchase_rate);
      if (suggested) next.rate = String(suggested);
    }
    onChange(i, next);
  }

  return (
    <>
      {/* Two renderings of the same `lines` prop: stacked cards below sm:,
          the original table from sm: up. Seven columns need horizontal
          scroll to fit under ~640px, and the borderless table-cell inputs
          are a poor touch target — the exact gap InvoiceForm's own dossier
          audit (F-12) flagged as "desktop-only in practice". */}
      <div className="mt-6 flex flex-col gap-3 sm:hidden">
        {lines.map((line, i) => {
          const item = items.find((x) => x.id === line.itemId);
          const { gross, discount, net } = lineAmounts(line.quantity, line.rate, line.discountPercent);
          return (
            <div key={i} className="rounded-lg border border-border bg-surface p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                  Line {i + 1}
                </span>
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
              <div className="flex flex-col gap-2.5">
                <div className="flex items-end gap-1.5">
                  <label className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-xs text-ink-faint">Item</span>
                    <select
                      aria-label={`Item on line ${i + 1}`}
                      value={line.itemId}
                      onChange={(e) => update(i, { itemId: e.target.value })}
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
                      onChange={(e) => update(i, { quantity: e.target.value })}
                      className={field + " text-right tabular-nums"}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-ink-faint">Rate</span>
                    <input
                      inputMode="decimal"
                      value={line.rate}
                      onChange={(e) => update(i, { rate: e.target.value })}
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
                        onChange={(e) => update(i, { discountPercent: e.target.value })}
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
                    onChange={(e) => update(i, { description: e.target.value })}
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

      <div className="mt-6 hidden overflow-x-auto rounded-lg border border-border bg-surface sm:block">
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
              <th className="w-10" />
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
                        onChange={(e) => update(i, { itemId: e.target.value })}
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
                      onChange={(e) => update(i, { quantity: e.target.value })}
                      className={cell + " text-right tabular-nums"}
                    />
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-faint">{item?.uom ?? "—"}</td>
                  <td className="px-3 py-2">
                    <input
                      {...getCellProps(i, 2)}
                      inputMode="decimal"
                      value={line.rate}
                      onChange={(e) => update(i, { rate: e.target.value })}
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
                        onChange={(e) => update(i, { discountPercent: e.target.value })}
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
                  <td className="px-2 py-2 text-center">
                    {lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => onRemoveRow(i)}
                        aria-label={`Remove line ${i + 1}`}
                        className="rounded px-1.5 py-0.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-soft"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {/* No totals row here — see this file's header. The shell renders
                taxable/CGST/SGST/IGST/TCS/Total around this grid, computed
                over the same `lines` prop this component was given, using
                the same `lineAmounts()` exported above. */}
            <tr className="border-t border-border bg-bg">
              <td className="px-3 py-2.5" colSpan={6 + (gstOn ? 1 : 0) + (showDiscountColumn ? 1 : 0)}>
                <button
                  type="button"
                  onClick={onAddRow}
                  className="rounded px-2 py-1 text-xs text-accent underline underline-offset-4"
                >
                  Add line
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
