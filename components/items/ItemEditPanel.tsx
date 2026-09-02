"use client";

// Editing an existing item — the half of the item master that has never
// existed. Until this panel, ItemManager could only INSERT, so a wrong HSN,
// GST rate or opening value was permanent, items.is_active was rendered but
// never written, and items.batch_tracking (0067) had no write path at all,
// which left /batches, Reports → Stock expiry and the batch half of
// /stock-verification permanently empty for every company.
//
// The save is a plain `.update()` on public.items, not an RPC: items_write
// (0013) is already `for all to authenticated` under can_write_company, and
// the rules that actually matter live in app_private.protect_item_master_fields
// (1370) as a BEFORE UPDATE trigger, so they hold for the CSV importer and the
// capture-review screen too — both of which write this table without going
// anywhere near this file. Everything disabled below is disabled because that
// trigger, or a table constraint, would refuse it; the form never invents a
// rule of its own.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  BATCH_TRACKING_MODES,
  EMPTY_ITEM_EDIT_CONTEXT,
  GST_RATES,
  ITC_BLOCK_CLAUSES,
  SUPPLY_NATURES,
  friendlyItemError,
  type ItemEditContext,
} from "@/components/items/itemFields";

export type EditableItem = {
  id: string;
  code: string | null;
  name: string;
  item_type: string;
  hsn_sac: string | null;
  uom: string;
  category: string | null;
  maintain_stock: boolean;
  opening_quantity: number;
  opening_value: number;
  sale_rate: number | null;
  purchase_rate: number | null;
  reorder_level: number | null;
  gst_rate_percent: number;
  cess_rate_percent: number;
  supply_nature: string;
  itc_eligibility: string;
  itc_blocked_clause: string | null;
  default_tcs_section: string | null;
  is_rcm_applicable: boolean;
  batch_tracking: string;
  is_active: boolean;
};

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-faint";

const legend = "text-[11px] font-semibold uppercase tracking-wide text-ink-faint";

function numOrNull(s: string) {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function qty(n: number) {
  return Number(n.toFixed(3)).toString();
}

export function ItemEditPanel({
  companyId,
  item,
  uoms,
  tcsSections,
  context,
  isAdmin,
  batchModuleActive,
  onClose,
}: {
  companyId: string;
  item: EditableItem;
  uoms: { code: string; name: string }[];
  tcsSections: { section_code: string; rate_percent: number }[];
  context: ItemEditContext | undefined;
  isAdmin: boolean;
  batchModuleActive: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const ctx = { item_id: item.id, ...EMPTY_ITEM_EDIT_CONTEXT, ...(context ?? {}) };

  const [name, setName] = useState(item.name);
  const [code, setCode] = useState(item.code ?? "");
  const [category, setCategory] = useState(item.category ?? "");
  const [hsn, setHsn] = useState(item.hsn_sac ?? "");
  const [uom, setUom] = useState(item.uom);
  const [supplyNature, setSupplyNature] = useState(item.supply_nature);
  const [gstRate, setGstRate] = useState(String(item.gst_rate_percent));
  const [cessRate, setCessRate] = useState(String(item.cess_rate_percent));
  const [itcBlockedClause, setItcBlockedClause] = useState(item.itc_blocked_clause ?? "");
  const [tcsSection, setTcsSection] = useState(item.default_tcs_section ?? "");
  const [rcm, setRcm] = useState(item.is_rcm_applicable);
  const [saleRate, setSaleRate] = useState(item.sale_rate == null ? "" : String(item.sale_rate));
  const [purchaseRate, setPurchaseRate] = useState(
    item.purchase_rate == null ? "" : String(item.purchase_rate)
  );
  const [reorderLevel, setReorderLevel] = useState(
    item.reorder_level == null ? "" : String(item.reorder_level)
  );
  const [openingQty, setOpeningQty] = useState(qty(item.opening_quantity));
  const [openingValue, setOpeningValue] = useState(String(item.opening_value));
  const [batchTracking, setBatchTracking] = useState(item.batch_tracking);
  const [isActive, setIsActive] = useState(item.is_active);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isStockItem = item.item_type === "goods" && item.maintain_stock;
  const transacted = ctx.stock_line_count > 0;

  // Every lock below mirrors a specific refusal in protect_item_master_fields
  // (1370) or a table constraint — never a rule invented in the browser.
  const uomLocked = transacted || ctx.uom_conversion_count > 0;
  const batchOffBlocked = ctx.batch_allocation_count > 0;
  const serialBlocked = ctx.non_unit_allocation_count > 0;
  const openingLocked = !isAdmin;

  const openingChanged =
    Number(openingQty) !== item.opening_quantity || Number(openingValue) !== item.opening_value;
  const rateChanged = Number(gstRate) !== item.gst_rate_percent;
  const trackingChanged = batchTracking !== item.batch_tracking;
  const turningOffActive = item.is_active && !isActive;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    const taxable = supplyNature === "taxable";
    const { error: updateError } = await createClient()
      .from("items")
      .update({
        name: name.trim(),
        code: code.trim() || null,
        category: category.trim() || null,
        hsn_sac: hsn.trim() || null,
        uom,
        supply_nature: supplyNature,
        // Same two constraints the create form already respects:
        // items_non_taxable_has_no_rate and
        // items_itc_clause_matches_eligibility.
        gst_rate_percent: taxable ? Number(gstRate) || 0 : 0,
        cess_rate_percent: taxable ? Number(cessRate) || 0 : 0,
        itc_eligibility: itcBlockedClause ? "blocked" : "eligible",
        itc_blocked_clause: itcBlockedClause || null,
        default_tcs_section: tcsSection || null,
        is_rcm_applicable: rcm,
        sale_rate: numOrNull(saleRate),
        purchase_rate: numOrNull(purchaseRate),
        reorder_level: numOrNull(reorderLevel),
        opening_quantity: isStockItem ? Number(openingQty) || 0 : 0,
        opening_value: isStockItem ? Number(openingValue) || 0 : 0,
        batch_tracking: isStockItem ? batchTracking : "none",
        is_active: isActive,
      })
      .eq("id", item.id)
      .eq("company_id", companyId);

    setBusy(false);
    if (updateError) {
      setError(friendlyItemError(updateError, name.trim()));
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form
      onSubmit={save}
      className="rounded-md border border-border-strong bg-bg p-4"
      aria-label={`Edit ${item.name}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">Edit {item.name}</h3>
        <span className="text-xs text-ink-faint">
          {transacted
            ? `${ctx.stock_line_count} stock line${ctx.stock_line_count === 1 ? "" : "s"} recorded`
            : "Never used on a voucher"}
        </span>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {/* ---------------------------------------------------------- */}
        <fieldset className="flex flex-col gap-3">
          <legend className={legend}>Identity</legend>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Code <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input value={code} onChange={(e) => setCode(e.target.value)} className={field + " font-mono"} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Category <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input value={category} onChange={(e) => setCategory(e.target.value)} className={field} />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              {item.item_type === "service" ? "SAC" : "HSN"}{" "}
              <span className="font-normal text-ink-faint">4–8 digits</span>
            </span>
            <input
              value={hsn}
              onChange={(e) => setHsn(e.target.value.replace(/\D/g, ""))}
              maxLength={8}
              className={field + " font-mono"}
            />
            <span className="text-xs text-ink-faint">
              Corrects every future invoice, the GSTR-1 HSN summary and the e-invoice
              payload. Invoices already issued keep the code they were printed with —
              it is copied onto the line at entry — so fix one of those through
              Invoices → Edit.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Unit{" "}
              {uomLocked && <span className="font-normal text-ink-faint">— locked</span>}
            </span>
            <select
              value={uom}
              onChange={(e) => setUom(e.target.value)}
              disabled={uomLocked || item.item_type === "service"}
              className={field}
            >
              {uoms.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.code} — {u.name}
                </option>
              ))}
            </select>
            {uomLocked && (
              <span className="text-xs text-ink-faint">
                {transacted
                  ? `${ctx.stock_line_count} stock line${ctx.stock_line_count === 1 ? " has" : "s have"} already recorded quantities in ${item.uom}. Changing the base unit would relabel them without converting them — 100 kilos would read as 100 grams. Deactivate this item and create a new one in the right unit.`
                  : `${ctx.uom_conversion_count} alternate-unit conversion${ctx.uom_conversion_count === 1 ? " is" : "s are"} expressed against ${item.uom} and would all become wrong. Remove them first.`}
              </span>
            )}
          </label>
        </fieldset>

        {/* ---------------------------------------------------------- */}
        <fieldset className="flex flex-col gap-3">
          <legend className={legend}>Tax</legend>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Supply nature</span>
            <select
              value={supplyNature}
              onChange={(e) => setSupplyNature(e.target.value)}
              className={field}
            >
              {SUPPLY_NATURES.map((n) => (
                <option key={n.value} value={n.value}>
                  {n.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-faint">
              {SUPPLY_NATURES.find((n) => n.value === supplyNature)?.hint}
            </span>
          </label>

          {supplyNature === "taxable" && (
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">GST rate</span>
                <select value={gstRate} onChange={(e) => setGstRate(e.target.value)} className={field}>
                  {GST_RATES.map((r) => (
                    <option key={r} value={r}>
                      {r}%
                    </option>
                  ))}
                  {!GST_RATES.includes(Number(gstRate)) && (
                    <option value={gstRate}>{gstRate}% (as stored)</option>
                  )}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  Cess <span className="font-normal text-ink-faint">%</span>
                </span>
                <input
                  inputMode="decimal"
                  value={cessRate}
                  onChange={(e) => setCessRate(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
            </div>
          )}

          {rateChanged && transacted && (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
              This item has already been invoiced. The rate here is the default for
              FUTURE invoices — tax already posted does not move, and the GST registers,
              the HSN summary and any e-invoice all read what was actually charged.
              One report is the exception: GSTR-1 Table 12&rsquo;s rate split reads this
              field live, because no per-line rate is stored, so past periods will
              re-bucket. Change it when the rate genuinely changed by notification, not
              to restate a past invoice.
            </p>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Input tax credit{" "}
              <span className="font-normal text-ink-faint">blank unless Sec 17(5) blocks it</span>
            </span>
            <select
              value={itcBlockedClause}
              onChange={(e) => setItcBlockedClause(e.target.value)}
              className={field}
            >
              <option value="">Claimable</option>
              {ITC_BLOCK_CLAUSES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              TCS section <span className="font-normal text-ink-faint">Sec 206C goods only</span>
            </span>
            <select value={tcsSection} onChange={(e) => setTcsSection(e.target.value)} className={field}>
              <option value="">Not applicable</option>
              {tcsSections.map((s) => (
                <option key={s.section_code} value={s.section_code}>
                  {s.section_code} — {s.rate_percent}%
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rcm}
              onChange={(e) => setRcm(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Purchases of this attract reverse charge
          </label>
        </fieldset>

        {/* ---------------------------------------------------------- */}
        <fieldset className="flex flex-col gap-3">
          <legend className={legend}>Rates and reorder</legend>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Sale rate</span>
              <input
                inputMode="decimal"
                value={saleRate}
                onChange={(e) => setSaleRate(e.target.value)}
                className={field + " text-right tabular-nums"}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Purchase rate</span>
              <input
                inputMode="decimal"
                value={purchaseRate}
                onChange={(e) => setPurchaseRate(e.target.value)}
                className={field + " text-right tabular-nums"}
              />
            </label>
          </div>
          {isStockItem && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Reorder level <span className="font-normal text-ink-faint">in {item.uom}</span>
              </span>
              <input
                inputMode="decimal"
                value={reorderLevel}
                onChange={(e) => setReorderLevel(e.target.value)}
                className={field + " text-right tabular-nums"}
              />
            </label>
          )}
        </fieldset>

        {/* ---------------------------------------------------------- */}
        {isStockItem && (
          <fieldset className="flex flex-col gap-3">
            <legend className={legend}>Stock</legend>

            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Opening qty</span>
                <input
                  inputMode="decimal"
                  value={openingQty}
                  disabled={openingLocked}
                  onChange={(e) => setOpeningQty(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Opening value</span>
                <input
                  inputMode="decimal"
                  value={openingValue}
                  disabled={openingLocked}
                  onChange={(e) => setOpeningValue(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
            </div>
            {openingLocked ? (
              <p className="text-xs text-ink-faint">
                Only an admin can change an opening quantity or value — it is this
                item&rsquo;s share of the balance sheet on day one, gated the same way a
                ledger&rsquo;s opening balance is.
              </p>
            ) : (
              openingChanged &&
              transacted && (
                <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
                  The opening sits before every movement and carries no date, so this
                  restates the stock summary, the stock ageing and closing stock at every
                  past date, including closed periods. Re-run{" "}
                  <Link href={`/${companyId}/closing-stock`} className="underline">
                    Closing stock
                  </Link>{" "}
                  afterwards — it posts only the difference, so the balance sheet comes
                  back into step once you do.
                </p>
              )
            )}

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Batch tracking{" "}
                {!batchModuleActive && (
                  <span className="font-normal text-ink-faint">— module off</span>
                )}
              </span>
              <select
                value={batchTracking}
                onChange={(e) => setBatchTracking(e.target.value)}
                disabled={!batchModuleActive}
                className={field}
              >
                {BATCH_TRACKING_MODES.map((m) => (
                  <option
                    key={m.value}
                    value={m.value}
                    disabled={
                      (m.value === "none" && batchOffBlocked && item.batch_tracking !== "none") ||
                      (m.value === "serial" && serialBlocked && item.batch_tracking !== "serial")
                    }
                  >
                    {m.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-ink-faint">
                {BATCH_TRACKING_MODES.find((m) => m.value === batchTracking)?.hint}
              </span>

              {!batchModuleActive && (
                <span className="text-xs text-ink-faint">
                  Turn on &ldquo;Batch, serial and expiry&rdquo; under{" "}
                  <Link href={`/${companyId}/settings/modules`} className="underline">
                    Settings → Modules
                  </Link>{" "}
                  first, or the Batches screen this feeds has no way in.
                </span>
              )}

              {batchModuleActive && batchOffBlocked && item.batch_tracking !== "none" && (
                <span className="text-xs text-ink-faint">
                  Cannot be turned off: {ctx.batch_allocation_count} allocation
                  {ctx.batch_allocation_count === 1 ? "" : "s"} already point at this
                  item&rsquo;s batches. Turning it off would strand them — the work queue
                  would empty while the expiry report kept reporting balances nothing can
                  be added to. Remove them under{" "}
                  <Link href={`/${companyId}/batches`} className="underline">
                    Batches
                  </Link>{" "}
                  first.
                </span>
              )}

              {batchModuleActive && serialBlocked && item.batch_tracking !== "serial" && (
                <span className="text-xs text-ink-faint">
                  Serial is unavailable: {ctx.non_unit_allocation_count} existing
                  allocation{ctx.non_unit_allocation_count === 1 ? "" : "s"} cover more
                  than one unit each, and a serial number is exactly one unit.
                </span>
              )}

              {batchModuleActive &&
                trackingChanged &&
                batchTracking !== "none" &&
                ctx.unallocated_line_count > 0 && (
                  <span className="rounded-md bg-accent-soft px-3 py-2 text-xs text-ink-soft">
                    Turning this on puts {ctx.unallocated_line_count} existing stock line
                    {ctx.unallocated_line_count === 1 ? "" : "s"} into the{" "}
                    <Link href={`/${companyId}/batches`} className="underline">
                      Batches
                    </Link>{" "}
                    work queue, waiting to be tagged. Nothing is posted or revalued —
                    batches are a physical quantity and expiry record kept alongside the
                    books, not a second valuation.
                  </span>
                )}
            </label>
          </fieldset>
        )}
      </div>

      {/* ------------------------------------------------------------- */}
      <div className="mt-4 border-t border-border pt-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span className="font-medium">Active</span>
          <span className="text-ink-faint">
            — an inactive item disappears from every item picker (invoices, POS, orders,
            job work, price lists, CSV import) but keeps its whole history.
          </span>
        </label>
        {turningOffActive && ctx.closing_quantity > 0.0005 && (
          <p className="mt-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
            {qty(ctx.closing_quantity)} {item.uom} is still on hand as at today — the
            same figure Reports → Stock summary shows. That stock stays in the stock
            summary and on the balance sheet, which is right; but the physical count
            sheet under Stock verification lists active items only, so this item will
            drop off it while the books still carry the stock.
          </p>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
      )}
      {saved && !error && (
        <p className="mt-3 rounded-md bg-success-soft px-3 py-2 text-sm text-success">Saved.</p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border-strong px-4 py-2 text-sm text-ink-soft hover:bg-surface-2"
        >
          Close
        </button>
      </div>

      <p className="mt-3 text-xs text-ink-faint">
        Whether this is goods or a service, and whether it holds stock, cannot be
        changed once it has been used — every stock report filters on those two fields,
        so flipping them would erase this item&rsquo;s history from the stock summary and
        from closing stock while its lines stayed behind. Deactivate it and create a
        replacement instead. There is no delete: vouchers, BOMs, price lists and batches
        all point here.
      </p>
    </form>
  );
}
