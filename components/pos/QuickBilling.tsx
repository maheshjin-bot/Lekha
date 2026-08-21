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

export function QuickBilling({
  companyId,
  items,
  branch,
  godown,
  salesLedgerId,
  cashLedgerId,
  todaySales,
}: {
  companyId: string;
  items: Item[];
  branch: Branch;
  godown: Godown;
  salesLedgerId: string | null;
  cashLedgerId: string | null;
  todaySales: TodaySale[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);

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
      return [...prev, { item, quantity: 1, rate: item.sale_rate ?? 0 }];
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
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Sale posted.");
    setCart([]);
    setSearch("");
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
                      {formatINRWithSymbol(it.sale_rate ?? 0)}/{it.uom}
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
