"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { ItemUomPanel, type ItemUomConversion } from "@/components/items/ItemUomPanel";
import { ItemEditPanel, type EditableItem } from "@/components/items/ItemEditPanel";
import {
  BATCH_TRACKING_MODES,
  GST_RATES,
  ITC_BLOCK_CLAUSES,
  SUPPLY_NATURES,
  friendlyItemError,
  type ItemEditContext,
} from "@/components/items/itemFields";

// The row type is now EditableItem itself: the list and the edit panel must
// read exactly the same columns, or a field would be editable but invisible.
type Item = EditableItem;

type TcsSection = { section_code: string; description: string; rate_percent: number };

export function ItemManager({
  companyId,
  items,
  uoms,
  tcsSections,
  uomConversions = [],
  editContexts = [],
  isAdmin = false,
  batchModuleActive = false,
}: {
  companyId: string;
  items: Item[];
  uoms: { code: string; name: string }[];
  tcsSections: TcsSection[];
  // Alternate-unit conversions (0121), keyed by item_id — additive to the
  // item master, not required by any caller that predates it.
  uomConversions?: ItemUomConversion[];
  // Per-item counts from get_item_edit_context (1370): which fields the edit
  // panel may offer at all. Defaulted so the component still renders if a
  // caller predates it, in which case every field simply looks unlocked and
  // protect_item_master_fields does the refusing.
  editContexts?: ItemEditContext[];
  isAdmin?: boolean;
  batchModuleActive?: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<{ id: string; panel: "uom" | "edit" } | null>(null);
  const [name, setName] = useState("");
  const [itemType, setItemType] = useState<"goods" | "service">("goods");
  const [hsn, setHsn] = useState("");
  const [uom, setUom] = useState("NOS");
  const [openingQty, setOpeningQty] = useState("0");
  const [openingValue, setOpeningValue] = useState("0");
  const [saleRate, setSaleRate] = useState("");
  const [gstRate, setGstRate] = useState("18");
  const [supplyNature, setSupplyNature] = useState("taxable");
  const [itcBlockedClause, setItcBlockedClause] = useState("");
  const [tcsSection, setTcsSection] = useState("");
  const [newBatchTracking, setNewBatchTracking] = useState("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isService = itemType === "service";
  const tcsSectionRate = (code: string | null) =>
    tcsSections.find((s) => s.section_code === code)?.rate_percent;
  const contextFor = (itemId: string) => editContexts.find((c) => c.item_id === itemId);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient()
      .from("items")
      .insert({
        company_id: companyId,
        name: name.trim(),
        item_type: itemType,
        hsn_sac: hsn.trim() || null,
        uom: isService ? "OTH" : uom,
        // A service cannot hold stock — the database refuses it, so the form
        // should not offer it either.
        maintain_stock: !isService,
        opening_quantity: isService ? 0 : Number(openingQty) || 0,
        opening_value: isService ? 0 : Number(openingValue) || 0,
        sale_rate: saleRate.trim() ? Number(saleRate) : null,
        supply_nature: supplyNature,
        // The two must agree — a block needs a clause and a clause needs a
        // block (items_itc_clause_matches_eligibility).
        itc_eligibility: itcBlockedClause ? "blocked" : "eligible",
        itc_blocked_clause: itcBlockedClause || null,
        // The database refuses a positive rate on a non-taxable supply
        // (items_non_taxable_has_no_rate). Send what that rule allows rather
        // than letting the form build a row it will reject.
        gst_rate_percent: supplyNature === "taxable" ? Number(gstRate) || 0 : 0,
        default_tcs_section: tcsSection || null,
        // items_batch_tracking_needs_stock (0067) refuses anything but 'none'
        // on a service, so send what that rule allows.
        batch_tracking: isService ? "none" : newBatchTracking,
      });

    if (error) {
      // Was error.message verbatim, so a mistyped HSN read
      // `violates check constraint "items_hsn_sac_check"` — the same defect
      // fixed for the ledger forms on 1 Sep.
      setError(friendlyItemError(error, name.trim()));
      setBusy(false);
      return;
    }

    setName("");
    setHsn("");
    setOpeningQty("0");
    setOpeningValue("0");
    setSaleRate("");
    setTcsSection("");
    setNewBatchTracking("none");
    setBusy(false);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Item</th>
                <th className="px-4 py-2.5 font-medium">HSN / SAC</th>
                <th className="px-4 py-2.5 font-medium">Unit</th>
                <th className="px-4 py-2.5 text-right font-medium">Opening</th>
                <th className="px-4 py-2.5 text-right font-medium">GST</th>
                <th className="px-4 py-2.5 font-medium">TCS</th>
                <th className="px-4 py-2.5 text-right font-medium">Sale rate</th>
                <th className="px-4 py-2.5 font-medium">Alt. units</th>
                <th className="px-4 py-2.5 font-medium">
                  <span className="sr-only">Edit</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-ink-faint">
                    No items yet. Create one on the right.
                  </td>
                </tr>
              )}
              {items.map((it) => {
                const canHaveUom = it.item_type === "goods" && it.maintain_stock;
                const itemConversions = uomConversions.filter((c) => c.item_id === it.id);
                const uomOpen = expanded?.id === it.id && expanded.panel === "uom";
                const editOpen = expanded?.id === it.id && expanded.panel === "edit";
                const trackingLabel = BATCH_TRACKING_MODES.find(
                  (m) => m.value === it.batch_tracking
                )?.label;
                return (
                <Fragment key={it.id}>
                <tr
                  className={
                    "border-b border-border last:border-0 " + (it.is_active ? "" : "opacity-60")
                  }
                >
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{it.name}</span>
                    {it.item_type === "service" && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-soft">
                        Service
                      </span>
                    )}
                    {!it.is_active && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                        Inactive
                      </span>
                    )}
                    {it.batch_tracking !== "none" && (
                      <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                        {trackingLabel}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {it.hsn_sac ?? <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="px-4 py-2.5">{it.uom}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                    {it.maintain_stock && it.opening_quantity > 0 ? (
                      <>
                        {it.opening_quantity} @ {formatINR(it.opening_value / it.opening_quantity)}
                      </>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                    {it.supply_nature === "taxable" ? (
                      `${it.gst_rate_percent}%`
                    ) : (
                      // Naming which of the three it is, rather than the bare
                      // dash a zero rate used to show — they report to
                      // different columns of GSTR-1 Table 8.
                      <span className="font-sans text-xs text-ink-soft">
                        {SUPPLY_NATURES.find((n) => n.value === it.supply_nature)?.label ??
                          it.supply_nature}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {it.default_tcs_section ? (
                      <span className="font-mono text-xs">
                        {it.default_tcs_section}
                        {tcsSectionRate(it.default_tcs_section) != null && (
                          <span className="ml-1 text-ink-faint">
                            {tcsSectionRate(it.default_tcs_section)}%
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                    {it.sale_rate ? formatINR(it.sale_rate) : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    {canHaveUom ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded(uomOpen ? null : { id: it.id, panel: "uom" })
                        }
                        className={
                          "rounded-md border px-2 py-1 text-xs " +
                          (itemConversions.length > 0
                            ? "border-accent bg-accent-soft text-accent"
                            : "border-border-strong text-ink-soft hover:bg-surface-2")
                        }
                      >
                        {itemConversions.length > 0
                          ? `${itemConversions.length} unit${itemConversions.length > 1 ? "s" : ""}`
                          : "+ Add"}
                      </button>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded(editOpen ? null : { id: it.id, panel: "edit" })
                      }
                      aria-expanded={editOpen}
                      className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium text-ink-soft hover:bg-surface-2"
                    >
                      {editOpen ? "Close" : "Edit"}
                    </button>
                  </td>
                </tr>
                {uomOpen && canHaveUom && (
                  <tr className="border-b border-border last:border-0 bg-bg">
                    <td colSpan={9} className="px-4 py-3">
                      <ItemUomPanel
                        companyId={companyId}
                        item={{ id: it.id, name: it.name, uom: it.uom }}
                        uoms={uoms}
                        conversions={itemConversions}
                      />
                    </td>
                  </tr>
                )}
                {editOpen && (
                  <tr className="border-b border-border last:border-0 bg-bg">
                    <td colSpan={9} className="px-4 py-3">
                      <ItemEditPanel
                        companyId={companyId}
                        item={it}
                        uoms={uoms}
                        tcsSections={tcsSections}
                        context={contextFor(it.id)}
                        isAdmin={isAdmin}
                        batchModuleActive={batchModuleActive}
                        onClose={() => setExpanded(null)}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New item</h2>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </label>

          <fieldset className="flex gap-2">
            {(["goods", "service"] as const).map((t) => (
              <label
                key={t}
                className={
                  "flex-1 cursor-pointer rounded-md border px-3 py-1.5 text-center text-sm capitalize transition " +
                  (itemType === t
                    ? "border-accent bg-accent-soft"
                    : "border-border-strong hover:bg-surface-2")
                }
              >
                <input
                  type="radio"
                  name="item_type"
                  checked={itemType === t}
                  onChange={() => setItemType(t)}
                  className="sr-only"
                />
                {t}
              </label>
            ))}
          </fieldset>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              {isService ? "SAC" : "HSN"}{" "}
              <span className="font-normal text-ink-faint">4–8 digits</span>
            </span>
            <input
              value={hsn}
              onChange={(e) => setHsn(e.target.value.replace(/\D/g, ""))}
              maxLength={8}
              className={field + " font-mono"}
            />
          </label>

          {!isService && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Unit</span>
                <select value={uom} onChange={(e) => setUom(e.target.value)} className={field}>
                  {uoms.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.code} — {u.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Opening qty</span>
                  <input
                    inputMode="decimal"
                    value={openingQty}
                    onChange={(e) => setOpeningQty(e.target.value)}
                    className={field + " text-right tabular-nums"}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Opening value</span>
                  <input
                    inputMode="decimal"
                    value={openingValue}
                    onChange={(e) => setOpeningValue(e.target.value)}
                    className={field + " text-right tabular-nums"}
                  />
                </label>
              </div>
              {Number(openingQty) > 0 && Number(openingValue) <= 0 && (
                <p className="text-xs text-warning">
                  An opening quantity needs a value, or the first issue is
                  costed at zero.
                </p>
              )}

              {batchModuleActive && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Batch tracking</span>
                  <select
                    value={newBatchTracking}
                    onChange={(e) => setNewBatchTracking(e.target.value)}
                    className={field}
                  >
                    {BATCH_TRACKING_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-ink-faint">
                    {BATCH_TRACKING_MODES.find((m) => m.value === newBatchTracking)?.hint}
                  </span>
                </label>
              )}
            </>
          )}

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

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Input tax credit{" "}
              <span className="font-normal text-ink-faint">
                leave blank unless Sec 17(5) blocks it
              </span>
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
            {itcBlockedClause && (
              <span className="text-xs text-warning">
                Input tax on this item will be reported as blocked and must not be claimed —
                a non-reclaimable reversal in GSTR-3B Table 4(B)(1).
              </span>
            )}
          </label>

          {supplyNature === "taxable" && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">GST rate</span>
              <select value={gstRate} onChange={(e) => setGstRate(e.target.value)} className={field}>
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}%
                  </option>
                ))}
              </select>
              <span className="text-xs text-ink-faint">
                A taxable supply at 0% is not the same as nil-rated — set the nature above if the
                goods are nil-rated, exempt or outside GST altogether.
              </span>
            </label>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              TCS section{" "}
              <span className="font-normal text-ink-faint">
                optional — only the specified goods 206C still covers (scrap,
                minerals, liquor, vehicles, timber…)
              </span>
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

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Sale rate <span className="font-normal text-ink-faint">optional</span>
            </span>
            <input
              inputMode="decimal"
              value={saleRate}
              onChange={(e) => setSaleRate(e.target.value)}
              className={field + " text-right tabular-nums"}
            />
          </label>

          {error && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add item"}
          </button>
        </form>
      </section>
    </div>
  );
}
