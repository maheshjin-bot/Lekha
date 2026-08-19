"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR, sumPaise, toPaise } from "@/lib/utils/currency";

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
type TcsSection = {
  section_code: string;
  rate_percent: number;
  no_pan_rate_percent: number;
  threshold_rupees: number | null;
};

const TYPES = [
  { value: "sales", label: "Sales invoice", party: "Customer", trading: "Sales ledger", roles: ["debtor", "cash_bank"] },
  { value: "purchase", label: "Purchase bill", party: "Supplier", trading: "Purchase ledger", roles: ["creditor", "cash_bank"] },
  { value: "credit_note", label: "Credit note", party: "Customer", trading: "Sales ledger", roles: ["debtor", "cash_bank"] },
  { value: "debit_note", label: "Debit note", party: "Supplier", trading: "Purchase ledger", roles: ["creditor", "cash_bank"] },
] as const;

type Line = { itemId: string; quantity: string; rate: string; description: string };
const emptyLine = (): Line => ({ itemId: "", quantity: "1", rate: "", description: "" });

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
}) {
  const router = useRouter();
  const [voucherType, setVoucherType] = useState<(typeof TYPES)[number]["value"]>("sales");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [godownId, setGodownId] = useState(godowns[0]?.id ?? "");
  const [date, setDate] = useState(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  const [partyId, setPartyId] = useState("");
  const [tradingId, setTradingId] = useState("");
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [placeOfSupplyTouched, setPlaceOfSupplyTouched] = useState(false);
  const [reference, setReference] = useState("");
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = TYPES.find((t) => t.value === voucherType)!;
  const isSale = voucherType === "sales" || voucherType === "credit_note";

  // The party side hard-filters by ledger role — a sale cannot be billed to a
  // supplier. The trading side stays open, since a business may post to any
  // of several income or expense ledgers.
  const partyLedgers = ledgers.filter((l) => (config.roles as readonly string[]).includes(l.ledger_role));
  const tradingLedgers = ledgers.filter((l) => l.ledger_role === (isSale ? "income" : "expense"));

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
    const party = ledgers.find((l) => l.id === newPartyId);
    if (party?.state_code) setPlaceOfSupply(party.state_code);
  }

  const supplyType =
    gstOn && branch?.registeredState && placeOfSupply
      ? branch.registeredState === placeOfSupply
        ? "intra"
        : "inter"
      : null;

  const taxable = useMemo(
    () =>
      sumPaise(
        lines.map((l) => toPaise(Math.round((Number(l.quantity) || 0) * (Number(l.rate) || 0) * 100) / 100))
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
      const item = items.find((x) => x.id === l.itemId);
      if (!item || !item.gst_rate_percent) continue;
      const amount = Math.round((Number(l.quantity) || 0) * (Number(l.rate) || 0) * 100) / 100;
      if (supplyType === "intra") {
        const half = Math.round(((amount * item.gst_rate_percent) / 2 / 100) * 100) / 100;
        cgst += half;
        sgst += half;
      } else {
        igst += Math.round(((amount * item.gst_rate_percent) / 100) * 100) / 100;
      }
    }
    return { cgst, sgst, igst };
  }, [lines, items, supplyType]);

  // Mirrors create_invoice's TCS math exactly, for the same display-only
  // reason as `tax` above. Only sales and credit notes ever carry TCS, only
  // when the module is on, only for lines whose item names a section, and
  // only above that section's threshold (if it has one) — on the line's own
  // taxable amount, never the invoice total.
  const tcs = useMemo(() => {
    if (!tcsOn || !isSale) return 0;
    const party = ledgers.find((l) => l.id === partyId);
    const hasPan = !!party?.pan;
    let total = 0;
    for (const l of lines) {
      const item = items.find((x) => x.id === l.itemId);
      if (!item || !item.default_tcs_section) continue;
      const section = tcsSections.find((s) => s.section_code === item.default_tcs_section);
      if (!section) continue;
      const amount = Math.round((Number(l.quantity) || 0) * (Number(l.rate) || 0) * 100) / 100;
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
  }, [tcsOn, isSale, lines, items, tcsSections, ledgers, partyId, supplyType]);

  const grandTotal = taxable + tax.cgst + tax.sgst + tax.igst + tcs;

  function update(i: number, patch: Partial<Line>) {
    setLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== i) return l;
        const next = { ...l, ...patch };
        // Prefill the rate from the item master when one is picked and the
        // rate is still blank — never overwrite something already typed.
        if (patch.itemId && !l.rate) {
          const it = items.find((x) => x.id === patch.itemId);
          const suggested = isSale ? it?.sale_rate : it?.purchase_rate;
          if (suggested) next.rate = String(suggested);
        }
        return next;
      })
    );
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

    setBusy(true);
    const { data, error } = await createClient().rpc("create_invoice", {
      p_company_id: companyId,
      p_branch_id: branchId,
      p_voucher_type: voucherType,
      p_voucher_date: date,
      p_party_ledger_id: partyId,
      p_trading_ledger_id: tradingId,
      p_godown_id: godownId,
      p_items: filled.map((l) => ({
        item_id: l.itemId,
        quantity: Number(l.quantity),
        rate: Number(l.rate) || 0,
        description: l.description.trim() || null,
      })),
      p_narration: narration.trim() || undefined,
      p_reference_number: reference.trim() || undefined,
      p_place_of_supply: placeOfSupply || undefined,
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    router.push(`/${companyId}/vouchers/${data}`);
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
            onChange={(e) => {
              setVoucherType(e.target.value as typeof voucherType);
              selectParty("");
              setTradingId("");
            }}
            className={field}
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

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{config.party}</span>
          <select required value={partyId} onChange={(e) => selectParty(e.target.value)} className={field}>
            <option value="">Select…</option>
            {partyLedgers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{config.trading}</span>
          <select required value={tradingId} onChange={(e) => setTradingId(e.target.value)} className={field}>
            <option value="">Select…</option>
            {tradingLedgers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

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

      <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <th className="px-3 py-2.5 font-medium">Item</th>
              <th className="w-24 px-3 py-2.5 text-right font-medium">Qty</th>
              <th className="w-16 px-3 py-2.5 font-medium">Unit</th>
              <th className="w-28 px-3 py-2.5 text-right font-medium">Rate</th>
              {gstOn && <th className="w-16 px-3 py-2.5 text-right font-medium">GST</th>}
              <th className="w-32 px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const item = items.find((x) => x.id === line.itemId);
              const amount = Math.round((Number(line.quantity) || 0) * (Number(line.rate) || 0) * 100) / 100;
              return (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <select value={line.itemId} onChange={(e) => update(i, { itemId: e.target.value })} className={cell}>
                      <option value="">Select an item…</option>
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
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
                  {gstOn && (
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-ink-faint font-mono">
                      {item ? `${item.gst_rate_percent}%` : "—"}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right tabular-nums font-mono">{formatINR(amount)}</td>
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
              <td className="px-3 py-2.5" colSpan={gstOn ? 5 : 4}>
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
                      <td className="px-3 py-1" colSpan={gstOn ? 5 : 4}>
                        CGST
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums font-mono">{formatINR(tax.cgst)}</td>
                      <td />
                    </tr>
                    <tr className="text-xs text-ink-soft">
                      <td className="px-3 py-1" colSpan={gstOn ? 5 : 4}>
                        SGST
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums font-mono">{formatINR(tax.sgst)}</td>
                      <td />
                    </tr>
                  </>
                ) : supplyType === "inter" ? (
                  <tr className="text-xs text-ink-soft">
                    <td className="px-3 py-1" colSpan={gstOn ? 5 : 4}>
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
                    <td className="px-3 py-1" colSpan={gstOn ? 5 : 4}>
                      TCS
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums font-mono">{formatINR(tcs)}</td>
                    <td />
                  </tr>
                )}
                <tr className="border-t-2 border-border-strong font-semibold">
                  <td className="px-3 py-2.5" colSpan={gstOn ? 5 : 4}>
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
        className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Saving…" : `Save ${config.label.toLowerCase()}`}
      </button>
    </form>
  );
}
