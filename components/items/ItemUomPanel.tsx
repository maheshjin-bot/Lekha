"use client";

// Additive sub-panel on the item master (0121): alternate units of measure
// for a stock item, each carrying a conversion_factor back to the item's own
// base/stocking unit (public.item_uom_conversions). Direction convention —
// documented at length in 0121's migration header, repeated here in miniature
// so the form itself teaches it: conversion_factor is how many BASE units
// equal ONE alternate unit ("1 BOX = 12 NOS" is stored as factor 12, not
// 1/12). Wiring an alternate-unit selector into invoice entry itself is
// explicitly out of scope — see 0121's header — this panel only maintains the
// conversion table and previews it; it never touches voucher_items.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type ItemUomConversion = {
  id: string;
  item_id: string;
  alternate_uom: string;
  conversion_factor: number;
  is_purchase_uom: boolean;
  is_sales_uom: boolean;
};

const fieldSm =
  "rounded-md border border-border-strong bg-surface px-2 py-1 text-xs text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

function formatFactor(n: number) {
  // Up to 3 decimals (ref_uom's own precision ceiling), trimmed of
  // trailing zeros so a whole-number factor like 12 doesn't print as
  // "12.000".
  return Number(n.toFixed(3)).toString();
}

function ConversionRow({
  conversion,
  baseUom,
  onSaved,
}: {
  conversion: ItemUomConversion;
  baseUom: string;
  onSaved: () => void;
}) {
  const [factor, setFactor] = useState(String(conversion.conversion_factor));
  const [isPurchase, setIsPurchase] = useState(conversion.is_purchase_uom);
  const [isSales, setIsSales] = useState(conversion.is_sales_uom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const numericFactor = Number(factor);
  const dirty =
    factor !== String(conversion.conversion_factor) ||
    isPurchase !== conversion.is_purchase_uom ||
    isSales !== conversion.is_sales_uom;

  async function save() {
    if (!numericFactor || numericFactor <= 0) {
      setError("Factor must be greater than zero");
      return;
    }
    if (!isPurchase && !isSales) {
      setError("Must be usable for at least purchase or sale");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient()
      .from("item_uom_conversions")
      .update({
        conversion_factor: numericFactor,
        is_purchase_uom: isPurchase,
        is_sales_uom: isSales,
      })
      .eq("id", conversion.id);
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    onSaved();
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const { error } = await createClient()
      .from("item_uom_conversions")
      .delete()
      .eq("id", conversion.id);
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    onSaved();
  }

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2 font-mono text-xs">{conversion.alternate_uom}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs whitespace-nowrap">
          <span className="text-ink-faint">1 {conversion.alternate_uom} =</span>
          <input
            inputMode="decimal"
            value={factor}
            onChange={(e) => setFactor(e.target.value)}
            className={fieldSm + " w-20 text-right tabular-nums"}
          />
          <span className="text-ink-faint">{baseUom}</span>
        </div>
      </td>
      <td className="px-3 py-2 text-center">
        <input
          type="checkbox"
          checked={isPurchase}
          onChange={(e) => setIsPurchase(e.target.checked)}
          className="h-3.5 w-3.5"
        />
      </td>
      <td className="px-3 py-2 text-center">
        <input
          type="checkbox"
          checked={isSales}
          onChange={(e) => setIsSales(e.target.checked)}
          className="h-3.5 w-3.5"
        />
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex justify-end gap-1.5">
          {dirty && (
            <button
              type="button"
              disabled={busy}
              onClick={save}
              className="rounded border border-accent px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
            >
              Save
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="rounded border border-border-strong px-2 py-0.5 text-[11px] text-ink-soft hover:bg-error-soft hover:text-error disabled:opacity-50"
          >
            Remove
          </button>
        </div>
        {error && <p className="mt-1 text-right text-[11px] text-error">{error}</p>}
      </td>
    </tr>
  );
}

export function ItemUomPanel({
  companyId,
  item,
  uoms,
  conversions,
}: {
  companyId: string;
  item: { id: string; name: string; uom: string };
  uoms: { code: string; name: string }[];
  conversions: ItemUomConversion[];
}) {
  const router = useRouter();
  const usedCodes = new Set([item.uom, ...conversions.map((c) => c.alternate_uom)]);
  const availableUoms = uoms.filter((u) => !usedCodes.has(u.code));

  const [newUom, setNewUom] = useState(availableUoms[0]?.code ?? "");
  const [newFactor, setNewFactor] = useState("");
  const [newPurchase, setNewPurchase] = useState(true);
  const [newSales, setNewSales] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    router.refresh();
  }

  async function addConversion(e: React.FormEvent) {
    e.preventDefault();
    const factor = Number(newFactor);
    if (!newUom) {
      setError("Choose an alternate unit");
      return;
    }
    if (!factor || factor <= 0) {
      setError("Factor must be greater than zero");
      return;
    }
    if (!newPurchase && !newSales) {
      setError("Must be usable for at least purchase or sale");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().from("item_uom_conversions").insert({
      company_id: companyId,
      item_id: item.id,
      alternate_uom: newUom,
      conversion_factor: factor,
      is_purchase_uom: newPurchase,
      is_sales_uom: newSales,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setNewFactor("");
    refresh();
  }

  const previewFactor = Number(newFactor);
  const previewOk = newUom && previewFactor > 0;

  return (
    <div className="rounded-md border border-border-strong bg-bg p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">
          Alternate units for {item.name}
        </h3>
        <span className="text-xs text-ink-faint">Base unit: {item.uom}</span>
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        Used to show this item&rsquo;s stock in a second unit on reports (e.g.
        stocked in NOS, purchased by the BOX). Does not yet apply at
        invoice-entry time — a quantity is still typed and posted in the base
        unit above.
      </p>

      {conversions.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-faint">
                <th className="px-3 py-1.5 font-medium">Unit</th>
                <th className="px-3 py-1.5 font-medium">Conversion</th>
                <th className="px-3 py-1.5 text-center font-medium">Purchase</th>
                <th className="px-3 py-1.5 text-center font-medium">Sale</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {conversions.map((c) => (
                <ConversionRow key={c.id} conversion={c} baseUom={item.uom} onSaved={refresh} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={addConversion} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-ink-soft">Alternate unit</span>
          <select
            value={newUom}
            onChange={(e) => setNewUom(e.target.value)}
            className={fieldSm}
            disabled={availableUoms.length === 0}
          >
            {availableUoms.length === 0 && <option value="">No more units</option>}
            {availableUoms.map((u) => (
              <option key={u.code} value={u.code}>
                {u.code} — {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-ink-soft">
            1 {newUom || "unit"} = ? {item.uom}
          </span>
          <input
            inputMode="decimal"
            value={newFactor}
            onChange={(e) => setNewFactor(e.target.value)}
            placeholder="e.g. 12"
            className={fieldSm + " w-24 text-right tabular-nums"}
          />
        </label>
        <label className="flex items-center gap-1.5 pb-1.5 text-xs">
          <input
            type="checkbox"
            checked={newPurchase}
            onChange={(e) => setNewPurchase(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Purchase
        </label>
        <label className="flex items-center gap-1.5 pb-1.5 text-xs">
          <input
            type="checkbox"
            checked={newSales}
            onChange={(e) => setNewSales(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Sale
        </label>
        <button
          type="submit"
          disabled={busy || availableUoms.length === 0}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </form>

      {previewOk && (
        <p className="mt-1.5 text-[11px] text-ink-faint">
          Check the direction: 1 {newUom} = {formatFactor(previewFactor)} {item.uom}, so
          100 {item.uom} of stock would show as{" "}
          {formatFactor(100 / previewFactor)} {newUom}.
        </p>
      )}

      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </div>
  );
}
