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
 *
 * ============================================================================
 * `rateSide` — THE FIXED BUG, AND WHY IT IS A PROP AND NOT A DEFAULT
 * ============================================================================
 * Until this prop existed, the one rate box on this popup was labelled "Sale
 * rate" and its value was written to items.sale_rate, unconditionally. That
 * is the correct behaviour on a sales invoice and it is WRONG NUMBERS on a
 * purchase bill: the figure in the rate column of a supplier's invoice is
 * what THEY charge US. Writing it to sale_rate puts our cost price on the
 * item master as our selling price, and the next sales invoice for that item
 * then prefills its line at cost — so the company sells at what it paid, and
 * nothing on the screen says so.
 *
 * public.items has had both columns since 0006 (sale_rate, purchase_rate,
 * confirmed live) and the popup already read purchase_rate back in its select
 * while never writing it. So this is not a new capability; it is a value
 * being put in the wrong column.
 *
 * It became urgent rather than latent when OCR capture began creating item
 * masters from photographed PURCHASE BILLS, which turns "rare" into "every
 * bill". `rateSide` is how the caller says which kind of document the popup
 * was opened from; it changes the label, the hint and the column, and it
 * changes nothing whatever when it is not passed.
 *
 * DEFAULTS TO "sale", which is exactly what this popup did before the prop
 * existed — the payload for a caller that passes nothing is the same payload,
 * key for key. The alternative (inferring the side, or defaulting to
 * purchase) would silently change what the invoice and voucher screens write.
 *
 * ============================================================================
 * `prefill` — AND WHY IT DOES NOT MAKE THIS FORM BIGGER
 * ============================================================================
 * Modelled on QuickAddLedgerModal's prop of the same name, deliberately: the
 * two popups are the two halves of one capture review screen and a preparer
 * should not meet two different idioms on one page.
 *
 * OCR capture reads a whole item master off a photographed invoice line —
 * description, HSN, unit, GST rate and a rate — and until this prop existed it
 * could only put those on COPY CHIPS beside the "+ New" button. A preparer was
 * left retyping an eight-digit HSN out of a popup that covers the text it came
 * from.
 *
 * Unlike the ledger popup, this one adds NO EXTRA FIELDS for a prefill: every
 * value capture reads already has a box here. So `prefill` only seeds what is
 * already on screen, and with no prefill this component renders and behaves
 * exactly as it did before the prop existed — same inputs, same defaults, same
 * insert. That is the invariant to preserve when touching this file, because a
 * regression here breaks ordinary daily data entry, not capture.
 *
 * Every seeded value stays EDITABLE. It was read by a vision model off a
 * photograph; a misread HSN or a rate off the wrong column has to be fixable
 * at the moment it is noticed, which is while the popup is open and the
 * document is on the screen behind it.
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
  /**
   * Read back so a caller does not have to re-select the row it was just
   * handed. The capture review screen offers to write a bill's HSN onto an
   * item that has none, and needs to know whether the preparer already typed
   * one into this popup.
   */
  hsn_sac: string | null;
};

/**
 * Which column the rate box writes to, and what it is called on screen.
 * "sale" is the default and is this popup's original, unchanged behaviour.
 */
export type ItemRateSide = "sale" | "purchase";

/**
 * Values to start from. Every field optional and nullable — a caller that
 * knows only a description passes only a name.
 *
 * Values are trusted to be SHAPED correctly (lib/capture/analyze.ts normalises
 * each one to what its items column accepts before it gets here — the UOM to a
 * ref_uom code, the HSN to 4-8 digits, the GST rate to a notified one) but are
 * still re-checked below, because "trusted" and "checked" are different things
 * and this popup is the last place a person can fix either.
 */
export type ItemPrefill = {
  name?: string | null;
  /** 4-8 digits. items_hsn_sac_check refuses anything else. */
  hsnSac?: string | null;
  /** A public.ref_uom code — items.uom is a foreign key to that table. */
  uom?: string | null;
  /** A notified rate. Anything else is ignored — see seedFromPrefill. */
  gstRatePercent?: number | null;
  /**
   * The rate printed on the document. WHICH COLUMN it lands in is `rateSide`'s
   * business, not this field's — a rate read off a purchase bill is a purchase
   * rate, and the same number read off a sales document is a sale rate.
   */
  rate?: number | null;
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
  rateSide = "sale",
  prefill,
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
  /**
   * Which side of the trade this popup was opened from, and therefore which
   * items column the one rate box writes to. Omit it and the box is the "Sale
   * rate" box it has always been — see the file header for the bug this
   * fixes and for why the default is not inferred.
   */
  rateSide?: ItemRateSide;
  /**
   * Values to start from. Omit it and this popup is byte-for-byte the popup
   * the invoice screen has always opened.
   */
  prefill?: ItemPrefill;
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
  // One box, two possible columns. Named for what it is rather than for where
  // it used to go — it was called saleRate when sale_rate was the only column
  // it could ever reach, which is exactly the bug the file header describes.
  const [rateInput, setRateInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isService = itemType === "service";
  const blockedAsService = requireStockItem && isService;
  const isPurchaseSide = rateSide === "purchase";

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

  /*
   * Seeding from the prefill — during render, not in an effect, and keyed on
   * the CONTENT of the prefill rather than on its identity. Both of those are
   * deliberate, and both are QuickAddLedgerModal's reasoning applied to the
   * other half of the same screen rather than re-derived.
   *
   * NOT AN EFFECT: this is React's own "adjusting state when a prop changes"
   * pattern (react.dev, You Might Not Need an Effect). Seeding in an effect
   * would paint the popup empty for one frame and then fill it, and this
   * project's react-hooks/set-state-in-effect rule refuses that form outright.
   * Setting state during render of THIS component is the supported shape:
   * React throws away the in-progress render and re-runs it before committing
   * anything to the DOM.
   *
   * KEYED ON CONTENT: the caller builds this object inline from an extracted
   * line — a fresh object on every render — so comparing identities would
   * reseed on every keystroke in the parent form and stamp the preparer's own
   * corrections back to the model's readings. A JSON string of the values
   * reseeds only when the values themselves change.
   *
   * `open` is folded into the key so that CLOSING the popup clears the marker
   * and a second open starts from the prefill again; reset() has emptied the
   * fields by then, and a popup that opened blank the second time would look
   * broken.
   *
   * With no prefill activeKey is "" and the only thing that ever happens here
   * is clearing a marker that is already clear — which is the whole
   * no-prefill guarantee.
   */
  const prefillKey = prefill ? JSON.stringify(prefill) : "";
  const activeKey = open ? prefillKey : "";
  const [seededKey, setSeededKey] = useState("");
  if (activeKey !== seededKey) {
    setSeededKey(activeKey);
    if (activeKey) seedFromPrefill(JSON.parse(activeKey) as ItemPrefill);
  }

  function seedFromPrefill(p: ItemPrefill) {
    setName(p.name?.trim() ?? "");
    // Digits only, and only a length items_hsn_sac_check will accept. A
    // half-read code seeded into the box would be refused at insert time on a
    // field the preparer never typed; an empty box is a question they answer.
    const hsnSeed = (p.hsnSac ?? "").replace(/\D/g, "");
    setHsn(/^\d{4,8}$/.test(hsnSeed) ? hsnSeed : "");
    // items.uom is a foreign key to ref_uom(code), so a code this popup's own
    // dropdown does not offer is an insert error rather than a wrong choice.
    // The dropdown below shows an unknown seeded code rather than silently
    // displaying a different one — see its fallback <option>.
    if (p.uom?.trim()) setUom(p.uom.trim().toUpperCase());
    // Only a rate the dropdown can actually show. A <select> whose value
    // matches no option displays the FIRST option, so seeding 9% here would
    // put "0%" on the screen and 9 in the state — the two disagreeing, with
    // nothing to see. Anything unnotified is left at the default.
    if (p.gstRatePercent != null && GST_RATES.some((r) => r === p.gstRatePercent)) {
      setGstRate(String(p.gstRatePercent));
    }
    // Which COLUMN this ends up in is rateSide's business. See the header.
    setRateInput(p.rate != null && Number.isFinite(p.rate) ? String(p.rate) : "");
    setError(null);
  }

  function reset() {
    setName("");
    setItemType("goods");
    setUom("NOS");
    setHsn("");
    setGstRate("18");
    setRateInput("");
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

    const rateValue = rateInput.trim() ? Number(rateInput) : null;

    /*
     * THE RATE, IN THE COLUMN IT BELONGS IN. A figure read off — or typed
     * beside — a supplier's bill is what they charge us and belongs in
     * purchase_rate; the same figure on a sales document is sale_rate. Before
     * rateSide existed the payload below wrote sale_rate unconditionally,
     * which put our cost price on the master as our selling price. See the
     * file header.
     *
     * Exactly ONE key is set rather than two with one of them null, so that a
     * caller which passes no rateSide sends the payload it always sent — the
     * same keys, not the same keys plus a null that overwrites nothing today
     * but is a different statement. The other column is simply absent and is
     * therefore null, which is correct: a supplier's price is no evidence at
     * all of what the goods will sell for.
     *
     * The annotation is load-bearing. Without it the ternary is a UNION of two
     * object types, and supabase-js's insert() rejects a union outright
     * (RejectExcessProperties resolves against one branch at a time and finds
     * the other branch's key missing). Both columns are nullable on
     * public.items, so one optional-keyed type is the honest shape anyway.
     */
    const rateColumn: { sale_rate?: number | null; purchase_rate?: number | null } =
      isPurchaseSide ? { purchase_rate: rateValue } : { sale_rate: rateValue };

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
      // sale_rate or purchase_rate, never both — see rateColumn above.
      ...rateColumn,
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
      .select(
        "id, name, uom, item_type, maintain_stock, sale_rate, purchase_rate, gst_rate_percent, default_tcs_section, hsn_sac"
      )
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
      hsn_sac: data.hsn_sac,
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
                {/*
                  A seeded code the reference table does not hold. Rendered so
                  the control never displays one unit while holding another —
                  a <select> whose value matches no option shows the FIRST
                  option, which would read as "NOS" while the insert carried
                  something else and failed on items_uom_fkey.

                  Costs the no-prefill path nothing and is not guarded on
                  `prefill`: while ref_uom is still loading `uoms` is null and
                  this renders nothing, and once loaded the default "NOS" is
                  always in the list.
                */}
                {uoms !== null && !uoms.some((u) => u.code === uom) && (
                  <option value={uom}>{uom} — not a notified unit</option>
                )}
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
              {isPurchaseSide ? "Purchase rate" : "Sale rate"}{" "}
              <span className="font-normal text-ink-faint">optional</span>
            </span>
            <input
              inputMode="decimal"
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
              className={field + " text-right tabular-nums"}
            />
            <span className="text-xs text-ink-faint">
              {isPurchaseSide
                ? "What this supplier charges. Saved as the purchase rate — not as what you sell it for."
                : "Prefilled onto the line — always editable there."}
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
