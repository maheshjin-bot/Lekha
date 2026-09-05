"use client";

/**
 * VoucherScreen — the shared shell that replaces InvoiceForm.tsx and
 * VoucherForm.tsx with one screen carrying three interchangeable modes
 * (Ctrl+H cycles between them): "item-invoice" and "accounting-invoice"
 * (both create_invoice/update_invoice, the same as InvoiceForm.tsx always
 * posted — an accounting-invoice is exactly an item-invoice with the item
 * picker restricted to non-stock items, per migration 1480) and
 * "raw-voucher" (create_voucher/update_voucher, the same generic Dr/Cr
 * ledger-line posting VoucherForm.tsx always did).
 *
 * THIS FILE IS THE SHELL ONLY. Per this wave's own task split, three sibling
 * agents are building the real line-item grids — ItemLinesGrid (serving both
 * item-invoice and accounting-invoice, parameterized by `restrictToNonStock`
 * per Recon's own recommendation) and RawVoucherGrid — against the exact
 * prop contracts Recon wrote out (header comments below name each one). This
 * file renders a literal `<div>Grid: {mode}</div>` placeholder where each
 * grid mounts; a later integration pass swaps that placeholder for the real
 * components. Every piece of state, every derived total, every submit call
 * and every quick-add/allocation/numbering/shortcut wire-up is otherwise
 * complete and correct on its own — the grid is the one deliberately missing
 * piece.
 *
 * WHY SOME HANDLERS AND PROPS LOOK UNUSED RIGHT NOW: `update`/`addLine`/
 * `removeLine`/`duplicateLine` for both line shapes, `openLedgerCreate`,
 * `onNewItemLine`, `priceListRate`, `ledgerOptions`, `partyRowIndex`, and the
 * `tdsSections`/`tdsPayableLedgerId`/`gstLedgerIds`/`priceListItems` props
 * are the exact shape the two real grids need once wired in (see each grid's
 * own prop-contract comment below) — they exist now so the integration pass
 * only has to pass them down, not re-derive them. Until that wiring lands,
 * several of them are legitimately not yet called from this file's own JSX;
 * that is expected, not a bug.
 *
 * WHAT MUST NEVER CHANGE, EVEN AS THE UI AROUND IT WAS RESTRUCTURED: every
 * argument name, shape and optionality on create_invoice / update_invoice /
 * create_voucher / update_voucher / set_voucher_allocations below is quoted
 * byte-for-byte from InvoiceForm.tsx / VoucherForm.tsx as they exist today.
 * This file restructures the UI that calls them, never the accounting
 * payload itself.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Settings } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { formatINR, sumPaise, toPaise } from "@/lib/utils/currency";
import {
  QuickAddLedgerModal,
  type QuickAddedLedger,
} from "@/components/ledgers/QuickAddLedgerModal";
import {
  QuickAddItemModal,
  type QuickAddedItem,
} from "@/components/items/QuickAddItemModal";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { useGridNav } from "@/components/ui/EntryGrid";
import { VoucherNumberField } from "@/components/numbering/VoucherNumberField";
import { useShortcuts } from "@/lib/keys/useShortcuts";
import { useScreenConfig } from "@/lib/config/useScreenConfig";
import { SessionStrip, type SessionStripEntry } from "@/components/vouchers/SessionStrip";
import { AllocationDrawer, type DrawerAllocation } from "@/components/allocations/AllocationDrawer";
import { ItemInvoiceGrid } from "@/components/vouchers/grids/ItemInvoiceGrid";
import { AccountingInvoiceGrid } from "@/components/vouchers/grids/AccountingInvoiceGrid";
import { RawVoucherGrid } from "@/components/vouchers/grids/RawVoucherGrid";
import {
  PURCHASE_TRADING_ROLES,
  SALE_TRADING_ROLES,
} from "@/lib/invoices/trading-roles";
import {
  friendlyNumberingError,
  validateManualNumber,
  type VoucherNumberingByBranch,
} from "@/lib/numbering/voucher-numbering";

// ============================================================================
// TYPES — the union of InvoiceForm's and VoucherForm's own prop/state types,
// per Recon Part B1/B1a/B1b/B1c. Exported so the sibling grid components (and
// the later integration pass) import these rather than re-declaring them.
// ============================================================================

/** B1a — byte-identical to InvoiceForm.tsx's own Item type. */
export type Item = {
  id: string;
  name: string;
  uom: string;
  sale_rate: number | null;
  purchase_rate: number | null;
  gst_rate_percent: number;
  default_tcs_section: string | null;
  item_type: string;
  maintain_stock: boolean;
  hsn_sac: string | null;
};

/**
 * Whether a line on this item moves stock — the same predicate
 * app_private.enforce_stock_item applies server-side. Needed here (not just
 * inside the future ItemLinesGrid) because `hasChargeLine`/the godown
 * caption and the tax/TCS memos below all have to know it too.
 */
function movesStock(item: Item) {
  return item.item_type === "goods" && item.maintain_stock;
}

/** B1b — the UNIFIED superset of InvoiceForm's and VoucherForm's own Ledger
 * types. See Recon's own field-by-field comparison for why every field below
 * is optional/nullable except the ones both forms already required. */
export type Ledger = {
  id: string;
  name: string;
  ledger_role?: string | null;
  group_name?: string | null;
  state_code: string | null;
  pan: string | null;
  address?: string | null;
  city?: string | null;
  pincode?: string | null;
  gstin?: string | null;
  gst_registration_type?: string | null;
  is_tds_deductee?: boolean;
  default_tds_section?: string | null;
  ldc_rate?: number | null;
  ldc_valid_from?: string | null;
  ldc_valid_to?: string | null;
  ldc_amount_cap?: number | null;
  party_type?: string | null;
};

/** B1c — registeredState kept required; a raw-voucher-only route passes null
 * per branch when it never selected gst_registrations at all. */
export type Branch = { id: string; code: string; name: string; registeredState: string | null };
export type Godown = { id: string; code: string; name: string };
export type StateOption = { code: string; name: string };
export type TcsSection = {
  section_code: string;
  rate_percent: number;
  no_pan_rate_percent: number;
  threshold_rupees: number | null;
};
export type PriceListEntry = { item_id: string; price: number; effective_from: string };
export type TdsSection = { section_code: string; description: string; rate_percent: number };

export type ItemLine = {
  itemId: string;
  quantity: string;
  rate: string;
  discountPercent: string;
  description: string;
};
const emptyItemLine = (): ItemLine => ({
  itemId: "",
  quantity: "1",
  rate: "",
  discountPercent: "",
  description: "",
});

export type DrCrLine = {
  ledgerId: string;
  side: "dr" | "cr";
  amount: string;
  narration: string;
  tdsSplit?: boolean;
};
const emptyDrCrLine = (): DrCrLine => ({ ledgerId: "", side: "dr", amount: "", narration: "" });

/** Mirrors create_invoice/update_invoice's own per-line formula exactly
 * (migration 0147) — see InvoiceForm.tsx's identical comment. */
function lineAmounts(quantity: string, rate: string, discountPercent: string) {
  const qty = Number(quantity) || 0;
  const r = Number(rate) || 0;
  const discPct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const gross = Math.round(qty * r * 100) / 100;
  const discount = Math.round(((gross * discPct) / 100) * 100) / 100;
  const net = Math.round((gross - discount) * 100) / 100;
  return { gross, discount, net };
}

/** Same rounding convention as AllocationDrawer/VoucherForm's own round2. */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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

/** The 4-value domain item-invoice/accounting-invoice voucherType lives in —
 * byte-identical to InvoiceForm.tsx's own TYPES. */
const TYPES = [
  { value: "sales", label: "Sales invoice", party: "Customer", trading: "Sales ledger", roles: ["debtor", "cash_bank"] },
  { value: "purchase", label: "Purchase bill", party: "Supplier", trading: "Purchase ledger", roles: ["creditor", "cash_bank"] },
  { value: "credit_note", label: "Credit note", party: "Customer", trading: "Sales ledger", roles: ["debtor", "cash_bank"] },
  { value: "debit_note", label: "Debit note", party: "Supplier", trading: "Purchase ledger", roles: ["creditor", "cash_bank"] },
] as const;

/** The 8-value domain raw-voucher's voucherType lives in — byte-identical to
 * VoucherForm.tsx's own VOUCHER_TYPES. TYPES's 4 values are a strict subset
 * of this list (see B5 Case B in Recon), which is what lets a switch INTO
 * raw-voucher keep whatever type was already selected without any mapping. */
const VOUCHER_TYPES = [
  { value: "receipt", label: "Receipt" },
  { value: "payment", label: "Payment" },
  { value: "contra", label: "Contra" },
  { value: "journal", label: "Journal" },
  { value: "sales", label: "Sales" },
  { value: "purchase", label: "Purchase" },
  { value: "credit_note", label: "Credit note" },
  { value: "debit_note", label: "Debit note" },
] as const;

export type Mode = "item-invoice" | "accounting-invoice" | "raw-voucher";

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: "item-invoice", label: "Item invoice" },
  { value: "accounting-invoice", label: "Charge invoice" },
  { value: "raw-voucher", label: "Voucher (Dr/Cr)" },
];

/** An existing item-invoice or accounting-invoice — byte-identical to
 * InvoiceForm.tsx's own ExistingInvoice. */
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
  challanNumber: string;
  challanDate: string;
  narration: string;
  lines: ItemLine[];
  shipTo: ShipTo | null;
};

/** An existing raw-voucher — byte-identical to VoucherForm.tsx's own
 * ExistingVoucher. */
export type ExistingVoucher = {
  id: string;
  voucherNumber: string;
  voucherType: string;
  financialYearLabel: string;
  date: string;
  narration: string;
  reference: string;
  branchId: string;
  lines: DrCrLine[];
};

/**
 * B6 — one prop, one boolean (`isEdit = Boolean(existing)`), and `mode` is
 * carried on the SAME object rather than inferred, because an edit is
 * single-mode for its whole lifetime (a saved voucher's row shape —
 * voucher_items vs voucher_entries — is fixed forever) and Ctrl+H is
 * disabled entirely once `isEdit` is true, for the identical reason both
 * original forms already lock Type and Branch on isEdit.
 */
export type VoucherScreenExisting =
  | { mode: "item-invoice" | "accounting-invoice"; data: ExistingInvoice }
  | { mode: "raw-voucher"; data: ExistingVoucher };

/** Server-fetched rows first, then anything quick-added this session — same
 * dedup InvoiceForm.tsx/VoucherForm.tsx both already use. */
function mergeById<T extends { id: string; name: string }>(server: T[], added: T[]): T[] {
  const known = new Set(server.map((r) => r.id));
  return [...server, ...added.filter((a) => !known.has(a.id))].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

function toLedgerFromQuickAdd(l: QuickAddedLedger): Ledger {
  return {
    id: l.id,
    name: l.name,
    ledger_role: l.ledger_role,
    group_name: l.group_name,
    state_code: l.state_code,
    pan: l.pan,
    gstin: l.gstin,
    gst_registration_type: l.gst_registration_type,
  };
}

function toItemFromQuickAdd(i: QuickAddedItem): Item {
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

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function resolveInitialVoucherType(mode: Mode, typeParam: string | null): string {
  if (mode === "raw-voucher") {
    return typeParam && VOUCHER_TYPES.some((t) => t.value === typeParam) ? typeParam : "payment";
  }
  return typeParam && TYPES.some((t) => t.value === typeParam) ? typeParam : "sales";
}

/**
 * P7.2 — nine form-level display preferences for this screen, persisted
 * under screen_key "voucher-entry" via useScreenConfig (1560), the same
 * get_screen_config/set_screen_config plumbing ReportShell.tsx's own
 * ReportDisplayConfig already uses for its three report-level keys. Every
 * key defaults to true, and true is defined as "whatever this screen already
 * renders today" for that field — so a company/user with no screen_config
 * row yet (every one of them, until someone opens the gear) sees unchanged
 * behaviour. This shell owns persisting the nine preferences and offering
 * the toggle panel; not every key has a rendering hook to gate ON THIS PASS
 * (see the four inline notes below at each toggle's own use site, or its
 * absence) — narration, ship-to and challan fields are shell-level sections
 * this file already renders and are gated directly; the discount column is
 * gated inside ItemInvoiceGrid/AccountingInvoiceGrid via their own new
 * `showDiscountColumn` prop. HSN is not today a separate grid column (it
 * only appears inside a charge line's own note), quantity/rate stay always
 * rendered because create_invoice's own guard requires a positive quantity
 * unconditionally (Recon B4 — hiding the column could never mean "still
 * post," only "silently fail"), and batch/expiry-inline / godown-per-line /
 * cost-centre-per-line have no per-line UI anywhere in this codebase to
 * gate yet (godown is a single header-level field, per InvoiceForm.tsx's own
 * layout — batch/serial and cost-centre allocation are both separate,
 * after-the-fact screens, not inline grid columns). Registering all nine
 * keys now, with the toggle panel and the ones that ARE renderable actually
 * wired, is the same scope ReportShell's own P7.2 pass drew for report
 * display config: "This file only owns persisting the preference and
 * offering the toggle UI" — the rest is later, per-surface work.
 */
type VoucherEntryConfig = {
  showNarration: boolean;
  showHsnColumn: boolean;
  showQuantityRateColumns: boolean;
  showDiscountColumn: boolean;
  showBatchExpiryInline: boolean;
  showGodownPerLine: boolean;
  showShipTo: boolean;
  showChallanFields: boolean;
  showCostCentrePerLine: boolean;
};

const DEFAULT_VOUCHER_ENTRY_CONFIG: VoucherEntryConfig = {
  showNarration: true,
  showHsnColumn: true,
  showQuantityRateColumns: true,
  showDiscountColumn: true,
  showBatchExpiryInline: true,
  showGodownPerLine: true,
  showShipTo: true,
  showChallanFields: true,
  showCostCentrePerLine: true,
};

function resolveVoucherEntryConfig(config: Record<string, unknown>): VoucherEntryConfig {
  return {
    showNarration: (config.showNarration as boolean | undefined) ?? DEFAULT_VOUCHER_ENTRY_CONFIG.showNarration,
    showHsnColumn: (config.showHsnColumn as boolean | undefined) ?? DEFAULT_VOUCHER_ENTRY_CONFIG.showHsnColumn,
    showQuantityRateColumns:
      (config.showQuantityRateColumns as boolean | undefined) ??
      DEFAULT_VOUCHER_ENTRY_CONFIG.showQuantityRateColumns,
    showDiscountColumn:
      (config.showDiscountColumn as boolean | undefined) ?? DEFAULT_VOUCHER_ENTRY_CONFIG.showDiscountColumn,
    showBatchExpiryInline:
      (config.showBatchExpiryInline as boolean | undefined) ?? DEFAULT_VOUCHER_ENTRY_CONFIG.showBatchExpiryInline,
    showGodownPerLine:
      (config.showGodownPerLine as boolean | undefined) ?? DEFAULT_VOUCHER_ENTRY_CONFIG.showGodownPerLine,
    showShipTo: (config.showShipTo as boolean | undefined) ?? DEFAULT_VOUCHER_ENTRY_CONFIG.showShipTo,
    showChallanFields:
      (config.showChallanFields as boolean | undefined) ?? DEFAULT_VOUCHER_ENTRY_CONFIG.showChallanFields,
    showCostCentrePerLine:
      (config.showCostCentrePerLine as boolean | undefined) ?? DEFAULT_VOUCHER_ENTRY_CONFIG.showCostCentrePerLine,
  };
}

const VOUCHER_ENTRY_CONFIG_ROWS: { key: keyof VoucherEntryConfig; label: string }[] = [
  { key: "showNarration", label: "Narration" },
  { key: "showHsnColumn", label: "HSN / SAC column" },
  { key: "showQuantityRateColumns", label: "Quantity / rate columns" },
  { key: "showDiscountColumn", label: "Discount % column" },
  { key: "showBatchExpiryInline", label: "Batch / expiry inline" },
  { key: "showGodownPerLine", label: "Godown per line" },
  { key: "showShipTo", label: "Ship-to (delivery address)" },
  { key: "showChallanFields", label: "Challan number / date" },
  { key: "showCostCentrePerLine", label: "Cost centre per line" },
];

/**
 * The gear affordance itself — same anchored-popover shape as ReportShell's
 * own ReportDisplayGear (outside-click and Escape both close it), kept as a
 * small local component here for the same reason that one is: this screen's
 * own toggle panel, not shared with reports.
 */
function VoucherEntryConfigGear({
  config,
  onToggle,
}: {
  config: VoucherEntryConfig;
  onToggle: (key: keyof VoucherEntryConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0 print:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Entry screen display settings"
        className="flex items-center justify-center rounded-lg border border-border-strong p-1.5 text-ink-soft transition-colors hover:bg-accent-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <Settings size={14} aria-hidden="true" />
        <span className="sr-only">Entry screen display settings</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-[14px] border border-border bg-surface p-3 shadow-card"
        >
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
            Fields on this screen
          </p>
          <div className="flex flex-col gap-2.5">
            {VOUCHER_ENTRY_CONFIG_ROWS.map((row) => (
              <label
                key={row.key}
                className="flex cursor-pointer items-center justify-between gap-3 text-sm text-ink"
              >
                <span>{row.label}</span>
                <input
                  type="checkbox"
                  checked={config[row.key]}
                  onChange={() => onToggle(row.key)}
                  className="h-4 w-4 shrink-0 rounded border-border-strong accent-accent"
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function VoucherScreen({
  companyId,
  items,
  ledgers,
  branches,
  godowns,
  states,
  gstOn,
  tcsOn,
  tcsSections,
  priceListItems = [],
  tdsSections = [],
  tdsPayableLedgerId = null,
  gstLedgerIds = [],
  numbering = {},
  existing,
  defaultMode = "item-invoice",
}: {
  companyId: string;
  items: Item[];
  ledgers: Ledger[];
  branches: Branch[];
  godowns: Godown[];
  states: StateOption[];
  gstOn: boolean;
  tcsOn: boolean;
  tcsSections: TcsSection[];
  /** item-invoice / accounting-invoice only. */
  priceListItems?: PriceListEntry[];
  /** raw-voucher only. */
  tdsSections?: TdsSection[];
  /** raw-voucher only. */
  tdsPayableLedgerId?: string | null;
  /** raw-voucher only — the eight input/output CGST/SGST/IGST/Cess ledgers
   * (1781), used by RawVoucherGrid's own gstComponentFor to net a sibling GST
   * leg out of a TDS base. See VoucherForm.tsx's identical prop comment for
   * why this must never be confused with ledger_role === "duty_tax". */
  gstLedgerIds?: string[];
  numbering?: VoucherNumberingByBranch;
  existing?: VoucherScreenExisting;
  /** Which mode a fresh (!isEdit) screen opens in, when neither `existing`
   * nor the `?mode=` query param say otherwise — e.g. /vouchers/new wants
   * "raw-voucher" even though most other entry points want the item-invoice
   * default. Ignored once `existing` is set (B6 — an edit's mode is fixed by
   * what was saved) and overridden by an explicit `?mode=` (B5's own
   * AppShell-shortcut convention takes priority over a route's default). */
  defaultMode?: Mode;
}) {
  const router = useRouter();
  const isEdit = Boolean(existing);
  const searchParams = useSearchParams();
  const typeParam = searchParams.get("type");
  // B5's own recommendation: extend the existing `?type=` convention (which
  // AppShell's Alt+P/Alt+D/Alt+R already write) with an initial `mode=` too,
  // so AppShell needs no awareness of this screen's internal mode split.
  const modeParam = searchParams.get("mode");
  const initialMode: Mode =
    !isEdit && modeParam && MODE_OPTIONS.some((m) => m.value === modeParam)
      ? (modeParam as Mode)
      : defaultMode;

  const [mode, setMode] = useState<Mode>(existing?.mode ?? initialMode);
  const [voucherType, setVoucherType] = useState<string>(
    existing ? existing.data.voucherType : resolveInitialVoucherType(initialMode, typeParam)
  );
  const [branchId, setBranchId] = useState(existing?.data.branchId ?? branches[0]?.id ?? "");
  const [date, setDate] = useState(existing?.data.date ?? todayLocal);
  const [narration, setNarration] = useState(existing?.data.narration ?? "");
  const [reference, setReference] = useState(existing?.data.reference ?? "");

  // ---- item-invoice / accounting-invoice ONLY state (B2) ----
  const existingInvoice = existing && existing.mode !== "raw-voucher" ? existing.data : undefined;
  const [godownId, setGodownId] = useState(existingInvoice?.godownId ?? godowns[0]?.id ?? "");
  const [partyId, setPartyId] = useState(existingInvoice?.partyId ?? "");
  const [tradingId, setTradingId] = useState(existingInvoice?.tradingId ?? "");
  const [placeOfSupply, setPlaceOfSupply] = useState(existingInvoice?.placeOfSupply ?? "");
  const [placeOfSupplyTouched, setPlaceOfSupplyTouched] = useState(isEdit);
  const [challanNumber, setChallanNumber] = useState(existingInvoice?.challanNumber ?? "");
  const [challanDate, setChallanDate] = useState(existingInvoice?.challanDate ?? "");
  const [shipToOn, setShipToOn] = useState(Boolean(existingInvoice?.shipTo));
  const [shipTo, setShipTo] = useState<ShipTo>(existingInvoice?.shipTo ?? emptyShipTo());
  const setShip = (patch: Partial<ShipTo>) => setShipTo((p) => ({ ...p, ...patch }));
  const [itemLines, setItemLines] = useState<ItemLine[]>(
    existingInvoice?.lines.length ? existingInvoice.lines : [emptyItemLine()]
  );

  // F6 allocation trio #1 — item/accounting mode's own shape (unchanged from
  // InvoiceForm.tsx). Kept entirely separate from trio #2 below — see
  // Recon's own "WHY THE TWO ALLOCATION TRIOS STAY SEPARATE".
  const [allocations, setAllocations] = useState<DrawerAllocation[] | null>(null);
  const [allocationOnAccount, setAllocationOnAccount] = useState(0);
  const [allocationDrawerOpen, setAllocationDrawerOpen] = useState(false);

  // ---- raw-voucher ONLY state (B2) ----
  const existingVoucher = existing && existing.mode === "raw-voucher" ? existing.data : undefined;
  const [voucherLines, setVoucherLines] = useState<DrCrLine[]>(
    existingVoucher?.lines.length ? existingVoucher.lines : [emptyDrCrLine(), emptyDrCrLine()]
  );

  // F6 allocation trio #2 — raw-voucher's own shape (unchanged from
  // VoucherForm.tsx): a draft array plus a derived summary plus the
  // partyLedgerId/partyAmount staleness guard, because raw-voucher's party is
  // GUESSED from line contents rather than typed into a dedicated field.
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [pendingAllocations, setPendingAllocations] = useState<DrawerAllocation[]>([]);
  const [allocationSummary, setAllocationSummary] = useState<{ count: number; onAccount: number } | null>(
    null
  );
  const [allocationLockKey, setAllocationLockKey] = useState<string | null>(null);

  // ---- shared, unchanged shape from both forms today (B2) ----
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualNumber, setManualNumber] = useState("");
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [addedLedgers, setAddedLedgers] = useState<Ledger[]>([]);
  const [addedItems, setAddedItems] = useState<Item[]>([]);
  const [partyModalOpen, setPartyModalOpen] = useState(false);
  const [tradingModalOpen, setTradingModalOpen] = useState(false);
  const [itemModalLine, setItemModalLine] = useState<number | null>(null);
  const [ledgerModalLine, setLedgerModalLine] = useState<number | null>(null);
  const [ledgerModalPrefillName, setLedgerModalPrefillName] = useState("");
  const [sessionEntries, setSessionEntries] = useState<SessionStripEntry[]>([]);
  const [adjacentBusy, setAdjacentBusy] = useState(false);

  // Migration 1530's `strict_allocation` module — is_strict_allocation_required
  // predates the generated types (same escape hatch every other post-1480 RPC
  // in this file uses), so this is one fetch, on mount / companyId change.
  const [strictAllocationRequired, setStrictAllocationRequired] = useState(false);
  useEffect(() => {
    let cancelled = false;
    createClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- is_strict_allocation_required (1530) predates the generated types.
      .rpc("is_strict_allocation_required" as any, { p_company_id: companyId })
      .then(({ data, error: rpcError }) => {
        if (cancelled || rpcError) return;
        setStrictAllocationRequired(Boolean(data));
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const allLedgers = useMemo(() => mergeById(ledgers, addedLedgers), [ledgers, addedLedgers]);
  const allItems = useMemo(() => mergeById(items, addedItems), [items, addedItems]);
  // accounting-invoice's own item picker restriction (Recon B3a's
  // `restrictToNonStock`) — a non-stock item is any item this line grid may
  // legally carry in that mode, i.e. everything create_invoice's own
  // enforce_stock_item trigger would NOT classify as moving stock.
  const nonStockItems = useMemo(() => allItems.filter((it) => !movesStock(it)), [allItems]);

  // P7.2 — this screen's own nine display-preference keys (screen_key
  // "voucher-entry"), same get_screen_config/set_screen_config plumbing
  // ReportShell.tsx already uses. See this file's own header comment on
  // VoucherEntryConfig for which keys have a rendering hook wired on this
  // pass and which are plumbing-only so far.
  const { config: rawEntryConfig, setConfig: setEntryConfig } = useScreenConfig(companyId, "voucher-entry");
  const entryConfig = resolveVoucherEntryConfig(rawEntryConfig);
  function toggleEntryConfig(key: keyof VoucherEntryConfig) {
    setEntryConfig((prev) => ({ ...prev, [key]: !resolveVoucherEntryConfig(prev)[key] }));
  }

  // ---- item-invoice / accounting-invoice derived values (byte-identical
  //      math to InvoiceForm.tsx) ----
  const config = TYPES.find((t) => t.value === voucherType) ?? TYPES[0];
  const isSale = voucherType === "sales" || voucherType === "credit_note";
  const isCreditOrDebitNote = voucherType === "credit_note" || voucherType === "debit_note";
  const allocationRole: "debtor" | "creditor" = voucherType === "debit_note" ? "creditor" : "debtor";
  const tradingRoles: readonly string[] = isSale ? SALE_TRADING_ROLES : PURCHASE_TRADING_ROLES;
  const partyLedgers = allLedgers.filter((l) =>
    (config.roles as readonly string[]).includes(l.ledger_role ?? "")
  );
  const tradingLedgers = allLedgers.filter((l) => tradingRoles.includes(l.ledger_role ?? ""));
  const partyRole = config.roles[0];
  const branch = branches.find((b) => b.id === branchId);

  function selectParty(newPartyId: string) {
    setPartyId(newPartyId);
    if (placeOfSupplyTouched) return;
    const party = allLedgers.find((l) => l.id === newPartyId);
    if (party?.state_code) setPlaceOfSupply(party.state_code);
  }

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

  const hasChargeLine = useMemo(
    () =>
      itemLines.some((l) => {
        const it = allItems.find((x) => x.id === l.itemId);
        return it ? !movesStock(it) : false;
      }),
    [itemLines, allItems]
  );

  const taxable = useMemo(
    () =>
      sumPaise(
        itemLines.map((l) => toPaise(lineAmounts(l.quantity, l.rate, l.discountPercent).net))
      ) / 100,
    [itemLines]
  );

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
    for (const l of itemLines) {
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
  }, [itemLines, allItems, supplyType, allLedgers, partyId, isSale]);

  const tcs = useMemo(() => {
    if (!tcsOn || !isSale) return 0;
    const party = allLedgers.find((l) => l.id === partyId);
    const hasPan = !!party?.pan;
    let total = 0;
    for (const l of itemLines) {
      const item = allItems.find((x) => x.id === l.itemId);
      if (!item || !item.default_tcs_section) continue;
      const section = tcsSections.find((s) => s.section_code === item.default_tcs_section);
      if (!section) continue;
      const amount = lineAmounts(l.quantity, l.rate, l.discountPercent).net;
      if (section.threshold_rupees != null && amount <= section.threshold_rupees) continue;
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
  }, [tcsOn, isSale, itemLines, allItems, tcsSections, allLedgers, partyId, supplyType]);

  const grandTotal = taxable + tax.cgst + tax.sgst + tax.igst + tcs;

  /** Shell-owned per Recon B3a — passed down to ItemLinesGrid once wired. */
  function priceListRate(itemId: string): number | undefined {
    if (!isSale) return undefined;
    const candidates = priceListItems.filter((p) => p.item_id === itemId && p.effective_from <= date);
    if (!candidates.length) return undefined;
    return candidates.reduce((latest, p) => (p.effective_from > latest.effective_from ? p : latest)).price;
  }

  function updateItemLine(i: number, patch: Partial<ItemLine>) {
    setItemLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== i) return l;
        const next = { ...l, ...patch };
        if (patch.itemId && !l.rate) {
          const it = allItems.find((x) => x.id === patch.itemId);
          const suggested = priceListRate(patch.itemId) ?? (isSale ? it?.sale_rate : it?.purchase_rate);
          if (suggested) next.rate = String(suggested);
        }
        return next;
      })
    );
  }
  function addItemLine() {
    setItemLines((p) => [...p, emptyItemLine()]);
  }
  function duplicateItemLine(i: number) {
    setItemLines((p) => [...p.slice(0, i + 1), { ...p[i] }, ...p.slice(i + 1)]);
  }
  function removeItemLine(i: number) {
    setItemLines((p) => p.filter((_, idx) => idx !== i));
  }
  function onNewItemLine(lineIndex: number) {
    setItemModalLine(lineIndex);
  }

  // F3's EntryGrid, for item-invoice/accounting-invoice's own desktop table
  // (both grids share one instance — colCount=4: itemId=0, quantity=1,
  // rate=2, discountPercent=3, per each grid's own getCellProps prop
  // contract). RawVoucherGrid calls useGridNav internally instead (per its
  // own header comment on that deliberate departure), so this is the only
  // useGridNav instance the shell itself owns.
  const { getCellProps: itemGridCellProps } = useGridNav({
    rowCount: itemLines.length,
    colCount: 4,
    onAddRow: addItemLine,
    onDuplicateRow: duplicateItemLine,
    onRemoveRow: removeItemLine,
  });

  function onPartyCreated(created: QuickAddedLedger) {
    setAddedLedgers((prev) => [...prev, toLedgerFromQuickAdd(created)]);
    setPartyId(created.id);
    if (!placeOfSupplyTouched && created.state_code) setPlaceOfSupply(created.state_code);
    router.refresh();
  }
  function onTradingCreated(created: QuickAddedLedger) {
    setAddedLedgers((prev) => [...prev, toLedgerFromQuickAdd(created)]);
    setTradingId(created.id);
    router.refresh();
  }
  function onItemCreated(lineIndex: number, created: QuickAddedItem) {
    setAddedItems((prev) => [...prev, toItemFromQuickAdd(created)]);
    setItemLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== lineIndex) return l;
        const suggested = isSale ? created.sale_rate : created.purchase_rate;
        return { ...l, itemId: created.id, rate: l.rate || (suggested ? String(suggested) : "") };
      })
    );
    router.refresh();
  }

  function filledItemLines(): ItemLine[] {
    return itemLines.filter((l) => l.itemId && Number(l.quantity) > 0);
  }

  // ---- raw-voucher derived values (byte-identical math to VoucherForm.tsx) ----
  const ledgerOptions = useMemo<ComboboxOption[]>(
    () => allLedgers.map((l) => ({ id: l.id, label: l.name, sublabel: l.group_name ?? undefined })),
    [allLedgers]
  );

  function openLedgerCreate(lineIndex: number, typedText: string) {
    setLedgerModalLine(lineIndex);
    setLedgerModalPrefillName(typedText.trim());
  }

  function updateVoucherLine(i: number, patch: Partial<DrCrLine>) {
    setVoucherLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== i) return l;
        const clearsSplit = "ledgerId" in patch || "amount" in patch;
        return { ...l, ...patch, ...(clearsSplit ? { tdsSplit: false } : {}) };
      })
    );
  }
  function addVoucherLine() {
    setVoucherLines((prev) => [...prev, emptyDrCrLine()]);
  }
  function removeVoucherLine(i: number) {
    setVoucherLines((prev) => (prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i)));
  }
  function duplicateVoucherLine(i: number) {
    setVoucherLines((prev) => [...prev.slice(0, i + 1), { ...prev[i] }, ...prev.slice(i + 1)]);
  }
  /** RawVoucherGrid's own new primitive (its header comment's "deliberate
   * departure #2" from Recon B3b) — the ported TDS-split logic inserts a
   * brand-new line right after an existing one rather than patching one in
   * place. Functional setState, same as every other voucherLines mutator
   * here, so a split's back-to-back onChange + onInsertLineAfter call
   * compose correctly under React's automatic batching. */
  function insertVoucherLineAfter(index: number, line: DrCrLine) {
    setVoucherLines((prev) => [...prev.slice(0, index + 1), line, ...prev.slice(index + 1)]);
  }
  function onLedgerCreated(lineIndex: number, created: QuickAddedLedger) {
    setAddedLedgers((prev) => [...prev, toLedgerFromQuickAdd(created)]);
    setVoucherLines((prev) =>
      prev.map((l, idx) => (idx === lineIndex ? { ...l, ledgerId: created.id, tdsSplit: false } : l))
    );
    router.refresh();
  }

  const rawTotals = useMemo(() => {
    const dr = sumPaise(
      voucherLines.filter((l) => l.side === "dr").map((l) => toPaise(Number(l.amount)))
    );
    const cr = sumPaise(
      voucherLines.filter((l) => l.side === "cr").map((l) => toPaise(Number(l.amount)))
    );
    return { dr, cr, balanced: dr === cr && dr > 0, difference: dr - cr };
  }, [voucherLines]);

  const filledDrCrLines = useMemo(
    () => voucherLines.filter((l) => l.ledgerId && Number(l.amount) > 0),
    [voucherLines]
  );

  const partyLedgerId = useMemo(() => {
    const candidates = Array.from(
      new Set(
        filledDrCrLines
          .map((l) => allLedgers.find((x) => x.id === l.ledgerId))
          .filter((l): l is Ledger => l?.ledger_role === "debtor" || l?.ledger_role === "creditor")
          .map((l) => l.id)
      )
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }, [filledDrCrLines, allLedgers]);
  const partyLedger = partyLedgerId ? allLedgers.find((l) => l.id === partyLedgerId) : undefined;

  const canAllocateRaw =
    (voucherType === "receipt" || voucherType === "payment") && partyLedger !== undefined;

  const partyAmount = useMemo(() => {
    if (!partyLedgerId) return 0;
    return round2(
      sumPaise(
        filledDrCrLines.filter((l) => l.ledgerId === partyLedgerId).map((l) => toPaise(Number(l.amount)))
      ) / 100
    );
  }, [filledDrCrLines, partyLedgerId]);

  const partyRowIndex = canAllocateRaw ? voucherLines.findIndex((l) => l.ledgerId === partyLedgerId) : -1;

  function sessionPartyLabel(): string {
    if (partyLedger) return partyLedger.name;
    const names = filledDrCrLines
      .map((l) => allLedgers.find((x) => x.id === l.ledgerId)?.name)
      .filter((n): n is string => Boolean(n));
    return names.join(" / ") || "—";
  }

  function onAllocationConfirmRaw(allocs: DrawerAllocation[], onAccount: number) {
    setPendingAllocations(allocs);
    setAllocationSummary({ count: allocs.length, onAccount });
    setAllocationLockKey(currentRawAllocationKey);
    setAllocationOpen(false);
  }

  // ---- numbering (0725) — mirrors both forms exactly. Re-derives itself the
  //      instant voucherType or branchId change, including on a Ctrl+H mode
  //      switch that changes voucherType (B5). ----
  const policy = isEdit ? undefined : numbering[branchId]?.[voucherType];
  const seriesOptions = policy?.mode === "series" ? policy.series : [];
  const effectiveSeriesId = seriesOptions.some((s) => s.id === seriesId)
    ? seriesId
    : (seriesOptions.find((s) => s.isDefault)?.id ?? seriesOptions[0]?.id ?? null);

  // ---- F5 render-time re-seed on `existing.id` change (B6's recommended,
  //      unified approach — component-instance reuse, no router.refresh()). ----
  const existingId = existing?.data.id ?? null;
  const [syncedExistingId, setSyncedExistingId] = useState<string | null>(existingId);
  if (existingId !== syncedExistingId) {
    setSyncedExistingId(existingId);
    if (existing) {
      setMode(existing.mode);
      setVoucherType(existing.data.voucherType);
      setBranchId(existing.data.branchId);
      setDate(existing.data.date);
      setNarration(existing.data.narration);
      setReference(existing.data.reference);
      if (existing.mode === "raw-voucher") {
        setVoucherLines(existing.data.lines.length ? existing.data.lines : [emptyDrCrLine(), emptyDrCrLine()]);
      } else {
        const inv = existing.data;
        setGodownId(inv.godownId);
        setPartyId(inv.partyId);
        setTradingId(inv.tradingId);
        setPlaceOfSupply(inv.placeOfSupply);
        setPlaceOfSupplyTouched(true);
        setChallanNumber(inv.challanNumber);
        setChallanDate(inv.challanDate);
        setItemLines(inv.lines.length ? inv.lines : [emptyItemLine()]);
        setShipToOn(Boolean(inv.shipTo));
        setShipTo(inv.shipTo ?? emptyShipTo());
      }
      setAllocations(null);
      setAllocationOnAccount(0);
      setAllocationDrawerOpen(false);
      setPendingAllocations([]);
      setAllocationSummary(null);
      setAllocationLockKey(null);
      setAllocationOpen(false);
      setError(null);
      setBusy(false);
    }
  }

  // Allocation trio #1's own sync key (item/accounting mode).
  const allocationSyncKey = `${partyId}|${voucherType}`;
  const [syncedAllocationKey, setSyncedAllocationKey] = useState(allocationSyncKey);
  if (allocationSyncKey !== syncedAllocationKey) {
    setSyncedAllocationKey(allocationSyncKey);
    setAllocations(null);
    setAllocationOnAccount(0);
    setAllocationDrawerOpen(false);
  }

  // Allocation trio #2's own sync key (raw-voucher mode).
  const currentRawAllocationKey = canAllocateRaw ? `${partyLedgerId}:${partyAmount}` : null;
  if (allocationLockKey !== null && allocationLockKey !== currentRawAllocationKey) {
    setPendingAllocations([]);
    setAllocationSummary(null);
    setAllocationLockKey(null);
  }

  /**
   * B5 — Ctrl+H. Disabled entirely while isEdit (B6). Case A (item-invoice
   * <-> accounting-invoice) needs nothing beyond the mode flag itself — both
   * share voucherType's 4-value domain, itemLines, and every other field.
   * Case B follows Recon's own rule: entering raw-voucher never has to touch
   * voucherType (its 4 values are a subset of the 8), leaving it falls back
   * to "sales" only if the value left behind isn't one of the four invoice
   * types — and only then are manualNumber/seriesId reset, since only then
   * did voucherType's domain actually change under them.
   */
  function switchMode(next: Mode) {
    if (isEdit || next === mode) return;
    const wasRaw = mode === "raw-voucher";
    const nowRaw = next === "raw-voucher";
    setMode(next);
    if (wasRaw && !nowRaw && !TYPES.some((t) => t.value === voucherType)) {
      setVoucherType("sales");
      setManualNumber("");
      setSeriesId(null);
    }
  }
  function cycleMode() {
    const idx = MODE_OPTIONS.findIndex((m) => m.value === mode);
    switchMode(MODE_OPTIONS[(idx + 1) % MODE_OPTIONS.length].value);
  }

  function handleVoucherTypeChange(value: string) {
    setVoucherType(value);
    if (mode !== "raw-voucher") {
      selectParty("");
      setTradingId("");
    }
  }

  /**
   * Every check both original forms ran onSubmit, unchanged, plus one new
   * check for migration 1530's strict_allocation module: when a company has
   * turned it on, a settlement that CAN carry a bill allocation (a new
   * credit/debit note in item/accounting mode, a new receipt/payment in
   * raw-voucher mode with a guessed party) must have actually visited the
   * allocation drawer and confirmed a choice — `allocations`/`allocationSummary`
   * being non-null is exactly that "a decision was made" marker, including a
   * deliberate "nothing to apply, all on account" choice (an empty array is
   * still a confirmed decision) — never just "the drawer happened to show
   * zero open bills", which must stay allowed.
   */
  function validateForm(): string | null {
    if (mode === "raw-voucher") {
      if (filledDrCrLines.length < 2) return "A voucher needs at least two lines with a ledger and an amount.";
      if (!rawTotals.balanced) return "Debit and credit totals must match before this can be saved.";
      if (policy?.mode === "manual") {
        const problem = validateManualNumber(manualNumber);
        if (problem) return problem;
      }
      if (strictAllocationRequired && !isEdit && canAllocateRaw && allocationSummary === null) {
        return "This company requires every receipt and payment to be applied to bills before saving. Open “Apply to bills” and confirm a split — even an all-on-account one — first.";
      }
      return null;
    }
    if (!filledItemLines().length) return "Add at least one item line.";
    if (!partyId) return `Select a ${config.party.toLowerCase()}.`;
    if (!tradingId) return `Select a ${config.trading.toLowerCase()}.`;
    if (taxable <= 0) return "The invoice must come to more than zero.";
    if (gstOn && !placeOfSupply) return "Select a place of supply.";
    if (policy?.mode === "manual") {
      const problem = validateManualNumber(manualNumber);
      if (problem) return problem;
    }
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
    if (strictAllocationRequired && !isEdit && isCreditOrDebitNote && allocations === null) {
      return "This company requires every credit and debit note to be applied to bills before saving. Open “Apply to a bill” and confirm a split — even an all-on-account one — first.";
    }
    return null;
  }

  /**
   * item-invoice / accounting-invoice save — quoted verbatim from
   * InvoiceForm.tsx's own saveInvoice(), including the challanArgs escape
   * hatch, the exact create_invoice/update_invoice argument names, the
   * voucher_ship_to upsert/delete, and set_voucher_allocations as a strictly
   * second call gated on `!existingInvoice && allocations && allocations.length > 0`.
   */
  async function saveItemInvoice(): Promise<{ voucherId: string } | null> {
    setError(null);
    const problem = validateForm();
    if (problem) {
      setError(problem);
      return null;
    }
    setBusy(true);

    const challanArgs = {
      p_challan_number: challanNumber.trim() || undefined,
      p_challan_date: challanDate || undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see InvoiceForm.tsx's identical comment
    } as any;

    const items_payload = filledItemLines().map((l) => ({
      item_id: l.itemId,
      quantity: Number(l.quantity),
      rate: Number(l.rate) || 0,
      discount_percent: Number(l.discountPercent) || 0,
      description: l.description.trim() || null,
    }));

    const { data, error: rpcError } = existingInvoice
      ? await createClient().rpc("update_invoice", {
          p_voucher_id: existingInvoice.id,
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
          p_voucher_number: policy?.mode === "manual" ? manualNumber.trim() : undefined,
          p_number_series_id: policy?.mode === "series" ? (effectiveSeriesId ?? undefined) : undefined,
          ...challanArgs,
        });

    if (rpcError) {
      setError(friendlyNumberingError(rpcError.message));
      setBusy(false);
      return null;
    }

    const voucherId = existingInvoice ? existingInvoice.id : (data as unknown as string);
    const shipToErr = shipToOn
      ? (
          await createClient()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see InvoiceForm.tsx's identical comment
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
      : existingInvoice?.shipTo
        ? (
            await createClient()
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see InvoiceForm.tsx's identical comment
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

    if (!existingInvoice && allocations && allocations.length > 0) {
      const { error: allocError } = await createClient().rpc(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- set_voucher_allocations (1490) predates the generated types.
        "set_voucher_allocations" as any,
        {
          p_company_id: companyId,
          p_settlement_voucher_id: voucherId,
          p_party_ledger_id: partyId,
          p_allocations: allocations.map((a) => ({ bill_voucher_id: a.billVoucherId, amount: a.amount })),
        }
      );
      if (allocError) {
        toast.error(
          `The ${config.label.toLowerCase()} saved, but its allocation to bills did not: ${allocError.message}. Open /allocations to finish applying it.`
        );
      }
    }

    setBusy(false);
    return { voucherId };
  }

  /**
   * raw-voucher save — quoted verbatim from VoucherForm.tsx's own
   * performSave()'s shared steps (everything up to and including
   * set_voucher_allocations), split out of the "new" vs "close" tail so this
   * shell's saveAndClose/saveAndNew can share it the same way item/accounting
   * mode's saveItemInvoice already does.
   */
  async function saveRawVoucher(): Promise<{ voucherId: string } | null> {
    setError(null);
    const problem = validateForm();
    if (problem) {
      setError(problem);
      return null;
    }
    setBusy(true);
    const supabase = createClient();

    const payload = filledDrCrLines.map((l, i) => ({
      ledger_id: l.ledgerId,
      debit_amount: l.side === "dr" ? Number(l.amount) : 0,
      credit_amount: l.side === "cr" ? Number(l.amount) : 0,
      narration: l.narration.trim() || null,
      line_order: i,
    }));

    const { data, error: saveError } = existingVoucher
      ? await supabase.rpc("update_voucher", {
          p_voucher_id: existingVoucher.id,
          p_voucher_date: date,
          p_lines: payload,
          p_narration: narration.trim() || undefined,
          p_reference_number: reference.trim() || undefined,
          p_party_ledger_id: partyLedgerId,
        })
      : await supabase.rpc("create_voucher", {
          p_company_id: companyId,
          p_branch_id: branchId,
          p_voucher_type: voucherType,
          p_voucher_date: date,
          p_lines: payload,
          p_narration: narration.trim() || undefined,
          p_reference_number: reference.trim() || undefined,
          p_party_ledger_id: partyLedgerId,
          p_voucher_number: policy?.mode === "manual" ? manualNumber.trim() : undefined,
          p_number_series_id: policy?.mode === "series" ? (effectiveSeriesId ?? undefined) : undefined,
        });

    if (saveError) {
      setError(friendlyNumberingError(saveError.message));
      setBusy(false);
      return null;
    }

    const voucherId = existingVoucher ? existingVoucher.id : (data as unknown as string);

    if (pendingAllocations.length > 0 && partyLedgerId) {
      const { error: allocError } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- set_voucher_allocations (1490) predates the generated types.
        .rpc("set_voucher_allocations" as any, {
          p_company_id: companyId,
          p_settlement_voucher_id: voucherId,
          p_party_ledger_id: partyLedgerId,
          p_allocations: pendingAllocations.map((a) => ({ bill_voucher_id: a.billVoucherId, amount: a.amount })),
        });
      if (allocError) {
        toast.error(
          `The voucher was saved, but its bill allocation was not: ${allocError.message}. Open Reports → Allocations to apply it there instead.`
        );
      }
    }

    setBusy(false);
    return { voucherId };
  }

  function resetForNewItemInvoice() {
    setGodownId(godowns[0]?.id ?? "");
    setPartyId("");
    setTradingId("");
    setPlaceOfSupply("");
    setPlaceOfSupplyTouched(false);
    setChallanNumber("");
    setChallanDate("");
    setItemLines([emptyItemLine()]);
    setShipToOn(false);
    setShipTo(emptyShipTo());
    setManualNumber("");
    setSeriesId(null);
    setAllocations(null);
    setAllocationOnAccount(0);
    setAllocationDrawerOpen(false);
    setError(null);
  }

  function resetForNewRawVoucher() {
    setVoucherLines([emptyDrCrLine(), emptyDrCrLine()]);
    setManualNumber("");
    setPendingAllocations([]);
    setAllocationSummary(null);
    setAllocationLockKey(null);
    setError(null);
  }

  /** Save & close (mod+shift+s / the Save button). Preserves each original
   * mode's own navigation target: item/accounting always lands on the
   * voucher itself (InvoiceForm's own behaviour, edit or new); raw-voucher
   * lands on the voucher when editing and the daybook on a fresh save
   * (VoucherForm's own behaviour) — a pre-existing divergence between the
   * two forms this shell intentionally keeps rather than papering over. */
  async function saveAndClose() {
    if (busy) return;
    if (mode === "raw-voucher") {
      const result = await saveRawVoucher();
      if (!result) return;
      router.push(
        existingVoucher ? `/${companyId}/vouchers/${existingVoucher.id}` : `/${companyId}/reports/daybook`
      );
      router.refresh();
      return;
    }
    const result = await saveItemInvoice();
    if (!result) return;
    router.push(`/${companyId}/vouchers/${result.voucherId}`);
    router.refresh();
  }

  /** mod+s on a NEW voucher/invoice: save, reopen a blank one of the same
   * type/branch/date, and drop a session-strip pill. Only ever called when
   * !isEdit — see useShortcuts wiring below. */
  async function saveAndNew() {
    if (busy) return;
    if (mode === "raw-voucher") {
      const partyName = sessionPartyLabel();
      const savedAmount = rawTotals.dr / 100;
      const result = await saveRawVoucher();
      if (!result) return;
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
          href: `/${companyId}/vouchers/${result.voucherId}`,
        },
      ]);
      resetForNewRawVoucher();
      return;
    }
    const partyName = allLedgers.find((l) => l.id === partyId)?.name ?? "—";
    const savedAmount = grandTotal;
    const result = await saveItemInvoice();
    if (!result) return;
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
    resetForNewItemInvoice();
    router.refresh();
  }

  /** F5, unified per Recon's own recommendation: component-instance reuse
   * (InvoiceForm's approach), no router.refresh() — the syncedExistingId
   * block above re-seeds every field once `existing.id` actually changes. */
  async function goAdjacent(direction: "prev" | "next") {
    if (!existing || adjacentBusy || busy) return;
    setAdjacentBusy(true);
    const { data, error: rpcError } = await createClient().rpc(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_adjacent_voucher (1520) predates the generated types.
      "get_adjacent_voucher" as any,
      { p_company_id: companyId, p_voucher_id: existing.data.id, p_direction: direction }
    );
    setAdjacentBusy(false);
    if (rpcError) {
      toast.error(rpcError.message);
      return;
    }
    const row = (data as unknown as Array<{ id: string }> | null)?.[0];
    const typeLabel =
      mode === "raw-voucher"
        ? (VOUCHER_TYPES.find((t) => t.value === voucherType)?.label.toLowerCase() ?? "voucher")
        : config.label.toLowerCase();
    if (!row) {
      toast(
        direction === "prev"
          ? `${existing.data.voucherNumber} is the earliest ${typeLabel} here.`
          : `${existing.data.voucherNumber} is the latest ${typeLabel} here.`
      );
      return;
    }
    const target =
      existing.mode === "raw-voucher"
        ? `/${companyId}/vouchers/${row.id}/edit`
        : `/${companyId}/invoices/${row.id}/edit`;
    router.push(target);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void saveAndClose();
  }

  // F1 — unified onto VoucherForm's own mod+-prefixed, cross-platform combo
  // spelling per Recon's own recommendation. mod+h is the new Ctrl+H mode
  // switch, disabled while isEdit exactly like the mode tabs below it — its
  // visible control is that same tab row, satisfying useShortcuts.ts's own
  // "never the only way" rule.
  useShortcuts("voucher-screen", [
    {
      combo: "mod+s",
      label: isEdit ? "Save changes" : "Save & start next",
      handler: () => {
        if (busy) return;
        if (isEdit) void saveAndClose();
        else void saveAndNew();
      },
    },
    {
      combo: "mod+shift+s",
      label: "Save & close",
      handler: () => {
        if (!busy) void saveAndClose();
      },
    },
    ...(!isEdit
      ? [{ combo: "mod+h", label: "Switch entry mode", handler: () => cycleMode() }]
      : []),
    ...(isEdit
      ? [
          { combo: "alt+ArrowUp", label: "Previous voucher", handler: () => void goAdjacent("prev") },
          { combo: "alt+ArrowDown", label: "Next voucher", handler: () => void goAdjacent("next") },
        ]
      : []),
  ]);

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  const isItemMode = mode !== "raw-voucher";
  const typeOptions = mode === "raw-voucher" ? VOUCHER_TYPES : TYPES;

  return (
    <>
      {/* Ctrl+H's visible control (B6/F1) — hidden entirely once isEdit, same
          reason Type/Branch lock on isEdit below. The P7.2 gear sits beside
          it (task's own "next to the mode switch"), but renders regardless
          of isEdit — the nine preferences it toggles (narration, ship-to,
          challan fields, discount column, ...) apply to an edit screen just
          as much as a fresh one. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-1.5">
        {!isEdit ? (
          <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Entry mode">
            {MODE_OPTIONS.map((m) => (
              <button
                key={m.value}
                type="button"
                role="tab"
                aria-selected={mode === m.value}
                onClick={() => switchMode(m.value)}
                title="Ctrl+H cycles"
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  mode === m.value
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border-strong text-ink-soft hover:bg-surface-2 hover:text-ink"
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <VoucherEntryConfigGear config={entryConfig} onToggle={toggleEntryConfig} />
      </div>

      <form onSubmit={onSubmit} className={isEdit ? "" : "mt-0"}>
        {isEdit && (
          <div className="mb-5 flex items-center gap-2 print:hidden">
            <button
              type="button"
              onClick={() => void goAdjacent("prev")}
              disabled={adjacentBusy}
              title="Alt+↑"
              className="rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
            >
              <ChevronUp size={12} className="inline" aria-hidden="true" /> Previous
            </button>
            <button
              type="button"
              onClick={() => void goAdjacent("next")}
              disabled={adjacentBusy}
              title="Alt+↓"
              className="rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
            >
              Next <ChevronDown size={12} className="inline" aria-hidden="true" />
            </button>
            <span className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm font-mono text-ink-soft">
              {existing!.data.voucherNumber}
            </span>
            <span className="text-xs text-ink-faint">Fixed once issued.</span>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Type</span>
            <select
              value={voucherType}
              disabled={isEdit}
              onChange={(e) => handleVoucherTypeChange(e.target.value)}
              className={field + (isEdit ? " opacity-60" : "")}
            >
              {typeOptions.map((t) => (
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

          <VoucherNumberField
            policy={policy}
            manualNumber={manualNumber}
            onManualNumberChange={setManualNumber}
            seriesId={effectiveSeriesId}
            onSeriesIdChange={setSeriesId}
          />

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Reference <span className="font-normal text-ink-faint">optional</span>
            </span>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={isItemMode && isSale ? "Their PO no." : isItemMode ? "Their bill no." : "Bill / PO no."}
              className={field}
            />
          </label>

          {isItemMode && (
            <>
              {entryConfig.showChallanFields && (
                <>
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
                  </label>
                </>
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
                  onCreateNew={() => setPartyModalOpen(true)}
                />
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
                <Combobox
                  value={godownId}
                  onChange={setGodownId}
                  options={godowns.map((g) => ({ id: g.id, label: `${g.code} — ${g.name}` }))}
                  placeholder="Select…"
                />
                {hasChargeLine && (
                  <span className="text-xs text-ink-faint">
                    Charge lines carry their SAC and GST but no stock, so this godown covers only the goods lines.
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
                      This branch has no GST registration — tax cannot be computed from it.
                    </span>
                  )}
                </label>
              )}
            </>
          )}

          {!isItemMode && (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-sm font-medium">Party (guessed)</span>
              <div className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-ink-soft">
                {partyLedger?.name ?? "No single debtor/creditor line yet — add ledger lines below."}
              </div>
              {canAllocateRaw && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <button
                    type="button"
                    onClick={() => setAllocationOpen(true)}
                    className="text-xs text-accent underline underline-offset-4"
                  >
                    {allocationSummary ? "Change bill allocation" : "Apply to bills"}
                  </button>
                  {allocationSummary && (
                    <span className="text-xs text-ink-faint">
                      {allocationSummary.count} bill{allocationSummary.count === 1 ? "" : "s"} ·{" "}
                      {formatINR(allocationSummary.onAccount, { showZero: true })} on account.
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {isItemMode && entryConfig.showShipTo && (
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
                  Bill-to / ship-to. Printed as the address of delivery, which a tax invoice must show when it
                  differs from the place of supply (CGST Rule 46).
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
                  <input value={shipTo.city} onChange={(e) => setShip({ city: e.target.value })} className={field} />
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

                {shipToIsElsewhere && (
                  <p className="rounded-lg border border-border-strong bg-bg px-3 py-2.5 text-xs text-ink-soft sm:col-span-3">
                    The goods leave the state the invoice is billed in, and the tax does not follow them. Place of
                    supply stays with{" "}
                    <span className="font-medium text-ink">
                      {allLedgers.find((l) => l.id === partyId)?.name ?? "the billed party"}
                    </span>{" "}
                    — Sec 10(1)(b) IGST Act deems the party directing the delivery to have received the goods, so
                    their own state decides CGST+SGST or IGST.
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {mode === "raw-voucher" ? (
          <RawVoucherGrid
            lines={voucherLines}
            onChange={updateVoucherLine}
            onAddRow={addVoucherLine}
            onDuplicateRow={duplicateVoucherLine}
            onRemoveRow={removeVoucherLine}
            onInsertLineAfter={insertVoucherLineAfter}
            ledgers={allLedgers}
            ledgerOptions={ledgerOptions}
            onNewLedger={openLedgerCreate}
            tdsSections={tdsSections}
            tdsPayableLedgerId={tdsPayableLedgerId}
            gstLedgerIds={gstLedgerIds}
            voucherType={voucherType}
            date={date}
            partyRowIndex={partyRowIndex}
            allocationSummary={allocationSummary}
            onOpenAllocation={() => setAllocationOpen(true)}
          />
        ) : mode === "accounting-invoice" ? (
          <AccountingInvoiceGrid
            lines={itemLines}
            onChange={updateItemLine}
            onAddRow={addItemLine}
            onDuplicateRow={duplicateItemLine}
            onRemoveRow={removeItemLine}
            items={nonStockItems}
            isSale={isSale}
            gstOn={gstOn}
            priceListRate={priceListRate}
            onNewItem={onNewItemLine}
            getCellProps={itemGridCellProps}
            showDiscountColumn={entryConfig.showDiscountColumn}
          />
        ) : (
          <ItemInvoiceGrid
            lines={itemLines}
            onChange={updateItemLine}
            onAddRow={addItemLine}
            onDuplicateRow={duplicateItemLine}
            onRemoveRow={removeItemLine}
            items={allItems}
            isSale={isSale}
            gstOn={gstOn}
            priceListRate={priceListRate}
            onNewItem={onNewItemLine}
            getCellProps={itemGridCellProps}
            showDiscountColumn={entryConfig.showDiscountColumn}
          />
        )}

        <div className="mt-4 rounded-lg border border-border bg-bg p-3 text-sm">
          {isItemMode ? (
            <>
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
            </>
          ) : (
            <>
              <div className="flex justify-between tabular-nums font-mono">
                <span>{formatINR(rawTotals.dr / 100, { showZero: true })} Dr</span>
                <span>{formatINR(rawTotals.cr / 100, { showZero: true })} Cr</span>
              </div>
              <div className="mt-2 flex justify-between border-t border-border-strong pt-2 text-xs">
                <span
                  className={cn(
                    "rounded px-2 py-1 font-medium",
                    rawTotals.balanced ? "bg-success-soft text-success" : "bg-warning-soft text-warning"
                  )}
                >
                  {rawTotals.balanced
                    ? "Balanced"
                    : `Out by ${formatINR(Math.abs(rawTotals.difference) / 100, { showZero: true })}`}
                </span>
              </div>
            </>
          )}
        </div>

        {entryConfig.showNarration && (
          <label className="mt-5 flex flex-col gap-1.5">
            <span className="text-sm font-medium">Narration</span>
            <textarea
              rows={2}
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              placeholder={isItemMode ? undefined : "Being…"}
              className={field}
            />
          </label>
        )}

        {error && (
          <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
        )}

        {isEdit && mode === "raw-voucher" && (
          <p className="mt-4 rounded-md border border-border bg-bg px-3 py-2 text-xs text-ink-soft">
            The date must stay inside financial year {existingVoucher!.financialYearLabel}. This voucher&rsquo;s
            number belongs to that series and may already be printed on a document sent to the other party — the
            database refuses the move rather than renumbering behind you.
          </p>
        )}

        <p className="mt-5 text-xs text-ink-faint">
          Saving records the stock movement (if any), the tax and the ledger entries together, in one transaction —
          never any of them without the others.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy || (isItemMode ? taxable <= 0 : !rawTotals.balanced)}
            title="mod+shift+s"
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50 sm:w-auto"
          >
            {busy ? "Saving…" : isEdit ? "Save changes" : `Save ${isItemMode ? config.label.toLowerCase() : "voucher"}`}
          </button>
          {!isEdit && (
            <button
              type="button"
              disabled={busy || (isItemMode ? taxable <= 0 : !rawTotals.balanced)}
              onClick={() => void saveAndNew()}
              title="mod+s"
              className="w-full rounded-lg border border-border-strong px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50 sm:w-auto"
            >
              {busy ? "Saving…" : "Save & start next"}
            </button>
          )}
          <span className="text-xs text-ink-faint">
            {isEdit
              ? "mod+s to save · Alt+↑ / Alt+↓ for the previous or next voucher"
              : "mod+s saves and starts the next · mod+shift+s saves and closes · mod+h switches entry mode"}
          </span>
        </div>

        {isItemMode && (
          <>
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
              onCreated={(created) => {
                if (itemModalLine !== null) onItemCreated(itemModalLine, created);
              }}
            />
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
          </>
        )}

        {!isItemMode && (
          <>
            <QuickAddLedgerModal
              open={ledgerModalLine !== null}
              onClose={() => {
                setLedgerModalLine(null);
                setLedgerModalPrefillName("");
              }}
              companyId={companyId}
              title="New ledger"
              description="Enough to post against. TDS, MSME, related-party and the rest live on the ledgers screen."
              prefill={ledgerModalPrefillName ? { name: ledgerModalPrefillName } : undefined}
              onCreated={(created) => {
                if (ledgerModalLine !== null) onLedgerCreated(ledgerModalLine, created);
                setLedgerModalPrefillName("");
              }}
            />
            <AllocationDrawer
              companyId={companyId}
              partyLedgerId={partyLedgerId ?? ""}
              role={partyLedger?.ledger_role === "creditor" ? "creditor" : "debtor"}
              amount={partyAmount}
              asAt={date}
              open={allocationOpen}
              onClose={() => setAllocationOpen(false)}
              onConfirm={onAllocationConfirmRaw}
            />
          </>
        )}
      </form>

      {!isEdit && (
        <div className="mt-4">
          <SessionStrip entries={sessionEntries} onClear={() => setSessionEntries([])} />
        </div>
      )}
    </>
  );
}
