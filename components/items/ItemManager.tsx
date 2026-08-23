"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";

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
  default_tcs_section: string | null;
  is_active: boolean;
};

type TcsSection = { section_code: string; description: string; rate_percent: number };

// The rates actually notified for goods and services — not every percentage
// in between, so a typo like 12.5 does not sit unnoticed on an invoice.
const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

export function ItemManager({
  companyId,
  items,
  uoms,
  tcsSections,
}: {
  companyId: string;
  items: Item[];
  uoms: { code: string; name: string }[];
  tcsSections: TcsSection[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [itemType, setItemType] = useState<"goods" | "service">("goods");
  const [hsn, setHsn] = useState("");
  const [uom, setUom] = useState("NOS");
  const [openingQty, setOpeningQty] = useState("0");
  const [openingValue, setOpeningValue] = useState("0");
  const [saleRate, setSaleRate] = useState("");
  const [gstRate, setGstRate] = useState("18");
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
        gst_rate_percent: Number(gstRate) || 0,
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
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                    No items yet. Create one on the right.
                  </td>
                </tr>
              )}
              {items.map((it) => (
                <tr
                  key={it.id}
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
                    {it.gst_rate_percent > 0 ? `${it.gst_rate_percent}%` : <span className="text-ink-faint">—</span>}
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
                </tr>
              ))}
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
            <span className="text-sm font-medium">GST rate</span>
            <select value={gstRate} onChange={(e) => setGstRate(e.target.value)} className={field}>
              {GST_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}%{r === 0 ? " — Nil / exempt" : ""}
                </option>
              ))}
            </select>
          </label>

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
