"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { ItemUomPanel, type ItemUomConversion } from "@/components/items/ItemUomPanel";
import { callRpc } from "@/lib/supabase/rpc";

type Item = {
  id: string;
  code: string | null;
  name: string;
  item_type: string;
  hsn_sac: string | null;
  uom: string;
  maintain_stock: boolean;
  opening_quantity: number;
  opening_value: number;
  sale_rate: number | null;
  purchase_rate: number | null;
  gst_rate_percent: number;
  cess_rate_percent: number;
  supply_nature: string;
  itc_blocked_clause: string | null;
  default_tcs_section: string | null;
  is_rcm_applicable: boolean;
  is_active: boolean;
  // 1370: 'none' | 'batch' | 'serial'. Governs whether this item can ever
  // appear on /batches, Reports > Stock expiry, or the batch half of
  // /stock-verification — see BatchManager.tsx, which has pointed a
  // preparer here since it shipped, long before this field had a writer.
  batch_tracking: string;
};

type TcsSection = { section_code: string; description: string; rate_percent: number };

// The rates actually notified for goods and services — not every percentage
// in between, so a typo like 12.5 does not sit unnoticed on an invoice.
const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

// Four legally distinct categories that a zero rate used to collapse into one.
// Zero-rated (export/SEZ) is deliberately absent: it is a property of the
// transaction, not of the item — the same goods are taxable domestically.
// Sec 17(5) blocks ITC on these however genuine the business purpose. The
// clause is stored alongside the flag so an auditor can be told which limb
// applies, not merely that something does.
const ITC_BLOCK_CLAUSES = [
  { value: "17(5)(a)", label: "17(5)(a) — Motor vehicles (13 seats or fewer)" },
  { value: "17(5)(aa)", label: "17(5)(aa) — Vessels and aircraft" },
  { value: "17(5)(ab)", label: "17(5)(ab) — Insurance, servicing, repair of the above" },
  { value: "17(5)(b)", label: "17(5)(b) — Food, catering, club, insurance, travel benefits" },
  { value: "17(5)(c)", label: "17(5)(c) — Works contract for immovable property" },
  { value: "17(5)(d)", label: "17(5)(d) — Construction on own account" },
  { value: "17(5)(e)", label: "17(5)(e) — Supplies taxed under composition" },
  { value: "17(5)(f)", label: "17(5)(f) — Supplies to a non-resident taxable person" },
  { value: "17(5)(fa)", label: "17(5)(fa) — CSR expenditure" },
  { value: "17(5)(g)", label: "17(5)(g) — Personal consumption" },
  { value: "17(5)(h)", label: "17(5)(h) — Gifts, free samples, goods lost or written off" },
  { value: "17(5)(i)", label: "17(5)(i) — Tax paid under Sec 74, 129 or 130" },
];

// 1370: mirrors the live items_batch_tracking_check constraint exactly —
// these are the only three values the database accepts.
const BATCH_TRACKING_OPTIONS = [
  { value: "none", label: "Not tracked" },
  { value: "batch", label: "Batch / lot" },
  { value: "serial", label: "Serial number" },
];

const SUPPLY_NATURES = [
  { value: "taxable", label: "Taxable", hint: "Attracts GST at the rate below" },
  { value: "nil_rated", label: "Nil-rated", hint: "Taxable under GST, tariff rate 0% — no ITC" },
  { value: "exempt", label: "Exempt", hint: "Exempted by notification (Sec 11) — no ITC" },
  { value: "non_gst", label: "Non-GST", hint: "Outside GST — petrol, diesel, alcohol" },
];

export function ItemManager({
  companyId,
  items,
  uoms,
  tcsSections,
  uomConversions = [],
  usedItemIds = [],
  godowns = [],
}: {
  companyId: string;
  items: Item[];
  uoms: { code: string; name: string }[];
  tcsSections: TcsSection[];
  // Alternate-unit conversions (0121), keyed by item_id — additive to the
  // item master, not required by any caller that predates it.
  uomConversions?: ItemUomConversion[];
  // 2210: which godown a NEW item's opening stock actually sits in — only
  // meaningful when there's more than one to choose from (see the create
  // form below). Never used for editing: opening_quantity/opening_value are
  // create-time-only fields, update_item has no parameter for either.
  godowns?: { id: string; name: string; is_default: boolean }[];
  // 1840: item ids that appear on at least one voucher_items line. item_type,
  // maintain_stock and uom are refused on these by the live
  // app_private.protect_item_master_fields trigger regardless of what this
  // list says — it is used here only to disable those controls in the edit
  // form up front, so a preparer never fills in a whole edit only to have it
  // refused at the end.
  usedItemIds?: string[];
}) {
  const router = useRouter();
  const usedIds = new Set(usedItemIds);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [itemType, setItemType] = useState<"goods" | "service">("goods");
  const [hsn, setHsn] = useState("");
  const [uom, setUom] = useState("NOS");
  const [openingQty, setOpeningQty] = useState("0");
  const [openingValue, setOpeningValue] = useState("0");
  // 2210: only asked when it's genuinely ambiguous. A single-godown company
  // has nowhere else the opening stock could be, so godowns.length <= 1
  // resolves it silently below with no field shown at all.
  const [openingGodownId, setOpeningGodownId] = useState("");
  const [saleRate, setSaleRate] = useState("");
  const [gstRate, setGstRate] = useState("18");
  const [supplyNature, setSupplyNature] = useState("taxable");
  const [itcBlockedClause, setItcBlockedClause] = useState("");
  const [tcsSection, setTcsSection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isService = itemType === "service";
  const tcsSectionRate = (code: string | null) =>
    tcsSections.find((s) => s.section_code === code)?.rate_percent;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const openingQtyNum = isService ? 0 : Number(openingQty) || 0;
    // 2210: with two or more godowns and a real opening quantity, there is
    // no fallback left to resolve it — get_stock_summary's item_home_godown
    // would otherwise place this item in no godown at all until its first
    // voucher, showing its full value company-wide and zero in every
    // per-godown view. Asked here, once, rather than left for the report to
    // silently mislead on later.
    if (openingQtyNum > 0 && godowns.length > 1 && !openingGodownId) {
      setError(
        "This company has more than one godown — pick which one the opening quantity actually sits in."
      );
      return;
    }

    setBusy(true);

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
        opening_quantity: openingQtyNum,
        opening_value: isService ? 0 : Number(openingValue) || 0,
        // 2210: null when there's nothing to disambiguate (service item,
        // zero opening qty, or a single-godown company where the existing
        // "company's only godown" fallback already gets it right).
        opening_godown_id:
          isService || openingQtyNum <= 0
            ? null
            : godowns.length === 1
              ? godowns[0].id
              : openingGodownId || null,
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
      });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    setName("");
    setHsn("");
    setOpeningQty("0");
    setOpeningValue("0");
    setOpeningGodownId("");
    setSaleRate("");
    setTcsSection("");
    setBusy(false);
    router.refresh();
  }

  // ---------------------------------------------------------------------
  // 1840 — edit an existing item via the update_item RPC. Kept as one flat
  // draft object rather than one useState per field: the create form above
  // predates this and already shows what one-state-per-field costs in wiring
  // for this many fields, and this form only exists while a row is expanded.
  // ---------------------------------------------------------------------
  type EditDraft = {
    name: string;
    itemType: "goods" | "service";
    hsn: string;
    uom: string;
    saleRate: string;
    purchaseRate: string;
    supplyNature: string;
    gstRate: string;
    cessRate: string;
    itcBlockedClause: string;
    tcsSection: string;
    isRcmApplicable: boolean;
    isActive: boolean;
    batchTracking: string;
  };
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function startEdit(it: Item) {
    setExpandedItemId(null);
    setEditingItemId(it.id);
    setEditError(null);
    setEditDraft({
      name: it.name,
      itemType: it.item_type === "service" ? "service" : "goods",
      hsn: it.hsn_sac ?? "",
      uom: it.uom,
      saleRate: it.sale_rate != null ? String(it.sale_rate) : "",
      purchaseRate: it.purchase_rate != null ? String(it.purchase_rate) : "",
      supplyNature: it.supply_nature,
      gstRate: String(it.gst_rate_percent),
      cessRate: String(it.cess_rate_percent),
      itcBlockedClause: it.itc_blocked_clause ?? "",
      tcsSection: it.default_tcs_section ?? "",
      isRcmApplicable: it.is_rcm_applicable,
      isActive: it.is_active,
      batchTracking: it.batch_tracking,
    });
  }

  function cancelEdit() {
    setEditingItemId(null);
    setEditDraft(null);
    setEditError(null);
  }

  async function saveEdit(itemId: string) {
    if (!editDraft) return;
    setEditBusy(true);
    setEditError(null);

    const isEditingService = editDraft.itemType === "service";
    // update_item's p_hsn_sac/p_sale_rate/p_purchase_rate/p_itc_blocked_clause/
    // p_default_tcs_section have no SQL DEFAULT, so the generated Args type
    // requires their base (non-null) type even though Postgres happily
    // accepts an explicit null for any of them — a required parameter is not
    // the same thing as a non-nullable one. Routed through callRpc (not the
    // typed .rpc()) to pass null through rather than lying with a cast.
    const { error } = await callRpc(createClient(), "update_item", {
      p_item_id: itemId,
      p_name: editDraft.name.trim(),
      p_item_type: editDraft.itemType,
      p_hsn_sac: editDraft.hsn.trim() || null,
      // 1841: never force "OTH" here — that is correct only on CREATE, where
      // a brand-new row has no prior uom to preserve. On EDIT, startEdit()
      // already seeded editDraft.uom with the item's real current unit, and
      // the Unit <select> below is only even rendered for a goods item, so a
      // service's editDraft.uom is simply left untouched by the user. Forcing
      // "OTH" here silently rewrote a service item's real unit (HRS, NOS...)
      // on every save, which for any item with existing voucher history is
      // then refused outright by protect_item_master_fields as an
      // unauthorized unit change the user never asked for — including on the
      // very save meant only to flip is_rcm_applicable — and for an item
      // with no history yet, silently corrupted the unit with no error at
      // all. editDraft.uom is always the right value for both item types.
      p_uom: editDraft.uom,
      // Same rule the create form applies: a service never maintains stock.
      // Whether this item is even allowed to change type/uom at all is
      // enforced by the database (app_private.protect_item_master_fields),
      // not by this client — see the disabled-controls note below.
      p_maintain_stock: !isEditingService,
      p_sale_rate: editDraft.saleRate.trim() ? Number(editDraft.saleRate) : null,
      p_purchase_rate: editDraft.purchaseRate.trim() ? Number(editDraft.purchaseRate) : null,
      p_supply_nature: editDraft.supplyNature,
      p_gst_rate_percent: editDraft.supplyNature === "taxable" ? Number(editDraft.gstRate) || 0 : 0,
      p_cess_rate_percent: editDraft.supplyNature === "taxable" ? Number(editDraft.cessRate) || 0 : 0,
      p_itc_blocked_clause: editDraft.itcBlockedClause || null,
      p_default_tcs_section: editDraft.tcsSection || null,
      p_is_rcm_applicable: editDraft.isRcmApplicable,
      p_is_active: editDraft.isActive,
      // items_batch_tracking_needs_stock refuses 'batch'/'serial' on
      // anything but a goods item that maintains stock — a service can
      // never carry it, same rule the control below is hidden under.
      p_batch_tracking: isEditingService ? "none" : editDraft.batchTracking,
    });

    if (error) {
      setEditError(error.message);
      setEditBusy(false);
      return;
    }

    setEditBusy(false);
    cancelEdit();
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[620px] text-sm">
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
                <th className="px-4 py-2.5 font-medium"><span className="sr-only">Actions</span></th>
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
                const expanded = expandedItemId === it.id;
                const editing = editingItemId === it.id;
                const locked = usedIds.has(it.id);
                return (
                <Fragment key={it.id}>
                <tr
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{it.name}</span>
                    {it.item_type === "service" && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-soft">
                        Service
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
                    {it.is_rcm_applicable && (
                      <span className="ml-1.5 rounded bg-warning-soft px-1 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide text-warning">
                        RCM
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
                        onClick={() => setExpandedItemId(expanded ? null : it.id)}
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
                      onClick={() => (editing ? cancelEdit() : startEdit(it))}
                      className="rounded-md border border-border-strong px-2 py-1 text-xs text-ink-soft hover:bg-surface-2"
                    >
                      {editing ? "Close" : "Edit"}
                    </button>
                  </td>
                </tr>
                {editing && editDraft && (
                  <tr className="border-b border-border last:border-0 bg-bg">
                    <td colSpan={9} className="px-4 py-4">
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          saveEdit(it.id);
                        }}
                        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
                      >
                        <label className="flex flex-col gap-1.5">
                          <span className="text-sm font-medium">Name</span>
                          <input
                            required
                            value={editDraft.name}
                            onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                            className={field}
                          />
                        </label>

                        <label className="flex flex-col gap-1.5">
                          <span className="text-sm font-medium">
                            Type{" "}
                            {locked && (
                              <span className="font-normal text-ink-faint">
                                locked — used on {"≥"}1 voucher
                              </span>
                            )}
                          </span>
                          <select
                            value={editDraft.itemType}
                            disabled={locked}
                            onChange={(e) =>
                              setEditDraft({
                                ...editDraft,
                                itemType: e.target.value as "goods" | "service",
                              })
                            }
                            className={field + " disabled:opacity-60"}
                          >
                            <option value="goods">Goods</option>
                            <option value="service">Service</option>
                          </select>
                        </label>

                        <label className="flex flex-col gap-1.5">
                          <span className="text-sm font-medium">
                            {editDraft.itemType === "service" ? "SAC" : "HSN"}
                          </span>
                          <input
                            value={editDraft.hsn}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, hsn: e.target.value.replace(/\D/g, "") })
                            }
                            maxLength={8}
                            className={field + " font-mono"}
                          />
                        </label>

                        {editDraft.itemType === "goods" && (
                          <label className="flex flex-col gap-1.5">
                            <span className="text-sm font-medium">
                              Unit{" "}
                              {locked && (
                                <span className="font-normal text-ink-faint">locked</span>
                              )}
                            </span>
                            <select
                              value={editDraft.uom}
                              disabled={locked}
                              onChange={(e) => setEditDraft({ ...editDraft, uom: e.target.value })}
                              className={field + " disabled:opacity-60"}
                            >
                              {uoms.map((u) => (
                                <option key={u.code} value={u.code}>
                                  {u.code} — {u.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}

                        {editDraft.itemType === "goods" && (
                          <label className="flex flex-col gap-1.5">
                            <span className="text-sm font-medium">Batch tracking</span>
                            <select
                              value={editDraft.batchTracking}
                              onChange={(e) =>
                                setEditDraft({ ...editDraft, batchTracking: e.target.value })
                              }
                              className={field}
                            >
                              {BATCH_TRACKING_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                            <span className="text-xs text-ink-faint">
                              Turns this item on for /batches, Stock expiry and batch/serial
                              allocation on vouchers.
                            </span>
                          </label>
                        )}

                        <label className="flex flex-col gap-1.5">
                          <span className="text-sm font-medium">Supply nature</span>
                          <select
                            value={editDraft.supplyNature}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, supplyNature: e.target.value })
                            }
                            className={field}
                          >
                            {SUPPLY_NATURES.map((n) => (
                              <option key={n.value} value={n.value}>
                                {n.label}
                              </option>
                            ))}
                          </select>
                        </label>

                        {editDraft.supplyNature === "taxable" && (
                          <label className="flex flex-col gap-1.5">
                            <span className="text-sm font-medium">GST rate</span>
                            <select
                              value={editDraft.gstRate}
                              onChange={(e) =>
                                setEditDraft({ ...editDraft, gstRate: e.target.value })
                              }
                              className={field}
                            >
                              {GST_RATES.map((r) => (
                                <option key={r} value={r}>
                                  {r}%
                                </option>
                              ))}
                            </select>
                          </label>
                        )}

                        {editDraft.supplyNature === "taxable" && (
                          <label className="flex flex-col gap-1.5">
                            <span className="text-sm font-medium">Cess rate %</span>
                            <input
                              inputMode="decimal"
                              value={editDraft.cessRate}
                              onChange={(e) =>
                                setEditDraft({ ...editDraft, cessRate: e.target.value })
                              }
                              className={field + " text-right tabular-nums"}
                            />
                          </label>
                        )}

                        <label className="flex flex-col gap-1.5">
                          <span className="text-sm font-medium">
                            Input tax credit{" "}
                            <span className="font-normal text-ink-faint">blank = claimable</span>
                          </span>
                          <select
                            value={editDraft.itcBlockedClause}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, itcBlockedClause: e.target.value })
                            }
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
                          <span className="text-sm font-medium">TCS section</span>
                          <select
                            value={editDraft.tcsSection}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, tcsSection: e.target.value })
                            }
                            className={field}
                          >
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
                            value={editDraft.saleRate}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, saleRate: e.target.value })
                            }
                            className={field + " text-right tabular-nums"}
                          />
                        </label>

                        <label className="flex flex-col gap-1.5">
                          <span className="text-sm font-medium">
                            Purchase rate <span className="font-normal text-ink-faint">optional</span>
                          </span>
                          <input
                            inputMode="decimal"
                            value={editDraft.purchaseRate}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, purchaseRate: e.target.value })
                            }
                            className={field + " text-right tabular-nums"}
                          />
                        </label>

                        <label className="flex items-start gap-2 sm:col-span-2">
                          <input
                            type="checkbox"
                            checked={editDraft.isRcmApplicable}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, isRcmApplicable: e.target.checked })
                            }
                            className="mt-0.5"
                          />
                          <span className="text-sm">
                            <span className="font-medium">Reverse charge (Sec 9(3)/9(4))</span>
                            <br />
                            <span className="text-xs text-ink-faint">
                              A purchase of this item self-assesses GST via RCM Payable instead of
                              the supplier charging it — GTA freight, an advocate&rsquo;s fee,
                              security services, director&rsquo;s fees and the like.
                            </span>
                          </span>
                        </label>

                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={editDraft.isActive}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, isActive: e.target.checked })
                            }
                          />
                          <span className="text-sm font-medium">Active</span>
                        </label>

                        {editError && (
                          <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error sm:col-span-2 lg:col-span-4">
                            {editError}
                          </p>
                        )}

                        <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
                          <button
                            type="submit"
                            disabled={editBusy}
                            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
                          >
                            {editBusy ? "Saving…" : "Save changes"}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="rounded-lg border border-border-strong px-4 py-2 text-sm text-ink-soft hover:bg-surface-2"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                )}
                {expanded && canHaveUom && (
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
              {Number(openingQty) > 0 && godowns.length > 1 && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Opening godown</span>
                  <select
                    value={openingGodownId}
                    onChange={(e) => setOpeningGodownId(e.target.value)}
                    className={field}
                  >
                    <option value="">— select —</option>
                    {godowns.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                        {g.is_default ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-ink-faint">
                    Where this opening quantity physically sits — with more
                    than one godown, the stock report can&rsquo;t place it
                    anywhere on its own until this item&rsquo;s first voucher.
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
