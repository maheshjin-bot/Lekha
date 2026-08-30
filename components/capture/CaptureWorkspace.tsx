"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR, sumPaise, toPaise } from "@/lib/utils/currency";
import { fuzzyMatchByName } from "@/lib/capture/fuzzyMatch";
import type { CaptureExtraction, CaptureLineItem } from "@/lib/capture/analyze";
import {
  QuickAddLedgerModal,
  type QuickAddedLedger,
} from "@/components/ledgers/QuickAddLedgerModal";
import {
  QuickAddItemModal,
  type QuickAddedItem,
} from "@/components/items/QuickAddItemModal";
import { VoucherNumberField } from "@/components/numbering/VoucherNumberField";
import { PURCHASE_TRADING_ROLES } from "@/lib/invoices/trading-roles";
import {
  friendlyNumberingError,
  validateManualNumber,
  type VoucherNumberingByBranch,
} from "@/lib/numbering/voucher-numbering";

/**
 * The review-and-post screen for OCR/vision bill capture (0740).
 *
 * A capture draft never posts itself: "Post as purchase bill" below calls the
 * EXISTING create_invoice RPC (same signature InvoiceForm.tsx uses, same
 * 'purchase' voucher type) with whatever the human confirmed in this form —
 * never a new posting path, never a direct voucher_entries write. Only after
 * that RPC succeeds does this component mark the draft confirmed.
 *
 * The vision model's guesses are a PREFILL, not an authority: every field
 * below is the same editable input a person would use typing the bill in by
 * hand, just started from whatever the model could read. A party the model
 * named is fuzzy-matched against this company's own ledgers by name
 * (lib/capture/fuzzyMatch.ts); on a real match, that ledger is preselected,
 * otherwise the party select is left blank and the model's raw guess is
 * shown as plain text next to "+ New" so nothing it read is silently
 * dropped — this is the "fall back to free text" the feature asked for:
 * create_invoice takes a real ledger id, not a name string, so free text can
 * only ever be shown for reference, never sent as the party.
 */

type Item = {
  id: string;
  name: string;
  uom: string;
  sale_rate: number | null;
  purchase_rate: number | null;
  gst_rate_percent: number;
  default_tcs_section: string | null;
};
type Ledger = { id: string; name: string; ledger_role: string; state_code: string | null; pan: string | null };
type Branch = { id: string; code: string; name: string; registeredState: string | null };
type Godown = { id: string; code: string; name: string };
type StateOption = { code: string; name: string };

type DraftRow = {
  id: string;
  source: string;
  storage_path: string;
  extracted_json: unknown;
  status: "pending_review" | "confirmed" | "rejected";
  confirmed_voucher_id: string | null;
  created_at: string;
};

type Line = { itemId: string; quantity: string; rate: string; discountPercent: string; description: string };

const ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Mirrors create_invoice's own per-line formula exactly (0147), the same
// copy InvoiceForm.tsx keeps for the same reason: this is a client-side
// preview only, so the number shown here must never disagree with what the
// database will actually post.
function lineAmounts(quantity: string, rate: string, discountPercent: string) {
  const qty = Number(quantity) || 0;
  const r = Number(rate) || 0;
  const discPct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const gross = Math.round(qty * r * 100) / 100;
  const discount = Math.round(((gross * discPct) / 100) * 100) / 100;
  const net = Math.round((gross - discount) * 100) / 100;
  return { gross, discount, net };
}

function asExtraction(raw: unknown): CaptureExtraction | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as CaptureExtraction;
}

function extractionLineToFormLine(li: CaptureLineItem, items: Item[]): Line {
  const match = fuzzyMatchByName(li.description, items);
  return {
    itemId: match?.id ?? "",
    quantity: li.quantity != null ? String(li.quantity) : "1",
    rate: li.rate != null ? String(li.rate) : match?.purchase_rate != null ? String(match.purchase_rate) : "",
    discountPercent: "",
    description: li.description,
  };
}

function draftSummary(extraction: CaptureExtraction | null): string {
  if (!extraction) return "No extraction recorded";
  if (!extraction.configured) return "Vision capture not configured";
  const vendor = extraction.vendor_name ?? "Unknown vendor";
  const amount = extraction.total_amount != null ? formatINR(extraction.total_amount, { showZero: true }) : "—";
  return `${vendor} · ${amount}`;
}

export function CaptureWorkspace({
  companyId,
  items,
  ledgers,
  branches,
  godowns,
  gstOn,
  states,
  numbering,
  initialDrafts,
}: {
  companyId: string;
  items: Item[];
  ledgers: Ledger[];
  branches: Branch[];
  godowns: Godown[];
  gstOn: boolean;
  states: StateOption[];
  numbering: VoucherNumberingByBranch;
  initialDrafts: DraftRow[];
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [drafts, setDrafts] = useState<DraftRow[]>(initialDrafts);
  const [selectedId, setSelectedId] = useState<string | null>(initialDrafts[0]?.id ?? null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [addedLedgers, setAddedLedgers] = useState<Ledger[]>([]);
  const [addedItems, setAddedItems] = useState<Item[]>([]);
  const allLedgers = useMemo(() => {
    const known = new Set(ledgers.map((l) => l.id));
    return [...ledgers, ...addedLedgers.filter((l) => !known.has(l.id))];
  }, [ledgers, addedLedgers]);
  const allItems = useMemo(() => {
    const known = new Set(items.map((i) => i.id));
    return [...items, ...addedItems.filter((i) => !known.has(i.id))];
  }, [items, addedItems]);

  const supplierLedgers = allLedgers.filter((l) => l.ledger_role === "creditor" || l.ledger_role === "cash_bank");
  const tradingLedgers = allLedgers.filter((l) => (PURCHASE_TRADING_ROLES as readonly string[]).includes(l.ledger_role));

  const selectedDraft = drafts.find((d) => d.id === selectedId) ?? null;
  const extraction = asExtraction(selectedDraft?.extracted_json);

  // Review-form state — reset whenever the selected draft changes (keyed
  // remount below), seeded from that draft's own extraction.
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [godownId, setGodownId] = useState(godowns[0]?.id ?? "");
  const [date, setDate] = useState(extraction?.bill_date ?? todayLocal());
  const [partyId, setPartyId] = useState(
    () => fuzzyMatchByName(extraction?.vendor_name, supplierLedgers)?.id ?? ""
  );
  const [placeOfSupplyTouched, setPlaceOfSupplyTouched] = useState(false);
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [tradingId, setTradingId] = useState("");
  const [reference, setReference] = useState("");
  const [narration, setNarration] = useState(
    extraction?.note ? `Captured bill — ${extraction.note}` : ""
  );
  const [lines, setLines] = useState<Line[]>(
    extraction?.line_items.length
      ? extraction.line_items.map((li) => extractionLineToFormLine(li, allItems))
      : [{ itemId: "", quantity: "1", rate: "", discountPercent: "", description: "" }]
  );
  const [manualNumber, setManualNumber] = useState("");
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [partyModalOpen, setPartyModalOpen] = useState(false);
  const [tradingModalOpen, setTradingModalOpen] = useState(false);
  const [itemModalLine, setItemModalLine] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formKey = selectedId ?? "none";

  const branch = branches.find((b) => b.id === branchId);
  const policy = numbering[branchId]?.purchase;
  const seriesOptions = policy?.mode === "series" ? policy.series : [];
  const effectiveSeriesId = seriesOptions.some((s) => s.id === seriesId)
    ? seriesId
    : (seriesOptions.find((s) => s.isDefault)?.id ?? seriesOptions[0]?.id ?? null);

  function selectParty(id: string) {
    setPartyId(id);
    if (placeOfSupplyTouched) return;
    const party = allLedgers.find((l) => l.id === id);
    if (party?.state_code) setPlaceOfSupply(party.state_code);
  }

  const supplyType =
    gstOn && branch?.registeredState && placeOfSupply
      ? branch.registeredState === placeOfSupply
        ? "intra"
        : "inter"
      : null;

  const taxable = useMemo(
    () => sumPaise(lines.map((l) => toPaise(lineAmounts(l.quantity, l.rate, l.discountPercent).net))) / 100,
    [lines]
  );

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

  const grandTotal = taxable + tax.cgst + tax.sgst + tax.igst;

  function selectDraft(id: string) {
    setSelectedId(id);
    const draft = drafts.find((d) => d.id === id);
    const ex = asExtraction(draft?.extracted_json);
    setBranchId(branches[0]?.id ?? "");
    setGodownId(godowns[0]?.id ?? "");
    setDate(ex?.bill_date ?? todayLocal());
    setPlaceOfSupplyTouched(false);
    setPlaceOfSupply("");
    const matchedParty = fuzzyMatchByName(ex?.vendor_name, supplierLedgers);
    setPartyId(matchedParty?.id ?? "");
    if (matchedParty?.state_code) setPlaceOfSupply(matchedParty.state_code);
    setTradingId("");
    setReference("");
    setNarration(ex?.note ? `Captured bill — ${ex.note}` : "");
    setLines(
      ex?.line_items.length
        ? ex.line_items.map((li) => extractionLineToFormLine(li, allItems))
        : [{ itemId: "", quantity: "1", rate: "", discountPercent: "", description: "" }]
    );
    setManualNumber("");
    setSeriesId(null);
    setError(null);
  }

  function update(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function upload(file: File) {
    setUploadError(null);
    if (!ALLOWED_MIME.includes(file.type)) {
      setUploadError("Only PDF, PNG, JPEG or WebP files can be captured.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploadError("File is larger than the 10 MB limit.");
      return;
    }

    setUploading(true);
    const body = new FormData();
    body.append("file", file);
    body.append("companyId", companyId);
    if (branchId) body.append("branchId", branchId);

    try {
      const res = await fetch("/api/capture/analyze", { method: "POST", body });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.draftId) {
        setUploadError(json?.error ?? "Could not analyze this file.");
        return;
      }
      const newDraft: DraftRow = {
        id: json.draftId,
        source: "upload",
        storage_path: "",
        extracted_json: json.extracted,
        status: "pending_review",
        confirmed_voucher_id: null,
        created_at: new Date().toISOString(),
      };
      setDrafts((prev) => [newDraft, ...prev]);
      selectDraft(newDraft.id);
      if (json.extracted?.configured === false) {
        toast.message("Vision capture isn't configured on this server — fill in the bill by hand below.");
      } else {
        toast.success("Bill read — check the draft below before posting.");
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function discard() {
    if (!selectedDraft || busy) return;
    setBusy(true);
    // capture_drafts is brand new (0740) — types/database.types.ts does not
    // know it in this session (no live DB connection was available to
    // regenerate it here; see this task's own final report).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const { error: updateError } = await (createClient() as any)
      .from("capture_drafts")
      .update({ status: "rejected" })
      .eq("id", selectedDraft.id);
    setBusy(false);
    if (updateError) {
      toast.error(updateError.message);
      return;
    }
    setDrafts((prev) => prev.map((d) => (d.id === selectedDraft.id ? { ...d, status: "rejected" } : d)));
    toast.success("Draft discarded");
  }

  async function post(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selectedDraft) return;

    const filled = lines.filter((l) => l.itemId && Number(l.quantity) > 0);
    if (!filled.length) {
      return setError("Match at least one line to a real item before posting — pick from the dropdown or use + New.");
    }
    if (!partyId) return setError("Select or create the supplier ledger.");
    if (!tradingId) return setError("Select the purchase/expense ledger.");
    if (taxable <= 0) return setError("The bill must come to more than zero.");
    if (gstOn && !placeOfSupply) return setError("Select a place of supply.");
    if (policy?.mode === "manual") {
      const problem = validateManualNumber(manualNumber);
      if (problem) return setError(problem);
    }

    setBusy(true);
    const items_payload = filled.map((l) => ({
      item_id: l.itemId,
      quantity: Number(l.quantity),
      rate: Number(l.rate) || 0,
      discount_percent: Number(l.discountPercent) || 0,
      description: l.description.trim() || null,
    }));

    const { data: voucherId, error: postError } = await createClient().rpc("create_invoice", {
      p_company_id: companyId,
      p_branch_id: branchId,
      p_voucher_type: "purchase",
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
    });

    if (postError || !voucherId) {
      setError(friendlyNumberingError(postError?.message ?? "Could not post this bill."));
      setBusy(false);
      return;
    }

    // The voucher is posted at this point — a real, already-final ledger
    // effect. Marking the draft confirmed is bookkeeping about THAT fact,
    // never a precondition for it, so a failure here is a warning, not a
    // reason to pretend the post did not happen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const { error: confirmError } = await (createClient() as any)
      .from("capture_drafts")
      .update({ confirmed_voucher_id: voucherId, branch_id: branchId })
      .eq("id", selectedDraft.id);
    if (confirmError) {
      toast.error(`Posted, but the draft record could not be updated: ${confirmError.message}`);
    }

    setBusy(false);
    router.push(`/${companyId}/vouchers/${voucherId}`);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section>
        <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-ink-soft hover:bg-surface-2">
          {uploading ? "Reading the bill…" : "Upload a photo or PDF of a bill"}
          <input
            ref={fileInput}
            type="file"
            accept={ALLOWED_MIME.join(",")}
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
            }}
            className="sr-only"
          />
        </label>
        {uploadError && <p className="mt-2 text-sm text-error">{uploadError}</p>}
      </section>

      {drafts.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-ink-soft">Drafts</h2>
          <div className="mt-2 flex flex-col gap-2">
            {drafts.map((d) => {
              const ex = asExtraction(d.extracted_json);
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => selectDraft(d.id)}
                  className={
                    "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors " +
                    (d.id === selectedId
                      ? "border-accent bg-accent/5"
                      : "border-border-strong hover:bg-surface-2")
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{draftSummary(ex)}</span>
                  <span
                    className={
                      "shrink-0 rounded-full px-2 py-0.5 text-xs " +
                      (d.status === "confirmed"
                        ? "bg-success-soft text-success"
                        : d.status === "rejected"
                          ? "bg-error-soft text-error"
                          : "bg-surface-2 text-ink-faint")
                    }
                  >
                    {d.status === "pending_review" ? "Pending review" : d.status}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {selectedDraft && selectedDraft.status === "pending_review" && (
        <form key={formKey} onSubmit={post} className="border-t border-border pt-6">
          <h2 className="text-lg font-semibold text-ink">Review draft</h2>
          {extraction && !extraction.configured && (
            <p className="mt-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
              Vision capture isn&rsquo;t configured on this server (no GOOGLE_API_KEY). Nothing was
              read automatically — fill in every field below by hand.
            </p>
          )}
          {extraction?.configured && (
            <p className="mt-2 text-xs text-ink-faint">
              Model read this bill as {extraction.confidence} confidence: {extraction.note}
            </p>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Date</span>
              <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={field} />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Their bill no. <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input value={reference} onChange={(e) => setReference(e.target.value)} className={field} />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Branch</span>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field}>
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

            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">Supplier</span>
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
                aria-label="Supplier"
                value={partyId}
                onChange={(e) => selectParty(e.target.value)}
                className={field}
              >
                <option value="">Select…</option>
                {supplierLedgers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              {extraction?.vendor_name && (
                <span className="text-xs text-ink-faint">
                  {partyId
                    ? `Matched from the bill's "${extraction.vendor_name}".`
                    : `Bill read as "${extraction.vendor_name}" — no matching ledger found. Use + New to create one with this name, or pick an existing supplier.`}
                </span>
              )}
              {extraction?.vendor_gstin && (
                <span className="text-xs text-ink-faint">GSTIN on bill: {extraction.vendor_gstin}</span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">Purchase/expense ledger</span>
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
                aria-label="Purchase/expense ledger"
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
              </label>
            )}
          </div>

          <div className="mt-6 flex flex-col gap-3">
            {lines.map((line, i) => {
              const item = allItems.find((x) => x.id === line.itemId);
              const { gross, discount, net } = lineAmounts(line.quantity, line.rate, line.discountPercent);
              return (
                <div key={i} className="rounded-lg border border-border bg-surface p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                      Line {i + 1}
                      {!line.itemId && line.description && (
                        <span className="ml-2 normal-case font-normal text-ink-faint">
                          — read as &ldquo;{line.description}&rdquo;, no matching item
                        </span>
                      )}
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
                      <span className="text-xs text-ink-faint">GST {item ? `${item.gst_rate_percent}%` : "—"}</span>
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
              onClick={() =>
                setLines((p) => [...p, { itemId: "", quantity: "1", rate: "", discountPercent: "", description: "" }])
              }
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
              <div className="mt-2 flex justify-between border-t border-border-strong pt-2 tabular-nums font-mono font-semibold">
                <span>Total</span>
                <span>{formatINR(grandTotal, { showZero: true })}</span>
              </div>
              {extraction?.total_amount != null && Math.abs(extraction.total_amount - grandTotal) > 1 && (
                <p className="mt-2 text-xs text-warning">
                  The bill read a total of {formatINR(extraction.total_amount, { showZero: true })} — check the
                  lines and rates above before posting.
                </p>
              )}
            </div>
          </div>

          <label className="mt-5 flex flex-col gap-1.5">
            <span className="text-sm font-medium">Narration</span>
            <textarea rows={2} value={narration} onChange={(e) => setNarration(e.target.value)} className={field} />
          </label>

          {error && <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>}

          <p className="mt-5 text-xs text-ink-faint">
            Posting calls the same create_invoice used by the ordinary purchase-bill screen — nothing here
            bypasses it. Nothing is posted until you press the button below.
          </p>

          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Posting…" : "Post as purchase bill"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={discard}
              className="rounded-lg border border-border-strong px-4 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              Discard draft
            </button>
          </div>
        </form>
      )}

      {selectedDraft && selectedDraft.status === "confirmed" && (
        <p className="border-t border-border pt-6 text-sm text-ink-soft">
          Already posted as{" "}
          <a
            href={`/${companyId}/vouchers/${selectedDraft.confirmed_voucher_id}`}
            className="text-accent underline underline-offset-4"
          >
            this voucher
          </a>
          .
        </p>
      )}

      {selectedDraft && selectedDraft.status === "rejected" && (
        <p className="border-t border-border pt-6 text-sm text-ink-faint">This draft was discarded.</p>
      )}

      <QuickAddLedgerModal
        open={partyModalOpen}
        onClose={() => setPartyModalOpen(false)}
        companyId={companyId}
        title="New supplier"
        description="Created under a payables group, so it appears in the supplier list straight away."
        roles={["creditor"]}
        onCreated={(created: QuickAddedLedger) => {
          setAddedLedgers((prev) => [
            ...prev,
            { id: created.id, name: created.name, ledger_role: created.ledger_role, state_code: created.state_code, pan: created.pan },
          ]);
          setPartyId(created.id);
          if (!placeOfSupplyTouched && created.state_code) setPlaceOfSupply(created.state_code);
          router.refresh();
        }}
      />

      <QuickAddLedgerModal
        open={tradingModalOpen}
        onClose={() => setTradingModalOpen(false)}
        companyId={companyId}
        title="New purchase/expense ledger"
        description="An expense ledger — what the purchase is debited to."
        roles={PURCHASE_TRADING_ROLES}
        onCreated={(created: QuickAddedLedger) => {
          setAddedLedgers((prev) => [
            ...prev,
            { id: created.id, name: created.name, ledger_role: created.ledger_role, state_code: created.state_code, pan: created.pan },
          ]);
          setTradingId(created.id);
          router.refresh();
        }}
      />

      <QuickAddItemModal
        open={itemModalLine !== null}
        onClose={() => setItemModalLine(null)}
        companyId={companyId}
        gstOn={gstOn}
        requireStockItem
        onCreated={(created: QuickAddedItem) => {
          setAddedItems((prev) => [
            ...prev,
            {
              id: created.id,
              name: created.name,
              uom: created.uom,
              sale_rate: created.sale_rate,
              purchase_rate: created.purchase_rate,
              gst_rate_percent: created.gst_rate_percent,
              default_tcs_section: created.default_tcs_section,
            },
          ]);
          if (itemModalLine !== null) {
            const suggested = created.purchase_rate;
            setLines((prev) =>
              prev.map((l, idx) =>
                idx === itemModalLine
                  ? { ...l, itemId: created.id, rate: l.rate || (suggested ? String(suggested) : "") }
                  : l
              )
            );
          }
          router.refresh();
        }}
      />
    </div>
  );
}
