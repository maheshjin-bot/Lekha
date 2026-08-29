"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/Modal";

/**
 * The minimum an item needs to be billed, created without leaving the invoice
 * you discovered it was missing from.
 *
 * Deliberately NOT a second ItemManager. That form carries the opening
 * quantity and value, the four supply natures, the twelve Sec 17(5) ITC-block
 * clauses, the TCS section and the alternate-unit conversions. None of those
 * has to be right before a line can be typed; all of them are one link away.
 *
 * Two database rules are mirrored here exactly as ItemManager mirrors them,
 * rather than re-derived:
 *
 *   items_service_has_no_stock — a service cannot maintain stock and cannot
 *   carry an opening quantity. Handled the same way ItemManager handles it:
 *   maintain_stock is !isService, the unit is forced to OTH for a service,
 *   and the openings are sent as 0.
 *
 *   items_non_taxable_has_no_rate — a nil-rated, exempt or non-GST supply
 *   cannot carry a positive GST or cess rate. This modal only ever creates a
 *   TAXABLE supply, so the rule cannot be violated from here; a supply that is
 *   anything else has to be created on the full screen, where the nature can
 *   actually be chosen. Said out loud below rather than left implicit.
 */

export type QuickAddedItem = {
  id: string;
  name: string;
  uom: string;
  item_type: string;
  maintain_stock: boolean;
  sale_rate: number | null;
  purchase_rate: number | null;
  gst_rate_percent: number;
  default_tcs_section: string | null;
};

type Uom = { code: string; name: string };

// The rates actually notified for goods and services — the same list
// ItemManager offers, for the same reason: so a typo like 12.5 does not sit
// unnoticed on an invoice.
const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

export function QuickAddItemModal({
  open,
  onClose,
  companyId,
  gstOn,
  requireStockItem = false,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  gstOn: boolean;
  /**
   * Set when the item is being created for a stock line — an invoice line, in
   * practice. voucher_items carries a BEFORE INSERT trigger
   * (app_private.enforce_stock_item, migration 0013) that refuses any item
   * which is not goods-and-maintains-stock: "This item does not maintain
   * stock, so it cannot appear on a stock line". Verified live against
   * create_invoice — a service line does not fail validation, it fails the
   * insert, after the voucher header has already been numbered. So the
   * service option is offered but blocked here, with the reason, rather than
   * letting the user create something the save is guaranteed to reject.
   */
  requireStockItem?: boolean;
  onCreated: (item: QuickAddedItem) => void;
}) {
  // null means "not fetched yet" — which is also what drives the loading
  // state, so nothing has to be set synchronously inside the effect.
  const [uoms, setUoms] = useState<Uom[] | null>(null);
  const loading = open && uoms === null;

  const [name, setName] = useState("");
  const [itemType, setItemType] = useState<"goods" | "service">("goods");
  const [uom, setUom] = useState("NOS");
  const [hsn, setHsn] = useState("");
  const [gstRate, setGstRate] = useState("18");
  const [saleRate, setSaleRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isService = itemType === "service";
  const blockedAsService = requireStockItem && isService;

  // ref_uom is a reference table readable by anyone (its RLS read policy is
  // literally `true`), so the modal can fetch it itself rather than being
  // threaded a prop through two different pages. Fetched on open, not on
  // mount, so a screen that never opens it never pays for it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from("ref_uom")
        .select("code, name")
        .order("name");
      if (cancelled) return;
      setUoms(data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function reset() {
    setName("");
    setItemType("goods");
    setUom("NOS");
    setHsn("");
    setGstRate("18");
    setSaleRate("");
    setError(null);
  }

  async function submit() {
    if (busy || blockedAsService) return;
    const trimmed = name.trim();
    if (!trimmed) return setError("Give the item a name.");
    if (hsn && !/^[0-9]{4,8}$/.test(hsn))
      return setError("An HSN/SAC is 4 to 8 digits — leave it blank if you don't have it yet.");

    setBusy(true);
    setError(null);

    const row = {
      company_id: companyId,
      name: trimmed,
      item_type: itemType,
      hsn_sac: hsn.trim() || null,
      // A service cannot hold stock — the database refuses it, so the form
      // should not offer it either. Mirrors ItemManager exactly.
      uom: isService ? "OTH" : uom,
      maintain_stock: !isService,
      opening_quantity: 0,
      opening_value: 0,
      sale_rate: saleRate.trim() ? Number(saleRate) : null,
      // Quick-add only ever creates a taxable supply, so the positive rate
      // below can never collide with items_non_taxable_has_no_rate. Nil-rated,
      // exempt and non-GST supplies are created on the full items screen.
      supply_nature: "taxable",
      gst_rate_percent: gstOn ? Number(gstRate) || 0 : 0,
    };

    const { data, error: insertError } = await createClient()
      .from("items")
      .insert(row)
      // Read back what the database actually stored — the caller has to be
      // able to select an id, and a rate prefill should use the stored figure
      // rather than the string that was typed.
      .select("id, name, uom, item_type, maintain_stock, sale_rate, purchase_rate, gst_rate_percent, default_tcs_section")
      .single();

    if (insertError || !data) {
      setError(
        insertError?.code === "23505"
          ? `This company already has an item called "${trimmed}".`
          : insertError?.message ?? "The item could not be created."
      );
      setBusy(false);
      return;
    }

    onCreated({
      id: data.id,
      name: data.name,
      uom: data.uom,
      item_type: data.item_type,
      maintain_stock: data.maintain_stock,
      sale_rate: data.sale_rate === null ? null : Number(data.sale_rate),
      purchase_rate: data.purchase_rate === null ? null : Number(data.purchase_rate),
      gst_rate_percent: Number(data.gst_rate_percent),
      default_tcs_section: data.default_tcs_section,
    });
    reset();
    setBusy(false);
    onClose();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New item"
      description="Enough to bill it. The rest — openings, ITC blocking, TCS, alternate units — lives on the items screen."
      className="max-w-lg"
    >
      {/* A div, not a <form> — see QuickAddLedgerModal for why nesting one
          inside the invoice form would be a hazard. */}
      <div
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          e.stopPropagation();
          void submit();
        }}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
          />
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
                name="quick_item_type"
                checked={itemType === t}
                onChange={() => setItemType(t)}
                className="sr-only"
              />
              {t}
            </label>
          ))}
        </fieldset>

        {blockedAsService && (
          <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
            A service can&rsquo;t go on an invoice line. Invoice lines are stock
            lines, and the database refuses any item that doesn&rsquo;t maintain
            stock — the save would fail after the invoice had already been
            numbered. Create the service on the{" "}
            <Link
              href={`/${companyId}/items`}
              className="underline underline-offset-2"
            >
              items screen
            </Link>
            , or switch this back to goods.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              {isService ? "SAC" : "HSN"}{" "}
              <span className="font-normal text-ink-faint">4–8 digits, optional</span>
            </span>
            <input
              value={hsn}
              onChange={(e) => setHsn(e.target.value.replace(/\D/g, ""))}
              maxLength={8}
              className={field + " font-mono"}
            />
          </label>

          {!isService && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Unit</span>
              <select
                value={uom}
                onChange={(e) => setUom(e.target.value)}
                disabled={loading}
                className={field}
              >
                {(uoms ?? []).map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.code} — {u.name}
                  </option>
                ))}
              </select>
              <span className="text-xs text-ink-faint">
                From the notified UQC list — a GST return will not accept
                anything else.
              </span>
            </label>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {gstOn && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">GST rate</span>
              <select
                value={gstRate}
                onChange={(e) => setGstRate(e.target.value)}
                className={field}
              >
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}%
                  </option>
                ))}
              </select>
              <span className="text-xs text-ink-faint">
                Taxable supply. Nil-rated, exempt and non-GST items are created
                on the items screen.
              </span>
            </label>
          )}

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
            <span className="text-xs text-ink-faint">
              Prefilled onto the line — always editable there.
            </span>
          </label>
        </div>

        {error && (
          <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}

        <div className="mt-1 flex items-center justify-between gap-4">
          <Link
            href={`/${companyId}/items`}
            className="text-xs text-accent underline underline-offset-4"
          >
            More options — openings, supply nature, ITC, TCS, alternate units…
          </Link>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                reset();
                onClose();
              }}
              className="rounded-lg border border-border-strong px-3 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || blockedAsService}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create and select"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
