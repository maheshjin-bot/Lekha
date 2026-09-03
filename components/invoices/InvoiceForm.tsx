"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronUp } from "lucide-react";
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
import { Combobox } from "@/components/ui/Combobox";
import { useGridNav } from "@/components/ui/EntryGrid";
import { VoucherNumberField } from "@/components/numbering/VoucherNumberField";
import { useShortcuts } from "@/lib/keys/useShortcuts";
import { SessionStrip, type SessionStripEntry } from "@/components/vouchers/SessionStrip";
import { AllocationDrawer, type DrawerAllocation } from "@/components/allocations/AllocationDrawer";
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
  // Migration 1480. An item that does not maintain stock is billed as a
  // CHARGE LINE — freight, processing, installation and the like — which
  // carries its SAC, rate, amount and GST onto the invoice and into both GST
  // registers, and moves no inventory. Read here only to label the line and
  // to say what the godown does not cover: the database derives
  // voucher_items.moves_stock from the item master itself, so nothing in the
  // submitted payload has to carry it, and nothing here can get it wrong.
  item_type: string;
  maintain_stock: boolean;
  hsn_sac: string | null;
};

/**
 * Whether a line on this item moves stock — the same predicate
 * app_private.enforce_stock_item applies server-side, and the reason a
 * service can be invoiced but still never reaches the stock ledger.
 */
function movesStock(item: Item) {
  return item.item_type === "goods" && item.maintain_stock;
}

/**
 * Names a charge line in the picker itself, so the difference is understood
 * before the choice is made rather than explained after it. Goods that simply
 * are not stock-tracked behave identically to a service on the invoice, but
 * calling them one would be wrong, so they say what they actually are.
 */
function itemOptionLabel(item: Item) {
  if (movesStock(item)) return item.name;
  return `${item.name} — ${item.item_type === "service" ? "service" : "no stock"}`;
}

/**
 * What a charge line is, shown on the line itself. The SAC is here because
 * Rule 46(g) CGST Rules requires a code for services exactly as it does for
 * goods, and because a preparer who sees it blank on the invoice has to know
 * to go and put it on the item master — quantity, by contrast, is a goods-only
 * particular under Rule 46(i), which is why nothing here asks for one.
 */
function ChargeLineNote({ item }: { item: Item }) {
  return (
    <p className="mt-1 text-[11px] text-ink-faint">
      Charge line · {item.hsn_sac ? `SAC ${item.hsn_sac}` : "no SAC on the item master"} · moves no
      stock
    </p>
  );
}

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
  // Read by the tax preview: a purchase/debit-note from an
  // unregistered or composition supplier carries no input tax at all
  // (Sec 32(1)/Sec 10(4) — such a supplier cannot lawfully charge GST),
  // mirroring create_invoice's own 1230 rule.
  gst_registration_type?: string | null;
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
    gst_registration_type: l.gst_registration_type,
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
    item_type: i.item_type,
    maintain_stock: i.maintain_stock,
    hsn_sac: i.hsn_sac,
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
  // AppShell's Alt+P (purchase bill) and Alt+D (debit note) global shortcuts
  // land here via /invoices/new?type=purchase|debit_note — a `type` query
  // param, read once on mount, that preselects the right option in the type
  // selector below instead of always opening on "Sales invoice". Only a
  // fresh /new (never an edit, which already has its own real voucherType)
  // honours it, and only when the value is one this form actually knows —
  // an unrecognised or absent param falls back to the pre-existing "sales"
  // default exactly as before this was added.
  const searchParams = useSearchParams();
  const typeParam = searchParams.get("type");
  const initialVoucherType =
    !isEdit && typeParam && TYPES.some((t) => t.value === typeParam)
      ? (typeParam as (typeof TYPES)[number]["value"])
      : "sales";
  const [voucherType, setVoucherType] = useState<(typeof TYPES)[number]["value"]>(
    existing?.voucherType ?? initialVoucherType,
  );
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

  // F4 (session strip) — every invoice saved via "save & start next" in THIS
  // sitting, oldest first (SessionStrip reverses for display). /new only:
  // an edit screen has no notion of "the next one in this session", it has
  // exactly the one voucher it was opened to fix.
  const [sessionEntries, setSessionEntries] = useState<SessionStripEntry[]>([]);

  // F6 (allocation drawer) — only ever populated on a brand-new credit or
  // debit note; see saveInvoice()'s own comment for why an edit never reads
  // or writes this. Reset to null whenever the party or the voucher type
  // changes (an allocation drafted against a different party or a
  // sales/purchase invoice is meaningless once the thing it was drafted for
  // is gone).
  const [allocations, setAllocations] = useState<DrawerAllocation[] | null>(null);
  const [allocationOnAccount, setAllocationOnAccount] = useState(0);
  const [allocationDrawerOpen, setAllocationDrawerOpen] = useState(false);

  // F5 (adjacent voucher) — guards get_adjacent_voucher against being fired
  // twice for one Alt+ArrowUp/Down press (e.g. key-repeat) while the first
  // request is still in flight.
  const [adjacentBusy, setAdjacentBusy] = useState(false);

  const allLedgers = useMemo(() => mergeById(ledgers, addedLedgers), [ledgers, addedLedgers]);
  const allItems = useMemo(() => mergeById(items, addedItems), [items, addedItems]);

  const config = TYPES.find((t) => t.value === voucherType)!;
  const isSale = voucherType === "sales" || voucherType === "credit_note";
  // A credit or debit note settles money against an EXISTING bill; a sales
  // or purchase invoice always creates a NEW one — per F7's recon of TYPES,
  // this is the only pair of voucherType values the allocation drawer
  // should ever gate on.
  const isCreditOrDebitNote = voucherType === "credit_note" || voucherType === "debit_note";
  // config.roles[0] is always the party's own role (see the `partyRole`
  // comment below) — narrowed to a literal union here because AllocationDrawer's
  // `role` prop is typed strictly as "debtor" | "creditor", not the wider
  // string TYPES itself is declared with.
  const allocationRole: "debtor" | "creditor" = voucherType === "debit_note" ? "creditor" : "debtor";

  // F5 (adjacent voucher). Alt+ArrowUp/Down navigates via router.push to
  // this SAME route pattern with a different [voucherId] — the edit page
  // (a file outside this pass's scope) renders a NEW `existing` prop for
  // that id, but does not give InvoiceForm a `key`, so React reuses this
  // exact component instance rather than remounting it. Every `useState`
  // above that seeded itself from `existing?.…` therefore would NOT pick up
  // the new voucher's data on its own — only this check, reacting to
  // `existing.id` actually changing, makes the arrow keys land on a form
  // that shows the voucher just navigated to instead of the one left
  // behind. Deliberately keyed on just the id: re-running this every time
  // any OTHER field of `existing` changed would fight the user's own edits
  // on the voucher currently open.
  //
  // Done during render (not in a useEffect) and guarded by comparing the id
  // against what was last synced — same "seed on key change" pattern as
  // EmployeeManager.tsx's revision form and useScreenConfig.ts's loadingFor
  // check, and for the same reason: an unconditional setState at the top of
  // an effect body is exactly what this project's react-hooks/set-state-in-effect
  // rule refuses.
  const [syncedExistingId, setSyncedExistingId] = useState<string | null>(existing?.id ?? null);
  if ((existing?.id ?? null) !== syncedExistingId) {
    setSyncedExistingId(existing?.id ?? null);
    if (existing) {
      setVoucherType(existing.voucherType);
      setBranchId(existing.branchId);
      setGodownId(existing.godownId);
      setDate(existing.date);
      setPartyId(existing.partyId);
      setTradingId(existing.tradingId);
      setPlaceOfSupply(existing.placeOfSupply);
      setPlaceOfSupplyTouched(true);
      setReference(existing.reference);
      setChallanNumber(existing.challanNumber);
      setChallanDate(existing.challanDate);
      setNarration(existing.narration);
      setLines(existing.lines.length ? existing.lines : [emptyLine()]);
      setShipToOn(Boolean(existing.shipTo));
      setShipTo(existing.shipTo ?? emptyShipTo());
      setAllocations(null);
      setAllocationOnAccount(0);
      setAllocationDrawerOpen(false);
      setError(null);
      setBusy(false);
    }
  }

  // A draft allocation is only ever meaningful for the party and the
  // voucher type it was drawn up against — switching either invalidates it.
  // Same render-time key-comparison pattern as above, for the same reason.
  const allocationSyncKey = `${partyId}|${voucherType}`;
  const [syncedAllocationKey, setSyncedAllocationKey] = useState(allocationSyncKey);
  if (allocationSyncKey !== syncedAllocationKey) {
    setSyncedAllocationKey(allocationSyncKey);
    setAllocations(null);
    setAllocationOnAccount(0);
    setAllocationDrawerOpen(false);
  }

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

  // True once any line on the invoice is billed as a charge rather than as
  // stock (migration 1480) — the one moment the godown below stops covering
  // the whole document, and the only thing on this screen that has to know.
  const hasChargeLine = useMemo(
    () =>
      lines.some((l) => {
        const it = allItems.find((x) => x.id === l.itemId);
        return it ? !movesStock(it) : false;
      }),
    [lines, allItems]
  );

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
  //
  // Also mirrors 1230's rule that a purchase or debit note carries no
  // input tax at all when the supplier is unregistered or composition —
  // neither may lawfully charge GST (Sec 32(1)/Sec 10(4)), so there is
  // nothing to preview. Before this, the preview showed a full tax split
  // for exactly this case, disagreeing with what actually got posted (found
  // live, wave 7, 1 Sep 2026 — every purchase from Rao Innovations OPC's two
  // real, both-unregistered suppliers hit this).
  const tax = useMemo(() => {
    if (!supplyType) return { cgst: 0, sgst: 0, igst: 0 };
    const party = allLedgers.find((l) => l.id === partyId);
    if (
      !isSale &&
      (party?.gst_registration_type === "unregistered" || party?.gst_registration_type === "composition")
    ) {
      return { cgst: 0, sgst: 0, igst: 0 };
    }
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
  }, [lines, allItems, supplyType, allLedgers, partyId, isSale]);

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

  // F3 grid navigation for the desktop line-items table: arrow keys move
  // between cells, Enter on the last cell of the last row adds a line,
  // Ctrl+D duplicates the focused row, Ctrl+Delete removes it. Column order
  // matches the desktop <table>'s own cell order below — itemId=0,
  // quantity=1, rate=2, discountPercent=3 — which is also the only place
  // this invoice's line items are laid out as an actual grid; the stacked
  // mobile cards below sm: are a single column already and are left on their
  // plain onChange handlers, same as before this pass. This REPLACES the
  // desktop Rate input's old one-off "Enter on the last row adds a line"
  // handler (now generalised to the true last cell, discountPercent) rather
  // than adding a second, competing Enter handler beside it.
  const { getCellProps } = useGridNav({
    rowCount: lines.length,
    colCount: 4,
    onAddRow: () => setLines((p) => [...p, emptyLine()]),
    onDuplicateRow: (i) => setLines((p) => [...p.slice(0, i + 1), { ...p[i] }, ...p.slice(i + 1)]),
    onRemoveRow: (i) => setLines((p) => p.filter((_, idx) => idx !== i)),
  });

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

  /** Lines actually filled in — the one predicate both validateForm() and
   * saveInvoice() need to agree on, so pulling it out is what keeps "is
   * there anything to save" and "what gets sent" from ever quietly
   * diverging. */
  function filledLines(): Line[] {
    return lines.filter((l) => l.itemId && Number(l.quantity) > 0);
  }

  /** Every check onSubmit used to run inline, unchanged, just returning the
   * message instead of calling setError itself — so both save paths below
   * (save & close, save & start next) run the identical validation. */
  function validateForm(): string | null {
    if (!filledLines().length) return "Add at least one item line.";
    if (!partyId) return `Select a ${config.party.toLowerCase()}.`;
    if (!tradingId) return `Select a ${config.trading.toLowerCase()}.`;
    if (taxable <= 0) return "The invoice must come to more than zero.";
    if (gstOn && !placeOfSupply) return "Select a place of supply.";
    // The same rule app_private.assert_rule46b_number applies, checked here so
    // the preparer reads a sentence rather than waiting for a round trip that
    // fails — and, on a tax invoice, so a number the IRP would reject never
    // gets issued in the first place.
    if (policy?.mode === "manual") {
      const problem = validateManualNumber(manualNumber);
      if (problem) return problem;
    }
    // Checked here rather than left to the database, because the ship-to is
    // written AFTER the invoice has already been posted and numbered — a
    // round-trip failure at that point cannot be undone by re-submitting.
    // These are the table's own NOT NULLs and its gstin/state CHECK (0805),
    // stated as sentences.
    if (shipToOn) {
      if (!shipTo.name.trim()) return "Give the delivery address a name, or untick “Deliver to a different address”.";
      if (!shipTo.address.trim()) return "Enter the delivery address, or untick “Deliver to a different address”.";
      if (!shipTo.stateCode) return "Select the delivery address's state — a GST invoice must name it (Rule 46).";
      const g = shipTo.gstin.trim().toUpperCase();
      if (g && g.length !== 15) return "A delivery GSTIN is 15 characters, or leave it blank.";
      if (g && g.slice(0, 2) !== shipTo.stateCode) {
        return "The delivery GSTIN starts with a different state code than the state selected beside it.";
      }
      if (shipTo.pincode.trim() && !/^[1-9][0-9]{5}$/.test(shipTo.pincode.trim())) {
        return "A delivery PIN code is six digits and cannot start with 0, or leave it blank.";
      }
    }
    return null;
  }

  /**
   * Validates and posts one invoice — every check, RPC call and ship-to
   * write onSubmit used to run inline, byte-for-byte unchanged in WHAT gets
   * sent, just extracted so both save paths below (Ctrl+Shift+S/the Save
   * button, which close the form, and Ctrl+S on a new invoice, which reopens
   * a blank one) share one implementation instead of two that could drift.
   *
   * Step 4 of this pass: a credit or debit note's chosen bill split (F6),
   * held in `allocations` state, is applied via set_voucher_allocations only
   * AFTER create_invoice has already returned a real id — a SECOND, separate
   * call — and only on a brand-new invoice, never an edit. AllocationDrawer's
   * own header comment explains why it cannot safely drive an edit-save: its
   * caps come straight from get_bill_wise_outstanding's `allocatable`
   * figure, which is NOT netted against this settlement voucher's own
   * already-posted allocations the way AllocationManager's revise flow is —
   * replaying a fresh draft against an existing voucher would show the wrong
   * room and could silently overwrite a correct allocation with a wrong one.
   * A credit/debit note's allocation, once posted, is revised at
   * /allocations instead, same as every other settlement voucher.
   */
  async function saveInvoice(): Promise<{ voucherId: string } | null> {
    setError(null);
    const problem = validateForm();
    if (problem) {
      setError(problem);
      return null;
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

    const items_payload = filledLines().map((l) => ({
      item_id: l.itemId,
      quantity: Number(l.quantity),
      rate: Number(l.rate) || 0,
      discount_percent: Number(l.discountPercent) || 0,
      description: l.description.trim() || null,
    }));

    const { data, error: rpcError } = existing
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

    if (rpcError) {
      setError(friendlyNumberingError(rpcError.message));
      setBusy(false);
      return null;
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

    // Only on a brand-new invoice (never `existing` — see this function's
    // own header comment) and only when step 3 actually drafted something.
    if (!existing && allocations && allocations.length > 0) {
      const { error: allocError } = await createClient().rpc(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- set_voucher_allocations (1490) predates the generated types, same escape hatch as the challanArgs cast above.
        "set_voucher_allocations" as any,
        {
          p_company_id: companyId,
          p_settlement_voucher_id: voucherId,
          p_party_ledger_id: partyId,
          p_allocations: allocations.map((a) => ({ bill_voucher_id: a.billVoucherId, amount: a.amount })),
        }
      );
      if (allocError) {
        // The invoice itself is already correctly created and posted — a
        // failure here must never read as though the whole save failed, or a
        // preparer would re-submit and double-post the same invoice. Worse
        // than the FIFO-inferred outstanding this leaves behind would be
        // pretending the save didn't happen, so this is a toast pointing at
        // the fix, not a form error blocking anything.
        toast.error(
          `The ${config.label.toLowerCase()} saved, but its allocation to bills did not: ${allocError.message}. Open /allocations to finish applying it.`
        );
      }
    }

    setBusy(false);
    return { voucherId };
  }

  /** Ctrl+Shift+S, and the Save button — today's existing default: save,
   * then navigate to the voucher and leave this form. */
  async function saveAndClose() {
    if (busy) return;
    const result = await saveInvoice();
    if (!result) return;
    router.push(`/${companyId}/vouchers/${result.voucherId}`);
    router.refresh();
  }

  /**
   * Ctrl+S on a new invoice (and the "Save & start next" button beside the
   * main Save button, which exists so this action is reachable without the
   * keyboard — see useShortcuts.ts's own header comment on why an
   * accelerator must never be the only way to do something): save, then
   * reopen a blank invoice of the SAME voucher type, date and branch,
   * without navigating anywhere, and drop a pill for what was just saved
   * onto the session strip below the form.
   *
   * Only ever called when !isEdit (see the useShortcuts wiring below) — on
   * the edit screen Ctrl+S behaves exactly like Ctrl+Shift+S instead, since
   * "reopen a blank invoice" has no safe meaning while editing one that
   * already exists: `existing.id` never changes just because the fields on
   * screen were reset to blank, so a second save from that blank state would
   * silently overwrite the original voucher with unrelated data.
   */
  async function saveAndNew() {
    if (busy) return;
    const partyName = allLedgers.find((l) => l.id === partyId)?.name ?? "—";
    const savedAmount = grandTotal;
    const result = await saveInvoice();
    if (!result) return;
    // create_invoice only ever returns the new id — the number itself is
    // assigned inside it (next_voucher_number / resolve_manual_voucher_number),
    // so it has to be read back to show it on the strip.
    const { data: numberRow } = await createClient()
      .from("vouchers")
      .select("voucher_number")
      .eq("id", result.voucherId)
      .maybeSingle();
    setSessionEntries((prev) => [
      ...prev,
      {
        id: result.voucherId,
        number: numberRow?.voucher_number ?? "—",
        party: partyName,
        amount: savedAmount,
        href: `/${companyId}/invoices/${result.voucherId}/edit`,
      },
    ]);
    resetForNewInvoice();
    router.refresh();
  }

  /** What saveAndNew() resets to — every field a fresh visit to
   * /invoices/new would start from, EXCEPT voucherType, branchId and date,
   * which stay put so a batch of same-day, same-branch entries doesn't have
   * to re-pick them each time. */
  function resetForNewInvoice() {
    setGodownId(godowns[0]?.id ?? "");
    setPartyId("");
    setTradingId("");
    setPlaceOfSupply("");
    setPlaceOfSupplyTouched(false);
    setReference("");
    setChallanNumber("");
    setChallanDate("");
    setNarration("");
    setLines([emptyLine()]);
    setShipToOn(false);
    setShipTo(emptyShipTo());
    setManualNumber("");
    setSeriesId(null);
    setAllocations(null);
    setAllocationOnAccount(0);
    setAllocationDrawerOpen(false);
    setError(null);
  }

  /**
   * F5. Alt+ArrowUp/Down, and the ‹ › buttons beside the invoice number —
   * only ever rendered/bound when `isEdit`, since a brand-new invoice has no
   * neighbor to step to yet. 'prev' on ArrowUp, 'next' on ArrowDown mirrors
   * an ordinary list's up-goes-back/down-goes-forward reading; the RPC's own
   * default (p_same_type = true) keeps this within the SAME voucher type,
   * matching Tally's PgUp/PgDn.
   */
  async function goAdjacent(direction: "prev" | "next") {
    if (!existing || adjacentBusy || busy) return;
    setAdjacentBusy(true);
    const { data, error: rpcError } = await createClient().rpc(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_adjacent_voucher (1520) predates the generated types, same escape hatch as the challanArgs cast above.
      "get_adjacent_voucher" as any,
      {
        p_company_id: companyId,
        p_voucher_id: existing.id,
        p_direction: direction,
      }
    );
    setAdjacentBusy(false);
    if (rpcError) {
      toast.error(rpcError.message);
      return;
    }
    const row = (data as unknown as Array<{ id: string }> | null)?.[0];
    if (!row) {
      // A subtle indicator, not an error — being at the first or last
      // voucher of a type is an entirely ordinary place to be.
      toast(
        direction === "prev"
          ? `${existing.voucherNumber} is the earliest ${config.label.toLowerCase()} here.`
          : `${existing.voucherNumber} is the latest ${config.label.toLowerCase()} here.`
      );
      return;
    }
    router.push(`/${companyId}/invoices/${row.id}/edit`);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void saveAndClose();
  }

  // F1. Every combo bound here already has a visible control beside it —
  // see each handler's own comment — this hook only gives a faster path to
  // an action that already works without it.
  useShortcuts("invoice-form", [
    {
      combo: "ctrl+s",
      label: isEdit ? "Save changes" : "Save & start next",
      handler: () => {
        if (isEdit) void saveAndClose();
        else void saveAndNew();
      },
    },
    {
      combo: "ctrl+shift+s",
      label: "Save & close",
      handler: () => void saveAndClose(),
    },
    ...(isEdit
      ? [
          { combo: "alt+arrowup", label: "Previous voucher", handler: () => void goAdjacent("prev") },
          { combo: "alt+arrowdown", label: "Next voucher", handler: () => void goAdjacent("next") },
        ]
      : []),
  ]);

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";
  const cell =
    "w-full rounded border border-transparent bg-transparent px-2 py-1.5 outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <>
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
            argument at all, so there is nothing here for an input to send.
            The ‹ › pair is the visible control F5's Alt+ArrowUp/Down rides on
            (see useShortcuts.ts's own rule that an accelerator must always
            have one) — same get_adjacent_voucher call, same "first/last"
            toast when there is nowhere to go. */}
        {isEdit && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Invoice number</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void goAdjacent("prev")}
                disabled={adjacentBusy}
                aria-label={`Previous ${config.label.toLowerCase()}`}
                title="Alt+↑"
                className="shrink-0 rounded-lg border border-border-strong p-2 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
              >
                <ChevronUp size={14} aria-hidden="true" />
              </button>
              <span className="flex-1 truncate rounded-lg border border-border bg-bg px-3 py-2 text-sm font-mono text-ink-soft">
                {existing!.voucherNumber}
              </span>
              <button
                type="button"
                onClick={() => void goAdjacent("next")}
                disabled={adjacentBusy}
                aria-label={`Next ${config.label.toLowerCase()}`}
                title="Alt+↓"
                className="shrink-0 rounded-lg border border-border-strong p-2 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </div>
            <span className="text-xs text-ink-faint">
              Fixed once issued. Alt+↑/↓ (or the arrows here) steps to the adjacent {config.label.toLowerCase()}.
            </span>
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
          <Combobox
            aria-label={config.party}
            value={partyId}
            onChange={selectParty}
            options={partyLedgers.map((l) => ({ id: l.id, label: l.name }))}
            placeholder="Select…"
            // Same modal, same onPartyCreated flow the "+ New" button above
            // already opens — this is only a second trigger for it, not a
            // second quick-add mechanism.
            onCreateNew={() => setPartyModalOpen(true)}
          />
          {/* F6. Only a credit or debit note settles an EXISTING bill — a
              sales or purchase invoice always creates a new one — and only on
              a fresh invoice; see saveInvoice()'s header comment for why an
              edit never mounts this. */}
          {!isEdit && isCreditOrDebitNote && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <button
                type="button"
                disabled={!partyId}
                onClick={() => setAllocationDrawerOpen(true)}
                className="text-xs text-accent underline underline-offset-4 disabled:cursor-not-allowed disabled:text-ink-faint disabled:no-underline"
              >
                {allocations && allocations.length > 0 ? "Change bill allocation" : "Apply to a bill"}
              </button>
              {allocations && allocations.length > 0 && (
                <span className="text-xs text-ink-faint">
                  Applied to {allocations.length} bill{allocations.length > 1 ? "s" : ""}
                  {allocationOnAccount > 0 ? `, ${formatINR(allocationOnAccount)} left on account` : ""}.
                </span>
              )}
            </div>
          )}
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
          <Combobox
            aria-label={config.trading}
            value={tradingId}
            onChange={setTradingId}
            options={tradingLedgers.map((l) => ({ id: l.id, label: l.name }))}
            placeholder="Select…"
            onCreateNew={() => setTradingModalOpen(true)}
          />
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Godown</span>
          {/* No onCreateNew: there is no quick-add flow for godowns today
              (only ledgers and items have one), so this stays a plain
              searchable picker with nothing for "Create <text>" to open. */}
          <Combobox
            value={godownId}
            onChange={setGodownId}
            options={godowns.map((g) => ({ id: g.id, label: `${g.code} — ${g.name}` }))}
            placeholder="Select…"
          />
          {/* Said only when it applies, and said where the confusion would
              arise: a charge line is taxed and reported like any other line
              but has no quantity to store anywhere, so the godown simply
              does not reach it. */}
          {hasChargeLine && (
            <span className="text-xs text-ink-faint">
              Charge lines carry their SAC and GST but no stock, so this godown covers only the
              goods lines.
            </span>
          )}
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
                  <label className="flex min-w-0 flex-1 flex-col gap-1">
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
                          {itemOptionLabel(it)}
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
                {item && !movesStock(item) && <ChargeLineNote item={item} />}
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
                        {...getCellProps(i, 0)}
                        aria-label={`Item on line ${i + 1}`}
                        value={line.itemId}
                        onChange={(e) => update(i, { itemId: e.target.value })}
                        className={cell}
                      >
                        <option value="">Select an item…</option>
                        {allItems.map((it) => (
                          <option key={it.id} value={it.id}>
                            {itemOptionLabel(it)}
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
                    {item && !movesStock(item) && <ChargeLineNote item={item} />}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      {...getCellProps(i, 1)}
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => update(i, { quantity: e.target.value })}
                      className={cell + " text-right tabular-nums"}
                    />
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-faint">{item?.uom ?? "—"}</td>
                  <td className="px-3 py-2">
                    <input
                      {...getCellProps(i, 2)}
                      inputMode="decimal"
                      value={line.rate}
                      onChange={(e) => update(i, { rate: e.target.value })}
                      className={cell + " text-right tabular-nums"}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      {...getCellProps(i, 3)}
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

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || taxable <= 0}
          title="Ctrl+Shift+S"
          className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50 sm:w-auto"
        >
          {busy ? "Saving…" : isEdit ? "Save changes" : `Save ${config.label.toLowerCase()}`}
        </button>
        {/* F1/F4. Ctrl+S's visible control — same saveAndNew() the shortcut
            calls, only offered on a fresh invoice (see saveAndNew()'s own
            comment for why the edit screen has nothing analogous to reopen). */}
        {!isEdit && (
          <button
            type="button"
            disabled={busy || taxable <= 0}
            onClick={() => void saveAndNew()}
            title="Ctrl+S"
            className="w-full rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50 sm:w-auto"
          >
            {busy ? "Saving…" : "Save & start next"}
          </button>
        )}
      </div>

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
        // requireStockItem is deliberately NOT passed any more (migration
        // 1480). It was set because an invoice line had to be a stock line
        // and voucher_items refused anything else, so offering the service
        // option here would only have produced an item the very invoice it
        // was created for could not carry. An invoice can now carry a charge
        // line, so the popup offers the whole choice again.
        onCreated={(created) => {
          if (itemModalLine !== null) onItemCreated(itemModalLine, created);
        }}
      />

      {/* F6. Same !isEdit && isCreditOrDebitNote gate as the trigger button
          beside the party field above — nothing to draft an allocation
          against on a sales/purchase invoice or on an edit, so nothing is
          mounted at all rather than mounted-but-hidden. */}
      {!isEdit && isCreditOrDebitNote && (
        <AllocationDrawer
          companyId={companyId}
          partyLedgerId={partyId}
          role={allocationRole}
          amount={grandTotal}
          asAt={date}
          open={allocationDrawerOpen}
          onClose={() => setAllocationDrawerOpen(false)}
          onConfirm={(allocs, onAccount) => {
            setAllocations(allocs);
            setAllocationOnAccount(onAccount);
            setAllocationDrawerOpen(false);
          }}
        />
      )}
    </form>

    {/* F4. /new only — an edit screen is here to fix the one voucher it was
        opened for, not to run a batch-entry sitting. */}
    {!isEdit && (
      <div className="mt-4">
        <SessionStrip entries={sessionEntries} onClear={() => setSessionEntries([])} />
      </div>
    )}
    </>
  );
}
