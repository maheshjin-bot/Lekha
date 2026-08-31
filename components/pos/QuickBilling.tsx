"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR, formatINRWithSymbol } from "@/lib/utils/currency";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card, CardBody } from "@/components/ui/Card";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { VoucherNumberField } from "@/components/numbering/VoucherNumberField";
import {
  friendlyNumberingError,
  validateManualNumber,
  type TypeNumbering,
} from "@/lib/numbering/voucher-numbering";

type Item = {
  id: string;
  name: string;
  code: string | null;
  uom: string;
  sale_rate: number | null;
  gst_rate_percent: number | null;
};

type Branch = { id: string; code: string; name: string; state_code: string | null } | null;
type Godown = { id: string; name: string; is_default: boolean } | null;

type CartLine = { item: Item; quantity: number; rate: number };

type TodaySale = { id: string; voucher_number: string; total_amount: number; created_at: string };

// One item's rate on the company's DEFAULT price list only, exactly the same
// shape and the same convenience-lookup contract as InvoiceForm's own
// PriceListEntry (see get_effective_item_price, 0147) — a counter sale should
// suggest the same rate a full invoice would for the same item today,
// instead of always falling back to the item master's flat sale_rate.
type PriceListEntry = { item_id: string; price: number; effective_from: string };

export function QuickBilling({
  companyId,
  items,
  branch,
  godown,
  salesLedgerId,
  cashLedgerId,
  todaySales,
  priceListItems = [],
  numbering,
}: {
  companyId: string;
  items: Item[];
  branch: Branch;
  godown: Godown;
  salesLedgerId: string | null;
  cashLedgerId: string | null;
  todaySales: TodaySale[];
  priceListItems?: PriceListEntry[];
  /**
   * The SALES voucher type's numbering policy for this branch (migration
   * 0725), or undefined when the company has none — which, since 0725 seeds
   * nothing, is every company that has never opened the numbering settings
   * screen. Optional for that reason and rendered by the same
   * VoucherNumberField the invoice and voucher screens use, never a third
   * copy of it.
   *
   * HOW MUCH A TILL SHOULD ASK — the deliberate part.
   *
   *   automatic  ASKS NOTHING. VoucherNumberField returns null before any
   *              markup, so the overwhelming majority of tills — every company
   *              that never changed the setting — see this screen exactly as
   *              it was. A greyed-out caption explaining that the app will
   *              number the sale would be a change, and a POS is measured in
   *              taps.
   *   series     ASKS, and this is the easy call. It is one select, touched
   *              once and then left alone: the choice deliberately SURVIVES
   *              checkout, so a counter working the "Counter" series picks it
   *              at the start of the shift and never sees it again. Without
   *              it every counter sale silently drew the default series, which
   *              for a company that took the trouble to define a second one is
   *              precisely wrong — and unfixable afterwards, because a voucher
   *              number is fixed once issued.
   *   manual     ASKS, and this is the harder call, taken deliberately.
   *              Typing a number at a till is real friction and a POS exists
   *              to be fast. But manual mode is a company saying "we number
   *              our own sales documents" — a GST invoice number is a legal
   *              register that must run consecutively (CGST Rule 46(b)), and
   *              the alternative here is not "faster", it is the app quietly
   *              issuing numbers into a series the company believes it
   *              controls, in a screen they cannot see doing it. Silence is
   *              the wrong trade; one typed field is the right one. It is
   *              cleared after each sale — the one thing that must NOT be
   *              sticky, since re-using a number is refused by the database.
   */
  numbering?: TypeNumbering;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);

  // Numbering (0725). Same three-line shape as InvoiceForm, on purpose: the
  // series id is RESOLVED rather than stored, so a series that has been
  // retired between page loads falls back to the default instead of being sent
  // to next_voucher_number, which refuses an inactive one outright.
  const [manualNumber, setManualNumber] = useState("");
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const seriesOptions = numbering?.mode === "series" ? numbering.series : [];
  const effectiveSeriesId = seriesOptions.some((s) => s.id === seriesId)
    ? seriesId
    : (seriesOptions.find((s) => s.isDefault)?.id ?? seriesOptions[0]?.id ?? null);

  // Today's date, once — every counter sale posts as of today (see checkout's
  // own p_voucher_date below), so unlike InvoiceForm's per-invoice `date`
  // state there is only ever one date to filter effective_from against here.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Mirrors InvoiceForm's priceListRate exactly: the latest price_list_items
  // row for this item whose effective_from is on or before today, or
  // undefined when none applies — callers fall back to the item master's
  // sale_rate, exactly as before this lookup existed.
  function priceListRate(itemId: string): number | undefined {
    const candidates = priceListItems.filter((p) => p.item_id === itemId && p.effective_from <= today);
    if (!candidates.length) return undefined;
    return candidates.reduce((latest, p) => (p.effective_from > latest.effective_from ? p : latest)).price;
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items.slice(0, 24);
    return items
      .filter((it) => it.name.toLowerCase().includes(q) || (it.code ?? "").toLowerCase().includes(q))
      .slice(0, 24);
  }, [items, search]);

  function addItem(item: Item) {
    setCart((prev) => {
      const existing = prev.find((l) => l.item.id === item.id);
      if (existing) {
        return prev.map((l) => (l.item.id === item.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      const rate = priceListRate(item.id) ?? item.sale_rate ?? 0;
      return [...prev, { item, quantity: 1, rate }];
    });
  }

  function updateLine(itemId: string, patch: Partial<Pick<CartLine, "quantity" | "rate">>) {
    setCart((prev) => prev.map((l) => (l.item.id === itemId ? { ...l, ...patch } : l)));
  }

  function removeLine(itemId: string) {
    setCart((prev) => prev.filter((l) => l.item.id !== itemId));
  }

  const subtotal = cart.reduce((n, l) => n + l.quantity * l.rate, 0);
  const missingSetup = !branch || !godown || !salesLedgerId || !cashLedgerId;

  async function checkout() {
    if (cart.length === 0) {
      toast.error("Cart is empty.");
      return;
    }
    if (!branch || !godown || !salesLedgerId || !cashLedgerId) {
      toast.error(
        "Quick billing needs an active branch, a godown and a Sales Account ledger set up first."
      );
      return;
    }
    // The same rule app_private.assert_rule46b_number applies, checked here so
    // the counter reads a sentence instead of waiting out a round trip that
    // fails — which at a till, with a customer standing there, is the whole
    // difference. Identical to InvoiceForm's own pre-submit check.
    if (numbering?.mode === "manual") {
      const problem = validateManualNumber(manualNumber);
      if (problem) {
        toast.error(problem);
        return;
      }
    }
    setBusy(true);
    const { data, error } = await createClient().rpc("create_invoice", {
      p_company_id: companyId,
      p_branch_id: branch.id,
      p_voucher_type: "sales",
      p_voucher_date: new Date().toISOString().slice(0, 10),
      p_party_ledger_id: cashLedgerId,
      p_trading_ledger_id: salesLedgerId,
      p_godown_id: godown.id,
      p_items: cart.map((l, i) => ({
        item_id: l.item.id,
        quantity: l.quantity,
        rate: l.rate,
        description: l.item.name,
        line_order: i,
      })),
      p_narration: "Quick billing (counter sale)",
      p_place_of_supply: branch.state_code ?? undefined,
      // Exactly one of these, and only when the mode calls for it — the same
      // contract InvoiceForm honours. next_voucher_number REFUSES a series it
      // was not asked for in automatic mode and resolve_manual_voucher_number
      // refuses a typed number outside manual mode, both deliberately, so this
      // screen cannot fork a company's GST series even by mistake. undefined
      // is dropped from the request body by supabase-js and falls through to
      // the SQL default, which is what quick billing sent for both arguments
      // before this change and is still what an automatic-mode till sends.
      p_voucher_number: numbering?.mode === "manual" ? manualNumber.trim() : undefined,
      p_number_series_id:
        numbering?.mode === "series" ? (effectiveSeriesId ?? undefined) : undefined,
    });
    setBusy(false);
    if (error) {
      // Turns the one numbering failure that can still arrive as a raw
      // Postgres unique-violation into a sentence a counter can act on.
      toast.error(friendlyNumberingError(error.message));
      return;
    }
    toast.success("Sale posted.");
    setCart([]);
    setSearch("");
    // Cleared, unlike the series selection above, which is kept for the shift:
    // a number is used once and the database refuses a repeat, so leaving the
    // last one in the box would hand the counter a guaranteed failure on the
    // next sale. router.refresh() re-reads the series preview so the "Next:"
    // caption moves on with the counter it just advanced.
    setManualNumber("");
    router.refresh();
    void data;
  }

  const todayTotal = todaySales.reduce((n, v) => n + (Number(v.total_amount) || 0), 0);

  return (
    <div className="flex flex-col gap-6">
      {missingSetup && (
        <Card className="border-warning/40 bg-warning-soft/40">
          <CardBody className="text-sm text-ink-soft">
            {!branch && "No active branch found. "}
            {branch && !godown && "This branch has no godown set up yet — add one in Godowns. "}
            {!salesLedgerId && "No income ledger (Sales Account) found in the chart of accounts. "}
            Quick billing can&rsquo;t post a sale until this is set up.
          </CardBody>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardBody className="flex flex-col gap-3">
            <Input
              autoFocus
              placeholder="Search item by name or code, or scan a barcode…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {filtered.length === 0 ? (
              <EmptyState>No items match. Try a different name or code, or clear the search.</EmptyState>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {filtered.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => addItem(it)}
                    className="flex flex-col items-start gap-0.5 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-left text-sm transition-colors hover:border-accent hover:bg-accent-soft"
                  >
                    <span className="font-medium text-ink">{it.name}</span>
                    <span className="text-xs text-ink-faint">
                      {it.code ? `${it.code} · ` : ""}
                      {formatINRWithSymbol(priceListRate(it.id) ?? it.sale_rate ?? 0)}/{it.uom}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold text-ink">Cart</h2>
            {cart.length === 0 ? (
              <p className="text-sm text-ink-faint">Tap an item to add it.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {cart.map((l) => (
                  <div key={l.item.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-ink">{l.item.name}</span>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={l.quantity}
                      onChange={(e) => updateLine(l.item.id, { quantity: Number(e.target.value) || 0 })}
                      className="w-16 rounded-md border border-border-strong bg-surface px-2 py-1 text-right font-mono text-xs tabular-nums"
                    />
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={l.rate}
                      onChange={(e) => updateLine(l.item.id, { rate: Number(e.target.value) || 0 })}
                      className="w-20 rounded-md border border-border-strong bg-surface px-2 py-1 text-right font-mono text-xs tabular-nums"
                    />
                    <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-ink">
                      {formatINR(l.quantity * l.rate)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeLine(l.item.id)}
                      className="shrink-0 text-ink-faint hover:text-error"
                      aria-label={`Remove ${l.item.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
              <span className="text-ink-soft">Subtotal (before GST)</span>
              <span className="font-mono font-semibold tabular-nums text-ink">
                {formatINRWithSymbol(subtotal)}
              </span>
            </div>
            <p className="text-xs text-ink-faint">
              GST/TCS (if applicable) is computed automatically at checkout, same as a full
              invoice — the final total appears in Today&rsquo;s sales below.
            </p>

            {/* Nothing at all in automatic mode — VoucherNumberField returns
                null before any markup, so a till that never touched the
                numbering settings is unchanged. Placed last, immediately above
                the button, because in manual mode it is the one thing that
                must be filled before the sale can be completed. */}
            <VoucherNumberField
              policy={numbering}
              manualNumber={manualNumber}
              onManualNumberChange={setManualNumber}
              seriesId={effectiveSeriesId}
              onSeriesIdChange={setSeriesId}
            />

            <Button
              type="button"
              onClick={checkout}
              busy={busy}
              busyLabel="Posting…"
              disabled={cart.length === 0 || missingSetup}
              className="w-full"
            >
              Complete sale
            </Button>
          </CardBody>
        </Card>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Today&rsquo;s sales</h2>
          <span className="font-mono text-sm tabular-nums text-ink-soft">
            {todaySales.length} bill{todaySales.length === 1 ? "" : "s"} ·{" "}
            {formatINRWithSymbol(todayTotal)}
          </span>
        </div>
        {todaySales.length === 0 ? (
          <p className="text-sm text-ink-faint">No counter sales yet today.</p>
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={th}>Invoice</th>
                  <th className={th}>Time</th>
                  <th className={th + " text-right"}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {todaySales.map((v) => (
                  <tr key={v.id}>
                    <td className={td}>{v.voucher_number}</td>
                    <td className={td}>
                      {new Date(v.created_at).toLocaleTimeString("en-IN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className={num}>{formatINR(v.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )}
      </div>
    </div>
  );
}
