"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";

type PriceList = { id: string; name: string; is_default: boolean; is_active: boolean };
type PriceListItem = {
  id: string;
  price_list_id: string;
  item_id: string;
  price: number;
  effective_from: string;
};
type Item = { id: string; name: string; uom: string };

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * A simple rate-per-item table, not a slab/customer-tier system (0147). At
 * most one price list per company can be is_default — that is the one the
 * invoice line-item screen reads for its rate-prefill convenience — so the
 * only control this screen offers over that is which list gets created with
 * the default flag on; changing it away later is not built here, matching
 * this feature's own "simplest shape first" scope.
 */
export function PriceListManager({
  companyId,
  items,
  priceLists,
  priceListItems,
}: {
  companyId: string;
  items: Item[];
  priceLists: PriceList[];
  priceListItems: PriceListItem[];
}) {
  const router = useRouter();
  const [selectedListId, setSelectedListId] = useState(priceLists[0]?.id ?? "");

  // New price list form
  const [listName, setListName] = useState("");
  const [listIsDefault, setListIsDefault] = useState(priceLists.length === 0);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Add item-price form
  const [itemId, setItemId] = useState("");
  const [price, setPrice] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayLocal);
  const [rowBusy, setRowBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const selectedList = priceLists.find((p) => p.id === selectedListId);
  const rows = useMemo(
    () =>
      priceListItems
        .filter((p) => p.price_list_id === selectedListId)
        .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1)),
    [priceListItems, selectedListId]
  );

  const itemName = (id: string) => items.find((i) => i.id === id)?.name ?? "—";

  async function onCreateList(e: React.FormEvent) {
    e.preventDefault();
    setListBusy(true);
    setListError(null);
    const supabase = createClient();

    // Only one price_lists row per company may have is_default set — a
    // partial unique index enforces it (0147) — so claiming the flag for a
    // new list means clearing it off whichever one holds it first. Done as
    // two calls rather than one, since Postgres has no "insert, bumping
    // whoever currently holds this unique flag" primitive; if the insert
    // below fails after this succeeds, the company briefly has no default,
    // which only affects the invoice screen's rate-prefill convenience —
    // never anything that posts money — so it is a safe, correctable gap.
    const currentDefault = priceLists.find((p) => p.is_default);
    if (listIsDefault && currentDefault) {
      const { error: clearError } = await supabase
        .from("price_lists")
        .update({ is_default: false })
        .eq("id", currentDefault.id);
      if (clearError) {
        setListError(clearError.message);
        setListBusy(false);
        return;
      }
    }

    const { data, error } = await supabase
      .from("price_lists")
      .insert({
        company_id: companyId,
        name: listName.trim(),
        is_default: listIsDefault,
      })
      .select("id")
      .single();

    if (error) {
      setListError(error.message);
      setListBusy(false);
      return;
    }

    setListName("");
    setListIsDefault(false);
    setListBusy(false);
    setSelectedListId(data.id);
    router.refresh();
  }

  async function onAddPrice(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedListId) return;
    setRowBusy(true);
    setRowError(null);

    const { error } = await createClient().from("price_list_items").insert({
      price_list_id: selectedListId,
      company_id: companyId,
      item_id: itemId,
      price: Number(price),
      effective_from: effectiveFrom,
    });

    if (error) {
      setRowError(error.message);
      setRowBusy(false);
      return;
    }

    setItemId("");
    setPrice("");
    setRowBusy(false);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_300px]">
      <section className="min-w-0">
        {priceLists.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
            No price lists yet — create one to start suggesting rates on invoice lines.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {priceLists.map((pl) => (
                <button
                  key={pl.id}
                  type="button"
                  onClick={() => setSelectedListId(pl.id)}
                  className={
                    "rounded-full border px-3 py-1.5 text-sm transition-colors " +
                    (pl.id === selectedListId
                      ? "border-accent bg-accent text-accent-ink"
                      : "border-border-strong bg-surface text-ink-soft hover:text-ink")
                  }
                >
                  {pl.name}
                  {pl.is_default && (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-75">Default</span>
                  )}
                </button>
              ))}
            </div>

            <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-surface">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="px-4 py-2.5 font-medium">Item</th>
                    <th className="px-4 py-2.5 text-right font-medium">Price</th>
                    <th className="px-4 py-2.5 font-medium">Effective from</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-10 text-center text-ink-faint">
                        No prices on {selectedList?.name ?? "this list"} yet.
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-medium">{itemName(r.item_id)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-mono">{formatINR(r.price)}</td>
                      <td className="px-4 py-2.5 tabular-nums text-ink-soft">{r.effective_from}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selectedListId && (
              <form onSubmit={onAddPrice} className="mt-4 flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-soft">Item</span>
                  <select required value={itemId} onChange={(e) => setItemId(e.target.value)} className={field}>
                    <option value="">Select…</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-soft">Price</span>
                  <input
                    required
                    inputMode="decimal"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className={field + " w-32"}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-soft">Effective from</span>
                  <input
                    type="date"
                    required
                    value={effectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                    className={field}
                  />
                </label>
                <button
                  type="submit"
                  disabled={rowBusy}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {rowBusy ? "Adding…" : "Add price"}
                </button>
              </form>
            )}
            {rowError && <p className="mt-2 rounded-md bg-error-soft px-3 py-2 text-sm text-error">{rowError}</p>}

            <p className="mt-3 text-xs text-ink-faint">
              A price change is a new row with its own effective date, not an overwrite —
              the invoice screen always picks the latest one on or before the invoice&rsquo;s own
              date, so older invoices keep the history that was actually in force then.
            </p>
          </>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New price list</h2>
        <form onSubmit={onCreateList} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input
              required
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="e.g. Retail, Distributor"
              className={field}
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={listIsDefault}
              onChange={(e) => setListIsDefault(e.target.checked)}
              className="h-4 w-4 rounded border-border-strong"
            />
            Use as the default for invoice rate suggestions
          </label>
          {listIsDefault && priceLists.some((p) => p.is_default) && (
            <p className="text-xs text-warning">
              Only one list can be default — this replaces{" "}
              {priceLists.find((p) => p.is_default)?.name}.
            </p>
          )}

          {listError && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{listError}</p>
          )}

          <button
            type="submit"
            disabled={listBusy}
            className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {listBusy ? "Creating…" : "Create list"}
          </button>
        </form>
      </section>
    </div>
  );
}
