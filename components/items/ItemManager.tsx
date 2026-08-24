"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { ItemUomPanel, type ItemUomConversion } from "@/components/items/ItemUomPanel";

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
  gst_rate_percent: number;
  supply_nature: string;
  default_tcs_section: string | null;
  is_active: boolean;
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
}: {
  companyId: string;
  items: Item[];
  uoms: { code: string; name: string }[];
  tcsSections: TcsSection[];
  // Alternate-unit conversions (0121), keyed by item_id — additive to the
  // item master, not required by any caller that predates it.
  uomConversions?: ItemUomConversion[];
}) {
  const router = useRouter();
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isService = itemType === "service";
  const tcsSectionRate = (code: string | null) =>
    tcsSections.find((s) => s.section_code === code)?.rate_percent;

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
    setSaleRate("");
    setTcsSection("");
    setBusy(false);
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
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-ink-faint">
                    No items yet. Create one on the right.
                  </td>
                </tr>
              )}
              {items.map((it) => {
                const canHaveUom = it.item_type === "goods" && it.maintain_stock;
                const itemConversions = uomConversions.filter((c) => c.item_id === it.id);
                const expanded = expandedItemId === it.id;
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
                </tr>
                {expanded && canHaveUom && (
                  <tr className="border-b border-border last:border-0 bg-bg">
                    <td colSpan={8} className="px-4 py-3">
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
