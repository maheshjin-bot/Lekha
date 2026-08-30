"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR, sumPaise, toPaise } from "@/lib/utils/currency";
import {
  QuickAddLedgerModal,
  type QuickAddedLedger,
} from "@/components/ledgers/QuickAddLedgerModal";
import {
  QuickAddItemModal,
  type QuickAddedItem,
} from "@/components/items/QuickAddItemModal";
import { VoucherNumberField } from "@/components/numbering/VoucherNumberField";
import {
  PURCHASE_TRADING_ROLES,
  SALE_TRADING_ROLES,
} from "@/lib/invoices/trading-roles";
import {
  friendlyNumberingError,
  validateManualNumber,
  type VoucherNumberingByBranch,
} from "@/lib/numbering/voucher-numbering";

type Item = {
  id: string;
  name: string;
  uom: string;
  sale_rate: number | null;
  purchase_rate: number | null;
  gst_rate_percent: number;
  default_tcs_section: string | null;
};
type Ledger = {
  id: string;
  name: string;
  ledger_role: string;
  state_code: string | null;
  pan: string | null;
  // Read only by the ship-to disclosure, to prefill a delivery address from a
  // party already on file. Never read for the bill-to side, which prints from
  // the party ledger itself.
  address?: string | null;
  city?: string | null;
  pincode?: string | null;
  gstin?: string | null;
};
type Branch = { id: string; code: string; name: string; registeredState: string | null };
type Godown = { id: string; code: string; name: string };
type StateOption = { code: string; name: string };
type TcsSection = {
  section_code: string;
  rate_percent: number;
  no_pan_rate_percent: number;
  threshold_rupees: number | null;
};
// One item's rate on the company's DEFAULT price list only (see get_effective_item_price,
// 0147) — a convenience prefill, never a hard lock, so the form only ever needs the one
// list the invoice screen defaults to rather than asking "which list" per line.
type PriceListEntry = { item_id: string; price: number; effective_from: string };

const TYPES = [
  { value: "sales", label: "Sales invoice", party: "Customer", trading: "Sales ledger", roles: ["debtor", "cash_bank"] },
  { value: "purchase", label: "Purchase bill", party: "Supplier", trading: "Purchase ledger", roles: ["creditor", "cash_bank"] },
  { value: "credit_note", label: "Credit note", party: "Customer", trading: "Sales ledger", roles: ["debtor", "cash_bank"] },
  { value: "debit_note", label: "Debit note", party: "Supplier", trading: "Purchase ledger", roles: ["creditor", "cash_bank"] },
] as const;

// The trading-ledger role lists live in lib/invoices/trading-roles.ts, not
// here: the edit page needs the same lists to recover a saved invoice's
// trading ledger, and a server component cannot import a value out of a
// "use client" module — it receives a client reference, not the array.

type Line = { itemId: string; quantity: string; rate: string; discountPercent: string; description: string };
const emptyLine = (): Line => ({ itemId: "", quantity: "1", rate: "", discountPercent: "", description: "" });

// Mirrors create_invoice/update_invoice's own per-line formula exactly (0147):
// gross = round(qty * rate, 2); discount = round(gross * discPct / 100, 2);
// net = gross - discount. Used by every client-side preview below so the
// number shown here never disagrees with what the database will actually post.
function lineAmounts(quantity: string, rate: string, discountPercent: string) {
  const qty = Number(quantity) || 0;
  const r = Number(rate) || 0;
  const discPct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const gross = Math.round(qty * r * 100) / 100;
  const discount = Math.round(((gross * discPct) / 100) * 100) / 100;
  const net = Math.round((gross - discount) * 100) / 100;
  return { gross, discount, net };
}

/**
 * The invoice's delivery address, when it differs from the billing address —
 * public.voucher_ship_to (migration 0805), one row per voucher.
 *
 * It is NOT a tax input. Under Sec 10(1)(b) IGST Act the place of supply of a
 * bill-to/ship-to supply is the principal place of business of the third
 * person directing the delivery — the party the invoice is billed to — so
 * nothing here touches placeOfSupply, and the form says so on screen.
 */
export type ShipTo = {
  ledgerId: string;
  name: string;
  address: string;
  city: string;
  stateCode: string;
  pincode: string;
  gstin: string;
};

const emptyShipTo = (): ShipTo => ({
  ledgerId: "",
  name: "",
  address: "",
  city: "",
  stateCode: "",
  pincode: "",
  gstin: "",
});

/**
 * An existing invoice being edited. voucherType and branchId are read but
 * not editable once numbered — same reason VoucherForm's ExistingVoucher
 * treats them the same way: the voucher number's prefix already encodes the
 * type, and re-deriving it would desync the number from what it claims.
 */
export type ExistingInvoice = {
  id: string;
  voucherNumber: string;
  voucherType: (typeof TYPES)[number]["value"];
  financialYearLabel: string;
  branchId: string;
  date: string;
  partyId: string;
  tradingId: string;
  godownId: string;
  placeOfSupply: string;
  reference: string;
  /**
   * vouchers.challan_number / challan_date (migration 0865) — the delivery
   * challan this invoice was raised against. A DIFFERENT fact from
   * `reference`, which is the counterparty's own document number; a sale can
   * carry both at once. Empty strings, not nulls, so they drop straight into
   * the controlled inputs below.
   */
  challanNumber: string;
  challanDate: string;
  narration: string;
  lines: Line[];
  /** The voucher_ship_to row on file, or null when goods go where the bill goes. */
  shipTo: ShipTo | null;
};

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Server-fetched rows first, then anything quick-added in this session that
 * the server has not caught up with yet, then sorted the same way the server
 * ordered its own query (by name).
 *
 * The dedup is the point: this form's props come from a server component, and
 * a quick-add ends with router.refresh(), so a moment later the same row
 * arrives from BOTH sides. Keyed on id, the server's copy wins — it is the
 * authoritative one, and it carries any column the insert's narrow
 * `.select(...)` did not read back. Sorting rather than appending means the
 * new row does not jump position when the refresh lands.
 */
function mergeById<T extends { id: string; name: string }>(server: T[], added: T[]): T[] {
  const known = new Set(server.map((r) => r.id));
  return [...server, ...added.filter((a) => !known.has(a.id))].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

/** The popup's row, narrowed to what this form actually reads off a ledger. */
function toLedger(l: QuickAddedLedger): Ledger {
  return {
    id: l.id,
    name: l.name,
    // From the ledger's GROUP, exactly as the page's own flatLedgers mapping
    // derives it — never from ledgers.ledger_role, which is a Schedule III
    // presentation override and is not what the party dropdown filters on.
    ledger_role: l.ledger_role,
    state_code: l.state_code,
    pan: l.pan,
  };
}

/** The popup's row, narrowed to what this form actually reads off an item. */
function toItem(i: QuickAddedItem): Item {
  return {
    id: i.id,
    name: i.name,
    uom: i.uom,
    sale_rate: i.sale_rate,
    purchase_rate: i.purchase_rate,
    gst_rate_percent: i.gst_rate_percent,
    default_tcs_section: i.default_tcs_section,
  };
}

export function InvoiceForm({
  companyId,
  items,
  ledgers,
  branches,
  godowns,
  gstOn,
  tcsOn,
  tcsSections,
  states,
  priceListItems = [],
  numbering = {},
  existing,
}: {
  companyId: string;
  items: Item[];
  ledgers: Ledger[];
  branches: Branch[];
  godowns: Godown[];
  gstOn: boolean;
  tcsOn: boolean;
  tcsSections: TcsSection[];
  states: StateOption[];
  priceListItems?: PriceListEntry[];
  /**
   * The company's numbering policy per branch and voucher type (migration
   * 0725), fetched by the page exactly as items, ledgers, branches and
   * godowns are. Absent on the edit screen; an empty object means automatic,
   * which is both the safe fallback and the true state of every company that
   * has not deliberately changed it.
   */
  numbering?: VoucherNumberingByBranch;
  existing?: ExistingInvoice;
}) {
  const router = useRouter();
  const isEdit = Boolean(existing);
  const [voucherType, setVoucherType] = useState<(typeof TYPES)[number]["value"]>(existing?.voucherType ?? "sales");
  const [branchId, setBranchId] = useState(existing?.branchId ?? branches[0]?.id ?? "");
  const [godownId, setGodownId] = useState(existing?.godownId ?? godowns[0]?.id ?? "");
  const [date, setDate] = useState(existing?.date ?? todayLocal);
  const [partyId, setPartyId] = useState(existing?.partyId ?? "");
  const [tradingId, setTradingId] = useState(existing?.tradingId ?? "");
  const [placeOfSupply, setPlaceOfSupply] = useState(existing?.placeOfSupply ?? "");
  // Editing an invoice whose place of supply is already on file must not let
  // the party-change effect below silently override it with a guess.
  const [placeOfSupplyTouched, setPlaceOfSupplyTouched] = useState(isEdit);
  const [reference, setReference] = useState(existing?.reference ?? "");
  // Migration 0865. Kept separate from `reference` on purpose: on a sale the
  // reference is the customer's PO number and this is our own outgoing
  // delivery challan's number, and an invoice raised after goods moved on a
  // challan (Rule 55(4)) routinely carries both.
  const [challanNumber, setChallanNumber] = useState(existing?.challanNumber ?? "");
  const [challanDate, setChallanDate] = useState(existing?.challanDate ?? "");
  const [narration, setNarration] = useState(existing?.narration ?? "");
  const [lines, setLines] = useState<Line[]>(existing?.lines.length ? existing.lines : [emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ship-to (migration 0805). Collapsed by default and gated behind one
  // checkbox: the overwhelming majority of invoices deliver to the billing
  // address, and five more always-visible fields would tax every preparer to
  // serve the minority. The checkbox is also the delete affordance — clearing
  // it on an invoice that has a delivery address on file removes the row.
  const [shipToOn, setShipToOn] = useState(Boolean(existing?.shipTo));
  const [shipTo, setShipTo] = useState<ShipTo>(existing?.shipTo ?? emptyShipTo());
  const setShip = (patch: Partial<ShipTo>) => setShipTo((p) => ({ ...p, ...patch }));

  // Numbering (0725). Only ever consulted on a NEW invoice: an issued number
  // is fixed, so the edit screen passes no policy and renders no control.
  const [manualNumber, setManualNumber] = useState("");
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const policy = isEdit ? undefined : numbering[branchId]?.[voucherType];
  const seriesOptions = policy?.mode === "series" ? policy.series : [];
  // Resolved rather than stored, so switching between a sales invoice and a
  // credit note — or between branches — can never leave a series selected
  // that belongs to the type you just left. An id no longer on offer falls
  // back to that type's default series.
  const effectiveSeriesId = seriesOptions.some((s) => s.id === seriesId)
    ? seriesId
    : (seriesOptions.find((s) => s.isDefault)?.id ?? seriesOptions[0]?.id ?? null);

  // Quick-added masters, held locally until the server catches up. Without
  // this the popup could not select what it just created: props arrive from a
  // server component, and router.refresh() is a round trip — selecting an id
  // that is not in the list yet would silently reset the select to blank.
  const [addedLedgers, setAddedLedgers] = useState<Ledger[]>([]);
  const [addedItems, setAddedItems] = useState<Item[]>([]);
  const [partyModalOpen, setPartyModalOpen] = useState(false);
  const [tradingModalOpen, setTradingModalOpen] = useState(false);
  const [itemModalLine, setItemModalLine] = useState<number | null>(null);

  const allLedgers = useMemo(() => mergeById(ledgers, addedLedgers), [ledgers, addedLedgers]);
  const allItems = useMemo(() => mergeById(items, addedItems), [items, addedItems]);

  const config = TYPES.find((t) => t.value === voucherType)!;
  const isSale = voucherType === "sales" || voucherType === "credit_note";

  // The party side hard-filters by ledger role — a sale cannot be billed to a
  // supplier. The trading side stays open, since a business may post to any
  // of several income or expense ledgers.
  const tradingRoles: readonly string[] = isSale ? SALE_TRADING_ROLES : PURCHASE_TRADING_ROLES;
  const partyLedgers = allLedgers.filter((l) => (config.roles as readonly string[]).includes(l.ledger_role));
  const tradingLedgers = allLedgers.filter((l) => tradingRoles.includes(l.ledger_role));

  // Which role a quick-added party has to be created under, taken from the
  // TYPES row above rather than restated: its first entry is the party's own
  // role ('debtor' for a sale or credit note, 'creditor' for a purchase or
  // debit note), the second being the cash/bank alternative a counter sale
  // uses. A ledger created under any other role would not appear in the very
  // dropdown it was created from, because that dropdown filters on the role
  // of the ledger's GROUP.
  const partyRole = config.roles[0];

  const branch = branches.find((b) => b.id === branchId);

  // Place of supply defaults to the party's state on file — the same rule
  // create_invoice applies server-side — but only until the user picks one
  // themselves. A party with no recorded state leaves this blank, which is
  // deliberate: guessing the wrong state here is worse than asking. Applied
  // directly in the party select's onChange (below) rather than as an effect
  // reacting to partyId, so the lookup always runs against the same ledgers
  // snapshot as the selection itself.
  function selectParty(newPartyId: string) {
    setPartyId(newPartyId);
    if (placeOfSupplyTouched) return;
    const party = allLedgers.find((l) => l.id === newPartyId);
    if (party?.state_code) setPlaceOfSupply(party.state_code);
  }

  // Copying a party's address into the ship-to takes a SNAPSHOT — the fields
  // stay editable afterwards and are what actually get stored and printed.
  // The ledger id is kept alongside only as provenance, because a master's
  // address may legitimately change long after an invoice was issued and the
  // issued invoice must keep showing what was on it. Same reasoning as the
  // 0805 migration's ship_to_ledger_id comment.
  function copyShipToFromLedger(ledgerId: string) {
    if (!ledgerId) return setShip({ ledgerId: "" });
    const l = allLedgers.find((x) => x.id === ledgerId);
    if (!l) return setShip({ ledgerId: "" });
    setShip({
      ledgerId,
      name: l.name,
      address: l.address ?? "",
      city: l.city ?? "",
      stateCode: l.state_code ?? "",
      pincode: l.pincode ?? "",
      gstin: l.gstin ?? "",
    });
  }

  // Every ledger that actually has an address or a state to copy. Not limited
  // to the party dropdown's own role filter: a customer's other site, a
  // sister concern's warehouse or a job worker are all legitimate consignees,
  // and none of them is necessarily a debtor.
  const shipToLedgerOptions = allLedgers.filter((l) => l.address || l.state_code);

  const partyState = allLedgers.find((l) => l.id === partyId)?.state_code ?? null;
  const shipToIsElsewhere =
    shipToOn && shipTo.stateCode !== "" && partyState !== null && shipTo.stateCode !== partyState;

  const supplyType =
    gstOn && branch?.registeredState && placeOfSupply
      ? branch.registeredState === placeOfSupply
        ? "intra"
        : "inter"
      : null;

  // Post-discount (net) taxable value per line — Sec 15(3)(a)/Rule 46(k),
  // see 0147. lineAmounts mirrors create_invoice's own formula exactly.
  const taxable = useMemo(
    () =>
      sumPaise(
        lines.map((l) => toPaise(lineAmounts(l.quantity, l.rate, l.discountPercent).net))
      ) / 100,
    [lines]
  );

  // Mirrors create_invoice's per-line rounding exactly — computed here only
  // to show the user what the server will post, not as the figure that gets
  // submitted. The database is still the one that actually decides.
  const tax = useMemo(() => {
    if (!supplyType) return { cgst: 0, sgst: 0, igst: 0 };
    let cgst = 0, sgst = 0, igst = 0;
    for (const l of lines) {
      const item = allItems.find((x) => x.id === l.itemId);
      if (!item || !item.gst_rate_percent) continue;
      const amount = lineAmounts(l.quantity, l.rate, l.discountPercent).net;
      if (supplyType === "intra") {
        const half = Math.round(((amount * item.gst_rate_percent) / 2 / 100) * 100) / 100;
        cgst += half;
        sgst += half;
      } else {
        igst += Math.round(((amount * item.gst_rate_percent) / 100) * 100) / 100;
      }
    }
    return { cgst, sgst, igst };
  }, [lines, allItems, supplyType]);

  // Mirrors create_invoice's TCS math exactly, for the same display-only
  // reason as `tax` above. Only sales and credit notes ever carry TCS, only
  // when the module is on, only for lines whose item names a section, and
  // only above that section's threshold (if it has one) — on the line's own
  // taxable amount, never the invoice total.
  const tcs = useMemo(() => {
    if (!tcsOn || !isSale) return 0;
    const party = allLedgers.find((l) => l.id === partyId);
    const hasPan = !!party?.pan;
    let total = 0;
    for (const l of lines) {
      const item = allItems.find((x) => x.id === l.itemId);
      if (!item || !item.default_tcs_section) continue;
      const section = tcsSections.find((s) => s.section_code === item.default_tcs_section);
      if (!section) continue;
      const amount = lineAmounts(l.quantity, l.rate, l.discountPercent).net;
      if (section.threshold_rupees != null && amount <= section.threshold_rupees) continue;
      // This line's own GST, computed inline rather than reused from `tax`
      // above, since that memo only keeps invoice-wide totals.
      let lineGst = 0;
      if (supplyType && item.gst_rate_percent) {
        if (supplyType === "intra") {
          const half = Math.round(((amount * item.gst_rate_percent) / 2 / 100) * 100) / 100;
          lineGst = half + half;
        } else {
          lineGst = Math.round(((amount * item.gst_rate_percent) / 100) * 100) / 100;
        }
      }
      const base = amount + lineGst;
      const rate = hasPan ? section.rate_percent : section.no_pan_rate_percent;
      total += Math.round(((base * rate) / 100) * 100) / 100;
    }
    return total;
  }, [tcsOn, isSale, lines, allItems, tcsSections, allLedgers, partyId, supplyType]);

  const grandTotal = taxable + tax.cgst + tax.sgst + tax.igst + tcs;

  // The company's default price list (0147), as of the invoice's own date —
  // NOT necessarily today, so a back-dated invoice still prefills the rate
  // that was actually in force on that date. Sales side only: a price list
  // represents what this company charges a customer, which has no bearing
  // on what a supplier billed on a purchase.
  function priceListRate(itemId: string): number | undefined {
    if (!isSale) return undefined;
    const candidates = priceListItems.filter((p) => p.item_id === itemId && p.effective_from <= date);
    if (!candidates.length) return undefined;
    return candidates.reduce((latest, p) => (p.effective_from > latest.effective_from ? p : latest)).price;
  }

  function update(i: number, patch: Partial<Line>) {
    setLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== i) return l;
        const next = { ...l, ...patch };
        // Prefill the rate when an item is picked and the rate is still
        // blank — never overwrite something already typed. The price list
        // (if it has an entry effective on this invoice's date) takes
        // priority over the item master's flat sale_rate/purchase_rate,
        // since it is the more specific, more recently-updated figure —
        // still just a suggestion, still fully editable either way.
        if (patch.itemId && !l.rate) {
          const it = allItems.find((x) => x.id === patch.itemId);
          const suggested = priceListRate(patch.itemId) ?? (isSale ? it?.sale_rate : it?.purchase_rate);
          if (suggested) next.rate = String(suggested);
        }
        return next;
      })
    );
  }

  /**
   * A ledger the popup just created. Selected here rather than through
   * selectParty(), because setAddedLedgers and the selection happen in the
   * same event: allLedgers still holds the previous render's array at this
   * point, so the state lookup selectParty does would miss. The place of
   * supply is taken straight off the row the insert returned instead.
   */
  function onPartyCreated(created: QuickAddedLedger) {
    setAddedLedgers((prev) => [...prev, toLedger(created)]);
    setPartyId(created.id);
    if (!placeOfSupplyTouched && created.state_code) setPlaceOfSupply(created.state_code);
    router.refresh();
  }

  function onTradingCreated(created: QuickAddedLedger) {
    setAddedLedgers((prev) => [...prev, toLedger(created)]);
    setTradingId(created.id);
    router.refresh();
  }

  /**
   * An item the popup just created, selected onto the line it was opened
   * from. Same reason as above for not routing through update(): its rate
   * prefill reads allItems, which does not contain this row until the next
   * render, so the rate is taken from the returned row here instead. An
   * already-typed rate is never overwritten — the same rule update() applies.
   */
  function onItemCreated(lineIndex: number, created: QuickAddedItem) {
    setAddedItems((prev) => [...prev, toItem(created)]);
    setLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== lineIndex) return l;
        const suggested = isSale ? created.sale_rate : created.purchase_rate;
        return {
          ...l,
          itemId: created.id,
          rate: l.rate || (suggested ? String(suggested) : ""),
        };
      })
    );
    router.refresh();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const filled = lines.filter((l) => l.itemId && Number(l.quantity) > 0);
    if (!filled.length) return setError("Add at least one item line.");
    if (!partyId) return setError(`Select a ${config.party.toLowerCase()}.`);
    if (!tradingId) return setError(`Select a ${config.trading.toLowerCase()}.`);
    if (taxable <= 0) return setError("The invoice must come to more than zero.");
    if (gstOn && !placeOfSupply) return setError("Select a place of supply.");
    // The same rule app_private.assert_rule46b_number applies, checked here so
    // the preparer reads a sentence rather than waiting for a round trip that
    // fails — and, on a tax invoice, so a number the IRP would reject never
    // gets issued in the first place.
    if (policy?.mode === "manual") {
      const problem = validateManualNumber(manualNumber);
      if (problem) return setError(problem);
    }
    // Checked here rather than left to the database, because the ship-to is
    // written AFTER the invoice has already been posted and numbered — a
    // round-trip failure at that point cannot be undone by re-submitting.
    // These are the table's own NOT NULLs and its gstin/state CHECK (0805),
    // stated as sentences.
    if (shipToOn) {
      if (!shipTo.name.trim()) return setError("Give the delivery address a name, or untick “Deliver to a different address”.");
      if (!shipTo.address.trim()) return setError("Enter the delivery address, or untick “Deliver to a different address”.");
      if (!shipTo.stateCode) return setError("Select the delivery address's state — a GST invoice must name it (Rule 46).");
      const g = shipTo.gstin.trim().toUpperCase();
      if (g && g.length !== 15) return setError("A delivery GSTIN is 15 characters, or leave it blank.");
      if (g && g.slice(0, 2) !== shipTo.stateCode) {
        return setError("The delivery GSTIN starts with a different state code than the state selected beside it.");
      }
      if (shipTo.pincode.trim() && !/^[1-9][0-9]{5}$/.test(shipTo.pincode.trim())) {
        return setError("A delivery PIN code is six digits and cannot start with 0, or leave it blank.");
      }
    }

    setBusy(true);

    // The two trailing arguments migration 0865 added to BOTH create_invoice
    // and update_invoice. Spread into each call rather than written inline
    // because types/database.types.ts — owned by the integration pass — does
    // not know them yet, so the object has to carry the escape hatch once
    // instead of twice. undefined is dropped from the request body by
    // supabase-js and falls through to the SQL default, exactly as every
    // other optional argument here does.
    //
    // A date with no number is deliberately still sent: the database accepts
    // it, because a challan whose printed number is illegible is still dated.
    const challanArgs = {
      p_challan_number: challanNumber.trim() || undefined,
      p_challan_date: challanDate || undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    } as any;

    const items_payload = filled.map((l) => ({
      item_id: l.itemId,
      quantity: Number(l.quantity),
      rate: Number(l.rate) || 0,
      discount_percent: Number(l.discountPercent) || 0,
      description: l.description.trim() || null,
    }));

    const { data, error } = existing
      ? await createClient().rpc("update_invoice", {
          p_voucher_id: existing.id,
          p_voucher_date: date,
          p_party_ledger_id: partyId,
          p_trading_ledger_id: tradingId,
          p_godown_id: godownId,
          p_items: items_payload,
          p_narration: narration.trim() || undefined,
          p_reference_number: reference.trim() || undefined,
          p_place_of_supply: placeOfSupply || undefined,
          ...challanArgs,
        })
      : await createClient().rpc("create_invoice", {
          p_company_id: companyId,
          p_branch_id: branchId,
          p_voucher_type: voucherType,
          p_voucher_date: date,
          p_party_ledger_id: partyId,
          p_trading_ledger_id: tradingId,
          p_godown_id: godownId,
          p_items: items_payload,
          p_narration: narration.trim() || undefined,
          p_reference_number: reference.trim() || undefined,
          p_place_of_supply: placeOfSupply || undefined,
          // Exactly one of these, and only when the mode calls for it.
          // next_voucher_number REFUSES a series it was not asked for in
          // automatic mode, and resolve_manual_voucher_number refuses a typed
          // number outside manual mode — both deliberately, so a UI bug cannot
          // quietly fork a company's GST series. undefined is dropped from the
          // request body by supabase-js and falls through to the SQL default,
          // exactly as every other optional argument here does.
          p_voucher_number: policy?.mode === "manual" ? manualNumber.trim() : undefined,
          p_number_series_id:
            policy?.mode === "series" ? (effectiveSeriesId ?? undefined) : undefined,
          ...challanArgs,
        });

    if (error) {
      setError(friendlyNumberingError(error.message));
      setBusy(false);
      return;
    }

    // The ship-to is a separate row keyed on the voucher, so it can only be
    // written once the voucher exists — which on a new invoice means after
    // create_invoice has already numbered and posted it. A failure here is
    // therefore reported rather than treated as a failed save: the invoice is
    // real, and re-submitting the form would raise a second one.
    const voucherId = existing ? existing.id : (data as unknown as string);
    // voucher_ship_to is brand new (migration 0805) and types/database.types.ts
    // — owned by the integration pass — does not know it yet. Same convention
    // as components/einvoice/EinvoiceDetailForm.tsx.
    const shipToErr = shipToOn
      ? (
          await createClient()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
            .from("voucher_ship_to" as any)
            .upsert(
              {
                company_id: companyId,
                voucher_id: voucherId,
                ship_to_ledger_id: shipTo.ledgerId || null,
                ship_to_name: shipTo.name.trim(),
                ship_to_address: shipTo.address.trim(),
                ship_to_city: shipTo.city.trim() || null,
                ship_to_state_code: shipTo.stateCode,
                ship_to_pincode: shipTo.pincode.trim() || null,
                ship_to_gstin: shipTo.gstin.trim().toUpperCase() || null,
              },
              { onConflict: "voucher_id" }
            )
        ).error
      : existing?.shipTo
        ? (
            await createClient()
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
              .from("voucher_ship_to" as any)
              .delete()
              .eq("voucher_id", voucherId)
          ).error
        : null;

    if (shipToErr) {
      toast.error(
        `The invoice was saved, but its delivery address was not: ${shipToErr.message}. Open the invoice and edit it to try again.`
      );
    }

    router.push(`/${companyId}/vouchers/${voucherId}`);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";
  const cell =
    "w-full rounded border border-transparent bg-transparent px-2 py-1.5 outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <form onSubmit={onSubmit} className="mt-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Type</span>
          <select
            value={voucherType}
            disabled={isEdit}
            onChange={(e) => {
              setVoucherType(e.target.value as typeof voucherType);
              selectParty("");
              setTradingId("");
            }}
            className={field + (isEdit ? " opacity-60" : "")}
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Date</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={field} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            Reference <span className="font-normal text-ink-faint">optional</span>
          </span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={isSale ? "Their PO no." : "Their bill no."}
            className={field}
          />
        </label>

        {/* Migration 0865. A separate field from Reference above, not a
            rewording of it: Reference is the counterparty's document number
            and this is the delivery challan the goods actually moved on —
            ours on a sale (Rule 55(4): challan first, tax invoice after),
            the supplier's on a purchase. Both routinely appear on one
            invoice, which is exactly why one text box could not hold them. */}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            Challan no. <span className="font-normal text-ink-faint">optional</span>
          </span>
          <input
            value={challanNumber}
            onChange={(e) => setChallanNumber(e.target.value)}
            placeholder={isSale ? "Our challan no." : "Their challan no."}
            className={field}
          />
          <span className="text-xs text-ink-faint">
            {isSale
              ? "The delivery challan these goods went out on."
              : "The challan these goods arrived on."}
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            Challan date <span className="font-normal text-ink-faint">optional</span>
          </span>
          <input
            type="date"
            value={challanDate}
            onChange={(e) => setChallanDate(e.target.value)}
            className={field}
          />
          <span className="text-xs text-ink-faint">
            {/* Sec 31(7): where goods went out on approval, the six-month
                clock for issuing the invoice runs from the date of REMOVAL —
                which is the challan's date, not this invoice's. */}
            Usually earlier than the invoice date.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Branch</span>
          <select
            value={branchId}
            disabled={isEdit}
            onChange={(e) => setBranchId(e.target.value)}
            className={field + (isEdit ? " opacity-60" : "")}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </select>
        </label>

        {/* Nothing at all in automatic mode — see VoucherNumberField. */}
        <VoucherNumberField
          policy={policy}
          manualNumber={manualNumber}
          onManualNumberChange={setManualNumber}
          seriesId={effectiveSeriesId}
          onSeriesIdChange={setSeriesId}
        />

        {/* Read-only on purpose. The number is allocated once, when the invoice
            is posted, and is very likely already printed on a document sent to
            the customer and filed in GSTR-1; update_invoice takes no number
            argument at all, so there is nothing here for an input to send. */}
        {isEdit && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Invoice number</span>
            <span className="rounded-lg border border-border bg-bg px-3 py-2 text-sm font-mono text-ink-soft">
              {existing!.voucherNumber}
            </span>
            <span className="text-xs text-ink-faint">Fixed once issued.</span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium">{config.party}</span>
            <button
              type="button"
              onClick={() => setPartyModalOpen(true)}
              className="text-xs text-accent underline underline-offset-4"
            >
              + New
            </button>
          </div>
          <select
            required
            aria-label={config.party}
            value={partyId}
            onChange={(e) => selectParty(e.target.value)}
            className={field}
          >
            <option value="">Select…</option>
            {partyLedgers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium">{config.trading}</span>
            <button
              type="button"
              onClick={() => setTradingModalOpen(true)}
              className="text-xs text-accent underline underline-offset-4"
            >
              + New
            </button>
          </div>
          <select
            required
            aria-label={config.trading}
            value={tradingId}
            onChange={(e) => setTradingId(e.target.value)}
            className={field}
          >
            <option value="">Select…</option>
            {tradingLedgers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Godown</span>
          <select value={godownId} onChange={(e) => setGodownId(e.target.value)} className={field}>
            {godowns.map((g) => (
              <option key={g.id} value={g.id}>
                {g.code} — {g.name}
              </option>
            ))}
          </select>
        </label>

        {gstOn && (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Place of supply</span>
            <select
              required
              value={placeOfSupply}
              onChange={(e) => {
                setPlaceOfSupply(e.target.value);
                setPlaceOfSupplyTouched(true);
              }}
              className={field}
            >
              <option value="">Select…</option>
              {states.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
            {!branch?.registeredState && (
              <span className="text-xs text-warning">
                This branch has no GST registration — tax cannot be computed
                from it.
              </span>
            )}
          </label>
        )}
      </div>

      {/* Bill-to / ship-to (migration 0805). A disclosure, not five more
          fields: almost every invoice delivers to the billing address, and
          the ones that do not are the exception the preparer opens this for.
          The checkbox is the whole switch — ticking it reveals the address,
          unticking it on a saved invoice deletes the one on file. */}
      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={shipToOn}
            onChange={(e) => setShipToOn(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            <span className="text-sm font-medium text-ink">Deliver to a different address</span>
            <span className="mt-0.5 block text-xs text-ink-faint">
              Bill-to / ship-to. Printed as the address of delivery, which a tax invoice must
              show when it differs from the place of supply (CGST Rule 46).
            </span>
          </span>
        </label>

        {shipToOn && (
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5 sm:col-span-3">
              <span className="text-sm font-medium">
                Copy from a party <span className="font-normal text-ink-faint">optional</span>
              </span>
              <select
                value={shipTo.ledgerId}
                onChange={(e) => copyShipToFromLedger(e.target.value)}
                className={field}
              >
                <option value="">Type it in below…</option>
                {shipToLedgerOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <span className="text-xs text-ink-faint">
                Fills the fields below once. They stay editable, and what you leave here is what
                gets stored — a later change to that party&rsquo;s address will not rewrite this
                invoice.
              </span>
            </label>

            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-sm font-medium">Deliver to</span>
              <input
                required
                value={shipTo.name}
                onChange={(e) => setShip({ name: e.target.value })}
                placeholder="Consignee name"
                className={field}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                GSTIN <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input
                value={shipTo.gstin}
                onChange={(e) => setShip({ gstin: e.target.value.toUpperCase() })}
                maxLength={15}
                placeholder="Of the delivery site"
                className={field + " font-mono"}
              />
            </label>

            <label className="flex flex-col gap-1.5 sm:col-span-3">
              <span className="text-sm font-medium">Address of delivery</span>
              <textarea
                required
                rows={2}
                value={shipTo.address}
                onChange={(e) => setShip({ address: e.target.value })}
                placeholder="Street, area, landmark"
                className={field}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                City <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input
                value={shipTo.city}
                onChange={(e) => setShip({ city: e.target.value })}
                className={field}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">State</span>
              <select
                required
                value={shipTo.stateCode}
                onChange={(e) => setShip({ stateCode: e.target.value })}
                className={field}
              >
                <option value="">Select…</option>
                {states.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                PIN code <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input
                value={shipTo.pincode}
                onChange={(e) => setShip({ pincode: e.target.value })}
                inputMode="numeric"
                maxLength={6}
                className={field + " font-mono"}
              />
            </label>

            {/* The one thing a preparer is most likely to get wrong, said
                where the mistake would be made. Sec 10(1)(b) IGST Act deems
                the third person directing the delivery to have received the
                goods, so the place of supply is THEIR principal place of
                business — the bill-to party — not wherever the lorry stops.
                Following the ship-to instead would swap CGST+SGST for IGST or
                the reverse. */}
            {shipToIsElsewhere && (
              <p className="rounded-lg border border-border-strong bg-bg px-3 py-2.5 text-xs text-ink-soft sm:col-span-3">
                The goods leave the state the invoice is billed in, and the tax does not follow
                them. Place of supply stays with{" "}
                <span className="font-medium text-ink">
                  {allLedgers.find((l) => l.id === partyId)?.name ?? "the billed party"}
                </span>{" "}
                — Sec 10(1)(b) IGST Act deems the party directing the delivery to have received
                the goods, so their own state decides CGST+SGST or IGST. The delivery address
                here is printed on the invoice and used for the e-Way Bill; it changes neither
                the tax head nor the place of supply.
              </p>
            )}
          </div>
        )}
      </section>

      {/* Two renderings of the same `lines` state: stacked cards below
          sm:, the original table from sm: up. Seven columns need
          horizontal scroll to fit under ~640px, and the borderless
          table-cell inputs are a poor touch target — the exact gap the
          dossier's own audit (F-12) flagged as "desktop-only in practice". */}
      <div className="mt-6 flex flex-col gap-3 sm:hidden">
        {lines.map((line, i) => {
          const item = allItems.find((x) => x.id === line.itemId);
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
                    onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))}
                    className="rounded px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-soft"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-2.5">
                <div className="flex items-end gap-1.5">
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="text-xs text-ink-faint">Item</span>
                    <select
                      aria-label={`Item on line ${i + 1}`}
                      value={line.itemId}
                      onChange={(e) => update(i, { itemId: e.target.value })}
                      className={field}
                    >
                      <option value="">Select an item…</option>
                      {allItems.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => setItemModalLine(i)}
                    aria-label={`New item for line ${i + 1}`}
                    className="shrink-0 rounded-lg border border-border-strong px-2.5 py-2 text-xs text-accent"
                  >
                    + New
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2.5">
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
          onClick={() => setLines((p) => [...p, emptyLine()])}
          className="self-start rounded px-2 py-1 text-xs text-accent underline underline-offset-4"
        >
          Add line
        </button>

        <div className="rounded-lg border border-border bg-bg p-3 text-sm">
          <div className="flex justify-between tabular-nums font-mono">
            <span className="text-ink-faint">Taxable value</span>
            <span>{formatINR(taxable, { showZero: true })}</span>
          </div>
          {supplyType === "intra" && (tax.cgst > 0 || tax.sgst > 0) && (
            <>
              <div className="mt-1 flex justify-between tabular-nums font-mono text-xs text-ink-soft">
                <span>CGST</span>
                <span>{formatINR(tax.cgst)}</span>
              </div>
              <div className="mt-1 flex justify-between tabular-nums font-mono text-xs text-ink-soft">
                <span>SGST</span>
                <span>{formatINR(tax.sgst)}</span>
              </div>
            </>
          )}
          {supplyType === "inter" && tax.igst > 0 && (
            <div className="mt-1 flex justify-between tabular-nums font-mono text-xs text-ink-soft">
              <span>IGST</span>
              <span>{formatINR(tax.igst)}</span>
            </div>
          )}
          {tcs > 0 && (
            <div className="mt-1 flex justify-between tabular-nums font-mono text-xs text-ink-soft">
              <span>TCS</span>
              <span>{formatINR(tcs)}</span>
            </div>
          )}
          <div className="mt-2 flex justify-between border-t border-border-strong pt-2 tabular-nums font-mono font-semibold">
            <span>Total</span>
            <span>{formatINR(grandTotal, { showZero: true })}</span>
          </div>
        </div>
      </div>

      <div className="mt-6 hidden overflow-x-auto rounded-lg border border-border bg-surface sm:block">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-3 py-2.5 font-medium">Item</th>
              <th className="w-24 px-3 py-2.5 text-right font-medium">Qty</th>
              <th className="w-16 px-3 py-2.5 font-medium">Unit</th>
              <th className="w-28 px-3 py-2.5 text-right font-medium">Rate</th>
              <th className="w-20 px-3 py-2.5 text-right font-medium">Disc %</th>
              {gstOn && <th className="w-16 px-3 py-2.5 text-right font-medium">GST</th>}
              <th className="w-32 px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const item = allItems.find((x) => x.id === line.itemId);
              const { gross, discount, net } = lineAmounts(line.quantity, line.rate, line.discountPercent);
              return (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <select
                        aria-label={`Item on line ${i + 1}`}
                        value={line.itemId}
                        onChange={(e) => update(i, { itemId: e.target.value })}
                        className={cell}
                      >
                        <option value="">Select an item…</option>
                        {allItems.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setItemModalLine(i)}
                        aria-label={`New item for line ${i + 1}`}
                        title="Create an item without leaving this invoice"
                        className="shrink-0 rounded px-1.5 py-1 text-xs text-accent underline underline-offset-4"
                      >
                        + New
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => update(i, { quantity: e.target.value })}
                      className={cell + " text-right tabular-nums"}
                    />
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-faint">{item?.uom ?? "—"}</td>
                  <td className="px-3 py-2">
                    <input
                      inputMode="decimal"
                      value={line.rate}
                      onChange={(e) => update(i, { rate: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && i === lines.length - 1) {
                          e.preventDefault();
                          setLines((p) => [...p, emptyLine()]);
                        }
                      }}
                      className={cell + " text-right tabular-nums"}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      inputMode="decimal"
                      value={line.discountPercent}
                      placeholder="0"
                      onChange={(e) => update(i, { discountPercent: e.target.value })}
                      className={cell + " text-right tabular-nums"}
                    />
                  </td>
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
                        onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))}
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
            <tr className="border-t border-border bg-bg">
              <td className="px-3 py-2.5" colSpan={gstOn ? 6 : 5}>
                <button
                  type="button"
                  onClick={() => setLines((p) => [...p, emptyLine()])}
                  className="rounded px-2 py-1 text-xs text-accent underline underline-offset-4"
                >
                  Add line
                </button>
              </td>
              <td className="px-3 py-2.5 text-right font-medium tabular-nums font-mono">
                {formatINR(taxable, { showZero: true })}
              </td>
              <td />
            </tr>
            {(tax.cgst > 0 || tax.sgst > 0 || tax.igst > 0 || tcs > 0) && (
              <>
                {supplyType === "intra" ? (
                  <>
                    <tr className="text-xs text-ink-soft">
                      <td className="px-3 py-1" colSpan={gstOn ? 6 : 5}>
                        CGST
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums font-mono">{formatINR(tax.cgst)}</td>
                      <td />
                    </tr>
                    <tr className="text-xs text-ink-soft">
                      <td className="px-3 py-1" colSpan={gstOn ? 6 : 5}>
                        SGST
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums font-mono">{formatINR(tax.sgst)}</td>
                      <td />
                    </tr>
                  </>
                ) : supplyType === "inter" ? (
                  <tr className="text-xs text-ink-soft">
                    <td className="px-3 py-1" colSpan={gstOn ? 6 : 5}>
                      IGST
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums font-mono">
                      {formatINR(tax.igst)}
                    </td>
                    <td />
                  </tr>
                ) : null}
                {tcs > 0 && (
                  <tr className="text-xs text-ink-soft">
                    <td className="px-3 py-1" colSpan={gstOn ? 6 : 5}>
                      TCS
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums font-mono">{formatINR(tcs)}</td>
                    <td />
                  </tr>
                )}
                <tr className="border-t-2 border-border-strong font-semibold">
                  <td className="px-3 py-2.5" colSpan={gstOn ? 6 : 5}>
                    Total
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-mono">
                    {formatINR(grandTotal, { showZero: true })}
                  </td>
                  <td />
                </tr>
              </>
            )}
          </tfoot>
        </table>
      </div>

      <label className="mt-5 flex flex-col gap-1.5">
        <span className="text-sm font-medium">Narration</span>
        <textarea
          rows={2}
          value={narration}
          onChange={(e) => setNarration(e.target.value)}
          className={field}
        />
      </label>

      {error && (
        <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}

      <p className="mt-5 text-xs text-ink-faint">
        Saving records the stock movement, the tax and the ledger entries
        together, in one transaction — never any of them without the others.
      </p>

      <button
        type="submit"
        disabled={busy || taxable <= 0}
        className="mt-3 w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50 sm:w-auto"
      >
        {busy ? "Saving…" : isEdit ? "Save changes" : `Save ${config.label.toLowerCase()}`}
      </button>

      {/* The three popups. Rendered inside the form so they sit next to the
          state they feed, but each is an overlay and none of them is a nested
          <form> — see QuickAddLedgerModal for why that matters here. */}
      <QuickAddLedgerModal
        open={partyModalOpen}
        onClose={() => setPartyModalOpen(false)}
        companyId={companyId}
        title={`New ${config.party.toLowerCase()}`}
        description={`Created under a ${partyRole === "debtor" ? "receivables" : "payables"} group, so it appears in the ${config.party.toLowerCase()} list straight away.`}
        roles={[partyRole]}
        onCreated={onPartyCreated}
      />

      <QuickAddLedgerModal
        open={tradingModalOpen}
        onClose={() => setTradingModalOpen(false)}
        companyId={companyId}
        title={`New ${config.trading.toLowerCase()}`}
        description={
          isSale
            ? "An income ledger — what the sale is credited to."
            : "An expense ledger — what the purchase is debited to."
        }
        roles={tradingRoles}
        onCreated={onTradingCreated}
      />

      <QuickAddItemModal
        open={itemModalLine !== null}
        onClose={() => setItemModalLine(null)}
        companyId={companyId}
        gstOn={gstOn}
        // An invoice line is a stock line — voucher_items refuses anything
        // that does not maintain stock. See the prop's own comment.
        requireStockItem
        onCreated={(created) => {
          if (itemModalLine !== null) onItemCreated(itemModalLine, created);
        }}
      />
    </form>
  );
}
